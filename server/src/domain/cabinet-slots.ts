import { DateTime } from 'luxon';
import type { DbOrTx } from '../db/client.js';
import { badRequest } from '../lib/errors.js';
import type { AppointmentRow } from '../lib/serialize.js';
import { MINUTE_MS } from '../lib/time.js';
import { freeSlots } from './free-slots.js';
import { bookingDates, MAX_DAYS_PER_REQUEST, onlineMasters } from './online-booking-slots.js';
import { datesBetween } from './work-schedule.js';

/**
 * Free time to move an appointment to from the cabinet: the online booking rules (the `stepMinutes` grid of the
 * master's working time, `leadMinutes` from now, `horizonDays` ahead, nothing overlapping) for the appointment's own
 * master and duration — its own time does not count as busy, and its current start is not offered.
 */

/** Days `GET …/days` answers without `to`. */
const DEFAULT_DAYS = 14;

export const durationOf = (a: Pick<AppointmentRow, 'startsAt' | 'endsAt'>): number => Math.round((a.endsAt - a.startsAt) / MINUTE_MS);

/** Free starts of a studio-local date for the appointment, ascending. */
export function rescheduleStarts(db: DbOrTx, a: AppointmentRow, date: string, now: number): number[] {
  const { first, last } = bookingDates(db, now);
  if (date < first || date > last) return [];
  const master = onlineMasters(db).find((m) => m.id === a.masterId);
  if (!master) return [];
  const [own] = freeSlots(db, { date, durationMin: durationOf(a), masters: [master], excludeAppointmentId: a.id, now });
  return (own?.starts ?? []).filter((start) => start !== a.startsAt);
}

/** Whether each date of [from, to] (≤ 31 dates; defaults: the first bookable date, 14 days) has a free start. */
export function rescheduleDays(
  db: DbOrTx,
  a: AppointmentRow,
  range: { from: string | null | undefined; to: string | null | undefined },
  now: number,
): Array<{ date: string; available: boolean }> {
  const from = range.from ?? bookingDates(db, now).first;
  const to = range.to ?? DateTime.fromISO(from, { zone: 'utc' }).plus({ days: DEFAULT_DAYS - 1 }).toISODate()!;
  if (to < from) throw badRequest('Конец периода должен быть не раньше начала');
  const span = DateTime.fromISO(to, { zone: 'utc' }).diff(DateTime.fromISO(from, { zone: 'utc' }), 'days').days;
  if (span + 1 > MAX_DAYS_PER_REQUEST) throw badRequest(`Можно запросить не больше ${MAX_DAYS_PER_REQUEST} дней за раз`);
  return datesBetween(from, to).map((date) => ({ date, available: rescheduleStarts(db, a, date, now).length > 0 }));
}
