import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { employees } from '../db/schema.js';
import { scheduleConflict } from '../lib/errors.js';
import { genitiveName } from '../lib/name-cases.js';
import type { EmployeeRow } from '../lib/serialize.js';
import { localDate } from '../lib/time.js';
import { studioTimezone } from './settings.js';
import { datesLabel, employeeScheduleDay, instantOf, scheduleDaysFor, workingIntervals, type ScheduleDay } from './work-schedule.js';

/**
 * What the work schedules change elsewhere: appointments booked in the app outside a master's own schedule are a
 * `schedule_conflict`, the bot offers and accepts only the working time, the morning digest names who works today.
 */

const fits = (day: ScheduleDay, tz: string, startsAt: number, endsAt: number) =>
  workingIntervals(day, tz).some((i) => startsAt >= i.start && endsAt <= i.end);

/**
 * Why [startsAt, endsAt) is outside the master's own schedule («Фатима не работает 23 октября», «У Фатимы перерыв
 * 14:00–14:30»), or null when it fits. Masters without an own schedule for that date are never restricted: the
 * studio hours are not a booking limit.
 */
export function workingTimeConflict(db: DbOrTx, masterId: number, startsAt: number, endsAt: number): string | null {
  const master = db.select().from(employees).where(eq(employees.id, masterId)).get();
  if (!master) return null;
  const tz = studioTimezone(db);
  const day = employeeScheduleDay(db, master, localDate(startsAt, tz));
  if (day.source === 'studio' || fits(day, tz, startsAt, endsAt)) return null;
  const when = datesLabel(day.date);
  if (!day.working || !day.start || !day.end) return `${master.name} не работает ${when}`;
  if (startsAt < instantOf(day.date, day.start, tz) || endsAt > instantOf(day.date, day.end, tz)) {
    return `${master.name} работает ${when} с ${day.start} до ${day.end}`;
  }
  const hit = day.breaks.find((b) => instantOf(day.date, b.start, tz) < endsAt && instantOf(day.date, b.end, tz) > startsAt);
  const pause = hit ? `${hit.start}–${hit.end}` : '';
  const whose = genitiveName(master.name);
  return whose ? `У ${whose} перерыв ${pause}` : `${master.name}: перерыв ${pause}`;
}

/** `409 schedule_conflict` when the time is outside the master's own schedule. */
export function assertWorkingTime(db: DbOrTx, masterId: number, startsAt: number, endsAt: number): void {
  const reason = workingTimeConflict(db, masterId, startsAt, endsAt);
  if (reason) throw scheduleConflict(reason);
}

/** Whether [startsAt, endsAt) lies inside the master's working time (the studio hours without an own schedule). */
export function fitsWorkingTime(db: DbOrTx, master: EmployeeRow, startsAt: number, endsAt: number): boolean {
  const tz = studioTimezone(db);
  return fits(employeeScheduleDay(db, master, localDate(startsAt, tz)), tz, startsAt, endsAt);
}

/**
 * «Сегодня работают: Амина 11:00–20:00, Фатима 12:00–21:00» for a studio-local date, or null when no master has an
 * own schedule that day (then everyone simply works the studio hours).
 */
export function whoWorksText(db: DbOrTx, masters: EmployeeRow[], date: string): string | null {
  const days = scheduleDaysFor(db, masters, [date]);
  if (days.every((d) => d.source === 'studio')) return null;
  const working = days.flatMap((d, i) => (d.working ? [`${masters[i]!.name} ${d.start}–${d.end}`] : []));
  return working.length ? `Сегодня работают: ${working.join(', ')}` : 'Сегодня никто из мастеров не работает';
}
