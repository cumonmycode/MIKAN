import { eq } from 'drizzle-orm';
import { DateTime } from 'luxon';
import type { DbOrTx } from '../db/client.js';
import { appointments } from '../db/schema.js';
import type { AppointmentRow, ScheduledRow } from '../lib/serialize.js';
import { HOUR_MS, toIso } from '../lib/time.js';
import { appointmentLedger, heldAmount } from './deposit-ledger.js';
import { getStudioSettings, type CancellationRules } from './settings.js';

/**
 * The studio's prepayment rules on a cancellation / no-show (`StudioSettings.cancellation`): what they mean for an
 * appointment, how the bot words them, and what the server keeps by itself (see `autoRetainDeposit`).
 */

/** `Appointment.cancellation`. */
export interface AppointmentCancellationOut {
  freeUntil: string | null;
  lateRetain: number;
  noShowRetain: number;
}

/** Whole rubles kept of `amount` at `percent`. */
export const retainShare = (amount: number, percent: number): number => Math.round((amount * percent) / 100);

/** The last moment a free cancellation is possible; null when the rules never make it free. */
export function freeUntil(startsAt: number, rules: CancellationRules): number | null {
  return rules.freeHours > 0 ? startsAt - rules.freeHours * HOUR_MS : null;
}

/** Cancelling at `at` is late: less than `freeHours` before the start (always when `freeHours` is 0). */
export function isLateCancellation(startsAt: number, at: number, rules: CancellationRules): boolean {
  const until = freeUntil(startsAt, rules);
  return until === null || at > until;
}

/**
 * What the rules mean for the appointment, counted from the held prepayment (the required one while nothing is
 * held); null when it neither holds nor requires one.
 */
export function appointmentCancellation(
  appointment: Pick<AppointmentRow, 'startsAt' | 'depositRequired'>,
  held: number,
  rules: CancellationRules,
): AppointmentCancellationOut | null {
  const base = held > 0 ? held : appointment.depositRequired;
  if (base <= 0) return null;
  return {
    freeUntil: toIso(freeUntil(appointment.startsAt, rules)),
    lateRetain: retainShare(base, rules.lateRetainPercent),
    noShowRetain: retainShare(base, rules.noShowRetainPercent),
  };
}

export function lateCancellationReason(rules: CancellationRules): string {
  return rules.freeHours > 0 ? `Поздняя отмена — меньше ${rules.freeHours} ч до записи` : 'Отмена записи — по правилам студии';
}

/**
 * The retain the rules call for when the appointment became `status` at `at` holding `held`: a share for a late
 * cancellation or a no-show, null for an early (free) cancellation or another status.
 */
export function closingRetain(
  status: string,
  startsAt: number,
  at: number,
  held: number,
  rules: CancellationRules,
): { amount: number; reason: string } | null {
  if (status === 'no_show') return { amount: retainShare(held, rules.noShowRetainPercent), reason: 'Неявка' };
  if (status !== 'cancelled' || !isLateCancellation(startsAt, at, rules)) return null;
  return { amount: retainShare(held, rules.lateRetainPercent), reason: lateCancellationReason(rules) };
}

// ---------- wording for clients ----------

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** «предоплата не возвращается» / «студия оставляет себе 30% предоплаты» / «предоплата возвращается». */
function keptPhrase(percent: number): string {
  if (percent >= 100) return 'предоплата не возвращается';
  if (percent <= 0) return 'предоплата возвращается';
  if (percent === 50) return 'студия оставляет себе половину предоплаты';
  return `студия оставляет себе ${percent}% предоплаты`;
}

/**
 * The rules in plain words: «Бесплатно отменить или перенести запись можно не позднее чем за 24 часа; при более
 * поздней отмене предоплата не возвращается, при неявке — тоже.»
 */
export function cancellationPolicyText(rules: CancellationRules): string {
  const late = keptPhrase(rules.lateRetainPercent);
  const noShow =
    rules.noShowRetainPercent === rules.lateRetainPercent ? 'при неявке — тоже' : `при неявке ${keptPhrase(rules.noShowRetainPercent)}`;
  if (rules.freeHours === 0) return `Бесплатной отмены нет: при отмене записи ${late}, ${noShow}.`;
  const hours = `${rules.freeHours} ${plural(rules.freeHours, 'час', 'часа', 'часов')}`;
  return `Бесплатно отменить или перенести запись можно не позднее чем за ${hours}; при более поздней отмене ${late}, ${noShow}.`;
}

/** «16 октября, 14:00» — until when the appointment can still be cancelled for free at `now`; null when not. */
export function freeUntilText(startsAt: number, now: number, rules: CancellationRules, tz: string): string | null {
  const until = freeUntil(startsAt, rules);
  if (until === null || now > until) return null;
  return DateTime.fromMillis(until, { zone: tz }).setLocale('ru').toFormat('d MMMM, HH:mm');
}

/** «Бесплатно отменить можно до 16 октября, 14:00» while the appointment holds a prepayment and that is still ahead. */
export function freeCancellationLine(db: DbOrTx, appointment: AppointmentRow, now: number): string | null {
  const studio = getStudioSettings(db);
  const until = freeUntilText(appointment.startsAt, now, studio.cancellation, studio.timezone);
  if (until === null || heldAmount(appointmentLedger(db, appointment.id)) <= 0) return null;
  return `Бесплатно отменить можно до ${until}`;
}

/**
 * A reminder as it is sent at `now`: with the free-cancellation line (decided at send time, the prepayment is often
 * paid after the reminder was scheduled) as its own paragraph before the closing one.
 */
export function reminderAsSent(db: DbOrTx, msg: Pick<ScheduledRow, 'appointmentId' | 'text'>, now: number): string {
  if (msg.appointmentId == null) return msg.text;
  const appointment = db.select().from(appointments).where(eq(appointments.id, msg.appointmentId)).get();
  const line = appointment ? freeCancellationLine(db, appointment, now) : null;
  if (!line) return msg.text;
  const at = msg.text.lastIndexOf('\n\n');
  return at < 0 ? `${msg.text}\n\n${line}` : `${msg.text.slice(0, at)}\n\n${line}${msg.text.slice(at)}`;
}
