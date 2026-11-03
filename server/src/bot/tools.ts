import type Anthropic from '@anthropic-ai/sdk';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { bookingRequests, botMessages, products, services } from '../db/schema.js';
import { auditBookingRequest } from '../domain/audit-events.js';
import { findChat, updateChatFlags } from '../domain/bot-chats.js';
import { hasSizeInStock } from '../domain/products.js';
import { normalizePhone, isPlausiblePhone } from '../lib/phone.js';
import type { ProductRow, ServiceRow } from '../lib/serialize.js';
import { truncate } from '../lib/text.js';
import { bookingRequestPush, clientMessagePush } from '../push/staff-events.js';
import type { JewelryList } from './callback-data.js';
import { BOOK_APPOINTMENT_TOOL, buildBookingToolHandler } from './booking-tool.js';
import { buildCabinetToolHandler, CABINET_LINK_TOOL } from './cabinet.js';
import { buildClientToolHandlers } from './client-tools.js';
import { photoMessageText, serviceCaptionTitle, servicePhotoSource } from './media.js';
import { buildPortfolioToolHandler, SHOW_PORTFOLIO_TOOL, type PortfolioShot } from './portfolio.js';
import { HISTORY_LIMIT } from './prompt.js';
import { clientLabel, notifyStaff } from './staff.js';
import { buildWaitlistToolHandler, JOIN_WAITLIST_TOOL } from './waitlist-tool.js';

export const MAX_PRODUCTS_PER_CALL = 5;

