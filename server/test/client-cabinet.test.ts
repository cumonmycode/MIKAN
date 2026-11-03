import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bonusOperations, clientAccessTokens, giftCertificates, waitlistEntries } from '../src/db/schema.js';
import { CABINET_TOKEN_DAYS, hashCabinetToken, issueCabinetToken, MAX_LIVE_TOKENS } from '../src/domain/cabinet-access.js';
import { linkTelegram } from '../src/domain/clients.js';
import { createTestApp, make, type TestApp } from './helpers.js';
import { appointment, cab, cabinetWorld, DAY, miniApp, SIGN_IN, type CabinetWorld } from './cabinet-fixtures.js';
import { BOT_TOKEN, FRIDAY_NOON, initData, NOW, pub, PUBLIC_URL, type Json } from './online-booking-fixtures.js';

const SATURDAY_NOON = '2026-10-17T09:00:00.000Z';

describe('client cabinet: who is signed in', () => {
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

  it('answers every endpoint with 401 «Войдите через Telegram-бота студии» without a valid identity', async () => {
    const unlinked = initData({ id: 990_001 });
    const forged = 'user=%7B%22id%22%3A770001%7D&auth_date=1&hash=' + '0'.repeat(64);
    const stale = initData({ id: 770_001 }, NOW - 2 * DAY);
    for (const who of [{}, { initData: forged }, { initData: unlinked }, { initData: stale }, { token: 'x'.repeat(43) }, { token: 'short' }, { token: '' }]) {
      const res = await cab(t, 'GET', '', undefined, who);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual(SIGN_IN);
    }
    const endpoints: Array<[string, string]> = [
      ['GET', '/bonuses'],
      ['GET', '/appointments/1/days'],
      ['GET', '/appointments/1/slots?date=2026-10-16'],
      ['POST', '/appointments/1/reschedule'],
      ['POST', '/appointments/1/cancel'],
      ['DELETE', '/waitlist/1'],
      ['POST', '/logout'],
    ];
    for (const [method, path] of endpoints) {
      const res = await cab(t, method as 'GET', path, method === 'GET' || method === 'DELETE' ? undefined : {});
      expect(res.statusCode, `${method} ${path}`).toBe(401);
      expect(res.json()).toEqual(SIGN_IN);
    }
  });

  it('knows the Mini App client by the chat linked to the card, with a masked phone', async () => {
    const res = await cab(t, 'GET', '', undefined, miniApp());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      client: { name: 'Анна', phone: '+7 *** ***-**-01', birthday: null },
      loyalty: { bonusBalance: 0, expiring: null },
      upcoming: [],
      past: [],
      waitlist: [],
      certificates: [],
      aftercare: [],
    });
  });

  it('knows the website client by a sign-in link: hashed, used, valid 30 days, ended by signing out', async () => {
    const { token, expiresAt } = issueCabinetToken(t.ctx.db, w.anna.id);
    expect(expiresAt).toBe(NOW + CABINET_TOKEN_DAYS * DAY);
    const stored = t.ctx.db.select().from(clientAccessTokens).all();
    expect(stored).toEqual([expect.objectContaining({ clientId: w.anna.id, tokenHash: hashCabinetToken(token), lastUsedAt: null })]);
    expect(JSON.stringify(stored)).not.toContain(token);

    vi.setSystemTime(NOW + 5 * DAY);
    expect((await cab(t, 'GET', '', undefined, { token })).json().client).toEqual({ name: 'Анна', phone: '+7 *** ***-**-01', birthday: null });
    expect(t.ctx.db.select().from(clientAccessTokens).get()!.lastUsedAt).toBe(NOW + 5 * DAY);

    // Signing out in the Mini App leaves the website link alone; on the website it ends it.
    expect((await cab(t, 'POST', '/logout', {}, miniApp())).statusCode).toBe(204);
    expect((await cab(t, 'GET', '', undefined, { token })).statusCode).toBe(200);
    expect((await cab(t, 'POST', '/logout', {}, { token })).statusCode).toBe(204);
    expect((await cab(t, 'GET', '', undefined, { token })).json()).toEqual(SIGN_IN);

    const second = issueCabinetToken(t.ctx.db, w.anna.id).token;
    vi.setSystemTime(NOW + 5 * DAY + CABINET_TOKEN_DAYS * DAY);
    expect((await cab(t, 'GET', '', undefined, { token: second })).statusCode).toBe(401);
    // Expired links are cleared when a new one is issued.
    issueCabinetToken(t.ctx.db, w.boris.id);
    expect(t.ctx.db.select().from(clientAccessTokens).all().map((r) => r.clientId)).toEqual([w.boris.id]);
  });

  it('a link stops working once the card loses its Telegram chat; a client keeps at most 5 live links', async () => {
    const { token } = issueCabinetToken(t.ctx.db, w.anna.id);
    expect((await cab(t, 'GET', '', undefined, { token })).statusCode).toBe(200);
    linkTelegram(t.ctx.db, w.boris.id, 770_001, null); // Anna's chat now belongs to Boris's card
    expect((await cab(t, 'GET', '', undefined, { token })).json()).toEqual(SIGN_IN);

    const tokens = Array.from({ length: 7 }, () => issueCabinetToken(t.ctx.db, w.boris.id).token);
    expect(t.ctx.db.select().from(clientAccessTokens).where(eq(clientAccessTokens.clientId, w.boris.id)).all()).toHaveLength(MAX_LIVE_TOKENS);
    expect((await cab(t, 'GET', '', undefined, { token: tokens[0] })).statusCode).toBe(401); // the oldest went first
    expect((await cab(t, 'GET', '', undefined, { token: tokens[6] })).json().client.name).toBe('Борис');
  });

  it('never falls back from invalid init data to a token', async () => {
    const { token } = issueCabinetToken(t.ctx.db, w.anna.id);
    expect((await cab(t, 'GET', '', undefined, { token, initData: initData({ id: 990_001 }) })).statusCode).toBe(401);
    // Valid init data wins over another client's token.
    const boris = issueCabinetToken(t.ctx.db, w.boris.id).token;
    expect((await cab(t, 'GET', '', undefined, { token: boris, ...miniApp() })).json().client.name).toBe('Анна');
  });
});

