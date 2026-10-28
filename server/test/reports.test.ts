import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, make, type TestApp } from './helpers.js';

const at = (iso: string) => vi.setSystemTime(Date.parse(iso));

describe('reports & dashboard', () => {
  let t: TestApp;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026-10-13T06:00:00.000Z');
    t = await createTestApp();
  });
  afterEach(async () => {
    await t.close();
    vi.useRealTimers();
  });

  it('summarizes revenue, payments, item split, byDay with zeros, tops and masters', async () => {
    const anna = await make(t, '/api/employees', { name: 'Анна', login: 'anna', password: 'pass123', isMaster: true, color: '#00AA00' });
    const product = await make(t, '/api/products', { kind: 'jewelry', name: 'Лабрет', price: 1000, initialQuantity: 10, minQuantity: 2 });
    const service = await make(t, '/api/services', { name: 'Прокол хеликса', category: 'piercing', price: 3000, durationMin: 30 });
    const client = await make(t, '/api/clients', { name: 'Иван', phone: '+79990000101' });
    const appt = await make(t, '/api/appointments', { clientId: client.id, masterId: anna.id, serviceId: service.id, startsAt: '2026-10-13T07:00:00Z' });
    await make(t, '/api/appointments', { clientId: client.id, masterId: 1, startsAt: '2026-10-14T07:00:00Z', endsAt: '2026-10-14T08:00:00Z', status: 'no_show' });

    at('2026-10-13T07:30:00.000Z');
    await make(t, '/api/sales', {
      appointmentId: appt.id,
      items: [
        { type: 'service', serviceId: service.id, quantity: 1 },
        { type: 'product', productId: product.id, quantity: 1 },
      ],
      discount: 400,
      payments: { cash: 3600 },
    });
    at('2026-10-15T08:00:00.000Z');
    await make(t, '/api/sales', { items: [{ type: 'product', productId: product.id, quantity: 2, price: 1500 }], discount: 0, payments: { card: 3000 } });
    const refunded = await make(t, '/api/sales', { items: [{ type: 'service', name: 'Консультация', price: 500 }], discount: 0, payments: { transfer: 500 } });
    at('2026-10-15T09:00:00.000Z');
    await t.api('POST', `/api/sales/${refunded.id}/refund`, { reason: 'Отмена', restock: true });

    const from = '2026-10-12T21:00:00.000Z'; // Oct 13 00:00 Moscow
    const to = '2026-10-15T21:00:00.000Z'; // Oct 16 00:00 Moscow
    const res = await t.api('GET', `/api/reports/summary?from=${from}&to=${to}`);
    expect(res.statusCode).toBe(200);
    const r = res.json();
    expect(r).toMatchObject({
      from,
      to,
      revenue: 6600,
      salesCount: 2,
      averageCheck: 3300,
      refunds: 500,
      payments: { cash: 3600, card: 3000, transfer: 0 },
      servicesRevenue: 2700,
      productsRevenue: 3900,
      newClients: 1,
      appointmentsCompleted: 1,
      noShows: 1,
    });
    expect(r.byDay).toEqual([
      { date: '2026-10-13', revenue: 3600, salesCount: 1 },
      { date: '2026-10-14', revenue: 0, salesCount: 0 },
      { date: '2026-10-15', revenue: 3000, salesCount: 1 },
    ]);
    expect(r.topProducts).toEqual([
      {
        productId: product.id,
        name: 'Лабрет',
        quantity: 3,
        revenue: 3900,
        variants: [{ variantId: product.variants[0].id, name: '', quantity: 3, revenue: 3900 }],
      },
    ]);
    expect(r.topServices).toEqual([{ serviceId: service.id, name: 'Прокол хеликса', quantity: 1, revenue: 2700 }]);
    expect(r.byMaster).toEqual([{ employee: { id: anna.id, name: 'Анна', color: '#00AA00' }, appointmentsCompleted: 1, revenue: 3600 }]);

    expect((await t.api('GET', `/api/reports/summary?from=${to}&to=${from}`)).statusCode).toBe(400);
    expect((await t.api('GET', '/api/reports/summary?from=x&to=y')).statusCode).toBe(400);
    expect((await t.api('GET', '/api/reports/summary?from=2020-01-01T00:00:00Z&to=2026-01-01T00:00:00Z')).statusCode).toBe(400);

    const empty = (await t.api('GET', '/api/reports/summary?from=2026-09-30T21:00:00Z&to=2026-10-01T21:00:00Z')).json();
    expect(empty).toMatchObject({ revenue: 0, salesCount: 0, averageCheck: 0, topProducts: [], byMaster: [] });
    expect(empty.byDay).toEqual([{ date: '2026-10-01', revenue: 0, salesCount: 0 }]);

    // Dashboard: "today" is the studio-local day (Oct 15).
    const dash = (await t.api('GET', '/api/dashboard')).json();
    expect(dash).toMatchObject({ date: '2026-10-15', revenueToday: 3000, salesCountToday: 1, openShift: null });
    expect(dash.appointments).toEqual([]);
    expect(dash.badges).toEqual({ unreadChats: 0, needsAttention: 0, newBookingRequests: 0, lowStock: 0, smmReview: 0 });
  });

  it('lists today’s non-cancelled appointments on the dashboard and counts low stock', async () => {
    at('2026-10-15T20:30:00.000Z'); // 23:30 Moscow, still Oct 15 locally (Oct 16 in Tomsk)
    const client = await make(t, '/api/clients', { name: 'Иван', phone: '+79990000101' });
    const a1 = await make(t, '/api/appointments', { clientId: client.id, masterId: 1, startsAt: '2026-10-15T06:00:00Z', endsAt: '2026-10-15T07:00:00Z' });
    const a2 = await make(t, '/api/appointments', { clientId: client.id, masterId: 1, startsAt: '2026-10-15T08:00:00Z', endsAt: '2026-10-15T09:00:00Z' });
    await make(t, '/api/appointments', { clientId: client.id, masterId: 1, startsAt: '2026-10-16T08:00:00Z', endsAt: '2026-10-16T09:00:00Z' });
    await t.api('PATCH', `/api/appointments/${a2.id}`, { status: 'cancelled' });
    await make(t, '/api/products', { kind: 'consumable', name: 'Перчатки', price: 0, initialQuantity: 1, minQuantity: 5 });
    const dash = (await t.api('GET', '/api/dashboard')).json();
    expect(dash.date).toBe('2026-10-15');
    expect(dash.appointments.map((a: { id: number }) => a.id)).toEqual([a1.id]);
    expect((await t.api('GET', '/api/badges')).json().lowStock).toBe(1);
  });
});
