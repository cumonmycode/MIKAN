import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotSendError } from '../src/bot/gateway.js';
import { handleStart } from '../src/bot/onboarding.js';
import { buildClientContext, buildStablePrompt } from '../src/bot/prompt.js';
import { depositStatusOf, heldAmount } from '../src/domain/deposit-ledger.js';
import { depositLinkTtlMinutes } from '../src/domain/deposit-links.js';
import { DEPOSIT_SWEEP_INTERVAL_MS, sweepQrPayments } from '../src/domain/qr-payments.js';
import { getClientRow } from '../src/domain/refs.js';
import { setStaffChatId } from '../src/domain/settings.js';
import { createTestApp, FakeQrProvider, make, type TestApp } from './helpers.js';

const NOW = Date.parse('2026-10-15T09:00:00.000Z'); // 12:00 Moscow
const STARTS = '2026-10-17T11:00:00.000Z'; // in two days
const CHAT = 777_001;
const STAFF_CHAT = -100777;

type Json = Record<string, any>;

describe('prepayments (deposits)', () => {
  let t: TestApp;
  let bank: FakeQrProvider;
  let tattoo: Json;
  let consult: Json;
  let client: Json;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    bank = new FakeQrProvider();
    t = await createTestApp({ qr: bank });
    tattoo = await make(t, '/api/services', { name: 'Тату среднее', category: 'tattoo', price: 8000, durationMin: 120, depositAmount: 2000 });
    consult = await make(t, '/api/services', { name: 'Консультация', category: 'other', price: 0, durationMin: 15 });
    client = await make(t, '/api/clients', { name: 'Иван Петров', phone: '+79991234567' });
  });
  afterEach(async () => {
    vi.useRealTimers();
    await t.close();
  });

  const post = async (url: string, payload: unknown = {}) => t.api('POST', url, payload);
  const ok = async (url: string, payload: unknown = {}) => {
    const res = await post(url, payload);
    if (res.statusCode !== 200) throw new Error(`POST ${url} → ${res.statusCode}: ${res.body}`);
    return res.json() as Json;
  };
  const appointment = async (id: number) => (await t.api('GET', `/api/appointments/${id}`)).json() as Json;
  const book = (extra: object = {}) =>
    make(t, '/api/appointments', { clientId: client.id, masterId: 1, services: [{ serviceId: tattoo.id }], startsAt: STARTS, ...extra });
  const openShift = (openingCash = 5000) => ok('/api/cash/shift/open', { openingCash });
  const shift = async () => (await t.api('GET', '/api/cash/shift/current')).json().shift as Json;
  const sell = (appointmentId: number, payments: object, price = 8000) =>
    post('/api/sales', {
      appointmentId,
      items: [{ type: 'service', serviceId: tattoo.id, quantity: 1, price }],
      discount: 0,
      payments: { cash: 0, card: 0, transfer: 0, qr: 0, ...payments },
    });
  const report = async () => {
    const from = new Date(NOW - 86_400_000).toISOString();
    const to = new Date(NOW + 86_400_000).toISOString();
    return (await t.api('GET', `/api/reports/summary?from=${from}&to=${to}`)).json() as Json;
  };
  const linkTelegram = async () => {
    const url = (await t.api('POST', `/api/clients/${client.id}/telegram-link`)).json().url as string;
    handleStart(t.ctx, { chatId: CHAT, telegramName: 'Иван', username: 'ivanp' }, new URL(url).searchParams.get('start')!);
    t.gateway.sent = [];
  };

  describe('required amount', () => {
    it('defaults to the services’ prepayments (a service twice counts twice) and can be overridden', async () => {
      expect(tattoo.depositAmount).toBe(2000);
      const two = await book({ services: [{ serviceId: tattoo.id }, { serviceId: tattoo.id }, { serviceId: consult.id }] });
      expect(two).toMatchObject({ depositRequired: 4000, deposit: 0, depositStatus: 'waiting', depositOperations: [], depositLink: null });
      const manual = await book({ startsAt: '2026-10-18T11:00:00.000Z', depositRequired: 1000 });
      expect(manual.depositRequired).toBe(1000);
      const none = await make(t, '/api/appointments', {
        clientId: client.id, masterId: 1, services: [{ serviceId: consult.id }], startsAt: '2026-10-19T11:00:00.000Z',
      });
      expect(none).toMatchObject({ depositRequired: 0, depositStatus: 'none' });
    });

    it('follows replaced services on PATCH unless sent explicitly; ignores the legacy deposit field', async () => {
      const a = await book();
      const patched = (await t.api('PATCH', `/api/appointments/${a.id}`, { services: [{ serviceId: consult.id }], deposit: 5000 })).json();
      expect(patched).toMatchObject({ depositRequired: 0, deposit: 0, depositStatus: 'none' });
      const explicit = (await t.api('PATCH', `/api/appointments/${a.id}`, { depositRequired: 1500 })).json();
      expect(explicit).toMatchObject({ depositRequired: 1500, depositStatus: 'waiting' });
      await t.api('PATCH', `/api/services/${tattoo.id}`, { depositAmount: 3000 });
      expect((await t.api('GET', '/api/services')).json().items.find((s: Json) => s.id === tattoo.id).depositAmount).toBe(3000);
    });
  });

  describe('received at the studio', () => {
    it('needs an open shift for cash and puts it into the drawer', async () => {
      const a = await book();
      const noShift = await post(`/api/appointments/${a.id}/deposit`, { amount: 2000, method: 'cash' });
      expect(noShift.statusCode).toBe(409);
      expect(noShift.json().error.message).toBe('Чтобы принять 2 000 ₽ наличными, сначала откройте кассовую смену');

      const opened = await openShift(5000);
      const paid = await ok(`/api/appointments/${a.id}/deposit`, { amount: 2000, method: 'cash', note: 'на ресепшене' });
      expect(paid).toMatchObject({ deposit: 2000, depositStatus: 'paid' });
      expect(paid.depositOperations).toEqual([
        expect.objectContaining({
          type: 'receive', amount: 2000, method: 'cash', shiftId: opened.id, saleId: null, note: 'на ресепшене',
          employee: expect.objectContaining({ id: 1 }),
        }),
      ]);
      const current = await shift();
      expect(current.summary.deposits).toEqual({ received: 2000, cash: 2000, card: 0, transfer: 0, qr: 0, refunded: 0, cashRefunded: 0, retained: 0 });
      expect(current.summary.revenue).toBe(0);
      expect(current.expectedCash).toBe(7000);
    });

    it('takes transfers without a shift and refuses closed appointments', async () => {
      const a = await book();
      const paid = await ok(`/api/appointments/${a.id}/deposit`, { amount: 1000, method: 'transfer' });
      expect(paid.depositOperations[0]).toMatchObject({ method: 'transfer', shiftId: null });
      expect((await post(`/api/appointments/${a.id}/deposit`, { amount: 0, method: 'transfer' })).statusCode).toBe(400);
      expect((await post(`/api/appointments/${a.id}/deposit`, { amount: 100, method: 'qr' })).statusCode).toBe(400);
      await t.api('PATCH', `/api/appointments/${a.id}`, { status: 'cancelled' });
      const cancelled = await post(`/api/appointments/${a.id}/deposit`, { amount: 1000, method: 'transfer' });
      expect(cancelled.statusCode).toBe(409);
      expect(cancelled.json().error.message).toBe('Запись отменена — предоплату по ней не принимают');
    });

    it('records one receipt per Idempotency-Key', async () => {
      const a = await book();
      const key = '7b0c5a0e-8a5e-4f7e-9d43-0d6f0f6a2b11';
      const send = () =>
        t.app.inject({
          method: 'POST',
          url: `/api/appointments/${a.id}/deposit`,
          headers: { authorization: `Bearer ${t.token}`, 'idempotency-key': key },
          payload: { amount: 2000, method: 'transfer' },
        });
      expect((await send()).statusCode).toBe(200);
      const again = await send();
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect((await appointment(a.id)).depositOperations).toHaveLength(1);
    });
  });

  describe('checkout', () => {
    it('counts the prepayment once: as cash when received, as a separate part of the sale', async () => {
      const opened = await openShift(5000);
      const a = await book();
      await ok(`/api/appointments/${a.id}/deposit`, { amount: 2000, method: 'cash' });
      const sale = await sell(a.id, { cash: 6000, deposit: 2000 });
      expect(sale.statusCode).toBe(200);
      expect(sale.json()).toMatchObject({ total: 8000, payments: { cash: 6000, card: 0, transfer: 0, qr: 0, deposit: 2000 } });

      const after = await appointment(a.id);
      expect(after).toMatchObject({ status: 'completed', saleId: sale.json().id, deposit: 0, depositStatus: 'applied' });
      expect(after.depositOperations.map((op: Json) => [op.type, op.amount, op.saleId])).toEqual([
        ['receive', 2000, null],
        ['apply', 2000, sale.json().id],
      ]);
      const current = await shift();
      expect(current.id).toBe(opened.id);
      expect(current.summary).toMatchObject({ revenue: 8000, cash: 6000, deposit: 2000 });
      expect(current.summary.deposits).toMatchObject({ received: 2000, cash: 2000 });
      // 5000 opening + 2000 prepayment + 6000 at checkout — not 2000 twice.
      expect(current.expectedCash).toBe(13000);

      const r = await report();
      expect(r.revenue).toBe(8000);
      expect(r.payments).toEqual({ cash: 6000, card: 0, transfer: 0, qr: 0, deposit: 2000 });
      expect(r.deposits).toEqual({ received: 2000, cash: 2000, card: 0, transfer: 0, qr: 0, applied: 2000, refunded: 0, retained: 0, held: 0 });
    });

    it('refuses clients that predate prepayments, more than is held, and a prepayment without an appointment', async () => {
      await openShift();
      const a = await book();
      await ok(`/api/appointments/${a.id}/deposit`, { amount: 2000, method: 'transfer' });
      const legacy = await post('/api/sales', {
        appointmentId: a.id,
        items: [{ type: 'service', serviceId: tattoo.id, quantity: 1, price: 8000 }],
        discount: 0,
        payments: { cash: 6000, card: 0, transfer: 2000 },
      });
      expect(legacy.statusCode).toBe(409);
      expect(legacy.json().error.message).toBe('По записи внесена предоплата 2 000 ₽. Обновите приложение MIKAN, чтобы зачесть её в чеке.');
      const tooMuch = await sell(a.id, { cash: 5000, deposit: 3000 });
      expect(tooMuch.statusCode).toBe(409);
      expect(tooMuch.json().error.message).toBe('За записью только 2 000 ₽ предоплаты');
      const noAppointment = await post('/api/sales', {
        items: [{ type: 'service', name: 'Тату', quantity: 1, price: 1000 }],
        discount: 0,
        payments: { cash: 0, card: 0, transfer: 0, qr: 0, deposit: 1000 },
      });
      expect(noAppointment.statusCode).toBe(400);
      expect((await appointment(a.id)).deposit).toBe(2000);
    });

    it('keeps the rest of a prepayment larger than the bill for the appointment', async () => {
      await openShift();
      const a = await book({ depositRequired: 3000 });
      await ok(`/api/appointments/${a.id}/deposit`, { amount: 3000, method: 'transfer' });
      expect((await sell(a.id, { deposit: 2500 }, 2500)).statusCode).toBe(200);
      expect(await appointment(a.id)).toMatchObject({ deposit: 500, depositStatus: 'paid' });
      const refunded = await ok(`/api/appointments/${a.id}/deposit/refund`, { reason: 'Остаток предоплаты' });
      expect(refunded).toMatchObject({ deposit: 0, depositStatus: 'applied' });
      expect(refunded.depositOperations.at(-1)).toMatchObject({ type: 'refund', amount: 500, method: 'transfer', note: 'Остаток предоплаты' });
    });

    it('returns the prepayment part of a refunded sale to the appointment, which can be paid again', async () => {
      await openShift(5000);
      const a = await book();
      await ok(`/api/appointments/${a.id}/deposit`, { amount: 2000, method: 'transfer' });
      const sale = (await sell(a.id, { cash: 6000, deposit: 2000 })).json();
      const refund = await post(`/api/sales/${sale.id}/refund`, { reason: 'Ошибка в чеке', restock: true });
      expect(refund.statusCode).toBe(200);
      const restored = await appointment(a.id);
      expect(restored).toMatchObject({ deposit: 2000, depositStatus: 'paid' });
      expect(restored.depositOperations.at(-1)).toMatchObject({ type: 'unapply', amount: 2000, saleId: sale.id, note: `Возврат чека №${sale.number}` });
      const current = await shift();
      // Only the cash part leaves the drawer.
      expect(current.summary).toMatchObject({ refunds: 8000, cashRefunds: 6000 });
      expect(current.expectedCash).toBe(5000);

      const again = await sell(a.id, { cash: 6000, deposit: 2000 });
      expect(again.statusCode).toBe(200);
      expect(await appointment(a.id)).toMatchObject({ deposit: 0, depositStatus: 'applied', saleId: again.json().id });
      expect((await report()).deposits).toMatchObject({ received: 2000, applied: 2000, held: 0 });
    });
  });

  describe('cancellation and no-show', () => {
    it('refunds the held prepayment the way it was received; cash leaves the drawer', async () => {
      const opened = await openShift(5000);
      const a = await book();
      await ok(`/api/appointments/${a.id}/deposit`, { amount: 2000, method: 'cash' });
      await t.api('PATCH', `/api/appointments/${a.id}`, { status: 'cancelled' });
      expect((await post(`/api/appointments/${a.id}/deposit/refund`, { amount: 2500 })).statusCode).toBe(409);
      const refunded = await ok(`/api/appointments/${a.id}/deposit/refund`, { reason: 'Клиент отменил' });
      expect(refunded).toMatchObject({ deposit: 0, depositStatus: 'refunded' });
      expect(refunded.depositOperations.at(-1)).toMatchObject({ type: 'refund', amount: 2000, method: 'cash', shiftId: opened.id });
      const current = await shift();
      expect(current.summary.deposits).toMatchObject({ received: 2000, cash: 2000, refunded: 2000, cashRefunded: 2000 });
      expect(current.expectedCash).toBe(5000);
      const nothing = await post(`/api/appointments/${a.id}/deposit/refund`);
      expect(nothing.statusCode).toBe(409);
      expect(nothing.json().error.message).toBe('По записи нет внесённой предоплаты');
    });

    it('retains only for a cancelled appointment or a no-show and shows it in the report', async () => {
      const a = await book();
      await ok(`/api/appointments/${a.id}/deposit`, { amount: 2000, method: 'transfer' });
      const early = await post(`/api/appointments/${a.id}/deposit/retain`);
      expect(early.statusCode).toBe(409);
      expect(early.json().error.message).toBe('Удержать предоплату можно только по отменённой записи или при неявке');
      await t.api('PATCH', `/api/appointments/${a.id}`, { status: 'no_show' });
      const kept = await ok(`/api/appointments/${a.id}/deposit/retain`);
      expect(kept).toMatchObject({ deposit: 0, depositStatus: 'retained' });
      expect(kept.depositOperations.at(-1)).toMatchObject({ type: 'retain', amount: 2000, method: null, note: 'Неявка' });
      expect((await report()).deposits).toMatchObject({ received: 2000, transfer: 2000, retained: 2000, held: 0 });
    });

    it('a cash refund needs an open shift', async () => {
      const a = await book();
      await openShift();
      await ok(`/api/appointments/${a.id}/deposit`, { amount: 2000, method: 'cash' });
      await ok('/api/cash/shift/close', { closingCash: 7000 });
      const res = await post(`/api/appointments/${a.id}/deposit/refund`);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.message).toBe('Чтобы вернуть 2 000 ₽ наличными, сначала откройте кассовую смену');
      const byTransfer = await ok(`/api/appointments/${a.id}/deposit/refund`, { method: 'transfer' });
      expect(byTransfer.depositOperations.at(-1)).toMatchObject({ method: 'transfer', shiftId: null });
    });
  });

  describe('SBP QR codes', () => {
    it('shows a 10-minute code at the studio and records the prepayment once the bank confirms it', async () => {
      setStaffChatId(t.ctx.db, STAFF_CHAT);
      await linkTelegram();
      await openShift();
      const a = await book();
      const result = await ok(`/api/appointments/${a.id}/deposit/qr`, { delivery: 'screen' });
      expect(result.sendError).toBeNull();
      expect(result.payment).toMatchObject({ kind: 'deposit', appointmentId: a.id, status: 'pending', amount: 2000, sale: null, sentAt: null });
      expect(bank.created[0]).toMatchObject({ amount: 2000, ttlMinutes: 10 });
      expect(bank.created[0]!.purpose).toBe('Предоплата, MIKAN STUDIO');
      expect(result.appointment.depositLink).toMatchObject({ id: result.payment.id, status: 'pending' });
      expect(t.gateway.textsTo(CHAT)).toEqual([]);

      bank.statuses.set('QR1', 'paid');
      const polled = (await t.api('GET', `/api/qr-payments/${result.payment.id}`)).json();
      expect(polled).toMatchObject({ status: 'paid', error: null, sale: null });
      const after = await appointment(a.id);
      expect(after).toMatchObject({ deposit: 2000, depositStatus: 'paid', depositLink: { status: 'paid' } });
      expect(after.depositOperations).toEqual([
        expect.objectContaining({ type: 'receive', method: 'qr', amount: 2000, qrPaymentId: result.payment.id }),
      ]);
      expect((await shift()).summary.deposits).toMatchObject({ received: 2000, qr: 2000, cash: 0 });
      expect(t.gateway.textsTo(CHAT)).toEqual(['Спасибо! Предоплата 2 000 ₽ получена ✅\nЖдём вас суббота, 17 октября в 14:00.']);
      expect(t.gateway.textsTo(STAFF_CHAT)[0]).toBe('💳 Предоплата 2 000 ₽ по СБП получена: Иван Петров, запись 17.10.2026 14:00');

      // Polling again does not record it twice.
      await t.api('GET', `/api/qr-payments/${result.payment.id}`);
      await sweepQrPayments(t.ctx);
      expect((await appointment(a.id)).depositOperations).toHaveLength(1);
      const covered = await post(`/api/appointments/${a.id}/deposit/qr`, { delivery: 'screen' });
      expect(covered.json().error.message).toBe('Предоплата по записи уже внесена');
    });

    it('sends a link in Telegram valid until the appointment, and refuses when the client has no chat', async () => {
      const a = await book();
      const noChat = await post(`/api/appointments/${a.id}/deposit/qr`, { delivery: 'telegram' });
      expect(noChat.statusCode).toBe(409);
      expect(noChat.json().error.message).toContain('Клиент ещё не писал боту в Telegram');
      expect(bank.created).toHaveLength(0);

      await linkTelegram();
      const sent = await ok(`/api/appointments/${a.id}/deposit/qr`, { delivery: 'telegram' });
      expect(sent.sendError).toBeNull();
      expect(sent.payment.sentAt).toBe(new Date(NOW).toISOString());
      expect(bank.created[0]!.ttlMinutes).toBe(50 * 60);
      expect(sent.payment.expiresAt).toBe(STARTS);
      const [message] = t.gateway.textsTo(CHAT);
      expect(message).toContain('Для подтверждения записи в MIKAN STUDIO нужна предоплата 2 000 ₽.');
      expect(message).toContain('Когда: суббота, 17 октября в 14:00');
      expect(message).toContain('Услуга: Тату среднее');
      expect(message).toContain(`Оплатить через СБП: ${sent.payment.payload}`);
      expect(message).toContain('Ссылка действует до 17.10.2026 14:00.');
      // The message is kept in the conversation the staff see.
      const messages = (await t.api('GET', `/api/bot/chats/${CHAT}/messages`)).json().items as Json[];
      expect(messages.at(-1)).toMatchObject({ role: 'system', text: message });

      t.gateway.running = false;
      const off = await post(`/api/appointments/${a.id}/deposit/qr`, { delivery: 'telegram' });
      expect(off.statusCode).toBe(409);
      expect(off.json().error.message).toContain('Telegram-бот выключен');
    });

    it('sends to the booking request chat and attributes it to the client', async () => {
      handleStart(t.ctx, { chatId: CHAT + 1, telegramName: 'Аноним', username: null }, '');
      t.gateway.sent = [];
      const a = await book();
      const sent = await ok(`/api/appointments/${a.id}/deposit/qr`, { delivery: 'telegram', chatId: CHAT + 1 });
      expect(sent.sendError).toBeNull();
      expect(t.gateway.textsTo(CHAT + 1).at(-1)).toContain('нужна предоплата 2 000 ₽');
      expect((await t.api('GET', `/api/clients/${client.id}/chat`)).json().chat).toMatchObject({ chatId: CHAT + 1 });
      expect((await post(`/api/appointments/${a.id}/deposit/qr`, { delivery: 'telegram', chatId: 42 })).statusCode).toBe(400);
    });

    it('reports a delivery failure but keeps the link, which can be shared another way', async () => {
      await linkTelegram();
      const a = await book();
      t.gateway.failures.push(new BotSendError('Forbidden', true));
      const res = await ok(`/api/appointments/${a.id}/deposit/qr`, { delivery: 'telegram' });
      expect(res.sendError).toBe('Клиент заблокировал бота — сообщение не доставлено');
      expect(res.payment).toMatchObject({ status: 'pending', sentAt: null });
      const link = await ok(`/api/appointments/${a.id}/deposit/qr`, { delivery: 'link', amount: 1000 });
      expect(link.payment).toMatchObject({ amount: 1000, status: 'pending', sentAt: null });
      expect(t.gateway.textsTo(CHAT)).toEqual([]);
    });

    it('a new link cancels the old one; paying the old one anyway is recorded and flagged', async () => {
      setStaffChatId(t.ctx.db, STAFF_CHAT);
      await linkTelegram();
      const a = await book();
      const first = await ok(`/api/appointments/${a.id}/deposit/qr`, { delivery: 'telegram' });
      const second = await ok(`/api/appointments/${a.id}/deposit/qr`, { delivery: 'telegram' });
      expect((await t.api('GET', `/api/qr-payments/${first.payment.id}`)).json().status).toBe('cancelled');
      expect(second.appointment.depositLink.id).toBe(second.payment.id);

      bank.statuses.set('QR1', 'paid');
      vi.setSystemTime(NOW + DEPOSIT_SWEEP_INTERVAL_MS);
      await sweepQrPayments(t.ctx);
      const old = (await t.api('GET', `/api/qr-payments/${first.payment.id}`)).json();
      expect(old.status).toBe('paid');
      expect(old.error).toContain('по ссылке, которая уже была заменена или отменена');
      expect(await appointment(a.id)).toMatchObject({ deposit: 2000, depositStatus: 'paid' });
      expect(t.gateway.textsTo(STAFF_CHAT).some((m) => m.startsWith(`⚠️ Оплата по QR №${first.payment.id}`))).toBe(true);
      // No thank-you for an unexpected payment.
      expect(t.gateway.textsTo(CHAT).some((m) => m.startsWith('Спасибо!'))).toBe(false);

      bank.statuses.set('QR2', 'paid');
      vi.setSystemTime(NOW + 2 * DEPOSIT_SWEEP_INTERVAL_MS);
      await sweepQrPayments(t.ctx);
      const over = (await t.api('GET', `/api/qr-payments/${second.payment.id}`)).json();
      expect(over.error).toContain('Предоплата внесена сверх нужной суммы: за записью 4 000 ₽ при 2 000 ₽.');
      expect((await appointment(a.id)).deposit).toBe(4000);
    });

    it('a payment that has just arrived on the old code counts before a new code is issued', async () => {
      const a = await book();
      const first = await ok(`/api/appointments/${a.id}/deposit/qr`, { delivery: 'link' });
      bank.statuses.set('QR1', 'paid');
      const again = await post(`/api/appointments/${a.id}/deposit/qr`, { delivery: 'link' });
      expect(again.statusCode).toBe(409);
      expect(again.json().error.message).toBe('Предоплата по записи уже внесена');
      expect((await t.api('GET', `/api/qr-payments/${first.payment.id}`)).json()).toMatchObject({ status: 'paid', error: null });
    });

    it('reminds with the pending link, or sends a fresh one when it is about to expire', async () => {
      await linkTelegram();
      const a = await book();
      const first = await ok(`/api/appointments/${a.id}/deposit/qr`, { delivery: 'telegram' });
      vi.setSystemTime(NOW + 60 * 60_000);
      const reminded = await ok(`/api/appointments/${a.id}/deposit/remind`);
      expect(reminded.payment.id).toBe(first.payment.id);
      expect(reminded.payment.sentAt).toBe(new Date(NOW + 60 * 60_000).toISOString());
      expect(t.gateway.textsTo(CHAT).at(-1)).toMatch(/^Напоминаем о предоплате 2 000 ₽ за запись в MIKAN STUDIO — суббота, 17 октября в 14:00\./);

      vi.setSystemTime(Date.parse(STARTS) - 10 * 60_000);
      const fresh = await ok(`/api/appointments/${a.id}/deposit/remind`);
      expect(fresh.payment.id).not.toBe(first.payment.id);
      expect(bank.created.at(-1)!.ttlMinutes).toBe(30);
      expect(t.gateway.textsTo(CHAT).at(-1)).toContain('нужна предоплата 2 000 ₽');

      bank.statuses.set(`QR${bank.created.length}`, 'paid');
      const done = await post(`/api/appointments/${a.id}/deposit/remind`);
      expect(done.statusCode).toBe(409);
      expect(done.json().error.message).toBe('Предоплата по записи уже внесена');
    });

    it('cancelling the appointment stops its pending codes; prepayment links are checked at most once a minute', async () => {
      const a = await book();
      const code = await ok(`/api/appointments/${a.id}/deposit/qr`, { delivery: 'link' });
      await sweepQrPayments(t.ctx);
      const checks = bank.statusChecks;
      await sweepQrPayments(t.ctx);
      expect(bank.statusChecks).toBe(checks);
      vi.setSystemTime(NOW + DEPOSIT_SWEEP_INTERVAL_MS);
      await sweepQrPayments(t.ctx);
      expect(bank.statusChecks).toBe(checks + 1);

      await t.api('PATCH', `/api/appointments/${a.id}`, { status: 'cancelled' });
      expect((await t.api('GET', `/api/qr-payments/${code.payment.id}`)).json().status).toBe('cancelled');
      expect((await post(`/api/appointments/${a.id}/deposit/qr`, { delivery: 'link' })).statusCode).toBe(409);
    });
  });

  describe('SBP QR codes: edge cases', () => {
    it('never sends to or re-attributes another client’s chat', async () => {
      await linkTelegram();
      const other = await make(t, '/api/clients', { name: 'Пётр', phone: '+79990000000' });
      const theirs = await make(t, '/api/appointments', {
        clientId: other.id, masterId: 1, services: [{ serviceId: tattoo.id }], startsAt: '2026-10-18T11:00:00.000Z',
      });
      const res = await post(`/api/appointments/${theirs.id}/deposit/qr`, { delivery: 'telegram', chatId: CHAT });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.message).toBe('Этот чат Telegram принадлежит другому клиенту — ссылка не отправлена');
      expect(bank.created).toHaveLength(0);
      expect(t.gateway.textsTo(CHAT)).toEqual([]);
      expect((await t.api('GET', `/api/clients/${client.id}/chat`)).json().chat).toMatchObject({ chatId: CHAT });
      expect((await t.api('GET', `/api/clients/${other.id}/chat`)).json().chat).toBeNull();
    });

    it('a reminder after a partial payment sends a new link for what is missing', async () => {
      await linkTelegram();
      const a = await book({ depositRequired: 3000 });
      const first = await ok(`/api/appointments/${a.id}/deposit/qr`, { delivery: 'telegram' });
      expect(first.payment.amount).toBe(3000);
      await ok(`/api/appointments/${a.id}/deposit`, { amount: 1000, method: 'transfer' });
      const reminded = await ok(`/api/appointments/${a.id}/deposit/remind`);
      expect(reminded.payment).toMatchObject({ amount: 2000, status: 'pending' });
      expect(reminded.payment.id).not.toBe(first.payment.id);
      expect((await t.api('GET', `/api/qr-payments/${first.payment.id}`)).json().status).toBe('cancelled');
      expect(t.gateway.textsTo(CHAT).at(-1)).toContain('нужна предоплата 2 000 ₽');
    });

    it('records a payment on a code of a cancelled appointment and says what to do', async () => {
      setStaffChatId(t.ctx.db, STAFF_CHAT);
      const a = await book();
      const code = await ok(`/api/appointments/${a.id}/deposit/qr`, { delivery: 'link' });
      await t.api('PATCH', `/api/appointments/${a.id}`, { status: 'cancelled' });
      bank.statuses.set('QR1', 'paid');
      vi.setSystemTime(NOW + DEPOSIT_SWEEP_INTERVAL_MS);
      await sweepQrPayments(t.ctx);
      const paid = (await t.api('GET', `/api/qr-payments/${code.payment.id}`)).json();
      expect(paid).toMatchObject({ status: 'paid' });
      expect(paid.error).toBe('Предоплата 2 000 ₽ поступила по отменённой записи — верните её клиенту или удержите в карточке записи.');
      expect(await appointment(a.id)).toMatchObject({ deposit: 2000, depositStatus: 'paid' });
      expect(t.gateway.textsTo(STAFF_CHAT).some((m) => m.includes('поступила по отменённой записи'))).toBe(true);
    });

    it('flags a payment that arrives after checkout; a code cancelled by completing the appointment is fine', async () => {
      await openShift();
      const paidLater = await book();
      const late = await ok(`/api/appointments/${paidLater.id}/deposit/qr`, { delivery: 'link' });
      expect((await sell(paidLater.id, { cash: 8000, deposit: 0 })).statusCode).toBe(200);
      bank.statuses.set('QR1', 'paid');
      await t.api('GET', `/api/qr-payments/${late.payment.id}`);
      expect((await t.api('GET', `/api/qr-payments/${late.payment.id}`)).json().error).toBe(
        'Предоплата 2 000 ₽ поступила, когда запись уже была оплачена, — верните её клиенту в карточке записи.',
      );

      const completed = await book({ startsAt: '2026-10-18T11:00:00.000Z' });
      const code = await ok(`/api/appointments/${completed.id}/deposit/qr`, { delivery: 'link' });
      await ok(`/api/appointments/${completed.id}/complete`, { sendAftercare: false });
      bank.statuses.set('QR2', 'paid');
      const paid = (await t.api('GET', `/api/qr-payments/${code.payment.id}`)).json();
      expect(paid).toMatchObject({ status: 'paid', error: null });
      expect((await sell(completed.id, { cash: 6000, deposit: 2000 })).statusCode).toBe(200);
    });

    it('cancels a prepayment code through /qr-payments/:id/cancel and records each payment once under concurrent polls', async () => {
      const a = await book();
      const code = await ok(`/api/appointments/${a.id}/deposit/qr`, { delivery: 'screen' });
      expect((await post(`/api/qr-payments/${code.payment.id}/cancel`)).json().status).toBe('cancelled');
      expect((await appointment(a.id)).depositLink.status).toBe('cancelled');

      const again = await ok(`/api/appointments/${a.id}/deposit/qr`, { delivery: 'screen' });
      bank.statuses.set('QR2', 'paid');
      bank.statusDelayMs = 20;
      await Promise.all([
        t.api('GET', `/api/qr-payments/${again.payment.id}`),
        t.api('GET', `/api/qr-payments/${again.payment.id}`),
        sweepQrPayments(t.ctx),
      ]);
      const ops = (await appointment(a.id)).depositOperations as Json[];
      expect(ops.filter((op) => op.type === 'receive')).toHaveLength(1);
    });

    it('needs an amount when the appointment requires no prepayment', async () => {
      const a = await make(t, '/api/appointments', {
        clientId: client.id, masterId: 1, services: [{ serviceId: consult.id }], startsAt: '2026-10-19T11:00:00.000Z',
      });
      const res = await post(`/api/appointments/${a.id}/deposit/qr`, { delivery: 'link' });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.message).toBe('Для записи не указана предоплата — задайте сумму в записи или в ссылке');
      expect((await ok(`/api/appointments/${a.id}/deposit/qr`, { delivery: 'link', amount: 500 })).payment.amount).toBe(500);
    });
  });

  describe('reports and the bot', () => {
    it('keeps held(start) + received − applied − refunded − retained = held(end)', async () => {
      await openShift();
      const a = await book();
      const b = await book({ startsAt: '2026-10-18T11:00:00.000Z' });
      await ok(`/api/appointments/${a.id}/deposit`, { amount: 2000, method: 'transfer' });
      await ok(`/api/appointments/${b.id}/deposit`, { amount: 3000, method: 'card' });
      vi.setSystemTime(NOW + 3 * 3_600_000);
      const mark = Date.now();
      await sell(a.id, { cash: 6000, deposit: 2000 });
      await ok(`/api/appointments/${b.id}/deposit/refund`, { amount: 1000 });
      await t.api('PATCH', `/api/appointments/${b.id}`, { status: 'cancelled' });
      await ok(`/api/appointments/${b.id}/deposit/retain`);
      const from = new Date(mark).toISOString();
      const to = new Date(mark + 3_600_000).toISOString();
      const window = (await t.api('GET', `/api/reports/summary?from=${from}&to=${to}`)).json().deposits as Json;
      const before = (await t.api('GET', `/api/reports/summary?from=${new Date(NOW).toISOString()}&to=${from}`)).json().deposits as Json;
      expect(before).toMatchObject({ received: 5000, card: 3000, transfer: 2000, held: 5000 });
      expect(window).toMatchObject({ received: 0, applied: 2000, refunded: 1000, retained: 2000, held: 0 });
      expect(before.held + window.received - window.applied - window.refunded - window.retained).toBe(window.held);
    });

    it('tells the AI which services need a prepayment and whether the client has paid it', async () => {
      await linkTelegram();
      const a = await book();
      expect(buildStablePrompt(t.ctx.db)).toContain('предоплата 2 000 ₽');
      const row = getClientRow(t.ctx.db, client.id);
      expect(buildClientContext(t.ctx.db, Date.now(), row, null)).toContain('ждём предоплату 2 000 ₽');
      await ok(`/api/appointments/${a.id}/deposit/qr`, { delivery: 'telegram' });
      expect(buildClientContext(t.ctx.db, Date.now(), row, null)).toContain('ссылка на оплату уже отправлена в этот чат');
      await ok(`/api/appointments/${a.id}/deposit`, { amount: 500, method: 'transfer' });
      expect(buildClientContext(t.ctx.db, Date.now(), row, null)).toContain('внесено 500 ₽ из 2 000 ₽ предоплаты');
      await ok(`/api/appointments/${a.id}/deposit`, { amount: 1500, method: 'transfer' });
      expect(buildClientContext(t.ctx.db, Date.now(), row, null)).toContain('предоплата 2 000 ₽ внесена');
    });
  });
});

