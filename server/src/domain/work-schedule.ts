import { and, asc, eq, gte, inArray, lte } from 'drizzle-orm';
import { DateTime } from 'luxon';
import type { DbOrTx } from '../db/client.js';
import { scheduleDays } from '../db/schema.js';
import { badRequest } from '../lib/errors.js';
import type { EmployeeRow } from '../lib/serialize.js';
import { formatTimeOfDay, parseTimeOfDay } from '../lib/time.js';
import { getStudioSettings } from './settings.js';

/**
 * Work schedules of masters (docs/API.md «WorkSchedule»): a weekly schedule (7 entries Monday…Sunday, `null` = day
 * off) and exceptions for single dates. The working time of a date = its exception, else its weekly entry, else the
 * studio hours; minus breaks. Times are "HH:MM" in the studio timezone ("24:00" = midnight).
 */

export interface TimeRange {
  start: string;
  end: string;
}
export interface WorkHours extends TimeRange {
  breaks: TimeRange[];
}
/** 7 entries Monday…Sunday; `null` = day off. */
export type WeeklySchedule = Array<WorkHours | null>;
export type ScheduleSource = 'weekly' | 'day' | 'studio';

/** `ScheduleDayOut`: the working time of one employee on one studio-local date. */
export interface ScheduleDay {
  employeeId: number;
  date: string;
  working: boolean;
  start: string | null;
  end: string | null;
  breaks: TimeRange[];
  source: ScheduleSource;
  note: string | null;
}

/** The stored fields of an exception (`schedule_days` row). */
export interface ScheduleException {
  off: boolean;
  start: string | null;
  end: string | null;
  /** JSON `[{ start, end }]`. */
  breaks: string;
  note: string | null;
}

/** An instant interval [start, end) in ms. */
export interface Interval {
  start: number;
  end: number;
}

export const WEEKDAY_TITLES = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
export const MAX_BREAKS = 6;
/** Longest range of dates read or written at once. */
export const MAX_RANGE_DAYS = 62;
const DAY_MINUTES = 24 * 60;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const span = (start: number, end: number) => `${formatTimeOfDay(start)}–${formatTimeOfDay(end)}`;

function minutesOf(value: unknown, label: string): number {
  const minutes = typeof value === 'string' ? parseTimeOfDay(value) : null;
  if (minutes === null) throw badRequest(`${label}: время должно быть в формате ЧЧ:ММ (например, 10:00)`);
  return minutes;
}

function parseBreak(raw: unknown, label: string, day: { start: number; end: number }): { start: number; end: number } {
  if (!isObject(raw) || raw.start == null || raw.end == null) throw badRequest(`${label}: укажите начало и конец перерыва`);
  const start = minutesOf(raw.start, label);
  const end = minutesOf(raw.end, label);
  if (end <= start) {
    throw badRequest(`${label}: конец перерыва (${formatTimeOfDay(end)}) должен быть позже начала (${formatTimeOfDay(start)})`);
  }
  if (start < day.start || end > day.end) {
    throw badRequest(`${label}: перерыв ${span(start, end)} выходит за часы работы ${span(day.start, day.end)}`);
  }
  return { start, end };
}

/** Validates the hours of one day (`label` prefixes the Russian reason) and normalizes them. */
export function parseWorkHours(raw: unknown, label: string): WorkHours {
  if (!isObject(raw) || raw.start == null || raw.end == null) throw badRequest(`${label}: укажите начало и конец работы`);
  const start = minutesOf(raw.start, label);
  const end = minutesOf(raw.end, label);
  if (end <= start) {
    throw badRequest(`${label}: конец работы (${formatTimeOfDay(end)}) должен быть позже начала (${formatTimeOfDay(start)})`);
  }
  const rawBreaks = raw.breaks ?? [];
  if (!Array.isArray(rawBreaks)) throw badRequest(`${label}: перерывы должны быть списком`);
  if (rawBreaks.length > MAX_BREAKS) throw badRequest(`${label}: не больше ${MAX_BREAKS} перерывов`);
  const breaks = rawBreaks.map((b) => parseBreak(b, label, { start, end })).sort((a, b) => a.start - b.start);
  breaks.forEach((b, i) => {
    const previous = breaks[i - 1];
    if (previous && b.start < previous.end) {
      throw badRequest(`${label}: перерывы ${span(previous.start, previous.end)} и ${span(b.start, b.end)} пересекаются`);
    }
  });
  return {
    start: formatTimeOfDay(start),
    end: formatTimeOfDay(end),
    breaks: breaks.map((b) => ({ start: formatTimeOfDay(b.start), end: formatTimeOfDay(b.end) })),
  };
}

/** `weekly` from a request: `null` / absent = no own schedule. */
export function parseWeekly(raw: unknown): WeeklySchedule | null {
  if (raw == null) return null;
  if (!Array.isArray(raw) || raw.length !== 7) throw badRequest('График: нужно 7 дней — с понедельника по воскресенье');
  return raw.map((entry, i) => (entry == null ? null : parseWorkHours(entry, WEEKDAY_TITLES[i]!)));
}

/** The stored weekly schedule; anything unreadable counts as none (the studio hours). */
export function readWeekly(json: string | null): WeeklySchedule | null {
  if (!json) return null;
  try {
    return parseWeekly(JSON.parse(json));
  } catch {
    return null;
  }
}

export function readBreaks(json: string): TimeRange[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((b): b is TimeRange => isObject(b) && typeof b.start === 'string' && typeof b.end === 'string') : [];
  } catch {
    return [];
  }
}

