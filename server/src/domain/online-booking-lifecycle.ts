import { and, eq, inArray, lte } from 'drizzle-orm';
import { notifyStaff } from '../bot/staff.js';
import type { AppContext } from '../context.js';
import type { DbOrTx } from '../db/client.js';
import { appointments } from '../db/schema.js';
import { conflict, errorMessage, notFound } from '../lib/errors.js';
import type { AppointmentRow, QrPaymentRow } from '../lib/serialize.js';
import { HOUR_MS, MINUTE_MS } from '../lib/time.js';
import { clientCancelledPush, depositPaidPush } from '../push/staff-events.js';
import { updateAppointment } from './appointments.js';
import { heldDeposit, pendingDepositCodes } from './deposits.js';
import { findBookingByToken } from './online-booking.js';
import { auditClientCancelled, auditHoldPaid, auditHoldReleased, auditUnconfirmedRejected } from './online-booking-audit.js';
import {
  bookingFacts,
  clientConfirmedText,
  clientRejectedText,
  clientReleasedText,
  safely,
  staffClientCancelText,
  staffPaidText,
  staffReleasedText,
  staffUnconfirmedText,
  tellClient,
} from './online-booking-messages.js';
import { refreshQrPayment } from './qr-payments.js';
import { getAppointmentRow } from './refs.js';
import { getStudioSettings } from './settings.js';

/**
 * What happens to an online booking after it is made (docs/API.md «Online booking» → «Settlement»): staff confirm or
 * reject it (or nobody confirms it in time — rejected by itself), the prepayment arrives (confirmed by itself) or its
 * hold runs out (cancelled, the time free again), the client cancels it on their booking page.
 */

/** How often unpaid holds are checked (index.ts). */
export const HOLD_CHECK_INTERVAL_MS = 60_000;
/** While the bank cannot be asked, an unpaid hold is kept at most this long past `holdUntil`. */
export const HOLD_BANK_WAIT_MS = 60 * MINUTE_MS;
export const NOT_PAID_NOTE = 'Предоплата не внесена вовремя';
/** Note lines of a booking staff rejected («…: <reason>») and of one the client cancelled (the growth report reads them). */
export const REJECTED_NOTE = 'Онлайн-запись отклонена';
export const CLIENT_CANCELLED_NOTE = 'Отменена клиентом онлайн';
/** The reason of a booking nobody confirmed in time (docs/API.md «StudioSettings» → `confirmationHours`). */
export const UNCONFIRMED_REASON = 'Студия не успела подтвердить запись — выберите, пожалуйста, другое время';
/** An unconfirmed booking is rejected at the latest this long before its start… */
export const CONFIRM_BEFORE_START_MS = 2 * HOUR_MS;
/** …but never sooner than this after it was made (a booking for the nearest free time is not rejected at once). */
export const CONFIRM_MIN_WINDOW_MS = 30 * MINUTE_MS;

const OPEN_STATUSES = ['scheduled', 'confirmed'];
const isOpen = (a: AppointmentRow): boolean => OPEN_STATUSES.includes(a.status);
const appendNote = (notes: string | null, line: string): string => (notes?.trim() ? `${notes.trim()}\n${line}` : line);

/** Clears the unsettled state (the row is otherwise updated by the regular appointment code). */
function settled(db: DbOrTx, id: number, now = Date.now()): AppointmentRow {
  return db.update(appointments).set({ onlineState: null, holdUntil: null, updatedAt: now }).where(eq(appointments.id, id)).returning().get()!;
}

/** Cancels the booking like staff would (codes, reminders, the rules' retain) and clears its online state. */
function cancelled(db: DbOrTx, a: AppointmentRow, note: string, actorId: number | null): AppointmentRow {
  updateAppointment(db, a.id, { status: 'cancelled', notes: appendNote(a.notes, note) }, actorId);
  return settled(db, a.id);
}

/** Staff: `…/online/confirm`. */
export async function confirmOnlineBooking(ctx: AppContext, id: number): Promise<AppointmentRow> {
  const row = ctx.db.transaction((tx) => {
    const a = getAppointmentRow(tx, id);
    if (!isOpen(a) || a.onlineState !== 'awaiting_confirmation') throw conflict('Эта запись не ждёт подтверждения');
    return settled(tx, id);
  });
  await safely(ctx, 'confirmation notice', () => tellClient(ctx, row, { text: clientConfirmedText(ctx.db, row, bookingFacts(ctx.db, row)) }));
  return row;
}

/** Cancels the booking as rejected: «Онлайн-запись отклонена: <reason>» in the notes (the growth report reads it). */
const rejected = (db: DbOrTx, a: AppointmentRow, reason: string | null, actorId: number | null): AppointmentRow =>
  cancelled(db, a, `${REJECTED_NOTE}${reason ? `: ${reason}` : ''}`, actorId);

