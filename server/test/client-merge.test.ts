import { and, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appointments,
  auditLog,
  bonusOperations,
  bookingRequests,
  botChats,
  campaignRecipients,
  campaigns,
  clientAccessTokens,
  clients,
  employees,
  giftCertificates,
  openReceipts,
  qrPayments,
  retentionSends,
  sales,
  scheduledMessages,
  waitlistEntries,
} from '../src/db/schema.js';
import { CLIENT_REFERENCES, mergedClientFields } from '../src/domain/client-merge.js';
import { createClient, findClientByChat, findClientByLinkToken, issueLinkToken } from '../src/domain/clients.js';
import type { ClientRow } from '../src/lib/serialize.js';
import { createTestApp, type TestApp } from './helpers.js';

const NOW = Date.parse('2026-10-15T09:00:00.000Z');
const HOUR = 3_600_000;

describe('client merge', () => {
  let t: TestApp;
  let masterId: number;
  let saleNumber = 0;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    t = await createTestApp();
    masterId = t.ctx.db.select().from(employees).get()!.id;
  });
  afterEach(async () => {
    await t.close();
    vi.useRealTimers();
  });

  const card = (name: string, extra: Partial<Parameters<typeof createClient>[1]> = {}, row: Partial<ClientRow> = {}) =>
    createClient(t.ctx.db, { name, phone: null, ...extra }, row);
  const merge = (id: number, intoId: unknown) => t.api('POST', `/api/clients/${id}/merge`, { intoId });
  const db = () => t.ctx.db;

  const visit = (clientId: number, startsAt: number, status = 'completed') =>
    db()
      .insert(appointments)
      .values({ clientId, masterId, startsAt, endsAt: startsAt + HOUR, status, createdAt: NOW, updatedAt: NOW })
      .returning()
      .get();
  const sale = (clientId: number, total: number) =>
    db()
      .insert(sales)
      .values({ number: ++saleNumber, clientId, employeeId: masterId, subtotal: total, total, payCash: total, status: 'completed', createdAt: NOW })
      .returning()
      .get();
  const campaign = () =>
    db().insert(campaigns).values({ title: 'Осень', text: 'Скидка', segment: '{}', status: 'sending', createdAt: NOW, updatedAt: NOW }).returning().get();
  const recipient = (campaignId: number, clientId: number, status: string) =>
    db().insert(campaignRecipients).values({ campaignId, clientId, chatId: 1, status }).returning().get();
  const count = (table: string, column: string, id: number) =>
    t.ctx.sqlite.prepare(`select count(*) as n from ${table} where ${column} = ?`).get(id) as { n: number };

  it('covers every column that references a client', () => {
    const tables = t.ctx.sqlite.prepare(`select name from sqlite_master where type = 'table'`).all() as Array<{ name: string }>;
    const referencing = tables.flatMap(({ name }) =>
      (t.ctx.sqlite.prepare(`pragma foreign_key_list(${JSON.stringify(name)})`).all() as Array<{ table: string; from: string }>)
        .filter((fk) => fk.table === 'clients')
        .map((fk) => `${name}.${fk.from}`),
    );
    expect(CLIENT_REFERENCES.map((r) => `${r.table}.${r.column}`).sort()).toEqual(referencing.sort());
  });

  it('moves everything of the source to the kept card and deletes the source', async () => {
    const kept = card('Анна', { lastName: 'Иванова', phone: '+79990000001' });
    const source = card('Анна', { phone: '+79990000002' });
    const appointment = visit(source.id, NOW - 30 * 24 * HOUR);
    const sold = sale(source.id, 3500);
    db().insert(openReceipts).values({ clientId: source.id, employeeId: masterId, createdAt: NOW, updatedAt: NOW }).run();
    db().insert(botChats).values({ chatId: 555, clientId: source.id, createdAt: NOW, updatedAt: NOW }).run();
    db()
      .insert(scheduledMessages)
      .values({ chatId: 555, clientId: source.id, kind: 'follow_up', sendAt: NOW + HOUR, text: 'Как заживает?', status: 'pending', createdAt: NOW })
      .run();
    db().insert(bookingRequests).values({ clientId: source.id, contactName: 'Анна', status: 'new', createdAt: NOW, updatedAt: NOW }).run();
    db().insert(bonusOperations).values({ clientId: source.id, type: 'gift', amount: 300, remaining: 300, createdAt: NOW }).run();
    db()
      .insert(giftCertificates)
      .values({ code: 'MIKAN-AAAA-BBBB', amount: 5000, balance: 5000, status: 'active', buyerClientId: source.id, createdAt: NOW, updatedAt: NOW })
      .run();
    recipient(campaign().id, source.id, 'sent');
    db().insert(retentionSends).values({ clientId: source.id, kind: 'birthday', periodKey: '2026', sentAt: NOW }).run();
    db()
      .insert(waitlistEntries)
      .values({ clientId: source.id, items: '[]', dateFrom: '2026-10-20', dateTo: '2026-10-30', status: 'waiting', channel: 'bot', createdAt: NOW, updatedAt: NOW })
      .run();
    db().insert(clientAccessTokens).values({ clientId: source.id, tokenHash: 'h1', createdAt: NOW, expiresAt: NOW + HOUR }).run();
    db().insert(auditLog).values({ at: NOW, source: 'app', action: 'client.update', entity: 'client', entityId: source.id, summary: 'Карточка изменена' }).run();
    db()
      .insert(qrPayments)
      .values({
        kind: 'sale',
        provider: 'fake',
        externalId: 'QR1',
        payload: 'https://qr.nspk.ru/QR1',
        amount: 1000,
        status: 'pending',
        saleInputJson: JSON.stringify({ clientId: source.id, items: [], payments: { qr: 1000 } }),
        employeeId: masterId,
        expiresAt: NOW + HOUR,
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();

    const res = await merge(source.id, kept.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: kept.id, name: 'Анна', lastName: 'Иванова', phone: '+79990000001' });

    for (const ref of CLIENT_REFERENCES) {
      expect({ ref, left: count(ref.table, ref.column, source.id).n }).toEqual({ ref, left: 0 });
      expect({ ref, moved: count(ref.table, ref.column, kept.id).n }).toEqual({ ref, moved: 1 });
    }
    expect(db().select().from(appointments).where(eq(appointments.id, appointment.id)).get()!.clientId).toBe(kept.id);
    expect(db().select().from(sales).where(eq(sales.id, sold.id)).get()!.clientId).toBe(kept.id);
    expect(count('audit_log', 'entity_id', source.id).n).toBe(0);
    const cart = JSON.parse(db().select().from(qrPayments).get()!.saleInputJson!) as { clientId: number };
    expect(cart.clientId).toBe(kept.id);
    expect((await t.api('GET', `/api/clients/${source.id}`)).statusCode).toBe(404);
  });

  it('answers with the kept card and its combined stats and bonuses', async () => {
    const kept = card('Анна', { lastName: 'Иванова', phone: '+79990000001' });
    const source = card('Анна', { phone: '+79990000002' });
    visit(kept.id, NOW - 60 * 24 * HOUR);
    visit(source.id, NOW - 10 * 24 * HOUR);
    visit(source.id, NOW + 2 * 24 * HOUR, 'scheduled');
    sale(kept.id, 2000);
    sale(source.id, 3500);
    db().insert(bonusOperations).values({ clientId: kept.id, type: 'gift', amount: 200, remaining: 200, createdAt: NOW }).run();
    db().insert(bonusOperations).values({ clientId: source.id, type: 'gift', amount: 300, remaining: 300, createdAt: NOW }).run();

    const res = await merge(source.id, kept.id);
    expect(res.json()).toMatchObject({
      id: kept.id,
      stats: {
        visits: 2,
        totalSpent: 5500,
        lastVisitAt: new Date(NOW - 10 * 24 * HOUR).toISOString(),
        upcomingAppointments: 1,
      },
      loyalty: { bonusBalance: 500 },
    });
    const history = (await t.api('GET', `/api/clients/${kept.id}/history`)).json();
    expect(history.appointments).toHaveLength(3);
    expect(history.sales).toHaveLength(2);
  });

  it('fills the kept card’s empty fields, joins notes and keeps a no-news request', async () => {
    const kept = card('Анна', { lastName: null, notes: 'Аллергия на никель', instagram: 'anna.main' });
    const source = card(
      'Анна',
      {
        lastName: 'Иванова',
        phone: '+79990000002',
        birthday: '1995-04-12',
        telegramNick: 'anna_iv',
        instagram: 'anna.other',
        source: 'instagram',
        notes: 'Любит маленькие серьги',
        marketingOptOut: true,
      },
    );
    db().update(clients).set({ createdAt: NOW - 400 * 24 * HOUR }).where(eq(clients.id, source.id)).run();

    const res = await merge(source.id, kept.id);
    expect(res.json()).toMatchObject({
      id: kept.id,
      name: 'Анна',
      lastName: 'Иванова',
      phone: '+79990000002',
      birthday: '1995-04-12',
      telegramNick: 'anna_iv',
      instagram: 'anna.main',
      source: 'instagram',
      notes: 'Аллергия на никель\n\nЛюбит маленькие серьги',
      marketingOptOut: true,
      createdAt: new Date(NOW - 400 * 24 * HOUR).toISOString(),
    });
    // The kept card is found by what it took over.
    const found = (await t.api('GET', '/api/clients?search=89990000002')).json().items;
    expect(found.map((c: { id: number }) => c.id)).toEqual([kept.id]);
    expect((await t.api('GET', '/api/clients?search=иванова')).json().items).toHaveLength(1);
  });

  it('works out the merged fields without doubling notes or a last name the first name already holds', () => {
    const base = card('Тест');
    const kept = { ...base, name: 'Анна Иванова', lastName: null, notes: 'Аллергия', archived: true };
    const source = { ...base, id: base.id + 1, name: 'Анна', lastName: 'Иванова', notes: ' Аллергия ', archived: false };
    const merged = mergedClientFields(kept, source);
    expect(merged.lastName).toBeNull();
    expect(merged.notes).toBe('Аллергия');
    expect(merged.archived).toBe(false);
    expect(mergedClientFields({ ...kept, notes: null }, { ...source, notes: null }).notes).toBeNull();
    expect(mergedClientFields({ ...kept, name: 'Анна' }, source).lastName).toBe('Иванова');
    // An older card holds the whole name in `name`: its last name still carries over.
    const legacy = { ...source, name: 'Анна  Иванова ', lastName: null };
    expect(mergedClientFields({ ...kept, name: 'Анна' }, legacy).lastName).toBe('Иванова');
    expect(mergedClientFields(kept, legacy).lastName).toBeNull();
    expect(mergedClientFields({ ...kept, name: 'Анна' }, { ...legacy, name: 'Анна' }).lastName).toBeNull();
  });

  it('refuses notes that would not fit together, changing nothing', async () => {
    const kept = card('Анна', { notes: 'а'.repeat(3000) });
    const source = card('Анна', { phone: '+79990000002', notes: 'б'.repeat(3000) });
    visit(source.id, NOW - HOUR);
    const res = await merge(source.id, kept.id);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe('Заметки двух карточек вместе длиннее 5000 символов — сократите их и повторите');
    expect(count('appointments', 'client_id', source.id).n).toBe(1);
    expect((await t.api('GET', `/api/clients/${source.id}`)).statusCode).toBe(200);
  });

  describe('Telegram', () => {
    it('takes the source’s link when the kept card has none, with reminders for upcoming visits', async () => {
      const kept = card('Анна', { lastName: 'Иванова', phone: '+79990000001' });
      const source = card('Анна', {}, { telegramChatId: 777, telegramUsername: 'anna_tg' });
      db().insert(botChats).values({ chatId: 777, clientId: source.id, createdAt: NOW, updatedAt: NOW }).run();
      const upcoming = visit(kept.id, NOW + 3 * 24 * HOUR, 'scheduled');

      const res = await merge(source.id, kept.id);
      expect(res.json()).toMatchObject({ id: kept.id, telegramLinked: true, telegramUsername: 'anna_tg' });
      expect(findClientByChat(db(), 777)?.id).toBe(kept.id);
      expect(db().select().from(botChats).where(eq(botChats.chatId, 777)).get()!.clientId).toBe(kept.id);
      const reminders = db()
        .select()
        .from(scheduledMessages)
        .where(and(eq(scheduledMessages.appointmentId, upcoming.id), eq(scheduledMessages.status, 'pending')))
        .all();
      expect(reminders.length).toBeGreaterThan(0);
      expect(reminders.every((r) => r.clientId === kept.id && r.chatId === 777)).toBe(true);
    });

    it('keeps the kept card’s own link when both are linked; the source’s chat stays with the kept card', async () => {
      const kept = card('Анна', { phone: '+79990000001' }, { telegramChatId: 111, telegramUsername: 'anna_one' });
      const source = card('Анна', {}, { telegramChatId: 222, telegramUsername: 'anna_two' });
      db().insert(botChats).values({ chatId: 111, clientId: kept.id, createdAt: NOW, updatedAt: NOW }).run();
      db().insert(botChats).values({ chatId: 222, clientId: source.id, createdAt: NOW, updatedAt: NOW }).run();

      const res = await merge(source.id, kept.id);
      expect(res.json()).toMatchObject({ telegramLinked: true, telegramUsername: 'anna_one' });
      expect(findClientByChat(db(), 111)?.id).toBe(kept.id);
      expect(findClientByChat(db(), 222)).toBeNull();
      expect(db().select().from(botChats).where(eq(botChats.chatId, 222)).get()!.clientId).toBe(kept.id);
      const chat = (await t.api('GET', `/api/clients/${kept.id}/chat`)).json().chat;
      expect(chat.chatId).toBe(111);
    });

    it('keeps the kept card’s link when only it is linked', async () => {
      const kept = card('Анна', { phone: '+79990000001' }, { telegramChatId: 111, telegramUsername: 'anna_one' });
      const source = card('Анна', { telegramNick: 'anna_nick' });
      const res = await merge(source.id, kept.id);
      expect(res.json()).toMatchObject({ telegramLinked: true, telegramUsername: 'anna_one', telegramNick: 'anna_nick' });
    });

    it('carries over a link the source was sent but has not opened yet', async () => {
      const kept = card('Анна', { phone: '+79990000001' });
      const source = card('Анна');
      const token = issueLinkToken(db(), source.id);
      await merge(source.id, kept.id);
      expect(findClientByLinkToken(db(), token)?.id).toBe(kept.id);
    });
  });

  describe('unique rows', () => {
    it('keeps one campaign recipient per campaign: the one that was sent', async () => {
      const kept = card('Анна', { phone: '+79990000001' });
      const source = card('Анна');
      const first = campaign();
      const second = campaign();
      const third = campaign();
      recipient(first.id, kept.id, 'pending');
      const sentToSource = recipient(first.id, source.id, 'sent');
      const sentToKept = recipient(second.id, kept.id, 'sent');
      recipient(second.id, source.id, 'pending');
      const onlySource = recipient(third.id, source.id, 'failed');

      expect((await merge(source.id, kept.id)).statusCode).toBe(200);
      const rows = db().select().from(campaignRecipients).orderBy(campaignRecipients.campaignId).all();
      expect(rows.map((r) => [r.id, r.campaignId, r.clientId, r.status])).toEqual([
        [sentToSource.id, first.id, kept.id, 'sent'],
        [sentToKept.id, second.id, kept.id, 'sent'],
        [onlySource.id, third.id, kept.id, 'failed'],
      ]);
    });

    it('keeps one retention send per kind and period', async () => {
      const kept = card('Анна', { phone: '+79990000001' });
      const source = card('Анна');
      const send = (clientId: number, kind: string, periodKey: string) =>
        db().insert(retentionSends).values({ clientId, kind, periodKey, sentAt: NOW }).run();
      send(kept.id, 'birthday', '2026');
      send(source.id, 'birthday', '2026');
      send(source.id, 'birthday', '2025');
      send(source.id, 'winback', '2026-03-01');

      expect((await merge(source.id, kept.id)).statusCode).toBe(200);
      const rows = db()
        .select({ clientId: retentionSends.clientId, kind: retentionSends.kind, periodKey: retentionSends.periodKey })
        .from(retentionSends)
        .orderBy(retentionSends.kind, retentionSends.periodKey)
        .all();
      expect(rows).toEqual([
        { clientId: kept.id, kind: 'birthday', periodKey: '2025' },
        { clientId: kept.id, kind: 'birthday', periodKey: '2026' },
        { clientId: kept.id, kind: 'winback', periodKey: '2026-03-01' },
      ]);
    });
  });

  it('logs the merge on the kept card, with the source’s history moved there', async () => {
    const kept = card('Анна', { lastName: 'Иванова', phone: '+79990000001' });
    const source = await t.api('POST', '/api/clients', { name: 'Анна', phone: '+79990000002' });
    const sourceId = source.json().id as number;

    await merge(sourceId, kept.id);
    const entries = (await t.api('GET', `/api/audit?entity=client&entityId=${kept.id}`)).json().items;
    expect(entries.map((e: { action: string }) => e.action)).toEqual(['client.merge', 'client.create']);
    expect(entries[0]).toMatchObject({
      entity: 'client',
      entityId: kept.id,
      summary: 'Карточка «Анна» (+79990000002) объединена с «Анна Иванова»',
      changes: { clientId: { from: sourceId, to: kept.id } },
    });
  });

  it('keeps dismissed duplicate pairs for the kept card', async () => {
    const kept = card('Анна', { lastName: 'Иванова', phone: '+79990000001' });
    const source = card('Анна', { lastName: 'Иванова', phone: '+79990000002' });
    const other = card('Анна', { lastName: 'Иванова', phone: '+79990000003' });
    await t.api('POST', '/api/clients/duplicates/dismiss', { clientIds: [source.id, other.id] });
    await t.api('POST', '/api/clients/duplicates/dismiss', { clientIds: [kept.id, other.id] });

    await merge(source.id, kept.id);
    expect((await t.api('GET', '/api/clients/duplicates')).json().items).toEqual([]);
    const stored = t.ctx.db.get<{ value: string }>(sql`select value from settings where key = 'clientDuplicatesDismissed'`);
    expect(JSON.parse(stored!.value)).toEqual([`${kept.id}:${other.id}`]);
  });

  it('answers errors for the same card, unknown cards and a missing target', async () => {
    const kept = card('Анна', { phone: '+79990000001' });
    const same = await merge(kept.id, kept.id);
    expect(same.statusCode).toBe(400);
    expect(same.json().error.message).toBe('Нельзя объединить карточку саму с собой');
    expect((await merge(9999, kept.id)).statusCode).toBe(404);
    const unknownTarget = await merge(kept.id, 9999);
    expect(unknownTarget.statusCode).toBe(404);
    expect(unknownTarget.json().error.message).toBe('Клиент не найден');
    expect((await merge(kept.id, undefined)).statusCode).toBe(400);
    expect((await merge(kept.id, 'abc')).statusCode).toBe(400);
    expect(db().select().from(clients).where(eq(clients.id, kept.id)).get()).toBeDefined();
  });
});
