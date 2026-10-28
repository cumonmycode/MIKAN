import { eq } from 'drizzle-orm';
import type { InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appointments, clients, employees } from '../src/db/schema.js';
import { createClient } from '../src/domain/clients.js';
import { createTestApp, make, type TestApp } from './helpers.js';

const MANAGERS = 'Это доступно владельцу и администратору';

interface GroupOut {
  reason: string;
  clients: Array<{ id: number; name: string; lastName: string | null; stats: { visits: number } | null }>;
}

describe('client duplicates', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(async () => {
    await t.close();
  });

  /** A card straight in the database: imported cards may have no phone. */
  const card = (name: string, extra: { lastName?: string; phone?: string | null; instagram?: string; telegramNick?: string } = {}) =>
    createClient(t.ctx.db, { name, phone: null, ...extra });

  const groups = async (): Promise<GroupOut[]> => {
    const res = await t.api('GET', '/api/clients/duplicates');
    expect(res.statusCode).toBe(200);
    return res.json<{ items: GroupOut[] }>().items;
  };
  const ids = (g: GroupOut) => g.clients.map((c) => c.id).sort((a, b) => a - b);

  const completedVisit = (clientId: number, at: string) => {
    const master = t.ctx.db.select().from(employees).get()!;
    const startsAt = Date.parse(at);
    t.ctx.db
      .insert(appointments)
      .values({ clientId, masterId: master.id, startsAt, endsAt: startsAt + 3_600_000, status: 'completed', createdAt: startsAt, updatedAt: startsAt })
      .run();
  };

  it('finds the same full name, ignoring case, ё and spaces, whichever field holds the last name', async () => {
    const a = card('Алёна', { lastName: 'Петрова', phone: '+79990000001' });
    const b = card('алена  петрова', { phone: '+79990000002' });
    const c = card('Алена', { lastName: 'ПЕТРОВА' });
    card('Алёна', { lastName: 'Смирнова', phone: '+79990000003' });

    const found = await groups();
    expect(found).toHaveLength(1);
    expect(found[0]!.reason).toBe('same_full_name');
    expect(ids(found[0]!)).toEqual([a.id, b.id, c.id]);
  });

  it('offers a first-name match only when one card has no phone and at most one has a last name', async () => {
    const phoneless = card('Мария');
    const withPhone = card('Мария', { phone: '+79990000011' });
    const withLastName = card('Мария', { lastName: 'Ким', phone: '+79990000012' });
    // Two cards with different phones and only a first name: likely different people.
    card('Ольга', { phone: '+79990000013' });
    card('Ольга', { phone: '+79990000014' });
    // Different last names: different people even though one has no phone.
    card('Ирина', { lastName: 'Ким' });
    card('Ирина', { lastName: 'Ли', phone: '+79990000015' });

    const found = await groups();
    expect(found).toHaveLength(1);
    expect(found[0]!.reason).toBe('phoneless_same_name');
    expect(ids(found[0]!)).toEqual([phoneless.id, withPhone.id, withLastName.id]);
  });

  it('matches Telegram nicks and usernames and Instagram case-insensitively, strongest reasons first', async () => {
    const nick = card('Катя', { phone: '+79990000021', telegramNick: 'Kate_Tattoo' });
    const linked = card('Екатерина', { phone: '+79990000022' });
    t.ctx.db.update(clients).set({ telegramUsername: 'kate_tattoo' }).where(eq(clients.id, linked.id)).run();
    const insta1 = card('Лиза', { phone: '+79990000023', instagram: 'Liza.Ink' });
    const insta2 = card('Елизавета', { phone: '+79990000024', instagram: 'liza.ink' });
    const full1 = card('Анна', { lastName: 'Иванова', phone: '+79990000025' });
    const full2 = card('Анна', { lastName: 'Иванова', phone: '+79990000026' });
    const phoneless1 = card('Зоя');
    const phoneless2 = card('Зоя', { phone: '+79990000027' });

    const found = await groups();
    expect(found.map((g) => g.reason)).toEqual(['same_telegram', 'same_instagram', 'same_full_name', 'phoneless_same_name']);
    expect(found.map(ids)).toEqual([
      [nick.id, linked.id],
      [insta1.id, insta2.id],
      [full1.id, full2.id],
      [phoneless1.id, phoneless2.id],
    ]);
  });

  it('shows a pair once, under its strongest reason', async () => {
    const a = card('Анна', { lastName: 'Иванова', phone: '+79990000031', telegramNick: 'anna_iv' });
    const b = card('Анна', { lastName: 'Иванова', phone: '+79990000032', telegramNick: 'Anna_Iv' });
    const c = card('Анна', { lastName: 'Иванова', phone: '+79990000033' });

    const found = await groups();
    expect(found.map((g) => [g.reason, ids(g)])).toEqual([
      ['same_telegram', [a.id, b.id]],
      ['same_full_name', [a.id, b.id, c.id]],
    ]);

    // Dismissing the third card's pairs leaves only the Telegram match.
    await t.api('POST', '/api/clients/duplicates/dismiss', { clientIds: [a.id, c.id] });
    await t.api('POST', '/api/clients/duplicates/dismiss', { clientIds: [b.id, c.id] });
    expect((await groups()).map((g) => [g.reason, ids(g)])).toEqual([['same_telegram', [a.id, b.id]]]);
  });

  it('returns cards with stats, the one with most visits first', async () => {
    const few = card('Вера', { lastName: 'Орлова', phone: '+79990000041' });
    const many = card('Вера', { lastName: 'Орлова', phone: '+79990000042' });
    completedVisit(many.id, '2026-09-01T10:00:00.000Z');
    completedVisit(many.id, '2026-09-20T10:00:00.000Z');
    completedVisit(few.id, '2026-08-01T10:00:00.000Z');

    const [group] = await groups();
    expect(group!.clients.map((c) => c.id)).toEqual([many.id, few.id]);
    expect(group!.clients[0]).toMatchObject({
      name: 'Вера',
      lastName: 'Орлова',
      phone: '+79990000042',
      stats: { visits: 2, totalSpent: 0, lastVisitAt: '2026-09-20T10:00:00.000Z', upcomingAppointments: 0 },
    });
  });

  it('dismisses every pair of the ids sent, so the group is not offered again', async () => {
    const a = card('Анна', { lastName: 'Иванова', phone: '+79990000051' });
    const b = card('Анна', { lastName: 'Иванова', phone: '+79990000052' });
    const c = card('Анна', { lastName: 'Иванова', phone: '+79990000053' });

    const one = await t.api('POST', '/api/clients/duplicates/dismiss', { clientIds: [b.id, a.id] });
    expect(one.statusCode).toBe(204);
    // A–C and B–C still connect all three.
    expect((await groups()).map(ids)).toEqual([[a.id, b.id, c.id]]);

    expect((await t.api('POST', '/api/clients/duplicates/dismiss', { clientIds: [a.id, b.id, c.id] })).statusCode).toBe(204);
    expect(await groups()).toEqual([]);
    // Dismissing again is harmless.
    expect((await t.api('POST', '/api/clients/duplicates/dismiss', { clientIds: [a.id, c.id] })).statusCode).toBe(204);
    expect(await groups()).toEqual([]);
  });

  it('validates the dismissed ids', async () => {
    const a = card('Анна', { lastName: 'Иванова', phone: '+79990000061' });
    const b = card('Анна', { lastName: 'Иванова', phone: '+79990000062' });
    const status = async (payload: unknown) => (await t.api('POST', '/api/clients/duplicates/dismiss', payload)).statusCode;

    expect(await status({ clientIds: [a.id] })).toBe(400);
    expect(await status({ clientIds: [a.id, a.id] })).toBe(400);
    expect(await status({})).toBe(400);
    const unknown = await t.api('POST', '/api/clients/duplicates/dismiss', { clientIds: [a.id, 9999] });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.message).toBe('Клиент не найден');
    expect((await groups()).map(ids)).toEqual([[a.id, b.id]]);
  });

  it('logs a dismissal', async () => {
    const a = card('Анна', { lastName: 'Иванова', phone: '+79990000071' });
    const b = card('Анна', { lastName: 'Иванова', phone: '+79990000072' });
    await t.api('POST', '/api/clients/duplicates/dismiss', { clientIds: [a.id, b.id] });
    const audit = (await t.api('GET', '/api/audit?entity=client')).json().items;
    expect(audit[0]).toMatchObject({
      action: 'client.dismiss_duplicates',
      entity: 'client',
      summary: `Карточки №${a.id} и №${b.id} отмечены как разные люди`,
    });
  });

  it('is limited to the owner and the admin', async () => {
    const a = card('Анна', { lastName: 'Иванова', phone: '+79990000081' });
    const b = card('Анна', { lastName: 'Иванова', phone: '+79990000082' });
    const session = async (role: 'admin' | 'master', login: string) => {
      await make(t, '/api/employees', { name: login, login, password: 'secret123', isMaster: role === 'master', role });
      const res = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login, password: 'secret123' } });
      const token = res.json<{ token: string }>().token;
      return (method: InjectOptions['method'], url: string, payload?: unknown) =>
        t.app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload === undefined ? {} : { payload: payload as InjectOptions['payload'] }) });
    };
    const master = await session('master', 'fatima');
    const admin = await session('admin', 'aida');

    for (const [method, url, payload] of [
      ['GET', '/api/clients/duplicates', undefined],
      ['POST', '/api/clients/duplicates/dismiss', { clientIds: [a.id, b.id] }],
      ['POST', `/api/clients/${a.id}/merge`, { intoId: b.id }],
    ] as const) {
      const res = await master(method, url, payload);
      expect({ url, status: res.statusCode, error: res.json().error }).toEqual({ url, status: 403, error: { code: 'forbidden', message: MANAGERS } });
    }
    expect((await admin('GET', '/api/clients/duplicates')).statusCode).toBe(200);
    expect((await admin('POST', `/api/clients/${a.id}/merge`, { intoId: b.id })).statusCode).toBe(200);
  });

  it('handles a thousand cards quickly', async () => {
    const now = Date.now();
    const rows = Array.from({ length: 1000 }, (_, i) => {
      const name = ['Анна', 'Мария', 'Ольга', 'Ирина', 'Елена'][i % 5]!;
      const lastName = i % 3 === 0 ? `Фамилия${i % 40}` : null;
      return {
        name,
        lastName,
        nameSort: `${name} ${lastName ?? ''}`.trim().toLowerCase(),
        phone: i % 80 === 0 ? null : `+7999${String(1_000_000 + i)}`,
        searchText: '',
        createdAt: now,
        updatedAt: now,
      };
    });
    t.ctx.db.insert(clients).values(rows).run();

    const started = performance.now();
    const found = await groups();
    const elapsed = performance.now() - started;
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((g) => g.clients.length >= 2 && g.clients.every((c) => c.stats !== null))).toBe(true);
    expect(elapsed).toBeLessThan(2000);
  });
});