describe('client cabinet: what the client sees', () => {
  let t: TestApp;
  let w: CabinetWorld;
  const get = async (): Promise<Json> => (await cab(t, 'GET', '', undefined, miniApp())).json();

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

  it('lists upcoming appointments soonest first and the past ones newest first, never another client\'s', async () => {
    const lobe = await appointment(t, { clientId: w.anna.id, masterId: w.fatima.id, services: [{ serviceId: w.lobe.id }], startsAt: FRIDAY_NOON });
    const nipple = await appointment(t, { clientId: w.anna.id, masterId: w.fatima.id, services: [{ serviceId: w.nipple.id }], startsAt: SATURDAY_NOON });
    await t.api('POST', `/api/appointments/${nipple.id}/deposit`, { amount: 1000, method: 'card' });
    const done = await appointment(t, {
      clientId: w.anna.id, masterId: w.fatima.id, services: [{ serviceId: w.lobe.id }], startsAt: new Date(NOW - 7 * DAY).toISOString(), status: 'completed',
    });
    const cancelled = await appointment(t, { clientId: w.anna.id, masterId: w.fatima.id, title: 'Консультация', startsAt: new Date(NOW + 3 * DAY).toISOString(), endsAt: new Date(NOW + 3 * DAY + 30 * 60_000).toISOString() });
    await t.api('PATCH', `/api/appointments/${cancelled.id}`, { status: 'cancelled' });
    await appointment(t, { clientId: w.boris.id, masterId: w.fatima.id, services: [{ serviceId: w.lobe.id }], startsAt: '2026-10-16T12:00:00.000Z' });

    const cabinet = await get();
    expect(cabinet.upcoming.map((a: Json) => a.id)).toEqual([lobe.id, nipple.id]);
    expect(cabinet.past.map((a: Json) => a.id)).toEqual([cancelled.id, done.id]);
    expect(cabinet.upcoming[1]).toEqual({
      id: nipple.id,
      startsAt: SATURDAY_NOON,
      endsAt: '2026-10-17T10:00:00.000Z',
      status: 'scheduled',
      onlineState: null,
      items: [{ name: 'Соски', price: 2500 }],
      master: { name: 'Фатима' },
      price: 2500,
      deposit: 1000,
      depositRequired: 1000,
      freeCancellationUntil: FRIDAY_NOON, // 24 h before the start
      canReschedule: true,
      canCancel: true,
      bookingToken: null,
    });
    expect(cabinet.upcoming[0]).toMatchObject({ deposit: 0, depositRequired: 0, freeCancellationUntil: null, canCancel: true });
    expect(cabinet.past[0]).toMatchObject({ status: 'cancelled', items: [{ name: 'Консультация', price: 0 }], canReschedule: false, canCancel: false });
    expect(cabinet.past[1]).toMatchObject({ status: 'completed', canReschedule: false, canCancel: false, freeCancellationUntil: null });
    // Internal fields stay out.
    expect(JSON.stringify(cabinet)).not.toMatch(/notes|clientId|masterId|Борис/);

    // An appointment under way is still upcoming, but can no longer be changed.
    vi.setSystemTime(Date.parse(FRIDAY_NOON) + 10 * 60_000);
    const during = await get();
    expect(during.upcoming[0]).toMatchObject({ id: lobe.id, canReschedule: false, canCancel: false });
  });

  it('shows an online booking with its page token, and offers no changes while online booking is off', async () => {
    const booked = (await pub(t, 'POST', '', { items: [{ serviceId: w.lobe.id }], masterId: w.fatima.id, startsAt: FRIDAY_NOON }, { initData: initData({ id: 770_001 }) })).json();
    let [first] = (await get()).upcoming;
    expect(first).toMatchObject({ id: booked.number, onlineState: 'awaiting_confirmation', bookingToken: booked.token, canReschedule: true });
    await t.api('PUT', '/api/settings/studio', { onlineBooking: { enabled: false } });
    [first] = (await get()).upcoming;
    expect(first).toMatchObject({ canReschedule: false, canCancel: false });
  });

  it('offers no move with a master who no longer takes online bookings', async () => {
    const admin = await make(t, '/api/employees', { name: 'Админ 2', login: 'admin2', password: 'secret123', isMaster: false });
    await appointment(t, { clientId: w.anna.id, masterId: admin.id, services: [{ serviceId: w.lobe.id }], startsAt: FRIDAY_NOON });
    expect((await get()).upcoming[0]).toMatchObject({ canReschedule: false, canCancel: true });
  });

  it('shows the bonus balance with the nearest expiry, null while loyalty is off; the history newest first', async () => {
    const expires = new Date(NOW + 10 * DAY).toISOString();
    await t.api('POST', `/api/clients/${w.anna.id}/bonuses`, { amount: 500, note: 'Подарок', expiresAt: expires });
    vi.setSystemTime(NOW + 1000);
    await t.api('POST', `/api/clients/${w.anna.id}/bonuses`, { amount: 300, note: 'Компенсация' });
    await t.api('POST', `/api/clients/${w.boris.id}/bonuses`, { amount: 900, note: 'Чужие' });
    expect((await get()).loyalty).toEqual({ bonusBalance: 800, expiring: { amount: 500, at: expires } });

    const bonuses = (await cab(t, 'GET', '/bonuses', undefined, miniApp())).json();
    expect(bonuses).toEqual({
      balance: 800,
      items: [
        { type: 'adjust', amount: 300, expiresAt: null, createdAt: new Date(NOW + 1000).toISOString(), note: 'Компенсация' },
        { type: 'adjust', amount: 500, expiresAt: expires, createdAt: new Date(NOW).toISOString(), note: 'Подарок' },
      ],
    });

    t.ctx.db
      .insert(bonusOperations)
      .values(Array.from({ length: 55 }, (_, i) => ({ clientId: w.anna.id, type: 'expire', amount: -1, createdAt: NOW - (i + 1) * 1000 })))
      .run();
    expect((await cab(t, 'GET', '/bonuses', undefined, miniApp())).json().items).toHaveLength(50);

    await t.api('PUT', '/api/settings/retention', { loyalty: { enabled: false } });
    expect((await get()).loyalty).toBeNull();
  });

  it('lists the active certificates the client bought', async () => {
    const values = (code: string, extra: Partial<typeof giftCertificates.$inferInsert>) => ({
      code, amount: 5000, balance: 3000, status: 'active', expiresAt: NOW + 300 * DAY, buyerClientId: w.anna.id,
      createdAt: NOW, updatedAt: NOW, ...extra,
    });
    t.ctx.db.insert(giftCertificates).values([
      values('MIKAN-AAAA-AAAA', {}),
      values('MIKAN-BBBB-BBBB', { status: 'used', balance: 0 }),
      values('MIKAN-CCCC-CCCC', { buyerClientId: w.boris.id }),
      values('MIKAN-DDDD-DDDD', { expiresAt: NOW - 1 }),
      values('MIKAN-EEEE-EEEE', { expiresAt: null, createdAt: NOW + 1 }),
    ]).run();
    expect((await get()).certificates).toEqual([
      { code: 'MIKAN-EEEE-EEEE', balance: 3000, expiresAt: null },
      { code: 'MIKAN-AAAA-AAAA', balance: 3000, expiresAt: new Date(NOW + 300 * DAY).toISOString() },
    ]);
  });

  it('gives the aftercare memos of fresh procedures of the last 60 days by day', async () => {
    const template = await make(t, '/api/aftercare-templates', {
      name: 'Уход за проколом',
      category: 'piercing',
      steps: [{ dayOffset: 3, text: 'Промывайте дважды в день' }, { dayOffset: 0, text: 'Не трогайте прокол' }],
    });
    const helix = await make(t, '/api/services', {
      name: 'Хеликс', category: 'piercing', price: 3000, durationMin: 30, freshProcedure: true, aftercareTemplateId: template.id,
    });
    const change = await make(t, '/api/services', { name: 'Замена украшения', category: 'piercing', price: 500, durationMin: 15, freshProcedure: false });
    const at = (days: number) => new Date(NOW - days * DAY).toISOString();
    const visit = (serviceId: number, days: number, status = 'completed') =>
      appointment(t, { clientId: w.anna.id, masterId: w.fatima.id, services: [{ serviceId }], startsAt: at(days), status });
    const recent = await visit(helix.id, 10);
    await visit(helix.id, 61); // too old
    await visit(change.id, 5); // no fresh procedure
    await visit(helix.id, 3, 'cancelled');
    expect((await get()).aftercare).toEqual([
      {
        appointmentId: recent.id,
        date: '2026-10-05',
        title: 'Уход за проколом',
        steps: [{ day: 0, text: 'Не трогайте прокол' }, { day: 3, text: 'Промывайте дважды в день' }],
      },
    ]);
  });

  it('lists the waiting and notified waitlist entries; the client cancels their own', async () => {
    const add = (clientId: number, status: string, extra: Partial<typeof waitlistEntries.$inferInsert> = {}) =>
      t.ctx.db
        .insert(waitlistEntries)
        .values({
          clientId, items: JSON.stringify([{ serviceId: w.nipple.id, variant: 'Два' }, { serviceId: w.lobe.id }]), masterId: w.fatima.id,
          dateFrom: '2026-10-20', dateTo: '2026-10-25', status, channel: 'web', createdAt: NOW, updatedAt: NOW, ...extra,
        })
        .returning()
        .get();
    const waiting = add(w.anna.id, 'waiting', { note: 'После обеда' });
    const notified = add(w.anna.id, 'notified', { masterId: null, notifiedAt: NOW - 1000, createdAt: NOW + 1 });
    const booked = add(w.anna.id, 'booked');
    const other = add(w.boris.id, 'waiting');
    const byStaff = add(w.anna.id, 'waiting', { channel: 'app', note: 'Капризная, звонить после 18', createdAt: NOW + 2 });

    const list = (await get()).waitlist;
    expect(list.map((e: Json) => e.id)).toEqual([waiting.id, notified.id, byStaff.id]);
    expect(list[2]).toMatchObject({ channel: 'app', note: null }); // staff notes stay internal
    expect(list[0]).toEqual({
      id: waiting.id,
      items: [
        { serviceId: w.nipple.id, variant: 'Два', name: 'Соски' },
        { serviceId: w.lobe.id, variant: null, name: 'Мочка' },
      ],
      master: { id: w.fatima.id, name: 'Фатима', color: w.fatima.color },
      dateFrom: '2026-10-20',
      dateTo: '2026-10-25',
      status: 'waiting',
      channel: 'web',
      notifiedAt: null,
      appointmentId: null,
      note: 'После обеда',
      createdAt: new Date(NOW).toISOString(),
    });
    expect(list[1]).toMatchObject({ master: null, notifiedAt: new Date(NOW - 1000).toISOString() });

    expect((await cab(t, 'DELETE', `/waitlist/${waiting.id}`, undefined, miniApp())).statusCode).toBe(204);
    expect(t.ctx.db.select().from(waitlistEntries).where(eq(waitlistEntries.id, waiting.id)).get()!.status).toBe('cancelled');
    expect((await cab(t, 'DELETE', `/waitlist/${waiting.id}`, undefined, miniApp())).statusCode).toBe(204); // already cancelled
    const stale = await cab(t, 'DELETE', `/waitlist/${booked.id}`, undefined, miniApp());
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.message).toBe('Эта запись в листе ожидания уже неактуальна');
    expect((await cab(t, 'DELETE', `/waitlist/${other.id}`, undefined, miniApp())).statusCode).toBe(404);
    expect((await cab(t, 'DELETE', '/waitlist/99999', undefined, miniApp())).statusCode).toBe(404);
    expect(t.ctx.db.select().from(waitlistEntries).where(eq(waitlistEntries.id, other.id)).get()!.status).toBe('waiting');
    expect((await get()).waitlist.map((e: Json) => e.id)).toEqual([notified.id, byStaff.id]);
  });
});
