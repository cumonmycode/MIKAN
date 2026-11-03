import type { InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { bonusBalance, creditGiftBonuses, expireBonusLots, hasBonusBalanceSql } from '../src/domain/bonuses.js';
import { linkTelegram } from '../src/domain/clients.js';
import { birthdayDiscount } from '../src/domain/loyalty.js';
import { DEFAULT_RETENTION } from '../src/domain/retention-settings.js';
import { DAY_MS } from '../src/lib/time.js';
import { createTestApp, FakeQrProvider, make, openShift, type TestApp } from './helpers.js';

const NOW = Date.parse('2026-10-15T09:00:00.000Z'); // Thu 12:00 Moscow
const CHAT = 777_001;

describe('loyalty bonuses', () => {
  let t: TestApp;
  let bank: FakeQrProvider;
  let client: { id: number };
  let service: { id: number };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    bank = new FakeQrProvider();
    t = await createTestApp({ qr: bank });
    await openShift(t);
    client = await make(t, '/api/clients', { name: 'Анна', lastName: 'Иванова', phone: '+79990001122' });
    service = await make(t, '/api/services', { name: 'Прокол мочки', category: 'piercing', price: 3000, durationMin: 30 });
  });
  afterEach(async () => {
    vi.useRealTimers();
    await t.close();
  });

  const sell = (payments: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    t.api('POST', '/api/sales', {
      clientId: client.id,
      items: [{ type: 'service', serviceId: service.id, quantity: 1 }],
      discount: 0,
      payments: { cash: 0, card: 0, transfer: 0, qr: 0, deposit: 0, ...payments },
      ...extra,
    });

  const sold = async (payments: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const res = await sell(payments, extra);
    if (res.statusCode !== 200) throw new Error(`POST /api/sales → ${res.statusCode}: ${res.body}`);
    return res.json();
  };

  const loyalty = async () => (await t.api('GET', `/api/clients/${client.id}`)).json().loyalty;
  const ledger = async (query = '') => (await t.api('GET', `/api/clients/${client.id}/bonuses${query}`)).json();
  const adjust = async (payload: Record<string, unknown>) => {
    const res = await t.api('POST', `/api/clients/${client.id}/bonuses`, payload);
    if (res.statusCode !== 200) throw new Error(`POST bonuses → ${res.statusCode}: ${res.body}`);
    return res.json();
  };
  const setLoyalty = (loyaltyPatch: Record<string, unknown>) => t.api('PUT', '/api/settings/retention', { loyalty: loyaltyPatch });

  it('earns the cashback on a completed sale with a client and shows it on the sale, the card and the ledger', async () => {
    const sale = await sold({ cash: 3000 });
    expect(sale.bonusEarned).toBe(150);
    expect(sale.payments).toEqual({ cash: 3000, card: 0, transfer: 0, qr: 0, deposit: 0, bonus: 0, certificate: 0 });
    expect(sale.items[0]).toMatchObject({ type: 'service', certificateId: null });
    expect(await loyalty()).toEqual({ bonusBalance: 150, expiring: null, birthdayDiscount: null });
    const list = await ledger();
    expect(list).toMatchObject({ balance: 150, total: 1 });
    expect(list.items[0]).toEqual({
      id: expect.any(Number),
      type: 'earn',
      amount: 150,
      remaining: 150,
      expiresAt: null,
      saleId: sale.id,
      saleNumber: sale.number,
      note: null,
      employee: { id: expect.any(Number), name: 'Админ', color: expect.any(String) },
      createdAt: new Date(NOW).toISOString(),
    });
    expect((await t.api('GET', `/api/sales/${sale.id}`)).json().bonusEarned).toBe(150);
    // Lists leave loyalty out.
    const listed = (await t.api('GET', '/api/clients')).json().items.find((c: { id: number }) => c.id === client.id);
    expect(listed).toMatchObject({ loyalty: null, marketingOptOut: false });
  });

  it('earns nothing without a client, at 0 % or with loyalty off, and rounds the cashback down', async () => {
    const anonymous = await sold({ cash: 3000 }, { clientId: null });
    expect(anonymous.bonusEarned).toBe(0);
    await setLoyalty({ cashbackPercent: 3 });
    const odd = await sold({ cash: 2990 }, { items: [{ type: 'service', name: 'Консультация', price: 2990, quantity: 1 }] });
    expect(odd.bonusEarned).toBe(89); // floor(2990 × 3 / 100) = floor(89.7)
    await setLoyalty({ enabled: false });
    expect((await sold({ cash: 3000 })).bonusEarned).toBe(0);
    await setLoyalty({ enabled: true, cashbackPercent: 0 });
    expect((await sold({ cash: 3000 })).bonusEarned).toBe(0);
    expect((await ledger()).balance).toBe(89);
  });

  it('pays with bonuses within the balance and the check limit, earning only on the rest', async () => {
    await adjust({ amount: 2000, note: 'Перенос с YCLIENTS' });
    const sale = await sold({ cash: 2100, bonus: 900 });
    expect(sale.payments).toMatchObject({ cash: 2100, bonus: 900 });
    expect(sale.bonusEarned).toBe(105); // 5 % of 3000 − 900
    expect((await ledger()).balance).toBe(2000 - 900 + 105);
    const ops = (await ledger()).items;
    expect(ops.map((o: { type: string; amount: number }) => [o.type, o.amount])).toEqual([
      ['earn', 105],
      ['spend', -900],
      ['adjust', 2000],
    ]);
    expect(ops[1]).toMatchObject({ remaining: 0, saleId: sale.id, saleNumber: sale.number });
    expect(ops[2]).toMatchObject({ remaining: 1100 });
  });

  it('refuses bonus payments without a client, with loyalty off, over the limit or over the balance', async () => {
    await adjust({ amount: 500, note: 'Подарок' });
    const anonymous = await sell({ cash: 2900, bonus: 100 }, { clientId: null });
    expect(anonymous.statusCode).toBe(400);
    expect(anonymous.json().error.message).toBe('Чтобы оплатить бонусами, выберите клиента');

    const overLimit = await sell({ cash: 2000, bonus: 1000 });
    expect(overLimit.statusCode).toBe(400);
    expect(overLimit.json().error.message).toBe('Бонусами можно оплатить не больше 30% чека — 900 ₽');

    const overBalance = await sell({ cash: 2400, bonus: 600 });
    expect(overBalance.statusCode).toBe(409);
    expect(overBalance.json().error.message).toBe('На счёте 500 бонусов');

    const mismatch = await sell({ cash: 2900, bonus: 200 });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().error.message).toBe('Сумма оплат (3 100 ₽) не совпадает с итогом (3 000 ₽)');

    await setLoyalty({ enabled: false });
    const off = await sell({ cash: 2900, bonus: 100 });
    expect(off.statusCode).toBe(409);
    expect(off.json().error.message).toBe('Бонусная программа выключена — оплатите другим способом');
    expect((await ledger()).balance).toBe(500);
    expect((await t.api('GET', '/api/sales')).json().total).toBe(0);
  });

  it('spends the oldest lots first and never touches burnt ones', async () => {
    await adjust({ amount: 100, note: 'Первый', expiresAt: new Date(NOW + 2 * DAY_MS).toISOString() });
    vi.setSystemTime(NOW + 1000);
    await adjust({ amount: 400, note: 'Второй' });
    vi.setSystemTime(NOW + 2000);
    await sold({ cash: 2850, bonus: 150 });
    const byNote = async (note: string) => (await ledger()).items.find((o: { note: string }) => o.note === note);
    expect((await byNote('Первый')).remaining).toBe(0);
    expect((await byNote('Второй')).remaining).toBe(350);

    await adjust({ amount: 200, note: 'Сгорит', expiresAt: new Date(NOW + DAY_MS).toISOString() });
    // The sale earned floor(5 % × 2850) = 142.
    expect(await loyalty()).toMatchObject({ bonusBalance: 350 + 142 + 200, expiring: { amount: 200, at: new Date(NOW + DAY_MS).toISOString() } });

    vi.setSystemTime(NOW + DAY_MS + 1);
    // Burnt at once for spending and the balance, before the hourly job records it.
    expect(bonusBalance(t.ctx.db, client.id)).toBe(350 + 142);
    expect(expireBonusLots(t.ctx.db, Date.now())).toEqual({ lots: 1, amount: 200 });
    expect(expireBonusLots(t.ctx.db, Date.now())).toEqual({ lots: 0, amount: 0 });
    const burnt = (await ledger()).items[0];
    expect(burnt).toMatchObject({ type: 'expire', amount: -200, remaining: 0 });
    expect(await loyalty()).toMatchObject({ bonusBalance: 492, expiring: null });
  });

  it('lets earned bonuses burn after expiryDays', async () => {
    await setLoyalty({ expiryDays: 30 });
    const sale = await sold({ cash: 3000 });
    const at = '2026-11-14T21:00:00.000Z'; // the end of 14 November, studio time
    expect((await ledger()).items[0]).toMatchObject({ type: 'earn', amount: 150, expiresAt: at, saleId: sale.id });
    expect(await loyalty()).toMatchObject({ bonusBalance: 150, expiring: { amount: 150, at } });
  });

  it('a refund returns the spent bonuses and takes back the earned ones', async () => {
    await adjust({ amount: 1000, note: 'Старт' });
    const sale = await sold({ cash: 2100, bonus: 900 });
    expect((await ledger()).balance).toBe(100 + 105);
    const refunded = (await t.api('POST', `/api/sales/${sale.id}/refund`, { reason: 'Ошибка', restock: true })).json();
    expect(refunded).toMatchObject({ status: 'refunded', bonusEarned: 105 });
    const list = await ledger();
    expect(list.balance).toBe(1000);
    expect(list.items.slice(0, 2).map((o: { type: string; amount: number }) => [o.type, o.amount])).toEqual([
      ['reverse', -105],
      ['reverse', 900],
    ]);
    expect(list.items[0]).toMatchObject({ saleId: sale.id, note: 'Возврат чека №1: начисленные бонусы списаны' });
    expect(list.items[1]).toMatchObject({ saleId: sale.id, note: 'Возврат чека №1: бонусы, оплаченные в чеке, вернулись' });
  });

  it('never takes back more than the client still has', async () => {
    const first = await sold({ cash: 3000 }); // +150
    await adjust({ amount: 50, note: 'Добавка' });
    await adjust({ amount: -180, note: 'Списание' });
    expect((await ledger()).balance).toBe(20);
    await t.api('POST', `/api/sales/${first.id}/refund`, { reason: 'Возврат', restock: true });
    const list = await ledger();
    expect(list.balance).toBe(0);
    expect(list.items[0]).toMatchObject({ type: 'reverse', amount: -20 });
  });

  it('does not take back earned bonuses that have already burnt', async () => {
    await setLoyalty({ expiryDays: 30 });
    await adjust({ amount: 500, note: 'Старт' });
    const burnt = await sold({ cash: 3000 }); // +150, burning in 30 days
    vi.setSystemTime(NOW + 2 * DAY_MS);
    const pending = await sold({ cash: 3000 }); // +150 more, burning 2 days later
    vi.setSystemTime(NOW + 31 * DAY_MS);
    expect(expireBonusLots(t.ctx.db, Date.now())).toEqual({ lots: 1, amount: 150 });
    const expired = (await ledger()).items.find((o: { type: string; saleId: number }) => o.type === 'expire' && o.saleId === burnt.id);
    expect(expired).toMatchObject({ amount: -150, saleNumber: burnt.number });
    expect((await t.api('POST', `/api/sales/${burnt.id}/refund`, { reason: 'Возврат', restock: true })).statusCode).toBe(200);
    expect((await ledger()).balance).toBe(650); // nothing taken: its 150 burnt (the other sale's 150 still live)
    // A lot past its expiry the hourly job has not reached yet is taken back as it is — once.
    vi.setSystemTime(NOW + 33 * DAY_MS);
    expect((await t.api('POST', `/api/sales/${pending.id}/refund`, { reason: 'Возврат', restock: true })).statusCode).toBe(200);
    expect((await ledger()).items[0]).toMatchObject({ type: 'reverse', amount: -150, saleId: pending.id });
    expect(expireBonusLots(t.ctx.db, Date.now())).toEqual({ lots: 0, amount: 0 });
    expect((await ledger()).balance).toBe(500);
  });

  it('adjusts by hand for owners and admins only, never below zero', async () => {
    const credit = await adjust({ amount: 300, note: 'Компенсация', expiresAt: new Date(NOW + 10 * DAY_MS).toISOString() });
    expect(credit).toMatchObject({ type: 'adjust', amount: 300, remaining: 300, note: 'Компенсация', saleId: null, saleNumber: null });
    const tooMuch = await t.api('POST', `/api/clients/${client.id}/bonuses`, { amount: -301, note: 'Ошибка' });
    expect(tooMuch.statusCode).toBe(409);
    expect(tooMuch.json().error.message).toBe('На счёте только 300 бонусов');
    const zero = await t.api('POST', `/api/clients/${client.id}/bonuses`, { amount: 0, note: 'Ноль' });
    expect(zero.statusCode).toBe(400);
    const noNote = await t.api('POST', `/api/clients/${client.id}/bonuses`, { amount: 10 });
    expect(noNote.statusCode).toBe(400);
    const past = await t.api('POST', `/api/clients/${client.id}/bonuses`, { amount: 10, note: 'x', expiresAt: new Date(NOW - 1).toISOString() });
    expect(past.statusCode).toBe(400);
    expect(past.json().error.message).toBe('Срок сгорания должен быть в будущем');
    const debit = await adjust({ amount: -100, note: 'Исправление' });
    expect(debit).toMatchObject({ type: 'adjust', amount: -100, remaining: 0, expiresAt: null });
    expect((await ledger()).balance).toBe(200);
    expect((await t.api('POST', '/api/clients/99999/bonuses', { amount: 10, note: 'x' })).statusCode).toBe(404);

    await make(t, '/api/employees', { name: 'Фатима', login: 'fatima', password: 'secret123', isMaster: true, role: 'master' });
    const login = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'fatima', password: 'secret123' } });
    const headers = { authorization: `Bearer ${login.json<{ token: string }>().token}` };
    const asMaster = (method: InjectOptions['method'], url: string, payload?: unknown) =>
      t.app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as InjectOptions['payload'] }) });
    const forbidden = await asMaster('POST', `/api/clients/${client.id}/bonuses`, { amount: 10, note: 'x' });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.message).toBe('Это доступно владельцу и администратору');
    expect((await asMaster('GET', `/api/clients/${client.id}/bonuses`)).statusCode).toBe(200);
    // Paying with bonuses is a till action: every role may.
    const res = await asMaster('POST', '/api/sales', {
      clientId: client.id,
      items: [{ type: 'service', serviceId: service.id, quantity: 1 }],
      discount: 0,
      payments: { cash: 2800, bonus: 200 },
    });
    expect(res.statusCode).toBe(200);
  });

  it('pages the ledger newest first', async () => {
    for (let i = 1; i <= 3; i += 1) {
      vi.setSystemTime(NOW + i * 1000);
      await adjust({ amount: i * 10, note: `№${i}` });
    }
    const page = await ledger('?limit=2&offset=1');
    expect(page).toMatchObject({ balance: 60, total: 3 });
    expect(page.items.map((o: { note: string }) => o.note)).toEqual(['№2', '№1']);
  });

  it('credits gift bonuses that burn after the given days (birthday and win-back)', async () => {
    const gift = creditGiftBonuses(t.ctx.db, client.id, 500, 14, 'С днём рождения!');
    // The end of the studio day 14 days ahead: valid all of 29 October.
    const at = Date.parse('2026-10-29T21:00:00.000Z');
    expect(gift).toMatchObject({ type: 'gift', amount: 500, remaining: 500, expiresAt: at, note: 'С днём рождения!' });
    expect(await loyalty()).toMatchObject({ bonusBalance: 500, expiring: { amount: 500, at: new Date(at).toISOString() } });
    expect(() => creditGiftBonuses(t.ctx.db, client.id, 0, 14, 'x')).toThrow();
  });

  it('the campaign segment «has bonuses» means a balance above 0 right now', async () => {
    const holders = () =>
      t.ctx.db.all<{ id: number }>(sql`select c.id from clients c where ${hasBonusBalanceSql(sql`c.id`, Date.now())}`).map((r) => r.id);
    expect(holders()).toEqual([]);
    creditGiftBonuses(t.ctx.db, client.id, 100, 1, 'Подарок');
    expect(holders()).toEqual([client.id]);
    vi.setSystemTime(NOW + 2 * DAY_MS); // burnt, the hourly job not run yet
    expect(bonusBalance(t.ctx.db, client.id)).toBe(0);
    expect(holders()).toEqual([]);
  });

  it('offers the birthday discount inside the window around the birthday', async () => {
    const card = async (birthday: string) => {
      await t.api('PATCH', `/api/clients/${client.id}`, { birthday });
      return loyalty();
    };
    // Today is 2026-10-15; the window is 7 days before to 7 days after.
    expect((await card('1995-10-20')).birthdayDiscount).toEqual({ percent: 10, until: '2026-10-27' });
    expect((await card('1995-10-08')).birthdayDiscount).toEqual({ percent: 10, until: '2026-10-15' });
    expect((await card('1995-10-07')).birthdayDiscount).toBeNull();
    expect((await card('1995-10-23')).birthdayDiscount).toBeNull();
    vi.setSystemTime(Date.parse('2026-12-30T09:00:00.000Z'));
    expect((await card('1990-01-03')).birthdayDiscount).toEqual({ percent: 10, until: '2027-01-10' });
    await t.api('PUT', '/api/settings/retention', { birthday: { discountPercent: 0 } });
    expect((await card('1990-01-03')).birthdayDiscount).toBeNull();
    await t.api('PUT', '/api/settings/retention', { birthday: { discountPercent: 15, enabled: false } });
    expect((await card('1990-01-03')).birthdayDiscount).toBeNull();
    await t.api('PUT', '/api/settings/retention', { birthday: { enabled: true } });
    expect((await card('1990-01-03')).birthdayDiscount).toEqual({ percent: 15, until: '2027-01-10' });
    // 29 February is celebrated on the 28th in other years.
    const settings = { ...DEFAULT_RETENTION.birthday, discountPercent: 15 };
    expect(birthdayDiscount({ birthday: '2000-02-29' }, settings, Date.parse('2027-02-22T09:00:00.000Z'), 'Europe/Moscow')).toEqual({
      percent: 15,
      until: '2027-03-07',
    });
    expect(birthdayDiscount({ birthday: '2000-02-29' }, settings, Date.parse('2028-03-07T09:00:00.000Z'), 'Europe/Moscow')).toEqual({
      percent: 15,
      until: '2028-03-07',
    });
    expect(birthdayDiscount({ birthday: null }, settings, Date.now(), 'Europe/Moscow')).toBeNull();
  });

  it('replays an idempotent sale without spending or earning twice', async () => {
    await adjust({ amount: 500, note: 'Старт' });
    const body = {
      clientId: client.id,
      items: [{ type: 'service', serviceId: service.id, quantity: 1 }],
      discount: 0,
      payments: { cash: 2700, bonus: 300 },
    };
    const headers = { authorization: `Bearer ${t.token}`, 'idempotency-key': '5f1d7c3e-8a52-4b8e-9d7a-0c2b1e4f6a90' };
    const first = await t.app.inject({ method: 'POST', url: '/api/sales', headers, payload: body });
    const again = await t.app.inject({ method: 'POST', url: '/api/sales', headers, payload: body });
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json()).toEqual(first.json());
    expect((await ledger()).balance).toBe(500 - 300 + 135);
    expect((await t.api('GET', '/api/sales')).json().total).toBe(1);
  });

  it('spends and earns on a sale created from a paid QR code', async () => {
    await adjust({ amount: 500, note: 'Старт' });
    const created = await t.api('POST', '/api/qr-payments', {
      clientId: client.id,
      items: [{ type: 'service', serviceId: service.id, quantity: 1 }],
      discount: 0,
      payments: { cash: 0, qr: 2600, bonus: 400 },
    });
    expect(created.statusCode).toBe(200);
    expect((await ledger()).balance).toBe(500); // nothing is spent before the bank confirms
    bank.statuses.set('QR1', 'paid');
    const paid = (await t.api('GET', `/api/qr-payments/${created.json().id}`)).json();
    expect(paid.sale).toMatchObject({ payments: { qr: 2600, bonus: 400 }, bonusEarned: 130 });
    expect((await ledger()).balance).toBe(500 - 400 + 130);

    const overLimit = await t.api('POST', '/api/qr-payments', {
      clientId: client.id,
      items: [{ type: 'service', serviceId: service.id, quantity: 1 }],
      discount: 0,
      payments: { qr: 2000, bonus: 1000 },
    });
    expect(overLimit.statusCode).toBe(400);
  });

  it('pays an open receipt with bonuses and closes it', async () => {
    await adjust({ amount: 500, note: 'Старт' });
    const receipt = (await t.api('POST', '/api/receipts', { clientId: client.id, items: [{ type: 'service', serviceId: service.id, quantity: 1 }] })).json();
    const sale = await sold({ cash: 2500, bonus: 500 }, { receiptId: receipt.id });
    expect(sale.payments).toMatchObject({ cash: 2500, bonus: 500 });
    expect((await t.api('GET', `/api/receipts/${receipt.id}`)).statusCode).toBe(404);
    expect((await ledger()).balance).toBe(125);
  });

  it('flags a QR payment for staff when the bonuses are gone by the time the bank confirms', async () => {
    await adjust({ amount: 500, note: 'Старт' });
    const created = (await t.api('POST', '/api/qr-payments', {
      clientId: client.id,
      items: [{ type: 'service', serviceId: service.id, quantity: 1 }],
      discount: 0,
      payments: { qr: 2600, bonus: 400 },
    })).json();
    await adjust({ amount: -300, note: 'Списание' });
    bank.statuses.set('QR1', 'paid');
    const paid = (await t.api('GET', `/api/qr-payments/${created.id}`)).json();
    expect(paid).toMatchObject({ status: 'paid', sale: null, error: 'Оплата 2 600 ₽ получена, но продажа не проведена: На счёте 200 бонусов' });
    expect((await ledger()).balance).toBe(200);
  });

  it('tells the linked client what was credited after a paid sale when the receipt is not sent', async () => {
    await t.api('PUT', '/api/settings/studio', { pos: { sendReceipt: false } });
    linkTelegram(t.ctx.db, client.id, CHAT, 'anna');
    await adjust({ amount: 1125, note: 'Старт' });
    await sold({ cash: 3000 });
    await vi.waitFor(() => expect(t.gateway.textsTo(CHAT)).toHaveLength(1));
    expect(t.gateway.textsTo(CHAT)[0]).toBe('Спасибо за покупку! 🎁 +150 бонусов, на счёте 1 275');
    const chat = (await t.api('GET', `/api/clients/${client.id}/chat`)).json().chat;
    expect(chat.lastMessage).toMatchObject({ role: 'system', text: 'Спасибо за покупку! 🎁 +150 бонусов, на счёте 1 275' });

    await setLoyalty({ notifyClient: false });
    await sold({ cash: 3000 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(t.gateway.textsTo(CHAT)).toHaveLength(1);

    await setLoyalty({ notifyClient: true, expiryDays: 30 });
    await t.api('PATCH', `/api/clients/${client.id}`, { botEnabled: false });
    await sold({ cash: 3000 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(t.gateway.textsTo(CHAT)).toHaveLength(1);
    await t.api('PATCH', `/api/clients/${client.id}`, { botEnabled: true });
    await sold({ cash: 1000 }, { items: [{ type: 'service', name: 'Уход', price: 1000, quantity: 1 }] });
    await vi.waitFor(() => expect(t.gateway.textsTo(CHAT)).toHaveLength(2));
    expect(t.gateway.textsTo(CHAT)[1]).toBe('Спасибо за покупку! 🎁 +50 бонусов, на счёте 1 625 — начисленные действуют до 14 ноября');
  });
});