/** Staff: `…/online/reject` — cancelled; the client hears the reason and gets the booking link. */
export async function rejectOnlineBooking(ctx: AppContext, id: number, reason: string | null, actorId: number): Promise<AppointmentRow> {
  const row = ctx.db.transaction((tx) => {
    const a = getAppointmentRow(tx, id);
    if (!isOpen(a) || a.onlineState == null) throw conflict('Эта запись не ждёт подтверждения или оплаты');
    return rejected(tx, a, reason, actorId);
  });
  await safely(ctx, 'rejection notice', () => tellClient(ctx, row, { text: clientRejectedText(ctx, bookingFacts(ctx.db, row), reason) }));
  return row;
}

/** The client: «Отменить запись» on the booking page, until the start. A held prepayment stays for staff. */
export async function cancelOnlineBookingByClient(ctx: AppContext, token: string, now = Date.now()): Promise<AppointmentRow> {
  const found = findBookingByToken(ctx.db, token);
  if (!found) throw notFound('Запись не найдена');
  const { before, after } = ctx.db.transaction((tx) => {
    const a = getAppointmentRow(tx, found.id);
    if (a.status === 'completed') throw conflict('Визит уже состоялся');
    if (!isOpen(a)) throw conflict('Запись уже отменена');
    if (a.startsAt <= now) throw conflict('Запись уже началась — отменить её можно только через студию');
    return { before: a, after: cancelled(tx, a, CLIENT_CANCELLED_NOTE, null) };
  });
  auditClientCancelled(ctx, before, after);
  await safely(ctx, 'cancellation notice', () =>
    notifyStaff(ctx, staffClientCancelText(ctx.db, after, bookingFacts(ctx.db, after)), () => clientCancelledPush(ctx.db, after)),
  );
  return after;
}

// ---------- the prepayment of a hold ----------

/** Whether the code's appointment is a booking waiting for its prepayment (read before the bank is asked). */
export function awaitsPayment(db: DbOrTx, code: Pick<QrPaymentRow, 'kind' | 'appointmentId'>): boolean {
  if (code.kind !== 'deposit' || code.appointmentId == null) return false;
  const a = db.select().from(appointments).where(eq(appointments.id, code.appointmentId)).get();
  return a !== undefined && a.onlineState === 'awaiting_payment' && isOpen(a);
}

/** After a bank confirmation: the code's booking is open and settled (its hold was just paid when it awaited it). */
export function holdSettled(db: DbOrTx, code: Pick<QrPaymentRow, 'appointmentId'>): boolean {
  if (code.appointmentId == null) return false;
  const a = db.select().from(appointments).where(eq(appointments.id, code.appointmentId)).get();
  return a !== undefined && a.onlineState === null && isOpen(a);
}

/**
 * Inside the bank confirmation's transaction (domain/qr-payments.ts): a paid prepayment code confirms the booking
 * it holds. Returns whether it did.
 */
export function settlePaidHold(db: DbOrTx, code: QrPaymentRow, now: number): boolean {
  if (code.kind !== 'deposit' || code.appointmentId == null) return false;
  const changed = db
    .update(appointments)
    .set({ onlineState: null, holdUntil: null, updatedAt: now })
    .where(and(eq(appointments.id, code.appointmentId), eq(appointments.onlineState, 'awaiting_payment'), inArray(appointments.status, OPEN_STATUSES)))
    .run().changes;
  return changed > 0;
}

/**
 * The hold is paid: logged, the staff chat and the client are told (instead of the usual prepayment notices, so the
 * `deposit_paid` push goes from here — once).
 */
export async function announceHoldPaid(ctx: AppContext, appointmentId: number, amount: number): Promise<void> {
  await safely(ctx, 'payment notice', async () => {
    const a = getAppointmentRow(ctx.db, appointmentId);
    const facts = bookingFacts(ctx.db, a);
    auditHoldPaid(ctx, a);
    await notifyStaff(ctx, staffPaidText(facts, amount), () => depositPaidPush(ctx.db, a, amount));
    await tellClient(ctx, a, { text: clientConfirmedText(ctx.db, a, facts) });
  });
}

// ---------- unpaid holds ----------

