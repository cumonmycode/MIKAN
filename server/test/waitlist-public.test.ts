import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleStart, SHARE_PHONE_HINT } from '../src/bot/onboarding.js';
import { clients, waitlistEntries } from '../src/db/schema.js';
import { JOINS_PER_HOUR } from '../src/routes/public-waitlist.js';
import type { TestApp } from './helpers.js';
import { BOT_TOKEN, initData, linkChat, NOW, pub, PUBLIC_URL, STAFF_CHAT, type Json } from './online-booking-fixtures.js';
import { addEntry, ANNA_CHAT, waitlistWorld } from './waitlist-fixtures.js';

const USER = 880_777;

describe('waitlist: joining from the booking page and the Mini App', () => {
  let t: TestApp;
  let lobe: Json;
  let fatima: Json;
  let anna: Json;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    ({ t, lobe, fatima, anna } = await waitlistWorld({ PUBLIC_URL, TELEGRAM_BOT_TOKEN: BOT_TOKEN }));
  });
  afterEach(async () => {
    vi.useRealTimers();
    await t.close();
  });

  const join = (body: Record<string, unknown>, opts: { ip?: string; initData?: string } = {}) =>
    pub(t, 'POST', '/waitlist', { items: [{ serviceId: lobe.id }], dateFrom: '2026-10-21', dateTo: '2026-10-25', ...body }, opts);
  const rows = () => t.ctx.db.select().from(waitlistEntries).all();

  it('puts a website client on the waitlist by phone and tells the staff chat', async () => {
    const res = await join({ name: 'Ольга', phone: '8 (999) 000-00-07', masterId: fatima.id, note: 'после 18:00' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({
      id: body.id,
      items: [{ serviceId: lobe.id, variant: null, name: 'Мочка' }],
      master: { id: fatima.id, name: 'Фатима', color: fatima.color },
      dateFrom: '2026-10-21',
      dateTo: '2026-10-25',
      status: 'waiting',
      channel: 'web',
      notifiedAt: null,
      appointmentId: null,
      note: 'после 18:00',
      createdAt: new Date(NOW).toISOString(),
      telegramLink: `https://t.me/mikan_test_bot?start=w_${body.id}`,
    });
    const olga = t.ctx.db.select().from(clients).all().find((c) => c.phone === '+79990000007')!;
    expect(olga).toMatchObject({ name: 'Ольга', source: 'онлайн-запись' });
    expect(rows()[0]).toMatchObject({ clientId: olga.id, channel: 'web' });
    expect(t.gateway.textsTo(STAFF_CHAT)).toEqual([
      '⏳ Ольга встал(а) в лист ожидания (сайт): Мочка, 21–25 октября, мастер Фатима\nКомментарий: после 18:00',
    ]);
    const log = (await t.api('GET', `/api/audit?entity=waitlist&entityId=${body.id}`)).json().items as Json[];
    expect(log[0]).toMatchObject({
      source: 'online',
      employee: null,
      action: 'waitlist.create',
      summary: `Лист ожидания №${body.id} (Ольга): заявка клиента (сайт) — Мочка, 21–25 октября, мастер Фатима`,
    });
    expect((await t.api('GET', '/api/badges')).json().waitlist).toBe(1);
  });

  it('uses the card with that phone; a repeat returns the same entry without a second note', async () => {
    const first = (await join({ name: 'Кто-то', phone: '+79991234567' })).json();
    const again = (await join({ name: 'Кто-то', phone: '+79991234567' })).json();
    expect(again.id).toBe(first.id);
    expect(rows()).toEqual([expect.objectContaining({ clientId: anna.id })]);
    expect(t.gateway.textsTo(STAFF_CHAT)).toEqual(['⏳ Анна Иванова встал(а) в лист ожидания (сайт): Мочка, 21–25 октября']);
  });

  it('a linked Mini App chat joins without name and phone; an unlinked one is asked to share its phone', async () => {
    await linkChat(t, anna.id, ANNA_CHAT);
    t.gateway.sent = [];
    const linked = await join({}, { initData: initData({ id: ANNA_CHAT }) });
    expect(linked.json()).toMatchObject({ channel: 'miniapp', status: 'waiting' });
    expect(rows()[0]).toMatchObject({ clientId: anna.id, channel: 'miniapp' });
    expect(t.gateway.textsTo(ANNA_CHAT)).toEqual([]);

    const missing = await join({}, { initData: initData({ id: USER }) });
    expect(missing.json().error.message).toBe('«Имя»: обязательное поле');
    const unlinked = await join({ name: 'Ира', phone: '+79990000008' }, { initData: initData({ id: USER }) });
    expect(unlinked.json().channel).toBe('miniapp');
    expect(t.ctx.db.select().from(clients).all().find((c) => c.phone === '+79990000008')).toMatchObject({ source: 'telegram', telegramChatId: null });
    expect(t.gateway.sent.filter((s) => s.chatId === USER)).toEqual([
      {
        chatId: USER,
        messageId: expect.any(Number),
        text: 'Чтобы сообщение о свободном времени пришло сюда, нажмите «📱 Поделиться номером» внизу 👇 Это нужно сделать один раз.',
        replyKeyboard: [[{ text: '📱 Поделиться номером', requestContact: true }]],
      },
    ]);
    expect((await join({}, { initData: 'user=forged&hash=00' })).statusCode).toBe(401);
  });

  it('keeps clients within the online booking horizon and their own limit', async () => {
    const far = await join({ name: 'Ольга', phone: '+79990000007', dateFrom: '2026-12-10', dateTo: '2026-12-20' });
    expect(far.json().error.message).toBe('Онлайн-запись открыта на 60 дней вперёд — выберите даты пораньше');
    // Staff may.
    expect((await addEntry(t, { clientId: anna.id, items: [{ serviceId: lobe.id }], dateFrom: '2026-12-10', dateTo: '2026-12-20' })).statusCode).toBe(200);
    await join({ name: 'Анна', phone: '+79991234567', dateTo: '2026-10-22' });
    await join({ name: 'Анна', phone: '+79991234567', dateTo: '2026-10-23' });
    const fourth = await join({ name: 'Анна', phone: '+79991234567', dateTo: '2026-10-24' });
    expect(fourth.statusCode).toBe(409);
    expect(fourth.json().error.message).toBe('У вас уже 3 заявки в листе ожидания — дождитесь сообщения или отмените одну из них');
  });

  it('answers a filled honeypot as if joined, stores nothing and counts it', async () => {
    const decoy = await join({ name: 'Bot', phone: '+79990000099', website: 'http://spam' }, { ip: '10.0.0.9' });
    expect(decoy.statusCode).toBe(200);
    expect(decoy.json()).toMatchObject({ id: 1, status: 'waiting', channel: 'web', telegramLink: 'https://t.me/mikan_test_bot?start=w_1' });
    expect(rows()).toEqual([]);
    expect(t.ctx.db.select().from(clients).all().some((c) => c.phone === '+79990000099')).toBe(false);
    expect(t.gateway.textsTo(STAFF_CHAT)).toEqual([]);
    // Validation still applies to the decoy.
    expect((await join({ name: 'Bot', phone: '+79990000099', website: 'x', dateTo: '2026-12-31' }, { ip: '10.0.0.9' })).statusCode).toBe(400);
  });

  it(`allows ${JOINS_PER_HOUR} joins an hour per IP; refused input does not count`, async () => {
    for (let i = 0; i < 3; i += 1) expect((await join({ name: 'Ольга', phone: '+79990000007', dateTo: '2026-11-30' }, { ip: '10.0.0.1' })).statusCode).toBe(400);
    for (let i = 0; i < JOINS_PER_HOUR; i += 1) {
      const res = await join({ name: `Гость ${i}`, phone: `+7999000003${i}` }, { ip: '10.0.0.1' });
      expect(res.statusCode).toBe(200);
    }
    const sixth = await join({ name: 'Гость', phone: '+79990000040' }, { ip: '10.0.0.1' });
    expect(sixth.statusCode).toBe(429);
    expect(sixth.json().error.message).toBe('Слишком много заявок с этого устройства — попробуйте позже или позвоните в студию');
    expect((await join({ name: 'Гость', phone: '+79990000040' }, { ip: '10.0.0.2' })).statusCode).toBe(200);
  });

  it('is closed while online booking is off', async () => {
    await t.api('PUT', '/api/settings/studio', { onlineBooking: { enabled: false } });
    const res = await join({ name: 'Ольга', phone: '+79990000007' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toBe('Онлайн-запись временно недоступна');
  });
});

describe('waitlist: the bot deep link /start w_<id>', () => {
  let t: TestApp;
  let lobe: Json;
  let anna: Json;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    ({ t, lobe, anna } = await waitlistWorld());
  });
  afterEach(async () => {
    vi.useRealTimers();
    await t.close();
  });

  const start = (chatId: number, payload: string) => handleStart(t.ctx, { chatId, telegramName: 'Анна', username: null }, payload).text;

  it('shows the entry only to a chat linked to its client', async () => {
    const entry = (await addEntry(t, { clientId: anna.id, items: [{ serviceId: lobe.id }], dateFrom: '2026-10-21', dateTo: '2026-10-25' })).json();
    expect(start(ANNA_CHAT, `w_${entry.id}`)).toBe(
      `Чтобы получить сообщение о свободном времени, поделитесь номером — так я найду вашу заявку.\n\n${SHARE_PHONE_HINT}`,
    );
    await linkChat(t, anna.id, ANNA_CHAT);
    expect(start(ANNA_CHAT, `w_${entry.id}`)).toBe(
      'Анна, вы в листе ожидания ✅ Мочка, 21–25 октября. Напишу сюда, как только освободится время.',
    );
    expect(start(ANNA_CHAT, 'w_9999')).toBe(
      'Не нашёл эту заявку листа ожидания среди ваших — возможно, она оформлена на другой номер телефона.',
    );
    await t.api('PATCH', `/api/waitlist/${entry.id}`, { status: 'cancelled' });
    expect(start(ANNA_CHAT, `w_${entry.id}`)).toBe('Анна, эта заявка листа ожидания уже закрыта.');
  });
});
