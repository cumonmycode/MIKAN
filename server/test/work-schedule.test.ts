import { eq } from 'drizzle-orm';
import type { InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { employees } from '../src/db/schema.js';
import {
  datesBetween,
  parseWeekly,
  parseWorkHours,
  resolveScheduleDay,
  workingIntervals,
  type WeeklySchedule,
} from '../src/domain/work-schedule.js';
import { AppError } from '../src/lib/errors.js';
import { genitiveName } from '../src/lib/name-cases.js';
import { createTestApp, make, type TestApp } from './helpers.js';

const TZ = 'Europe/Moscow';
const STUDIO = { workdayStart: '11:00', workdayEnd: '21:00' };
const hours = (start: string, end: string, breaks: Array<[string, string]> = []) => ({
  start,
  end,
  breaks: breaks.map(([s, e]) => ({ start: s, end: e })),
});
/** Fatima: Mon, Wed, Thu 12:00–21:00 with a break 15:00–15:30, Sat 11:00–20:00; Tue, Fri, Sun off. */
const FATIMA_WEEK: WeeklySchedule = [
  hours('12:00', '21:00', [['15:00', '15:30']]),
  null,
  hours('12:00', '21:00', [['15:00', '15:30']]),
  hours('12:00', '21:00', [['15:00', '15:30']]),
  null,
  hours('11:00', '20:00'),
  null,
];

const reason = (fn: () => unknown): string | null => {
  try {
    fn();
  } catch (err) {
    if (err instanceof AppError) return err.message;
    throw err;
  }
  return null;
};
const week = (index: number, entry: unknown) => Array.from({ length: 7 }, (_, i) => (i === index ? entry : null));

describe('work schedule: validation', () => {
  it('normalizes the weekly schedule: two-digit hours, sorted breaks, midnight as 24:00', () => {
    const parsed = parseWeekly([
      { start: '9:00', end: '18:00', breaks: [{ start: '14:00', end: '14:30' }, { start: '12:00', end: '12:15' }] },
      null,
      null,
      null,
      null,
      null,
      { start: '12:00', end: '24:00' },
    ]);
    expect(parsed).toEqual([
      hours('09:00', '18:00', [['12:00', '12:15'], ['14:00', '14:30']]),
      null,
      null,
      null,
      null,
      null,
      hours('12:00', '24:00'),
    ]);
    expect(parseWeekly(null)).toBeNull();
    expect(parseWeekly(undefined)).toBeNull();
  });

  it('rejects invalid schedules with the Russian reason', () => {
    expect(reason(() => parseWeekly([null]))).toBe('График: нужно 7 дней — с понедельника по воскресенье');
    expect(reason(() => parseWeekly('пн-пт'))).toBe('График: нужно 7 дней — с понедельника по воскресенье');
    expect(reason(() => parseWeekly(week(0, { start: '25:00', end: '18:00' })))).toBe(
      'Понедельник: время должно быть в формате ЧЧ:ММ (например, 10:00)',
    );
    expect(reason(() => parseWeekly(week(0, { start: '10:00' })))).toBe('Понедельник: укажите начало и конец работы');
    expect(reason(() => parseWeekly(week(1, { start: '18:00', end: '10:00' })))).toBe(
      'Вторник: конец работы (10:00) должен быть позже начала (18:00)',
    );
    expect(reason(() => parseWeekly(week(2, hours('10:00', '18:00', [['09:00', '09:30']]))))).toBe(
      'Среда: перерыв 09:00–09:30 выходит за часы работы 10:00–18:00',
    );
    expect(reason(() => parseWeekly(week(3, hours('10:00', '18:00', [['13:00', '14:00'], ['13:30', '14:30']]))))).toBe(
      'Четверг: перерывы 13:00–14:00 и 13:30–14:30 пересекаются',
    );
    expect(reason(() => parseWeekly(week(4, hours('10:00', '18:00', [['14:00', '13:00']]))))).toBe(
      'Пятница: конец перерыва (13:00) должен быть позже начала (14:00)',
    );
    expect(reason(() => parseWeekly(week(6, hours('10:00', '18:00', Array.from({ length: 7 }, (_, i) => [`1${i}:00`, `1${i}:10`] as [string, string])))))).toBe(
      'Воскресенье: не больше 6 перерывов',
    );
    // Breaks that only touch each other or the edges of the day are fine.
    expect(parseWorkHours(hours('10:00', '18:00', [['10:00', '10:30'], ['10:30', '11:00'], ['17:30', '18:00']]), '23 октября').breaks).toHaveLength(3);
  });

  it('declines first names to the genitive when it is safe', () => {
    expect(genitiveName('Фатима')).toBe('Фатимы');
    expect(genitiveName('Ольга')).toBe('Ольги');
    expect(genitiveName('Мария')).toBe('Марии');
    expect(genitiveName('Андрей')).toBe('Андрея');
    expect(genitiveName('Борис')).toBe('Бориса');
    expect(genitiveName('Нелли')).toBe('Нелли');
    expect(genitiveName('Игорь')).toBeNull();
    expect(genitiveName('Анна Иванова')).toBeNull();
    expect(genitiveName('Kate')).toBeNull();
  });
});

describe('work schedule: working time of a date', () => {
  const resolve = (date: string, weekly: WeeklySchedule | null, exception?: Parameters<typeof resolveScheduleDay>[0]['exception']) =>
    resolveScheduleDay({ employeeId: 3, date, weekly, exception, studio: STUDIO });

  it('takes the exception, else the weekly entry, else the studio hours', () => {
    expect(resolve('2026-10-19', FATIMA_WEEK)).toEqual({
      employeeId: 3, date: '2026-10-19', working: true, start: '12:00', end: '21:00',
      breaks: [{ start: '15:00', end: '15:30' }], source: 'weekly', note: null,
    });
    expect(resolve('2026-10-20', FATIMA_WEEK)).toMatchObject({ working: false, start: null, end: null, breaks: [], source: 'weekly' });
    expect(resolve('2026-10-25', null)).toMatchObject({ working: true, start: '11:00', end: '21:00', breaks: [], source: 'studio' });
    const vacation = { off: true, start: null, end: null, breaks: '[]', note: 'Отпуск' };
    expect(resolve('2026-10-19', FATIMA_WEEK, vacation)).toMatchObject({ working: false, start: null, source: 'day', note: 'Отпуск' });
    const shortDay = { off: false, start: '10:00', end: '14:00', breaks: '[]', note: null };
    expect(resolve('2026-10-20', FATIMA_WEEK, shortDay)).toMatchObject({ working: true, start: '10:00', end: '14:00', source: 'day' });
    // An exception applies even without a weekly schedule.
    expect(resolve('2026-10-25', null, vacation)).toMatchObject({ working: false, source: 'day' });
  });

  it('turns the working time into studio-time instants minus the breaks', () => {
    const monday = resolve('2026-10-19', FATIMA_WEEK);
    expect(workingIntervals(monday, TZ)).toEqual([
      { start: Date.parse('2026-10-19T09:00:00Z'), end: Date.parse('2026-10-19T12:00:00Z') },
      { start: Date.parse('2026-10-19T12:30:00Z'), end: Date.parse('2026-10-19T18:00:00Z') },
    ]);
    expect(workingIntervals(resolve('2026-10-20', FATIMA_WEEK), TZ)).toEqual([]);
    const late = resolve('2026-10-25', [null, null, null, null, null, null, hours('18:00', '24:00')]);
    expect(workingIntervals(late, TZ)).toEqual([{ start: Date.parse('2026-10-25T15:00:00Z'), end: Date.parse('2026-10-25T21:00:00Z') }]);
    expect(workingIntervals(late, 'Asia/Novosibirsk')).toEqual([{ start: Date.parse('2026-10-25T11:00:00Z'), end: Date.parse('2026-10-25T17:00:00Z') }]);
  });

  it('lists the dates of a range inclusively', () => {
    expect(datesBetween('2026-10-30', '2026-11-02')).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
    expect(datesBetween('2026-10-30', '2026-10-30')).toEqual(['2026-10-30']);
    expect(datesBetween('2026-10-30', '2026-10-29')).toEqual([]);
  });
});

describe('work schedules API', () => {
  let t: TestApp;
  let fatima: { id: number };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-10-19T06:00:00Z')); // Monday 09:00 in Moscow
    t = await createTestApp();
    fatima = await make(t, '/api/employees', { name: 'Фатима', login: 'fatima', password: 'secret123', isMaster: true });
  });
  afterEach(async () => {
    await t.close();
    vi.useRealTimers();
  });

  /** Requests as another employee with the given role. */
  async function as(login: string, role: 'owner' | 'admin' | 'master') {
    t.ctx.db.update(employees).set({ role }).where(eq(employees.login, login)).run();
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login, password: 'secret123' } });
    const token = res.json<{ token: string }>().token;
    return (method: InjectOptions['method'], url: string, payload?: unknown) =>
      t.app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload === undefined ? {} : { payload: payload as InjectOptions['payload'] }) });
  }

  it('stores the weekly schedule and reads it back with the upcoming exceptions', async () => {
    const empty = await t.api('GET', `/api/employees/${fatima.id}/schedule`);
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ employeeId: fatima.id, weekly: null, days: [] });

    const put = await t.api('PUT', `/api/employees/${fatima.id}/schedule`, { weekly: FATIMA_WEEK });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ employeeId: fatima.id, weekly: FATIMA_WEEK, days: [] });
    expect((await t.api('GET', `/api/employees/${fatima.id}/schedule`)).json().weekly).toEqual(FATIMA_WEEK);

    const bad = await t.api('PUT', `/api/employees/${fatima.id}/schedule`, { weekly: week(1, { start: '18:00', end: '10:00' }) });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toEqual({ code: 'validation_error', message: 'Вторник: конец работы (10:00) должен быть позже начала (18:00)' });

    // `null` returns the employee to the studio hours.
    expect((await t.api('PUT', `/api/employees/${fatima.id}/schedule`, { weekly: null })).json().weekly).toBeNull();
    expect((await t.api('GET', `/api/employees/999/schedule`)).statusCode).toBe(404);
    expect((await t.api('PUT', `/api/employees/999/schedule`, { weekly: null })).statusCode).toBe(404);
  });

  it('sets, lists and removes exceptions over a range of dates', async () => {
    const vacation = await t.api('PUT', `/api/employees/${fatima.id}/schedule/days`, {
      from: '2026-10-23', to: '2026-10-25', off: true, start: '10:00', note: ' Отпуск ',
    });
    expect(vacation.statusCode).toBe(200);
    expect(vacation.json().days).toEqual(
      ['2026-10-23', '2026-10-24', '2026-10-25'].map((date) => ({ date, off: true, start: null, end: null, breaks: [], note: 'Отпуск' })),
    );
    // Other hours for one date replace that date only; `to` defaults to `from`.
    const other = await t.api('PUT', `/api/employees/${fatima.id}/schedule/days`, {
      from: '2026-10-24', off: false, start: '14:00', end: '20:00', breaks: [{ start: '17:00', end: '17:30' }],
    });
    expect(other.json().days.map((d: { date: string; off: boolean }) => [d.date, d.off])).toEqual([
      ['2026-10-23', true], ['2026-10-24', false], ['2026-10-25', true],
    ]);
    expect(other.json().days[1]).toEqual({
      date: '2026-10-24', off: false, start: '14:00', end: '20:00', breaks: [{ start: '17:00', end: '17:30' }], note: null,
    });
    // Past exceptions show only with ?from=.
    await t.api('PUT', `/api/employees/${fatima.id}/schedule/days`, { from: '2026-10-12', off: true });
    expect((await t.api('GET', `/api/employees/${fatima.id}/schedule`)).json().days).toHaveLength(3);
    expect((await t.api('GET', `/api/employees/${fatima.id}/schedule?from=2026-10-01`)).json().days).toHaveLength(4);

    const removed = await t.api('DELETE', `/api/employees/${fatima.id}/schedule/days?from=2026-10-24&to=2026-10-25`);
    expect(removed.statusCode).toBe(200);
    expect(removed.json().days.map((d: { date: string }) => d.date)).toEqual(['2026-10-23']);
    const single = await t.api('DELETE', `/api/employees/${fatima.id}/schedule/days?from=2026-10-23`);
    expect(single.json().days).toEqual([]);
  });

  it('rejects invalid exceptions and ranges', async () => {
    const put = (body: object) => t.api('PUT', `/api/employees/${fatima.id}/schedule/days`, body);
    const message = async (body: object) => (await put(body)).json().error.message as string;
    expect(await message({ off: true })).toBe('«Начало периода»: обязательное поле');
    expect(await message({ from: '2026-13-01', off: true })).toBe('«Начало периода»: дата должна быть в формате ГГГГ-ММ-ДД');
    expect(await message({ from: '2026-10-25', to: '2026-10-23', off: true })).toBe('Конец периода раньше начала');
    expect(await message({ from: '2026-10-01', to: '2026-12-02', off: true })).toBe('Период — не больше 62 дней');
    expect(await message({ from: '2026-10-23', off: false })).toBe('23 октября: укажите начало и конец работы');
    expect(await message({ from: '2026-10-23', to: '2026-10-24', off: false, start: '12:00', end: '20:00', breaks: [{ start: '11:00', end: '11:30' }] })).toBe(
      '23–24 октября: перерыв 11:00–11:30 выходит за часы работы 12:00–20:00',
    );
    expect((await put({ from: '2026-10-01', to: '2026-12-02', off: true })).statusCode).toBe(400);
  });

  it('GET /schedules gives every active master every date of the range', async () => {
    await t.api('PUT', `/api/employees/${fatima.id}/schedule`, { weekly: FATIMA_WEEK });
    await t.api('PUT', `/api/employees/${fatima.id}/schedule/days`, { from: '2026-10-21', off: true, note: 'Больничный' });
    await make(t, '/api/employees', { name: 'Ирина', login: 'irina', password: 'secret123', isMaster: false });
    const res = await t.api('GET', '/api/schedules?from=2026-10-19&to=2026-10-21');
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<{ employeeId: number; date: string }>;
    expect(items.map((d) => [d.date, d.employeeId])).toEqual([
      ['2026-10-19', 1], ['2026-10-19', fatima.id],
      ['2026-10-20', 1], ['2026-10-20', fatima.id],
      ['2026-10-21', 1], ['2026-10-21', fatima.id],
    ]);
    expect(items[0]).toEqual({ employeeId: 1, date: '2026-10-19', working: true, start: '11:00', end: '21:00', breaks: [], source: 'studio', note: null });
    expect(items[1]).toEqual({
      employeeId: fatima.id, date: '2026-10-19', working: true, start: '12:00', end: '21:00',
      breaks: [{ start: '15:00', end: '15:30' }], source: 'weekly', note: null,
    });
    expect(items[3]).toMatchObject({ working: false, start: null, end: null, source: 'weekly' });
    expect(items[5]).toMatchObject({ working: false, source: 'day', note: 'Больничный' });

    expect((await t.api('GET', '/api/schedules?from=2026-10-01&to=2026-12-31')).json().error.message).toBe('Период — не больше 62 дней');
    expect((await t.api('GET', '/api/schedules?from=2026-10-01')).json().error.message).toBe('«Конец периода»: обязательное поле');
  });

  it('lets owners and admins change schedules; masters only read them', async () => {
    await make(t, '/api/employees', { name: 'Олег', login: 'oleg', password: 'secret123' });
    const master = await as('fatima', 'master');
    const forbidden = { error: { code: 'forbidden', message: 'Это доступно владельцу и администратору' } };
    const put = await master('PUT', `/api/employees/${fatima.id}/schedule`, { weekly: FATIMA_WEEK });
    expect(put.statusCode).toBe(403);
    expect(put.json()).toEqual(forbidden);
    expect((await master('PUT', `/api/employees/${fatima.id}/schedule/days`, { from: '2026-10-23', off: true })).statusCode).toBe(403);
    expect((await master('DELETE', `/api/employees/${fatima.id}/schedule/days?from=2026-10-23`)).statusCode).toBe(403);
    expect((await master('GET', `/api/employees/${fatima.id}/schedule`)).statusCode).toBe(200);
    expect((await master('GET', '/api/schedules?from=2026-10-19&to=2026-10-19')).statusCode).toBe(200);

    const admin = await as('oleg', 'admin');
    expect((await admin('PUT', `/api/employees/${fatima.id}/schedule`, { weekly: FATIMA_WEEK })).statusCode).toBe(200);
    expect((await admin('PUT', `/api/employees/${fatima.id}/schedule/days`, { from: '2026-10-23', off: true })).statusCode).toBe(200);
  });
});
