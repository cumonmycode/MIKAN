import { randomBytes } from 'node:crypto';
import { and, asc, count, desc, eq, gte, inArray, max, ne, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { appointments, botChats, clients, sales } from '../db/schema.js';
import { badRequest, conflict } from '../lib/errors.js';
import { phoneSearchVariants } from '../lib/phone.js';
import { clientFullName, type ClientRow, type ClientStats } from '../lib/serialize.js';
import { normalizeSearchTerm, searchKey } from '../lib/text.js';
import { toIso } from '../lib/time.js';
import { likePattern } from '../lib/validation.js';
import { cancelPendingFollowUps, FOLLOW_UP_SKIP } from './follow-ups.js';
import { getClientRow } from './refs.js';
import { syncRemindersForClient } from './scheduling.js';

export interface ClientInput {
  name?: string;
  lastName?: string | null;
  phone?: string | null;
  instagram?: string | null;
  /** Already cleaned (see `cleanTelegramNick`). */
  telegramNick?: string | null;
  birthday?: string | null;
  notes?: string | null;
  source?: string | null;
  botEnabled?: boolean;
  /** No news and offers (campaigns, birthday, win-back); service messages still go. */
  marketingOptOut?: boolean;
  archived?: boolean;
}

/** The longest `notes` a card may hold (the app's edit form sends them back). */
export const CLIENT_NOTES_MAX = 5000;

type SearchFields = Pick<ClientRow, 'name' | 'lastName' | 'phone' | 'instagram' | 'telegramNick' | 'telegramUsername'>;

/** `nameSort` and `searchText` of a card with these fields. */
export function derivedClientFields(row: SearchFields) {
  const fullName = clientFullName(row);
  return {
    nameSort: searchKey(fullName),
    searchText: searchKey(fullName, phoneSearchVariants(row.phone), row.instagram, row.telegramNick, row.telegramUsername),
  };
}

function assertPhoneFree(db: DbOrTx, phone: string | null | undefined, exceptId?: number): void {
  if (!phone) return;
  const conditions = [eq(clients.phone, phone)];
  if (exceptId !== undefined) conditions.push(ne(clients.id, exceptId));
  const owner = db.select().from(clients).where(and(...conditions)).get();
  if (owner) throw conflict(`Телефон ${phone} уже принадлежит клиенту «${clientFullName(owner)}»`);
}

export function cleanInstagram(value: string | null | undefined): string | null | undefined {
  if (value == null) return value;
  const cleaned = value.trim().replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/^@/, '').replace(/\/+$/, '');
  return cleaned === '' ? null : cleaned;
}

