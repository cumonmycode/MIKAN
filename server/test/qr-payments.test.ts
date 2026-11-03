import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { qrPayments } from '../src/db/schema.js';
import { applyBankStatus, QR_GIVE_UP_MS, QR_SETTLE_GRACE_MS, sweepQrPayments } from '../src/domain/qr-payments.js';
import { setStaffChatId } from '../src/domain/settings.js';
import { formatRub } from '../src/lib/text.js';
import { QrProviderError } from '../src/payments/qr-provider.js';
import { createTestApp, FakeQrProvider, make, openShift, type TestApp } from './helpers.js';

const STAFF_CHAT = -100500;

describe('QR payments (SBP)', () => {
  let t: TestApp;
  let bank: FakeQrProvider;
  let product: { id: number };
  let service: { id: number };
  let client: { id: number };

  beforeEach(async () => {
    bank = new FakeQrProvider();
    t = await createTestApp({ qr: bank });
    await openShift(t);
    product = await make(t, '/api/products', { kind: 'jewelry', name: 'Лабрет', price: 1500, initialQuantity: 3 });
    service = await make(t, '/api/services', { name: 'Прокол мочки', category: 'piercing', price: 2500, durationMin: 30 });
    client = await make(t, '/api/clients', { name: 'Иван', phone: '+79991234567' });
  });
  afterEach(async () => {
    vi.useRealTimers();
    await t.close();
  });

  const body = (overrides: object = {}) => ({
    clientId: client.id,
    items: [
      { type: 'product', productId: product.id, quantity: 1, price: 1500 },
      { type: 'service', serviceId: service.id, quantity: 1 },
    ],
    discount: 0,
    payments: { cash: 1000, card: 0, transfer: 0, qr: 3000 },
    ...overrides,
  });

  const createQr = async (overrides: object = {}) => {
    const res = await t.api('POST', '/api/qr-payments', body(overrides));
    if (res.statusCode !== 200) throw new Error(`POST /api/qr-payments → ${res.statusCode}: ${res.body}`);
    return res.json();
  };

  const stock = async () => (await t.api('GET', `/api/products/${product.id}`)).json().quantity;

  it('reports whether QR payments are configured', async () => {
    expect((await t.api('GET', '/api/qr-payments/config')).json()).toEqual({ enabled: true });
    const bare = await createTestApp();
    try {
      expect((await bare.api('GET', '/api/qr-payments/config')).json()).toEqual({ enabled: false });
      const res = await bare.api('POST', '/api/qr-payments', { items: [{ type: 'service', name: 'Прокол', price: 100 }], discount: 0, payments: { qr: 100 } });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.message).toBe('Оплата по QR-коду не настроена на сервере');
    } finally {
      await bare.close();
    }
  });

  it('creates a pending QR for the QR share without selling anything yet', async () => {
    const qr = await createQr();
    expect(qr).toMatchObject({ status: 'pending', amount: 3000, payload: 'https://qr.nspk.ru/QR1?type=02&sum=300000', error: null, sale: null });
    expect(Date.parse(qr.expiresAt) - Date.parse(qr.createdAt)).toBe(10 * 60_000);
    expect(bank.created).toEqual([{ amount: 3000, purpose: 'Оплата услуг, MIKAN STUDIO', ttlMinutes: 10 }]);
    expect((await t.api('GET', '/api/sales')).json().total).toBe(0);
    expect(await stock()).toBe(3);
  });

  it('validates the cart before asking the bank', async () => {
    const mismatch = await t.api('POST', '/api/qr-payments', body({ payments: { cash: 0, qr: 1000 } }));
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().error.message).toBe('Сумма оплат (1 000 ₽) не совпадает с итогом (4 000 ₽)');
    const noQr = await t.api('POST', '/api/qr-payments', body({ payments: { cash: 4000 } }));
    expect(noQr.json().error.message).toBe('Укажите сумму оплаты по QR-коду');
    const tooMany = await t.api('POST', '/api/qr-payments', body({
      items: [{ type: 'product', productId: product.id, quantity: 4 }],
      payments: { qr: 6000 },
    }));
    expect(tooMany.statusCode).toBe(409);
    expect(tooMany.json().error.code).toBe('insufficient_stock');
    expect(bank.created).toHaveLength(0);
  });

  it('refuses QR money in a plain POST /sales', async () => {
    const res = await t.api('POST', '/api/sales', body());
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe('Оплату по QR-коду проводите через «Показать QR-код»');
  });

  it('reports a bank failure as 502 without storing a payment', async () => {
    bank.createFailure = new QrProviderError('Tochka register-qr: ETIMEDOUT');
    const res = await t.api('POST', '/api/qr-payments', body());
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toEqual({
      code: 'payment_provider_error',
      message: 'Банк не ответил. Попробуйте ещё раз или выберите другой способ оплаты.',
    });
    bank.createFailure = new QrProviderError('Tochka register-qr: HTTP 403 Forbidden by consent', 403);
    const refused = await t.api('POST', '/api/qr-payments', body());
    expect(refused.json().error.message).toBe(
      'Банк не выдал QR-код. Проверьте подключение оплаты по QR (СБП) в Точке — подробности в журнале сервера.',
    );
    expect(t.ctx.db.select().from(qrPayments).all()).toHaveLength(0);
  });

  it('sells at the prices of the moment the QR was shown', async () => {
    const qr = await createQr({ items: [{ type: 'service', serviceId: service.id }], payments: { qr: 2500 } });
    await t.api('PATCH', `/api/services/${service.id}`, { price: 3000 });
    bank.statuses.set('QR1', 'paid');
    const res = (await t.api('GET', `/api/qr-payments/${qr.id}`)).json();
    expect(res.error).toBeNull();
    expect(res.sale).toMatchObject({ total: 2500, payments: { qr: 2500 } });
  });

  it('asks the bank once for overlapping polls and sells once', async () => {
    const qr = await createQr();
    bank.statuses.set('QR1', 'paid');
    bank.statusDelayMs = 30;
    const [a, b] = await Promise.all([t.api('GET', `/api/qr-payments/${qr.id}`), t.api('GET', `/api/qr-payments/${qr.id}`)]);
    expect(a.json().sale.id).toBe(b.json().sale.id);
    expect(bank.statusChecks).toBe(1);
    expect((await t.api('GET', '/api/sales')).json().total).toBe(1);
  });

  it('creates exactly one sale once the bank reports the payment', async () => {
    const qr = await createQr();
    const waiting = (await t.api('GET', `/api/qr-payments/${qr.id}`)).json();
    expect(waiting).toMatchObject({ status: 'pending', sale: null });
    expect(bank.statusChecks).toBe(1);
    await t.api('GET', `/api/qr-payments/${qr.id}`);
    expect(bank.statusChecks).toBe(1);

    bank.statuses.set('QR1', 'paid');
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 3_000 });
    const paid = (await t.api('GET', `/api/qr-payments/${qr.id}`)).json();
    expect(paid.status).toBe('paid');
    expect(paid.error).toBeNull();
    expect(paid.sale).toMatchObject({
      number: 1,
      client: { id: client.id },
      total: 4000,
      payments: { cash: 1000, card: 0, transfer: 0, qr: 3000 },
      status: 'completed',
    });
    expect(await stock()).toBe(2);

    vi.setSystemTime(Date.now() + 10_000);
    const again = (await t.api('GET', `/api/qr-payments/${qr.id}`)).json();
    expect(again.sale.id).toBe(paid.sale.id);
    await sweepQrPayments(t.ctx);
    expect((await t.api('GET', '/api/sales')).json().total).toBe(1);
  });

  it('pays for an appointment and counts QR money in the shift and the report', async () => {
    const appt = await make(t, '/api/appointments', {
      clientId: client.id,
      masterId: 1,
      serviceId: service.id,
      startsAt: '2026-11-01T10:00:00.000Z',
    });
    const qr = await createQr({ appointmentId: appt.id, items: [{ type: 'service', serviceId: service.id }], payments: { qr: 2500 } });
    bank.statuses.set('QR1', 'paid');
    await sweepQrPayments(t.ctx);

    const sale = (await t.api('GET', `/api/qr-payments/${qr.id}`)).json().sale;
    expect((await t.api('GET', `/api/appointments/${appt.id}`)).json()).toMatchObject({ status: 'completed', saleId: sale.id });
    const shift = (await t.api('GET', '/api/cash/shift/current')).json().shift;
    expect(shift.summary).toMatchObject({ revenue: 2500, cash: 0, qr: 2500 });
    expect(shift.expectedCash).toBe(0);
    const from = new Date(Date.now() - 60_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    const report = (await t.api('GET', `/api/reports/summary?from=${from}&to=${to}`)).json();
    expect(report.payments).toEqual({ cash: 0, card: 0, transfer: 0, qr: 2500, deposit: 0 });
  });

  it('keeps waiting after a declined attempt and expires an unpaid code', async () => {
    const qr = await createQr();
    bank.statuses.set('QR1', 'rejected');
    const declined = (await t.api('GET', `/api/qr-payments/${qr.id}`)).json();
    expect(declined).toMatchObject({ status: 'pending', error: 'Банк клиента отклонил оплату. Клиент может попробовать ещё раз по этому же QR-коду.' });
    expect(applyBankStatus(t.ctx.db, qr.id, 'pending', Date.now() + 3000).error, 'the hint goes away with the next answer').toBeNull();

    const expiry = Date.parse(qr.expiresAt);
    expect(applyBankStatus(t.ctx.db, qr.id, 'pending', expiry + 1000).status).toBe('pending');
    expect(applyBankStatus(t.ctx.db, qr.id, 'pending', expiry + QR_SETTLE_GRACE_MS + 1).status).toBe('expired');
    expect(applyBankStatus(t.ctx.db, qr.id, 'paid', expiry + QR_SETTLE_GRACE_MS + 2).status).toBe('expired');
    expect((await t.api('GET', '/api/sales')).json().total).toBe(0);
  });

  it('flags a cancelled code the client paid anyway instead of selling the cart twice', async () => {
    setStaffChatId(t.ctx.db, STAFF_CHAT);
    const qr = await createQr();
    const cancelled = (await t.api('POST', `/api/qr-payments/${qr.id}/cancel`)).json();
    expect(cancelled).toMatchObject({ status: 'cancelled', sale: null });

    bank.statuses.set('QR1', 'paid');
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 3_000 });
    await sweepQrPayments(t.ctx);
    const late = (await t.api('GET', `/api/qr-payments/${qr.id}`)).json();
    expect(late).toMatchObject({ status: 'paid', sale: null });
    expect(late.error).toContain(`Клиент оплатил ${formatRub(3000)} по QR-коду уже после отмены`);
    expect((await t.api('GET', '/api/sales')).json().total).toBe(0);
    expect(t.gateway.textsTo(STAFF_CHAT)).toEqual([`⚠️ Оплата по QR №${qr.id} (${formatRub(3000)}): ${late.error}`]);
  });

  it('stops watching a cancelled code once the bank confirms it expired unpaid', async () => {
    const qr = await createQr();
    await t.api('POST', `/api/qr-payments/${qr.id}/cancel`);
    const expiry = Date.parse(qr.expiresAt);
    applyBankStatus(t.ctx.db, qr.id, 'pending', expiry + QR_SETTLE_GRACE_MS + 1);
    expect(applyBankStatus(t.ctx.db, qr.id, 'paid', expiry + QR_SETTLE_GRACE_MS + 2).status).toBe('cancelled');
  });

  it('completes instead of cancelling when the money has just arrived', async () => {
    const qr = await createQr();
    bank.statuses.set('QR1', 'paid');
    const res = (await t.api('POST', `/api/qr-payments/${qr.id}/cancel`)).json();
    expect(res.status).toBe('paid');
    expect(res.sale).not.toBeNull();
  });

  it('flags a payment whose cart can no longer be sold and tells staff', async () => {
    setStaffChatId(t.ctx.db, STAFF_CHAT);
    const qr = await createQr({ items: [{ type: 'product', productId: product.id, quantity: 3 }], payments: { qr: 4500 } });
    await t.api('POST', '/api/sales', { items: [{ type: 'product', productId: product.id, quantity: 1 }], discount: 0, payments: { cash: 1500 } });
    bank.statuses.set('QR1', 'paid');
    const res = (await t.api('GET', `/api/qr-payments/${qr.id}`)).json();
    expect(res).toMatchObject({
      status: 'paid',
      sale: null,
      error: `Оплата ${formatRub(4500)} получена, но продажа не проведена: Недостаточно на складе: Лабрет (осталось 2)`,
    });
    expect((await t.api('GET', '/api/sales')).json().total).toBe(1);
    expect(t.gateway.textsTo(STAFF_CHAT)).toHaveLength(1);
  });

  it('shows an unreachable bank to the cashier and gives up only when a payment could no longer be read', async () => {
    setStaffChatId(t.ctx.db, STAFF_CHAT);
    const qr = await createQr();
    bank.statusFailure = new Error('ECONNRESET');
    const waiting = (await t.api('GET', `/api/qr-payments/${qr.id}`)).json();
    expect(waiting).toMatchObject({ status: 'pending', error: 'Не удаётся связаться с банком — продолжаем проверять оплату.' });

    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse(qr.expiresAt) + QR_GIVE_UP_MS - 1000 });
    expect((await t.api('GET', `/api/qr-payments/${qr.id}`)).json().status, 'still watched within 24 h').toBe('pending');
    vi.setSystemTime(Date.parse(qr.expiresAt) + QR_GIVE_UP_MS + 1);
    const gaveUp = (await t.api('GET', `/api/qr-payments/${qr.id}`)).json();
    expect(gaveUp).toMatchObject({ status: 'expired', error: 'Банк так и не подтвердил оплату. Проверьте поступление в интернет-банке Точки.' });
    expect(t.gateway.textsTo(STAFF_CHAT)).toHaveLength(1);
  });

  it('keeps sweeping other codes when one of them fails', async () => {
    const broken = await createQr();
    const good = await createQr();
    t.ctx.db.update(qrPayments).set({ saleInputJson: '{' }).where(eq(qrPayments.id, broken.id)).run();
    bank.statuses.set('QR1', 'paid');
    bank.statuses.set('QR2', 'paid');
    await sweepQrPayments(t.ctx);
    expect((await t.api('GET', `/api/qr-payments/${good.id}`)).json().status).toBe('paid');
    expect((await t.api('GET', '/api/sales')).json().total).toBe(1);
  });

  it('returns 404 for an unknown payment', async () => {
    expect((await t.api('GET', '/api/qr-payments/999')).statusCode).toBe(404);
    expect((await t.api('POST', '/api/qr-payments/999/cancel')).statusCode).toBe(404);
  });
});