export const TOOLS: Anthropic.Tool[] = [
  {
    name: 'create_booking_request',
    description:
      'Создаёт заявку на запись для администратора. Вызывай, когда клиент хочет записаться, но точного времени у него нет ' +
      '(«как-нибудь на выходных»), он просит, чтобы время подобрал администратор, или онлайн-запись выключена; нужны имя, ' +
      'телефон, желаемая услуга и удобное время. Время не подтверждается автоматически — администратор свяжется с клиентом.',
    input_schema: {
      type: 'object',
      properties: {
        contactName: { type: 'string', description: 'Имя клиента' },
        phone: { type: 'string', description: 'Телефон клиента для связи' },
        serviceName: { type: 'string', description: 'Желаемая услуга, например «прокол хеликса» или «тату на предплечье»' },
        preferredTime: { type: 'string', description: 'Удобные дата и время словами клиента, например «в субботу после 15:00»' },
        comment: { type: 'string', description: 'Детали: зона, размер, эскиз, выбранное украшение и т. п. Можно пустую строку.' },
      },
      required: ['contactName', 'phone', 'serviceName', 'preferredTime'],
    },
  },
  {
    name: 'handoff_to_staff',
    description:
      'Передаёт диалог живому администратору. Вызывай при признаках осложнений после процедуры (гной, нарастающий отёк, ' +
      'сильная боль, температура, аллергия), при жалобах, просьбе позвать человека, вопросах, на которые нет ответа в данных студии.',
    input_schema: {
      type: 'object',
      properties: { reason: { type: 'string', description: 'Кратко: почему нужен администратор' } },
      required: ['reason'],
    },
  },
  {
    name: 'show_products',
    description:
      'Отправляет клиенту фото украшений (и товаров) в наличии — из списка «Украшения в наличии» или найденных через ' +
      'find_jewelry — с названием, материалом, толщиной, ценой и размерами в наличии. Вызывай, когда клиент хочет ' +
      'посмотреть конкретные позиции. Фото придут сразу после твоего текстового ответа.',
    input_schema: {
      type: 'object',
      properties: {
        productIds: {
          type: 'array',
          items: { type: 'integer' },
          description: `id украшений из списка (не больше ${MAX_PRODUCTS_PER_CALL})`,
        },
      },
      required: ['productIds'],
    },
  },
  {
    name: 'show_service',
    description:
      'Отправляет клиенту схематичную картинку услуги из раздела «Услуги и цены» с подписью: название, цена, варианты ' +
      'и краткое описание. Вызывай, когда клиент спрашивает о конкретной услуге, выбирает её или консультация идёт об ' +
      'одной услуге. Картинка придёт сразу после твоего текстового ответа, поэтому не повторяй в тексте все цены и ' +
      'варианты. Для каждой услуги — не больше одного раза за диалог. Работает только для услуг с пометкой «есть ' +
      'картинка»: если её нет, просто ответь текстом. Никогда не придумывай и не описывай картинки, которых нет.',
    input_schema: {
      type: 'object',
      properties: { serviceId: { type: 'integer', description: 'id услуги из раздела «Услуги и цены»' } },
      required: ['serviceId'],
    },
  },
  SHOW_PORTFOLIO_TOOL,
  {
    name: 'show_jewelry_for_service',
    description:
      'Отправляет клиенту интерактивный каталог украшений, подходящих для услуги (зоны прокола): карусель с фото, ' +
      'материалом, толщиной, размерами в наличии и ценами, кнопками «◀︎ ▶︎», «Хочу это украшение» и «Все украшения». ' +
      'Вызывай, когда клиент спрашивает, какие украшения есть или подходят для прокола (например «украшения для хеликса»). ' +
      'Клиенты часто пишут зону с ошибкой или по-русски на слух («Феликс», «трагус», «септум») — сопоставь её с услугой ' +
      'из раздела «Услуги и цены» и передай её id. Каталог придёт после твоего ответа: не перечисляй все позиции текстом.',
    input_schema: {
      type: 'object',
      properties: { serviceId: { type: 'integer', description: 'id услуги (зоны прокола) из раздела «Услуги и цены»' } },
      required: ['serviceId'],
    },
  },
  {
    name: 'find_jewelry',
    description:
      'Ищет конкретное украшение или товар по названию, типу, материалу, размеру или толщине и сверяется со складом: ' +
      'возвращает id, характеристики, размеры в наличии с ценами или «нет в наличии» (количество не раскрывается). ' +
      'Вызывай, когда клиент спрашивает про конкретную позицию («есть ли титановый лабрет 8 мм?», «сколько стоит кликер»). ' +
      'Чтобы показать фото найденного — вызови show_products с его id.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Ключевые слова: тип, материал, размер, например «лабрет титан 8 мм»' } },
      required: ['query'],
    },
  },
  {
    name: 'my_appointments',
    description:
      'Возвращает предстоящие записи этого клиента (номер, дата и время, услуги, мастер, статус). Вызывай, когда клиент ' +
      'спрашивает о своей записи, хочет её перенести или подтвердить. Работает, только если клиент идентифицирован.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'free_slots',
    description:
      'Возвращает свободное время мастеров на дату (в их рабочее время, с шагом и сроками онлайн-записи студии). Для ' +
      'переноса записи передай appointmentId — тогда учитываются её длительность и мастер. Для новой записи передай ' +
      'serviceId (длительность услуги) и masterId, если клиент хочет к конкретному мастеру. Предлагай клиенту 2–4 удобных ' +
      'варианта, а не весь список.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Дата в формате ГГГГ-ММ-ДД (по времени студии)' },
        appointmentId: { type: 'integer', description: 'Номер записи клиента, которую переносим (из my_appointments)' },
        serviceId: { type: 'integer', description: 'id услуги из прайса — для длительности' },
        masterId: { type: 'integer', description: 'id мастера, если клиент хочет к конкретному мастеру' },
      },
      required: ['date'],
    },
  },
  BOOK_APPOINTMENT_TOOL,
  JOIN_WAITLIST_TOOL,
  {
    name: 'reschedule_appointment',
    description:
      'Переносит запись клиента на новое время (мастер и длительность сохраняются; время проверяется по расписанию). ' +
      'Вызывай только после того, как клиент явно выбрал конкретное время из предложенных free_slots. Студия получит ' +
      'уведомление, напоминания обновятся.',
    input_schema: {
      type: 'object',
      properties: {
        appointmentId: { type: 'integer', description: 'Номер записи (из my_appointments)' },
        startsAt: { type: 'string', description: 'Новое начало по времени студии: «ГГГГ-ММ-ДД ЧЧ:ММ», как в ответе free_slots' },
      },
      required: ['appointmentId', 'startsAt'],
    },
  },
  {
    name: 'certificate_balance',
    description:
      'Проверяет подарочный сертификат студии по коду (формат MIKAN-XXXX-XXXX; регистр, дефисы и пробелы не важны): ' +
      'сколько на нём осталось и до какого числа он действует. Вызывай, когда клиент спрашивает о своём сертификате ' +
      'и называет код. Кто купил сертификат, не сообщается и не обсуждается.',
    input_schema: {
      type: 'object',
      properties: { code: { type: 'string', description: 'Код сертификата, как его написал клиент' } },
      required: ['code'],
    },
  },
  CABINET_LINK_TOOL,
];

