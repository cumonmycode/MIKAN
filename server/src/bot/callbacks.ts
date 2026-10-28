import { and, eq, gt } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { productVariants, services } from '../db/schema.js';
import { findClientByChat } from '../domain/clients.js';
import { variantsByProduct } from '../domain/products.js';
import { studioTimezone } from '../domain/settings.js';
import { errorMessage } from '../lib/errors.js';
import { sizedName } from '../lib/jewelry.js';
import type { ProductRow, VariantRow } from '../lib/serialize.js';
import { formatRub, formatServicePrice } from '../lib/text.js';
import { formatHumanDateTime } from '../lib/time.js';
import { isSmmCallback, onSmmCallback } from '../smm/tg-handlers.js';
import { decodeCallback, encodeCallback, type CallbackAction, type JewelryList } from './callback-data.js';
import {
  jewelryCategoriesMenu,
  jewelryKeyboard,
  jewelryPage,
  sendPage,
  serviceSectionsMenu,
  servicePage,
  showMenu,
  showPageInPlace,
  sizeKeyboard,
  type CurrentMessage,
} from './catalog.js';
import { appointmentWhat, confirmForClient, ownActiveAppointment } from './client-appointments.js';
import type { InlineKeyboard } from './gateway.js';
import type { BotPipeline, IncomingFrom } from './pipeline.js';

/** Inline buttons: catalog paging and choices, the reminder buttons, and the SMM buttons of staff. */

export interface CallbackDeps {
  ctx: AppContext;
  pipeline: BotPipeline;
}

export interface CallbackQueryInput {
  /** The private chat (and its Telegram user). */
  from: IncomingFrom;
  data: string;
  /** The message the button belongs to; null when Telegram did not send it (too old). */
  message: CurrentMessage | null;
}

/** The toast shown to the user after a press (Telegram `answerCallbackQuery`). */
export interface CallbackAnswer {
  text?: string;
}

export const REMINDER_BUTTONS = { confirm: '✅ Приду', move: '🔁 Перенести' } as const;

export function reminderKeyboard(appointmentId: number): InlineKeyboard {
  return [
    [
      { text: REMINDER_BUTTONS.confirm, data: encodeCallback({ kind: 'reminderConfirm', appointmentId }) },
      { text: REMINDER_BUTTONS.move, data: encodeCallback({ kind: 'reminderMove', appointmentId }) },
    ],
  ];
}

const STALE = 'Каталог обновился — откройте его заново кнопкой «💎 Украшения» или «💉 Услуги и цены»';

/** «[Выбрано] Лабрет — 8 мм · 1 700 ₽ (украшение id 12)»: the choice handed to the AI as the client's message. */
export function jewelryChoiceText(product: ProductRow, size: VariantRow | null, context: string | null): string {
  const price = formatRub(size?.price ?? product.price);
  return `[Выбрано] ${sizedName(product.name, size?.name)} · ${price} (украшение id ${product.id}${context ? `, ${context}` : ''})`;
}

export async function handleCallback(deps: CallbackDeps, query: CallbackQueryInput): Promise<CallbackAnswer> {
  // SMM buttons under previews and hand-offs (staff chats only; see smm/tg-handlers.ts).
  if (isSmmCallback(query.data)) {
    return onSmmCallback(deps.ctx, { chatId: query.from.chatId, data: query.data, messageId: query.message?.messageId ?? null });
  }
  const action = decodeCallback(query.data);
  if (!action) return { text: 'Эта кнопка устарела' };
  try {
    return await dispatch(deps, query, action);
  } catch (err) {
    deps.ctx.log.warn({ chatId: query.from.chatId, data: query.data, err: errorMessage(err) }, 'bot button failed');
    return { text: 'Не получилось — попробуйте ещё раз' };
  }
}

async function dispatch(deps: CallbackDeps, query: CallbackQueryInput, action: CallbackAction): Promise<CallbackAnswer> {
  const { ctx } = deps;
  const chatId = query.from.chatId;
  const dataDir = ctx.config.dataDir;
  switch (action.kind) {
    case 'noop':
      return {};

    case 'jewelryCategories': {
      const menu = jewelryCategoriesMenu(ctx.db);
      if (!menu) return { text: 'Сейчас украшений в наличии нет — уточните у администратора' };
      await showMenu(ctx, chatId, query.message, menu);
      return {};
    }

    case 'serviceCategories': {
      const menu = serviceSectionsMenu(ctx.db);
      if (!menu) return { text: 'Прайс пока не заполнен — уточните у администратора' };
      await showMenu(ctx, chatId, query.message, menu);
      return {};
    }

    case 'jewelryOpen':
    case 'serviceJewelry': {
      const list: JewelryList = action.kind === 'jewelryOpen' ? action.list : { by: 'service', id: action.serviceId };
      const page = jewelryPage(ctx.db, dataDir, list, 0);
      if (!page) return { text: 'Сейчас таких украшений нет в наличии' };
      await sendPage(ctx, chatId, page);
      return {};
    }

    case 'serviceOpen': {
      const page = servicePage(ctx.db, dataDir, action.list, 0);
      if (!page) return { text: STALE };
      await sendPage(ctx, chatId, page);
      return {};
    }

    case 'jewelryPage':
    case 'servicePage': {
      const page =
        action.kind === 'jewelryPage' ? jewelryPage(ctx.db, dataDir, action.list, action.index) : servicePage(ctx.db, dataDir, action.list, action.index);
      if (!page) return { text: STALE };
      if (query.message) await showPageInPlace(ctx, chatId, query.message, page);
      else await sendPage(ctx, chatId, page);
      return {};
    }

    case 'jewelryWant':
      return want(deps, query, action.list, action.index, action.productId);

    case 'jewelrySize':
      return pickSize(deps, query, action.list, action.index, action.variantId);

    case 'serviceBook': {
      const service = ctx.db.select().from(services).where(and(eq(services.id, action.serviceId), eq(services.active, true))).get();
      if (!service) return { text: STALE };
      deps.pipeline.receive(
        query.from,
        `[Выбрано] Записаться: ${service.name} · ${formatServicePrice(service.price, service.priceMax, service.priceFrom)} (услуга id ${service.id})`,
      );
      return { text: 'Отлично! Сейчас оформим запись 🙌' };
    }

    case 'reminderConfirm':
    case 'reminderMove':
      return reminderButton(deps, query, action.kind, action.appointmentId);
  }
}

