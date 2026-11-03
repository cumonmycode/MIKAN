import { and, eq } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { services } from '../db/schema.js';
import { certificateBalanceText } from '../domain/certificate-views.js';
import { bookableMasters, freeSlots } from '../domain/free-slots.js';
import { findClientByChat } from '../domain/clients.js';
import { serviceIdsByProduct } from '../domain/products.js';
import { getStudioSettings, studioTimezone } from '../domain/settings.js';
import { formatThickness, threadLabel } from '../lib/jewelry.js';
import { formatRub } from '../lib/text.js';
import { formatHumanDateTime, formatTime, localDate, MINUTE_MS } from '../lib/time.js';
import { compatibleJewelry } from './catalog.js';
import {
  describeForClient,
  ownActiveAppointment,
  parseStudioDateTime,
  rescheduleForClient,
  studioDateTimeText,
  upcomingForClient,
} from './client-appointments.js';
import { offerText, searchJewelry } from './jewelry.js';
import type { ToolHandler, ToolResult, ToolScope, ToolSink } from './tools.js';

/** Client tools beyond the original four: jewelry catalogs and search, the client's appointments and rescheduling. */

export const FIND_JEWELRY_LIMIT = 8;
/** Duration assumed by free_slots when neither an appointment nor a service is given. */
const DEFAULT_SLOT_MINUTES = 60;

const serviceInput = z.object({ serviceId: z.number().int().positive() });
const findInput = z.object({ query: z.string().trim().min(1).max(200) });
const slotsInput = z.object({
  date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/),
  appointmentId: z.number().int().positive().nullish(),
  serviceId: z.number().int().positive().nullish(),
  masterId: z.number().int().positive().nullish(),
});
const rescheduleInput = z.object({ appointmentId: z.number().int().positive(), startsAt: z.string().trim().min(10).max(40) });
const certificateInput = z.object({ code: z.string().trim().min(1).max(40) });

const error = (content: string): ToolResult => ({ content, isError: true });

const NOT_IDENTIFIED =
  'Клиент не идентифицирован, поэтому его записи не видны. Попроси поделиться номером кнопкой «📱 Поделиться номером» ' +
  'внизу чата — после этого записи станут доступны. Если клиент не хочет — передай вопрос администратору (handoff_to_staff).';

