import { and, asc, desc, eq, gte, inArray, lt, or } from 'drizzle-orm';
import { DateTime } from 'luxon';
import type { DbOrTx } from '../db/client.js';
import { clients, waitlistEntries } from '../db/schema.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { clientRef, employeeRef, parseVariants } from '../lib/serialize.js';
import { pluralWord } from '../lib/text.js';
import { DAY_MS, isValidCalendarDate, localDate, toIso } from '../lib/time.js';
import { resolveItems, type BookingItem } from './online-booking-items.js';
import { bookingDates, onlineMasters } from './online-booking-slots.js';
import { clientsByIds, employeesByIds, servicesByIds } from './refs.js';
import { getStudioSettings } from './settings.js';
import {
  isOpenStatus,
  openEntryCount,
  OPEN_WAITLIST_STATUSES,
  parseWaitlistItems,
  waitlistItemsJson,
  WAITLIST_STATUSES,
  type WaitlistChannel,
  type WaitlistItem,
  type WaitlistRow,
} from './waitlist-store.js';

/**
 * The waitlist (docs/API.md «Waitlist»): a client's wish for services, a master or any and a range of dates, kept
 * until freed time is booked, the client or staff cancel it or the range is over.
 */

export const MAX_OPEN_PER_CLIENT = 3;
export const MAX_RANGE_DAYS = 30;
/** Staff may put a wish this far ahead; clients only within the online booking horizon. */
export const STAFF_AHEAD_DAYS = 365;
export const NOTE_MAX = 500;
/** `GET /waitlist` shows closed entries of this many recent days. */
export const CLOSED_SHOWN_DAYS = 90;

export const STAFF_LIMIT_MESSAGE = `В листе ожидания уже ${MAX_OPEN_PER_CLIENT} заявки этого клиента`;
export const CLIENT_LIMIT_MESSAGE = `У вас уже ${MAX_OPEN_PER_CLIENT} заявки в листе ожидания — дождитесь сообщения или отмените одну из них`;
export const CLOSED_MESSAGE = 'Эта запись листа ожидания уже закрыта';
/** The same in the client cabinet (docs/API.md «Client cabinet» → «Waitlist»). */
export const CLIENT_CLOSED_MESSAGE = 'Эта запись в листе ожидания уже неактуальна';

export interface WaitlistInput {
  channel: WaitlistChannel;
  items: BookingItem[];
  masterId?: number | null;
  dateFrom: string;
  dateTo: string;
  note?: string | null;
}

/** A validated wish: items with their canonical variant names, ready to store. */
export interface CheckedWish {
  items: WaitlistItem[];
  masterId: number | null;
  dateFrom: string;
  dateTo: string;
  note: string | null;
}

const daysBetween = (from: string, to: string): number =>
  DateTime.fromISO(to, { zone: 'utc' }).diff(DateTime.fromISO(from, { zone: 'utc' }), 'days').days;

/** `400` unless the range is valid for the channel (clients: within the online booking horizon). */
export function checkRange(db: DbOrTx, from: string, to: string, channel: WaitlistChannel, now: number): void {
  if (!isValidCalendarDate(from) || !isValidCalendarDate(to)) throw badRequest('Даты должны быть в формате ГГГГ-ММ-ДД');
  const today = localDate(now, getStudioSettings(db).timezone);
  if (from < today) throw badRequest('Начало периода уже прошло — выберите даты с сегодняшнего дня');
  if (to < from) throw badRequest('Конец периода должен быть не раньше начала');
  if (daysBetween(from, to) + 1 > MAX_RANGE_DAYS) throw badRequest(`Период — не больше ${MAX_RANGE_DAYS} дней`);
  if (channel === 'app') {
    if (daysBetween(today, to) > STAFF_AHEAD_DAYS) throw badRequest('Лист ожидания — не дальше чем на год вперёд');
    return;
  }
  const { horizonDays } = getStudioSettings(db).onlineBooking;
  if (to > bookingDates(db, now).last) {
    throw badRequest(`Онлайн-запись открыта на ${horizonDays} ${pluralWord(horizonDays, 'день', 'дня', 'дней')} вперёд — выберите даты пораньше`);
  }
}

/** The variant as the catalog names it (the check accepts any letter case). */
function canonicalItems(db: DbOrTx, items: BookingItem[]): WaitlistItem[] {
  const catalog = servicesByIds(db, items.map((i) => i.serviceId));
  return items.map((item) => {
    const wanted = item.variant?.trim().toLowerCase() ?? '';
    const variants = parseVariants(catalog.get(item.serviceId)?.variantsJson ?? '[]');
    const variant = wanted ? (variants.find((v) => v.name.trim().toLowerCase() === wanted)?.name ?? item.variant!.trim()) : null;
    return { serviceId: item.serviceId, variant };
  });
}

