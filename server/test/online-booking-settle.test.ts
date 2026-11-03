import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOLD_BANK_WAIT_MS, releaseUnpaidHolds } from '../src/domain/online-booking-lifecycle.js';
import { createTestApp, FakeQrProvider, make, type TestApp } from './helpers.js';
import {
  addMaster,
  auditEntries,
  bindStaffChat,
  FRIDAY_NOON,
  hhmm,
  linkChat,
  loginAs,
  MIN,
  NOW,
  pub,
  PUBLIC_URL,
  STAFF_CHAT,
  type Json,
} from './online-booking-fixtures.js';

const CHAT = 601;
const CANCEL_RULE =
  'Бесплатно отменить или перенести запись можно не позднее чем за 24 часа; при более поздней отмене предоплата не возвращается, при неявке — тоже.';

describe('online booking: staff confirm and reject', () => {
  let t: TestApp;
  let lobe: Json;
  let fatima: Json;
  let anna: Json;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    t = await createTestApp({ env: { PUBLIC_URL } });
    bindStaffChat(t);
    lobe = await make(t, '/api/services', { name: 'Мочка', category: 'piercing', price: 1600, durationMin: 30 });
    fatima = await addMaster(t, 'Фатима', 'fatima');
    anna = await make(t, '/api/clients', { name: 'Анна', phone: '+79991234567' });
    await linkChat(t, anna.id, CHAT);
  });
  afterEach(async () => {
    vi.useRealTimers();
    await t.close();
  });

  const book = async (masterId: number, startsAt = FRIDAY_NOON) =>
    (await pub(t, 'POST', '', { items: [{ serviceId: lobe.id }], masterId, startsAt, name: 'Анна', phone: '+79991234567' })).json();

  it('confirms: the booking is settled and the client hears it', async () => {
    const booking = await book(fatima.id);
    const res = await t.api('POST', `/api/appointments/${booking.number}/online/confirm`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: booking.number, status: 'scheduled', onlineState: null, channel: 'web' });
    expect(t.gateway.textsTo(CHAT).at(-1)).toBe('✅ Запись подтверждена: 16 октября, 12:00, мастер Фатима\nМочка');
    expect((await pub(t, 'GET', `/b/${booking.token}`)).json().status).toBe('confirmed');
    expect((await t.api('GET', '/api/badges')).json().onlineAwaiting).toBe(0);
    const again = await t.api('POST', `/api/appointments/${booking.number}/online/confirm`);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.message).toBe('Эта запись не ждёт подтверждения');
    expect((await auditEntries(t, booking.number)).at(-1)).toMatchObject({
      source: 'app',
      employee: { id: 1 },
      action: 'appointment.online_confirm',
      summary: `Онлайн-запись №${booking.number} (Анна) на 16 октября, 12:00 подтверждена`,
    });
  });

  it('rejects with a reason: cancelled, the client gets the reason and the booking link', async () => {
    await t.api('PUT', '/api/settings/studio', { address: 'ул. Ленина, 1' });
    const booking = await book(fatima.id);
    const res = await t.api('POST', `/api/appointments/${booking.number}/online/reject`, { reason: 'Мастер заболела' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'cancelled', onlineState: null, notes: 'Онлайн-запись отклонена: Мастер заболела' });
    expect(t.gateway.textsTo(CHAT).at(-1)).toBe(
      `😔 Не получится принять запись на 16 октября, 12:00.\nПричина: Мастер заболела\n\nВыберите другое время: ${PUBLIC_URL}/book`,
    );
    expect((await t.api('POST', `/api/appointments/${booking.number}/online/reject`, {})).statusCode).toBe(409);
    expect((await auditEntries(t, booking.number)).at(-1)).toMatchObject({
      source: 'app',
      action: 'appointment.online_reject',
      summary: `Онлайн-запись №${booking.number} (Анна) на 16 октября, 12:00 отклонена. Причина: Мастер заболела`,
      changes: { status: { from: 'scheduled', to: 'cancelled' } },
    });
    // The freed time is offered again.
    const slots = (await pub(t, 'GET', `/slots?date=2026-10-16&items=${lobe.id}&masterId=${fatima.id}`)).json().items as Json[];
    expect(slots.map((s) => hhmm(s.startsAt))).toContain('12:00');
  });

  it('lets a master settle only their own online bookings', async () => {
    const theirs = await book(1);
    const own = await book(fatima.id, '2026-10-16T10:00:00.000Z');
    const asFatima = await loginAs(t, 'fatima');
    const refused = await asFatima('POST', `/api/appointments/${theirs.number}/online/confirm`);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.message).toBe('Можно менять только свои записи');
    expect((await asFatima('POST', `/api/appointments/${theirs.number}/online/reject`, {})).statusCode).toBe(403);
    expect((await asFatima('POST', `/api/appointments/${own.number}/online/confirm`)).statusCode).toBe(200);
    expect((await t.api('POST', `/api/appointments/${theirs.number}/online/confirm`)).statusCode).toBe(200); // the owner
  });
});