const bookingInput = z.object({
  contactName: z.string().trim().min(1).max(100),
  phone: z.string().trim().min(3).max(40),
  serviceName: z.string().trim().min(1).max(200),
  preferredTime: z.string().trim().min(1).max(200),
  comment: z.string().trim().max(1000).nullish(),
});
const handoffInput = z.object({ reason: z.string().trim().min(1).max(500) });
const productsInput = z.object({ productIds: z.array(z.number().int().positive()).min(1).max(MAX_PRODUCTS_PER_CALL) });
const serviceInput = z.object({ serviceId: z.number().int().positive() });

export interface ToolResult {
  content: string;
  isError?: boolean;
}
export type ToolHandler = (input: unknown) => Promise<ToolResult>;

export interface ToolScope {
  mode: 'live' | 'test';
  chatId: number | null;
  clientId: number | null;
  telegramName: string | null;
  username: string | null;
  lastUserText: string;
}

/** Collects side effects that happen after the text reply (service pictures, product photos) and test-mode notes. */
export interface ToolSink {
  products: ProductRow[];
  services: ServiceRow[];
  /** Photos of masters' work to send after the reply (`show_portfolio`). */
  portfolio: PortfolioShot[];
  /** Jewelry carousels to send after the reply. */
  carousels: JewelryList[];
  notes: string[];
  /** Live actions that succeeded (used to confirm them if the model ends without text). */
  done: Set<'booking' | 'handoff' | 'reschedule' | 'online_booking' | 'waitlist' | 'cabinet'>;
  /** Messages sent after the reply (the payment request of an online booking). */
  after: Array<() => Promise<unknown>>;
}

export const emptySink = (): ToolSink => ({
  products: [],
  services: [],
  portfolio: [],
  carousels: [],
  notes: [],
  done: new Set(),
  after: [],
});

const invalid = (what: string): ToolResult => ({ content: `Некорректные данные: ${what}. Уточни у клиента и попробуй снова.`, isError: true });

function availableJewelry(ctx: AppContext, ids: number[]): ProductRow[] {
  const rows = ctx.db
    .select()
    .from(products)
    .where(and(inArray(products.id, ids), inArray(products.kind, ['jewelry', 'goods']), eq(products.active, true), hasSizeInStock))
    .all();
  return ids.map((id) => rows.find((r) => r.id === id)).filter((r): r is ProductRow => r !== undefined);
}

function activeService(ctx: AppContext, id: number): ServiceRow | undefined {
  return ctx.db.select().from(services).where(and(eq(services.id, id), eq(services.active, true))).get();
}

/** Whether this service's picture is already in the part of the chat the model sees. */
function serviceShownRecently(ctx: AppContext, chatId: number | null, service: ServiceRow): boolean {
  if (chatId === null) return false;
  // Captions before bold titles had the plain name.
  const markers = [photoMessageText(`${serviceCaptionTitle(service.name)}\n`), photoMessageText(`${service.name}\n`)];
  return ctx.db
    .select({ role: botMessages.role, text: botMessages.text })
    .from(botMessages)
    .where(eq(botMessages.chatId, chatId))
    .orderBy(desc(botMessages.id))
    .limit(HISTORY_LIMIT)
    .all()
    .some((m) => m.role === 'assistant' && markers.some((marker) => m.text.startsWith(marker)));
}