describe('deposit ledger arithmetic', () => {
  const op = (type: string, amount: number) => ({ type, amount });

  it('derives the held amount and status', () => {
    expect(heldAmount([])).toBe(0);
    expect(depositStatusOf([], 2000, 'scheduled')).toBe('waiting');
    expect(depositStatusOf([], 2000, 'completed')).toBe('none');
    expect(depositStatusOf([], 0, 'scheduled')).toBe('none');
    const partial = [op('receive', 3000), op('apply', 2500)];
    expect(heldAmount(partial)).toBe(500);
    expect(depositStatusOf(partial, 3000, 'completed')).toBe('paid');
    expect(depositStatusOf([...partial, op('refund', 500)], 3000, 'completed')).toBe('applied');
    expect(depositStatusOf([op('receive', 2000), op('apply', 2000), op('unapply', 2000)], 2000, 'completed')).toBe('paid');
    expect(depositStatusOf([op('receive', 2000), op('retain', 2000)], 2000, 'no_show')).toBe('retained');
    expect(depositStatusOf([op('receive', 2000), op('refund', 2000)], 2000, 'cancelled')).toBe('refunded');
  });

  it('keeps a link valid until the appointment, between 30 minutes and 3 days', () => {
    const now = Date.parse('2026-10-15T09:00:00.000Z');
    expect(depositLinkTtlMinutes(now + 5 * 60_000, now)).toBe(30);
    expect(depositLinkTtlMinutes(now + 2 * 3_600_000, now)).toBe(120);
    expect(depositLinkTtlMinutes(now + 10 * 86_400_000, now)).toBe(72 * 60);
    expect(depositLinkTtlMinutes(now - 3_600_000, now)).toBe(30);
  });
});
