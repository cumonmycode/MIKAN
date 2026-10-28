import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApnsRequest, ApnsResponse, ApnsTransport } from '../src/push/apns.js';
import { pushesSettled } from '../src/push/staff-push.js';
import { createTestApp, FakeQrProvider, make, type TestApp } from './helpers.js';
import { addMaster, bindStaffChat, FRIDAY_NOON, loginAs, NOW, pub, type Json } from './online-booking-fixtures.js';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const APNS_ENV = {
  APNS_KEY_ID: 'ABC123DEFG',
  APNS_TEAM_ID: 'G99YH9UK8C',
  APNS_PRIVATE_KEY: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' }) as string).toString('base64'),
  APNS_BUNDLE_ID: 'com.mikanstudio.crm',
};
const deviceToken = (n: number) => n.toString(16).padStart(2, '0').repeat(32);

class RecordingApns implements ApnsTransport {
  requests: ApnsRequest[] = [];
  async send(request: ApnsRequest): Promise<ApnsResponse> {
    this.requests.push(request);
    return { status: 200, reason: null };
  }
  /** `[type, device token]` of every push, in order. */
  sent(): Array<[string, string]> {
    return this.requests.map((r) => [(JSON.parse(r.body) as Json).type as string, r.deviceToken]);
  }
}

describe('online booking: staff pushes', () => {
  let t: TestApp;
  let apns: RecordingApns;
  let bank: FakeQrProvider;
  let lobe: Json;
  let tattoo: Json;
  let fatima: Json;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    apns = new RecordingApns();
    bank = new FakeQrProvider();
    t = await createTestApp({ env: APNS_ENV, apns, qr: bank });
    bindStaffChat(t);
    lobe = await make(t, '/api/services', { name: 'Мочка', category: 'piercing', price: 1600, durationMin: 30 });
    tattoo = await make(t, '/api/services', { name: 'Тату мини', category: 'tattoo', price: 5000, durationMin: 60, depositAmount: 1000 });
    fatima = await addMaster(t, 'Фатима', 'fatima');
    await addMaster(t, 'Борис', 'boris');
    await t.api('POST', '/api/devices', { token: deviceToken(1), environment: 'production' }); // the owner
    await (await loginAs(t, 'fatima'))('POST', '/api/devices', { token: deviceToken(2), environment: 'production' });
    await (await loginAs(t, 'boris'))('POST', '/api/devices', { token: deviceToken(3), environment: 'production' });
  });
  afterEach(async () => {
    vi.useRealTimers();
    await t.close();
  });

  const book = async (serviceId: number) =>
    (await pub(t, 'POST', '', { items: [{ serviceId }], masterId: fatima.id, startsAt: FRIDAY_NOON, name: 'Анна', phone: '+79991234567' })).json();

  it('a new online booking pushes online_booking to the owner and the booked master', async () => {
    await book(lobe.id);
    await pushesSettled(t.ctx);
    expect(apns.sent().sort()).toEqual([
      ['online_booking', deviceToken(1)],
      ['online_booking', deviceToken(2)],
    ]);
    expect(JSON.parse(apns.requests[0]!.body)).toMatchObject({
      aps: { alert: { title: 'Новая онлайн-запись', body: 'Анна · Мочка · 16 окт, 12:00 · ждёт подтверждения' } },
      type: 'online_booking',
    });
  });

  it('a client cancelling on the booking page pushes client_cancelled', async () => {
    const booking = await book(lobe.id);
    await pushesSettled(t.ctx);
    apns.requests = [];
    await pub(t, 'POST', `/b/${booking.token}/cancel`);
    await pushesSettled(t.ctx);
    expect(apns.sent().sort()).toEqual([
      ['client_cancelled', deviceToken(1)],
      ['client_cancelled', deviceToken(2)],
    ]);
  });

  it('a paid hold pushes deposit_paid once', async () => {
    const booking = await book(tattoo.id);
    await pushesSettled(t.ctx);
    expect(apns.sent().map(([type]) => type)).toEqual(['online_booking', 'online_booking']);
    apns.requests = [];
    bank.statuses.set('QR1', 'paid');
    expect((await pub(t, 'GET', `/b/${booking.token}`)).json().status).toBe('confirmed');
    await pushesSettled(t.ctx);
    expect(apns.sent().sort()).toEqual([
      ['deposit_paid', deviceToken(1)],
      ['deposit_paid', deviceToken(2)],
    ]);
  });
});
