import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dueDigest, eveningDigest, morningDigest, sendDueDigests } from '../src/bot/digest.js';
import { cashShifts, employees, openReceipts, sales } from '../src/db/schema.js';
import { setChatEmployee, upsertChat } from '../src/domain/bot-chats.js';
import { createTestApp, make, openShift, type TestApp } from './helpers.js';

const HOUR = 3_600_000;
/** Monday 19 October 2026, 09:40 in Moscow (UTC+3). */
const MORNING = Date.parse('2026-10-19T06:40:00Z');
/** The same day, 21:40 in Moscow. */
const EVENING = Date.parse('2026-10-19T18:40:00Z');
const msk = (iso: string) => new Date(Date.parse(`${iso}+03:00`)).toISOString();
const STAFF_CHAT = 7001;
const CLIENT_CHAT = 7002;

describe('staff digests', () => {
  let t: TestApp;
  let lobe: { id: number };
  let anna: { id: number };
  let oleg: { id: number };
  const admin = () => t.ctx.db.select().from(employees).where(eq(employees.id, 1)).get()!;

  beforeEach(async () => {
    t = await createTestApp();
    lobe = await make(t, '/api/services', { name: 'Мочка', category: 'piercing', price: 1600, durationMin: 30 });
    anna = await make(t, '/api/clients', { name: 'Анна', lastName: 'Иванова', phone: '+79990000001', birthday: '1995-10-19' });
    oleg = await make(t, '/api/clients', { name: 'Олег', phone: '+79990000002' });
    const fatima = await make(t, '/api/employees', { name: 'Фатима', login: 'fatima', password: 'secret123', color: '#FF00AA', isMaster: true });
    const book = (body: object) => make(t, '/api/appointments', { services: [{ serviceId: lobe.id }], force: true, ...body });
    await book({ clientId: anna.id, masterId: 1, startsAt: msk('2026-10-19T12:00:00'), depositRequired: 1000 });
    await book({ clientId: oleg.id, masterId: fatima.id, startsAt: msk('2026-10-19T15:00:00') });
    await book({ clientId: oleg.id, masterId: 1, startsAt: msk('2026-10-20T10:00:00'), depositRequired: 500 });
    await book({ clientId: anna.id, masterId: 1, startsAt: msk('2026-10-17T13:00:00'), status: 'completed' });
    await make(t, '/api/receipts', { clientId: oleg.id });
    t.ctx.db.update(openReceipts).set({ createdAt: MORNING - 30 * HOUR }).run();
    upsertChat(t.ctx.db, STAFF_CHAT, { telegramName: 'Админ', username: null });
    setChatEmployee(t.ctx.db, STAFF_CHAT, 1);
    upsertChat(t.ctx.db, CLIENT_CHAT, { telegramName: 'Клиент', username: null });
  });
  afterEach(async () => {
    vi.useRealTimers();
    await t.close();
  });

  it('the morning digest shows the day, what needs attention and tomorrow', () => {
    const text = morningDigest(t.ctx.db, MORNING, admin());
    expect(text).toContain('☀️ **Доброе утро, Админ!**\nПонедельник, 19 октября');
    expect(text).toContain('📅 **Сегодня — 2 записи** · ожидается 3 200 ₽');
    expect(text).toContain('• **12:00** Анна Иванова — Мочка · вы · 1 600 ₽ 🎂');
    expect(text).toContain('• **15:00** Олег — Мочка · Фатима · 1 600 ₽');
    expect(text).toContain('⚠️ **Обратить внимание**');
    expect(text).toContain('• ⏳ Ждём предоплату: Анна Иванова (сегодня 12:00, 1 000 ₽), Олег (завтра 10:00, 500 ₽)');
    expect(text).toContain('• 💳 Не оплачены прошлые визиты: 1 — Анна Иванова (17.10, 1 600 ₽)');
    expect(text).toContain('• 🧾 Открытые чеки с прошлых дней: 1 — закройте или удалите');
    expect(text).toContain('• 🎂 Сегодня день рождения: Анна Иванова — запись в 12:00');
    expect(text).toMatch(/📆 \*\*Завтра\*\* — 1 запись, первая в 10:00$/);
  });

  it('the evening digest sums up the day and lists tomorrow', async () => {
    await t.api('POST', '/api/cash/shift/open', { openingCash: 5000 });
    await t.api('POST', '/api/sales', {
      clientId: oleg.id, items: [{ type: 'service', serviceId: lobe.id, quantity: 1 }], discount: 0,
      payments: { cash: 1000, card: 0, transfer: 600, qr: 0, deposit: 0 },
    });
    t.ctx.db.update(sales).set({ createdAt: EVENING - 2 * HOUR }).run();
    const text = eveningDigest(t.ctx.db, EVENING, admin());
    expect(text).toContain('🌙 **Итоги дня, Админ**\nПонедельник, 19 октября');
    expect(text).toContain('💰 **Выручка — 1 600 ₽**\n• 1 чек · средний 1 600 ₽\n• Наличные 1 000 ₽ · перевод 600 ₽');
    expect(text).toContain('💳 **Не оплачены сегодня**\n• **12:00** Анна Иванова — Мочка · вы · 1 600 ₽\n• **15:00** Олег — Мочка · Фатима · 1 600 ₽');
    expect(text).toContain('• 🧾 Открытые чеки: 1 — закройте или удалите');
    expect(text).toContain('• 🏦 Смена открыта — в кассе должно быть **6 000 ₽**. Не забудьте закрыть');
    expect(text).toContain('📆 **Завтра — 1 запись**\n• **10:00** Олег — Мочка · вы · 1 600 ₽ ⏳\n⏳ — ждём предоплату');
  });

  it('the evening revenue follows analytics: without bonuses and certificates sold, net of the refunds made today', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const sell = async (clientId: number, items: object[], payments: object) => {
      const res = await t.api('POST', '/api/sales', { clientId, items, discount: 0, payments });
      expect(res.statusCode).toBe(200);
      return res.json();
    };
    const lobeLine = { type: 'service', serviceId: lobe.id, quantity: 1 };
    // Yesterday's sale, refunded today.
    vi.setSystemTime(EVENING - 26 * HOUR);
    await openShift(t);
    const yesterday = await sell(anna.id, [lobeLine], { transfer: 1600 });
    vi.setSystemTime(EVENING - 3 * HOUR);
    await t.api('POST', `/api/clients/${oleg.id}/bonuses`, { amount: 1000, note: 'Перенос' });
    await sell(oleg.id, [lobeLine], { cash: 1200, bonus: 400 });
    const gift = await sell(oleg.id, [{ type: 'certificate', price: 5000, recipientName: 'Маше' }], { transfer: 5000 });
    const code = (gift.items[0].name as string).replace('Подарочный сертификат ', '');
    await sell(anna.id, [lobeLine], { card: 600, certificates: [{ code, amount: 1000 }] });
    expect((await t.api('POST', `/api/sales/${yesterday.id}/refund`, { reason: 'Отказ', restock: false })).statusCode).toBe(200);

    const text = eveningDigest(t.ctx.db, EVENING, admin());
    // Sales 1 200 + 0 + 1 600 = 2 800 made, 1 600 refunded.
    expect(text).toContain(
      '💰 **Выручка — 1 200 ₽**\n' +
        '• 3 чека · средний 933 ₽\n' +
        '• Наличные 1 200 ₽ · перевод 5 000 ₽ · карта 600 ₽ · бонусами 400 ₽ · сертификатом 1 000 ₽\n' +
        '• 🎁 Продано сертификатов: 1 на 5 000 ₽\n' +
        '• ↩️ Возвраты: 1 600 ₽',
    );
    const analytics = (
      await t.api('GET', `/api/reports/analytics?from=${msk('2026-10-19T00:00:00')}&to=${msk('2026-10-20T00:00:00')}`)
    ).json();
    expect(analytics.revenue).toMatchObject({ net: 1200, salesCount: 3, averageCheck: 933, refunds: 1600 });
  });

  it('the evening digest names refunds even on a day without sales, and leaves out bonuses and certificates when none', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(EVENING - 26 * HOUR);
    await openShift(t);
    const res = await t.api('POST', '/api/sales', {
      clientId: anna.id, items: [{ type: 'service', serviceId: lobe.id, quantity: 1 }], discount: 0, payments: { transfer: 1600 },
    });
    vi.setSystemTime(EVENING - HOUR);
    const refund = await t.api('POST', `/api/sales/${res.json().id}/refund`, { reason: 'Отказ', restock: false });
    expect(refund.statusCode).toBe(200);
    const text = eveningDigest(t.ctx.db, EVENING, admin());
    expect(text).toContain('💰 Продаж сегодня не было\n• ↩️ Возвраты: 1 600 ₽');
    expect(text).not.toContain('бонусами');
    expect(text).not.toContain('сертификат');
  });

  it('a shift left open from an earlier day is flagged in the morning', async () => {
    await t.api('POST', '/api/cash/shift/open', { openingCash: 0 });
    t.ctx.db.update(cashShifts).set({ openedAt: MORNING - 20 * HOUR }).run();
    expect(morningDigest(t.ctx.db, MORNING, admin())).toContain('• 🏦 Кассовая смена с 18.10 не закрыта');
  });

  it('a digest is due once a day from its time for three hours', () => {
    const tz = 'Europe/Moscow';
    expect(dueDigest('morning', '09:30', MORNING - 20 * 60_000, tz, {})).toBeNull();
    expect(dueDigest('morning', '09:30', MORNING, tz, {})).toBe('2026-10-19');
    expect(dueDigest('morning', '09:30', MORNING, tz, { morning: '2026-10-19' })).toBeNull();
    expect(dueDigest('morning', '09:30', MORNING, tz, { morning: '2026-10-18' })).toBe('2026-10-19');
    expect(dueDigest('morning', '09:30', MORNING + 3 * HOUR, tz, {})).toBeNull();
    expect(dueDigest('morning', null, MORNING, tz, {})).toBeNull();
  });

  it('sends due digests to staff chats only, once, and keeps them in the chat', async () => {
    await t.api('PUT', '/api/settings/bot', { morningDigestAt: '09:30', eveningDigestAt: null });
    expect((await t.api('GET', '/api/settings/bot')).json()).toMatchObject({ morningDigestAt: '09:30', eveningDigestAt: null });

    expect(await sendDueDigests(t.ctx, MORNING)).toBe(1);
    expect(t.gateway.sent.map((m) => m.chatId)).toEqual([STAFF_CHAT]);
    expect(t.gateway.sent[0]!.text).toMatch(/^☀️ \*\*Доброе утро, Админ!\*\*/);
    expect(await sendDueDigests(t.ctx, MORNING + 60_000)).toBe(0);
    expect(await sendDueDigests(t.ctx, EVENING)).toBe(0);
    const stored = (await t.api('GET', `/api/bot/chats/${STAFF_CHAT}/messages`)).json().items;
    expect(stored.at(-1)).toMatchObject({ role: 'assistant', text: expect.stringMatching(/^☀️/) });

    t.gateway.running = false;
    await t.api('PUT', '/api/settings/bot', { eveningDigestAt: '21:30' });
    expect(await sendDueDigests(t.ctx, EVENING)).toBe(0);
    t.gateway.running = true;
    expect(await sendDueDigests(t.ctx, EVENING)).toBe(1);
  });

  it('older builds that do not send the digest times keep them', async () => {
    await t.api('PUT', '/api/settings/bot', { morningDigestAt: '8:15' });
    await t.api('PUT', '/api/settings/bot', { greeting: 'Привет!' });
    expect((await t.api('GET', '/api/settings/bot')).json()).toMatchObject({ morningDigestAt: '08:15', eveningDigestAt: '21:30' });
    expect((await t.api('PUT', '/api/settings/bot', { morningDigestAt: '25:00' })).statusCode).toBe(400);
  });
});
