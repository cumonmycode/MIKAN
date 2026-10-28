import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { productVariants } from '../src/db/schema.js';
import { createTestApp, FakeQrProvider, make, openShift, type TestApp } from './helpers.js';

interface Size {
  id: number;
  name: string;
  quantity: number;
}

describe('jewelry sizes: selling, refunds, QR, history and reports', () => {
  let t: TestApp;
  let bank: FakeQrProvider;
  let labret: { id: number; variants: Size[] };
  let six: number;
  let eight: number;

  beforeEach(async () => {
    bank = new FakeQrProvider();
    t = await createTestApp({ qr: bank });
    await openShift(t);
    labret = await make(t, '/api/products', {
      kind: 'jewelry',
      name: 'Лабрет',
      price: 1500,
      variants: [
        { name: '6 мм', initialQuantity: 2 },
        { name: '8 мм', price: 1700, initialQuantity: 1 },
      ],
    });
    [six, eight] = labret.variants.map((v) => v.id) as [number, number];
  });
  afterEach(async () => {
    await t.close();
  });

  const sell = (items: object[], payments: object) => t.api('POST', '/api/sales', { items, discount: 0, payments });
  const stock = async () =>
    (await t.api('GET', `/api/products/${labret.id}`)).json().variants.map((v: Size) => [v.name, v.quantity]);

  it('sells a size at its own price and takes the stock from that size', async () => {
    const res = await sell(
      [
        { type: 'product', productId: labret.id, variantId: eight, quantity: 1 },
        { type: 'product', productId: labret.id, variantId: six, quantity: 2 },
      ],
      { cash: 4700 },
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((i: { name: string; variantId: number; variantName: string; price: number }) => [i.name, i.variantId, i.variantName, i.price])).toEqual([
      ['Лабрет — 8 мм', eight, '8 мм', 1700],
      ['Лабрет — 6 мм', six, '6 мм', 1500],
    ]);
    expect(await stock()).toEqual([
      ['6 мм', 0],
      ['8 мм', 0],
    ]);
    const moves = (await t.api('GET', `/api/products/${labret.id}/movements?variantId=${eight}`)).json().items;
    expect(moves[0]).toMatchObject({ type: 'sale', delta: -1, quantityAfter: 0, variantName: '8 мм', saleId: res.json().id });
  });

  it('checks stock per size, summing lines of one size', async () => {
    const res = await sell(
      [
        { type: 'product', productId: labret.id, variantId: eight, quantity: 1, price: 1700 },
        { type: 'product', productId: labret.id, variantId: eight, quantity: 1, price: 1000 },
      ],
      { cash: 2700 },
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toEqual({ code: 'insufficient_stock', message: 'Недостаточно на складе: Лабрет — 8 мм (осталось 1)' });
    expect(await stock()).toEqual([
      ['6 мм', 2],
      ['8 мм', 1],
    ]);
  });

  it('refuses a product with several sizes from older builds and accepts one with a single size', async () => {
    const old = await sell([{ type: 'product', productId: labret.id, quantity: 1, price: 1500 }], { cash: 1500 });
    expect(old.statusCode).toBe(409);
    expect(old.json().error).toEqual({ code: 'conflict', message: 'У «Лабрет» несколько размеров. Обновите приложение MIKAN, чтобы выбрать размер.' });

    const ring = await make(t, '/api/products', { kind: 'jewelry', name: 'Кольцо', price: 900, initialQuantity: 1 });
    const single = await sell([{ type: 'product', productId: ring.id, quantity: 1 }], { cash: 900 });
    expect(single.json().items[0]).toMatchObject({ name: 'Кольцо', variantId: ring.variants[0].id, variantName: null, price: 900 });

    const foreign = await sell([{ type: 'product', productId: labret.id, variantId: ring.variants[0].id, quantity: 1 }], { cash: 900 });
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json().error.message).toBe('Позиция №1: размер не найден');
  });

  it('returns refunded jewelry to the sold size, even after that size was removed from the list', async () => {
    const sale = (await sell([{ type: 'product', productId: labret.id, variantId: eight, quantity: 1 }], { transfer: 1700 })).json();
    // 8 мм is out and has history: removing it archives it.
    await t.api('PATCH', `/api/products/${labret.id}`, { variants: [{ id: six }] });
    expect((await t.api('GET', `/api/products/${labret.id}`)).json().size).toBe('6 мм');

    const refund = await t.api('POST', `/api/sales/${sale.id}/refund`, { reason: 'Не подошёл размер', restock: true });
    expect(refund.statusCode).toBe(200);
    expect(await stock()).toEqual([
      ['6 мм', 2],
      ['8 мм', 1],
    ]);
    expect(t.ctx.db.select().from(productVariants).where(eq(productVariants.id, eight)).get()!.archived).toBe(false);
    const moves = (await t.api('GET', `/api/products/${labret.id}/movements?variantId=${eight}`)).json().items;
    expect(moves[0]).toMatchObject({ type: 'return', delta: 1, quantityAfter: 1, note: 'Не подошёл размер' });
  });

  it('a size added back under its old name reuses the archived row; a refund never brings back a duplicate', async () => {
    // 8 мм is sold out and archived, then added back with new stock: the same row returns.
    const sold = (await sell([{ type: 'product', productId: labret.id, variantId: eight, quantity: 1 }], { transfer: 1700 })).json();
    await t.api('PATCH', `/api/products/${labret.id}`, { variants: [{ id: six }] });
    const back = (await t.api('PATCH', `/api/products/${labret.id}`, { variants: [{ id: six }, { name: ' 8 ММ ', initialQuantity: 2 }] })).json();
    expect(back.variants.map((v: Size) => [v.id, v.name, v.quantity])).toEqual([
      [six, '6 мм', 2],
      [eight, '8 ММ', 2],
    ]);
    expect((await t.api('GET', `/api/products?search=8%20%D0%BC%D0%BC`)).json().items.map((p: { id: number }) => p.id)).toEqual([labret.id]);

    // An archived size whose name is taken by another current size: the refund goes to the current one.
    const ring = await make(t, '/api/products', { kind: 'jewelry', name: 'Кольцо', price: 900, variants: [{ name: '8 мм', initialQuantity: 1 }, { name: '10 мм', initialQuantity: 1 }] });
    const [ringEight, ringTen] = (ring.variants as Size[]).map((v) => v.id);
    const ringSale = (await sell([{ type: 'product', productId: ring.id, variantId: ringEight, quantity: 1 }], { transfer: 900 })).json();
    await t.api('PATCH', `/api/products/${ring.id}`, { variants: [{ id: ringTen, name: '8 мм' }] });
    await t.api('POST', `/api/sales/${ringSale.id}/refund`, { reason: 'Возврат', restock: true });
    const after = (await t.api('GET', `/api/products/${ring.id}`)).json();
    expect(after.variants.map((v: Size) => [v.id, v.name, v.quantity])).toEqual([[ringTen, '8 мм', 2]]);
    expect(after.size).toBe('8 мм');
    expect(sold.id).toBeGreaterThan(0);
  });

  it('QR: the stored cart keeps the size and price even if sizes change before the client pays', async () => {
    const ring = await make(t, '/api/products', { kind: 'jewelry', name: 'Кольцо', price: 900, initialQuantity: 2 });
    const created = await t.api('POST', '/api/qr-payments', {
      // An older build: no variantId, the ring has one size.
      items: [
        { type: 'product', productId: ring.id, quantity: 1 },
        { type: 'product', productId: labret.id, variantId: eight, quantity: 1 },
      ],
      discount: 0,
      payments: { qr: 2600 },
    });
    expect(created.statusCode).toBe(200);
    // Before the payment, staff add a second size to the ring and raise the labret price.
    await t.api('PATCH', `/api/products/${ring.id}`, { variants: [{ id: ring.variants[0].id, name: '8 мм' }, { name: '10 мм', initialQuantity: 1 }] });
    await t.api('PATCH', `/api/products/${labret.id}`, { variants: [{ id: six }, { id: eight, price: 2000 }] });

    bank.statuses.set('QR1', 'paid');
    const paid = (await t.api('GET', `/api/qr-payments/${created.json().id}`)).json();
    expect(paid.error).toBeNull();
    expect(paid.sale.items.map((i: { name: string; price: number; variantId: number }) => [i.name, i.price, i.variantId])).toEqual([
      ['Кольцо — 8 мм', 900, ring.variants[0].id],
      ['Лабрет — 8 мм', 1700, eight],
    ]);
    expect(paid.sale.total).toBe(2600);
  });

  it('QR: a size sold out before the payment leaves the money flagged for staff, no sale', async () => {
    const created = await t.api('POST', '/api/qr-payments', {
      items: [{ type: 'product', productId: labret.id, variantId: eight, quantity: 1 }],
      discount: 0,
      payments: { qr: 1700 },
    });
    await sell([{ type: 'product', productId: labret.id, variantId: eight, quantity: 1 }], { cash: 1700 });
    bank.statuses.set('QR1', 'paid');
    const paid = (await t.api('GET', `/api/qr-payments/${created.json().id}`)).json();
    expect(paid).toMatchObject({ status: 'paid', sale: null });
    expect(paid.error).toContain('Недостаточно на складе: Лабрет — 8 мм (осталось 0)');
  });

  it('product history names the size and filters by it; reports split top products by size', async () => {
    const client = await make(t, '/api/clients', { name: 'Иван', phone: '+79991234567' });
    await t.api('POST', '/api/sales', {
      clientId: client.id,
      items: [{ type: 'product', productId: labret.id, variantId: six, quantity: 2 }],
      discount: 0,
      payments: { cash: 3000 },
    });
    await sell([{ type: 'product', productId: labret.id, variantId: eight, quantity: 1 }], { transfer: 1700 });

    const all = (await t.api('GET', `/api/products/${labret.id}/history`)).json();
    expect(all.items.map((e: { name: string; variantName: string; quantity: number }) => [e.name, e.variantName, e.quantity])).toEqual([
      ['Лабрет — 8 мм', '8 мм', 1],
      ['Лабрет — 6 мм', '6 мм', 2],
    ]);
    const onlySix = (await t.api('GET', `/api/products/${labret.id}/history?variantId=${six}`)).json();
    expect(onlySix.total).toBe(1);
    expect(onlySix.items[0]).toMatchObject({ variantId: six, client: { id: client.id } });
    expect((await t.api('GET', `/api/clients/${client.id}/history`)).json().items[0]).toMatchObject({ name: 'Лабрет — 6 мм', variantName: '6 мм' });

    const from = new Date(Date.now() - 86_400_000).toISOString();
    const to = new Date(Date.now() + 86_400_000).toISOString();
    const report = (await t.api('GET', `/api/reports/summary?from=${from}&to=${to}`)).json();
    expect(report.topProducts).toEqual([
      {
        productId: labret.id,
        name: 'Лабрет',
        quantity: 3,
        revenue: 4700,
        variants: [
          { variantId: six, name: '6 мм', quantity: 2, revenue: 3000 },
          { variantId: eight, name: '8 мм', quantity: 1, revenue: 1700 },
        ],
      },
    ]);
  });

  it('completing an appointment uses a size of the consumed product', async () => {
    const client = await make(t, '/api/clients', { name: 'Иван', phone: '+79991234567' });
    const needles = await make(t, '/api/products', { kind: 'consumable', name: 'Иглы', initialQuantity: 10 });
    const appt = await make(t, '/api/appointments', { clientId: client.id, masterId: 1, title: 'Прокол', startsAt: '2026-10-20T10:00:00Z', endsAt: '2026-10-20T11:00:00Z' });
    const noSize = await t.api('POST', `/api/appointments/${appt.id}/complete`, {
      sendAftercare: false,
      consumables: [{ productId: labret.id, quantity: 1 }],
    });
    expect(noSize.statusCode).toBe(409);
    expect(noSize.json().error.message).toBe('У «Лабрет» несколько размеров — обновите приложение MIKAN, чтобы провести операцию по размеру');
    const done = await t.api('POST', `/api/appointments/${appt.id}/complete`, {
      sendAftercare: false,
      consumables: [
        { productId: needles.id, quantity: 2 },
        { productId: labret.id, variantId: six, quantity: 1 },
      ],
    });
    expect(done.statusCode).toBe(200);
    expect((await t.api('GET', `/api/products/${needles.id}`)).json().quantity).toBe(8);
    expect(await stock()).toEqual([
      ['6 мм', 1],
      ['8 мм', 1],
    ]);
  });
});
