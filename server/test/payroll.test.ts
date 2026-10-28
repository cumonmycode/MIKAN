import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { splitByWeight } from '../src/domain/payroll.js';
import { createTestApp, make, openShift, type TestApp } from './helpers.js';
import { at, ok, pay, setRules, staff, statement, visit, type Staff } from './payroll-fixtures.js';

// The studio is in Moscow (UTC+3); the test process runs in Asia/Tomsk (UTC+7, see vitest.config.ts).

describe('splitByWeight', () => {
  it('splits proportionally in whole rubles with the remainder on the last share', () => {
    expect(splitByWeight(100, [5000, 3000])).toEqual([63, 37]);
    expect(splitByWeight(100, [0, 0])).toEqual([0, 100]);
    expect(splitByWeight(0, [1, 2])).toEqual([0, 0]);
    expect(splitByWeight(10, [])).toEqual([]);
    // Shares rounded up never take more than is left, so the last one never goes negative.
    expect(splitByWeight(2, [1, 1, 1, 1])).toEqual([1, 1, 0, 0]);
  });
});

describe('payroll statement', () => {
  let t: TestApp;
  let fatima: Staff;
  let clientId: number;
  let helix: { id: number };
  let tattoo: { id: number };
  let labret: { id: number };
  let ring: { id: number };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026-09-20T06:00:00.000Z');
    t = await createTestApp();
    await openShift(t);
    fatima = await staff(t, 'Фатима', 'fatima', 'master');
    clientId = (await make(t, '/api/clients', { name: 'Иван', phone: '+79990000101' })).id;
    labret = await make(t, '/api/products', { kind: 'jewelry', name: 'Лабрет', price: 1000, initialQuantity: 10 });
    ring = await make(t, '/api/products', { kind: 'jewelry', name: 'Кольцо', price: 2000, initialQuantity: 10 });
    // Two needles per tattoo at 50 ₽ each: 100 ₽ of materials per visit.
    const needles = await make(t, '/api/products', { kind: 'consumable', name: 'Игла', price: 0, cost: 50, initialQuantity: 100 });
    helix = await make(t, '/api/services', { name: 'Прокол хеликса', category: 'piercing', price: 3000, durationMin: 30 });
    tattoo = await make(t, '/api/services', {
      name: 'Тату мини', category: 'tattoo', price: 5000, durationMin: 60, consumables: [{ productId: needles.id, quantity: 2 }],
    });
  });
  afterEach(async () => {
    await t.close();
    vi.useRealTimers();
  });

  it('splits the discount, applies category percents and materials, skips refunds and attributes products', async () => {
    await setRules(t, fatima.id, {
      effectiveFrom: '2026-10-01', servicePercent: 40, categoryPercent: { tattoo: 50 }, productPercent: 10, deductMaterials: true, perDay: 1000,
    });
    // 5 Oct: a piercing with jewelry, 400 ₽ off a 4 000 ₽ receipt rung up by the owner → 2 700 + 900.
    const first = await visit(t, fatima.id, clientId, [helix.id], '2026-10-05T08:00:00Z');
    at('2026-10-05T09:00:00Z');
    const firstSale = await pay(t.api, [{ type: 'service', serviceId: helix.id }, { type: 'product', productId: labret.id }], 3600, {
      appointmentId: first.id, discount: 400,
    });
    // 6 Oct: a tattoo; paying it completes the visit and writes off two needles.
    const second = await visit(t, fatima.id, clientId, [tattoo.id], '2026-10-06T08:00:00Z');
    at('2026-10-06T09:00:00Z');
    const secondSale = await pay(t.api, [{ type: 'service', serviceId: tattoo.id }], 5000, { appointmentId: second.id });
    // 7 Oct: a piercing paid and refunded — still a visit, no pay.
    const third = await visit(t, fatima.id, clientId, [helix.id], '2026-10-07T08:00:00Z');
    at('2026-10-07T09:00:00Z');
    const refunded = await pay(t.api, [{ type: 'service', serviceId: helix.id }], 3000, { appointmentId: third.id });
    await ok(t.api, 'POST', `/api/sales/${refunded.id}/refund`, { reason: 'Передумал', restock: false });
    // 8 Oct: Fatima sells a ring herself; the owner sells a labret to a walk-in.
    at('2026-10-08T10:00:00Z');
    const ownSale = await pay(fatima.api, [{ type: 'product', productId: ring.id }], 2000);
    at('2026-10-08T11:00:00Z');
    await pay(t.api, [{ type: 'product', productId: labret.id }], 1000);

    const s = await statement(t.api, fatima.id, '2026-10-01', '2026-10-31');
    expect(s).toMatchObject({
      employee: { id: fatima.id, name: 'Фатима' },
      from: '2026-10-01',
      to: '2026-10-31',
      services: { visits: 3, revenue: 7700, materials: 100, amount: 1080 + 2450 },
      products: { revenue: 2900, amount: 290 },
      salary: 0,
      days: 4,
      perDay: 4000,
      adjustments: { bonus: 0, penalty: 0, advance: 0, payout: 0 },
      earned: 3530 + 290 + 4000,
      paid: 0,
      due: 7820,
      adjustmentItems: [],
    });
    expect(s.lines).toEqual([
      { date: '2026-10-05', kind: 'service', appointmentId: first.id, saleId: firstSale.id, name: 'Прокол хеликса', category: 'piercing', revenue: 2700, materials: 0, percent: 40, amount: 1080 },
      { date: '2026-10-05', kind: 'product', appointmentId: first.id, saleId: firstSale.id, name: 'Лабрет', category: null, revenue: 900, materials: 0, percent: 10, amount: 90 },
      { date: '2026-10-06', kind: 'service', appointmentId: second.id, saleId: secondSale.id, name: 'Тату мини', category: 'tattoo', revenue: 5000, materials: 100, percent: 50, amount: 2450 },
      { date: '2026-10-08', kind: 'product', appointmentId: null, saleId: ownSale.id, name: 'Кольцо', category: null, revenue: 2000, materials: 0, percent: 10, amount: 200 },
    ]);

    // The owner gets the walk-in labret (no rules: revenue shown, nothing earned).
    const owner = await statement(t.api, 1, '2026-10-01', '2026-10-31');
    expect(owner.products).toEqual({ revenue: 1000, amount: 0 });
    expect(owner.services.visits).toBe(0);
  });

  it('never lets materials take a visit below zero and splits them across its services', async () => {
    await setRules(t, fatima.id, { effectiveFrom: '2026-10-01', servicePercent: 50, deductMaterials: true });
    const consult = await make(t, '/api/services', {
      name: 'Консультация', category: 'tattoo', price: 50, durationMin: 15,
      consumables: [{ productId: (await make(t, '/api/products', { kind: 'consumable', name: 'Плёнка', price: 0, cost: 150, initialQuantity: 10 })).id, quantity: 1 }],
    });
    const cheap = await visit(t, fatima.id, clientId, [consult.id], '2026-10-05T08:00:00Z');
    at('2026-10-05T09:00:00Z');
    await pay(t.api, [{ type: 'service', serviceId: consult.id }], 50, { appointmentId: cheap.id });
    // A tattoo and a piercing in one visit: 100 ₽ of needles split 5 000 : 3 000 → 63 + 37 (rounded, the rest to the last).
    const both = await visit(t, fatima.id, clientId, [tattoo.id, helix.id], '2026-10-06T08:00:00Z');
    at('2026-10-06T10:00:00Z');
    await pay(t.api, [{ type: 'service', serviceId: tattoo.id }, { type: 'service', serviceId: helix.id }], 8000, { appointmentId: both.id });

    const s = await statement(t.api, fatima.id, '2026-10-01', '2026-10-31');
    expect(s.lines.map((l: { revenue: number; materials: number; amount: number }) => [l.revenue, l.materials, l.amount])).toEqual([
      [50, 150, 0],
      [5000, 63, Math.round((5000 - 63) / 2)],
      [3000, 37, Math.round((3000 - 37) / 2)],
    ]);
    expect(s.services).toEqual({ visits: 2, revenue: 8050, materials: 250, amount: 2469 + 1482 });
  });

  it('counts every visit, sale and day by the version in force that day', async () => {
    await setRules(t, fatima.id, { effectiveFrom: '2026-10-01', servicePercent: 40, productPercent: 5, perDay: 1000, deductMaterials: true });
    await setRules(t, fatima.id, { effectiveFrom: '2026-10-16', servicePercent: 50, productPercent: 10, perDay: 2000, deductMaterials: false });
    // Before the first version: shown, earns nothing.
    const early = await visit(t, fatima.id, clientId, [tattoo.id], '2026-09-28T08:00:00Z');
    at('2026-09-28T09:00:00Z');
    await pay(t.api, [{ type: 'service', serviceId: tattoo.id }], 5000, { appointmentId: early.id });
    const october = await visit(t, fatima.id, clientId, [tattoo.id], '2026-10-10T08:00:00Z');
    at('2026-10-10T09:00:00Z');
    await pay(t.api, [{ type: 'service', serviceId: tattoo.id }, { type: 'product', productId: labret.id }], 6000, { appointmentId: october.id });
    const late = await visit(t, fatima.id, clientId, [tattoo.id], '2026-10-20T08:00:00Z');
    at('2026-10-20T09:00:00Z');
    await pay(t.api, [{ type: 'service', serviceId: tattoo.id }, { type: 'product', productId: ring.id }], 7000, { appointmentId: late.id });

    const s = await statement(t.api, fatima.id, '2026-09-25', '2026-10-31');
    expect(s.lines.map((l: { date: string; kind: string; materials: number; percent: number; amount: number }) => [l.date, l.kind, l.materials, l.percent, l.amount])).toEqual([
      ['2026-09-28', 'service', 0, 0, 0],
      ['2026-10-10', 'service', 100, 40, 1960],
      ['2026-10-10', 'product', 0, 5, 50],
      ['2026-10-20', 'service', 0, 50, 2500],
      ['2026-10-20', 'product', 0, 10, 200],
    ]);
    expect(s).toMatchObject({
      services: { visits: 3, revenue: 15000, materials: 100, amount: 4460 },
      products: { revenue: 3000, amount: 250 },
      days: 3,
      perDay: 0 + 1000 + 2000,
      earned: 4460 + 250 + 3000,
    });
  });

  it('prorates the monthly salary per day across versions and month lengths', async () => {
    await setRules(t, fatima.id, { effectiveFrom: '2026-10-01', salaryMonthly: 31000 });
    await setRules(t, fatima.id, { effectiveFrom: '2026-10-11', salaryMonthly: 62000 });
    const alina = await staff(t, 'Алина', 'alina', 'admin');
    await setRules(t, alina.id, { effectiveFrom: '2026-09-01', salaryMonthly: 50000 });

    const salary = async (id: number, from: string, to: string) => (await statement(t.api, id, from, to)).salary;
    expect(await salary(fatima.id, '2026-10-01', '2026-10-31')).toBe(10 * 1000 + 21 * 2000);
    expect(await salary(fatima.id, '2026-09-20', '2026-10-05')).toBe(5000);
    expect(await salary(fatima.id, '2026-10-12', '2026-10-14')).toBe(6000);
    expect(await salary(fatima.id, '2026-11-01', '2026-11-30')).toBe(62000);
    expect(await salary(alina.id, '2026-10-01', '2026-10-31')).toBe(50000);
    expect(await salary(alina.id, '2026-09-01', '2026-10-31')).toBe(100000);
    expect(await salary(alina.id, '2026-10-01', '2026-10-15')).toBe(Math.round((50000 * 15) / 31));

    const whole = await statement(t.api, alina.id, '2026-10-01', '2026-10-31');
    expect(whole).toMatchObject({ days: 0, perDay: 0, earned: 50000, due: 50000, lines: [] });
  });

  it('pays per day for days with a completed visit or a sale of their own', async () => {
    const alina = await staff(t, 'Алина', 'alina', 'admin');
    await setRules(t, alina.id, { effectiveFrom: '2026-10-01', perDay: 1500 });
    await setRules(t, fatima.id, { effectiveFrom: '2026-10-01', perDay: 1000 });
    // Alina: two receipts on 2 Oct, one on 3 Oct (refunded later — she still worked that day).
    at('2026-10-02T08:00:00Z');
    await pay(alina.api, [{ type: 'product', productId: ring.id }], 2000);
    at('2026-10-02T20:30:00Z'); // 23:30 in Moscow, still 2 Oct
    await pay(alina.api, [{ type: 'product', productId: ring.id }], 2000);
    at('2026-10-03T08:00:00Z');
    const back = await pay(alina.api, [{ type: 'product', productId: labret.id }], 1000);
    await ok(t.api, 'POST', `/api/sales/${back.id}/refund`, { reason: 'Брак', restock: true });
    // Fatima: a completed visit without a receipt (4 Oct), a cancelled one (5 Oct) and an upcoming one (6 Oct).
    await visit(t, fatima.id, clientId, [helix.id], '2026-10-04T08:00:00Z', 'completed');
    await visit(t, fatima.id, clientId, [helix.id], '2026-10-05T08:00:00Z', 'cancelled');
    await visit(t, fatima.id, clientId, [helix.id], '2026-10-06T08:00:00Z');

    expect(await statement(t.api, alina.id, '2026-10-01', '2026-10-31')).toMatchObject({ days: 2, perDay: 3000, products: { revenue: 4000 } });
    expect(await statement(t.api, fatima.id, '2026-10-01', '2026-10-31')).toMatchObject({
      days: 1, perDay: 1000, services: { visits: 1, revenue: 0, amount: 0 }, lines: [],
    });
  });

  it('lists every employee with rules or activity in the period for the owner', async () => {
    const alina = await staff(t, 'Алина', 'alina', 'admin');
    await staff(t, 'Олег', 'oleg', 'master');
    await setRules(t, fatima.id, { effectiveFrom: '2026-10-01', perDay: 1000 });
    // Alina's rules start after the period: not enough to list her.
    await setRules(t, alina.id, { effectiveFrom: '2026-12-01', perDay: 1000 });

    const list = async () => (await ok(t.api, 'GET', '/api/payroll?from=2026-10-01&to=2026-10-31'));
    const first = await list();
    expect(first).toMatchObject({ from: '2026-10-01', to: '2026-10-31' });
    expect(first.items.map((s: { employee: { name: string } }) => s.employee.name)).toEqual(['Фатима']);

    at('2026-10-02T08:00:00Z');
    await pay(alina.api, [{ type: 'product', productId: ring.id }], 2000);
    const second = await list();
    expect(second.items.map((s: { employee: { name: string } }) => s.employee.name)).toEqual(['Алина', 'Фатима']);
    expect(second.items[0]).not.toHaveProperty('lines');
  });
});
