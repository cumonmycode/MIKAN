import type { InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expireBonusLots } from '../src/domain/bonuses.js';
import { DAY_MS } from '../src/lib/time.js';
import { createTestApp, make, openShift, type TestApp } from './helpers.js';

type Json = Record<string, any>;

const NOW = Date.parse('2026-10-15T09:00:00.000Z');

/** Bonuses, gift certificates and prepayments given back by partial refunds (docs/API.md «SaleRefund»). */
describe('partial refunds: bonuses, certificates and prepayments', () => {
  let t: TestApp;
  let api: TestApp['api'];
  let labret: { id: number };
  let lobe: { id: number };
  let client: { id: number };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    t = await createTestApp();
    api = t.api;
    labret = await make(t, '/api/products', { kind: 'jewelry', name: 'Лабрет', price: 1500, initialQuantity: 10 });
    lobe = await make(t, '/api/services', { name: 'Прокол мочки', category: 'piercing', price: 2500, durationMin: 30 });
    client = await make(t, '/api/clients', { name: 'Анна', phone: '+79991234567' });
    await openShift(t);
  });
  afterEach(async () => {
    vi.useRealTimers();
    await t.close();
  });

  const ok = async (method: 'GET' | 'POST', url: string, body?: Json) => {
    const res = await api(method, url, body);
    if (res.statusCode !== 200) throw new Error(`${method} ${url} → ${res.statusCode}: ${res.body}`);
    return res.json();
  };
  const sell = (body: Json) => ok('POST', '/api/sales', { discount: 0, ...body });
  const twoLabrets = () => ({ type: 'product', productId: labret.id, quantity: 2, price: 1500 });
  const refund = (id: number, body: Json = {}) => ok('POST', `/api/sales/${id}/refund`, { reason: 'Возврат', restock: true, ...body });
  const preview = (id: number, body: Json = {}) => ok('POST', `/api/sales/${id}/refund/preview`, body);
  const oneOf = (sale: Json, index = 0) => ({ items: [{ saleItemId: sale.items[index].id, quantity: 1 }] });
  const ledger = () => ok('GET', `/api/clients/${client.id}/bonuses`);
  const adjust = (amount: number, note: string) => ok('POST', `/api/clients/${client.id}/bonuses`, { amount, note });
  /** Refunds and checks that the preview said exactly what was recorded. */
  const refundAsPreviewed = async (sale: Json, body: Json = {}) => {
    const planned = await preview(sale.id, body);
    const after = await refund(sale.id, body);
    const recorded = after.refunds.at(-1);
    expect({ amount: recorded.amount, items: recorded.items, payments: recorded.payments, bonusTakenBack: recorded.bonusTakenBack }).toEqual({
      amount: planned.amount,
      items: planned.items,
      payments: planned.payments,
      bonusTakenBack: planned.bonusTakenBack,
    });
    return recorded as Json;
  };

  it('gives back the bonuses paid in the returned part and takes back the earned ones in proportion', async () => {
    await adjust(1000, 'Старт');
    const sale = await sell({ clientId: client.id, items: [twoLabrets()], payments: { cash: 2100, bonus: 900 } });
    expect(sale.bonusEarned).toBe(105); // floor(5 % × 2 100)
    expect((await ledger()).balance).toBe(205);

    const first = await refundAsPreviewed(sale, oneOf(sale));
    // Bonus base 2 100, this refund returns 1 500 − 450 of it: floor(105 × 1 050 / 2 100) = 52.
    expect(first).toMatchObject({ amount: 1500, payments: { cash: 1050, bonus: 450 }, bonusTakenBack: 52 });
    const afterFirst = await ledger();
    expect(afterFirst.balance).toBe(205 + 450 - 52);
    expect(afterFirst.items.slice(0, 2).map((o: Json) => [o.type, o.amount, o.note])).toEqual([
      ['reverse', -52, `Частичный возврат чека №${sale.number}: начисленные бонусы списаны`],
      ['reverse', 450, `Частичный возврат чека №${sale.number}: бонусы, оплаченные в чеке, вернулись`],
    ]);

    const last = await refundAsPreviewed(sale);
    expect(last).toMatchObject({ amount: 1500, payments: { cash: 1050, bonus: 450 }, bonusTakenBack: 53 });
    // As if the whole receipt had been refunded at once.
    expect((await ledger()).balance).toBe(1000);
    expect((await ok('GET', `/api/sales/${sale.id}`)).bonusEarned).toBe(105);
  });

  it('never takes back more than the client has, and a later refund owes only its own share', async () => {
    const sale = await sell({ clientId: client.id, items: [twoLabrets()], payments: { cash: 3000 } }); // +150
    await adjust(-150, 'Списали');
    expect(await refundAsPreviewed(sale, oneOf(sale))).toMatchObject({ bonusTakenBack: 0 });
    expect((await ledger()).items[0]).toMatchObject({ type: 'adjust' });
    await adjust(40, 'Подарок');
    // The rest owes 150 − 75; the client has 40.
    expect(await refundAsPreviewed(sale)).toMatchObject({ bonusTakenBack: 40 });
    expect((await ledger()).balance).toBe(0);
  });

  it('does not take back earned bonuses that burnt between two refunds', async () => {
    await api('PUT', '/api/settings/retention', { loyalty: { expiryDays: 30 } });
    const sale = await sell({ clientId: client.id, items: [twoLabrets()], payments: { cash: 3000 } }); // +150, burning in 30 days
    expect(await refundAsPreviewed(sale, oneOf(sale))).toMatchObject({ bonusTakenBack: 75 });
    expect((await ledger()).balance).toBe(75);

    vi.setSystemTime(NOW + 31 * DAY_MS);
    const signIn = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'admin', password: 'secret123' } });
    const headers = { authorization: `Bearer ${signIn.json<{ token: string }>().token}` };
    api = (method, url, payload) =>
      t.app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as InjectOptions['payload'] }) });
    expect(expireBonusLots(t.ctx.db, Date.now())).toEqual({ lots: 1, amount: 75 });

    // 75 taken back + 75 burnt = everything the sale earned: nothing more is owed.
    expect(await refundAsPreviewed(sale)).toMatchObject({ bonusTakenBack: 0 });
    const ops = (await ledger()).items.filter((o: Json) => o.saleId === sale.id).map((o: Json) => [o.type, o.amount]);
    expect(ops).toEqual([
      ['expire', -75],
      ['reverse', -75],
      ['earn', 150],
    ]);
  });

  it('still takes back the earned bonuses when the bonuses a partial refund gave back burnt meanwhile', async () => {
    await api('PUT', '/api/settings/retention', { loyalty: { expiryDays: 30 } });
    await adjust(1000, 'Старт');
    const sale = await sell({ clientId: client.id, items: [twoLabrets()], payments: { cash: 2100, bonus: 900 } });
    expect(sale.bonusEarned).toBe(105);
    await adjust(-205, 'Потратила всё'); // the earned 105 are spent, not burnt

    const first = await refundAsPreviewed(sale, oneOf(sale));
    expect(first).toMatchObject({ payments: { bonus: 450 }, bonusTakenBack: 52 });
    vi.setSystemTime(NOW + 31 * DAY_MS);
    expireBonusLots(t.ctx.db, Date.now()); // the 450 given back (less the 52 taken) burn

    const last = await refundAsPreviewed(sale);
    // The sale's own earnings never burnt: the rest of them is owed, as if refunded at once.
    expect(last).toMatchObject({ payments: { bonus: 450 }, bonusTakenBack: 53 });
    expect((await ledger()).balance).toBe(450 - 53);
  });

  it('gives the certificate part back to the latest redemption first', async () => {
    const certificate = async (price: number) => {
      const sold = await sell({ clientId: client.id, items: [{ type: 'certificate', price }], payments: { cash: price } });
      return { code: sold.items[0].certificateCode as string, id: sold.items[0].certificateId as number };
    };
    const first = await certificate(2000);
    const second = await certificate(3000);
    const sale = await sell({
      items: [twoLabrets()],
      payments: { cash: 500, certificates: [{ code: first.code, amount: 1000 }, { code: second.code, amount: 1500 }] },
    });
    const balance = async (id: number) => (await ok('GET', `/api/certificates/${id}`)).balance;
    expect([await balance(first.id), await balance(second.id)]).toEqual([1000, 1500]);

    // 1 500 in proportion to cash 500 / certificates 2 500 → 250 + 1 250, all onto the later redemption.
    expect(await refundAsPreviewed(sale, oneOf(sale))).toMatchObject({ payments: { cash: 250, certificate: 1250 } });
    expect([await balance(first.id), await balance(second.id)]).toEqual([1000, 2750]);
    expect(await refundAsPreviewed(sale)).toMatchObject({ payments: { cash: 250, certificate: 1250 } });
    expect([await balance(first.id), await balance(second.id)]).toEqual([2000, 3000]);
    const ops = (await ok('GET', `/api/certificates/${second.id}`)).operations.map((o: Json) => [o.type, o.amount]);
    expect(ops.slice(-2)).toEqual([
      ['refund', 1250],
      ['refund', 250],
    ]);
    expect((await ok('GET', `/api/certificates/${second.id}`)).status).toBe('active');
  });

  it('cancels a certificate when its line is returned, unless it is partly spent', async () => {
    const both = await sell({
      clientId: client.id,
      items: [{ type: 'certificate', price: 5000 }, { type: 'product', productId: labret.id, quantity: 1, price: 1500 }],
      payments: { cash: 6500 },
    });
    const certificateId = both.items[0].certificateId as number;
    await refund(both.id, oneOf(both, 1));
    expect(await ok('GET', `/api/certificates/${certificateId}`)).toMatchObject({ status: 'active', balance: 5000 });
    const rest = await refund(both.id);
    expect(rest).toMatchObject({ status: 'refunded', refundedTotal: 6500 });
    expect(rest.refunds[1]).toMatchObject({ amount: 5000, items: [{ name: both.items[0].name, quantity: 1, amount: 5000 }] });
    const cancelled = await ok('GET', `/api/certificates/${certificateId}`);
    expect(cancelled).toMatchObject({ status: 'cancelled', balance: 0 });
    expect(cancelled.operations.at(-1)).toMatchObject({ type: 'cancel', amount: -5000, saleId: both.id });

    const spentSale = await sell({
      clientId: client.id,
      items: [{ type: 'certificate', price: 4000 }, { type: 'service', serviceId: lobe.id, quantity: 1 }],
      payments: { cash: 6500 },
    });
    const code = spentSale.items[0].certificateCode as string;
    await sell({ items: [{ type: 'service', serviceId: lobe.id, quantity: 1 }], payments: { cash: 1500, certificates: [{ code, amount: 1000 }] } });
    const message = `Сертификат ${code} уже частично оплачен покупками — его нельзя вернуть`;
    for (const body of [oneOf(spentSale, 0), {}]) {
      for (const url of [`/api/sales/${spentSale.id}/refund`, `/api/sales/${spentSale.id}/refund/preview`]) {
        const res = await api('POST', url, { reason: 'Передумали', restock: true, ...body });
        expect(res.statusCode).toBe(409);
        expect(res.json().error.message).toBe(message);
      }
    }
    expect((await refund(spentSale.id, oneOf(spentSale, 1))).refunds[0]).toMatchObject({ amount: 2500 });
    expect((await ok('GET', `/api/certificates/code/${code}`)).balance).toBe(3000);
  });

  it('holds the prepayment part of each refund for the appointment again; a partial refund leaves it paid', async () => {
    const appointment = await make(t, '/api/appointments', {
      clientId: client.id,
      masterId: 1,
      services: [{ serviceId: lobe.id }],
      startsAt: '2026-10-15T10:00:00.000Z',
    });
    await ok('POST', `/api/appointments/${appointment.id}/deposit`, { amount: 2000, method: 'transfer' });
    const items = [{ type: 'service', serviceId: lobe.id, quantity: 1 }, { type: 'product', productId: labret.id, quantity: 1, price: 1500 }];
    const sale = await sell({ appointmentId: appointment.id, items, payments: { cash: 2000, deposit: 2000 } });
    const held = async () => ok('GET', `/api/appointments/${appointment.id}`);

    expect(await refundAsPreviewed(sale, oneOf(sale, 1))).toMatchObject({ amount: 1500, payments: { cash: 750, deposit: 750 } });
    const partly = await held();
    expect(partly).toMatchObject({ deposit: 750, saleId: sale.id, status: 'completed' });
    expect(partly.depositOperations.at(-1)).toMatchObject({
      type: 'unapply', amount: 750, saleId: sale.id, note: `Частичный возврат чека №${sale.number}`,
    });
    const again = await api('POST', '/api/sales', { appointmentId: appointment.id, items: items.slice(0, 1), discount: 0, payments: { cash: 2500 } });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.message).toBe(`Запись уже оплачена (чек №${sale.number})`);

    expect(await refundAsPreviewed(sale)).toMatchObject({ amount: 2500, payments: { cash: 1250, deposit: 1250 } });
    const restored = await held();
    expect(restored.deposit).toBe(2000);
    expect(restored.depositOperations.filter((o: Json) => o.type === 'unapply').map((o: Json) => o.amount)).toEqual([750, 1250]);
    const shift = (await ok('GET', '/api/cash/shift/current')).shift;
    expect(shift.summary).toMatchObject({ refunds: 4000, cashRefunds: 2000 });

    const paidAgain = await sell({ appointmentId: appointment.id, items: items.slice(0, 1), payments: { cash: 500, deposit: 2000 } });
    expect((await held())).toMatchObject({ deposit: 0, saleId: paidAgain.id });
  });
});
