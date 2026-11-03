import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, make, openShift, type TestApp } from './helpers.js';

describe('sales (POS)', () => {
  let t: TestApp;
  let product: { id: number; variants: Array<{ id: number }> };
  let service: { id: number };
  let client: { id: number };

  beforeEach(async () => {
    t = await createTestApp();
    await openShift(t);
    product = await make(t, '/api/products', { kind: 'jewelry', name: 'Лабрет', price: 1500, initialQuantity: 3 });
    service = await make(t, '/api/services', { name: 'Прокол мочки', category: 'piercing', price: 2500, durationMin: 30 });
    client = await make(t, '/api/clients', { name: 'Иван', phone: '+79991234567' });
  });
  afterEach(async () => {
    await t.close();
  });

  const body = (overrides: object = {}) => ({
    clientId: client.id,
    items: [
      { type: 'product', productId: product.id, quantity: 1, price: 1500 },
      { type: 'service', serviceId: service.id, quantity: 1 },
    ],
    discount: 500,
    payments: { cash: 1500, card: 2000, transfer: 0 },
    note: null,
    ...overrides,
  });

  it('creates a sale with mixed payments, discount and a stock decrement', async () => {
    const res = await t.api('POST', '/api/sales', body());
    expect(res.statusCode).toBe(200);
    const sale = res.json();
    expect(sale).toMatchObject({
      number: 1,
      client: { id: client.id, name: 'Иван', phone: '+79991234567', telegramLinked: false },
      employee: { id: 1, name: 'Админ', color: '#FF7A1A' },
      appointmentId: null,
      shiftId: 1,
      subtotal: 4000,
      discount: 500,
      total: 3500,
      payments: { cash: 1500, card: 2000, transfer: 0 },
      status: 'completed',
      refundedAt: null,
      refundReason: null,
    });
    expect(sale.items).toEqual([
      { id: expect.any(Number), type: 'product', productId: product.id, variantId: product.variants[0].id, variantName: null, serviceId: null, certificateId: null, certificateCode: null, name: 'Лабрет', quantity: 1, price: 1500, total: 1500, refundedQuantity: 0 },
      { id: expect.any(Number), type: 'service', productId: null, variantId: null, variantName: null, serviceId: service.id, certificateId: null, certificateCode: null, name: 'Прокол мочки', quantity: 1, price: 2500, total: 2500, refundedQuantity: 0 },
    ]);
    expect((await t.api('GET', `/api/products/${product.id}`)).json().quantity).toBe(2);
    const moves = (await t.api('GET', `/api/products/${product.id}/movements`)).json().items;
    expect(moves[0]).toMatchObject({ type: 'sale', delta: -1, quantityAfter: 2, saleId: sale.id });

    const second = await t.api('POST', '/api/sales', body({ discount: 0, payments: { cash: 4000 } }));
    expect(second.json().number).toBe(2);
    expect((await t.api('GET', `/api/sales/${sale.id}`)).json().id).toBe(sale.id);
    const list = await t.api('GET', `/api/sales?clientId=${client.id}&limit=1`);
    expect(list.json().total).toBe(2);
    expect(list.json().items[0].number).toBe(2);
  });

  it('validates payment sums, discounts and items', async () => {
    const mismatch = await t.api('POST', '/api/sales', body({ payments: { cash: 1000, card: 2000, transfer: 0 } }));
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().error.message).toBe('Сумма оплат (3 000 ₽) не совпадает с итогом (3 500 ₽)');
    const bigDiscount = await t.api('POST', '/api/sales', body({ discount: 5000 }));
    expect(bigDiscount.json().error.message).toBe('Скидка не может быть больше суммы чека');
    const noName = await t.api('POST', '/api/sales', body({ items: [{ type: 'service', quantity: 1, price: 100 }], discount: 0, payments: { cash: 100 } }));
    expect(noName.json().error.message).toBe('Позиция №1: укажите название услуги');
    const custom = await t.api('POST', '/api/sales', body({ items: [{ type: 'service', name: 'Коррекция', price: 700 }], discount: 0, payments: { transfer: 700 } }));
    expect(custom.json().items[0]).toMatchObject({ name: 'Коррекция', serviceId: null, quantity: 1, total: 700 });
    const consumable = await make(t, '/api/products', { kind: 'consumable', name: 'Игла', price: 0, initialQuantity: 5 });
    const sellConsumable = await t.api('POST', '/api/sales', body({ items: [{ type: 'product', productId: consumable.id, quantity: 1 }], discount: 0, payments: { cash: 0 } }));
    expect(sellConsumable.statusCode).toBe(400);
    expect((await t.api('POST', '/api/sales', body({ items: [] }))).statusCode).toBe(400);
  });

  it('rolls back the whole sale on insufficient stock', async () => {
    const res = await t.api('POST', '/api/sales', body({
      items: [{ type: 'product', productId: product.id, quantity: 5 }],
      discount: 0,
      payments: { cash: 7500 },
    }));
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toEqual({ code: 'insufficient_stock', message: 'Недостаточно на складе: Лабрет (осталось 3)' });
    expect((await t.api('GET', '/api/sales')).json().total).toBe(0);
    expect((await t.api('GET', `/api/products/${product.id}`)).json().quantity).toBe(3);
  });

  it('links an appointment: sets saleId, completes it, blocks double payment', async () => {
    const appt = await make(t, '/api/appointments', {
      clientId: client.id,
      masterId: 1,
      serviceId: service.id,
      startsAt: '2026-11-01T10:00:00.000Z',
    });
    const sale = await t.api('POST', '/api/sales', {
      appointmentId: appt.id,
      items: [{ type: 'service', serviceId: service.id, quantity: 1 }],
      discount: 0,
      payments: { cash: 1500, card: 0, transfer: 1000 },
    });
    expect(sale.statusCode).toBe(200);
    expect(sale.json()).toMatchObject({ appointmentId: appt.id, client: { id: client.id } });
    const after = (await t.api('GET', `/api/appointments/${appt.id}`)).json();
    expect(after).toMatchObject({ status: 'completed', saleId: sale.json().id });
    expect(after.completedAt).not.toBeNull();
    const again = await t.api('POST', '/api/sales', {
      appointmentId: appt.id,
      items: [{ type: 'service', serviceId: service.id }],
      discount: 0,
      payments: { cash: 2500 },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.message).toBe('Запись уже оплачена (чек №1)');
    expect((await t.api('GET', `/api/clients/${client.id}`)).json().stats).toMatchObject({ visits: 1, totalSpent: 2500 });
  });

  it('refunds with restock and refuses a second refund', async () => {
    const sale = (await t.api('POST', '/api/sales', body())).json();
    await t.api('POST', '/api/cash/shift/close', { closingCash: 1500 });
    // Regression (review #5): cash handed back without an open shift would vanish from the drawer.
    const noShift = await t.api('POST', `/api/sales/${sale.id}/refund`, { reason: 'Не подошло', restock: true });
    expect(noShift.statusCode).toBe(409);
    expect(noShift.json().error).toEqual({ code: 'conflict', message: 'Откройте смену, чтобы вернуть наличные' });
    expect((await t.api('GET', `/api/sales/${sale.id}`)).json().status).toBe('completed');
    await t.api('POST', '/api/cash/shift/open', { openingCash: 5000 });
    const refund = await t.api('POST', `/api/sales/${sale.id}/refund`, { reason: 'Не подошло', restock: true });
    expect(refund.statusCode).toBe(200);
    expect(refund.json()).toMatchObject({ status: 'refunded', refundReason: 'Не подошло' });
    expect(refund.json().refundedAt).not.toBeNull();
    expect((await t.api('GET', `/api/products/${product.id}`)).json().quantity).toBe(3);
    const moves = (await t.api('GET', `/api/products/${product.id}/movements`)).json().items;
    expect(moves[0]).toMatchObject({ type: 'return', delta: 1, quantityAfter: 3, saleId: sale.id });

    const twice = await t.api('POST', `/api/sales/${sale.id}/refund`, { reason: 'ещё раз', restock: true });
    expect(twice.statusCode).toBe(409);
    expect((await t.api('POST', `/api/sales/${sale.id}/refund`, { reason: '' })).statusCode).toBe(400);
    expect((await t.api('GET', `/api/clients/${client.id}`)).json().stats.totalSpent).toBe(0);

    await t.api('POST', '/api/cash/shift/close', { closingCash: 3500 });
    // A refund with no cash part needs no shift.
    await openShift(t);
    const cardOnly = (await t.api('POST', '/api/sales', body({ payments: { cash: 0, card: 3500, transfer: 0 } }))).json();
    await t.api('POST', '/api/cash/shift/close', { closingCash: 0 });
    expect((await t.api('POST', `/api/sales/${cardOnly.id}/refund`, { reason: 'Отказ', restock: true })).statusCode).toBe(200);
    await t.api('POST', '/api/cash/shift/open', { openingCash: 0 });
    const keep = (await t.api('POST', '/api/sales', body())).json();
    await t.api('POST', `/api/sales/${keep.id}/refund`, { reason: 'Брак', restock: false });
    expect((await t.api('GET', `/api/products/${product.id}`)).json().quantity).toBe(2);
    expect((await t.api('GET', '/api/cash/shift/current')).json().shift.summary).toMatchObject({ refunds: 3500, cashRefunds: 1500 });
    expect((await t.api('GET', '/api/sales/999')).statusCode).toBe(404);
  });
});
