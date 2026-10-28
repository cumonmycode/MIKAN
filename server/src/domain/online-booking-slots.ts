import { and, asc, count, eq, gte, inArray, lt, notInArray } from 'drizzle-orm';
import { DateTime } from 'luxon';
import type { DbOrTx } from '../db/client.js';
import { appointments, employees } from '../db/schema.js';
import { badRequest } from '../lib/errors.js';
import type { EmployeeRow } from '../lib/serialize.js';
import { localDate, localDayBounds } from '../lib/time.js';
import { freeSlots } from './free-slots.js';
import { getStudioSettings } from './settings.js';
import { datesBetween } from './work-schedule.js';

/**
 * Free time for online booking (docs/API.md «Online booking» → «Free time»): starts on the `stepMinutes` grid of the
 * masters' working time, at least `leadMinutes` from now, at most `horizonDays` ahead, not overlapping anything.
 * «Any master» = every active master (`isMaster`).
 */

/** The longest range of dates `GET /public/booking/days` answers at once. */
export const MAX_DAYS_PER_REQUEST = 31;

export interface StartOption {
  startsAt: number;
  /** Masters free at that start, ascending ids. */
  masterIds: number[];
}

/** Active masters clients can book with, by name. */
export function onlineMasters(db: DbOrTx): EmployeeRow[] {
  return db
    .select()
    .from(employees)
    .where(and(eq(employees.active, true), eq(employees.isMaster, true)))
    .orderBy(asc(employees.name), asc(employees.id))
    .all();
}

/** `400` unless `masterId` is an active master. */
export function assertOnlineMaster(db: DbOrTx, masterId: number): EmployeeRow {
  const master = onlineMasters(db).find((m) => m.id === masterId);
  if (!master) throw badRequest('Этот мастер сейчас не принимает онлайн-записи — выберите другого или «Любой мастер»');
  return master;
}

/** Studio-local dates open for booking at `now`: today … today + horizonDays. */
export function bookingDates(db: DbOrTx, now: number): { first: string; last: string } {
  const { timezone, onlineBooking } = getStudioSettings(db);
  const today = DateTime.fromMillis(now, { zone: timezone }).startOf('day');
  return { first: today.toISODate()!, last: today.plus({ days: onlineBooking.horizonDays }).toISODate()! };
}

export interface StartsQuery {
  /** Studio-local date "YYYY-MM-DD". */
  date: string;
  durationMin: number;
  /** One master, else every active master. */
  masterId?: number | null;
  now: number;
}

/** Free starts of a date, each with the masters free then. */
export function availableStarts(db: DbOrTx, q: StartsQuery): StartOption[] {
  const { first, last } = bookingDates(db, q.now);
  if (q.date < first || q.date > last) return [];
  const all = onlineMasters(db);
  const masters = q.masterId != null ? all.filter((m) => m.id === q.masterId) : all;
  if (masters.length === 0) return [];
  const byStart = new Map<number, number[]>();
  for (const { master, starts } of freeSlots(db, { date: q.date, durationMin: q.durationMin, masters, now: q.now })) {
    for (const start of starts) byStart.set(start, [...(byStart.get(start) ?? []), master.id]);
  }
  return [...byStart.entries()]
    .sort(([a], [b]) => a - b)
    .map(([startsAt, ids]) => ({ startsAt, masterIds: ids.sort((a, b) => a - b) }));
}

/** Whether each date of [from, to] has any free start (≤ MAX_DAYS_PER_REQUEST dates). */
export function availableDays(
  db: DbOrTx,
  q: { from: string; to: string; durationMin: number; masterId?: number | null; now: number },
): Array<{ date: string; available: boolean }> {
  if (q.to < q.from) throw badRequest('Конец периода должен быть не раньше начала');
  const span = DateTime.fromISO(q.to, { zone: 'utc' }).diff(DateTime.fromISO(q.from, { zone: 'utc' }), 'days').days;
  if (span + 1 > MAX_DAYS_PER_REQUEST) throw badRequest(`Можно запросить не больше ${MAX_DAYS_PER_REQUEST} дней за раз`);
  return datesBetween(q.from, q.to).map((date) => ({ date, available: availableStarts(db, { ...q, date }).length > 0 }));
}

/** The start of `startsAt` if it is free (for `masterId`, or for any master), else null. */
export function freeStart(db: DbOrTx, q: Omit<StartsQuery, 'date'> & { startsAt: number }): StartOption | null {
  const date = localDate(q.startsAt, getStudioSettings(db).timezone);
  return availableStarts(db, { ...q, date }).find((o) => o.startsAt === q.startsAt) ?? null;
}

/**
 * «Any master»: of the masters free at the start, the one with the fewest appointments that studio day, then the
 * lowest id.
 */
export function chooseMaster(db: DbOrTx, startsAt: number, masterIds: number[]): number {
  if (masterIds.length <= 1) return masterIds[0]!;
  const day = localDayBounds(startsAt, getStudioSettings(db).timezone);
  const counts = new Map(
    db
      .select({ masterId: appointments.masterId, n: count() })
      .from(appointments)
      .where(
        and(
          inArray(appointments.masterId, masterIds),
          gte(appointments.startsAt, day.start),
          lt(appointments.startsAt, day.end),
          notInArray(appointments.status, ['cancelled', 'no_show']),
        ),
      )
      .groupBy(appointments.masterId)
      .all()
      .map((r) => [r.masterId, r.n]),
  );
  return [...masterIds].sort((a, b) => (counts.get(a) ?? 0) - (counts.get(b) ?? 0) || a - b)[0]!;
}
