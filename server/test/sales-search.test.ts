import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sales } from '../src/db/schema.js';
import { createTestApp, make, openShift, type TestApp } from './helpers.js';

/** `GET /sales?search=` — docs/API.md «Sales (POS)». */

const NOW = Date.parse('2026-10-15T09:00:00.000Z');
const DAY = 86_400_000;

describe('sales search', () => {
  let t: TestApp;
  let ivan: { id: number };
  let anna: { id: number };
  let yolka: { id: number };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    t = await createTestApp();
    await openShift(t);
    ivan = await make(t, '/api/clients', { name: 'Иван', lastName: 'Петров', phone: '+79991234567' });
    anna = await make(t, '/api/clients', { name: 'Анна', lastName: 'Сидорова', phone: '+79995550017' });
    yolka = await make(t, '/api/clients', { name: 'Алёна', lastName: 'Ёлкина', phone: '+79161112233' });
  });
  afterEach(async () => {
    vi.useRealTimers();
    await t.close();
  });

  /** A sale with this receipt number (renumbered after the fact to reach two-digit numbers quickly). */
  const sell = async (number: number, clientId: number | null, at = NOW) => {
    vi.setSystemTime(at);
    const sale = await make(t, '/api/sales', {
      clientId,
      items: [{ type: 'service', name: 'Консультация', price: 1000, quantity: 1 }],
      discount: 0,
      payments: { card: 1000 },
    });
    t.ctx.db.update(sales).set({ number }).where(eq(sales.id, sale.id)).run();
    return sale.id as number;
  };
  const search = async (query: string) => {
    const res = await t.api('GET', `/api/sales?${query}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    return { numbers: body.items.map((s: { number: number }) => s.number) as number[], total: body.total as number };
  };
  const q = (term: string) => `search=${encodeURIComponent(term)}`;

  it('finds a receipt by its number, with or without «№»', async () => {
    await sell(7, ivan.id);
    await sell(17, null, NOW + 1000);
    await sell(117, anna.id, NOW + 2000);
    // Two digits are a receipt number only: Anna's phone ends with 17 but does not match.
    expect(await search(q('17'))).toEqual({ numbers: [17], total: 1 });
    expect(await search(q('№17'))).toEqual({ numbers: [17], total: 1 });
    expect(await search(q('№ 17'))).toEqual({ numbers: [17], total: 1 });
    expect(await search(q('#117'))).toEqual({ numbers: [117], total: 1 });
    expect(await search(q('  7 '))).toEqual({ numbers: [7], total: 1 });
    expect(await search(q('№99'))).toEqual({ numbers: [], total: 0 });
    // Three digits and more: the number or the digits anywhere in the client's phone.
    expect(await search(q('017'))).toEqual({ numbers: [117, 17], total: 2 });
  });

  it('finds a client’s receipts by phone digits written any way', async () => {
    await sell(1, ivan.id);
    await sell(2, anna.id, NOW + 1000);
    await sell(3, anna.id, NOW + 2000);
    await sell(4, null, NOW + 3000);
    expect(await search(q('555'))).toEqual({ numbers: [3, 2], total: 2 });
    expect(await search(q('+7 (999) 555-00'))).toEqual({ numbers: [3, 2], total: 2 });
    expect(await search(q('8 999 123'))).toEqual({ numbers: [1], total: 1 });
    expect(await search(q('9991234567'))).toEqual({ numbers: [1], total: 1 });
    expect(await search(q('+7'))).toEqual({ numbers: [3, 2, 1], total: 3 });
  });

  it('finds a client’s receipts by name in any case, «ё» as «е»', async () => {
    await sell(1, ivan.id);
    await sell(2, anna.id, NOW + 1000);
    await sell(3, yolka.id, NOW + 2000);
    await sell(4, null, NOW + 3000);
    expect(await search(q('ПЕТРОВ'))).toEqual({ numbers: [1], total: 1 });
    expect(await search(q('анна сидорова'))).toEqual({ numbers: [2], total: 1 });
    expect(await search(q('елкина'))).toEqual({ numbers: [3], total: 1 });
    expect(await search(q('Алёна'))).toEqual({ numbers: [3], total: 1 });
    expect(await search(q('ан'))).toEqual({ numbers: [2, 1], total: 2 });
    expect(await search(q('100%'))).toEqual({ numbers: [], total: 0 });
    // A blank search lists everything.
    expect(await search(q('   '))).toEqual({ numbers: [4, 3, 2, 1], total: 4 });
  });

  it('combines the search with the period, the client and paging', async () => {
    await sell(1, anna.id, NOW - 3 * DAY);
    await sell(2, ivan.id, NOW - DAY);
    await sell(3, anna.id, NOW);
    await sell(4, anna.id, NOW + 1000);
    const from = new Date(NOW - 2 * DAY).toISOString();
    expect(await search(`${q('сидорова')}&from=${from}`)).toEqual({ numbers: [4, 3], total: 2 });
    expect(await search(`${q('сидорова')}&to=${from}`)).toEqual({ numbers: [1], total: 1 });
    expect(await search(`${q('сидорова')}&clientId=${ivan.id}`)).toEqual({ numbers: [], total: 0 });
    expect(await search(`${q('2')}&clientId=${ivan.id}`)).toEqual({ numbers: [2], total: 1 });
    expect(await search(`${q('сидорова')}&limit=1&offset=1`)).toEqual({ numbers: [3], total: 3 });
    const tooLong = await t.api('GET', `/api/sales?${q('x'.repeat(101))}`);
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json().error.message).toBe('«Поиск»: максимум 100 символов');
  });
});