/** Monday = 0 … Sunday = 6 for a calendar date "YYYY-MM-DD". */
const weekdayIndex = (date: string) => DateTime.fromISO(date, { zone: 'utc' }).weekday - 1;

export function resolveScheduleDay(input: {
  employeeId: number;
  date: string;
  weekly: WeeklySchedule | null;
  exception: ScheduleException | undefined;
  studio: { workdayStart: string; workdayEnd: string };
}): ScheduleDay {
  const { employeeId, date, weekly, exception, studio } = input;
  const off = (source: ScheduleSource, note: string | null): ScheduleDay => ({
    employeeId, date, working: false, start: null, end: null, breaks: [], source, note,
  });
  const on = (hours: WorkHours, source: ScheduleSource, note: string | null): ScheduleDay => ({
    employeeId, date, working: true, start: hours.start, end: hours.end, breaks: hours.breaks, source, note,
  });
  if (exception) {
    if (exception.off || !exception.start || !exception.end) return off('day', exception.note);
    return on({ start: exception.start, end: exception.end, breaks: readBreaks(exception.breaks) }, 'day', exception.note);
  }
  if (weekly) {
    const entry = weekly[weekdayIndex(date)];
    return entry ? on(entry, 'weekly', null) : off('weekly', null);
  }
  return on({ start: studio.workdayStart, end: studio.workdayEnd, breaks: [] }, 'studio', null);
}

/** The instant of a studio time of day ("24:00" = the next midnight) on a studio-local date. */
export function instantOf(date: string, time: string, tz: string): number {
  const day = DateTime.fromISO(date, { zone: tz }).startOf('day');
  const minutes = parseTimeOfDay(time) ?? 0;
  if (minutes >= DAY_MINUTES) return day.plus({ days: 1 }).toMillis();
  return day.set({ hour: Math.floor(minutes / 60), minute: minutes % 60 }).toMillis();
}

/** The working time of a day as instants, minus the breaks (empty on a day off). */
export function workingIntervals(day: ScheduleDay, tz: string): Interval[] {
  if (!day.working || !day.start || !day.end) return [];
  const close = instantOf(day.date, day.end, tz);
  const intervals: Interval[] = [];
  let cursor = instantOf(day.date, day.start, tz);
  for (const b of day.breaks) {
    const breakStart = instantOf(day.date, b.start, tz);
    if (breakStart > cursor) intervals.push({ start: cursor, end: breakStart });
    cursor = Math.max(cursor, instantOf(day.date, b.end, tz));
  }
  if (close > cursor) intervals.push({ start: cursor, end: close });
  return intervals;
}

/** Every calendar date from `from` to `to`, inclusive. */
export function datesBetween(from: string, to: string): string[] {
  const dates: string[] = [];
  const last = DateTime.fromISO(to, { zone: 'utc' });
  for (let day = DateTime.fromISO(from, { zone: 'utc' }); day <= last; day = day.plus({ days: 1 })) {
    dates.push(day.toISODate() ?? '');
  }
  return dates;
}

/** «23 октября», «23–24 октября», «30 октября – 2 ноября». */
export function datesLabel(from: string, to = from): string {
  const a = DateTime.fromISO(from).setLocale('ru');
  const b = DateTime.fromISO(to).setLocale('ru');
  if (from === to) return a.toFormat('d MMMM');
  if (a.hasSame(b, 'month')) return `${a.toFormat('d')}–${b.toFormat('d MMMM')}`;
  return `${a.toFormat('d MMMM')} – ${b.toFormat('d MMMM')}`;
}

/** The working time of each employee on each date: date ascending, then employees in the given order. */
export function scheduleDaysFor(db: DbOrTx, people: EmployeeRow[], dates: string[]): ScheduleDay[] {
  if (people.length === 0 || dates.length === 0) return [];
  const studio = getStudioSettings(db);
  const rows = db
    .select()
    .from(scheduleDays)
    .where(
      and(
        inArray(scheduleDays.employeeId, people.map((p) => p.id)),
        gte(scheduleDays.date, dates[0]!),
        lte(scheduleDays.date, dates.at(-1)!),
      ),
    )
    .all();
  const exceptions = new Map(rows.map((r) => [`${r.employeeId}:${r.date}`, r]));
  const weekly = new Map(people.map((p) => [p.id, readWeekly(p.weeklySchedule)]));
  return dates.flatMap((date) =>
    people.map((p) =>
      resolveScheduleDay({ employeeId: p.id, date, weekly: weekly.get(p.id) ?? null, exception: exceptions.get(`${p.id}:${date}`), studio }),
    ),
  );
}

export function employeeScheduleDay(db: DbOrTx, employee: EmployeeRow, date: string): ScheduleDay {
  return scheduleDaysFor(db, [employee], [date])[0]!;
}

/** `WorkSchedule` output: the weekly schedule and the exceptions from `from` on. */
export function workScheduleOut(db: DbOrTx, employee: EmployeeRow, from: string) {
  const days = db
    .select()
    .from(scheduleDays)
    .where(and(eq(scheduleDays.employeeId, employee.id), gte(scheduleDays.date, from)))
    .orderBy(asc(scheduleDays.date))
    .all();
  return {
    employeeId: employee.id,
    weekly: readWeekly(employee.weeklySchedule),
    days: days.map((d) => ({
      date: d.date,
      off: d.off,
      start: d.off ? null : d.start,
      end: d.off ? null : d.end,
      breaks: d.off ? [] : readBreaks(d.breaks),
      note: d.note,
    })),
  };
}
