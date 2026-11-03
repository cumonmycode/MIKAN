import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rescheduleForClient } from '../src/bot/client-appointments.js';
import { buildClientToolHandlers } from '../src/bot/client-tools.js';
import { emptySink } from '../src/bot/tools.js';
import { morningDigest } from '../src/bot/digest.js';
import { employees } from '../src/db/schema.js';
import { freeSlots } from '../src/domain/free-slots.js';
import { createTestApp, make, type TestApp } from './helpers.js';

/** Monday 19 October 2026, 09:00 in Moscow (UTC+3). */
const NOW = Date.parse('2026-10-19T06:00:00Z');
const msk = (local: string) => new Date(Date.parse(`${local}+03:00`)).toISOString();
const hhmm = (ms: number) => new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' }).format(ms);
const hours = (start: string, end: string, breaks: Array<[string, string]> = []) => ({
  start,
  end,
  breaks: breaks.map(([s, e]) => ({ start: s, end: e })),
});
/** Mon, Wed, Thu 12:00–21:00 with a break 15:00–15:30, Sat 11:00–20:00; Tue, Fri, Sun off. */
const FATIMA_WEEK = [
  hours('12:00', '21:00', [['15:00', '15:30']]),
  null,
  hours('12:00', '21:00', [['15:00', '15:30']]),
  hours('12:00', '21:00', [['15:00', '15:30']]),
  null,
  hours('11:00', '20:00'),
  null,
];

