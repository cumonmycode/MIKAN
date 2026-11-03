import { and, asc, eq, gt, inArray, lt } from 'drizzle-orm';
import { DateTime } from 'luxon';
import type { DbOrTx } from '../db/client.js';
import { appointments, employees } from '../db/schema.js';
import { employeeRef } from '../lib/serialize.js';
import { localDatesInRange, MINUTE_MS } from '../lib/time.js';
import { scheduleDaysFor, workingIntervals, type Interval } from './work-schedule.js';

/**
 * `load` of the growth report (docs/API.md «Reports»): every active master's working time in the period — their work
 * schedule, the studio hours without one — against the time their appointments take in it.
 */

/** Statuses that take a master's time: everything except cancelled and no-show. */
const BOOKED_STATUSES = ['scheduled', 'confirmed', 'completed'];
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];

/** Milliseconds by ISO weekday: index 0 = Monday … 6 = Sunday. */
type Week = number[];

const emptyWeek = (): Week => WEEKDAYS.map(() => 0);
const minutesOf = (week: Week): number[] => week.map((ms) => Math.round(ms / MINUTE_MS));
const sum = (list: number[]): number => list.reduce((s, x) => s + x, 0);

function clip(i: Interval, from: number, to: number): Interval | null {
  const start = Math.max(i.start, from);
  const end = Math.min(i.end, to);
  return end > start ? { start, end } : null;
}

/** Overlapping intervals merged into one, sorted by start: the same minute is never counted twice. */
export function mergeIntervals(list: readonly Interval[]): Interval[] {
  const merged: Interval[] = [];
  for (const i of [...list].sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && i.start <= last.end) merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, i.end) };
    else merged.push({ ...i });
  }
  return merged;
}

/** An interval split at studio-local midnights: the weekday and length of each piece. */
function weekdayPieces(i: Interval, tz: string): Array<{ weekday: number; ms: number }> {
  const pieces: Array<{ weekday: number; ms: number }> = [];
  let day = DateTime.fromMillis(i.start, { zone: tz }).startOf('day');
  let start = i.start;
  while (start < i.end) {
    const nextDay = day.plus({ days: 1 });
    const end = Math.min(i.end, nextDay.toMillis());
    pieces.push({ weekday: day.weekday, ms: end - start });
    start = end;
    day = nextDay;
  }
  return pieces;
}

/** Time covered by the intervals inside [from, to), by studio-local weekday. */
function coveredWeek(list: readonly Interval[], from: number, to: number, tz: string): Week {
  const week = emptyWeek();
  for (const merged of mergeIntervals(list)) {
    const inside = clip(merged, from, to);
    if (!inside) continue;
    for (const piece of weekdayPieces(inside, tz)) week[piece.weekday - 1] = (week[piece.weekday - 1] ?? 0) + piece.ms;
  }
  return week;
}

/** Working time of each master inside [from, to), by weekday (their own schedule, else the studio hours). */
function workingWeeks(db: DbOrTx, masters: Array<typeof employees.$inferSelect>, from: number, to: number, tz: string): Map<number, Week> {
  const dates = localDatesInRange(from, to, tz);
  const weekdayOf = new Map(dates.map((date) => [date, DateTime.fromISO(date, { zone: 'utc' }).weekday]));
  const weeks = new Map(masters.map((m) => [m.id, emptyWeek()]));
  for (const day of scheduleDaysFor(db, masters, dates)) {
    const week = weeks.get(day.employeeId);
    const weekday = weekdayOf.get(day.date);
    if (!week || weekday === undefined) continue;
    for (const interval of workingIntervals(day, tz)) {
      const inside = clip(interval, from, to);
      if (inside) week[weekday - 1] = (week[weekday - 1] ?? 0) + inside.end - inside.start;
    }
  }
  return weeks;
}

interface MasterTime {
  booked: Interval[];
  completed: Interval[];
}

/** The masters' appointments that take time in [from, to). */
function appointmentTimes(db: DbOrTx, masterIds: number[], from: number, to: number): Map<number, MasterTime> {
  const rows = db
    .select({ masterId: appointments.masterId, startsAt: appointments.startsAt, endsAt: appointments.endsAt, status: appointments.status })
    .from(appointments)
    .where(
      and(
        inArray(appointments.masterId, masterIds),
        inArray(appointments.status, BOOKED_STATUSES),
        lt(appointments.startsAt, to),
        gt(appointments.endsAt, from),
      ),
    )
    .all();
  const times = new Map<number, MasterTime>();
  for (const row of rows) {
    const entry = times.get(row.masterId) ?? { booked: [], completed: [] };
    const interval = { start: row.startsAt, end: row.endsAt };
    entry.booked.push(interval);
    if (row.status === 'completed') entry.completed.push(interval);
    times.set(row.masterId, entry);
  }
  return times;
}

export function loadSection(db: DbOrTx, from: number, to: number, tz: string) {
  const masters = db
    .select()
    .from(employees)
    .where(and(eq(employees.isMaster, true), eq(employees.active, true)))
    .orderBy(asc(employees.id))
    .all();
  if (masters.length === 0) return [];
  const working = workingWeeks(db, masters, from, to, tz);
  const times = appointmentTimes(db, masters.map((m) => m.id), from, to);
  return masters
    .map((master) => {
      const workingByDay = minutesOf(working.get(master.id) ?? emptyWeek());
      const bookedByDay = minutesOf(coveredWeek(times.get(master.id)?.booked ?? [], from, to, tz));
      const workingMinutes = sum(workingByDay);
      const bookedMinutes = sum(bookedByDay);
      return {
        employee: employeeRef(master),
        workingMinutes,
        bookedMinutes,
        completedMinutes: sum(minutesOf(coveredWeek(times.get(master.id)?.completed ?? [], from, to, tz))),
        loadPercent: workingMinutes > 0 ? Math.round((bookedMinutes * 100) / workingMinutes) : null,
        byWeekday: WEEKDAYS.map((weekday, i) => ({ weekday, workingMinutes: workingByDay[i] ?? 0, bookedMinutes: bookedByDay[i] ?? 0 })),
      };
    })
    .sort(
      (a, b) =>
        (b.loadPercent ?? -1) - (a.loadPercent ?? -1) || b.bookedMinutes - a.bookedMinutes || a.employee.id - b.employee.id,
    );
}
