import type { InlineKeyboard, ReplyKeyboard } from '../bot/gateway.js';
import { BUTTONS, PHONE_KEYBOARD } from '../bot/keyboards.js';
import { notifyStaff } from '../bot/staff.js';
import type { AppContext } from '../context.js';
import type { DbOrTx } from '../db/client.js';
import { errorMessage } from '../lib/errors.js';
import { clientFullName, type AppointmentRow, type ClientRow, type QrPaymentRow } from '../lib/serialize.js';
import { formatRub } from '../lib/text.js';
import { formatTime } from '../lib/time.js';
import { onlineBookingPush } from '../push/staff-events.js';
import { formatWhen } from './audit-text.js';
import { findChat, storeMessage, upsertChat } from './bot-chats.js';
import { cancellationPolicyText } from './cancellation.js';
import { appointmentLedger, heldAmount } from './deposit-ledger.js';
import { bookingPageUrl } from './online-booking-links.js';
import { employeesByIds, getClientRow, serviceLinesByAppointment } from './refs.js';
import { getStudioSettings } from './settings.js';

/**
 * Telegram texts of online booking (docs/API.md «Online booking» → «Settlement»): to the staff chat and to the
 * client's chat. Sending never throws — the booking is already saved; a failure is logged.
 */

export const CHANNEL_LABELS: Record<string, string> = { bot: 'бот', miniapp: 'Mini App', web: 'сайт' };
export const PAY_BUTTON = '💳 Оплатить предоплату';

/** What every message names about a booking. */
export interface BookingFacts {
  id: number;
  client: ClientRow;
  clientName: string;
  phone: string;
  /** Service line names. */
  what: string;
  /** «21 октября, 15:00» in the studio timezone. */
  when: string;
  master: string;
}

export function bookingFacts(db: DbOrTx, a: AppointmentRow, now = Date.now()): BookingFacts {
  const tz = getStudioSettings(db).timezone;
  const client = getClientRow(db, a.clientId);
  const lines = serviceLinesByAppointment(db, [a.id]).get(a.id) ?? [];
  return {
    id: a.id,
    client,
    clientName: clientFullName(client),
    phone: client.phone ?? 'без телефона',
    what: lines.map((l) => l.name).join(', ') || a.title?.trim() || 'процедура',
    when: formatWhen(a.startsAt, tz, now),
    master: employeesByIds(db, [a.masterId]).get(a.masterId)?.name ?? '—',
  };
}

/** «Анна, +7…, Мочка — 21 октября, 15:00, мастер Фатима» */
const summary = (f: BookingFacts): string => `${f.clientName}, ${f.phone}, ${f.what} — ${f.when}, мастер ${f.master}`;

const heldOf = (db: DbOrTx, a: AppointmentRow): number => heldAmount(appointmentLedger(db, a.id));

// ---------- staff ----------

export function staffBookedText(db: DbOrTx, a: AppointmentRow, f: BookingFacts): string {
  const tz = getStudioSettings(db).timezone;
  const state =
    a.onlineState === 'awaiting_payment' && a.holdUntil != null ? `ждёт оплату до ${formatTime(a.holdUntil, tz)}` : 'ждёт подтверждения';
  const head = `🆕 Онлайн-запись (${CHANNEL_LABELS[a.channel] ?? a.channel}): ${summary(f)} · ${state}`;
  return a.notes?.trim() ? `${head}\nКомментарий: ${a.notes.trim()}` : head;
}

export const staffPaidText = (f: BookingFacts, amount: number): string =>
  `💳 Онлайн-запись оплачена: ${summary(f)} · предоплата ${formatRub(amount)}`;

export const staffReleasedText = (f: BookingFacts): string =>
  `⌛ Онлайн-запись №${f.id} снята — предоплата не поступила вовремя: ${summary(f)}`;

export const staffUnconfirmedText = (f: BookingFacts): string =>
  `⌛ Онлайн-запись №${f.id} отклонена — её не подтвердили вовремя: ${summary(f)}`;

export function staffClientCancelText(db: DbOrTx, a: AppointmentRow, f: BookingFacts): string {
  const held = heldOf(db, a);
  const head = `❌ Клиент отменил онлайн-запись №${f.id}: ${summary(f)}`;
  return held > 0 ? `${head}\nЗа записью предоплата ${formatRub(held)} — верните или удержите её по правилам в карточке записи.` : head;
}

// ---------- the client ----------

export interface ClientMessage {
  text: string;
  keyboard?: InlineKeyboard;
  /** The keyboard under the input field (ignored with `keyboard`). */
  replyKeyboard?: ReplyKeyboard;
}

export const clientBookedText = (f: BookingFacts): string =>
  `Заявка принята, время за вами 🙌 Подтвердим в ближайшее время.\n\n**${f.when}** — ${f.what}\nМастер: ${f.master}`;

/** The payment request: the time is held until `holdUntil`, the link opens the client's bank app. */
export function clientPaymentMessage(db: DbOrTx, a: AppointmentRow, f: BookingFacts, payment: QrPaymentRow): ClientMessage {
  const until = formatTime(a.holdUntil ?? payment.expiresAt, getStudioSettings(db).timezone);
  return {
    text:
      `Время **${f.when}** за вами до ${until} 🙌\n` +
      `Чтобы подтвердить запись, внесите предоплату **${formatRub(payment.amount)}** по кнопке ниже — она зачтётся в ` +
      `стоимость процедуры.\n\n${f.what}, мастер ${f.master}\nЕсли не успеть до ${until}, время освободится.`,
    keyboard: [[{ text: PAY_BUTTON, url: payment.payload }]],
  };
}