export function buildClientToolHandlers(ctx: AppContext, scope: ToolScope, sink: ToolSink): Record<string, ToolHandler> {
  const { db } = ctx;
  /**
   * Appointments are shown and moved only for the client whose Telegram is linked to this very chat (a chat merely
   * attributed to a client, e.g. an old account after re-linking, gets nothing).
   */
  const linkedClientId = (): number | null => (scope.chatId === null ? null : (findClientByChat(db, scope.chatId)?.id ?? null));
  return {
    // Read-only, so the test mode answers exactly like a live chat.
    certificate_balance: async (raw) => {
      const parsed = certificateInput.safeParse(raw);
      if (!parsed.success) return error('Некорректные данные: передай код сертификата, как его написал клиент.');
      const answer = certificateBalanceText(db, parsed.data.code);
      return answer.found ? { content: answer.text } : error(answer.text);
    },

    show_jewelry_for_service: async (raw) => {
      const parsed = serviceInput.safeParse(raw);
      if (!parsed.success) return error('Некорректные данные: нужен id услуги из раздела «Услуги и цены».');
      const service = db.select().from(services).where(and(eq(services.id, parsed.data.serviceId), eq(services.active, true))).get();
      if (!service) return error('Такой услуги нет в прайсе. Сопоставь зону с услугой из раздела «Услуги и цены» и возьми её id.');
      const items = compatibleJewelry(db, service.id);
      if (items.length === 0) {
        return {
          content:
            `Для «${service.name}» сейчас нет подходящих украшений в наличии. Скажи клиенту честно, предложи посмотреть все ` +
            'украшения кнопкой «💎 Украшения» или уточнить у администратора.',
        };
      }
      if (!sink.carousels.some((l) => l.by === 'service' && l.id === service.id)) sink.carousels.push({ by: 'service', id: service.id });
      if (scope.mode === 'test') sink.notes.push(`отправлен бы каталог украшений для «${service.name}»`);
      return {
        content:
          `Каталог «Украшения для «${service.name}»» с фото, размерами и ценами будет отправлен клиенту после твоего ответа — ` +
          `он сможет листать и выбрать кнопкой. В каталоге: ${items.map((p) => p.name).join(', ')}. Не перечисляй их все в тексте.`,
      };
    },

    find_jewelry: async (raw) => {
      const parsed = findInput.safeParse(raw);
      if (!parsed.success) return error('Некорректные данные: передай ключевые слова поиска.');
      const matches = searchJewelry(db, parsed.data.query, FIND_JEWELRY_LIMIT);
      if (matches.length === 0) {
        return {
          content:
            `По запросу «${parsed.data.query}» ничего не найдено. Не придумывай наличие: предложи посмотреть каталог ` +
            '(кнопка «💎 Украшения») или уточнить у администратора.',
        };
      }
      const links = serviceIdsByProduct(db, matches.map((m) => m.product.id));
      const serviceNames = new Map(db.select({ id: services.id, name: services.name }).from(services).all().map((s) => [s.id, s.name]));
      const lines = matches.map(({ product: p, inStock }) => {
        const suits = (links.get(p.id) ?? []).map((id) => serviceNames.get(id)).filter(Boolean);
        return [
          `• [id ${p.id}] ${p.name}${p.kind === 'goods' ? ' (товар)' : ''}`,
          p.category,
          p.material,
          threadLabel(p.threadType),
          p.thicknessMm != null ? formatThickness(p.thicknessMm) : null,
          p.color,
          p.stone,
          suits.length ? `подходит для: ${suits.join(', ')}` : null,
          inStock.length ? `в наличии — ${offerText(p, inStock)}` : `нет в наличии (цена ${formatRub(p.price)})`,
          p.photoUrl ? 'есть фото' : null,
        ]
          .filter(Boolean)
          .join(' · ');
      });
      return {
        content:
          `Найдено на складе (количество клиенту не называй; предлагай только размеры «в наличии»):\n${lines.join('\n')}\n` +
          'Чтобы показать фото позиции в наличии — вызови show_products с её id.',
      };
    },

    my_appointments: async () => {
      const clientId = linkedClientId();
      if (clientId === null) return { content: NOT_IDENTIFIED };
      const rows = upcomingForClient(db, clientId);
      if (rows.length === 0) return { content: 'У клиента нет предстоящих записей.' };
      return { content: `Предстоящие записи клиента:\n${describeForClient(db, rows).join('\n')}` };
    },

    free_slots: async (raw) => {
      const parsed = slotsInput.safeParse(raw);
      if (!parsed.success) return error('Некорректные данные: дата нужна в формате ГГГГ-ММ-ДД.');
      const input = parsed.data;
      const { timezone: tz, onlineBooking: online } = getStudioSettings(db);
      const now = Date.now();
      const day = DateTime.fromISO(input.date, { zone: tz });
      if (!day.isValid) return error('Такой даты нет. Дата нужна в формате ГГГГ-ММ-ДД.');
      if (input.date < localDate(now, tz)) return error('Эта дата уже прошла. Уточни у клиента другую дату.');
      if (day.diff(DateTime.fromMillis(now, { zone: tz }).startOf('day'), 'days').days > online.horizonDays) {
        return error(`Можно смотреть не дальше чем на ${online.horizonDays} дней вперёд.`);
      }
      let durationMin = DEFAULT_SLOT_MINUTES;
      let masterId = input.masterId ?? undefined;
      let excludeAppointmentId: number | undefined;
      let note = `длительность ${DEFAULT_SLOT_MINUTES} мин (услуга не указана)`;
      if (input.appointmentId != null) {
        const clientId = linkedClientId();
        if (clientId === null) return { content: NOT_IDENTIFIED };
        const own = ownActiveAppointment(db, clientId, input.appointmentId, now);
        if (!own.ok) return error(own.text);
        durationMin = Math.round((own.appointment.endsAt - own.appointment.startsAt) / MINUTE_MS);
        masterId = own.appointment.masterId; // a moved appointment keeps its master
        excludeAppointmentId = own.appointment.id;
        note = `для переноса записи №${own.appointment.id}: длительность ${durationMin} мин, тот же мастер`;
      } else if (input.serviceId != null) {
        const service = db.select().from(services).where(and(eq(services.id, input.serviceId), eq(services.active, true))).get();
        if (!service) return error('Такой услуги нет в прайсе.');
        durationMin = service.durationMin;
        note = `для «${service.name}»: длительность ${durationMin} мин`;
      }
      if (masterId !== undefined && bookableMasters(db, masterId).length === 0) return error('Такого мастера нет.');
      const result = freeSlots(db, { date: input.date, durationMin, masterId, excludeAppointmentId, now });
      const dayTitle = formatHumanDateTime(day.startOf('day').toMillis(), tz).replace(/ в \d{2}:\d{2}$/, '');
      const lines = result.map(({ master, off, starts }) =>
        `• ${master.name} [id ${master.id}]: ${off ? 'не работает в этот день' : starts.length ? starts.map((s) => formatTime(s, tz)).join(', ') : 'нет свободного времени'}`,
      );
      const anyFree = result.some((r) => r.starts.length > 0);
      return {
        content:
          `Свободное время на ${dayTitle} (${input.date}), ${note}, шаг ${online.stepMinutes} мин:\n${lines.join('\n')}\n` +
          (anyFree
            ? `Для book_appointment и reschedule_appointment передавай startsAt в виде «${input.date} ЧЧ:ММ», например «${studioDateTimeText(result.find((r) => r.starts.length)!.starts[0]!, tz)}».`
            : 'Свободного времени нет — предложи другую дату.'),
      };
    },

    reschedule_appointment: async (raw) => {
      const parsed = rescheduleInput.safeParse(raw);
      if (!parsed.success) return error('Некорректные данные: нужен номер записи и время «ГГГГ-ММ-ДД ЧЧ:ММ».');
      const clientId = linkedClientId();
      if (clientId === null) return { content: NOT_IDENTIFIED };
      const tz = studioTimezone(db);
      const startsAt = parseStudioDateTime(parsed.data.startsAt, tz);
      if (startsAt === null) return error('Время не распознано: передай его как «ГГГГ-ММ-ДД ЧЧ:ММ» по времени студии.');
      const result = await rescheduleForClient(ctx, {
        clientId,
        appointmentId: parsed.data.appointmentId,
        startsAt,
        dryRun: scope.mode === 'test',
      });
      if (!result.ok) return error(result.text);
      if (scope.mode === 'test') sink.notes.push(`запись №${parsed.data.appointmentId} перенеслась бы на ${parsed.data.startsAt}`);
      else sink.done.add('reschedule');
      return { content: result.text };
    },
  };
}
