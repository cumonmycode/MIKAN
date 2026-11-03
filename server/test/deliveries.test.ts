import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, make, type TestApp } from './helpers.js';

/** Deliveries (поставки) and suppliers — docs/API.md «Products & stock» → «Deliveries», «StockDelivery». */

const NOW = Date.parse('2026-10-15T09:00:00.000Z');

interface Size {
  id: number;
  name: string;
  quantity: number;
  cost: number | null;
}
interface Product {
  id: number;
  name: string;
  supplier: string | null;
  cost: number | null;
  quantity: number;
  variants: Size[];
}

describe('stock deliveries', () => {
  let t: TestApp;
  let labret: Product;
  let spray: Product;
  let gloves: Product;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    t = await createTestApp();
    labret = await make(t, '/api/products', {
      kind: 'jewelry',
      name: 'Лабрет',
      price: 1500,
      cost: 600,
      variants: [
        { name: '6 мм', initialQuantity: 2 },
        { name: '8 мм', cost: 650, initialQuantity: 0 },
      ],
    });
    spray = await make(t, '/api/products', { kind: 'goods', name: 'Спрей', price: 500, cost: 200, supplier: 'Аптека', initialQuantity: 1 });
    gloves = await make(t, '/api/products', { kind: 'consumable', name: 'Перчатки', price: 0, stockMode: 'presence' });
  });
  afterEach(async () => {
    vi.useRealTimers();
    await t.close();
  });

  const [six, eight] = [() => labret.variants[0]!.id, () => labret.variants[1]!.id];
  const product = async (id: number): Promise<Product> => (await t.api('GET', `/api/products/${id}`)).json();
  const deliver = (body: Record<string, unknown>) => t.api('POST', '/api/stock/deliveries', body);
  const delivered = async (body: Record<string, unknown>) => {
    const res = await deliver(body);
    if (res.statusCode !== 200) throw new Error(`POST /api/stock/deliveries → ${res.statusCode}: ${res.body}`);
    return res.json();
  };
  const refused = async (body: Record<string, unknown>) => {
    const res = await deliver(body);
    expect(res.statusCode).toBe(400);
    return res.json().error.message as string;
  };

  it('receives many products and sizes in one go: stock, movements, costs and the totals', async () => {
    const d = await delivered({
      supplier: '  Industrial Strength ',
      note: 'Счёт 118',
      lines: [
        { productId: labret.id, variantId: six(), quantity: 4, unitCost: 700 },
        { productId: labret.id, variantId: eight(), quantity: 6, unitCost: 1000 },
        { productId: spray.id, quantity: 4 },
      ],
    });
    expect(d).toEqual({
      id: expect.any(Number),
      number: 1,
      supplier: 'Industrial Strength',
      note: 'Счёт 118',
      total: 8800,
      itemCount: 14,
      lineCount: 3,
      employee: { id: 1, name: 'Админ', color: expect.any(String) },
      createdAt: new Date(NOW).toISOString(),
      lines: [
        { movementId: expect.any(Number), productId: labret.id, productName: 'Лабрет', productKind: 'jewelry', variantId: six(), variantName: '6 мм', quantity: 4, unitCost: 700, amount: 2800 },
        { movementId: expect.any(Number), productId: labret.id, productName: 'Лабрет', productKind: 'jewelry', variantId: eight(), variantName: '8 мм', quantity: 6, unitCost: 1000, amount: 6000 },
        { movementId: expect.any(Number), productId: spray.id, productName: 'Спрей', productKind: 'goods', variantId: spray.variants[0]!.id, variantName: '', quantity: 4, unitCost: null, amount: null },
      ],
    });

    const after = await product(labret.id);
    expect(after.variants.map((v) => [v.name, v.quantity, v.cost])).toEqual([
      ['6 мм', 6, null],
      ['8 мм', 6, 1000],
    ]);
    // A size without its own cost moves the product's cost; a line without a cost changes none.
    expect(after.cost).toBe(700);
    expect(await product(spray.id)).toMatchObject({ quantity: 5, cost: 200 });

    const moves = (await t.api('GET', `/api/products/${labret.id}/movements`)).json().items;
    expect(moves.slice(0, 2)).toEqual([
      expect.objectContaining({ type: 'receipt', variantName: '8 мм', delta: 6, quantityAfter: 6, amount: 6000, deliveryId: d.id, note: 'Поставка №1 · Счёт 118' }),
      expect.objectContaining({ type: 'receipt', variantName: '6 мм', delta: 4, quantityAfter: 6, amount: 2800, deliveryId: d.id, note: 'Поставка №1 · Счёт 118' }),
    ]);
    expect(d.lines.slice(0, 2).map((l: { movementId: number }) => l.movementId)).toEqual([moves[1].id, moves[0].id]);
    // Every movement carries `deliveryId`, null outside deliveries.
    const sold = (await t.api('GET', '/api/stock/movements?type=receipt')).json().items;
    expect(sold.every((m: Record<string, unknown>) => 'deliveryId' in m)).toBe(true);
    await t.api('POST', `/api/products/${spray.id}/movements`, { type: 'writeoff', quantity: 1 });
    expect((await t.api('GET', `/api/products/${spray.id}/movements`)).json().items[0]).toMatchObject({ type: 'writeoff', deliveryId: null });
  });

  it('fills in the supplier of products that have none and keeps the others', async () => {
    await delivered({ supplier: 'Anatometal', lines: [{ productId: labret.id, variantId: six(), quantity: 1 }, { productId: spray.id, quantity: 1 }] });
    expect((await product(labret.id)).supplier).toBe('Anatometal');
    expect((await product(spray.id)).supplier).toBe('Аптека');
    // The search text follows the new supplier.
    const found = (await t.api('GET', '/api/products?search=anatometal')).json().items;
    expect(found.map((p: Product) => p.id)).toEqual([labret.id]);

    // A delivery without a supplier writes none.
    const plain = await make(t, '/api/products', { kind: 'goods', name: 'Мыло', price: 100 });
    const d = await delivered({ supplier: '', lines: [{ productId: plain.id, quantity: 2 }] });
    expect(d).toMatchObject({ number: 2, supplier: null, note: null, total: 0, itemCount: 2, lineCount: 1 });
    expect((await product(plain.id)).supplier).toBeNull();
    expect((await t.api('GET', `/api/products/${plain.id}/movements`)).json().items[0]).toMatchObject({ note: 'Поставка №2', amount: null });
  });

  it('validates the lines and writes nothing when one of them is wrong', async () => {
    expect(await refused({ lines: [{ productId: gloves.id, quantity: 1 }] })).toBe('Покупку расходника «Перчатки» записывают суммой');
    expect(await refused({ lines: [{ productId: labret.id, quantity: 1 }] })).toBe('Выберите размер «Лабрет»');
    expect(await refused({ lines: [{ productId: 999, quantity: 1 }] })).toBe('Позиция №1: товар не найден');
    expect(await refused({ lines: [{ productId: spray.id, quantity: 1 }, { productId: labret.id, variantId: spray.variants[0]!.id, quantity: 1 }] })).toBe(
      'Позиция №2: размер не найден',
    );
    expect(
      await refused({ lines: [{ productId: labret.id, variantId: six(), quantity: 1 }, { productId: labret.id, variantId: six(), quantity: 2 }] }),
    ).toBe('«Лабрет — 6 мм» указан в поставке дважды');
    expect(await refused({ lines: [{ productId: spray.id, quantity: 0 }] })).toBe('«Количество (№1)»: должно быть не меньше 1');
    expect(await refused({ lines: [{ productId: spray.id, quantity: 10_001 }] })).toBe('«Количество (№1)»: должно быть не больше 10000');
    expect(await refused({ lines: [{ productId: spray.id, quantity: 1, unitCost: -1 }] })).toMatch(/не меньше 0/);
    expect(await refused({ lines: [] })).toMatch(/нужно указать хотя бы 1/);
    expect(await refused({ supplier: 'x'.repeat(101), lines: [{ productId: spray.id, quantity: 1 }] })).toBe('«Поставщик»: максимум 100 символов');
    expect(await refused({ note: 'x'.repeat(501), lines: [{ productId: spray.id, quantity: 1 }] })).toBe('«Комментарий»: максимум 500 символов');

    // A deleted product takes no stock; the earlier lines of the delivery are not kept either.
    const gone = await make(t, '/api/products', { kind: 'goods', name: 'Старый крем', price: 100, initialQuantity: 1 });
    expect((await t.api('DELETE', `/api/products/${gone.id}?writeOff=true`)).json()).toMatchObject({ archived: true });
    expect(await refused({ lines: [{ productId: spray.id, quantity: 3 }, { productId: gone.id, quantity: 1 }] })).toBe(
      '«Старый крем»: позиция удалена со склада',
    );
    expect((await product(spray.id)).quantity).toBe(1);
    expect((await t.api('GET', '/api/stock/deliveries')).json()).toEqual({ items: [], total: 0 });
    // A product with one size needs no size; the next number is 1.
    expect((await delivered({ lines: [{ productId: spray.id, quantity: 3 }] })).number).toBe(1);
  });

  it('lists deliveries newest first, by supplier in any case, and reads one with its lines', async () => {
    const first = await delivered({ supplier: 'Поставщик Ёлка', lines: [{ productId: spray.id, quantity: 2, unitCost: 150 }] });
    vi.setSystemTime(NOW + 60_000);
    const second = await delivered({ supplier: 'Industrial Strength', lines: [{ productId: labret.id, variantId: six(), quantity: 1, unitCost: 0 }] });
    vi.setSystemTime(NOW + 120_000);
    const third = await delivered({ supplier: 'поставщик елка', lines: [{ productId: labret.id, variantId: eight(), quantity: 3 }] });

    const all = (await t.api('GET', '/api/stock/deliveries')).json();
    expect(all.total).toBe(3);
    expect(all.items.map((d: { number: number }) => d.number)).toEqual([3, 2, 1]);
    expect(all.items[0]).toMatchObject({ id: third.id, total: 0, itemCount: 3, lineCount: 1, lines: [] });
    // A zero cost is a cost: the line has an amount of 0.
    expect(all.items[1]).toMatchObject({ id: second.id, total: 0, itemCount: 1, lineCount: 1, lines: [] });
    expect(all.items[2]).toMatchObject({ id: first.id, total: 300, itemCount: 2, lineCount: 1 });

    const elka = (await t.api('GET', `/api/stock/deliveries?supplier=${encodeURIComponent('ПОСТАВЩИК ЕЛКА')}`)).json();
    expect(elka).toMatchObject({ total: 2 });
    expect(elka.items.map((d: { id: number }) => d.id)).toEqual([third.id, first.id]);
    const paged = (await t.api('GET', `/api/stock/deliveries?supplier=${encodeURIComponent('поставщик ёлка')}&limit=1&offset=1`)).json();
    expect(paged).toMatchObject({ total: 2, items: [{ id: first.id }] });
    expect((await t.api('GET', '/api/stock/deliveries?limit=1')).json()).toMatchObject({ total: 3, items: [{ id: third.id }] });

    const one = (await t.api('GET', `/api/stock/deliveries/${second.id}`)).json();
    expect(one).toEqual(second);
    expect(one.lines).toEqual([expect.objectContaining({ variantName: '6 мм', quantity: 1, unitCost: 0, amount: 0 })]);
    expect((await t.api('GET', '/api/stock/deliveries/999')).json().error).toEqual({ code: 'not_found', message: 'Поставка не найдена' });
  });

  it('lists suppliers of deliveries and products, recently used first, with one spelling per name', async () => {
    await make(t, '/api/products', { kind: 'goods', name: 'Бальзам', price: 300, supplier: 'Botanica' });
    expect((await t.api('GET', '/api/stock/suppliers')).json()).toEqual({
      // Names only products carry are in alphabetical order (Cyrillic first).
      items: [
        { name: 'Аптека', deliveries: 0, lastAt: null },
        { name: 'Botanica', deliveries: 0, lastAt: null },
      ],
    });

    await delivered({ supplier: 'аптека', lines: [{ productId: spray.id, quantity: 1 }] });
    vi.setSystemTime(NOW + 60_000);
    await delivered({ supplier: 'Industrial Strength', lines: [{ productId: labret.id, variantId: six(), quantity: 1 }] });
    vi.setSystemTime(NOW + 120_000);
    await delivered({ supplier: 'АПТЕКА', lines: [{ productId: spray.id, quantity: 1 }] });
    await delivered({ lines: [{ productId: spray.id, quantity: 1 }] });

    expect((await t.api('GET', '/api/stock/suppliers')).json().items).toEqual([
      { name: 'АПТЕКА', deliveries: 2, lastAt: new Date(NOW + 120_000).toISOString() },
      { name: 'Industrial Strength', deliveries: 1, lastAt: new Date(NOW + 60_000).toISOString() },
      { name: 'Botanica', deliveries: 0, lastAt: null },
    ]);
  });

  it('replays a delivery sent again with the same Idempotency-Key', async () => {
    const key = randomUUID();
    const body = { supplier: 'Аптека', lines: [{ productId: spray.id, quantity: 5, unitCost: 180 }] };
    const send = () =>
      t.app.inject({ method: 'POST', url: '/api/stock/deliveries', headers: { authorization: `Bearer ${t.token}`, 'idempotency-key': key }, payload: body });
    const first = await send();
    const again = await send();
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json()).toEqual(first.json());
    expect((await product(spray.id)).quantity).toBe(6);
    expect((await t.api('GET', '/api/stock/deliveries')).json().total).toBe(1);
  });

  it('logs a delivery with its supplier, positions, pieces and sum', async () => {
    await delivered({
      supplier: 'Industrial Strength',
      lines: [
        { productId: labret.id, variantId: six(), quantity: 4, unitCost: 700 },
        { productId: labret.id, variantId: eight(), quantity: 6, unitCost: 1000 },
        { productId: spray.id, quantity: 4, unitCost: 900 },
      ],
    });
    await delivered({ lines: [{ productId: spray.id, quantity: 5 }] });
    const entries = (await t.api('GET', '/api/audit?entity=stock')).json().items;
    expect(entries.slice(0, 2)).toEqual([
      expect.objectContaining({ action: 'stock.delivery', entity: 'stock', entityId: null, summary: 'Поставка №2: 1 позиция, 5 шт' }),
      expect.objectContaining({ action: 'stock.delivery', entityId: null, summary: 'Поставка №1 от Industrial Strength: 3 позиции, 14 шт, 12 400 ₽' }),
    ]);
  });
});
