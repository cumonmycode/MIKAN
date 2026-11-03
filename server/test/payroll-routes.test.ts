import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, type TestApp } from './helpers.js';
import { at, ok, setRules, staff, statement, type Staff } from './payroll-fixtures.js';

const FORBIDDEN = 'Это доступно владельцу студии';
const OWNER_ID = 1;

describe('payroll endpoints', () => {
  let t: TestApp;
  let fatima: Staff;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // 01:30 on 21 Oct in Moscow, still 20 Oct in UTC.
    at('2026-10-20T22:30:00.000Z');
    t = await createTestApp();
    fatima = await staff(t, 'Фатима', 'fatima', 'master');
  });
  afterEach(async () => {
    await t.close();
    vi.useRealTimers();
  });

  describe('pay rules', () => {
    it('starts empty, fills defaults, versions by date and replaces the same date', async () => {
      expect(await ok(t.api, 'GET', `/api/employees/${fatima.id}/pay-rules`)).toEqual({ current: null, history: [] });

      const saved = await setRules(t, fatima.id, { servicePercent: 40, categoryPercent: { tattoo: 50 } });
      const rules = {
        salaryMonthly: 0, perDay: 0, servicePercent: 40, categoryPercent: { tattoo: 50, piercing: null, other: null },
        productPercent: 0, deductMaterials: false,
      };
      expect(saved).toEqual({
        current: rules,
        history: [{ effectiveFrom: '2026-10-21', rules, createdBy: { id: OWNER_ID, name: 'Админ', color: expect.any(String) }, createdAt: '2026-10-20T22:30:00.000Z' }],
      });

      // A future version is history, not current yet.
      const future = await setRules(t, fatima.id, { effectiveFrom: '2026-11-01', servicePercent: 50, deductMaterials: true });
      expect(future.current.servicePercent).toBe(40);
      expect(future.history.map((v: { effectiveFrom: string }) => v.effectiveFrom)).toEqual(['2026-11-01', '2026-10-21']);

      const replaced = await setRules(t, fatima.id, { effectiveFrom: '2026-10-21', servicePercent: 45, perDay: 1500 });
      expect(replaced.current).toMatchObject({ servicePercent: 45, perDay: 1500, categoryPercent: { tattoo: null } });
      expect(replaced.history).toHaveLength(2);
      expect(await ok(t.api, 'GET', `/api/employees/${fatima.id}/pay-rules`)).toEqual(replaced);
    });

    it('rejects invalid rules and unknown employees', async () => {
      const put = (body: object, id = fatima.id) => t.api('PUT', `/api/employees/${id}/pay-rules`, body);
      for (const body of [
        { servicePercent: 101 },
        { productPercent: -1 },
        { perDay: -100 },
        { salaryMonthly: 10.5 },
        { categoryPercent: { tattoo: 150 } },
        { effectiveFrom: '2026-13-01' },
      ]) {
        const res = await put(body);
        expect(res.statusCode, JSON.stringify(body)).toBe(400);
        expect(res.json().error.code).toBe('validation_error');
      }
      expect((await put({ servicePercent: 101 })).json().error.message).toContain('Процент с услуг');
      expect((await put({ servicePercent: 10 }, 999)).statusCode).toBe(404);
      expect((await t.api('GET', '/api/employees/999/pay-rules')).statusCode).toBe(404);
    });
  });

  describe('adjustments', () => {
    const adjust = (body: object, key?: string) =>
      t.app.inject({
        method: 'POST',
        url: '/api/payroll/adjustments',
        headers: { authorization: `Bearer ${t.token}`, ...(key ? { 'idempotency-key': key } : {}) },
        payload: body,
      });

    it('records bonuses, penalties, advances and payouts, and pays from the till', async () => {
      const bonus = (await adjust({ employeeId: fatima.id, date: '2026-10-10', kind: 'bonus', amount: 5000, note: 'За отзывы' })).json();
      expect(bonus).toEqual({
        id: expect.any(Number), employee: { id: fatima.id, name: 'Фатима', color: expect.any(String) }, date: '2026-10-10',
        kind: 'bonus', amount: 5000, note: 'За отзывы', cashOperationId: null,
        createdBy: { id: OWNER_ID, name: 'Админ', color: expect.any(String) }, createdAt: '2026-10-20T22:30:00.000Z',
      });
      await ok(t.api, 'POST', '/api/payroll/adjustments', { employeeId: fatima.id, date: '2026-10-11', kind: 'penalty', amount: 1000 });
      // No date: today in the studio (21 Oct in Moscow).
      const payout = await ok(t.api, 'POST', '/api/payroll/adjustments', { employeeId: fatima.id, kind: 'payout', amount: 3000 });
      expect(payout.date).toBe('2026-10-21');
      // Outside the period.
      await ok(t.api, 'POST', '/api/payroll/adjustments', { employeeId: fatima.id, date: '2026-11-01', kind: 'bonus', amount: 700 });

      // From the till: needs an open shift, then withdraws the cash once per key.
      const noShift = await adjust({ employeeId: fatima.id, date: '2026-10-15', kind: 'advance', amount: 20000, fromCash: true });
      expect(noShift.statusCode).toBe(409);
      await ok(t.api, 'POST', '/api/cash/shift/open', { openingCash: 30000 });
      const key = randomUUID();
      const body = { employeeId: fatima.id, date: '2026-10-15', kind: 'advance', amount: 20000, fromCash: true };
      const first = await adjust(body, key);
      const replay = await adjust(body, key);
      expect(first.statusCode).toBe(200);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.json()).toEqual(first.json());
      const advance = first.json();
      expect(advance.cashOperationId).toEqual(expect.any(Number));
      await ok(t.api, 'POST', '/api/payroll/adjustments', { employeeId: fatima.id, date: '2026-10-16', kind: 'payout', amount: 1000, fromCash: true });
      const shift = (await ok(t.api, 'GET', '/api/cash/shift/current')).shift;
      expect(shift.operations.map((o: { type: string; amount: number; reason: string }) => [o.type, o.amount, o.reason])).toEqual([
        ['out', 20000, 'Аванс: Фатима'],
        ['out', 1000, 'Выплата: Фатима'],
      ]);
      expect(shift.operations[0].id).toBe(advance.cashOperationId);
      expect(shift.expectedCash).toBe(9000);

      const s = await statement(t.api, fatima.id, '2026-10-01', '2026-10-31');
      expect(s).toMatchObject({
        adjustments: { bonus: 5000, penalty: 1000, advance: 20000, payout: 4000 },
        earned: 4000,
        paid: 24000,
        due: -20000,
      });
      expect(s.adjustmentItems.map((a: { date: string; kind: string }) => [a.date, a.kind])).toEqual([
        ['2026-10-10', 'bonus'],
        ['2026-10-11', 'penalty'],
        ['2026-10-15', 'advance'],
        ['2026-10-16', 'payout'],
        ['2026-10-21', 'payout'],
      ]);

      // Deleting keeps the cash withdrawal (corrected in the till).
      expect((await t.api('DELETE', `/api/payroll/adjustments/${advance.id}`)).statusCode).toBe(204);
      expect((await t.api('DELETE', `/api/payroll/adjustments/${advance.id}`)).statusCode).toBe(404);
      expect((await statement(t.api, fatima.id, '2026-10-01', '2026-10-31')).adjustments.advance).toBe(0);
      expect((await ok(t.api, 'GET', '/api/cash/shift/current')).shift.operations).toHaveLength(2);
    });

    it('rejects invalid adjustments', async () => {
      const cases: Array<[object, number]> = [
        [{ employeeId: fatima.id, kind: 'bonus', amount: 0 }, 400],
        [{ employeeId: fatima.id, kind: 'gift', amount: 100 }, 400],
        [{ employeeId: fatima.id, kind: 'bonus', amount: 100, date: '21.10.2026' }, 400],
        [{ employeeId: fatima.id, kind: 'bonus', amount: 100, fromCash: true }, 400],
        [{ employeeId: 999, kind: 'bonus', amount: 100 }, 404],
      ];
      for (const [body, status] of cases) expect((await adjust(body)).statusCode, JSON.stringify(body)).toBe(status);
      expect((await adjust({ employeeId: fatima.id, kind: 'penalty', amount: 100, fromCash: true })).json().error.message).toBe(
        'Из кассы можно выдать только аванс или выплату',
      );
    });
  });

  describe('access', () => {
    let alina: Staff;
    beforeEach(async () => {
      alina = await staff(t, 'Алина', 'alina', 'admin');
      await setRules(t, fatima.id, { effectiveFrom: '2026-10-01', perDay: 1000 });
    });

    const forbidden = async (res: Awaited<ReturnType<TestApp['api']>>) => {
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toEqual({ code: 'forbidden', message: FORBIDDEN });
    };

    it('lets anyone read only their own statement and rules', async () => {
      for (const who of [fatima, alina]) {
        const list = await ok(who.api, 'GET', '/api/payroll?from=2026-10-01&to=2026-10-31');
        expect(list.items.map((s: { employee: { id: number } }) => s.employee.id)).toEqual([who.id]);
        expect((await statement(who.api, who.id, '2026-10-01', '2026-10-31')).employee.id).toBe(who.id);
        await ok(who.api, 'GET', `/api/employees/${who.id}/pay-rules`);
        const other = who === fatima ? alina : fatima;
        await forbidden(await who.api('GET', `/api/payroll/${other.id}?from=2026-10-01&to=2026-10-31`));
        await forbidden(await who.api('GET', `/api/employees/${other.id}/pay-rules`));
        await forbidden(await who.api('GET', `/api/payroll/${OWNER_ID}?from=2026-10-01&to=2026-10-31`));
      }
    });

    it('leaves rules and adjustments to the owner', async () => {
      const adjustment = await ok(t.api, 'POST', '/api/payroll/adjustments', { employeeId: fatima.id, kind: 'bonus', amount: 100 });
      for (const who of [fatima, alina]) {
        await forbidden(await who.api('PUT', `/api/employees/${who.id}/pay-rules`, { perDay: 5000 }));
        await forbidden(await who.api('POST', '/api/payroll/adjustments', { employeeId: who.id, kind: 'bonus', amount: 100 }));
        await forbidden(await who.api('DELETE', `/api/payroll/adjustments/${adjustment.id}`));
      }
      expect((await t.api('GET', `/api/payroll/999?from=2026-10-01&to=2026-10-31`)).statusCode).toBe(404);
    });
  });

  describe('period', () => {
    it('needs a valid period of at most 400 days', async () => {
      const get = (query: string) => t.api('GET', `/api/payroll${query}`);
      expect((await get('?from=2026-10-01')).statusCode).toBe(400);
      expect((await get('?from=2026-10-01&to=2026-10-32')).statusCode).toBe(400);
      const reversed = await get('?from=2026-10-31&to=2026-10-01');
      expect(reversed.statusCode).toBe(400);
      expect(reversed.json().error.message).toBe('Конец периода должен быть не раньше начала');
      const long = await get('?from=2025-09-01&to=2026-10-06');
      expect(long.statusCode).toBe(400);
      expect(long.json().error.message).toBe('Период — не больше 400 дней');
      expect((await get('?from=2025-09-01&to=2026-10-05')).statusCode).toBe(200);
      expect((await t.api('GET', `/api/payroll/${fatima.id}?from=2026-10-01`)).statusCode).toBe(400);
    });
  });
});
