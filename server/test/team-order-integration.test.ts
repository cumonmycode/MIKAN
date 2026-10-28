import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, make, type TestApp } from './helpers.js';

/**
 * «Порядок в команде» built by separate pieces (roles, audit log, work schedules, payroll, drag to reschedule):
 * how they work together once merged.
 */

const NOW = Date.parse('2026-10-19T07:00:00.000Z'); // Monday 10:00 Moscow
const msk = (iso: string) => new Date(Date.parse(`${iso}+03:00`)).toISOString();

interface Entry {
  entity: string;
  entityId: number | null;
  summary: string;
  employee: { id: number } | null;
}

describe('team order: the pieces together', () => {
  let t: TestApp;
  let fatima: { id: number };
  let fatimaToken: string;
  let client: { id: number };
  let service: { id: number };

  const audit = async (query: string): Promise<Entry[]> => {
    const res = await t.api('GET', `/api/audit${query}`);
    expect(res.statusCode).toBe(200);
    return res.json().items as Entry[];
  };
  const asFatima = (method: 'GET' | 'PUT' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    t.app.inject({ method, url, headers: { authorization: `Bearer ${fatimaToken}` }, ...(payload ? { payload } : {}) });

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    t = await createTestApp();
    fatima = await make(t, '/api/employees', {
      name: 'Фатима',
      login: 'fatima',
      password: 'secret123',
      color: '#FF00AA',
      isMaster: true,
    });
    const login = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { login: 'fatima', password: 'secret123' },
    });
    fatimaToken = login.json().token;
    client = await make(t, '/api/clients', { name: 'Анна', phone: '+79990000001' });
    service = await make(t, '/api/services', { name: 'Мочка', category: 'piercing', price: 1600, durationMin: 30 });
  });
  afterEach(async () => {
    await t.close();
    vi.useRealTimers();
  });

  it('a new master gets the master role', async () => {
    const res = await asFatima('GET', '/api/auth/me');
    expect(res.json().role).toBe('master');
  });

  it('logs schedule changes with their own summaries', async () => {
    const weekly = [{ start: '11:00', end: '20:00', breaks: [] }, null, null, null, null, null, null];
    expect((await t.api('PUT', `/api/employees/${fatima.id}/schedule`, { weekly })).statusCode).toBe(200);
    const days = { from: '2026-10-26', to: '2026-10-30', off: true, note: 'Отпуск' };
    expect((await t.api('PUT', `/api/employees/${fatima.id}/schedule/days`, days)).statusCode).toBe(200);

    const entries = await audit(`?entity=schedule&entityId=${fatima.id}`);
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry.summary).not.toMatch(/^Изменение:/);
      expect(entry.employee?.id).toBe(1);
    }
  });

  it('logs pay rules and adjustments with their own summaries', async () => {
    const rules = { effectiveFrom: '2026-10-01', servicePercent: 40, productPercent: 10 };
    expect((await t.api('PUT', `/api/employees/${fatima.id}/pay-rules`, rules)).statusCode).toBe(200);
    const adjustment = { employeeId: fatima.id, kind: 'bonus', amount: 5000, note: 'Премия' };
    expect((await t.api('POST', '/api/payroll/adjustments', adjustment)).statusCode).toBe(200);

    const entries = await audit('?entity=payroll');
    expect(entries).toHaveLength(2);
    for (const entry of entries) expect(entry.summary).not.toMatch(/^Изменение:/);
  });

  it('keeps the new sections to the right roles', async () => {
    const weekly = [null, null, null, null, null, null, null];
    expect((await asFatima('PUT', `/api/employees/${fatima.id}/schedule`, { weekly })).statusCode).toBe(403);
    expect((await asFatima('GET', `/api/employees/${fatima.id}/schedule`)).statusCode).toBe(200);
    expect((await asFatima('PUT', `/api/employees/${fatima.id}/pay-rules`, { servicePercent: 90 })).statusCode).toBe(403);
    expect((await asFatima('GET', `/api/employees/${fatima.id}/pay-rules`)).statusCode).toBe(200);
    expect((await asFatima('GET', '/api/employees/1/pay-rules')).statusCode).toBe(403);
    expect((await asFatima('GET', '/api/audit')).statusCode).toBe(403);
    const own = await asFatima('GET', '/api/payroll?from=2026-10-01&to=2026-10-31');
    expect(own.statusCode).toBe(200);
    expect(own.json().items.map((s: { employee: { id: number } }) => s.employee.id)).toEqual([fatima.id]);
  });

  it('a master drags only their own appointment, and the schedule still applies', async () => {
    const weekly = [{ start: '11:00', end: '20:00', breaks: [{ start: '14:00', end: '14:30' }] }, null, null, null, null, null, null];
    await t.api('PUT', `/api/employees/${fatima.id}/schedule`, { weekly });
    const own = await make(t, '/api/appointments', {
      clientId: client.id,
      masterId: fatima.id,
      services: [{ serviceId: service.id }],
      startsAt: msk('2026-10-26T12:00:00'),
    });
    const others = await make(t, '/api/appointments', {
      clientId: client.id,
      masterId: 1,
      services: [{ serviceId: service.id }],
      startsAt: msk('2026-10-26T12:00:00'),
      force: true,
    });

    const intoBreak = { startsAt: msk('2026-10-26T14:00:00'), endsAt: msk('2026-10-26T14:30:00'), notifyClient: true };
    const conflict = await asFatima('PATCH', `/api/appointments/${own.id}`, intoBreak);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('schedule_conflict');
    expect((await asFatima('PATCH', `/api/appointments/${own.id}`, { ...intoBreak, force: true })).statusCode).toBe(200);

    const moveOthers = { startsAt: msk('2026-10-26T15:00:00'), endsAt: msk('2026-10-26T15:30:00') };
    expect((await asFatima('PATCH', `/api/appointments/${others.id}`, moveOthers)).statusCode).toBe(403);

    const moves = await audit(`?entity=appointment&entityId=${own.id}`);
    expect(moves.some((e) => e.employee?.id === fatima.id && /перенесена/.test(e.summary))).toBe(true);
  });
});
