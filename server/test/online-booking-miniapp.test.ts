import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleContact } from '../src/bot/onboarding.js';
import { initDataHash, validateInitData } from '../src/lib/telegram-webapp.js';
import { createTestApp, make, type TestApp } from './helpers.js';
import {
  addMaster,
  BOT_TOKEN,
  FRIDAY_NOON,
  initData,
  linkChat,
  NOW,
  pub,
  PUBLIC_URL,
  type Json,
} from './online-booking-fixtures.js';

const USER = 880_001;

describe('Telegram Mini App init data', () => {
  it('accepts data signed with the bot token while fresh, nothing else', () => {
    const valid = initData({ id: USER, username: 'anna', first_name: 'Анна' });
    expect(validateInitData(valid, BOT_TOKEN, NOW)).toEqual({ id: USER, firstName: 'Анна', lastName: null, username: 'anna' });
    expect(validateInitData(valid, BOT_TOKEN, NOW + 23 * 3_600_000)).not.toBeNull();
    expect(validateInitData(valid, BOT_TOKEN, NOW + 24 * 3_600_000 + 1000)).toBeNull(); // older than 24 h
    expect(validateInitData(initData({ id: USER }, NOW + 10 * 60_000), BOT_TOKEN, NOW)).toBeNull(); // from the future
    expect(validateInitData(valid, '999:other-token', NOW)).toBeNull();
    expect(validateInitData(valid, null, NOW)).toBeNull();
    // Any edited field breaks the hash.
    const forged = new URLSearchParams(valid);
    forged.set('user', JSON.stringify({ id: 1, first_name: 'Админ' }));
    expect(validateInitData(forged.toString(), BOT_TOKEN, NOW)).toBeNull();
    const noHash = new URLSearchParams(valid);
    noHash.delete('hash');
    expect(validateInitData(noHash.toString(), BOT_TOKEN, NOW)).toBeNull();
    expect(validateInitData('', BOT_TOKEN, NOW)).toBeNull();
    expect(validateInitData(undefined, BOT_TOKEN, NOW)).toBeNull();
    // Signed but without a user: nothing to book for.
    const anonymous = new URLSearchParams({ auth_date: String(NOW / 1000) });
    anonymous.set('hash', initDataHash(anonymous, BOT_TOKEN));
    expect(validateInitData(anonymous.toString(), BOT_TOKEN, NOW)).toBeNull();
  });

  it('builds the data-check-string from every field but the hash, sorted by key (Telegram\'s example)', () => {
    const params = new URLSearchParams('query_id=Q&user=%7B%22id%22%3A1%7D&auth_date=1700000000&signature=abc&hash=00');
    params.set('hash', initDataHash(params, BOT_TOKEN));
    expect(validateInitData(params.toString(), BOT_TOKEN, 1_700_000_000_000)).toMatchObject({ id: 1 });
  });
});