/** "@nick", "t.me/nick", "https://telegram.me/nick/" → "nick"; empty → null. */
export function cleanTelegramNick(value: string | null | undefined): string | null | undefined {
  if (value == null) return value;
  const cleaned = value
    .trim()
    .replace(/^(https?:\/\/)?(www\.)?(t|telegram)\.me\//i, '')
    .replace(/^@/, '')
    .replace(/\/+$/, '');
  return cleaned === '' ? null : cleaned;
}

export function createClient(db: DbOrTx, input: ClientInput & { name: string }, extra: Partial<ClientRow> = {}): ClientRow {
  assertPhoneFree(db, input.phone);
  const now = Date.now();
  const base = {
    name: input.name,
    lastName: input.lastName ?? null,
    phone: input.phone ?? null,
    instagram: cleanInstagram(input.instagram) ?? null,
    telegramNick: input.telegramNick ?? null,
    telegramUsername: extra.telegramUsername ?? null,
  };
  return db
    .insert(clients)
    .values({
      ...base,
      ...derivedClientFields(base),
      birthday: input.birthday ?? null,
      notes: input.notes ?? null,
      source: input.source ?? null,
      botEnabled: input.botEnabled ?? true,
      marketingOptOut: input.marketingOptOut ?? false,
      archived: false,
      telegramChatId: extra.telegramChatId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
}

/**
 * A phone, once set, can be changed but not removed. Clients imported without one (YCLIENTS) stay editable:
 * sending `phone: null` for them changes nothing.
 */
function assertPhoneKept(current: ClientRow, phone: string | null | undefined): void {
  if (phone === null && current.phone !== null) {
    throw badRequest('«Телефон»: обязательное поле — номер можно изменить, но не удалить');
  }
}

export function updateClient(db: DbOrTx, id: number, input: ClientInput): ClientRow {
  const current = getClientRow(db, id);
  assertPhoneKept(current, input.phone);
  if (input.phone !== undefined && input.phone !== current.phone) assertPhoneFree(db, input.phone, id);
  const next = {
    name: input.name ?? current.name,
    lastName: input.lastName === undefined ? current.lastName : input.lastName,
    phone: input.phone === undefined ? current.phone : input.phone,
    instagram: input.instagram === undefined ? current.instagram : (cleanInstagram(input.instagram) ?? null),
    telegramNick: input.telegramNick === undefined ? current.telegramNick : input.telegramNick,
    telegramUsername: current.telegramUsername,
  };
  const row = db
    .update(clients)
    .set({
      ...next,
      ...derivedClientFields(next),
      birthday: input.birthday === undefined ? current.birthday : input.birthday,
      notes: input.notes === undefined ? current.notes : input.notes,
      source: input.source === undefined ? current.source : input.source,
      botEnabled: input.botEnabled ?? current.botEnabled,
      marketingOptOut: input.marketingOptOut ?? current.marketingOptOut,
      archived: input.archived ?? current.archived,
      updatedAt: Date.now(),
    })
    .where(eq(clients.id, id))
    .returning()
    .get();
  if (current.botEnabled && !row.botEnabled) cancelPendingFollowUps(db, [id], FOLLOW_UP_SKIP.botOff);
  return row;
}

export function searchClients(db: DbOrTx, f: { search?: string; archived: boolean; limit: number; offset: number }) {
  const conditions = [eq(clients.archived, f.archived)];
  const term = f.search ? normalizeSearchTerm(f.search) : '';
  if (term) {
    // A phone-looking query ("+7 (999) 12", "8999") is matched by digits against all phone variants.
    const digits = term.replace(/\D/g, '');
    const phoneLike = digits.length >= 3 && /^[\d\s+()-]+$/.test(term);
    conditions.push(sql`${clients.searchText} like ${likePattern(phoneLike ? digits : term)} escape '\\'`);
  }
  const where = and(...conditions);
  const rows = db.select().from(clients).where(where).orderBy(asc(clients.nameSort), asc(clients.id)).limit(f.limit).offset(f.offset).all();
  const total = db.select({ n: count() }).from(clients).where(where).get()?.n ?? 0;
  return { rows, total };
}

export function clientStats(db: DbOrTx, clientId: number): ClientStats {
  return clientStatsByIds(db, [clientId]).get(clientId)!;
}

/** `Client.stats` of several clients in three queries (every id gets an entry, zeros when nothing is found). */
export function clientStatsByIds(db: DbOrTx, clientIds: readonly number[]): Map<number, ClientStats> {
  const ids = [...new Set(clientIds)];
  const result = new Map<number, ClientStats>(
    ids.map((id) => [id, { visits: 0, totalSpent: 0, lastVisitAt: null, upcomingAppointments: 0 }]),
  );
  if (ids.length === 0) return result;
  const visits = db
    .select({ id: appointments.clientId, n: count(), last: max(appointments.startsAt) })
    .from(appointments)
    .where(and(inArray(appointments.clientId, ids), eq(appointments.status, 'completed')))
    .groupBy(appointments.clientId)
    .all();
  // What the client kept of each sale: a partial refund takes off what it returned, a full one everything.
  const spent = db
    .select({ id: sales.clientId, v: sql<number>`coalesce(sum(${sales.total} - ${sales.refundedTotal}), 0)` })
    .from(sales)
    .where(and(inArray(sales.clientId, ids), eq(sales.status, 'completed')))
    .groupBy(sales.clientId)
    .all();
  const upcoming = db
    .select({ id: appointments.clientId, n: count() })
    .from(appointments)
    .where(
      and(
        inArray(appointments.clientId, ids),
        inArray(appointments.status, ['scheduled', 'confirmed']),
        gte(appointments.startsAt, Date.now()),
      ),
    )
    .groupBy(appointments.clientId)
    .all();
  const patch = (id: number | null, values: Partial<ClientStats>) => {
    const current = id != null ? result.get(id) : undefined;
    if (current) result.set(id!, { ...current, ...values });
  };
  for (const v of visits) patch(v.id, { visits: v.n, lastVisitAt: toIso(v.last ?? null) });
  for (const s of spent) patch(s.id, { totalSpent: s.v });
  for (const u of upcoming) patch(u.id, { upcomingAppointments: u.n });
  return result;
}

export function clientHistory(db: DbOrTx, clientId: number) {
  const appts = db
    .select()
    .from(appointments)
    .where(eq(appointments.clientId, clientId))
    .orderBy(desc(appointments.startsAt), desc(appointments.id))
    .all();
  const saleRows = db.select().from(sales).where(eq(sales.clientId, clientId)).orderBy(desc(sales.createdAt), desc(sales.id)).all();
  return { appts, saleRows };
}

/** Creates (or replaces) the one-time token used in the t.me deep link. */
export function issueLinkToken(db: DbOrTx, clientId: number): string {
  getClientRow(db, clientId);
  const token = randomBytes(12).toString('base64url');
  db.update(clients).set({ linkToken: token, updatedAt: Date.now() }).where(eq(clients.id, clientId)).run();
  return token;
}

export function findClientByLinkToken(db: DbOrTx, token: string): ClientRow | null {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(token)) return null;
  return db.select().from(clients).where(eq(clients.linkToken, token)).get() ?? null;
}

export function findClientByPhone(db: DbOrTx, phone: string): ClientRow | null {
  return db.select().from(clients).where(eq(clients.phone, phone)).get() ?? null;
}

export function findClientByChat(db: DbOrTx, chatId: number): ClientRow | null {
  return db.select().from(clients).where(eq(clients.telegramChatId, chatId)).get() ?? null;
}

/**
 * Links a Telegram chat to a client (unlinking any other client that had this chat),
 * updates the bot chat row and schedules reminders for upcoming appointments.
 */
export function linkTelegram(db: DbOrTx, clientId: number, chatId: number, username: string | null): ClientRow {
  return db.transaction((tx) => {
    const now = Date.now();
    const unlinked = tx
      .update(clients)
      .set({ telegramChatId: null, updatedAt: now })
      .where(and(eq(clients.telegramChatId, chatId), ne(clients.id, clientId)))
      .returning({ id: clients.id })
      .all();
    cancelPendingFollowUps(tx, unlinked.map((c) => c.id), FOLLOW_UP_SKIP.unlinked);
    const current = getClientRow(tx, clientId);
    const next = { ...current, telegramUsername: username ?? current.telegramUsername };
    const row = tx
      .update(clients)
      .set({
        telegramChatId: chatId,
        telegramUsername: next.telegramUsername,
        linkToken: null,
        ...derivedClientFields(next),
        updatedAt: now,
      })
      .where(eq(clients.id, clientId))
      .returning()
      .get();
    tx.update(botChats).set({ clientId, updatedAt: now }).where(eq(botChats.chatId, chatId)).run();
    syncRemindersForClient(tx, clientId, now);
    return row;
  });
}