describe('online booking: prepayment holds', () => {
  let t: TestApp;
  let bank: FakeQrProvider;
  let tattoo: Json;
  let fatima: Json;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    bank = new FakeQrProvider();
    t = await createTestApp({ qr: bank, env: { PUBLIC_URL } });
    bindStaffChat(t);
    tattoo = await make(t, '/api/services', { name: 'Тату мини', category: 'tattoo', price: 5000, durationMin: 60, depositAmount: 1000 });
    fatima = await addMaster(t, 'Фатима', 'fatima');
    const anna = await make(t, '/api/clients', { name: 'Анна', phone: '+79991234567' });
    await linkChat(t, anna.id, CHAT);
  });
  afterEach(async () => {
    vi.useRealTimers();
    await t.close();
  });

  const book = async () =>
    (await pub(t, 'POST', '', { items: [{ serviceId: tattoo.id }], masterId: fatima.id, startsAt: FRIDAY_NOON, name: 'Анна', phone: '+79991234567' })).json();
  const appointment = async (id: number) => (await t.api('GET', `/api/appointments/${id}`)).json() as Json;

  it('holds the time while the client pays by QR; the payment confirms it', async () => {
    const booking = await book();
    const holdUntil = new Date(NOW + 15 * MIN).toISOString();
    expect(booking).toMatchObject({
      status: 'awaiting_payment',
      depositRequired: 1000,
      holdUntil,
      payment: { payload: 'https://qr.nspk.ru/QR1?type=02&sum=100000', amount: 1000, expiresAt: holdUntil },
    });
    expect(bank.created).toEqual([{ amount: 1000, purpose: 'Предоплата, MIKAN STUDIO', ttlMinutes: 15 }]);
    expect(await appointment(booking.number)).toMatchObject({
      onlineState: 'awaiting_payment',
      holdUntil,
      depositStatus: 'waiting',
      depositLink: { kind: 'deposit', status: 'pending', amount: 1000, expiresAt: holdUntil },
    });
    expect(t.gateway.textsTo(STAFF_CHAT).at(-1)).toBe(
      '🆕 Онлайн-запись (сайт): Анна, +79991234567, Тату мини — 16 октября, 12:00, мастер Фатима · ждёт оплату до 12:15',
    );
    const request = t.gateway.sent.filter((m) => m.chatId === CHAT).at(-1)!;
    expect(request.text).toBe(
      'Время **16 октября, 12:00** за вами до 12:15 🙌\nЧтобы подтвердить запись, внесите предоплату **1 000 ₽** по кнопке ниже — ' +
        'она зачтётся в стоимость процедуры.\n\nТату мини, мастер Фатима\nЕсли не успеть до 12:15, время освободится.',
    );
    expect(request.keyboard).toEqual([[{ text: '💳 Оплатить предоплату', url: 'https://qr.nspk.ru/QR1?type=02&sum=100000' }]]);
    expect((await t.api('GET', '/api/badges')).json().onlineAwaiting).toBe(0); // waits for the client, not for staff

    // The page polls; the bank reports the money.
    bank.statuses.set('QR1', 'paid');
    vi.setSystemTime(NOW + 3 * MIN);
    const paid = (await pub(t, 'GET', `/b/${booking.token}`)).json();
    expect(paid).toMatchObject({ status: 'confirmed', holdUntil: null, payment: null });
    expect(await appointment(booking.number)).toMatchObject({ onlineState: null, holdUntil: null, deposit: 1000, depositStatus: 'paid' });
    expect(t.gateway.textsTo(STAFF_CHAT).at(-1)).toBe(
      '💳 Онлайн-запись оплачена: Анна, +79991234567, Тату мини — 16 октября, 12:00, мастер Фатима · предоплата 1 000 ₽',
    );
    expect(t.gateway.textsTo(CHAT).at(-1)).toBe(`✅ Запись подтверждена: 16 октября, 12:00, мастер Фатима\nТату мини\n\n${CANCEL_RULE}`);
    expect(t.gateway.textsTo(CHAT).some((m) => m.startsWith('Спасибо! Предоплата'))).toBe(false); // not thanked twice
    const audit = await auditEntries(t, booking.number);
    expect(audit.map((e) => [e.source, e.action])).toEqual([
      ['online', 'appointment.create'],
      ['system', 'appointment.confirm'],
    ]);
    // Nothing is released later.
    vi.setSystemTime(NOW + 20 * MIN);
    expect(await releaseUnpaidHolds(t.ctx)).toBe(0);
  });

  it('releases an unpaid hold once the bank confirms it unpaid: cancelled, code cancelled, time free, everyone told', async () => {
    const booking = await book();
    vi.setSystemTime(NOW + 10 * MIN);
    expect(await releaseUnpaidHolds(t.ctx)).toBe(0); // still within the hold
    vi.setSystemTime(NOW + 16 * MIN);
    expect(await releaseUnpaidHolds(t.ctx)).toBe(1);
    const row = await appointment(booking.number);
    expect(row).toMatchObject({ status: 'cancelled', onlineState: null, holdUntil: null, notes: 'Предоплата не внесена вовремя' });
    expect(row.depositLink.status).toBe('cancelled');
    expect((await pub(t, 'GET', `/b/${booking.token}`)).json()).toMatchObject({ status: 'cancelled', payment: null });
    expect(t.gateway.textsTo(CHAT).at(-1)).toBe(
      `⌛ Время 16 октября, 12:00 освободилось — предоплата не поступила вовремя.\nЗаписаться снова: ${PUBLIC_URL}/book`,
    );
    expect(t.gateway.textsTo(STAFF_CHAT).at(-1)).toBe(
      `⌛ Онлайн-запись №${booking.number} снята — предоплата не поступила вовремя: Анна, +79991234567, Тату мини — 16 октября, 12:00, мастер Фатима`,
    );
    expect((await auditEntries(t, booking.number)).at(-1)).toMatchObject({
      source: 'system',
      employee: null,
      action: 'appointment.status',
      summary: `Онлайн-запись №${booking.number} (Анна) на 16 октября, 12:00 отменена: предоплата не внесена вовремя`,
    });
    const slots = (await pub(t, 'GET', `/slots?date=2026-10-16&items=${tattoo.id}&masterId=${fatima.id}`)).json().items as Json[];
    expect(slots.map((s) => hhmm(s.startsAt))).toContain('12:00');
    // A late payment is still recorded, flagged for staff; the booking stays cancelled.
    bank.statuses.set('QR1', 'paid');
    vi.setSystemTime(NOW + 18 * MIN);
    expect(await releaseUnpaidHolds(t.ctx)).toBe(0);
    await t.api('GET', `/api/qr-payments/${row.depositLink.id}`);
    expect(await appointment(booking.number)).toMatchObject({ status: 'cancelled', deposit: 1000 });
  });

  it('keeps the hold while the bank cannot be asked, and gives up an hour past the hold', async () => {
    const booking = await book();
    bank.statusFailure = new Error('bank down');
    vi.setSystemTime(NOW + 16 * MIN);
    expect(await releaseUnpaidHolds(t.ctx)).toBe(0);
    expect((await appointment(booking.number)).onlineState).toBe('awaiting_payment');
    vi.setSystemTime(NOW + 15 * MIN + HOLD_BANK_WAIT_MS);
    expect(await releaseUnpaidHolds(t.ctx)).toBe(1);
    expect((await appointment(booking.number)).status).toBe('cancelled');
  });

  it('a prepayment taken at the studio meanwhile confirms the hold instead', async () => {
    const booking = await book();
    expect((await t.api('POST', `/api/appointments/${booking.number}/deposit`, { amount: 1000, method: 'transfer' })).statusCode).toBe(200);
    vi.setSystemTime(NOW + 16 * MIN);
    expect(await releaseUnpaidHolds(t.ctx)).toBe(0);
    expect(await appointment(booking.number)).toMatchObject({ status: 'scheduled', onlineState: null, deposit: 1000 });
    expect(t.gateway.textsTo(STAFF_CHAT).at(-1)).toContain('💳 Онлайн-запись оплачена');
  });

  it('waits for staff when the bank does not issue a code, or QR payments are off', async () => {
    bank.createFailure = new Error('bank down');
    const booking = await book();
    expect(booking).toMatchObject({ status: 'awaiting_confirmation', holdUntil: null, payment: null, depositRequired: 1000 });
    t.ctx.qr = null;
    const second = (
      await pub(t, 'POST', '', { items: [{ serviceId: tattoo.id }], masterId: 1, startsAt: FRIDAY_NOON, name: 'Пётр', phone: '+79990000001' })
    ).json();
    expect(second).toMatchObject({ status: 'awaiting_confirmation', payment: null });
    expect((await t.api('GET', '/api/badges')).json().onlineAwaiting).toBe(2);
  });
});