/** The page the choice was made on, for the «для «Хеликс»» context of the choice. */
function listContext(deps: CallbackDeps, list: JewelryList): string | null {
  if (list.by !== 'service') return null;
  const service = deps.ctx.db.select({ name: services.name }).from(services).where(eq(services.id, list.id)).get();
  return service ? `для «${service.name}»` : null;
}

async function want(deps: CallbackDeps, query: CallbackQueryInput, list: JewelryList, index: number, productId: number): Promise<CallbackAnswer> {
  const { ctx } = deps;
  const page = jewelryPage(ctx.db, ctx.config.dataDir, list, index);
  if (!page || page.product.id !== productId) return { text: STALE };
  const sizes = variantsByProduct(ctx.db, [productId], { inStockOnly: true }).get(productId) ?? [];
  const named = sizes.filter((v) => v.name.trim());
  if (named.length >= 2 && query.message) {
    await ctx.gateway.editKeyboard(query.from.chatId, query.message.messageId, sizeKeyboard(list, page.index, page.product, named));
    return { text: 'Выберите размер' };
  }
  // One size (or several but no message to show size buttons on): the choice itself; the AI asks for a size if needed.
  deps.pipeline.receive(query.from, jewelryChoiceText(page.product, named.length === 1 ? named[0]! : null, listContext(deps, list)));
  return { text: 'Отлично! Передаю ваш выбор 🙌' };
}

async function pickSize(deps: CallbackDeps, query: CallbackQueryInput, list: JewelryList, index: number, variantId: number): Promise<CallbackAnswer> {
  const { ctx } = deps;
  const variant = ctx.db
    .select()
    .from(productVariants)
    .where(and(eq(productVariants.id, variantId), eq(productVariants.archived, false), gt(productVariants.quantity, 0)))
    .get();
  const page = jewelryPage(ctx.db, ctx.config.dataDir, list, index);
  if (!page) return { text: STALE };
  if (query.message) {
    await ctx.gateway.editKeyboard(query.from.chatId, query.message.messageId, jewelryKeyboard(list, page.index, page.total, page.product.id));
  }
  if (!variant || variant.productId !== page.product.id) return { text: 'Этот размер уже закончился — выберите другой' };
  deps.pipeline.receive(query.from, jewelryChoiceText(page.product, variant, listContext(deps, list)));
  return { text: 'Отлично! Передаю ваш выбор 🙌' };
}

async function reminderButton(
  deps: CallbackDeps,
  query: CallbackQueryInput,
  kind: 'reminderConfirm' | 'reminderMove',
  appointmentId: number,
): Promise<CallbackAnswer> {
  const { ctx, pipeline } = deps;
  const chatId = query.from.chatId;
  // Only the chat the client's Telegram is linked to (not an old chat merely attributed to them).
  const client = findClientByChat(ctx.db, chatId);
  const own = client ? ownActiveAppointment(ctx.db, client.id, appointmentId) : null;
  if (!client || !own?.ok) {
    if (query.message) await ctx.gateway.editKeyboard(chatId, query.message.messageId, null).catch(() => undefined);
    return { text: 'Эта запись уже неактуальна' };
  }
  const tz = studioTimezone(ctx.db);
  const when = formatHumanDateTime(own.appointment.startsAt, tz);
  if (kind === 'reminderMove') {
    pipeline.receive(
      query.from,
      `[Кнопка] 🔁 Хочу перенести запись №${appointmentId}: ${when} — ${appointmentWhat(ctx.db, [own.appointment]).get(appointmentId)}`,
    );
    return { text: 'Подберём другое время 🙌' };
  }
  const result = await confirmForClient(ctx, client.id, appointmentId);
  if (!result.ok) return { text: 'Эта запись уже неактуальна' };
  if (query.message) {
    const moveOnly = reminderKeyboard(appointmentId).map((row) => row.filter((b) => b.text === REMINDER_BUTTONS.move));
    await ctx.gateway.editKeyboard(chatId, query.message.messageId, moveOnly).catch(() => undefined);
  }
  await pipeline.receiveHandled(query.from, `[Кнопка] ${REMINDER_BUTTONS.confirm}`, result.text);
  return { text: 'Запись подтверждена ✅' };
}
