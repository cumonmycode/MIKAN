import { and, eq } from 'drizzle-orm';
import { DateTime } from 'luxon';
import type { DbOrTx } from '../db/client.js';
import { clients, employees, scheduledMessages } from '../db/schema.js';
import type { AppointmentRow } from '../lib/serialize.js';
import { ACTIVE_APPOINTMENT_STATUSES } from './scheduling.js';
import { studioTimezone } from './settings.js';

/**
 * «Ваша запись перенесена» (docs/API.md → Appointments, `notifyClient`): staff moved an appointment and asked to tell
 * the client. Queued with `sendAt = now`; bot/sender.ts sends it with the reminder buttons «✅ Приду» / «🔁 Перенести».
 */

export const RESCHEDULE_NOTICE = 'reschedule_notice';

/** «21 октября, 15:00» in the studio timezone. */
export function formatNoticeMoment(ms: number, tz: string): string {
  return DateTime.fromMillis(ms, { zone: tz }).setLocale('ru').toFormat('d MMMM, HH:mm');
}

export function rescheduleNoticeText(clientName: string, was: string, now: string, masterName: string | null): string {
  const name = clientName.trim();
  const lines = [
    name ? `${name}, ваша запись перенесена 🗓` : 'Ваша запись перенесена 🗓',
    '',
    `Было: ${was}`,
    `Стало: **${now}**`,
  ];
  if (masterName) lines.push(`Мастер: ${masterName}`);
  lines.push('', 'Если новое время не подходит — нажмите «🔁 Перенести».');
  return lines.join('\n');
}

function cancelPendingNotices(db: DbOrTx, appointmentId: number): void {
  db.update(scheduledMessages)
    .set({ status: 'cancelled' })
    .where(
      and(
        eq(scheduledMessages.appointmentId, appointmentId),
        eq(scheduledMessages.kind, RESCHEDULE_NOTICE),
        eq(scheduledMessages.status, 'pending'),
      ),
    )
    .run();
}

/**
 * After a write that changed `startsAt`: a pending notice of the appointment is dropped (it names a time that is gone),
 * and with `notify` a new one is queued — for a future active appointment of a client with Telegram and the bot on.
 */
export function syncRescheduleNotice(db: DbOrTx, before: AppointmentRow, after: AppointmentRow, notify: boolean, now = Date.now()): void {
  if (after.startsAt === before.startsAt) return;
  cancelPendingNotices(db, after.id);
  if (!notify || after.startsAt <= now) return;
  if (!(ACTIVE_APPOINTMENT_STATUSES as readonly string[]).includes(after.status)) return;
  const client = db.select().from(clients).where(eq(clients.id, after.clientId)).get();
  if (!client?.telegramChatId || !client.botEnabled) return;
  const master = db.select({ name: employees.name }).from(employees).where(eq(employees.id, after.masterId)).get();
  const tz = studioTimezone(db);
  db.insert(scheduledMessages)
    .values({
      chatId: client.telegramChatId,
      clientId: client.id,
      appointmentId: after.id,
      kind: RESCHEDULE_NOTICE,
      sendAt: now,
      text: rescheduleNoticeText(client.name, formatNoticeMoment(before.startsAt, tz), formatNoticeMoment(after.startsAt, tz), master?.name ?? null),
      status: 'pending',
      createdAt: now,
    })
    .run();
}
