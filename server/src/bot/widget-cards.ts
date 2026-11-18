import { and, asc, eq } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { appointments, widgetCards } from '../db/schema.js';
import { getBotSettings, getStudioSettings } from '../domain/settings.js';
import { errorMessage } from '../lib/errors.js';
import type { AppointmentRow } from '../lib/serialize.js';
import { BotSendError, type SentMessage } from './gateway.js';
import { APPOINTMENT_CARD_HTML, appointmentCardData, cardIsFinal, type CardKind } from './widget-card.js';

/**
 * The appointment cards sent to clients (bot/widget-card.ts) and keeping them live: every card is registered in
 * `widget_cards`, and the background pass redraws each one whose appointment changed — confirmed by staff, paid,
 * moved, cancelled, completed — whoever made the change. A card retires once it shows a final state.
 */

type CardRow = typeof widgetCards.$inferSelect;

/** Cards redrawn per background pass (each is one Telegram call at most). */
const REFRESH_BATCH = 200;

/** Telegram no longer has the message (deleted by the user, or the chat is gone): the card retires. */
const messageGone = (err: unknown): boolean =>
  err instanceof BotSendError && (err.blocked || /message to edit not found|message not found|message_id_invalid/i.test(err.message));

export const defaultCardTitle = (ctx: AppContext): string => `🗓 Ваша запись в ${getStudioSettings(ctx.db).name}`;

export interface CardSend {
  chatId: number;
  appointment: AppointmentRow;
  kind: CardKind;
  title: string;
  /** The message text: the card's caption, shown instead of the card by apps without widget support. */
  caption: string;
}

/**
 * Sends the appointment card while «widgetCards» is on and registers it for live redraws. Null when it was not sent
 * as a card — the setting is off, or Telegram refused the widget (an old API, a rejected widget) — then the caller
 * sends its plain message. An unreachable chat or a flood limit is thrown, like any other send.
 */
export async function sendAppointmentCard(ctx: AppContext, card: CardSend): Promise<SentMessage | null> {
  if (!getBotSettings(ctx.db).widgetCards) return null;
  const chatData = appointmentCardData(ctx.db, card.appointment, { kind: card.kind, title: card.title, pressed: null });
  let sent: SentMessage;
  try {
    sent = await ctx.gateway.sendWidget(card.chatId, { html: APPOINTMENT_CARD_HTML, chatData, caption: card.caption });
  } catch (err) {
    if (err instanceof BotSendError && (err.blocked || err.retryAfterMs !== null)) throw err;
    ctx.log.warn({ appointmentId: card.appointment.id, err: errorMessage(err) }, 'appointment card not sent, sending the plain message');
    return null;
  }
  if (sent.messageId > 0) {
    const now = Date.now();
    ctx.db
      .insert(widgetCards)
      .values({
        chatId: card.chatId,
        messageId: sent.messageId,
        appointmentId: card.appointment.id,
        kind: card.kind,
        title: card.title,
        chatData,
        active: !cardIsFinal(card.appointment, now),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .run();
  }
  return sent;
}

/** «Перенести» stays shown until the appointment changes after the press. */
function pressedNow(row: CardRow, appointment: AppointmentRow): 'm' | null {
  return row.pressed === 'm' && row.pressedAt !== null && appointment.updatedAt <= row.pressedAt ? 'm' : null;
}

/** Draws `row` as `appointment` is now; the row keeps what was drawn. Throws Telegram's errors. */
async function draw(ctx: AppContext, row: CardRow, appointment: AppointmentRow, pressed: 'm' | null, now: number): Promise<boolean> {
  const chatData = appointmentCardData(ctx.db, appointment, { kind: row.kind as CardKind, title: row.title, pressed, now });
  const changed = chatData !== row.chatData;
  const active = !cardIsFinal(appointment, now);
  if (changed) await ctx.gateway.editWidgetData(row.chatId, row.messageId, chatData);
  // Most passes change nothing: the row is written only when something did.
  if (changed || active !== row.active || pressed !== row.pressed) {
    ctx.db.update(widgetCards).set({ chatData, pressed, active, updatedAt: now }).where(eq(widgetCards.id, row.id)).run();
  }
  return changed;
}

function retire(ctx: AppContext, row: CardRow, now: number): void {
  ctx.db.update(widgetCards).set({ active: false, updatedAt: now }).where(eq(widgetCards.id, row.id)).run();
}

export interface RefreshStats {
  redrawn: number;
  retired: number;
}

/**
 * Redraws every active card whose content changed and retires the finished ones. Runs with the scheduled sender;
 * does nothing while the bot is offline. A flood limit ends the pass (the rest waits for the next one).
 */
export async function refreshWidgetCards(ctx: AppContext, now = Date.now()): Promise<RefreshStats> {
  const stats: RefreshStats = { redrawn: 0, retired: 0 };
  if (!ctx.gateway.isRunning()) return stats;
  const rows = ctx.db.select().from(widgetCards).where(eq(widgetCards.active, true)).orderBy(asc(widgetCards.id)).limit(REFRESH_BATCH).all();
  for (const row of rows) {
    const appointment = ctx.db.select().from(appointments).where(eq(appointments.id, row.appointmentId)).get();
    if (!appointment) {
      retire(ctx, row, now);
      stats.retired += 1;
      continue;
    }
    try {
      if (await draw(ctx, row, appointment, pressedNow(row, appointment), now)) stats.redrawn += 1;
      if (cardIsFinal(appointment, now)) stats.retired += 1;
    } catch (err) {
      if (messageGone(err)) {
        retire(ctx, row, now);
        stats.retired += 1;
        continue;
      }
      ctx.log.warn({ cardId: row.id, err: errorMessage(err) }, 'appointment card not redrawn');
      if (err instanceof BotSendError && err.retryAfterMs !== null) break;
    }
  }
  return stats;
}

/**
 * Redraws the card a press came from, at once: `pressed` is «m» after «Перенести». A card sent before the registry
 * (the first pilot) is drawn as a reminder card with the studio's title. A failure is only logged: the press itself
 * is done and answered.
 */
export async function redrawPressedCard(
  ctx: AppContext,
  chatId: number,
  messageId: number,
  appointment: AppointmentRow,
  pressed: 'm' | null,
): Promise<void> {
  const now = Date.now();
  try {
    const row = ctx.db
      .select()
      .from(widgetCards)
      .where(and(eq(widgetCards.chatId, chatId), eq(widgetCards.messageId, messageId)))
      .get();
    if (row && row.appointmentId === appointment.id) {
      ctx.db.update(widgetCards).set({ pressedAt: now }).where(eq(widgetCards.id, row.id)).run();
      await draw(ctx, { ...row, pressedAt: now }, appointment, pressed, now);
      return;
    }
    const chatData = appointmentCardData(ctx.db, appointment, { kind: 'reminder', title: defaultCardTitle(ctx), pressed, now });
    await ctx.gateway.editWidgetData(chatId, messageId, chatData);
  } catch (err) {
    ctx.log.warn({ chatId, appointmentId: appointment.id, err: errorMessage(err) }, 'appointment card not redrawn');
  }
}
