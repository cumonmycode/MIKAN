import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allocateDiscount } from '../src/domain/reports.js';
import { createTestApp, make, type TestApp } from './helpers.js';

const at = (iso: string) => vi.setSystemTime(Date.parse(iso));

// The studio is in Moscow (UTC+3); the test process runs in Asia/Tomsk (UTC+7, see vitest.config.ts).
const FROM = '2026-10-12T21:00:00.000Z'; // Tue 13 Oct 00:00 Moscow
const TO = '2026-10-15T21:00:00.000Z'; // Fri 16 Oct 00:00 Moscow
const PREVIOUS_FROM = '2026-10-09T21:00:00.000Z'; // the three days before

interface Size {
  id: number;
  name: string;
}

describe('GET /reports/analytics', () => {
  let t: TestApp;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026-10-09T06:00:00.000Z');
    t = await createTestApp();
  });
  afterEach(async () => {
    await t.close();
    vi.useRealTimers();
  });

  const ok = async (method: 'POST' | 'PATCH' | 'PUT', url: string, body: object) => {
    const res = await t.api(method, url, body);
    if (res.statusCode !== 200) throw new Error(`${method} ${url} → ${res.statusCode}: ${res.body}`);
    return res.json();
  };
  const analytics = async (from = FROM, to = TO) => {
    const res = await t.api('GET', `/api/reports/analytics?from=${from}&to=${to}`);
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  /**
   * Three studio days (13–15 Oct) and the three days before them: sales with a discount, sizes with their own and
   * the product's cost, a product without cost, refunds of this and of the previous period, appointments of every
   * outcome, stock write-offs and consumables, cash shifts (selling needs one) and a prepayment.
   */
  async function seedStudio() {
    const anna = await make(t, '/api/employees', { name: 'Анна', login: 'anna', password: 'pass123', isMaster: true, color: '#00AA00' });
    const helix = await make(t, '/api/services', { name: 'Прокол хеликса', category: 'piercing', price: 3000, durationMin: 30 });
    const tattoo = await make(t, '/api/services', { name: 'Тату мини', category: 'tattoo', price: 5000, durationMin: 60 });
    const labret = await make(t, '/api/products', {
      kind: 'jewelry',
      name: 'Лабрет',
      price: 1000,
      cost: 400,
      variants: [
        { name: '6 мм', initialQuantity: 10 },
        { name: '8 мм', price: 1200, cost: 500, initialQuantity: 10 },
      ],
    });
    const [six, eight] = (labret.variants as Size[]).map((v) => v.id) as [number, number];
    const ring = await make(t, '/api/products', { kind: 'jewelry', name: 'Кольцо', price: 2000, initialQuantity: 5 });
    const gloves = await make(t, '/api/products', { kind: 'consumable', name: 'Перчатки', price: 0, cost: 10, initialQuantity: 100 });
    const needles = await make(t, '/api/products', { kind: 'consumable', name: 'Игла', price: 0, initialQuantity: 10 });

    // Previous period: Ivan buys, a shift closes even, Oleg has a completed visit without a sale (imported history).
    at('2026-10-10T05:00:00.000Z');
    await ok('POST', '/api/cash/shift/open', { openingCash: 500 });
    const ivan = await make(t, '/api/clients', { name: 'Иван', lastName: 'Петров', phone: '+79990000101' });
    const oleg = await make(t, '/api/clients', { name: 'Олег', phone: '+79990000102' });
    at('2026-10-10T12:00:00.000Z');
    await ok('POST', '/api/sales', {
      clientId: ivan.id,
      items: [{ type: 'product', productId: labret.id, variantId: six, quantity: 1 }],
      discount: 0,
      payments: { cash: 1000 },
    });
    at('2026-10-10T18:00:00.000Z');
    await ok('POST', '/api/cash/shift/close', { closingCash: 1500 });
    at('2026-10-10T18:30:00.000Z');
    await make(t, '/api/appointments', {
      clientId: oleg.id, masterId: 1, startsAt: '2026-10-11T07:00:00Z', endsAt: '2026-10-11T08:00:00Z', status: 'completed',
    });
    // A short shift for one sale: the takings leave with the collector, the drawer stays as it was.
    at('2026-10-11T09:00:00.000Z');
    await ok('POST', '/api/cash/shift/open', { openingCash: 1500 });
    at('2026-10-11T10:00:00.000Z');
    const piercing = await ok('POST', '/api/sales', { items: [{ type: 'service', name: 'Пирсинг', price: 800 }], discount: 0, payments: { cash: 800 } });
    await ok('POST', '/api/cash/operations', { type: 'out', amount: 800, reason: 'Инкассация' });
    await ok('POST', '/api/cash/shift/close', { closingCash: 1500 });

    // This period.
    at('2026-10-12T21:10:00.000Z');
    await ok('POST', '/api/cash/shift/open', { openingCash: 1200 });
    const maria = await make(t, '/api/clients', { name: 'Мария', phone: '+79990000103' });
    const visit = await make(t, '/api/appointments', {
      clientId: ivan.id, masterId: anna.id, services: [{ serviceId: helix.id }, { name: 'Подбор украшения', price: 0 }],
      startsAt: '2026-10-12T21:00:00Z',
    });
    await make(t, '/api/appointments', { clientId: maria.id, masterId: anna.id, serviceId: tattoo.id, startsAt: '2026-10-14T07:00:00Z', status: 'no_show' });
    await make(t, '/api/appointments', {
      clientId: maria.id, masterId: 1, services: [{ name: 'Эскиз', price: 2000 }], startsAt: '2026-10-15T07:00:00Z',
      endsAt: '2026-10-15T08:00:00Z', status: 'cancelled',
    });
    const upcoming = await make(t, '/api/appointments', { clientId: ivan.id, masterId: anna.id, serviceId: helix.id, startsAt: '2026-10-15T10:00:00Z' });

    at('2026-10-12T21:30:00.000Z'); // 00:30 on Tuesday 13 Oct in Moscow, still 12 Oct in UTC
    await ok('POST', '/api/sales', {
      clientId: ivan.id,
      appointmentId: visit.id,
      items: [
        { type: 'service', serviceId: helix.id, quantity: 1 },
        { type: 'product', productId: labret.id, variantId: eight, quantity: 1 },
      ],
      discount: 420,
      payments: { cash: 3780 },
    });
    at('2026-10-13T06:00:00.000Z');
    await ok('POST', '/api/cash/operations', { type: 'in', amount: 500, reason: 'Размен' });
    await ok('POST', '/api/cash/operations', { type: 'out', amount: 2000, reason: 'Инкассация' });
    at('2026-10-13T08:00:00.000Z');
    await ok('POST', `/api/sales/${piercing.id}/refund`, { reason: 'Передумал', restock: true });
    at('2026-10-13T18:00:00.000Z');
    // Expected: 1200 + 3780 − 800 (cash refund) + 500 − 2000 = 2680.
    await ok('POST', '/api/cash/shift/close', { closingCash: 2600 });

    // The next shift opens with what the last one left and stays open.
    at('2026-10-14T08:00:00.000Z');
    await ok('POST', '/api/cash/shift/open', { openingCash: 2600 });
    at('2026-10-14T09:00:00.000Z');
    const consult = await ok('POST', '/api/sales', { items: [{ type: 'service', name: 'Консультация', price: 500 }], discount: 0, payments: { transfer: 500 } });
    at('2026-10-14T10:00:00.000Z');
    await ok('POST', `/api/sales/${consult.id}/refund`, { reason: 'Ошибка', restock: true });
    at('2026-10-14T11:00:00.000Z');
    await ok('POST', `/api/products/${labret.id}/movements`, { type: 'writeoff', variantId: six, quantity: 2, note: 'Брак' });
    await ok('POST', `/api/products/${gloves.id}/movements`, { type: 'usage', quantity: 5 });
    await ok('POST', `/api/products/${needles.id}/movements`, { type: 'usage', quantity: 3 });
    at('2026-10-14T12:00:00.000Z'); // Wednesday 15:00 Moscow
    await ok('POST', '/api/sales', {
      clientId: oleg.id,
      items: [{ type: 'product', productId: labret.id, variantId: eight, quantity: 2 }],
      discount: 0,
      payments: { cash: 2400 },
    });
    at('2026-10-14T13:00:00.000Z');
    await ok('POST', `/api/appointments/${upcoming.id}/deposit`, { amount: 1000, method: 'transfer' });
    at('2026-10-15T20:30:00.000Z'); // Thursday 23:30 Moscow — already 16 Oct in Tomsk
    await ok('POST', '/api/sales', {
      clientId: maria.id,
      items: [
        { type: 'product', productId: ring.id, quantity: 2 },
        { type: 'product', productId: labret.id, variantId: six, quantity: 1 },
      ],
      discount: 0,
      payments: { transfer: 5000 },
    });
    at('2026-10-15T20:45:00.000Z');
    return { anna, helix, labret, six, eight, ring, gloves, needles, ivan, oleg, maria };
  }

  it('reports revenue, refunds, payments and the previous period of the same length', async () => {
    await seedStudio();
    const r = await analytics();
    expect(r).toMatchObject({ from: FROM, to: TO, previousFrom: PREVIOUS_FROM, previousTo: FROM, timezone: 'Europe/Moscow' });
    // Made: 3780 + 500 + 2400 + 5000; refunded in the period: 800 (made earlier) + 500 (made and refunded now).
    expect(r.revenue).toEqual({
      gross: 11_680,
      refunds: 1300,
      refundsCount: 2,
      net: 10_380,
      salesCount: 4,
      averageCheck: 2920,
      discounts: 420,
      kept: 11_180,
      payments: { cash: 6180, card: 0, transfer: 5500, qr: 0, deposit: 0, bonus: 0, certificate: 0 },
    });
    expect(r.totals).toEqual({
      net: 10_380,
      gross: 11_680,
      refunds: 1300,
      salesCount: 4,
      averageCheck: 2920,
      discounts: 420,
      servicesRevenue: 2700,
      productsRevenue: 8480,
      cogs: 1900,
      grossProfit: 2580,
      marginPercent: 57.6,
      stockExpenses: 850,
      newClients: 1,
      appointmentsCompleted: 1,
      noShows: 1,
      noShowLoss: 5000,
      depositsReceived: 1000,
    });
    // The previous three days: Ivan's labret and the piercing refunded later (still made then, not kept).
    expect(r.previous).toEqual({
      net: 1800,
      gross: 1800,
      refunds: 0,
      salesCount: 2,
      averageCheck: 900,
      discounts: 0,
      servicesRevenue: 0,
      productsRevenue: 1000,
      cogs: 400,
      grossProfit: 600,
      marginPercent: 60,
      stockExpenses: 0,
      newClients: 2,
      appointmentsCompleted: 1,
      noShows: 0,
      noShowLoss: 0,
      depositsReceived: 0,
    });
    expect(r.deposits).toMatchObject({ received: 1000, transfer: 1000, held: 1000 });
  });

  it('buckets days, weekdays and hours in the studio timezone', async () => {
    await seedStudio();
    const r = await analytics();
    expect(r.byDay).toEqual([
      { date: '2026-10-13', gross: 3780, refunds: 800, net: 2980, salesCount: 1 },
      { date: '2026-10-14', gross: 2900, refunds: 500, net: 2400, salesCount: 2 },
      { date: '2026-10-15', gross: 5000, refunds: 0, net: 5000, salesCount: 1 },
    ]);
    expect(r.byWeekday).toHaveLength(7);
    expect(r.byWeekday.filter((d: { salesCount: number }) => d.salesCount > 0)).toEqual([
      { weekday: 2, revenue: 3780, salesCount: 1 },
      { weekday: 3, revenue: 2400, salesCount: 1 },
      { weekday: 4, revenue: 5000, salesCount: 1 },
    ]);
    expect(r.byHour).toHaveLength(24);
    expect(r.byHour.map((h: { hour: number }) => h.hour)).toEqual([...Array(24).keys()]);
    expect(r.byHour.filter((h: { salesCount: number }) => h.salesCount > 0)).toEqual([
      { hour: 0, revenue: 3780, salesCount: 1 },
      { hour: 15, revenue: 2400, salesCount: 1 },
      { hour: 23, revenue: 5000, salesCount: 1 },
    ]);

    // Another studio timezone moves the same sale to another hour and day.
    await ok('PUT', '/api/settings/studio', { timezone: 'Asia/Vladivostok' }); // UTC+10
    const far = await analytics('2026-10-15T14:00:00.000Z', '2026-10-16T14:00:00.000Z'); // 16 Oct in Vladivostok
    expect(far.byDay).toEqual([{ date: '2026-10-16', gross: 5000, refunds: 0, net: 5000, salesCount: 1 }]);
    expect(far.byHour.find((h: { salesCount: number }) => h.salesCount > 0)).toEqual({ hour: 6, revenue: 5000, salesCount: 1 });
    expect(far.byWeekday.find((d: { salesCount: number }) => d.salesCount > 0)).toMatchObject({ weekday: 5 });
  });

  it('splits services and products with the discount allocated and margins from size and product costs', async () => {
    const { helix, labret, six, eight, ring } = await seedStudio();
    const r = await analytics();
    // 420 off 3000 + 1200: the service takes round(420 × 3000 / 4200) = 300, the labret the remaining 120.
    expect(allocateDiscount([{ total: 3000 }, { total: 1200 }], 420)).toEqual([2700, 1080]);
    expect(r.services).toEqual({
      quantity: 1,
      revenue: 2700,
      byCategory: [{ category: 'piercing', quantity: 1, revenue: 2700 }],
      top: [{ serviceId: helix.id, name: 'Прокол хеликса', category: 'piercing', quantity: 1, revenue: 2700 }],
    });
    // 8 мм has its own cost (500), 6 мм uses the product's (400), the ring has none.
    expect(r.products).toMatchObject({
      quantity: 6,
      revenue: 8480,
      revenueWithCost: 4480,
      cogs: 1900,
      grossProfit: 2580,
      marginPercent: 57.6,
      itemsWithoutCost: 2,
      byKind: [{ kind: 'jewelry', quantity: 6, revenue: 8480, cogs: 1900, grossProfit: 2580, marginPercent: 57.6, itemsWithoutCost: 2 }],
    });
    expect(r.products.top).toEqual([
      {
        productId: labret.id, name: 'Лабрет', kind: 'jewelry',
        quantity: 4, revenue: 4480, revenueWithCost: 4480, cogs: 1900, grossProfit: 2580, marginPercent: 57.6, itemsWithoutCost: 0,
        variants: [
          { variantId: eight, name: '8 мм', quantity: 3, revenue: 3480, revenueWithCost: 3480, cogs: 1500, grossProfit: 1980, marginPercent: 56.9, itemsWithoutCost: 0 },
          { variantId: six, name: '6 мм', quantity: 1, revenue: 1000, revenueWithCost: 1000, cogs: 400, grossProfit: 600, marginPercent: 60, itemsWithoutCost: 0 },
        ],
      },
      {
        productId: ring.id, name: 'Кольцо', kind: 'jewelry',
        quantity: 2, revenue: 4000, revenueWithCost: 0, cogs: 0, grossProfit: 0, marginPercent: null, itemsWithoutCost: 2,
        variants: [{ variantId: ring.variants[0].id, name: '', quantity: 2, revenue: 4000, revenueWithCost: 0, cogs: 0, grossProfit: 0, marginPercent: null, itemsWithoutCost: 2 }],
      },
    ]);
  });

  it('values write-offs, consumables and the stock on hand at cost', async () => {
    const { labret, gloves, needles } = await seedStudio();
    const r = await analytics();
    expect(r.stock).toMatchObject({
      writeoffs: { quantity: 2, value: 800, unitsWithoutCost: 0 },
      usage: { quantity: 8, value: 50, unitsWithoutCost: 3 },
      expenses: 850,
    });
    expect(r.stock.top).toEqual([
      { productId: labret.id, name: 'Лабрет', kind: 'jewelry', type: 'writeoff', quantity: 2, value: 800 },
      { productId: gloves.id, name: 'Перчатки', kind: 'consumable', type: 'usage', quantity: 5, value: 50 },
      { productId: needles.id, name: 'Игла', kind: 'consumable', type: 'usage', quantity: 3, value: 0 },
    ]);
    // Labret 6 мм: 6 × 400, 8 мм: 7 × 500; 3 rings without cost; gloves 95 × 10; 7 needles without cost.
    expect(r.stock.onHand).toEqual({
      units: 118,
      value: 6850,
      unitsWithoutCost: 10,
      byKind: [
        { kind: 'jewelry', units: 16, value: 5900, unitsWithoutCost: 3 },
        { kind: 'consumable', units: 102, value: 950, unitsWithoutCost: 7 },
      ],
    });
  });

  it('reports the cash register, masters, clients and appointments', async () => {
    const { anna, ivan, oleg, maria } = await seedStudio();
    const r = await analytics();
    expect(r.cash).toMatchObject({
      cashIn: 500,
      cashOut: 2000,
      operationsCount: 2,
      shiftsClosed: 1,
      closingDifference: -80,
      shortage: -80,
      surplus: 0,
      openingDifference: -300,
    });
    expect(r.cash.shifts).toEqual([
      expect.objectContaining({
        openingCash: 1200, closingCash: 2600, expectedCash: 2680, openingDifference: -300, difference: -80,
        closedAt: '2026-10-13T18:00:00.000Z', closedBy: { id: 1, name: 'Админ', color: expect.any(String) },
      }),
    ]);

    expect(r.masters).toEqual([
      {
        employee: { id: anna.id, name: 'Анна', color: '#00AA00' },
        revenue: 3780, salesCount: 1, averageCheck: 3780, appointmentsCompleted: 1, noShows: 1, servicesCount: 2,
      },
    ]);

    expect(r.appointments).toEqual({ total: 4, open: 1, completed: 1, cancelled: 1, noShow: 1, noShowLoss: 5000, cancelledValue: 2000 });

    // Ivan bought before, Oleg visited before (no sale), Maria is new.
    expect(r.clients).toMatchObject({
      newClients: 1,
      buyers: 3,
      firstTime: { count: 1, revenue: 5000 },
      returning: { count: 2, revenue: 6180 },
      anonymous: { salesCount: 0, revenue: 0 },
    });
    expect(r.clients.top.map((c: { client: { id: number }; revenue: number; salesCount: number; visits: number }) => [c.client.id, c.revenue, c.salesCount, c.visits])).toEqual([
      [maria.id, 5000, 1, 0],
      [ivan.id, 3780, 1, 1],
      [oleg.id, 2400, 1, 0],
    ]);
    expect(r.clients.top[1].client).toEqual({ id: ivan.id, name: 'Иван', lastName: 'Петров', phone: '+79990000101', telegramLinked: false });
  });

  it('returns zeros for an empty period and validates the range like the summary', async () => {
    const r = await analytics('2026-09-30T21:00:00.000Z', '2026-10-01T21:00:00.000Z');
    expect(r.previousFrom).toBe('2026-09-29T21:00:00.000Z');
    expect(r.totals).toMatchObject({ net: 0, gross: 0, salesCount: 0, averageCheck: 0, marginPercent: null, stockExpenses: 0 });
    expect(r.byDay).toEqual([{ date: '2026-10-01', gross: 0, refunds: 0, net: 0, salesCount: 0 }]);
    expect(r.byWeekday.every((d: { revenue: number }) => d.revenue === 0)).toBe(true);
    expect(r).toMatchObject({
      services: { quantity: 0, revenue: 0, byCategory: [], top: [] },
      products: { quantity: 0, revenue: 0, byKind: [], top: [], marginPercent: null },
      masters: [],
      clients: { buyers: 0, top: [] },
      cash: { shiftsClosed: 0, shifts: [] },
    });

    const message = async (query: string) => (await t.api('GET', `/api/reports/analytics?${query}`)).json().error;
    expect(await message(`from=${TO}&to=${FROM}`)).toEqual({ code: 'validation_error', message: 'Конец периода должен быть позже начала' });
    expect(await message('from=2020-01-01T00:00:00Z&to=2026-01-01T00:00:00Z')).toEqual({
      code: 'validation_error',
      message: 'Период отчёта — не больше 400 дней',
    });
    expect((await t.api('GET', '/api/reports/analytics?from=x&to=y')).statusCode).toBe(400);
    expect((await t.api('GET', '/api/reports/analytics')).statusCode).toBe(400);
  });

  it('keeps /reports/summary unchanged for older app builds', async () => {
    await seedStudio();
    const summary = (await t.api('GET', `/api/reports/summary?from=${FROM}&to=${TO}`)).json();
    expect(Object.keys(summary)).toEqual([
      'from', 'to', 'revenue', 'salesCount', 'averageCheck', 'refunds', 'payments', 'deposits', 'servicesRevenue',
      'productsRevenue', 'byDay', 'topProducts', 'topServices', 'byMaster', 'newClients', 'appointmentsCompleted', 'noShows',
    ]);
    // Revenue there counts only the kept sales.
    expect(summary).toMatchObject({ revenue: 11_180, salesCount: 3, refunds: 1300, servicesRevenue: 2700, productsRevenue: 8480 });
    expect(summary.byDay[0]).toEqual({ date: '2026-10-13', revenue: 3780, salesCount: 1 });
  });
});
