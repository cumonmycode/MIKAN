import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, make, openShift, type TestApp } from './helpers.js';

type Json = Record<string, any>;

describe('deleting products and the unit cost of receipts', () => {
  let t: TestApp;
  let labret: Json;

  beforeEach(async () => {
    t = await createTestApp();
    await openShift(t);
    labret = await make(t, '/api/products', {
      kind: 'jewelry', name: 'Лабрет', price: 1500, cost: 500,
      variants: [{ name: '6 мм', initialQuantity: 2 }, { name: '8 мм', cost: 700, initialQuantity: 1 }],
    });
  });
  afterEach(async () => {
    await t.close();
  });

  const get = async (id: number) => (await t.api('GET', `/api/products/${id}`)).json();
  const list = async () => (await t.api('GET', '/api/products?includeInactive=true')).json().items.map((p: Json) => p.id);

  it('a product without history is deleted for good', async () => {
    const draft = await make(t, '/api/products', { kind: 'jewelry', name: 'Черновик', price: 100 });
    const res = await t.api('DELETE', `/api/products/${draft.id}`);
    expect(res.json()).toEqual({ deleted: true });
    expect((await t.api('GET', `/api/products/${draft.id}`)).statusCode).toBe(404);
    expect(await list()).not.toContain(draft.id);
  });

  it('stock left is refused unless written off; then the product is archived and keeps its history', async () => {
    const service = await make(t, '/api/services', { name: 'Хеликс', category: 'piercing', price: 2500, durationMin: 30, jewelryIds: [labret.id] });
    await t.api('POST', '/api/sales', {
      items: [{ type: 'product', productId: labret.id, variantId: labret.variants[0].id, quantity: 1 }],
      discount: 0, payments: { cash: 1500, card: 0, transfer: 0, qr: 0, deposit: 0 },
    });

    const refused = await t.api('DELETE', `/api/products/${labret.id}`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.message).toBe('На складе ещё 2 шт. — спишите остаток, чтобы удалить позицию');

    const res = await t.api('DELETE', `/api/products/${labret.id}?writeOff=true`);
    expect(res.json()).toEqual({ archived: true, writtenOff: 2 });
    expect(await get(labret.id)).toMatchObject({ archived: true, active: false, quantity: 0 });
    expect(await list()).not.toContain(labret.id);
    const moves = (await t.api('GET', `/api/products/${labret.id}/movements`)).json().items;
    expect(moves.filter((m: Json) => m.type === 'writeoff').map((m: Json) => [m.delta, m.note])).toEqual([
      [-1, 'Позиция удалена со склада'], [-1, 'Позиция удалена со склада'],
    ]);
    const services = (await t.api('GET', '/api/services')).json().items;
    expect(services.find((s: Json) => s.id === service.id).jewelryIds).toEqual([]);

    // Nothing new happens to it; deleting again is 404.
    const sell = await t.api('POST', '/api/sales', {
      items: [{ type: 'product', productId: labret.id, variantId: labret.variants[0].id, quantity: 1 }],
      discount: 0, payments: { cash: 1500, card: 0, transfer: 0, qr: 0, deposit: 0 },
    });
    expect(sell.json().error.message).toBe('«Лабрет»: позиция удалена со склада');
    expect((await t.api('POST', `/api/products/${labret.id}/movements`, { type: 'receipt', variantId: labret.variants[0].id, quantity: 1 })).statusCode).toBe(400);
    expect((await t.api('PATCH', `/api/products/${labret.id}`, { name: 'Новый' })).statusCode).toBe(400);
    expect((await t.api('DELETE', `/api/products/${labret.id}`)).statusCode).toBe(404);
  });

  it('a refund of a deleted product returns the money, not the stock', async () => {
    const sale = (await t.api('POST', '/api/sales', {
      items: [{ type: 'product', productId: labret.id, variantId: labret.variants[0].id, quantity: 1 }],
      discount: 0, payments: { cash: 0, card: 0, transfer: 1500, qr: 0, deposit: 0 },
    })).json();
    await t.api('DELETE', `/api/products/${labret.id}?writeOff=true`);
    const refund = await t.api('POST', `/api/sales/${sale.id}/refund`, { reason: 'Не подошло', restock: true });
    expect(refund.json().status).toBe('refunded');
    expect((await get(labret.id)).quantity).toBe(0);
  });

  it('a receipt with a unit cost keeps the total and updates the cost of what was received', async () => {
    const single = await t.api('POST', `/api/products/${labret.id}/movements`, { type: 'receipt', variantId: labret.variants[0].id, quantity: 5, unitCost: 450 });
    expect(single.json().movement).toMatchObject({ type: 'receipt', delta: 5, amount: 2250 });
    // 6 мм has no own cost: the product's cost changes.
    expect(single.json().product).toMatchObject({ cost: 450 });

    const batch = await t.api('POST', `/api/products/${labret.id}/movements/batch`, {
      type: 'receipt', unitCost: 400,
      lines: [{ variantId: labret.variants[0].id, quantity: 2 }, { variantId: labret.variants[1].id, quantity: 3, unitCost: 650 }],
    });
    expect(batch.json().movements.map((m: Json) => m.amount)).toEqual([800, 1950]);
    const product = batch.json().product;
    expect(product.cost).toBe(400);
    expect(product.variants.find((v: Json) => v.id === labret.variants[1].id).cost).toBe(650);

    // Without a unit cost nothing changes; other types ignore it.
    const plain = await t.api('POST', `/api/products/${labret.id}/movements`, { type: 'receipt', variantId: labret.variants[0].id, quantity: 1 });
    expect(plain.json().movement.amount).toBeNull();
    const writeoff = await t.api('POST', `/api/products/${labret.id}/movements`, { type: 'writeoff', variantId: labret.variants[0].id, quantity: 1, unitCost: 1 });
    expect(writeoff.json().movement.amount).toBeNull();
    expect(writeoff.json().product.cost).toBe(400);
  });
});

describe('deleting a presence consumable', () => {
  it('writes nothing off, whatever count was left from before', async () => {
    const t = await createTestApp();
    try {
      const soap = await make(t, '/api/products', { kind: 'consumable', name: 'Мыло', initialQuantity: 4, cost: 100 });
      await t.api('PATCH', `/api/products/${soap.id}`, { stockMode: 'presence' });
      const res = await t.api('DELETE', `/api/products/${soap.id}`);
      expect(res.json()).toEqual({ archived: true, writtenOff: 0 });
      const moves = (await t.api('GET', `/api/products/${soap.id}/movements`)).json().items;
      expect(moves.some((m: { type: string }) => m.type === 'writeoff')).toBe(false);
    } finally {
      await t.close();
    }
  });
});
