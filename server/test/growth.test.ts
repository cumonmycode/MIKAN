import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appointments, clients, sales } from '../src/db/schema.js';
import { createTestApp, type TestApp } from './helpers.js';
import {
  addAppointment,
  addBookingRequest,
  addClient,
  addEmployee,
  addSale,
  addScheduleDay,
  ALL_DAYS_OFF,
  at,
  WEEKDAYS_10_19,
  type Json,
} from './growth-fixtures.js';

// The studio is in Moscow (UTC+3); the test process runs in Asia/Tomsk (UTC+7, see vitest.config.ts).
const NOW = '2026-10-19T12:00:00+03:00';
const WEEK = { from: '2026-10-01T00:00:00+03:00', to: '2026-10-08T00:00:00+03:00' }; // Thu 1 – Wed 7 Oct
const SEPTEMBER = { from: '2026-09-01T00:00:00+03:00', to: '2026-10-01T00:00:00+03:00' };

const iso = (value: string) => new Date(at(value)).toISOString();

describe('GET /reports/growth', () => {
  let t: TestApp;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(at(NOW));
    t = await createTestApp();
  });
  afterEach(async () => {
    await t.close();
    vi.useRealTimers();
  });

  const growth = async (period: { from: string; to: string }): Promise<Json> => {
    const res = await t.api('GET', `/api/reports/growth?from=${iso(period.from)}&to=${iso(period.to)}`);
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  it('counts booking requests, online bookings by outcome and every appointment booked in the period', async () => {
    addBookingRequest(t, 'new', '2026-10-02T10:00:00+03:00');
    addBookingRequest(t, 'processed', '2026-10-03T10:00:00+03:00');
    addBookingRequest(t, 'processed', '2026-10-07T23:59:00+03:00');
    addBookingRequest(t, 'rejected', '2026-10-01T00:00:00+03:00');
    addBookingRequest(t, 'processed', '2026-09-30T23:59:00+03:00'); // before the period
    addBookingRequest(t, 'new', '2026-10-08T00:00:00+03:00'); // at `to`: outside

    const k = addClient(t, 'Клиент');
    const booked = (channel: string, status: string, extra: { onlineState?: string; notes?: string; createdAt?: string } = {}) =>
      addAppointment(t, k, { start: '2026-10-20T12:00:00+03:00', channel, status, createdAt: '2026-10-03T12:00:00+03:00', ...extra });
    booked('web', 'scheduled', { onlineState: 'awaiting_confirmation' });
    booked('miniapp', 'scheduled', { onlineState: 'awaiting_payment' });
    booked('web', 'cancelled', { notes: 'Онлайн-запись отклонена: мастер заболел' });
    booked('bot', 'cancelled', { onlineState: 'awaiting_confirmation' }); // staff cancelled it without confirming
    booked('web', 'cancelled', { notes: 'Предоплата не внесена вовремя' });
    booked('miniapp', 'cancelled', { notes: 'Аллергия на никель\nОтменена клиентом онлайн' });
    booked('bot', 'completed');
    booked('web', 'scheduled');
    booked('miniapp', 'no_show');
    booked('bot', 'cancelled'); // confirmed, cancelled by staff later
    booked('web', 'completed', { createdAt: '2026-09-30T23:00:00+03:00' }); // booked before the period
    booked('bot', 'confirmed', { createdAt: '2026-10-08T00:00:00+03:00' }); // booked at `to`
    booked('app', 'completed');
    booked('app', 'completed');
    booked('app', 'cancelled');
    booked('app', 'scheduled');
    booked('app', 'no_show', { createdAt: '2026-09-20T12:00:00+03:00' });

    const r = await growth(WEEK);
    expect(r.from).toBe(iso(WEEK.from));
    expect(r.to).toBe(iso(WEEK.to));
    expect(r.funnel).toEqual({
      bookingRequests: { created: 4, processed: 2, rejected: 1, open: 1 },
      online: {
        created: 10,
        byChannel: { bot: 3, miniapp: 3, web: 4 },
        confirmed: 4,
        rejected: 2,
        expired: 1,
        cancelledByClient: 1,
        completed: 1,
        awaiting: 2,
      },
      appointments: { created: 14, byChannel: { app: 4, bot: 3, miniapp: 3, web: 4 }, completed: 3, cancelled: 6, noShow: 1 },
    });
  });

  it('measures master load against work schedules, studio hours without one, by weekday', async () => {
    const anna = addEmployee(t, 'Анна', { weekly: WEEKDAYS_10_19 });
    addScheduleDay(t, anna, '2026-10-02'); // Friday off
    const boris = addEmployee(t, 'Борис', { weekly: ALL_DAYS_OFF });
    const inactive = addEmployee(t, 'Вера', { active: false });
    const notMaster = addEmployee(t, 'Глеб', { isMaster: false });
    const c = addClient(t, 'Клиент');
    const visit = (masterId: number, start: string, end: string, status = 'completed') => addAppointment(t, c, { masterId, start, end, status });

    visit(anna, '2026-10-01T10:00:00+03:00', '2026-10-01T12:00:00+03:00');
    visit(anna, '2026-10-01T11:00:00+03:00', '2026-10-01T13:00:00+03:00', 'scheduled'); // overlaps: counted once
    visit(anna, '2026-09-30T23:00:00+03:00', '2026-10-01T00:30:00+03:00'); // 30 min inside the period
    visit(anna, '2026-10-03T12:00:00+03:00', '2026-10-03T13:00:00+03:00'); // Saturday, a day off: still booked
    visit(anna, '2026-10-05T16:00:00+03:00', '2026-10-05T18:00:00+03:00', 'confirmed');
    visit(anna, '2026-10-05T23:00:00+03:00', '2026-10-06T01:00:00+03:00', 'scheduled'); // Monday 60 + Tuesday 60
    visit(anna, '2026-10-06T12:00:00+03:00', '2026-10-06T13:00:00+03:00', 'cancelled');
    visit(anna, '2026-10-06T13:00:00+03:00', '2026-10-06T14:00:00+03:00', 'no_show');
    visit(anna, '2026-10-07T23:30:00+03:00', '2026-10-08T01:00:00+03:00', 'scheduled'); // 30 min inside the period
    visit(anna, '2026-10-08T10:00:00+03:00', '2026-10-08T11:00:00+03:00'); // after the period
    visit(boris, '2026-10-06T12:00:00+03:00', '2026-10-06T13:00:00+03:00');
    visit(inactive, '2026-10-06T12:00:00+03:00', '2026-10-06T13:00:00+03:00');
    visit(notMaster, '2026-10-06T12:00:00+03:00', '2026-10-06T13:00:00+03:00');

    const weekdays = (working: number[], booked: number[]) =>
      working.map((workingMinutes, i) => ({ weekday: i + 1, workingMinutes, bookedMinutes: booked[i] }));
    const { load } = await growth(WEEK);
    expect(load.map((l: Json) => l.employee.name)).toEqual(['Анна', 'Админ', 'Борис']);
    expect(load[0]).toEqual({
      employee: { id: anna, name: 'Анна', color: '#123456' },
      workingMinutes: 1920,
      bookedMinutes: 540,
      completedMinutes: 210,
      loadPercent: 28,
      byWeekday: weekdays([480, 480, 480, 480, 0, 0, 0], [180, 60, 30, 210, 0, 60, 0]),
    });
    expect(load[1]).toMatchObject({
      employee: { id: 1 },
      workingMinutes: 4200, // the studio hours 11:00–21:00, every day
      bookedMinutes: 0,
      completedMinutes: 0,
      loadPercent: 0,
      byWeekday: weekdays([600, 600, 600, 600, 600, 600, 600], [0, 0, 0, 0, 0, 0, 0]),
    });
    expect(load[2]).toMatchObject({
      employee: { id: boris },
      workingMinutes: 0,
      bookedMinutes: 60,
      completedMinutes: 60,
      loadPercent: null,
      byWeekday: weekdays([0, 0, 0, 0, 0, 0, 0], [0, 60, 0, 0, 0, 0, 0]),
    });
  });

  it('follows new clients by their first completed visit, returns within 90 days and monthly cohorts', async () => {
    const visit = (client: number, start: string, status = 'completed') => addAppointment(t, client, { start, status });
    const a = addClient(t, 'A');
    visit(a, '2026-09-01T00:30:00+03:00'); // 31 Aug in UTC — September in the studio
    visit(a, '2026-10-01T00:30:00+03:00'); // 30 studio days later, after the period
    const b = addClient(t, 'B');
    visit(b, '2026-09-02T12:00:00+03:00');
    visit(b, '2026-10-03T12:00:00+03:00'); // 31 days
    const c = addClient(t, 'C');
    visit(c, '2026-09-15T12:00:00+03:00');
    visit(c, '2026-09-15T18:00:00+03:00'); // the same day is not a return
    visit(c, '2026-09-20T12:00:00+03:00', 'cancelled');
    visit(c, '2026-09-25T12:00:00+03:00', 'no_show');
    const d = addClient(t, 'D');
    visit(d, '2026-08-31T23:30:00+03:00'); // August in the studio
    visit(d, '2026-09-05T12:00:00+03:00');
    const e = addClient(t, 'E');
    visit(e, '2025-10-01T12:00:00+03:00');
    visit(e, '2026-02-28T12:00:00+03:00'); // 150 days
    const f = addClient(t, 'F');
    visit(f, '2025-09-30T23:30:00+03:00'); // before the 12 cohort months
    visit(f, '2026-09-10T12:00:00+03:00'); // 345 days later
    const g = addClient(t, 'G');
    visit(g, '2026-09-10T12:00:00+03:00', 'cancelled');
    addSale(t, g, { at: '2026-09-10T13:00:00+03:00', total: 1000 });
    const h = addClient(t, 'H');
    visit(h, '2026-08-20T12:00:00+03:00', 'no_show');
    visit(h, '2026-09-20T12:00:00+03:00');

    const { retention } = await growth(SEPTEMBER);
    expect(retention).toMatchObject({
      newClients: 4, // A, B, C, H
      returnedWithin90Days: 2, // A, B
      repeatRatePercent: 50,
      averageDaysBetweenVisits: 175, // D: 5 days, F: 345 days
    });
    const months = ['2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];
    const filled: Record<string, Json> = {
      '2025-10': { clients: 1, returned30: 0, returned90: 0, returned180: 1 },
      '2026-08': { clients: 1, returned30: 1, returned90: 1, returned180: 1 },
      '2026-09': { clients: 4, returned30: 1, returned90: 2, returned180: 2 },
    };
    expect(retention.cohorts).toEqual(
      months.map((month) => ({ month, ...(filled[month] ?? { clients: 0, returned30: 0, returned90: 0, returned180: 0 }) })),
    );
  });

  it('values clients over all time up to `to`: kept revenue without bonuses and certificates, visits, the top 10 %', async () => {
    const p = addClient(t, 'P');
    for (const start of ['2026-01-10T12:00:00+03:00', '2026-03-10T12:00:00+03:00', '2026-06-10T12:00:00+03:00', '2026-09-10T12:00:00+03:00']) {
      addAppointment(t, p, { start });
    }
    addAppointment(t, p, { start: '2026-07-10T12:00:00+03:00', status: 'no_show' });
    addSale(t, p, { at: '2026-03-10T13:00:00+03:00', total: 5000 });
    addSale(t, p, { at: '2026-06-10T13:00:00+03:00', total: 3000, status: 'refunded' });
    addSale(t, p, { at: '2026-09-10T13:00:00+03:00', total: 2000, payBonus: 500 });
    const q = addClient(t, 'Q');
    addAppointment(t, q, { start: '2026-05-05T12:00:00+03:00' });
    const r = addClient(t, 'R');
    addSale(t, r, { at: '2026-07-07T12:00:00+03:00', total: 1000 });
    const u = addClient(t, 'U');
    addSale(t, u, { at: '2026-08-08T12:00:00+03:00', total: 5000, certificate: 3000 });
    const v = addClient(t, 'V');
    addAppointment(t, v, { start: '2026-09-30T23:59:00+03:00' });
    const s = addClient(t, 'S');
    addAppointment(t, s, { start: '2026-10-01T00:00:00+03:00' }); // at `to`
    addSale(t, s, { at: '2026-10-01T10:00:00+03:00', total: 7000 });
    const tt = addClient(t, 'T');
    addAppointment(t, tt, { start: '2026-04-04T12:00:00+03:00', status: 'cancelled' });
    const w = addClient(t, 'W');
    addSale(t, w, { at: '2026-02-02T12:00:00+03:00', total: 2500, status: 'refunded' });
    addSale(t, null, { at: '2026-05-05T12:00:00+03:00', total: 4000 });

    const { value } = await growth(SEPTEMBER);
    expect(value).toEqual({
      clientsWithVisits: 5, // P, Q, R, U, V
      averageRevenuePerClient: 1900, // (6500 + 0 + 1000 + 2000 + 0) / 5
      averageVisitsPerClient: 1.2, // 6 visits / 5
      top10PercentShare: 68.4, // P: 6500 of 9500
    });
  });

  it('splits the new clients of the period by source with the revenue they brought in it', async () => {
    const newcomer = (name: string, source: string | null, start = '2026-09-10T12:00:00+03:00') => {
      const id = addClient(t, name, source);
      addAppointment(t, id, { start });
      return id;
    };
    const n1 = newcomer('N1', 'Instagram ');
    addSale(t, n1, { at: '2026-09-10T13:00:00+03:00', total: 3000 });
    addSale(t, n1, { at: '2026-09-11T13:00:00+03:00', total: 1000, status: 'refunded' });
    addSale(t, n1, { at: '2026-08-10T13:00:00+03:00', total: 500 }); // before the period
    const n2 = newcomer('N2', 'instagram');
    addSale(t, n2, { at: '2026-09-12T13:00:00+03:00', total: 2000 });
    newcomer('N3', null);
    const n4 = newcomer('N4', '  ');
    addSale(t, n4, { at: '2026-09-30T23:00:00+03:00', total: 700 });
    const n5 = newcomer('N5', 'рекомендация');
    addSale(t, n5, { at: '2026-10-01T10:00:00+03:00', total: 4000 }); // after the period
    const old = newcomer('O1', 'instagram', '2026-08-10T12:00:00+03:00');
    addSale(t, old, { at: '2026-09-12T13:00:00+03:00', total: 9000 });
    const lead = addClient(t, 'X', 'telegram', at('2026-09-05T12:00:00+03:00')); // a card without a visit
    addSale(t, lead, { at: '2026-09-12T13:00:00+03:00', total: 9000 });

    const r = await growth(SEPTEMBER);
    expect(r.retention.newClients).toBe(5);
    expect(r.sources).toEqual([
      { source: 'instagram', newClients: 2, revenue: 5000 },
      { source: 'не указан', newClients: 2, revenue: 700 },
      { source: 'рекомендация', newClients: 1, revenue: 0 },
    ]);
  });

  it('answers an empty studio with zeros, nulls where nothing can be divided and all 12 cohort months', async () => {
    const r = await growth({ from: '2026-10-01T00:00:00+03:00', to: '2026-10-02T00:00:00+03:00' });
    expect(r.funnel).toEqual({
      bookingRequests: { created: 0, processed: 0, rejected: 0, open: 0 },
      online: { created: 0, byChannel: { bot: 0, miniapp: 0, web: 0 }, confirmed: 0, rejected: 0, expired: 0, cancelledByClient: 0, completed: 0, awaiting: 0 },
      appointments: { created: 0, byChannel: { app: 0, bot: 0, miniapp: 0, web: 0 }, completed: 0, cancelled: 0, noShow: 0 },
    });
    expect(r.load).toHaveLength(1);
    expect(r.load[0]).toMatchObject({ workingMinutes: 600, bookedMinutes: 0, completedMinutes: 0, loadPercent: 0 });
    expect(r.load[0].byWeekday).toHaveLength(7);
    expect(r.retention).toMatchObject({ newClients: 0, returnedWithin90Days: 0, repeatRatePercent: null, averageDaysBetweenVisits: null });
    expect(r.retention.cohorts.map((c: Json) => c.month)).toEqual([
      '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10',
    ]);
    expect(r.value).toEqual({ clientsWithVisits: 0, averageRevenuePerClient: 0, averageVisitsPerClient: 0, top10PercentShare: null });
    expect(r.sources).toEqual([]);
  });

  it('validates the period like the analytics', async () => {
    const error = async (query: string) => (await t.api('GET', `/api/reports/growth?${query}`)).json().error;
    const from = iso(WEEK.from);
    const to = iso(WEEK.to);
    expect(await error(`from=${to}&to=${from}`)).toEqual({ code: 'validation_error', message: 'Конец периода должен быть позже начала' });
    expect(await error(`from=${from}&to=${from}`)).toEqual({ code: 'validation_error', message: 'Конец периода должен быть позже начала' });
    expect(await error('from=2025-01-01T00:00:00.000Z&to=2026-03-01T00:00:00.000Z')).toEqual({
      code: 'validation_error',
      message: 'Период отчёта — не больше 400 дней',
    });
    expect((await t.api('GET', '/api/reports/growth?from=x&to=y')).statusCode).toBe(400);
    expect((await t.api('GET', '/api/reports/growth')).statusCode).toBe(400);
  });

  it('stays fast on a studio year: ~1 600 sales and ~1 900 appointments over 400 days', async () => {
    const masters = [1, ...['Анна', 'Фатима', 'Амина', 'Лия'].map((name) => addEmployee(t, name, { weekly: WEEKDAYS_10_19 }))];
    const start = at('2025-09-15T00:00:00+03:00');
    const DAY = 86_400_000;
    const now = Date.now();
    const clientRows = Array.from({ length: 700 }, (_, i) => ({
      name: `Клиент ${i}`, nameSort: `клиент ${i}`, source: ['instagram', 'telegram', null][i % 3] ?? null, createdAt: start, updatedAt: now,
    }));
    const statuses = ['completed', 'completed', 'completed', 'cancelled', 'no_show', 'scheduled'];
    t.ctx.db.transaction((tx) => {
      for (let i = 0; i < clientRows.length; i += 100) tx.insert(clients).values(clientRows.slice(i, i + 100)).run();
      const visits = Array.from({ length: 1900 }, (_, i) => {
        const startsAt = start + (i % 400) * DAY + (10 + (i % 8)) * 3_600_000;
        return {
          clientId: (i * 7) % 700 + 1, masterId: masters[i % masters.length]!, startsAt, endsAt: startsAt + 3_600_000,
          status: statuses[i % statuses.length]!, price: 3000, channel: ['app', 'bot', 'web'][i % 3]!, createdAt: startsAt - DAY, updatedAt: now,
        };
      });
      for (let i = 0; i < visits.length; i += 100) tx.insert(appointments).values(visits.slice(i, i + 100)).run();
      const receipts = Array.from({ length: 1600 }, (_, i) => ({
        number: 100_000 + i, clientId: i % 5 === 0 ? null : (i * 11) % 700 + 1, employeeId: 1, subtotal: 2500, total: 2500, payCash: 2500,
        status: i % 25 === 0 ? 'refunded' : 'completed', createdAt: start + (i % 400) * DAY + 15 * 3_600_000,
      }));
      for (let i = 0; i < receipts.length; i += 100) tx.insert(sales).values(receipts.slice(i, i + 100)).run();
    });

    const began = performance.now();
    const r = await growth({ from: '2025-09-15T00:00:00+03:00', to: '2026-10-19T00:00:00+03:00' });
    const elapsed = performance.now() - began;
    expect(r.load).toHaveLength(5);
    expect(r.value.clientsWithVisits).toBeGreaterThan(500);
    expect(r.retention.cohorts).toHaveLength(12);
    expect(elapsed).toBeLessThan(1500);
  });
});
