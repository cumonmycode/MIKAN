import type { InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { upsertChat } from '../src/domain/bot-chats.js';
import { expireCertificates, generateCertificateCode, normalizeCertificateCode } from '../src/domain/certificates.js';
import { linkTelegram } from '../src/domain/clients.js';
import { DAY_MS } from '../src/lib/time.js';
import { createTestApp, FakeQrProvider, make, type TestApp } from './helpers.js';

const NOW = Date.parse('2026-10-15T09:00:00.000Z'); // Thu 12:00 Moscow
const YEAR_LATER = '2027-10-15T09:00:00.000Z';
const CODE = /^MIKAN-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/;
const BUYER_CHAT = 888_001;

type Api = (method: InjectOptions['method'], url: string, payload?: unknown) => ReturnType<TestApp['api']>;

describe('gift certificates', () => {
  let t: TestApp;
  let bank: FakeQrProvider;
  let buyer: { id: number };
  let service: { id: number };
  /** The owner's requests; replaced after a jump in time (sign-in tokens live 90 days). */
  let api: Api;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    bank = new FakeQrProvider();
    t = await createTestApp({ qr: bank });
    buyer = await make(t, '/api/clients', { name: 'Ольга', lastName: 'Смирнова', phone: '+79990002233' });
    service = await make(t, '/api/services', { name: 'Прокол мочки', category: 'piercing', price: 3000, durationMin: 30 });
    api = t.api;
    await api('POST', '/api/cash/shift/open', { openingCash: 0 });
  });
  afterEach(async () => {
    vi.useRealTimers();
    await t.close();
  });

  const certificateLine = (price = 5000, extra: Record<string, unknown> = {}) => ({ type: 'certificate', price, recipientName: 'Маше', note: null, ...extra });

  /** Moves the clock and signs the owner in again. */
  async function travelTo(ms: number) {
    vi.setSystemTime(ms);
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'admin', password: 'secret123' } });
    const headers = { authorization: `Bearer ${res.json<{ token: string }>().token}` };
    api = (method, url, payload) =>
      t.app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as InjectOptions['payload'] }) });
  }

  const post = (body: Record<string, unknown>) =>
    api('POST', '/api/sales', { clientId: buyer.id, discount: 0, ...body, payments: { cash: 0, ...(body.payments as object) } });
  const ok = async (body: Record<string, unknown>) => {
    const res = await post(body);
    if (res.statusCode !== 200) throw new Error(`POST /api/sales → ${res.statusCode}: ${res.body}`);
    return res.json();
  };
  const sellCertificate = async (price = 5000) => {
    const sale = await ok({ items: [certificateLine(price)], payments: { cash: price } });
    return { sale, code: sale.items[0].certificateCode as string, id: sale.items[0].certificateId as number };
  };
  const byCode = async (code: string) => (await api('GET', `/api/certificates/code/${encodeURIComponent(code)}`)).json();
  const payService = (certificates: Array<{ code: string; amount: number }>, cash: number) =>
    post({ items: [{ type: 'service', serviceId: service.id, quantity: 1 }], payments: { cash, certificates } });

  async function session(role: 'admin' | 'master', login: string): Promise<Api> {
    await make(t, '/api/employees', { name: login, login, password: 'secret123', isMaster: role === 'master', role });
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login, password: 'secret123' } });
    const headers = { authorization: `Bearer ${res.json<{ token: string }>().token}` };
    return (method, url, payload) =>
      t.app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as InjectOptions['payload'] }) });
  }

  it('generates readable codes and reads them back in any case, with or without dashes', () => {
    for (let i = 0; i < 50; i += 1) expect(generateCertificateCode()).toMatch(CODE);
    expect(normalizeCertificateCode('mikan-7k3q-9f2d')).toBe('MIKAN-7K3Q-9F2D');
    expect(normalizeCertificateCode(' 7K3Q 9F2D ')).toBe('MIKAN-7K3Q-9F2D');
    expect(normalizeCertificateCode('МИКАН-7К3Q-9F2D')).toBe('MIKAN-7K3Q-9F2D');
    expect(normalizeCertificateCode('MIKAN7K3Q9F2D')).toBe('MIKAN-7K3Q-9F2D');
    expect(normalizeCertificateCode('7K3Q-9F2')).toBeNull();
  });

  it('issues a certificate from a sold certificate line and shows the line in its wire form', async () => {
    const { sale, code, id } = await sellCertificate();
    expect(code).toMatch(CODE);
    expect(sale.items).toEqual([
      {
        id: expect.any(Number), type: 'service', productId: null, variantId: null, variantName: null, serviceId: null,
        certificateId: id, certificateCode: code, name: `Подарочный сертификат ${code}`, quantity: 1, price: 5000, total: 5000, refundedQuantity: 0,
      },
    ]);
    expect(sale.bonusEarned).toBe(0);
    const certificate = await byCode(code.toLowerCase().replace(/-/g, ''));
    expect(certificate).toEqual({
      id,
      code,
      amount: 5000,
      balance: 5000,
      status: 'active',
      expiresAt: YEAR_LATER,
      buyer: { id: buyer.id, name: 'Ольга', lastName: 'Смирнова', phone: '+79990002233', telegramLinked: false },
      recipientName: 'Маше',
      note: null,
      saleId: sale.id,
      saleNumber: sale.number,
      operations: [{ type: 'issue', amount: 5000, saleId: sale.id, saleNumber: sale.number, createdAt: new Date(NOW).toISOString() }],
      createdAt: new Date(NOW).toISOString(),
    });
    expect((await t.api('GET', '/api/certificates/code/MIKAN-AAAA-AAAA')).statusCode).toBe(404);
    expect((await t.api('GET', '/api/certificates/code/MIKAN-AAAA-AAAA')).json().error.message).toBe('Сертификат не найден');
  });

  it('uses the validity from the settings (or none) and earns bonuses only on the other lines', async () => {
    await t.api('PUT', '/api/settings/retention', { certificates: { validityMonths: null } });
    const mixed = await ok({ items: [certificateLine(2000), { type: 'service', serviceId: service.id, quantity: 1 }], discount: 500, payments: { cash: 4500 } });
    expect(mixed.bonusEarned).toBe(125); // 5 % of 3000 − 500; the certificate is not discounted and earns nothing
    const certificate = (await t.api('GET', `/api/certificates?q=${encodeURIComponent('Маше')}`)).json().items[0];
    expect(certificate).toMatchObject({ amount: 2000, balance: 2000, expiresAt: null });
  });

  it('validates certificate lines', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ items: [certificateLine(5000, { quantity: 2 })], payments: { cash: 10000 } }, 'Позиция №1: сертификат продаётся по одному — укажите количество 1'],
      [{ items: [certificateLine(400)], payments: { cash: 400 } }, 'Номинал сертификата — от 500 ₽ до 100 000 ₽'],
      [{ items: [certificateLine(100_001)], payments: { cash: 100_001 } }, 'Номинал сертификата — от 500 ₽ до 100 000 ₽'],
      [{ items: [{ type: 'certificate' }], payments: { cash: 0 } }, 'Позиция №1: укажите номинал сертификата'],
      [
        { items: [certificateLine(5000), { type: 'service', serviceId: service.id, quantity: 1 }], discount: 3001, payments: { cash: 4999 } },
        'Скидка не распространяется на подарочный сертификат: она не может быть больше суммы остальных позиций',
      ],
      [{ items: [certificateLine(5000)], payments: { cash: 4000, bonus: 1000 } }, 'Подарочный сертификат нельзя оплатить бонусами или другим сертификатом'],
      [
        { items: [certificateLine(5000)], payments: { cash: 4000, certificates: [{ code: 'MIKAN-AAAA-AAAA', amount: 1000 }] } },
        'Подарочный сертификат нельзя оплатить бонусами или другим сертификатом',
      ],
    ];
    for (const [body, message] of cases) {
      const res = await post(body);
      expect(res.statusCode, message).toBe(400);
      expect(res.json().error.message).toBe(message);
    }
    expect((await t.api('GET', '/api/certificates')).json().total).toBe(0);
  });

  it('reads a certificate by id', async () => {
    const { id, code } = await sellCertificate(1000);
    expect((await api('GET', `/api/certificates/${id}`)).json()).toMatchObject({ id, code, amount: 1000, status: 'active' });
    const missing = await api('GET', '/api/certificates/9999');
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.message).toBe('Сертификат не найден');
  });

  it('an open receipt holds a certificate to sell, shown as a service line, and the sale issues it', async () => {
    const created = await api('POST', '/api/receipts', {
      clientId: buyer.id,
      items: [certificateLine(3000), { type: 'service', serviceId: service.id, quantity: 1 }],
      discount: 500,
    });
    expect(created.statusCode).toBe(200);
    const receipt = created.json();
    expect(receipt).toMatchObject({ subtotal: 6000, discount: 500, total: 5500, itemCount: 2 });
    expect(receipt.items[0]).toEqual({
      type: 'service', productId: null, variantId: null, variantName: null, productKind: null, serviceId: null,
      name: 'Подарочный сертификат', quantity: 1, price: 3000, total: 3000, stock: null,
      certificate: { recipientName: 'Маше', note: null },
    });
    expect(receipt.items[1]).toMatchObject({ type: 'service', serviceId: service.id, certificate: null });

    const cases: Array<[Record<string, unknown>, string]> = [
      [{ items: [certificateLine(3000, { quantity: 2 })] }, 'Позиция №1: сертификат продаётся по одному — укажите количество 1'],
      [{ items: [certificateLine(100)] }, 'Номинал сертификата — от 500 ₽ до 100 000 ₽'],
      [
        { items: [certificateLine(3000), { type: 'service', serviceId: service.id, quantity: 1 }], discount: 3001 },
        'Скидка не распространяется на подарочный сертификат: она не может быть больше суммы остальных позиций',
      ],
    ];
    for (const [body, message] of cases) {
      const res = await api('PUT', `/api/receipts/${receipt.id}`, { clientId: buyer.id, ...body });
      expect(res.statusCode, message).toBe(400);
      expect(res.json().error.message).toBe(message);
    }

    // The app pays the receipt with its lines; the sale issues the certificate and closes the receipt.
    const sale = await ok({
      receiptId: receipt.id,
      items: [certificateLine(3000), { type: 'service', serviceId: service.id, quantity: 1 }],
      discount: 500,
      payments: { cash: 5500 },
    });
    expect(sale.items[0]).toMatchObject({ type: 'service', certificateId: expect.any(Number), certificateCode: expect.stringMatching(CODE) });
    expect((await api('GET', `/api/receipts/${receipt.id}`)).statusCode).toBe(404);
    expect(await byCode(sale.items[0].certificateCode)).toMatchObject({ amount: 3000, recipientName: 'Маше', buyer: { id: buyer.id } });
  });

  it('is spent in parts until used, and refuses what it does not cover', async () => {
    const { code, id } = await sellCertificate(5000);
    const first = await payService([{ code: code.toLowerCase(), amount: 2500 }], 500);
    expect(first.statusCode).toBe(200);
    // Bonuses are earned on the money part only: 5 % of 500.
    expect(first.json()).toMatchObject({ payments: { cash: 500, certificate: 2500, bonus: 0 }, bonusEarned: 25 });
    expect(await byCode(code)).toMatchObject({ balance: 2500, status: 'active' });

    const tooMuch = await payService([{ code, amount: 2600 }], 400);
    expect(tooMuch.statusCode).toBe(409);
    expect(tooMuch.json().error.message).toBe(`На сертификате ${code} осталось 2 500 ₽`);
    const unknown = await payService([{ code: 'MIKAN-AAAA-AAAA', amount: 100 }], 2900);
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.message).toBe('Сертификат MIKAN-AAAA-AAAA не найден');
    const twice = await payService([{ code, amount: 100 }, { code: code.replace(/-/g, ''), amount: 100 }], 2800);
    expect(twice.statusCode).toBe(400);
    expect(twice.json().error.message).toBe(`Сертификат ${code} указан дважды`);

    const second = await payService([{ code, amount: 2500 }], 500);
    expect(second.statusCode).toBe(200);
    const used = await byCode(code);
    expect(used).toMatchObject({ id, balance: 0, status: 'used' });
    expect(used.operations.map((op: { type: string; amount: number }) => [op.type, op.amount])).toEqual([
      ['issue', 5000],
      ['redeem', -2500],
      ['redeem', -2500],
    ]);
    const again = await payService([{ code, amount: 100 }], 2900);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.message).toBe(`Сертификат ${code} не действует: он уже использован`);
  });

  it('expires at expiresAt: refused at once, burnt by the hourly job', async () => {
    const { code } = await sellCertificate(5000);
    await payService([{ code, amount: 1000 }], 2000);
    await travelTo(Date.parse(YEAR_LATER) + 1);
    expect(await byCode(code)).toMatchObject({ status: 'expired', balance: 4000 });
    const late = await payService([{ code, amount: 1000 }], 2000);
    expect(late.statusCode).toBe(409);
    expect(late.json().error.message).toBe(`Сертификат ${code} не действует: срок действия истёк`);
    expect(expireCertificates(t.ctx.db, Date.now())).toEqual({ certificates: 1, amount: 4000 });
    expect(expireCertificates(t.ctx.db, Date.now())).toEqual({ certificates: 0, amount: 0 });
    const burnt = await byCode(code);
    expect(burnt).toMatchObject({ status: 'expired', balance: 0 });
    expect(burnt.operations.at(-1)).toMatchObject({ type: 'expire', amount: -4000, saleId: null });
  });

  it('a refund gives the amount back to the certificate it was paid with', async () => {
    const { code } = await sellCertificate(3000);
    const paid = (await payService([{ code, amount: 3000 }], 0)).json();
    expect(await byCode(code)).toMatchObject({ balance: 0, status: 'used' });
    const refunded = await t.api('POST', `/api/sales/${paid.id}/refund`, { reason: 'Отказ', restock: true });
    expect(refunded.statusCode).toBe(200);
    const back = await byCode(code);
    expect(back).toMatchObject({ balance: 3000, status: 'active' });
    expect(back.operations.at(-1)).toMatchObject({ type: 'refund', amount: 3000, saleId: paid.id, saleNumber: paid.number });
  });

  it('a refund to a certificate that has expired since burns the amount with it', async () => {
    const { code } = await sellCertificate(3000);
    const paid = (await payService([{ code, amount: 1000 }], 2000)).json();
    await travelTo(Date.parse(YEAR_LATER) + 1);
    expect((await api('POST', `/api/sales/${paid.id}/refund`, { reason: 'Отказ', restock: true })).statusCode).toBe(200);
    const burnt = await byCode(code);
    expect(burnt).toMatchObject({ status: 'expired', balance: 0 });
    expect(burnt.operations.slice(-2).map((op: { type: string; amount: number }) => [op.type, op.amount])).toEqual([
      ['refund', 1000],
      ['expire', -3000],
    ]);
  });

  it('a refund to a used certificate past its expiry burns at once; an expired one cannot be extended', async () => {
    const { code } = await sellCertificate(1000);
    const other = await sellCertificate(2000);
    const paid = (await payService([{ code, amount: 1000 }], 2000)).json();
    expect(await byCode(code)).toMatchObject({ status: 'used', balance: 0 });
    await travelTo(Date.parse(YEAR_LATER) + 1);
    expect((await api('POST', `/api/sales/${paid.id}/refund`, { reason: 'Отказ', restock: true })).statusCode).toBe(200);
    const burnt = await byCode(code);
    expect(burnt).toMatchObject({ status: 'expired', balance: 0 });
    expect(burnt.operations.slice(-2).map((op: { type: string; amount: number }) => [op.type, op.amount])).toEqual([
      ['refund', 1000],
      ['expire', -1000],
    ]);

    // Past expiresAt before the hourly job: already expired, so the expiry cannot revive it.
    expect(await byCode(other.code)).toMatchObject({ status: 'expired', balance: 2000 });
    const late = await api('PATCH', `/api/certificates/${other.id}`, { expiresAt: '2028-12-31T00:00:00.000Z' });
    expect(late.statusCode).toBe(409);
    expect(late.json().error.message).toBe(`Сертификат ${other.code} уже не действует — срок изменить нельзя`);
  });

  it('refunding the sale of an unspent certificate cancels it; a spent one blocks the refund', async () => {
    const unspent = await sellCertificate(5000);
    const res = await t.api('POST', `/api/sales/${unspent.sale.id}/refund`, { reason: 'Передумали', restock: true });
    expect(res.statusCode).toBe(200);
    const cancelled = await byCode(unspent.code);
    expect(cancelled).toMatchObject({ status: 'cancelled', balance: 0 });
    expect(cancelled.operations.at(-1)).toMatchObject({ type: 'cancel', amount: -5000, saleId: unspent.sale.id });

    const spent = await sellCertificate(5000);
    await payService([{ code: spent.code, amount: 500 }], 2500);
    const blocked = await t.api('POST', `/api/sales/${spent.sale.id}/refund`, { reason: 'Передумали', restock: true });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.message).toBe(`Сертификат ${spent.code} уже частично оплачен покупками — его нельзя вернуть`);
    expect((await t.api('GET', `/api/sales/${spent.sale.id}`)).json().status).toBe('completed');
  });

  it('lists certificates newest first by status and by code or recipient', async () => {
    const a = await sellCertificate(1000);
    vi.setSystemTime(NOW + 1000);
    const b = await ok({ items: [certificateLine(2000, { recipientName: 'Ёлке Петровой' })], payments: { cash: 2000 } });
    const bCode = b.items[0].name.replace('Подарочный сертификат ', '');
    await payService([{ code: a.code, amount: 1000 }], 2000);
    const list = async (query: string) => (await t.api('GET', `/api/certificates${query}`)).json();
    expect((await list('')).items.map((c: { code: string }) => c.code)).toEqual([bCode, a.code]);
    expect((await list('?status=used')).items.map((c: { code: string }) => c.code)).toEqual([a.code]);
    expect((await list('?status=active')).total).toBe(1);
    expect((await list(`?q=${a.code.slice(6, 10).toLowerCase()}`)).items.map((c: { code: string }) => c.code)).toEqual([a.code]);
    expect((await list(`?q=${encodeURIComponent('елке')}`)).items.map((c: { code: string }) => c.code)).toEqual([bCode]);
    expect((await list('?limit=1&offset=1')).items.map((c: { code: string }) => c.code)).toEqual([a.code]);
    expect((await t.api('GET', '/api/certificates?status=lost')).statusCode).toBe(400);
  });

  it('edits the recipient and note for anyone, the expiry for the owner only', async () => {
    const { id } = await sellCertificate();
    const admin = await session('admin', 'aliya');
    const edited = await admin('PATCH', `/api/certificates/${id}`, { recipientName: 'Маше Ивановой', note: 'Подарок на ДР' });
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toMatchObject({ recipientName: 'Маше Ивановой', note: 'Подарок на ДР', expiresAt: YEAR_LATER });
    // The whole card resent with the same expiry is fine; another expiry is the owner's.
    expect((await admin('PATCH', `/api/certificates/${id}`, { recipientName: 'Маше', expiresAt: YEAR_LATER })).statusCode).toBe(200);
    const denied = await admin('PATCH', `/api/certificates/${id}`, { expiresAt: '2028-01-01T00:00:00.000Z' });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.message).toBe('Это доступно владельцу студии');
    const extended = await t.api('PATCH', `/api/certificates/${id}`, { expiresAt: '2028-01-01T00:00:00.000Z' });
    expect(extended.json()).toMatchObject({ expiresAt: '2028-01-01T00:00:00.000Z', recipientName: 'Маше' });
    expect((await t.api('PATCH', `/api/certificates/${id}`, { expiresAt: null })).json().expiresAt).toBeNull();
    const past = await t.api('PATCH', `/api/certificates/${id}`, { expiresAt: new Date(NOW - DAY_MS).toISOString() });
    expect(past.statusCode).toBe(400);
    expect(past.json().error.message).toBe('Срок действия должен быть в будущем');
    expect((await t.api('PATCH', '/api/certificates/9999', { note: 'x' })).statusCode).toBe(404);
  });

  it('the owner cancels an active certificate and its balance burns', async () => {
    const { id, code } = await sellCertificate(5000);
    await payService([{ code, amount: 1000 }], 2000);
    const admin = await session('admin', 'aliya');
    const denied = await admin('POST', `/api/certificates/${id}/cancel`, { reason: 'Ошибка' });
    expect(denied.statusCode).toBe(403);
    const cancelled = await t.api('POST', `/api/certificates/${id}/cancel`, { reason: 'Продан по ошибке' });
    expect(cancelled.json()).toMatchObject({ status: 'cancelled', balance: 0, note: 'Аннулирован: Продан по ошибке' });
    expect(cancelled.json().operations.at(-1)).toMatchObject({ type: 'cancel', amount: -4000, saleId: null });
    const again = await t.api('POST', `/api/certificates/${id}/cancel`, { reason: 'Ещё раз' });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.message).toBe(`Сертификат ${code} уже не действует: он аннулирован`);
    const pay = await payService([{ code, amount: 100 }], 2900);
    expect(pay.json().error.message).toBe(`Сертификат ${code} не действует: он аннулирован`);
  });

  it('sends the certificate card to the buyer or a chosen chat', async () => {
    const { id, code } = await sellCertificate(5000);
    const noChat = await t.api('POST', `/api/certificates/${id}/send`, {});
    expect(noChat.statusCode).toBe(409);
    expect(noChat.json().error.message).toBe('Покупатель не писал боту в Telegram — выберите чат или поделитесь сертификатом другим способом');

    linkTelegram(t.ctx.db, buyer.id, BUYER_CHAT, 'olga');
    upsertChat(t.ctx.db, BUYER_CHAT, { clientId: buyer.id });
    expect((await t.api('POST', `/api/certificates/${id}/send`, {})).json()).toEqual({ sent: true });
    const card = `🎁 Подарочный сертификат MIKAN STUDIO на 5 000 ₽ · код ${code} · действует до 15 октября 2027\nКому: Маше`;
    expect(t.gateway.textsTo(BUYER_CHAT)).toEqual([card]);
    expect((await t.api('GET', `/api/clients/${buyer.id}/chat`)).json().chat.lastMessage).toMatchObject({ role: 'system', text: card });

    const otherChat = 888_002;
    upsertChat(t.ctx.db, otherChat, { telegramName: 'Маша' });
    await payService([{ code, amount: 1000 }], 2000);
    expect((await t.api('POST', `/api/certificates/${id}/send`, { chatId: otherChat })).statusCode).toBe(200);
    expect(t.gateway.textsTo(otherChat)).toEqual([`${card.split('\n')[0]}\nОсталось 4 000 ₽\nКому: Маше`]);
    expect((await t.api('POST', `/api/certificates/${id}/send`, { chatId: 123 })).statusCode).toBe(400);

    t.gateway.running = false;
    expect((await t.api('POST', `/api/certificates/${id}/send`, {})).statusCode).toBe(409);
    t.gateway.running = true;
    await t.api('POST', `/api/certificates/${id}/cancel`, { reason: 'Тест' });
    const dead = await t.api('POST', `/api/certificates/${id}/send`, {});
    expect(dead.statusCode).toBe(409);
  });

  it('works on the QR path: a paid code sells the certificate and spends another', async () => {
    const { code } = await sellCertificate(3000);
    const spend = await t.api('POST', '/api/qr-payments', {
      clientId: buyer.id,
      items: [{ type: 'service', serviceId: service.id, quantity: 1 }],
      discount: 0,
      payments: { qr: 1000, certificates: [{ code, amount: 2000 }] },
    });
    expect(spend.statusCode).toBe(200);
    const sell = await t.api('POST', '/api/qr-payments', {
      clientId: buyer.id,
      items: [certificateLine(1500)],
      discount: 0,
      payments: { qr: 1500 },
    });
    expect(sell.statusCode).toBe(200);
    expect(await byCode(code)).toMatchObject({ balance: 3000 }); // nothing spent before the bank confirms
    bank.statuses.set('QR1', 'paid');
    bank.statuses.set('QR2', 'paid');
    const spent = (await t.api('GET', `/api/qr-payments/${spend.json().id}`)).json();
    expect(spent.sale).toMatchObject({ payments: { qr: 1000, certificate: 2000 } });
    expect(await byCode(code)).toMatchObject({ balance: 1000 });
    const sold = (await t.api('GET', `/api/qr-payments/${sell.json().id}`)).json();
    expect(sold.sale.items[0]).toMatchObject({ type: 'service', certificateId: expect.any(Number), name: expect.stringMatching(/^Подарочный сертификат MIKAN-/) });
    expect((await t.api('GET', '/api/certificates?status=active')).json().total).toBe(2);
  });

  it('replays an idempotent certificate sale without issuing it twice', async () => {
    const headers = { authorization: `Bearer ${t.token}`, 'idempotency-key': '0b4c7a1e-2f3d-4e5a-8b9c-1d2e3f4a5b6c' };
    const body = { clientId: buyer.id, items: [certificateLine(1000)], discount: 0, payments: { cash: 1000 } };
    const first = await t.app.inject({ method: 'POST', url: '/api/sales', headers, payload: body });
    const again = await t.app.inject({ method: 'POST', url: '/api/sales', headers, payload: body });
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json()).toEqual(first.json());
    expect((await t.api('GET', '/api/certificates')).json().total).toBe(1);
  });

  it('selling and redeeming are till actions open to masters', async () => {
    const master = await session('master', 'fatima');
    const sold = await master('POST', '/api/sales', { items: [certificateLine(1000)], discount: 0, payments: { cash: 1000 } });
    expect(sold.statusCode).toBe(200);
    const code = sold.json().items[0].name.replace('Подарочный сертификат ', '');
    expect((await master('GET', `/api/certificates/code/${code}`)).statusCode).toBe(200);
    const paid = await master('POST', '/api/sales', {
      items: [{ type: 'service', serviceId: service.id, quantity: 1 }],
      discount: 0,
      payments: { cash: 2000, certificates: [{ code, amount: 1000 }] },
    });
    expect(paid.statusCode).toBe(200);
    expect((await master('GET', '/api/certificates')).json().total).toBe(1);
  });
});
