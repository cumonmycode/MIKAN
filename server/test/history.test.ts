import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, make, openShift, type TestApp } from './helpers.js';

const NOW = Date.parse('2026-10-15T09:00:00.000Z');

interface Entry {
  id: string;
  kind: string;
  date: string;
  name: string;
  serviceId: number | null;
  productId: number | null;
  quantity: number;
  price: number;
  total: number;
  client: { id: number } | null;
  employee: { id: number; name: string } | null;
  appointmentId: number | null;
  saleId: number | null;
  saleNumber: number | null;
  refunded: boolean;
}

describe('history: what was done for a client, who got a service, who bought a product', () => {
  let t: TestApp;
  let tattoo: { id: number };
  let piercing: { id: number };
  let labret: { id: number };
  let ivan: { id: number; name: string };
  let olga: { id: number };
  let maria: { id: number };

  const at = (iso: string) => vi.setSystemTime(Date.parse(iso));
  const get = async (url: string) => {
    const res = await t.api('GET', url);
    expect(res.statusCode).toBe(200);
    return res.json();
  };
  const ids = (items: Entry[]) => items.map((e) => e.id);

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    t = await createTestApp();
    await openShift(t);
    tattoo = await make(t, '/api/services', { name: 'Тату среднее', category: 'tattoo', price: 8000, durationMin: 120 });
    piercing = await make(t, '/api/services', { name: 'Соски', category: 'piercing', price: 2500, durationMin: 45 });
    labret = await make(t, '/api/products', { kind: 'jewelry', name: 'Лабрет', price: 1500, initialQuantity: 10 });
    ivan = await make(t, '/api/clients', { name: 'Иван', phone: '+79991234567' });
    olga = await make(t, '/api/clients', { name: 'Ольга', phone: '+79990000103' });
    maria = await make(t, '/api/employees', { name: 'Мария', login: 'maria', password: 'secret123', isMaster: true });
  });
  afterEach(async () => {
    await t.close();
    vi.useRealTimers();
  });

  /** Ivan: two completed visits (one paid by a sale), one upcoming, one cancelled, and a refunded standalone sale. */
  async function seedHistory() {
    const visit = await make(t, '/api/appointments', {
      clientId: ivan.id,
      masterId: maria.id,
      startsAt: '2026-10-10T10:00:00Z',
      services: [{ serviceId: piercing.id }, { name: 'Подбор украшения' }],
    });
    const titled = await make(t, '/api/appointments', {
      clientId: ivan.id,
      masterId: 1,
      title: 'Коррекция тату',
      price: 1500,
      startsAt: '2026-10-11T10:00:00Z',
      endsAt: '2026-10-11T11:00:00Z',
    });
    await t.api('POST', `/api/appointments/${titled.id}/complete`, { sendAftercare: false });
    await make(t, '/api/appointments', { clientId: ivan.id, masterId: 1, startsAt: '2026-10-20T10:00:00Z', services: [{ serviceId: tattoo.id }] });
    const cancelled = await make(t, '/api/appointments', {
      clientId: ivan.id, masterId: 1, startsAt: '2026-10-09T10:00:00Z', services: [{ serviceId: piercing.id }],
    });
    await t.api('PATCH', `/api/appointments/${cancelled.id}`, { status: 'cancelled' });

    // Paying for the visit completes it; its service item must not be listed twice.
    at('2026-10-12T12:00:00Z');
    const paid = await make(t, '/api/sales', {
      appointmentId: visit.id,
      items: [
        { type: 'service', serviceId: piercing.id, quantity: 1, price: 2500 },
        { type: 'product', productId: labret.id, quantity: 1, price: 1500 },
      ],
      discount: 0,
      payments: { card: 4000 },
    });
    at('2026-10-13T12:00:00Z');
    const standalone = await make(t, '/api/sales', {
      clientId: ivan.id,
      items: [
        { type: 'service', serviceId: tattoo.id, quantity: 1, price: 7000 },
        { type: 'product', productId: labret.id, quantity: 2, price: 1400 },
      ],
      discount: 0,
      payments: { card: 9800 },
    });
    at('2026-10-13T13:00:00Z');
    const olgaSale = await make(t, '/api/sales', {
      clientId: olga.id, items: [{ type: 'product', productId: labret.id, quantity: 1 }], discount: 0, payments: { cash: 1500 },
    });
    at('2026-10-14T13:00:00Z');
    const anonymous = await make(t, '/api/sales', {
      items: [
        { type: 'product', productId: labret.id, quantity: 1 },
        { type: 'service', serviceId: piercing.id, quantity: 1 },
      ],
      discount: 0,
      payments: { transfer: 4000 },
    });
    at('2026-10-14T15:00:00Z');
    const refund = await t.api('POST', `/api/sales/${standalone.id}/refund`, { reason: 'Передумал', restock: true });
    expect(refund.statusCode).toBe(200);
    vi.setSystemTime(NOW);
    return { visit, titled, paid, standalone, olgaSale, anonymous };
  }

  it('client history lists completed services and sale items newest first, without duplicates', async () => {
    const { visit, titled, paid, standalone } = await seedHistory();
    const body = await get(`/api/clients/${ivan.id}/history`);
    expect(body.appointments).toHaveLength(4);
    expect(body.sales.map((s: { id: number }) => s.id)).toEqual([standalone.id, paid.id]);

    const items = body.items as Entry[];
    const [visitPiercing, visitCustom] = visit.services as Array<{ id: number }>;
    const [standaloneService, standaloneProduct] = standalone.items as Array<{ id: number }>;
    const paidProduct = (paid.items as Array<{ id: number; type: string }>).find((i) => i.type === 'product')!;
    // Inside one visit the receipt / booking order is kept.
    expect(ids(items)).toEqual([
      `si${standaloneService!.id}`,
      `si${standaloneProduct!.id}`,
      `si${paidProduct.id}`,
      `at${titled.id}`,
      `as${visitPiercing!.id}`,
      `as${visitCustom!.id}`,
    ]);

    const ivanRef = { id: ivan.id, name: 'Иван', lastName: null, phone: '+79991234567', telegramLinked: false };
    const admin = { id: 1, name: 'Админ', color: '#FF7A1A' };
    expect(items[1]).toEqual({
      id: `si${standaloneProduct!.id}`,
      kind: 'product',
      date: '2026-10-13T12:00:00.000Z',
      name: 'Лабрет',
      serviceId: null,
      productId: labret.id,
      variantId: labret.variants[0].id,
      variantName: null,
      quantity: 2,
      price: 1400,
      total: 2800,
      client: ivanRef,
      employee: admin,
      appointmentId: null,
      saleId: standalone.id,
      saleNumber: standalone.number,
      refunded: true,
    });
    expect(items[0]).toMatchObject({ kind: 'service', name: 'Тату среднее', serviceId: tattoo.id, price: 7000, total: 7000, refunded: true });
    // A product sold together with the visit points at that appointment.
    expect(items[2]).toMatchObject({ kind: 'product', appointmentId: visit.id, saleId: paid.id, refunded: false });
    expect(items[3]).toEqual({
      id: `at${titled.id}`,
      kind: 'service',
      date: '2026-10-11T10:00:00.000Z',
      name: 'Коррекция тату',
      serviceId: null,
      productId: null,
      variantId: null,
      variantName: null,
      quantity: 1,
      price: 1500,
      total: 1500,
      client: ivanRef,
      employee: admin,
      appointmentId: titled.id,
      saleId: null,
      saleNumber: null,
      refunded: false,
    });
    expect(items[4]).toEqual({
      id: `as${visitPiercing!.id}`,
      kind: 'service',
      date: '2026-10-10T10:00:00.000Z',
      name: 'Соски',
      serviceId: piercing.id,
      productId: null,
      variantId: null,
      variantName: null,
      quantity: 1,
      price: 2500,
      total: 2500,
      client: ivanRef,
      employee: { id: maria.id, name: 'Мария', color: expect.any(String) },
      appointmentId: visit.id,
      saleId: paid.id,
      saleNumber: paid.number,
      refunded: false,
    });
    expect(items[5]).toMatchObject({ name: 'Подбор украшения', serviceId: null, price: 0, saleNumber: paid.number });

    // Olga only bought a product.
    expect((await get(`/api/clients/${olga.id}/history`)).items).toMatchObject([{ kind: 'product', productId: labret.id, quantity: 1 }]);
  });

  it('an untitled appointment without lines is listed as «Процедура»; refunding its sale flags it', async () => {
    const appt = await make(t, '/api/appointments', {
      clientId: ivan.id, masterId: 1, price: 2000, startsAt: '2026-10-14T10:00:00Z', endsAt: '2026-10-14T11:00:00Z',
    });
    const sale = await make(t, '/api/sales', {
      appointmentId: appt.id,
      items: [{ type: 'service', name: 'Процедура', quantity: 1, price: 2000 }],
      discount: 0,
      payments: { card: 2000 },
    });
    await t.api('POST', `/api/sales/${sale.id}/refund`, { reason: 'Ошибка', restock: false });
    const items = (await get(`/api/clients/${ivan.id}/history`)).items as Entry[];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: `at${appt.id}`, name: 'Процедура', price: 2000, saleId: sale.id, refunded: true });
  });

  it('services added at the checkout of a visit are listed once; the booked ones are not duplicated', async () => {
    const visit = await make(t, '/api/appointments', {
      clientId: ivan.id,
      masterId: 1,
      startsAt: '2026-10-14T10:00:00Z',
      services: [{ serviceId: piercing.id }, { name: 'Подбор украшения' }],
    });
    const sale = await make(t, '/api/sales', {
      appointmentId: visit.id,
      items: [
        { type: 'service', serviceId: piercing.id, name: 'Соски', quantity: 1, price: 2500 },
        { type: 'service', name: '  подбор  УКРАШЕНИЯ ', quantity: 1, price: 0 },
        { type: 'service', name: 'Замена украшения', quantity: 1, price: 300 },
        { type: 'service', serviceId: tattoo.id, quantity: 1, price: 7000 },
        { type: 'service', serviceId: piercing.id, quantity: 1, price: 2000 },
      ],
      discount: 0,
      payments: { card: 11800 },
    });
    const [, , replacement, extraTattoo, secondPiercing] = sale.items as Array<{ id: number }>;
    const [piercingLine, customLine] = visit.services as Array<{ id: number }>;

    const items = (await get(`/api/clients/${ivan.id}/history`)).items as Entry[];
    expect(ids(items).sort()).toEqual(
      [`as${piercingLine!.id}`, `as${customLine!.id}`, `si${replacement!.id}`, `si${extraTattoo!.id}`, `si${secondPiercing!.id}`].sort(),
    );
    expect(items.find((e) => e.id === `si${replacement!.id}`)).toMatchObject({
      kind: 'service', name: 'Замена украшения', price: 300, appointmentId: visit.id, saleId: sale.id, saleNumber: sale.number,
    });

    // A service sold on top of the booked ones shows up in that service's history.
    const tattooHistory = await get(`/api/services/${tattoo.id}/history`);
    expect(tattooHistory).toMatchObject({ total: 1, items: [{ id: `si${extraTattoo!.id}`, client: { id: ivan.id }, appointmentId: visit.id }] });
    const piercingHistory = await get(`/api/services/${piercing.id}/history`);
    expect(piercingHistory.total).toBe(2);
    expect(ids(piercingHistory.items).sort()).toEqual([`as${piercingLine!.id}`, `si${secondPiercing!.id}`].sort());
  });

  it('a single cart line for the whole visit is covered by the appointment; a cancelled visit leaves the sale items', async () => {
    // The apps put one line named after the visit into the cart when the line prices do not add up.
    const custom = await make(t, '/api/appointments', {
      clientId: ivan.id, masterId: 1, price: 3000, startsAt: '2026-10-12T10:00:00Z',
      services: [{ name: 'Коррекция', durationMin: 30 }, { name: 'Подбор украшения' }],
    });
    await make(t, '/api/sales', {
      appointmentId: custom.id,
      items: [{ type: 'service', name: 'Коррекция, Подбор украшения', quantity: 1, price: 3000 }],
      discount: 0,
      payments: { card: 3000 },
    });
    const titled = await make(t, '/api/appointments', {
      clientId: ivan.id, masterId: 1, title: 'Тату на предплечье', price: 9000, startsAt: '2026-10-13T10:00:00Z', endsAt: '2026-10-13T12:00:00Z',
    });
    await make(t, '/api/sales', {
      appointmentId: titled.id,
      items: [{ type: 'service', name: 'Тату на предплечье', quantity: 1, price: 9000 }],
      discount: 0,
      payments: { card: 9000 },
    });
    let items = (await get(`/api/clients/${ivan.id}/history`)).items as Entry[];
    expect(items.map((e) => e.id[0] + e.id[1])).toEqual(['at', 'as', 'as']);

    // Once the visit is no longer completed, its sale's items are the only record left.
    await t.api('PATCH', `/api/appointments/${titled.id}`, { status: 'cancelled' });
    items = (await get(`/api/clients/${ivan.id}/history`)).items as Entry[];
    expect(items[0]).toMatchObject({ kind: 'service', name: 'Тату на предплечье', appointmentId: titled.id, price: 9000 });
    expect(items[0]!.id.startsWith('si')).toBe(true);
    expect(items).toHaveLength(3);
  });

  it('service history: completed lines and standalone service items, paginated, 404 for unknown', async () => {
    const { visit, anonymous } = await seedHistory();
    const anonymousService = (anonymous.items as Array<{ id: number; type: string }>).find((i) => i.type === 'service')!;
    const piercingLine = (visit.services as Array<{ id: number; serviceId: number | null }>).find((l) => l.serviceId === piercing.id)!;

    const all = await get(`/api/services/${piercing.id}/history`);
    expect(all.total).toBe(2);
    expect(ids(all.items)).toEqual([`si${anonymousService.id}`, `as${piercingLine.id}`]);
    expect(all.items[0]).toMatchObject({ client: null, kind: 'service', serviceId: piercing.id, appointmentId: null });

    const first = await get(`/api/services/${piercing.id}/history?limit=1`);
    expect(first).toMatchObject({ total: 2, items: [{ id: `si${anonymousService.id}` }] });
    const second = await get(`/api/services/${piercing.id}/history?limit=1&offset=1`);
    expect(second).toMatchObject({ total: 2, items: [{ id: `as${piercingLine.id}`, client: { id: ivan.id } }] });
    expect((await get(`/api/services/${piercing.id}/history?offset=5`)).items).toEqual([]);

    // The upcoming tattoo appointment does not count; the refunded standalone sale does.
    const tattooHistory = await get(`/api/services/${tattoo.id}/history`);
    expect(tattooHistory.total).toBe(1);
    expect(tattooHistory.items[0]).toMatchObject({ kind: 'service', name: 'Тату среднее', refunded: true, client: { id: ivan.id } });

    expect((await t.api('GET', `/api/services/${piercing.id}/history?limit=500`)).statusCode).toBe(400);
    const missing = await t.api('GET', '/api/services/999/history');
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toEqual({ code: 'not_found', message: 'Услуга не найдена' });
  });

  it('product history: every sale of the product with buyer, quantity and refund flag', async () => {
    const { paid, standalone, olgaSale, anonymous } = await seedHistory();
    const body = await get(`/api/products/${labret.id}/history`);
    expect(body.total).toBe(4);
    expect(body.items.map((e: Entry) => [e.saleId, e.client?.id ?? null, e.quantity, e.total, e.refunded])).toEqual([
      [anonymous.id, null, 1, 1500, false],
      [olgaSale.id, olga.id, 1, 1500, false],
      [standalone.id, ivan.id, 2, 2800, true],
      [paid.id, ivan.id, 1, 1500, false],
    ]);
    expect(body.items.every((e: Entry) => e.kind === 'product' && e.productId === labret.id && e.serviceId === null)).toBe(true);

    const page = await get(`/api/products/${labret.id}/history?limit=2&offset=2`);
    expect(page.total).toBe(4);
    expect(page.items.map((e: Entry) => e.saleId)).toEqual([standalone.id, paid.id]);

    const missing = await t.api('GET', '/api/products/999/history');
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.message).toBe('Товар не найден');
  });
});
