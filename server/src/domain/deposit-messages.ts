import { BotSendError, BotUnavailableError } from '../bot/gateway.js';
import { notifyStaff } from '../bot/staff.js';
import type { AppContext } from '../context.js';
import type { DbOrTx } from '../db/client.js';
import { badRequest, conflict, errorMessage } from '../lib/errors.js';
import { clientFullName, type AppointmentRow, type QrPaymentRow } from '../lib/serialize.js';
import { formatRub } from '../lib/text.js';
import { formatHumanDateTime, formatShortDateTime } from '../lib/time.js';
import { depositPaidPush } from '../push/staff-events.js';
import { findChat, findClientChat, storeMessage, upsertChat } from './bot-chats.js';
import { DEPOSIT_OPEN_STATUSES } from './deposit-ledger.js';
import { getAppointmentRow, getClientRow, serviceLinesByAppointment } from './refs.js';
import { getStudioSettings } from './settings.js';

/** Telegram texts about prepayments and their delivery through the bot. */

export type DepositLinkText = 'link' | 'reminder';

function serviceNames(db: DbOrTx, appointment: AppointmentRow): string[] {
  const names = (serviceLinesByAppointment(db, [appointment.id]).get(appointment.id) ?? []).map((l) => l.name);
  return names.length > 0 ? names : appointment.title?.trim() ? [appointment.title.trim()] : [];
}

/** The message carrying a prepayment link: the first one or a reminder. */
export function depositLinkText(db: DbOrTx, appointment: AppointmentRow, code: QrPaymentRow, kind: DepositLinkText): string {
  const studio = getStudioSettings(db);
  const when = formatHumanDateTime(appointment.startsAt, studio.timezone);
  const services = serviceNames(db, appointment);
  const lines =
    kind === 'link'
      ? [
          `Здравствуйте! Для подтверждения записи в ${studio.name} нужна предоплата ${formatRub(code.amount)}.`,
          `Когда: ${when}`,
          ...(services.length > 0 ? [`${services.length > 1 ? 'Услуги' : 'Услуга'}: ${services.join(', ')}`] : []),
        ]
      : [`Напоминаем о предоплате ${formatRub(code.amount)} за запись в ${studio.name} — ${when}.`];
  lines.push(
    '',
    `Оплатить через СБП: ${code.payload}`,
    `Ссылка действует до ${formatShortDateTime(code.expiresAt, studio.timezone)}. Предоплата зачтётся в стоимость процедуры.`,
  );
  return lines.join('\n');
}

export function depositThanksText(db: DbOrTx, appointment: AppointmentRow, amount: number): string {
  const studio = getStudioSettings(db);
  return `Спасибо! Предоплата ${formatRub(amount)} получена ✅\nЖдём вас ${formatHumanDateTime(appointment.startsAt, studio.timezone)}.`;
}

/**
 * The chat to send the appointment's prepayment messages to: `chatId` when given (e.g. the booking request's chat,
 * anonymous or already the client's — never another client's), else the client's own chat; null when the client
 * never wrote. Writes nothing: an anonymous chat is attributed only once a message reached it.
 */
export function depositChatFor(db: DbOrTx, appointment: AppointmentRow, chatId?: number | null): number | null {
  if (chatId != null) {
    const chat = findChat(db, chatId);
    if (!chat) throw badRequest('Чат Telegram не найден');
    if (chat.clientId != null && chat.clientId !== appointment.clientId) {
      throw conflict('Этот чат Telegram принадлежит другому клиенту — ссылка не отправлена');
    }
    return chatId;
  }
  return findClientChat(db, getClientRow(db, appointment.clientId))?.chatId ?? null;
}

/** Like `depositChatFor`, but refuses before anything is registered at the bank when the link cannot be delivered. */
export function requireDepositChat(ctx: AppContext, appointment: AppointmentRow, chatId?: number | null): number {
  const chat = depositChatFor(ctx.db, appointment, chatId);
  if (chat === null) {
    throw conflict(
      'Клиент ещё не писал боту в Telegram — поделитесь ссылкой другим способом или привяжите Telegram в карточке клиента',
    );
  }
  if (!ctx.gateway.isRunning()) {
    throw conflict('Telegram-бот выключен — ссылка не может быть отправлена. Включите бота в настройках или поделитесь ссылкой.');
  }
  return chat;
}

/**
 * Sends to the client's chat and keeps a copy in the conversation the staff see; an anonymous chat becomes the
 * client's (a chat attributed to someone else keeps its owner). Throws the gateway's errors.
 */
export async function sendToClientChat(ctx: AppContext, chatId: number, clientId: number, text: string): Promise<void> {
  await ctx.gateway.sendText(chatId, text);
  const owner = findChat(ctx.db, chatId)?.clientId ?? null;
  upsertChat(ctx.db, chatId, owner == null ? { clientId } : {});
  storeMessage(ctx.db, chatId, 'system', text);
}

/** Why a message did not reach the client, for staff. */
export function deliveryProblem(err: unknown): string {
  if (err instanceof BotUnavailableError) return 'Telegram-бот выключен — сообщение не отправлено';
  if (err instanceof BotSendError && err.blocked) return 'Клиент заблокировал бота — сообщение не доставлено';
  return 'Не удалось отправить сообщение в Telegram — поделитесь ссылкой другим способом';
}

/**
 * The bank confirmed a prepayment code: thank the client when the payment was expected (an open appointment, no
 * warning) and tell the staff chat. Never throws — the money is already recorded.
 */
export async function announceQrDeposit(ctx: AppContext, code: QrPaymentRow): Promise<void> {
  if (code.appointmentId == null) return;
  try {
    const appointment = getAppointmentRow(ctx.db, code.appointmentId);
    const client = getClientRow(ctx.db, appointment.clientId);
    const tz = getStudioSettings(ctx.db).timezone;
    await notifyStaff(
      ctx,
      `💳 Предоплата ${formatRub(code.amount)} по СБП получена: ${clientFullName(client)}, запись ${formatShortDateTime(appointment.startsAt, tz)}`,
      () => depositPaidPush(ctx.db, appointment, code.amount),
    );
    if (code.error || !DEPOSIT_OPEN_STATUSES.includes(appointment.status) || !ctx.gateway.isRunning()) return;
    const chatId = findClientChat(ctx.db, client)?.chatId;
    if (chatId == null) return;
    await sendToClientChat(ctx, chatId, client.id, depositThanksText(ctx.db, appointment, code.amount));
  } catch (err) {
    ctx.log.warn({ err: errorMessage(err), qrPaymentId: code.id }, 'prepayment confirmation not delivered');
  }
}