/** «✅ Запись подтверждена: 21 октября, 15:00, мастер Фатима, адрес…» and, with a prepayment, the cancellation rule. */
export function clientConfirmedText(db: DbOrTx, a: AppointmentRow, f: BookingFacts): string {
  const studio = getStudioSettings(db);
  const address = studio.address.trim() ? `, ${studio.address.trim()}` : '';
  const lines = [`✅ Запись подтверждена: ${f.when}, мастер ${f.master}${address}`, f.what];
  if (a.depositRequired > 0 || heldOf(db, a) > 0) lines.push('', cancellationPolicyText(studio.cancellation));
  return lines.join('\n');
}

function againLine(ctx: AppContext, label: string): string {
  const url = bookingPageUrl(ctx.config);
  return url ? `${label}: ${url}` : 'Напишите нам здесь — подберём другое время.';
}

export function clientRejectedText(ctx: AppContext, f: BookingFacts, reason: string | null): string {
  const lines = [`😔 Не получится принять запись на ${f.when}.`];
  if (reason) lines.push(`Причина: ${reason}`);
  lines.push('', againLine(ctx, 'Выберите другое время'));
  return lines.join('\n');
}

export const clientReleasedText = (ctx: AppContext, f: BookingFacts): string =>
  `⌛ Время ${f.when} освободилось — предоплата не поступила вовремя.\n${againLine(ctx, 'Записаться снова')}`;

// ---------- delivery ----------

/**
 * Sends to a chat and keeps a copy in the conversation the staff see. The chat is never attributed to a client here:
 * only a linked chat (or the Mini App chat that made the booking) is written to.
 */
export async function deliverToChat(ctx: AppContext, chatId: number, message: ClientMessage): Promise<boolean> {
  if (!ctx.gateway.isRunning()) return false;
  try {
    await ctx.gateway.sendText(chatId, message.text, { keyboard: message.keyboard, replyKeyboard: message.replyKeyboard });
    if (!findChat(ctx.db, chatId)) upsertChat(ctx.db, chatId);
    storeMessage(ctx.db, chatId, 'system', message.text);
    return true;
  } catch (err) {
    ctx.log.warn({ chatId, err: errorMessage(err) }, 'online booking message not delivered');
    return false;
  }
}

/** To the chat linked to the booking's client (or `chatId`); nothing when there is none. */
export async function tellClient(ctx: AppContext, a: AppointmentRow, message: ClientMessage, chatId?: number | null): Promise<boolean> {
  const target = chatId ?? getClientRow(ctx.db, a.clientId).telegramChatId;
  return target != null ? deliverToChat(ctx, target, message) : false;
}

/** Never throws: what the staff chat and the client hear must not fail a booking that is already saved. */
export async function safely(ctx: AppContext, what: string, send: () => Promise<unknown>): Promise<void> {
  try {
    await send();
  } catch (err) {
    ctx.log.warn({ err: errorMessage(err) }, `online booking: ${what} failed`);
  }
}

/** The client's message right after booking: the payment request, else «Заявка принята…». */
export function clientBookingMessage(db: DbOrTx, a: AppointmentRow, f: BookingFacts, payment: QrPaymentRow | null): ClientMessage {
  return payment ? clientPaymentMessage(db, a, f, payment) : { text: clientBookedText(f) };
}

export const SHARE_NUMBER_TEXT = `Чтобы уведомления о записи приходили сюда, нажмите «${BUTTONS.contact}» внизу 👇 Это нужно сделать один раз.`;

/** A Mini App chat not linked to a card: linking needs the person's own contact (the bot's phone button). */
export async function askToShareNumber(ctx: AppContext, chatId: number): Promise<void> {
  await safely(ctx, 'share number request', () => deliverToChat(ctx, chatId, { text: SHARE_NUMBER_TEXT, replyKeyboard: PHONE_KEYBOARD }));
}

/** The payment request with the «💳 Оплатить предоплату» button (the bot sends it after the AI's reply). */
export async function sendPaymentRequest(ctx: AppContext, a: AppointmentRow, payment: QrPaymentRow): Promise<void> {
  await safely(ctx, 'payment request', () => tellClient(ctx, a, clientPaymentMessage(ctx.db, a, bookingFacts(ctx.db, a), payment)));
}

/**
 * A new booking: the staff chat is told, and the client too (unless `toClient` is false: the bot's AI tells them
 * itself and sends only the payment request).
 */
export async function announceBooking(
  ctx: AppContext,
  a: AppointmentRow,
  payment: QrPaymentRow | null,
  opts: { toClient: boolean; chatId?: number | null },
): Promise<void> {
  await safely(ctx, 'new booking notice', async () => {
    const facts = bookingFacts(ctx.db, a);
    await notifyStaff(ctx, staffBookedText(ctx.db, a, facts), () => onlineBookingPush(ctx.db, a));
    if (opts.toClient) await tellClient(ctx, a, clientBookingMessage(ctx.db, a, facts, payment), opts.chatId);
  });
}
