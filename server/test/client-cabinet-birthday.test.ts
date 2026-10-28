import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { issueCabinetToken } from '../src/domain/cabinet-access.js';
import { createTestApp, type TestApp } from './helpers.js';
import { cab, cabinetWorld, miniApp, SIGN_IN, type CabinetWorld } from './cabinet-fixtures.js';
import { BOT_TOKEN, NOW, PUBLIC_URL } from './online-booking-fixtures.js';

describe('client cabinet: the birthday', () => {
  let t: TestApp;
  let w: CabinetWorld;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    t = await createTestApp({ env: { PUBLIC_URL, TELEGRAM_BOT_TOKEN: BOT_TOKEN } });
    w = await cabinetWorld(t);
  });
  afterEach(async () => {
    vi.useRealTimers();
    await t.close();
  });

  const cabinet = async () => (await cab(t, 'GET', '', undefined, miniApp())).json();
  const card = async () => (await t.api('GET', `/api/clients/${w.anna.id}`)).json();

  it('the cabinet says the birthday is empty; the client adds it once', async () => {
    expect((await cabinet()).client).toEqual({ name: 'Анна', phone: '+7 *** ***-**-01', birthday: null });
    const res = await cab(t, 'POST', '/birthday', { birthday: '1995-04-12' }, miniApp());
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ birthday: '1995-04-12' });
    expect((await card()).birthday).toBe('1995-04-12');
    expect((await cabinet()).client.birthday).toBe('1995-04-12');
    const log = (await t.api('GET', `/api/audit?entity=client&entityId=${w.anna.id}`)).json().items;
    expect(log[0]).toMatchObject({
      source: 'online',
      action: 'client.birthday',
      summary: 'Клиент «Анна Иванова» указал(а) дату рождения в личном кабинете: 12 апреля 1995',
    });

    // Only while it is empty.
    const again = await cab(t, 'POST', '/birthday', { birthday: '1990-01-01' }, miniApp());
    expect(again.statusCode).toBe(409);
    expect(again.json().error.message).toBe('Дата рождения уже указана — изменить её можно через студию');
    expect((await card()).birthday).toBe('1995-04-12');
  });

  it('takes a date without the year (1900) from the website sign-in link too', async () => {
    const { token } = issueCabinetToken(t.ctx.db, w.anna.id);
    const res = await cab(t, 'POST', '/birthday', { birthday: '1900-02-29' }, { token });
    expect(res.statusCode, res.body).toBe(200);
    expect((await card()).birthday).toBe('1900-02-29');
  });

  it('a birthday staff typed counts as filled', async () => {
    await t.api('PATCH', `/api/clients/${w.anna.id}`, { birthday: '1900-04-12' });
    expect((await cabinet()).client.birthday).toBe('1900-04-12');
    expect((await cab(t, 'POST', '/birthday', { birthday: '1995-04-12' }, miniApp())).statusCode).toBe(409);
  });

  it('refuses what is not a real past birthday, and anyone not signed in', async () => {
    for (const birthday of [null, '', '2030-01-01', '1995-02-29', '12.04.1995', '1890-01-01']) {
      const res = await cab(t, 'POST', '/birthday', { birthday }, miniApp());
      expect(res.statusCode, String(birthday)).toBe(400);
      expect(res.json().error.message).toMatch(/Дата рождения/);
    }
    const anonymous = await cab(t, 'POST', '/birthday', { birthday: '1995-04-12' });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toEqual(SIGN_IN);
    expect((await card()).birthday).toBeNull();
  });
});