/** Validates a wish without the client: services, master, dates, note. `400` with the reason. */
export function checkWish(db: DbOrTx, input: WaitlistInput, now: number): CheckedWish {
  resolveItems(db, input.items);
  const masterId = input.masterId ?? null;
  if (masterId !== null && !onlineMasters(db).some((m) => m.id === masterId)) {
    throw badRequest('Этот мастер сейчас не принимает записи — выберите другого или «Любой мастер»');
  }
  checkRange(db, input.dateFrom, input.dateTo, input.channel, now);
  const note = input.note?.trim() || null;
  if (note && note.length > NOTE_MAX) throw badRequest(`Комментарий — не длиннее ${NOTE_MAX} символов`);
  return { items: canonicalItems(db, input.items), masterId, dateFrom: input.dateFrom, dateTo: input.dateTo, note };
}

/** The same wish of the client still open (a double submit), else null. */
function sameOpenWish(db: DbOrTx, clientId: number, wish: CheckedWish, itemsJson: string): WaitlistRow | null {
  return (
    db
      .select()
      .from(waitlistEntries)
      .where(and(eq(waitlistEntries.clientId, clientId), inArray(waitlistEntries.status, [...OPEN_WAITLIST_STATUSES])))
      .all()
      .find((e) => e.items === itemsJson && e.masterId === wish.masterId && e.dateFrom === wish.dateFrom && e.dateTo === wish.dateTo) ?? null
  );
}

