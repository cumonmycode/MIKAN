import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, FakeQrProvider, make, openShift, type TestApp } from './helpers.js';

type Json = Record<string, any>;

describe('open receipts (POS)', () => {
  let t: TestApp;
  let bank: FakeQrProvider;
  let labret: { id: number; variants: Array<{ id: number }> };
  let lobe: { id: number };
  let helix: { id: number };
  let client: { id: number };

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
    lobe = await make(t, '/api/services', { name: 'Мочка', category: 'piercing', price: 1600, durationMin: 30 });
    helix = await make(t, '/api/services', { name: 'Хеликс', category: 'piercing', price: 2500, durationMin: 30 });
    client = await make(t, '/api/clients', { name: 'Анна', phone: '+79991234567' });
  });
  afterEach(async () => {
    await t.close();
  });

  const book = (extra: object = {}) =>
    make(t, '/api/appointments', {
      clientId: client.id,
      masterId: 1,
      services: [{ serviceId: lobe.id }, { serviceId: helix.id }],
      startsAt: '2026-10-18T11:00:00.000Z',
      ...extra,
    });
  const open = async (body: object) => {
    const res = await t.api('POST', '/api/receipts', body);
    if (res.statusCode !== 200) throw new Error(`POST /api/receipts → ${res.statusCode}: ${res.body}`);
    return res.json() as Json;
  };
  const list = async () => (await t.api('GET', '/api/receipts')).json().items as Json[];
  const appointment = async (id: number) => (await t.api('GET', `/api/appointments/${id}`)).json() as Json;
  const stockOf = async (variantId: number) =>
    (await t.api('GET', `/api/products/${labret.id}`)).json().variants.find((v: Json) => v.id === variantId).quantity;

  it('starting a visit opens a receipt with the appointment lines, client and prepayment', async () => {
    const a = await book();
    await t.api('POST', `/api/appointments/${a.id}/deposit`, { amount: 1000, method: 'transfer' });

    const receipt = await open({ appointmentId: a.id });
    expect(receipt).toMatchObject({
      client: { id: client.id, name: 'Анна' },
      subtotal: 4100,
      discount: 0,
      total: 4100,
      itemCount: 2,
      note: null,
      openedBy: { id: 1, name: 'Админ' },
      appointment: { id: a.id, deposit: 1000, receiptId: expect.any(Number) },
    });
    expect(receipt.items).toEqual([
      { type: 'service', productId: null, variantId: null, variantName: null, productKind: null, serviceId: lobe.id, name: 'Мочка', quantity: 1, price: 1600, total: 1600, stock: null, certificate: null },
      { type: 'service', productId: null, variantId: null, variantName: null, productKind: null, serviceId: helix.id, name: 'Хеликс', quantity: 1, price: 2500, total: 2500, stock: null, certificate: null },
    ]);
    expect((await appointment(a.id)).receiptId).toBe(receipt.id);

    // Another device starting the same visit gets the same receipt.
    const again = await open({ appointmentId: a.id });
    expect(again.id).toBe(receipt.id);
    expect(await list()).toHaveLength(1);
  });

  it('a price set for the whole appointment becomes one line named after its services', async () => {
    const a = await book({ price: 3500 });
    const receipt = await open({ appointmentId: a.id });
    expect(receipt.items).toEqual([expect.objectContaining({ name: 'Мочка, Хеликс', price: 3500, quantity: 1, serviceId: lobe.id })]);
    const custom = await book({ services: [], title: 'Тату, эскиз', price: 9000, startsAt: '2026-10-18T14:00:00.000Z', endsAt: '2026-10-18T17:00:00.000Z' });
    expect((await open({ appointmentId: custom.id })).items[0]).toMatchObject({ name: 'Тату, эскиз', price: 9000 });
  });

  it('saves edits, shows sizes with their stock and validates lines', async () => {
    const receipt = await open({});
    expect(receipt).toMatchObject({ appointment: null, client: null, items: [], total: 0, itemCount: 0 });

    const saved = await t.api('PUT', `/api/receipts/${receipt.id}`, {
      clientId: client.id,
      items: [
        { type: 'product', productId: labret.id, variantId: labret.variants[1]!.id, quantity: 1 },
        { type: 'service', name: 'Замена украшения', quantity: 2, price: 300 },
      ],
      discount: 200,
      note: 'Подарок',
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ client: { id: client.id }, subtotal: 2300, discount: 200, total: 2100, itemCount: 3, note: 'Подарок' });
    expect(saved.json().items[0]).toEqual({
      type: 'product', productId: labret.id, variantId: labret.variants[1]!.id, variantName: '8 мм', productKind: 'jewelry',
      serviceId: null, name: 'Лабрет — 8 мм', quantity: 1, price: 1700, total: 1700, stock: 1, certificate: null,
    });

    const noSize = await t.api('PUT', `/api/receipts/${receipt.id}`, { items: [{ type: 'product', productId: labret.id, quantity: 1 }] });
    expect(noSize.statusCode).toBe(400);
    expect(noSize.json().error.message).toBe('Выберите размер «Лабрет»');
    const consumable = await make(t, '/api/products', { kind: 'consumable', name: 'Игла', price: 0, initialQuantity: 5 });
    const sellConsumable = await t.api('PUT', `/api/receipts/${receipt.id}`, { items: [{ type: 'product', productId: consumable.id, quantity: 1 }] });
    expect(sellConsumable.json().error.message).toBe('«Игла» — расходник, его нельзя продать');
    const bigDiscount = await t.api('PUT', `/api/receipts/${receipt.id}`, { items: [{ type: 'service', name: 'Прокол', price: 100 }], discount: 500 });
    expect(bigDiscount.json().error.message).toBe('Скидка не может быть больше суммы чека');
    // Failed saves changed nothing; an open receipt never touches the stock.
    expect((await t.api('GET', `/api/receipts/${receipt.id}`)).json().total).toBe(2100);
    expect(await stockOf(labret.variants[1]!.id)).toBe(1);
  });

  it('deleting a receipt changes nothing else and the visit can be started again', async () => {
    const a = await book();
    await t.api('POST', `/api/appointments/${a.id}/deposit`, { amount: 1000, method: 'transfer' });
    const receipt = await open({ appointmentId: a.id });
    await t.api('PUT', `/api/receipts/${receipt.id}`, {
      appointmentId: a.id,
      clientId: client.id,
      items: [{ type: 'product', productId: labret.id, variantId: labret.variants[0]!.id, quantity: 1 }],
    });

    const deleted = await t.api('DELETE', `/api/receipts/${receipt.id}`);
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ ok: true });
    expect(await list()).toEqual([]);
    expect(await appointment(a.id)).toMatchObject({ receiptId: null, status: 'scheduled', deposit: 1000, saleId: null });
    expect(await stockOf(labret.variants[0]!.id)).toBe(2);

    const gone = await t.api('DELETE', `/api/receipts/${receipt.id}`);
    expect(gone.statusCode).toBe(404);
    expect(gone.json().error.message).toBe('Чек уже оплачен или удалён');
    expect((await t.api('PUT', `/api/receipts/${receipt.id}`, { items: [] })).statusCode).toBe(404);

    const reopened = await open({ appointmentId: a.id });
    expect(reopened.id).not.toBe(receipt.id);
    expect(reopened.items).toHaveLength(2);
  });

  it('paying the receipt sells it and closes the receipt', async () => {
    const a = await book();
    const receipt = await open({ appointmentId: a.id });
    const other = await open({ clientId: client.id });
    const sale = await t.api('POST', '/api/sales', {
      appointmentId: a.id,
      receiptId: receipt.id,
      items: [
        { type: 'service', serviceId: lobe.id, quantity: 1, price: 1600 },
        { type: 'service', serviceId: helix.id, quantity: 1, price: 2500 },
      ],
      discount: 0,
      payments: { cash: 0, card: 0, transfer: 4100, qr: 0, deposit: 0 },
    });
    expect(sale.statusCode).toBe(200);
    expect((await list()).map((r) => r.id)).toEqual([other.id]);
    expect(await appointment(a.id)).toMatchObject({ receiptId: null, status: 'completed', saleId: sale.json().id });

    const paid = await t.api('POST', '/api/receipts', { appointmentId: a.id });
    expect(paid.statusCode).toBe(409);
    expect(paid.json().error.message).toBe(`Запись уже оплачена (чек №${sale.json().number})`);

    // A walk-in receipt is closed by its own id.
    await t.api('POST', '/api/sales', {
      receiptId: other.id,
      items: [{ type: 'service', name: 'Консультация', price: 0 }],
      discount: 0,
      payments: { cash: 0, card: 0, transfer: 0, qr: 0, deposit: 0 },
    });
    expect(await list()).toEqual([]);
  });

  it('a sale for the appointment confirmed later through QR closes its receipt too', async () => {
    const a = await book();
    await open({ appointmentId: a.id });
    const qr = await t.api('POST', '/api/qr-payments', {
      appointmentId: a.id,
      items: [{ type: 'service', name: 'Мочка и хеликс', price: 4100 }],
      discount: 0,
      payments: { qr: 4100, deposit: 0 },
    });
    expect(qr.statusCode).toBe(200);
    expect(await list()).toHaveLength(1);
    bank.statuses.set('QR1', 'paid');
    expect((await t.api('GET', `/api/qr-payments/${qr.json().id}`)).json().status).toBe('paid');
    expect(await list()).toEqual([]);
  });

  it('cancelling the appointment or a no-show removes its receipt; a cancelled visit cannot be started', async () => {
    const a = await book();
    await open({ appointmentId: a.id });
    await t.api('PATCH', `/api/appointments/${a.id}`, { status: 'cancelled' });
    expect(await list()).toEqual([]);
    const cancelled = await t.api('POST', '/api/receipts', { appointmentId: a.id });
    expect(cancelled.statusCode).toBe(409);
    expect(cancelled.json().error.message).toBe('Запись отменена — верните её в расписание, чтобы открыть чек');

    const b = await book({ startsAt: '2026-10-18T15:00:00.000Z' });
    await open({ appointmentId: b.id });
    await t.api('PATCH', `/api/appointments/${b.id}`, { status: 'no_show' });
    expect(await list()).toEqual([]);
  });

  it('a receipt moves to another appointment only when that one has no receipt', async () => {
    const a = await book();
    const b = await book({ startsAt: '2026-10-18T15:00:00.000Z' });
    const first = await open({ appointmentId: a.id });
    const walkIn = await open({ clientId: client.id });
    const taken = await t.api('PUT', `/api/receipts/${walkIn.id}`, { appointmentId: a.id, items: [] });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error.message).toBe('По этой записи уже открыт другой чек');
    const moved = await t.api('PUT', `/api/receipts/${walkIn.id}`, { appointmentId: b.id, items: [] });
    expect(moved.json().appointment.id).toBe(b.id);
    // Detaching keeps the receipt and frees the appointment.
    const detached = await t.api('PUT', `/api/receipts/${first.id}`, { clientId: client.id, items: [] });
    expect(detached.json()).toMatchObject({ appointment: null, client: { id: client.id } });
    expect((await appointment(a.id)).receiptId).toBeNull();
  });

  it('opening a receipt is idempotent with the same key', async () => {
    const post = () =>
      t.app.inject({
        method: 'POST',
        url: '/api/receipts',
        payload: { clientId: client.id },
        headers: { authorization: `Bearer ${t.token}`, 'idempotency-key': '6f9619ff-8b86-4011-b42d-00c04fc964ff' },
      });
    const first = await post();
    const replay = await post();
    expect(replay.json().id).toBe(first.json().id);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(await list()).toHaveLength(1);
  });
});