describe('work schedules: effects', () => {
  let t: TestApp;
  let fatima: { id: number };
  let client: { id: number };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    t = await createTestApp();
    fatima = await make(t, '/api/employees', { name: 'Фатима', login: 'fatima', password: 'secret123', isMaster: true });
    client = await make(t, '/api/clients', { name: 'Анна', phone: '+79990000001' });
    await t.api('PUT', `/api/employees/${fatima.id}/schedule`, { weekly: FATIMA_WEEK });
  });
  afterEach(async () => {
    await t.close();
    vi.useRealTimers();
  });

  const book = (startsAt: string, endsAt: string, extra: object = {}) =>
    t.api('POST', '/api/appointments', { clientId: client.id, masterId: fatima.id, startsAt: msk(startsAt), endsAt: msk(endsAt), ...extra });
  const conflictOf = async (res: Awaited<ReturnType<typeof book>>) => {
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('schedule_conflict');
    return res.json().error.message as string;
  };

  describe('appointments', () => {
    it('refuses a day off, a break and time outside the hours unless forced', async () => {
      expect(await conflictOf(await book('2026-10-23T13:00:00', '2026-10-23T14:00:00'))).toBe('Фатима не работает 23 октября');
      expect(await conflictOf(await book('2026-10-21T14:30:00', '2026-10-21T15:15:00'))).toBe('У Фатимы перерыв 15:00–15:30');
      expect(await conflictOf(await book('2026-10-21T11:00:00', '2026-10-21T12:30:00'))).toBe('Фатима работает 21 октября с 12:00 до 21:00');
      expect(await conflictOf(await book('2026-10-21T20:30:00', '2026-10-21T21:30:00'))).toBe('Фатима работает 21 октября с 12:00 до 21:00');
      expect((await book('2026-10-21T14:00:00', '2026-10-21T15:00:00')).statusCode).toBe(200);
      expect((await book('2026-10-21T15:30:00', '2026-10-21T21:00:00')).statusCode).toBe(200);
      expect((await book('2026-10-23T13:00:00', '2026-10-23T14:00:00', { force: true })).statusCode).toBe(200);
      // Cancelled visits block nothing, so they are not checked either.
      expect((await book('2026-10-20T13:00:00', '2026-10-20T14:00:00', { status: 'cancelled' })).statusCode).toBe(200);
    });

    it('an exception wins over the weekly schedule', async () => {
      await t.api('PUT', `/api/employees/${fatima.id}/schedule/days`, { from: '2026-10-21', off: true, note: 'Отпуск' });
      await t.api('PUT', `/api/employees/${fatima.id}/schedule/days`, { from: '2026-10-23', off: false, start: '10:00', end: '14:00' });
      expect(await conflictOf(await book('2026-10-21T13:00:00', '2026-10-21T14:00:00'))).toBe('Фатима не работает 21 октября');
      expect((await book('2026-10-23T10:00:00', '2026-10-23T11:00:00')).statusCode).toBe(200);
    });

    it('checks moves and a change of master, not status changes or edits that keep the time', async () => {
      const visit = (await book('2026-10-21T13:00:00', '2026-10-21T14:00:00')).json();
      const moved = await t.api('PATCH', `/api/appointments/${visit.id}`, { startsAt: msk('2026-10-20T13:00:00') });
      expect(await conflictOf(moved)).toBe('Фатима не работает 20 октября');
      const forced = await t.api('PATCH', `/api/appointments/${visit.id}`, { startsAt: msk('2026-10-20T13:00:00'), force: true });
      expect(forced.statusCode).toBe(200);
      // Now outside her schedule: notes and status still change freely.
      expect((await t.api('PATCH', `/api/appointments/${visit.id}`, { notes: 'Принесёт эскиз' })).statusCode).toBe(200);
      expect((await t.api('PATCH', `/api/appointments/${visit.id}`, { status: 'confirmed' })).statusCode).toBe(200);
      expect((await t.api('PATCH', `/api/appointments/${visit.id}`, { status: 'cancelled' })).statusCode).toBe(200);
      expect((await t.api('PATCH', `/api/appointments/${visit.id}`, { status: 'scheduled' })).statusCode).toBe(200);

      // Giving the admin's visit to Fatima on her day off is a move too.
      const other = await make(t, '/api/appointments', {
        clientId: client.id, masterId: 1, startsAt: msk('2026-10-25T13:00:00'), endsAt: msk('2026-10-25T14:00:00'),
      });
      const handed = await t.api('PATCH', `/api/appointments/${other.id}`, { masterId: fatima.id });
      expect(await conflictOf(handed)).toBe('Фатима не работает 25 октября');
    });

    it('employees without an own schedule may be booked at any time', async () => {
      const res = await t.api('POST', '/api/appointments', {
        clientId: client.id, masterId: 1, startsAt: msk('2026-10-20T07:00:00'), endsAt: msk('2026-10-20T08:00:00'),
      });
      expect(res.statusCode).toBe(200);
    });

    it('a name that cannot be declined safely is named as is', async () => {
      t.ctx.db.update(employees).set({ name: 'Анна Иванова' }).where(eq(employees.id, fatima.id)).run();
      expect(await conflictOf(await book('2026-10-21T14:30:00', '2026-10-21T15:15:00'))).toBe('Анна Иванова: перерыв 15:00–15:30');
    });
  });

  describe('bot', () => {
    it('offers only the working time of the master and leaves out masters who are off', () => {
      const wednesday = freeSlots(t.ctx.db, { date: '2026-10-21', durationMin: 60, masterId: fatima.id });
      expect(wednesday).toHaveLength(1);
      expect(wednesday[0]!.off).toBe(false);
      expect(wednesday[0]!.starts.map(hhmm)).toEqual([
        '12:00', '12:30', '13:00', '13:30', '14:00',
        '15:30', '16:00', '16:30', '17:00', '17:30', '18:00', '18:30', '19:00', '19:30', '20:00',
      ]);
      // Friday: Fatima is off — not offered with every master, marked off when asked for her.
      const friday = freeSlots(t.ctx.db, { date: '2026-10-23', durationMin: 60 });
      expect(friday.map((m) => m.master.name)).toEqual(['Админ']);
      expect(friday[0]!.starts).toHaveLength(19); // the admin keeps the studio hours 11:00–21:00
      expect(freeSlots(t.ctx.db, { date: '2026-10-23', durationMin: 60, masterId: fatima.id })).toEqual([
        expect.objectContaining({ off: true, starts: [] }),
      ]);
    });

    it('free_slots tells the model which master does not work that day', async () => {
      const scope = { mode: 'test' as const, chatId: null, clientId: null, telegramName: null, username: null, lastUserText: '' };
      const tools = buildClientToolHandlers(t.ctx, scope, emptySink());
      const result = await tools.free_slots!({ date: '2026-10-23', masterId: fatima.id });
      expect(result.content).toContain(`• Фатима [id ${fatima.id}]: не работает в этот день`);
    });

    it('rescheduling through the bot keeps to the working time of the master', async () => {
      const visit = (await book('2026-10-21T13:00:00', '2026-10-21T14:00:00')).json();
      const reschedule = (local: string) =>
        rescheduleForClient(t.ctx, { clientId: client.id, appointmentId: visit.id, startsAt: Date.parse(msk(local)) });
      const intoBreak = await reschedule('2026-10-22T14:30:00');
      expect(intoBreak).toEqual({ ok: false, text: 'Это время вне часов работы мастера. Возьми время из free_slots.' });
      expect((await reschedule('2026-10-23T13:00:00')).ok).toBe(false); // her day off
      const fine = await reschedule('2026-10-22T16:00:00');
      expect(fine.ok).toBe(true);
    });
  });

  describe('morning digest', () => {
    const admin = () => t.ctx.db.select().from(employees).where(eq(employees.id, 1)).get()!;

    it('lists who works today with hours when any master has a schedule', async () => {
      expect(morningDigest(t.ctx.db, NOW, admin())).toContain('👥 Сегодня работают: Админ 11:00–21:00, Фатима 12:00–21:00');
      // Tuesday: Fatima is off.
      expect(morningDigest(t.ctx.db, NOW + 24 * 3_600_000, admin())).toContain('👥 Сегодня работают: Админ 11:00–21:00');
      await t.api('PUT', '/api/employees/1/schedule/days', { from: '2026-10-20', off: true });
      expect(morningDigest(t.ctx.db, NOW + 24 * 3_600_000, admin())).toContain('👥 Сегодня никто из мастеров не работает');
    });

    it('stays as before when nobody has an own schedule', async () => {
      await t.api('PUT', `/api/employees/${fatima.id}/schedule`, { weekly: null });
      expect(morningDigest(t.ctx.db, NOW, admin())).not.toContain('Сегодня работают');
    });
  });
});
