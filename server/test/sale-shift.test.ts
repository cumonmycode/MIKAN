import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, FakeQrProvider, make, openShift, type TestApp } from './helpers.js';

/** Selling needs an open cash shift — docs/API.md «Sales (POS)», «CashShift». */

const NO_SHIFT = { code: 'conflict', message: 'Откройте кассовую смену, чтобы провести продажу' };

describe('a sale needs an open cash shift', () => {
  let t: TestApp;
  let bank: FakeQrProvider;
  let product: { id: number };

  beforeEach(async () => {
    bank = new FakeQrProvider();
    t = await createTestApp({ qr: bank });
    product = await make(t, '/api/products', { kind: 'jewelry', name: 'Лабрет', price: 1500, initialQuantity: 3 });
  });
  afterEach(async () => {
    await t.close();
  });

  const cart = (payments: Record<string, number>, extra: object = {}) => ({
    items: [{ type: 'product', productId: product.id, quantity: 1 }],
    discount: 0,
    payments: { cash: 0, card: 0, transfer: 0, qr: 0, ...payments },
    ...extra,
  });
  const stock = async () => (await t.api('GET', `/api/products/${product.id}`)).json().quantity;
  const close = (closingCash = 0) => t.api('POST', '/api/cash/shift/close', { closingCash });

  it('refuses POST /sales without a shift and writes nothing; attaches the sale to the open shift', async () => {
    const refused = await t.api('POST', '/api/sales', cart({ cash: 1500 }));
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toEqual(NO_SHIFT);
    expect((await t.api('GET', '/api/sales')).json().total).toBe(0);
    expect(await stock()).toBe(3);

    const shiftId = await openShift(t);
    const sale = await t.api('POST', '/api/sales', cart({ card: 1500 }));
    expect(sale.json()).toMatchObject({ number: 1, shiftId, status: 'completed' });
    expect(await stock()).toBe(2);

    // Closed again: the next sale is refused, the earlier one stays.
    await close();
    expect((await t.api('POST', '/api/sales', cart({ card: 1500 }))).json().error).toEqual(NO_SHIFT);
    expect((await t.api('GET', '/api/sales')).json().total).toBe(1);
  });

  it('checks the shift before anything else is written: an open receipt stays open', async () => {
    const receipt = await make(t, '/api/receipts', { items: [{ type: 'product', productId: product.id, quantity: 1 }] });
    const refused = await t.api('POST', '/api/sales', cart({ cash: 1500 }, { receiptId: receipt.id }));
    expect(refused.json().error).toEqual(NO_SHIFT);
    expect((await t.api('GET', `/api/receipts/${receipt.id}`)).statusCode).toBe(200);
  });

  it('replays a sale stored before the shift was closed', async () => {
    await openShift(t);
    const key = randomUUID();
    const send = () =>
      t.app.inject({ method: 'POST', url: '/api/sales', headers: { authorization: `Bearer ${t.token}`, 'idempotency-key': key }, payload: cart({ cash: 1500 }) });
    const first = await send();
    await close(1500);
    const again = await send();
    expect(again.statusCode).toBe(200);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json()).toEqual(first.json());
  });

  it('refuses a QR code without a shift before asking the bank', async () => {
    const refused = await t.api('POST', '/api/qr-payments', cart({ qr: 1500 }));
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toEqual(NO_SHIFT);
    expect(bank.created).toEqual([]);
  });

  it('a QR payment the bank confirms after the shift was closed still becomes a sale', async () => {
    const first = await openShift(t);
    const code = await make(t, '/api/qr-payments', cart({ qr: 1500 }));
    await close();
    bank.statuses.set('QR1', 'paid');
    const paid = (await t.api('GET', `/api/qr-payments/${code.id}`)).json();
    expect(paid).toMatchObject({ status: 'paid', error: null, sale: { shiftId: null, total: 1500, payments: { qr: 1500 } } });
    expect(await stock()).toBe(2);

    // Confirmed while a later shift is open: the sale counts in that one.
    await t.api('POST', '/api/cash/shift/open', { openingCash: 0 });
    const current = (await t.api('GET', '/api/cash/shift/current')).json().shift.id;
    expect(current).not.toBe(first);
    const second = await make(t, '/api/qr-payments', cart({ qr: 1500 }));
    bank.statuses.set('QR2', 'paid');
    expect((await t.api('GET', `/api/qr-payments/${second.id}`)).json().sale.shiftId).toBe(current);
  });
});
