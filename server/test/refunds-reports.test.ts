import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, make, openShift, type TestApp } from './helpers.js';

type Json = Record<string, any>;

const at = (iso: string) => vi.setSystemTime(Date.parse(iso));

// The studio is in Moscow (UTC+3).
const DAY13 = '2026-10-12T21:00:00.000Z'; // Tue 13 Oct 00:00 Moscow
const DAY14 = '2026-10-13T21:00:00.000Z';
const DAY16 = '2026-10-15T21:00:00.000Z';

/** Everywhere money is counted, a partly refunded sale counts by what of it is kept (docs/API.md «Reports»). */
describe('partial refunds in reports, analytics, payroll and the cash register', () => {
  let t: TestApp;
  let anna: { id: number };
  let labret: { id: number; variants: Array<{ id: number }> };
  let lobe: { id: number };
  let helix: { id: number };
  let client: { id: number };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026-10-13T06:00:00.000Z');
    t = await createTestApp();
    anna = await make(t, '/api/employees', { name: 'Анна', login: 'anna', password: 'pass123', isMaster: true });
    labret = await make(t, '/api/products', { kind: 'jewelry', name: 'Лабрет', price: 1500, cost: 600, variants: [{ name: '8 мм', initialQuantity: 10 }] });
    lobe = await make(t, '/api/services', { name: 'Прокол мочки', category: 'piercing', price: 2500, durationMin: 30 });
    helix = await make(t, '/api/services', { name: 'Прокол хеликса', category: 'piercing', price: 3000, durationMin: 30 });
    client = await make(t, '/api/clients', { name: 'Ирина', phone: '+79991234567' });
    await openShift(t, 1000);
  });
  afterEach(async () => {
    await t.close();
    vi.useRealTimers();
  });

  const ok = async (method: 'GET' | 'POST' | 'PUT', url: string, body?: Json) => {
    const res = await t.api(method, url, body);
    if (res.statusCode !== 200) throw new Error(`${method} ${url} → ${res.statusCode}: ${res.body}`);
    return res.json();
  };
  const visit = (serviceIds: number[]) =>
    make(t, '/api/appointments', {
      clientId: client.id,
      masterId: anna.id,
      services: serviceIds.map((serviceId) => ({ serviceId })),
      startsAt: '2026-10-13T08:00:00.000Z',
    });
  /** 13 Oct, 12:00 Moscow: Anna's visit paid — 2 × «Лабрет — 8 мм» + «Прокол мочки» − 550 = 4 950. */
  async function paidVisit() {
    const appointment = await visit([lobe.id]);
    at('2026-10-13T09:00:00.000Z');
    return ok('POST', '/api/sales', {
      clientId: client.id,
      appointmentId: appointment.id,
      items: [
        { type: 'product', productId: labret.id, variantId: labret.variants[0]!.id, quantity: 2, price: 1500 },
        { type: 'service', serviceId: lobe.id, quantity: 1 },
      ],
      discount: 550,
      payments: { cash: 2950, transfer: 2000 },
    });
  }
  const refund = (sale: Json, body: Json = {}) => ok('POST', `/api/sales/${sale.id}/refund`, { reason: 'Возврат', restock: true, ...body });
  const oneLabret = (sale: Json) => ({ items: [{ saleItemId: sale.items[0].id, quantity: 1 }] });
  const summary = (from = DAY13, to = DAY16) => ok('GET', `/api/reports/summary?from=${from}&to=${to}`);
  const analytics = (from = DAY13, to = DAY16) => ok('GET', `/api/reports/analytics?from=${from}&to=${to}`);
  const statement = () => ok('GET', `/api/payroll/${anna.id}?from=2026-10-01&to=2026-10-31`);

  it('counts the refund on its own day by its money and the kept units everywhere else', async () => {
    await ok('PUT', `/api/employees/${anna.id}/pay-rules`, { effectiveFrom: '2026-10-01', servicePercent: 40, productPercent: 10 });
    const sale = await paidVisit();
    expect((await statement()).products).toEqual({ revenue: 2700, amount: 270 });

    // 14 Oct: one labret comes back — 1 350 (cash 805, transfer 545).
    at('2026-10-14T09:00:00.000Z');
    await refund(sale, oneLabret(sale));

    const shift = (await ok('GET', '/api/cash/shift/current')).shift;
    expect(shift.summary).toMatchObject({ salesCount: 1, revenue: 4950, cash: 2950, transfer: 2000, refunds: 1350, cashRefunds: 805 });
    expect(shift.expectedCash).toBe(1000 + 2950 - 805);

    const s = await summary();
    expect(s).toMatchObject({
      revenue: 3600,
      salesCount: 1,
      averageCheck: 3600,
      refunds: 1350,
      payments: { cash: 2145, card: 0, transfer: 1455, qr: 0, deposit: 0 },
      servicesRevenue: 2250,
      productsRevenue: 1350,
      byMaster: [{ employee: { id: anna.id }, appointmentsCompleted: 1, revenue: 3600 }],
    });
    expect(s.byDay.slice(0, 2)).toEqual([
      { date: '2026-10-13', revenue: 3600, salesCount: 1 },
      { date: '2026-10-14', revenue: 0, salesCount: 0 },
    ]);
    expect(s.topProducts).toEqual([
      { productId: labret.id, name: 'Лабрет', quantity: 1, revenue: 1350, variants: [{ variantId: labret.variants[0]!.id, name: '8 мм', quantity: 1, revenue: 1350 }] },
    ]);
    expect(s.topServices).toEqual([{ serviceId: lobe.id, name: 'Прокол мочки', quantity: 1, revenue: 2250 }]);
    expect(await summary(DAY14, DAY16)).toMatchObject({ revenue: 0, salesCount: 0, refunds: 1350 });

    const a = await analytics();
    expect(a.revenue).toMatchObject({ gross: 4950, refunds: 1350, refundsCount: 1, net: 3600, kept: 3600, salesCount: 1 });
    expect(a.byDay.slice(0, 2)).toEqual([
      { date: '2026-10-13', gross: 4950, refunds: 0, net: 4950, salesCount: 1 },
      { date: '2026-10-14', gross: 0, refunds: 1350, net: -1350, salesCount: 0 },
    ]);
    expect(a.byWeekday[1]).toEqual({ weekday: 2, revenue: 3600, salesCount: 1 });
    expect(a.services).toMatchObject({ quantity: 1, revenue: 2250, top: [{ serviceId: lobe.id, quantity: 1, revenue: 2250 }] });
    const margins = { quantity: 1, revenue: 1350, revenueWithCost: 1350, cogs: 600, grossProfit: 750, marginPercent: 55.6, itemsWithoutCost: 0 };
    expect(a.products).toMatchObject({ ...margins, byKind: [{ kind: 'jewelry', ...margins }] });
    expect(a.products.top).toEqual([
      { productId: labret.id, name: 'Лабрет', kind: 'jewelry', ...margins, variants: [{ variantId: labret.variants[0]!.id, name: '8 мм', ...margins }] },
    ]);
    expect(a.revenue.kept).toBe(a.services.revenue + a.products.revenue);
    expect(a.masters).toEqual([expect.objectContaining({ employee: expect.objectContaining({ id: anna.id }), revenue: 3600, salesCount: 1 })]);
    expect(a.clients).toMatchObject({ buyers: 1, firstTime: { count: 1, revenue: 3600 }, top: [{ client: { id: client.id }, revenue: 3600 }] });
    expect(a.loyalty).toMatchObject({ bonusEarned: 247 - 67 });
    // The day of the sale alone: the refund falls into the next period.
    expect((await analytics(DAY13, DAY14)).revenue).toMatchObject({ gross: 4950, refunds: 0, net: 4950, kept: 3600 });

    const p = await statement();
    expect(p).toMatchObject({ services: { visits: 1, revenue: 2250, amount: 900 }, products: { revenue: 1350, amount: 135 } });
    expect(p.lines.map((l: Json) => [l.kind, l.name, l.revenue, l.amount])).toEqual([
      ['service', 'Прокол мочки', 2250, 900],
      ['product', 'Лабрет — 8 мм', 1350, 135],
    ]);

    // The rest comes back too: the sale behaves as a refunded sale did before.
    await refund(sale);
    expect((await ok('GET', '/api/cash/shift/current')).shift.summary).toMatchObject({ refunds: 4950, cashRefunds: 2950 });
    expect(await summary()).toMatchObject({ revenue: 0, salesCount: 0, refunds: 4950, payments: { cash: 0, transfer: 0 }, topProducts: [] });
    const after = await analytics();
    expect(after.revenue).toMatchObject({ gross: 4950, refunds: 4950, refundsCount: 2, net: 0, kept: 0 });
    expect(after.products.quantity).toBe(0);
    expect(after.loyalty.bonusEarned).toBe(0);
    expect((await statement())).toMatchObject({ services: { revenue: 0, amount: 0 }, products: { revenue: 0, amount: 0 }, lines: [] });
  });

  it('counts a refund like the sale: bonuses and sold certificates are not revenue, the drawer counts money', async () => {
    await ok('POST', `/api/clients/${client.id}/bonuses`, { amount: 900, note: 'Старт' });
    const labrets = (quantity: number) => ({ type: 'product', productId: labret.id, variantId: labret.variants[0]!.id, quantity, price: 1500 });
    at('2026-10-13T09:00:00.000Z');
    const withBonus = await ok('POST', '/api/sales', { clientId: client.id, items: [labrets(2)], discount: 0, payments: { cash: 2100, bonus: 900 } });
    const withCertificate = await ok('POST', '/api/sales', {
      items: [{ type: 'certificate', price: 5000 }, labrets(1)],
      discount: 0,
      payments: { cash: 6500 },
    });
    // Revenue: 3 000 − 900 bonuses, and 6 500 − the 5 000 certificate sold.
    at('2026-10-14T09:00:00.000Z');
    await refund(withBonus, oneLabret(withBonus)); // 1 500: cash 1 050 + bonuses 450 → revenue 1 050
    await refund(withCertificate, { items: [{ saleItemId: withCertificate.items[0].id, quantity: 1 }] }); // 5 000 cash, no revenue

    const a = await analytics();
    expect(a.revenue).toMatchObject({ gross: 3600, refunds: 1050, refundsCount: 2, net: 2550, kept: 2550 });
    expect(a.products).toMatchObject({ quantity: 2, revenue: 2550 });
    expect(await summary()).toMatchObject({ revenue: 2550, salesCount: 2, refunds: 1050, productsRevenue: 2550 });
    expect((await ok('GET', '/api/cash/shift/current')).shift.summary).toMatchObject({ refunds: 1050 + 5000, cashRefunds: 1050 + 5000 });
  });

  it('keeps the dashboard, the client card and «Рост» on what is kept', async () => {
    const sale = await paidVisit();
    await refund(sale, oneLabret(sale));
    expect(await ok('GET', '/api/dashboard')).toMatchObject({ revenueToday: 3600, salesCountToday: 1 });
    expect((await ok('GET', `/api/clients/${client.id}`)).stats).toMatchObject({ visits: 1, totalSpent: 3600 });
    const growth = await ok('GET', `/api/reports/growth?from=${DAY13}&to=${DAY16}`);
    expect(growth.value).toMatchObject({ clientsWithVisits: 1, averageRevenuePerClient: 3600 });
    expect(growth.sources).toEqual([{ source: 'не указан', newClients: 1, revenue: 3600 }]);

    await refund(sale);
    expect(await ok('GET', '/api/dashboard')).toMatchObject({ revenueToday: 0, salesCountToday: 0 });
    expect((await ok('GET', `/api/clients/${client.id}`)).stats.totalSpent).toBe(0);
  });

  it('marks history lines returned in full as refunded while the rest of the sale is kept', async () => {
    const appointment = await visit([lobe.id, helix.id]);
    const sale = await ok('POST', '/api/sales', {
      clientId: client.id,
      appointmentId: appointment.id,
      items: [
        { type: 'service', serviceId: lobe.id, quantity: 1 },
        { type: 'service', serviceId: helix.id, quantity: 1 },
        { type: 'product', productId: labret.id, variantId: labret.variants[0]!.id, quantity: 2, price: 1500 },
      ],
      payments: { cash: 8500 },
      discount: 0,
    });
    const history = async () =>
      new Map(((await ok('GET', `/api/clients/${client.id}/history`)).items as Json[]).map((e) => [e.name, e.refunded]));
    const [lobeItem, , labretItem] = sale.items;

    await refund(sale, { items: [{ saleItemId: labretItem.id, quantity: 1 }] });
    expect(Object.fromEntries(await history())).toEqual({ 'Прокол мочки': false, 'Прокол хеликса': false, 'Лабрет — 8 мм': false });
    await refund(sale, { items: [{ saleItemId: labretItem.id, quantity: 1 }, { saleItemId: lobeItem.id, quantity: 1 }] });
    expect(Object.fromEntries(await history())).toEqual({ 'Прокол мочки': true, 'Прокол хеликса': false, 'Лабрет — 8 мм': true });
    await refund(sale);
    expect(Object.fromEntries(await history())).toEqual({ 'Прокол мочки': true, 'Прокол хеликса': true, 'Лабрет — 8 мм': true });
  });
});
