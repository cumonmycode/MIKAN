import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, make, type TestApp } from './helpers.js';
import { addMaster, BOT_TOKEN, FRIDAY_NOON, initData, linkChat, NOW, pub, PUBLIC_URL, type Json } from './online-booking-fixtures.js';

const USER = 880_101;

describe('the birthday in online booking', () => {
  let t: TestApp;
  let lobe: Json;
  let fatima: Json;
  let ip = 0;

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

  /** Each booking from its own IP, so the hourly limit never interferes. */
  const book = (body: Json, startsAt = FRIDAY_NOON, opts: { initData?: string } = {}) =>
    pub(t, 'POST', '', { items: [{ serviceId: lobe.id }], masterId: fatima.id, startsAt, ...body }, { ip: `10.0.0.${++ip}`, ...opts });
  const clientOf = async (booking: Json) => {
    const appointment = (await t.api('GET', `/api/appointments/${booking.number}`)).json();
    return (await t.api('GET', `/api/clients/${appointment.client.id}`)).json();
  };

  it('a new client gets the birthday from the page, with or without the year', async () => {
    const full = await book({ name: 'Анна', phone: '+79991230001', birthday: '1995-04-12' });
    expect(full.statusCode, full.body).toBe(200);
    expect(await clientOf(full.json())).toMatchObject({ name: 'Анна', birthday: '1995-04-12' });

    const yearless = await book({ name: 'Вера', phone: '+79991230002', birthday: '1900-02-29' }, '2026-10-16T10:00:00.000Z');
    expect(yearless.statusCode, yearless.body).toBe(200);
    expect((await clientOf(yearless.json())).birthday).toBe('1900-02-29');

    const none = await book({ name: 'Олег', phone: '+79991230003', birthday: null }, '2026-10-16T11:00:00.000Z');
    expect((await clientOf(none.json())).birthday).toBeNull();
  });

  it('fills an existing card only when it has none', async () => {
    const empty = await make(t, '/api/clients', { name: 'Ирина', phone: '+79991230011' });
    const filled = await book({ name: 'Ира', phone: '+79991230011', birthday: '1990-01-02' });
    expect((await clientOf(filled.json())).birthday).toBe('1990-01-02');
    const log = (await t.api('GET', `/api/audit?entity=client&entityId=${empty.id}`)).json().items;
    expect(log[0]).toMatchObject({
      source: 'online', action: 'client.birthday', summary: 'Клиент «Ирина» указал(а) дату рождения при онлайн-записи: 2 января 1990',
    });

    await make(t, '/api/clients', { name: 'Зоя', phone: '+79991230012', birthday: '1985-05-05' });
    const kept = await book({ name: 'Зоя', phone: '+79991230012', birthday: '1990-01-02' }, '2026-10-16T10:00:00.000Z');
    expect((await clientOf(kept.json())).birthday).toBe('1985-05-05');
  });

  it('refuses a date that is not a real past birthday, booking nothing', async () => {
    for (const birthday of ['2030-01-01', '1995-02-29', '12.04.1995', '1850-01-01']) {
      const res = await book({ name: 'Анна', phone: '+79991230021', birthday });
      expect(res.statusCode, birthday).toBe(400);
      expect(res.json().error.message).toMatch(/Дата рождения/);
    }
    expect((await t.api('GET', '/api/clients?search=79991230021')).json().items).toHaveLength(0);
  });

  it('a linked Mini App chat learns whether its card has a birthday and can give it', async () => {
    const anna = await make(t, '/api/clients', { name: 'Анна', phone: '+79991230031' });
    await linkChat(t, anna.id, USER);
    const me = initData({ id: USER });
    expect((await pub(t, 'GET', '/me', undefined, { initData: me })).json()).toEqual({
      linked: true, name: 'Анна', phone: '+7 *** ***-**-31', hasBirthday: false,
    });
    const res = await book({ birthday: '1900-04-12' }, FRIDAY_NOON, { initData: me });
    expect(res.statusCode, res.body).toBe(200);
    expect((await t.api('GET', `/api/clients/${anna.id}`)).json().birthday).toBe('1900-04-12');
    expect((await pub(t, 'GET', '/me', undefined, { initData: me })).json().hasBirthday).toBe(true);
  });

  it('a honeypot hit stores no birthday', async () => {
    const res = await book({ name: 'Бот', phone: '+79991230041', birthday: '1995-04-12', website: 'spam' });
    expect(res.statusCode).toBe(200);
    expect((await t.api('GET', '/api/clients?search=79991230041')).json().items).toHaveLength(0);
  });
});
