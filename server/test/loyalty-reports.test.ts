import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { creditGiftBonuses } from '../src/domain/bonuses.js';
import { expireLoyalty } from '../src/domain/loyalty.js';
import { createTestApp, make, openShift, type TestApp } from './helpers.js';
import { at, ok, setRules, staff, statement, visit } from './payroll-fixtures.js';

/** Loyalty in analytics, the summary, the dashboard, the cash shift and payroll (docs/API.md «Analytics», «PayRules»). */

const FROM = '2026-10-14T21:00:00.000Z'; // 15 Oct, Moscow
const TO = '2026-10-15T21:00:00.000Z';

describe('loyalty in reports and payroll', () => {
  let t: TestApp;
  let client: { id: number };
  let lobe: { id: number };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026-10-14T09:00:00.000Z');
    t = await createTestApp();
    client = await make(t, '/api/clients', { name: 'Анна', phone: '+79990001122' });
    lobe = await make(t, '/api/services', { name: 'Прокол мочки', category: 'piercing', price: 3000, durationMin: 30 });
  });
  afterEach(async () => {
    vi.useRealTimers();
    await t.close();
  });

  const sell = (body: Record<string, unknown>) => ok(t.api, 'POST', '/api/sales', { clientId: client.id, discount: 0, ...body });
  const service = (price = 3000) => ({ type: 'service', serviceId: lobe.id, quantity: 1, price });
  const certificate = (price: number) => ({ type: 'certificate', price, recipientName: 'Маше' });

  /** 13 Oct: a 200 gift valid through 14 Oct; 14 Oct: 1 000 bonuses by hand. 15 Oct: four receipts, one refunded. */
  async function day() {
    creditGiftBonuses(t.ctx.db, client.id, 200, 1, 'Подарок', Date.parse('2026-10-13T09:00:00.000Z'));
    await ok(t.api, 'POST', `/api/clients/${client.id}/bonuses`, { amount: 1000, note: 'Перенос' });
    at('2026-10-15T09:30:00.000Z');
    await ok(t.api, 'POST', '/api/cash/shift/open', { openingCash: 0 });
    at('2026-10-15T10:00:00.000Z');
    expireLoyalty(t.ctx.db);
    at('2026-10-15T10:05:00.000Z');
    const s1 = await sell({ items: [service()], payments: { cash: 2100, bonus: 900 } });
    at('2026-10-15T10:10:00.000Z');
    const s2 = await sell({ items: [certificate(5000)], payments: { cash: 5000 } });
    const code = s2.items[0].name.replace('Подарочный сертификат ', '');
    at('2026-10-15T10:15:00.000Z');
    const s3 = await sell({ items: [service()], payments: { transfer: 1000, certificates: [{ code, amount: 2000 }] } });
    at('2026-10-15T10:20:00.000Z');
    const s4 = await sell({ items: [certificate(1000), service(2000)], discount: 500, payments: { cash: 2500 } });
    at('2026-10-15T10:30:00.000Z');
    await ok(t.api, 'POST', `/api/sales/${s3.id}/refund`, { reason: 'Отказ', restock: true });
    at('2026-10-15T12:00:00.000Z');
    return { s1, s2, s3, s4 };
  }

  it('analytics: revenue without bonuses and certificate sales, payments with both, the loyalty section', async () => {
    await day();
    const r = (await t.api('GET', `/api/reports/analytics?from=${FROM}&to=${TO}`)).json();
    expect(r.revenue).toEqual({
      gross: 6600, // 2 100 + 0 + 3 000 + 1 500
      refunds: 3000,
      refundsCount: 1,
      net: 3600,
      salesCount: 4,
      averageCheck: 1650,
      discounts: 500,
      kept: 3600,
      payments: { cash: 9600, card: 0, transfer: 1000, qr: 0, deposit: 0, bonus: 900, certificate: 2000 },
    });
    expect(r.byDay).toEqual([{ date: '2026-10-15', gross: 6600, refunds: 3000, net: 3600, salesCount: 4 }]);
    expect(r.services).toMatchObject({ quantity: 2, revenue: 3600 });
    expect(r.services.top).toEqual([{ serviceId: lobe.id, name: 'Прокол мочки', category: 'piercing', quantity: 2, revenue: 3600 }]);
    expect(r.totals).toMatchObject({ gross: 6600, net: 3600, servicesRevenue: 3600, productsRevenue: 0 });
    expect(r.clients).toMatchObject({ buyers: 1, firstTime: { count: 1, revenue: 3600 } });
    expect(r.byHour.find((h: { hour: number }) => h.hour === 13)).toEqual({ hour: 13, revenue: 3600, salesCount: 3 });
    expect(r.loyalty).toEqual({
      bonusEarned: 180, // 105 + 50 + 75 earned, 50 taken back by the refund
      bonusSpent: 900,
      bonusExpired: 200,
      bonusOutstanding: 280, // 1 200 at the start + 180 − 900 − 200
      certificatesSold: 6000,
      certificatesRedeemed: 0, // 2 000 spent, given back by the refund
      certificatesExpired: 0,
      certificatesCancelled: 0,
      certificatesOutstanding: 6000,
    });
    const previous = (await t.api('GET', `/api/reports/analytics?from=2026-10-13T21:00:00.000Z&to=${FROM}`)).json();
    expect(previous.loyalty).toMatchObject({ bonusEarned: 1000, bonusSpent: 0, bonusOutstanding: 1200, certificatesOutstanding: 0 });
  });

  it('the summary, the dashboard and the cash shift count revenue and money the same way', async () => {
    await day();
    const summary = (await t.api('GET', `/api/reports/summary?from=${FROM}&to=${TO}`)).json();
    expect(summary).toMatchObject({ revenue: 3600, salesCount: 3, refunds: 3000, servicesRevenue: 3600, productsRevenue: 0 });
    expect(summary.topServices).toEqual([{ serviceId: lobe.id, name: 'Прокол мочки', quantity: 2, revenue: 3600 }]);
    expect(summary.payments).toEqual({ cash: 9600, card: 0, transfer: 0, qr: 0, deposit: 0 });
    expect((await t.api('GET', '/api/dashboard')).json()).toMatchObject({ revenueToday: 3600, salesCountToday: 3 });
    const shift = (await t.api('GET', '/api/cash/shift/current')).json().shift;
    // Money only: bonuses and certificate payments never enter the till; a certificate sold does.
    expect(shift.summary).toMatchObject({ salesCount: 4, revenue: 10600, cash: 9600, transfer: 1000, refunds: 1000, cashRefunds: 0 });
    expect(shift.expectedCash).toBe(9600);
  });

  it('payroll: bonuses paid act as a discount, certificate lines are not revenue', async () => {
    const fatima = await staff(t, 'Фатима', 'fatima', 'master');
    const ring = await make(t, '/api/products', { kind: 'jewelry', name: 'Кольцо', price: 1000, initialQuantity: 5 });
    await setRules(t, fatima.id, { effectiveFrom: '2026-10-01', servicePercent: 40, productPercent: 10 });
    await ok(t.api, 'POST', `/api/clients/${client.id}/bonuses`, { amount: 1500, note: 'Перенос' });
    const appointment = await visit(t, fatima.id, client.id, [lobe.id], '2026-10-15T08:00:00Z');
    at('2026-10-15T09:00:00.000Z');
    await openShift(t);
    // A 3 000 ₽ piercing and a 1 000 ₽ ring: 1 200 ₽ of bonuses split 900 / 300.
    const paid = await sell({
      appointmentId: appointment.id,
      items: [service(), { type: 'product', productId: ring.id, quantity: 1 }],
      payments: { cash: 2800, bonus: 1200 },
    });
    const gift = await ok(fatima.api, 'POST', '/api/sales', {
      items: [certificate(2000), { type: 'product', productId: ring.id, quantity: 1 }],
      discount: 0,
      payments: { cash: 3000 },
    });
    const s = await statement(t.api, fatima.id, '2026-10-01', '2026-10-31');
    expect(s.lines).toEqual([
      { date: '2026-10-15', kind: 'service', appointmentId: appointment.id, saleId: paid.id, name: 'Прокол мочки', category: 'piercing', revenue: 2100, materials: 0, percent: 40, amount: 840 },
      { date: '2026-10-15', kind: 'product', appointmentId: appointment.id, saleId: paid.id, name: 'Кольцо', category: null, revenue: 700, materials: 0, percent: 10, amount: 70 },
      { date: '2026-10-15', kind: 'product', appointmentId: null, saleId: gift.id, name: 'Кольцо', category: null, revenue: 1000, materials: 0, percent: 10, amount: 100 },
    ]);
    expect(s).toMatchObject({ services: { revenue: 2100, amount: 840 }, products: { revenue: 1700, amount: 170 } });
  });
});