/** Stores a checked wish for the client; the same open wish is returned instead of a copy (`created: false`). */
export function insertWish(
  db: DbOrTx,
  clientId: number,
  wish: CheckedWish,
  channel: WaitlistChannel,
  now: number,
): { row: WaitlistRow; created: boolean } {
  return db.transaction((tx) => {
    if (!tx.select({ id: clients.id }).from(clients).where(eq(clients.id, clientId)).get()) throw badRequest('Клиент не найден');
    const itemsJson = waitlistItemsJson(wish.items);
    const same = sameOpenWish(tx, clientId, wish, itemsJson);
    if (same) return { row: same, created: false };
    if (openEntryCount(tx, clientId) >= MAX_OPEN_PER_CLIENT) {
      throw conflict(channel === 'app' ? STAFF_LIMIT_MESSAGE : CLIENT_LIMIT_MESSAGE);
    }
    const row = tx
      .insert(waitlistEntries)
      .values({
        clientId,
        items: itemsJson,
        masterId: wish.masterId,
        dateFrom: wish.dateFrom,
        dateTo: wish.dateTo,
        status: 'waiting',
        channel,
        note: wish.note,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    return { row, created: true };
  });
}

export function getWaitlistRow(db: DbOrTx, id: number): WaitlistRow {
  const row = db.select().from(waitlistEntries).where(eq(waitlistEntries.id, id)).get();
  if (!row) throw notFound('Запись листа ожидания не найдена');
  return row;
}

/** `?status=` → statuses; `400` on an unknown one. */
export function parseStatuses(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const list = value.split(',').map((s) => s.trim()).filter(Boolean);
  const invalid = list.find((s) => !(WAITLIST_STATUSES as readonly string[]).includes(s));
  if (invalid) throw badRequest(`«Статус»: недопустимое значение «${invalid}»`);
  return list;
}

/** Oldest first: open entries and the closed ones of the last CLOSED_SHOWN_DAYS days. */
export function listWaitlist(db: DbOrTx, statuses: string[] | undefined, now = Date.now()): WaitlistRow[] {
  const recent = or(inArray(waitlistEntries.status, [...OPEN_WAITLIST_STATUSES]), gte(waitlistEntries.updatedAt, now - CLOSED_SHOWN_DAYS * DAY_MS));
  return db
    .select()
    .from(waitlistEntries)
    .where(statuses?.length ? and(inArray(waitlistEntries.status, statuses), recent) : recent)
    .orderBy(asc(waitlistEntries.createdAt), asc(waitlistEntries.id))
    .all();
}

/**
 * Cancels an open entry; an entry cancelled already is returned as is. Staff cancel any entry; the client in the
 * cabinet (`by.clientId`) only their own — somebody else's reads as not found.
 */
export function cancelWaitlistEntry(db: DbOrTx, id: number, now = Date.now(), by: { clientId?: number } = {}): WaitlistRow {
  return db.transaction((tx) => {
    const row = getWaitlistRow(tx, id);
    if (by.clientId !== undefined && row.clientId !== by.clientId) throw notFound('Запись листа ожидания не найдена');
    if (row.status === 'cancelled') return row;
    if (!isOpenStatus(row.status)) throw conflict(by.clientId !== undefined ? CLIENT_CLOSED_MESSAGE : CLOSED_MESSAGE);
    return tx.update(waitlistEntries).set({ status: 'cancelled', updatedAt: now }).where(eq(waitlistEntries.id, id)).returning().get()!;
  });
}

/** The client's open (`waiting` / `notified`) entries, oldest first. */
export function clientOpenEntries(db: DbOrTx, clientId: number): WaitlistRow[] {
  return db
    .select()
    .from(waitlistEntries)
    .where(and(eq(waitlistEntries.clientId, clientId), inArray(waitlistEntries.status, [...OPEN_WAITLIST_STATUSES])))
    .orderBy(asc(waitlistEntries.createdAt), asc(waitlistEntries.id))
    .all();
}

/** Entries whose last date is before today (studio) become `expired`; returns how many. */
export function expireWaitlist(db: DbOrTx, now = Date.now()): number {
  const today = localDate(now, getStudioSettings(db).timezone);
  return db
    .update(waitlistEntries)
    .set({ status: 'expired', updatedAt: now })
    .where(and(inArray(waitlistEntries.status, [...OPEN_WAITLIST_STATUSES]), lt(waitlistEntries.dateTo, today)))
    .run().changes;
}

/** The newest entry id, for the honeypot's look-alike answer. */
export function lastWaitlistId(db: DbOrTx): number {
  return db.select({ id: waitlistEntries.id }).from(waitlistEntries).orderBy(desc(waitlistEntries.id)).limit(1).get()?.id ?? 0;
}

// ---------- output ----------

export interface WaitlistItemOut {
  serviceId: number;
  variant: string | null;
  name: string;
}

function itemsOut(items: WaitlistItem[], names: Map<number, string>): WaitlistItemOut[] {
  return items.map((i) => ({ serviceId: i.serviceId, variant: i.variant, name: names.get(i.serviceId) ?? 'Услуга' }));
}

/** `WaitlistEntry` of each row (references loaded in batches). */
export function serializeWaitlist(db: DbOrTx, rows: WaitlistRow[]) {
  const parsed = rows.map((r) => parseWaitlistItems(r.items));
  const services = servicesByIds(db, parsed.flat().map((i) => i.serviceId));
  const names = new Map([...services.values()].map((s) => [s.id, s.name]));
  const people = clientsByIds(db, rows.map((r) => r.clientId));
  const masters = employeesByIds(db, rows.map((r) => r.masterId));
  return rows.map((r, index) => {
    const client = people.get(r.clientId);
    const master = r.masterId != null ? masters.get(r.masterId) : undefined;
    return {
      id: r.id,
      client: client
        ? clientRef(client)
        : { id: r.clientId, name: `Клиент №${r.clientId}`, lastName: null, phone: null, telegramLinked: false },
      items: itemsOut(parsed[index]!, names),
      master: master ? employeeRef(master) : null,
      dateFrom: r.dateFrom,
      dateTo: r.dateTo,
      status: r.status,
      channel: r.channel,
      notifiedAt: toIso(r.notifiedAt),
      appointmentId: r.appointmentId,
      note: r.note,
      createdAt: toIso(r.createdAt),
    };
  });
}
export type WaitlistEntryOut = ReturnType<typeof serializeWaitlist>[number];

export function serializeWaitlistEntry(db: DbOrTx, row: WaitlistRow): WaitlistEntryOut {
  return serializeWaitlist(db, [row])[0]!;
}

/**
 * `WaitlistEntryPublic` of each row: the entry without the client, and without the note of an entry staff added in
 * the app (it is theirs); the client's own words are shown.
 */
export function publicWaitlistEntries(db: DbOrTx, rows: WaitlistRow[]) {
  return serializeWaitlist(db, rows).map(({ client: _client, ...rest }) => ({ ...rest, note: rest.channel === 'app' ? null : rest.note }));
}
export type WaitlistEntryPublic = ReturnType<typeof publicWaitlistEntries>[number];

export function publicWaitlistEntry(db: DbOrTx, row: WaitlistRow): WaitlistEntryPublic {
  return publicWaitlistEntries(db, [row])[0]!;
}