/** Asks the bank about the hold, then settles it (paid), waits (no answer yet) or releases it. True when released. */
async function settleOrRelease(ctx: AppContext, hold: AppointmentRow, now: number): Promise<boolean> {
  // A payment that has just arrived counts (and is announced by the bank check itself).
  for (const code of pendingDepositCodes(ctx.db, hold.id)) await refreshQrPayment(ctx, code.id, { force: true });
  const current = getAppointmentRow(ctx.db, hold.id);
  if (current.onlineState !== 'awaiting_payment' || !isOpen(current) || current.holdUntil == null) return false;
  const held = heldDeposit(ctx.db, hold.id);
  if (held > 0) {
    // Paid another way meanwhile (at the studio): that confirms it too.
    settled(ctx.db, hold.id);
    await announceHoldPaid(ctx, hold.id, held);
    return false;
  }
  const holdUntil = current.holdUntil;
  const unanswered = ctx.qr !== null && pendingDepositCodes(ctx.db, hold.id).some((c) => c.checkedAt == null || c.checkedAt < holdUntil);
  if (unanswered && now < holdUntil + HOLD_BANK_WAIT_MS) return false;
  const released = ctx.db.transaction((tx) => {
    const latest = getAppointmentRow(tx, hold.id);
    if (latest.onlineState !== 'awaiting_payment' || !isOpen(latest)) return null;
    return cancelled(tx, latest, NOT_PAID_NOTE, null);
  });
  if (!released) return false;
  auditHoldReleased(ctx, current, released);
  await safely(ctx, 'release notice', async () => {
    const facts = bookingFacts(ctx.db, released);
    await notifyStaff(ctx, staffReleasedText(facts));
    await tellClient(ctx, released, { text: clientReleasedText(ctx, facts) });
  });
  return true;
}

/** The background check (every minute): holds whose time to pay is over. Returns how many were released. */
export async function releaseUnpaidHolds(ctx: AppContext, now = Date.now()): Promise<number> {
  const due = ctx.db
    .select()
    .from(appointments)
    .where(and(eq(appointments.onlineState, 'awaiting_payment'), inArray(appointments.status, OPEN_STATUSES), lte(appointments.holdUntil, now)))
    .all();
  let released = 0;
  for (const hold of due) {
    try {
      if (await settleOrRelease(ctx, hold, now)) released += 1;
    } catch (err) {
      ctx.log.error({ appointmentId: hold.id, err: errorMessage(err) }, 'online hold check failed');
    }
  }
  return released;
}

// ---------- unconfirmed bookings ----------

/**
 * When an unconfirmed booking rejects itself: `hours` after it was made, or 2 hours before its start if earlier — but
 * not sooner than 30 minutes after it was made.
 */
export function confirmationDeadline(a: Pick<AppointmentRow, 'createdAt' | 'startsAt'>, hours: number): number {
  return Math.max(a.createdAt + CONFIRM_MIN_WINDOW_MS, Math.min(a.createdAt + hours * HOUR_MS, a.startsAt - CONFIRM_BEFORE_START_MS));
}

/**
 * Rejects one booking like staff would (as `system`); false when it was settled meanwhile or holds a prepayment (staff
 * took money for it: theirs to settle, and the cancellation rules must not keep any of it for the studio's delay).
 */
async function rejectUnconfirmed(ctx: AppContext, booking: AppointmentRow): Promise<boolean> {
  const result = ctx.db.transaction((tx) => {
    const before = getAppointmentRow(tx, booking.id);
    if (!isOpen(before) || before.onlineState !== 'awaiting_confirmation' || heldDeposit(tx, before.id) > 0) return null;
    return { before, after: rejected(tx, before, UNCONFIRMED_REASON, null) };
  });
  if (!result) return false;
  auditUnconfirmedRejected(ctx, result.before, result.after);
  await safely(ctx, 'unconfirmed rejection notice', async () => {
    const facts = bookingFacts(ctx.db, result.after);
    await notifyStaff(ctx, staffUnconfirmedText(facts));
    await tellClient(ctx, result.after, { text: clientRejectedText(ctx, facts, UNCONFIRMED_REASON) });
  });
  return true;
}

/**
 * The background check (every minute, next to the unpaid holds): online bookings still waiting for staff past their
 * deadline (`onlineBooking.confirmationHours`; `null` = never) are rejected. Returns how many were.
 */
export async function rejectUnconfirmedBookings(ctx: AppContext, now = Date.now()): Promise<number> {
  const hours = getStudioSettings(ctx.db).onlineBooking.confirmationHours;
  if (hours == null) return 0;
  // A handful at most: the bookings staff have not settled yet.
  const due = ctx.db
    .select()
    .from(appointments)
    .where(and(eq(appointments.onlineState, 'awaiting_confirmation'), inArray(appointments.status, OPEN_STATUSES)))
    .all()
    .filter((a) => confirmationDeadline(a, hours) <= now);
  let rejectedCount = 0;
  for (const booking of due) {
    try {
      if (await rejectUnconfirmed(ctx, booking)) rejectedCount += 1;
    } catch (err) {
      ctx.log.error({ appointmentId: booking.id, err: errorMessage(err) }, 'unconfirmed online booking check failed');
    }
  }
  return rejectedCount;
}
