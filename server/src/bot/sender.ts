import { and, asc, eq, lte } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { appointments, clients, scheduledMessages } from '../db/schema.js';
import { storeMessage, upsertChat } from '../domain/bot-chats.js';
import { reminderAsSent } from '../domain/cancellation.js';
import { followUpSkipReason } from '../domain/follow-ups.js';
import { RESCHEDULE_NOTICE } from '../domain/reschedule-notice.js';
import { ACTIVE_APPOINTMENT_STATUSES } from '../domain/scheduling.js';
import { errorMessage } from '../lib/errors.js';
import type { ScheduledRow } from '../lib/serialize.js';
import { truncate } from '../lib/text.js';
import { reminderKeyboard } from './callbacks.js';
import { followUpKeyboard } from './follow-ups.js';
import { BotSendError, type InlineKeyboard } from './gateway.js';

export const SENDER_INTERVAL_MS = 30_000;
export const MAX_ATTEMPTS = 3;
const BATCH = 20;

export interface SendStats {
  sent: number;
  failed: number;
  cancelled: number;
  retried: number;
}

function mark(ctx: AppContext, id: number, patch: Partial<ScheduledRow>): void {
  ctx.db.update(scheduledMessages).set(patch).where(eq(scheduledMessages.id, id)).run();
}

/** Messages about a coming visit: they go out only while it is active and ahead, with the reminder buttons. */
const aboutComingVisit = (msg: ScheduledRow) => msg.kind === 'reminder' || msg.kind === RESCHEDULE_NOTICE;

/** Why a due message should not be sent any more, or null if it should. */
function skipReason(ctx: AppContext, msg: ScheduledRow, now: number): string | null {
  const client = ctx.db.select().from(clients).where(eq(clients.id, msg.clientId)).get();
  if (!client) return 'Клиент удалён';
  if (!client.botEnabled) return 'Клиент отключил сообщения бота';
  if (aboutComingVisit(msg) && msg.appointmentId != null) {
    const appointment = ctx.db.select().from(appointments).where(eq(appointments.id, msg.appointmentId)).get();
    if (!appointment || !(ACTIVE_APPOINTMENT_STATUSES as readonly string[]).includes(appointment.status)) {
      return 'Запись отменена или завершена';
    }
    if (appointment.startsAt <= now) return 'Время записи уже наступило';
  }
  return followUpSkipReason(ctx.db, msg, client);
}

/** Reminders, reschedule notices and follow-ups carry their inline buttons. */
function keyboardOf(msg: ScheduledRow): InlineKeyboard | undefined {
  if (msg.appointmentId == null) return undefined;
  return aboutComingVisit(msg) ? reminderKeyboard(msg.appointmentId) : followUpKeyboard(msg.kind, msg.appointmentId);
}

/** Sends due pending aftercare/reminder/reschedule/follow-up messages. Does nothing while the bot is offline. */
export async function processDueMessages(ctx: AppContext, now = Date.now()): Promise<SendStats> {
  const stats: SendStats = { sent: 0, failed: 0, cancelled: 0, retried: 0 };
  if (!ctx.gateway.isRunning()) return stats;
  const due = ctx.db
    .select()
    .from(scheduledMessages)
    .where(and(eq(scheduledMessages.status, 'pending'), lte(scheduledMessages.sendAt, now)))
    .orderBy(asc(scheduledMessages.sendAt), asc(scheduledMessages.id))
    .limit(BATCH)
    .all();

  for (const row of due) {
    // A reminder's free-cancellation line depends on the prepayment held when it is sent.
    const msg = row.kind === 'reminder' ? { ...row, text: reminderAsSent(ctx.db, row, now) } : row;
    const reason = skipReason(ctx, msg, now);
    if (reason) {
      mark(ctx, msg.id, { status: 'cancelled', error: reason });
      stats.cancelled += 1;
      continue;
    }
    const client = ctx.db.select().from(clients).where(eq(clients.id, msg.clientId)).get();
    const chatId = client?.telegramChatId ?? msg.chatId;
    try {
      const keyboard = keyboardOf(msg);
      await ctx.gateway.sendText(chatId, msg.text, keyboard ? { keyboard } : {});
      mark(ctx, msg.id, { status: 'sent', sentAt: Date.now(), error: null, chatId, text: msg.text });
      upsertChat(ctx.db, chatId, { clientId: msg.clientId });
      storeMessage(ctx.db, chatId, 'system', msg.text);
      stats.sent += 1;
    } catch (err) {
      const attempts = msg.attempts + 1;
      if (err instanceof BotSendError && err.blocked) {
        mark(ctx, msg.id, { status: 'failed', attempts, error: 'Клиент заблокировал бота или чат недоступен' });
        stats.failed += 1;
      } else if (attempts >= MAX_ATTEMPTS) {
        mark(ctx, msg.id, { status: 'failed', attempts, error: truncate(errorMessage(err), 500) });
        stats.failed += 1;
      } else {
        mark(ctx, msg.id, { attempts, error: truncate(errorMessage(err), 500) });
        stats.retried += 1;
      }
      ctx.log.warn({ scheduledId: msg.id, attempts, err: errorMessage(err) }, 'scheduled message not delivered');
    }
  }
  return stats;
}