describe('online booking in the Mini App', () => {
  let t: TestApp;
  let lobe: Json;
  let fatima: Json;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    t = await createTestApp({ env: { PUBLIC_URL, TELEGRAM_BOT_TOKEN: BOT_TOKEN } });
    lobe = await make(t, '/api/services', { name: 'Мочка', category: 'piercing', price: 1600, durationMin: 30 });
    fatima = await addMaster(t, 'Фатима', 'fatima');
  });
  afterEach(async () => {
    vi.useRealTimers();
    await t.close();
  });

  const book = (body: Json, init = initData({ id: USER, username: 'anna' })) =>
    pub(t, 'POST', '', { items: [{ serviceId: lobe.id }], masterId: fatima.id, startsAt: FRIDAY_NOON, ...body }, { initData: init });

  it('/me tells whether the Telegram user is a known client, with a masked phone', async () => {
    expect((await pub(t, 'GET', '/me')).statusCode).toBe(401);
    expect((await pub(t, 'GET', '/me', undefined, { initData: 'user=1&hash=00' })).statusCode).toBe(401);
    const me = initData({ id: USER });
    expect((await pub(t, 'GET', '/me', undefined, { initData: me })).json()).toEqual({ linked: false, name: null, phone: null, hasBirthday: false });
    const anna = await make(t, '/api/clients', { name: 'Анна', phone: '+79991234567' });
    await linkChat(t, anna.id, USER);
    expect((await pub(t, 'GET', '/me', undefined, { initData: me })).json()).toEqual({ linked: true, name: 'Анна', phone: '+7 *** ***-**-67', hasBirthday: false });
  });

  it('books a new client by name and phone, confirms in the chat and asks for the own contact to link it', async () => {
    const res = await book({ name: 'Анна', phone: '+79991234567' });
    expect(res.statusCode).toBe(200);
    const booking = res.json();
    const appointment = (await t.api('GET', `/api/appointments/${booking.number}`)).json();
    // A typed phone proves nothing: the chat is not linked to the card by it.
    expect(appointment).toMatchObject({ channel: 'miniapp', onlineState: 'awaiting_confirmation', client: { name: 'Анна', telegramLinked: false } });
    expect((await t.api('GET', `/api/clients/${appointment.client.id}`)).json()).toMatchObject({ source: 'telegram' });
    const toChat = t.gateway.sent.filter((m) => m.chatId === USER);
    expect(toChat.map((m) => m.text)).toEqual([
      'Заявка принята, время за вами 🙌 Подтвердим в ближайшее время.\n\n**16 октября, 12:00** — Мочка\nМастер: Фатима',
      'Чтобы уведомления о записи приходили сюда, нажмите «📱 Поделиться номером» внизу 👇 Это нужно сделать один раз.',
    ]);
    expect(toChat[1]!.replyKeyboard).toEqual([[{ text: '📱 Поделиться номером', requestContact: true }]]);
    expect((await pub(t, 'GET', '/me', undefined, { initData: initData({ id: USER }) })).json().linked).toBe(false);
    // The shared contact links the chat to the card with that phone.
    await handleContact(t.ctx, { chatId: USER, telegramName: 'Анна', username: 'anna', userId: USER }, { userId: USER, phone: '+79991234567', firstName: 'Анна', lastName: undefined });
    expect((await pub(t, 'GET', '/me', undefined, { initData: initData({ id: USER }) })).json()).toEqual({ linked: true, name: 'Анна', phone: '+7 *** ***-**-67', hasBirthday: false });
  });

  it('a linked chat books without name and phone', async () => {
    const anna = await make(t, '/api/clients', { name: 'Анна', phone: '+79991234567' });
    await linkChat(t, anna.id, USER);
    const res = await book({});
    expect(res.statusCode).toBe(200);
    expect((await t.api('GET', `/api/appointments/${res.json().number}`)).json().client.id).toBe(anna.id);
  });

  it('never links the chat to an existing card by a typed phone, but still answers in the chat', async () => {
    const regular = await make(t, '/api/clients', { name: 'Ольга', phone: '+79995550000' });
    await make(t, '/api/appointments', { clientId: regular.id, masterId: 1, title: 'Хеликс', startsAt: '2026-10-01T09:00:00.000Z', endsAt: '2026-10-01T10:00:00.000Z' });
    const res = await book({ name: 'Ольга', phone: '+79995550000' });
    expect(res.statusCode).toBe(200);
    expect((await t.api('GET', `/api/clients/${regular.id}`)).json().telegramLinked).toBe(false);
    expect(t.gateway.textsTo(USER)).toHaveLength(2);
  });

  it('refuses forged init data and writes nothing', async () => {
    const res = await book({ name: 'Анна', phone: '+79991234567' }, initData({ id: USER }, NOW, '1:wrong'));
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthorized');
    expect((await t.api('GET', '/api/clients')).json().items).toEqual([]);
  });

  it('the web page needs name and phone', async () => {
    const res = await pub(t, 'POST', '', { items: [{ serviceId: lobe.id }], startsAt: FRIDAY_NOON, name: 'Анна' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe('«Телефон»: обязательное поле');
  });
});
