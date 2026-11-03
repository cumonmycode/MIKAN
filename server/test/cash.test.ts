import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, make, type TestApp } from './helpers.js';

describe('cash register', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(async () => {
    await t.close();
  });

  const sell = (payments: Record<string, number>, total: number) =>
    t.api('POST', '/api/sales', { items: [{ type: 'service', name: 'Тату', price: total }], discount: 0, payments });

  it('runs a full shift: open, sales, cash in/out, refund, close with expected cash and difference', async () => {
    expect((await t.api('GET', '/api/cash/shift/current')).json()).toEqual({ shift: null });
    const noShiftOp = await t.api('POST', '/api/cash/operations', { type: 'in', amount: 100, reason: 'Размен' });
    expect(noShiftOp.statusCode).toBe(409);
    expect(noShiftOp.json().error.code).toBe('conflict');
    expect((await t.api('POST', '/api/cash/shift/close', { closingCash: 0 })).statusCode).toBe(409);

    const opened = await t.api('POST', '/api/cash/shift/open', { openingCash: 5000 });
    expect(opened.json()).toMatchObject({
      openingCash: 5000,
      openedBy: { id: 1, name: 'Админ' },
      closedAt: null,
      closedBy: null,
      closingCash: null,
      expectedCash: 5000,
      difference: null,
      operations: [],
    });
    const again = await t.api('POST', '/api/cash/shift/open', { openingCash: 1 });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.message).toMatch(/^Смена уже открыта \(с \d{2}\.\d{2}\.\d{4} \d{2}:\d{2}\)$/);

    const s1 = (await sell({ cash: 2500 }, 2500)).json();
    expect(s1.shiftId).toBe(opened.json().id);
    await sell({ card: 5000 }, 5000);
    await sell({ cash: 1000, transfer: 1500 }, 2500);
    await t.api('POST', '/api/cash/operations', { type: 'in', amount: 300, reason: 'Размен' });
    const out = await t.api('POST', '/api/cash/operations', { type: 'out', amount: 1000, reason: 'Инкассация' });
    expect(out.json()).toMatchObject({ type: 'out', amount: 1000, reason: 'Инкассация', employee: { id: 1 } });
    expect((await t.api('POST', '/api/cash/operations', { type: 'out', amount: 0, reason: 'x' })).statusCode).toBe(400);
    await t.api('POST', `/api/sales/${s1.id}/refund`, { reason: 'Отказ', restock: true });

    const current = (await t.api('GET', '/api/cash/shift/current')).json().shift;
    expect(current.summary).toEqual({
      salesCount: 3,
      revenue: 10000,
      cash: 3500,
      card: 5000,
      transfer: 1500,
      qr: 0,
      refunds: 2500,
      cashRefunds: 2500,
      cashIn: 300,
      cashOut: 1000,
      deposit: 0,
      deposits: { received: 0, cash: 0, card: 0, transfer: 0, qr: 0, refunded: 0, cashRefunded: 0, retained: 0 },
    });
    // 5000 + 3500 − 2500 + 300 − 1000
    expect(current.expectedCash).toBe(5300);
    expect(current.operations).toHaveLength(2);

    const closed = await t.api('POST', '/api/cash/shift/close', { closingCash: 5200, note: 'Нехватка 100' });
    expect(closed.json()).toMatchObject({ closingCash: 5200, expectedCash: 5300, difference: -100, note: 'Нехватка 100', closedBy: { id: 1 } });
    expect(closed.json().closedAt).not.toBeNull();
    expect((await t.api('GET', '/api/cash/shift/current')).json().shift).toBeNull();

    // Selling needs an open shift.
    const noShiftSale = await sell({ cash: 100 }, 100);
    expect(noShiftSale.statusCode).toBe(409);
    expect(noShiftSale.json().error).toEqual({ code: 'conflict', message: 'Откройте кассовую смену, чтобы провести продажу' });

    const list = await t.api('GET', '/api/cash/shifts');
    expect(list.json().total).toBe(1);
    expect(list.json().items[0]).toMatchObject({ expectedCash: 5300, difference: -100, operations: [] });
    const byId = await t.api('GET', `/api/cash/shifts/${opened.json().id}`);
    expect(byId.json().operations).toHaveLength(2);
    expect((await t.api('GET', '/api/cash/shifts/999')).statusCode).toBe(404);
  });

  it('shows the open shift on the dashboard', async () => {
    await t.api('POST', '/api/cash/shift/open', { openingCash: 1000 });
    await make(t, '/api/clients', { name: 'Иван', phone: '+79990000102' });
    const dash = (await t.api('GET', '/api/dashboard')).json();
    expect(dash.openShift).toMatchObject({ openingCash: 1000, expectedCash: 1000 });
  });
});