export function buildToolHandlers(ctx: AppContext, scope: ToolScope, sink: ToolSink): Record<string, ToolHandler> {
  const who = clientLabel(scope.telegramName, scope.username);
  return {
    ...buildClientToolHandlers(ctx, scope, sink),
    book_appointment: buildBookingToolHandler(ctx, scope, sink),
    join_waitlist: buildWaitlistToolHandler(ctx, scope, sink),
    show_portfolio: buildPortfolioToolHandler(ctx, scope, sink),
    cabinet_link: buildCabinetToolHandler(ctx, scope, sink),
    create_booking_request: async (raw) => {
      const parsed = bookingInput.safeParse(raw);
      if (!parsed.success) {
        const fields = [...new Set(parsed.error.issues.map((i) => i.path.join('.')))].join(', ');
        return invalid(`проверь поля ${fields} (имя, телефон, услуга и время обязательны)`);
      }
      const input = parsed.data;
      const phone = normalizePhone(input.phone);
      if (!phone || !isPlausiblePhone(phone)) return invalid('телефон выглядит неправильно');
      if (scope.mode === 'test') {
        sink.notes.push(`создана бы заявка: ${input.contactName}, ${phone}, ${input.serviceName}, ${input.preferredTime}`);
        return { content: 'Тестовый режим: заявка не сохранена, но для клиента всё выглядит так, будто она создана.' };
      }
      const now = Date.now();
      const row = ctx.db
        .insert(bookingRequests)
        .values({
          chatId: scope.chatId,
          clientId: scope.clientId,
          contactName: input.contactName,
          phone,
          serviceName: input.serviceName,
          preferredTime: input.preferredTime,
          comment: input.comment || null,
          status: 'new',
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
      auditBookingRequest(ctx, row);
      await notifyStaff(
        ctx,
        [
          `📅 Новая заявка на запись №${row.id}`,
          `Имя: ${input.contactName}`,
          `Телефон: ${phone}`,
          `Услуга: ${input.serviceName}`,
          `Когда удобно: ${input.preferredTime}`,
          ...(input.comment ? [`Комментарий: ${input.comment}`] : []),
          `Telegram: ${who}`,
        ].join('\n'),
        () => bookingRequestPush(row),
      );
      sink.done.add('booking');
      return { content: `Заявка №${row.id} создана. Администратор свяжется с клиентом, чтобы подтвердить время.` };
    },

    handoff_to_staff: async (raw) => {
      const parsed = handoffInput.safeParse(raw);
      if (!parsed.success) return invalid('укажи причину');
      if (scope.mode === 'test') {
        sink.notes.push(`диалог передан бы администратору: ${parsed.data.reason}`);
        return { content: 'Тестовый режим: администратор не уведомлён, но для клиента всё выглядит как обычно.' };
      }
      const chat =
        scope.chatId !== null && findChat(ctx.db, scope.chatId) ? updateChatFlags(ctx.db, scope.chatId, { needsAttention: true }) : null;
      await notifyStaff(
        ctx,
        `🙋 Бот передал диалог администратору\nКлиент: ${who}\nПричина: ${parsed.data.reason}\n` +
          `Последнее сообщение: «${truncate(scope.lastUserText, 500)}»\nОтветьте в приложении MIKAN.`,
        chat ? () => clientMessagePush(ctx.db, chat, scope.lastUserText) : undefined,
      );
      sink.done.add('handoff');
      return { content: 'Администратор уведомлён и скоро ответит в этом чате.' };
    },

    show_products: async (raw) => {
      const parsed = productsInput.safeParse(raw);
      if (!parsed.success) return invalid(`нужен список id (от 1 до ${MAX_PRODUCTS_PER_CALL})`);
      const found = availableJewelry(ctx, parsed.data.productIds);
      if (found.length === 0) return { content: 'Этих украшений сейчас нет в наличии. Предложи другие из списка.', isError: true };
      const fresh = found.filter((p) => !sink.products.some((q) => q.id === p.id));
      sink.products.push(...fresh);
      if (scope.mode === 'test') sink.notes.push(`показаны бы фото: ${found.map((p) => p.name).join(', ')}`);
      return { content: `Фото будут отправлены клиенту после твоего ответа: ${found.map((p) => p.name).join(', ')}.` };
    },

    show_service: async (raw) => {
      const parsed = serviceInput.safeParse(raw);
      if (!parsed.success) return invalid('нужен id услуги из раздела «Услуги и цены»');
      const service = activeService(ctx, parsed.data.serviceId);
      if (!service) return { content: 'Такой услуги нет в прайсе. Возьми id из раздела «Услуги и цены».', isError: true };
      if (!servicePhotoSource(ctx.config.dataDir, service)) {
        return { content: `У услуги «${service.name}» нет картинки — просто ответь клиенту текстом.` };
      }
      if (sink.services.some((s) => s.id === service.id) || serviceShownRecently(ctx, scope.chatId, service)) {
        return { content: `Картинка услуги «${service.name}» уже отправлена клиенту в этом диалоге — не отправляй её повторно.` };
      }
      sink.services.push(service);
      if (scope.mode === 'test') sink.notes.push(`показана бы картинка услуги: ${service.name}`);
      return { content: `Картинка услуги «${service.name}» с ценой и вариантами будет отправлена клиенту после твоего ответа.` };
    },
  };
}
