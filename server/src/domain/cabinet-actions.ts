import { eq } from 'drizzle-orm';
import { appointmentWhat } from '../bot/client-appointments.js';
import { notifyStaff } from '../bot/staff.js';
import type { AppContext } from '../context.js';
import type { DbOrTx } from '../db/client.js';
import { appointments } from '../db/schema.js';
import { AppError, badRequest, conflict, notFound, scheduleConflict } from '../lib/errors.js';
import type { AppointmentRow } from '../lib/serialize.js';
import { formatRub, pluralWord } from '../lib/text.js';
import { formatHumanDateTime, formatTime, localDate, MINUTE_MS, toIso } from '../lib/time.js';
import { clientCancelledPush } from '../push/staff-events.js';
import { updateAppointment } from './appointments.js';
import { auditSafely, writeAudit } from './audit.js';
import { appointmentRef } from './audit-summaries-visits.js';
import { formatWhen } from './audit-text.js';
import { rescheduleStarts } from './cabinet-slots.js';
import { freeChangesOver, isChangeable } from './cabinet.js';
import { heldDeposit } from './deposits.js';
import { assertOnlineEnabled } from './online-booking.js';
import { CLIENT_CANCELLED_NOTE } from './online-booking-lifecycle.js';
import { bookingDates } from './online-booking-slots.js';
import { bookingFacts, safely } from './online-booking-messages.js';
import { employeesByIds, getAppointmentRow } from './refs.js';
import { getStudioSettings } from './settings.js';

/**
 * What the client changes in their cabinet (docs/API.md «Client cabinet»): moving and cancelling their own future
 * appointments while online booking is on. Like the bot: the reminders are rebuilt by the domain update, the staff
 * chat is told (a cancellation also by push), the change is logged with source `online`. Cancellation rules apply as
 * for staff (a late cancellation keeps the rules' share when `autoRetain` is on); a move is not limited by them.
 */

export const TIME_TAKEN = 'Это время уже занято';
/** The note line of an appointment the client cancelled in the cabinet (the growth report counts it by the prefix). */
export const CABINET_CANCELLED_NOTE = `${CLIENT_CANCELLED_NOTE} — личный кабинет`;

const appendNote = (notes: string | null, line: string): string => (notes?.trim() ? `${notes.trim()}\n${line}` : line);

/** The client's own appointment; somebody else's is «not found», never «forbidden». */
export function ownAppointment(db: DbOrTx, clientId: number, id: number): AppointmentRow {
  const row = db.select().from(appointments).where(eq(appointments.id, id)).get();
  if (!row || row.clientId !== clientId) throw notFound('Запись не найдена');
  return row;
}

export function assertChangeable(a: AppointmentRow, now: number, what: 'перенести' | 'отменить'): void {
  if (a.status === 'completed') throw conflict('Визит уже состоялся');
  if (a.status === 'cancelled' || a.status === 'no_show') throw conflict('Запись уже отменена');
  if (!isChangeable(a, now)) throw conflict(`Запись уже началась — ${what} её можно только через студию`);
}

function assertBookableStart(db: DbOrTx, startsAt: number, now: number): void {
  const { leadMinutes, horizonDays } = getStudioSettings(db).onlineBooking;
  if (startsAt < now + leadMinutes * MINUTE_MS) throw badRequest('Это время уже недоступно — выберите время попозже');
  if (localDate(startsAt, getStudioSettings(db).timezone) > bookingDates(db, now).last) {
    throw badRequest(`Перенести можно не дальше чем на ${horizonDays} ${pluralWord(horizonDays, 'день', 'дня', 'дней')} вперёд`);
  }
}

function audit(ctx: AppContext, a: AppointmentRow, action: string, summary: string, changes: Record<string, { from: unknown; to: unknown }>): void {
  auditSafely(() => {
    writeAudit(ctx.db, { source: 'online', employeeId: null, action, entity: 'appointment', entityId: a.id, summary, changes }, ctx.log);
  }, ctx.log);
}

/** `POST /public/cabinet/appointments/:id/reschedule`: the same start again changes nothing. */
export async function rescheduleFromCabinet(
  ctx: AppContext,
  clientId: number,
  appointmentId: number,
  startsAt: number,
  now = Date.now(),
): Promise<AppointmentRow> {
  const { db } = ctx;
  assertOnlineEnabled(db);
  const current = ownAppointment(db, clientId, appointmentId);
  assertChangeable(current, now, 'перенести');
  const { cancellation } = getStudioSettings(db);
  if (freeChangesOver(current, heldDeposit(db, current.id), cancellation, now)) {
    throw conflict(`Перенести запись с предоплатой меньше чем за ${cancellation.freeHours} ч до начала можно только через студию`);
  }
  if (startsAt === current.startsAt) return current;
  assertBookableStart(db, startsAt, now);
  const tz = getStudioSettings(db).timezone;
  const isFree = (tx: DbOrTx) => rescheduleStarts(tx, current, localDate(startsAt, tz), now).includes(startsAt);
  if (!isFree(db)) throw scheduleConflict(TIME_TAKEN);
  const moved = db.transaction((tx) => {
    if (!isFree(tx)) throw scheduleConflict(TIME_TAKEN);
    try {
      return updateAppointment(tx, current.id, { startsAt });
    } catch (err) {
      // Never pass on the regular overlap message: it names another client.
      if (err instanceof AppError && err.code === 'schedule_conflict') throw scheduleConflict(TIME_TAKEN);
      throw err;
    }
  });
  const f = bookingFacts(db, moved);
  audit(
    ctx,
    moved,
    'appointment.move',
    `Запись ${appointmentRef(moved.id, f.client)} перенесена клиентом в личном кабинете с ${formatWhen(current.startsAt, tz)} на ${formatWhen(moved.startsAt, tz)}`,
    {
      startsAt: { from: toIso(current.startsAt), to: toIso(moved.startsAt) },
      endsAt: { from: toIso(current.endsAt), to: toIso(moved.endsAt) },
    },
  );
  const master = employeesByIds(db, [moved.masterId]).get(moved.masterId);
  await safely(ctx, 'cabinet reschedule notice', () =>
    notifyStaff(
      ctx,
      `🔁 Клиент ${f.clientName} перенёс запись №${moved.id} в личном кабинете\n` +
        `Было: ${formatHumanDateTime(current.startsAt, tz)}\nСтало: ${formatHumanDateTime(moved.startsAt, tz)}–${formatTime(moved.endsAt, tz)}\n` +
        `${appointmentWhat(db, [moved]).get(moved.id)} · мастер ${master?.name ?? '—'}`,
    ),
  );
  return moved;
}

/** `POST /public/cabinet/appointments/:id/cancel`. */
export async function cancelFromCabinet(ctx: AppContext, clientId: number, appointmentId: number, now = Date.now()): Promise<AppointmentRow> {
  const { db } = ctx;
  assertOnlineEnabled(db);
  const { before, after, heldBefore } = db.transaction((tx) => {
    const a = ownAppointment(tx, clientId, appointmentId);
    assertChangeable(a, now, 'отменить');
    const held = heldDeposit(tx, a.id);
    // Like staff cancelling it: codes, reminders and the rules' retain (`autoRetain`) are handled by the update.
    updateAppointment(tx, a.id, { status: 'cancelled', notes: appendNote(a.notes, CABINET_CANCELLED_NOTE) }, null);
    const row = tx.update(appointments).set({ onlineState: null, holdUntil: null }).where(eq(appointments.id, a.id)).returning().get()!;
    return { before: a, after: row, heldBefore: held };
  });
  const tz = getStudioSettings(db).timezone;
  const f = bookingFacts(db, after);
  const heldNow = heldDeposit(db, after.id);
  const retained = Math.max(0, heldBefore - heldNow);
  audit(
    ctx,
    after,
    'appointment.status',
    `Запись ${appointmentRef(after.id, f.client)} на ${formatWhen(after.startsAt, tz)} отменена клиентом в личном кабинете`,
    { status: { from: before.status, to: after.status } },
  );
  const lines = [`❌ Клиент отменил запись №${after.id} в личном кабинете: ${f.clientName}, ${f.phone}, ${f.what} — ${f.when}, мастер ${f.master}`];
  if (retained > 0) lines.push(`По правилам отмены удержано ${formatRub(retained)} предоплаты.`);
  if (heldNow > 0) lines.push(`За записью предоплата ${formatRub(heldNow)} — верните или удержите её по правилам в карточке записи.`);
  await safely(ctx, 'cabinet cancellation notice', () => notifyStaff(ctx, lines.join('\n'), () => clientCancelledPush(db, after)));
  return getAppointmentRow(db, after.id);
}
