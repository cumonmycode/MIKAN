import { and, asc, count, eq, gte, inArray, isNull, lte, or } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { waitlistEntries } from '../db/schema.js';
import { readWaitlistFreed, writeWaitlistFreed } from './settings.js';

/**
 * The waitlist's rows and the queue of freed time (docs/API.md «Waitlist»). Kept free of the appointment and online
 * booking modules: domain/appointments.ts reaches the waitlist through domain/waitlist-hooks.ts, which builds on this.
 */

export const WAITLIST_STATUSES = ['waiting', 'notified', 'booked', 'cancelled', 'expired'] as const;
export type WaitlistStatus = (typeof WAITLIST_STATUSES)[number];
/** Entries still waiting for a time (told about freed time or not yet). */
export const OPEN_WAITLIST_STATUSES: readonly WaitlistStatus[] = ['waiting', 'notified'];
export const WAITLIST_CHANNELS = ['app', 'bot', 'miniapp', 'web'] as const;
export type WaitlistChannel = (typeof WAITLIST_CHANNELS)[number];

export type WaitlistRow = typeof waitlistEntries.$inferSelect;

/** One wished service as stored in `items`. */
export interface WaitlistItem {
  serviceId: number;
  variant: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The stored `items` JSON; malformed parts are skipped. */
export function parseWaitlistItems(json: string): WaitlistItem[] {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw): WaitlistItem[] => {
    if (!isRecord(raw) || !Number.isSafeInteger(raw.serviceId) || (raw.serviceId as number) <= 0) return [];
    const variant = typeof raw.variant === 'string' && raw.variant.trim() ? raw.variant : null;
    return [{ serviceId: raw.serviceId as number, variant }];
  });
}

/** `[{ serviceId, variant? }]` — the same wish always gives the same text (duplicates are found by it). */
export function waitlistItemsJson(items: WaitlistItem[]): string {
  return JSON.stringify(items.map((i) => (i.variant ? { serviceId: i.serviceId, variant: i.variant } : { serviceId: i.serviceId })));
}

export const isOpenStatus = (status: string): boolean => (OPEN_WAITLIST_STATUSES as readonly string[]).includes(status);

/** Open entries whose range covers `date` and whose master is `masterId` or «any», oldest first. */
export function openEntriesOn(db: DbOrTx, date: string, masterId: number): WaitlistRow[] {
  return db
    .select()
    .from(waitlistEntries)
    .where(
      and(
        inArray(waitlistEntries.status, [...OPEN_WAITLIST_STATUSES]),
        lte(waitlistEntries.dateFrom, date),
        gte(waitlistEntries.dateTo, date),
        or(isNull(waitlistEntries.masterId), eq(waitlistEntries.masterId, masterId)),
      ),
    )
    .orderBy(asc(waitlistEntries.createdAt), asc(waitlistEntries.id))
    .all();
}

/** Open entries of every client (the `waitlist` badge), or of one. */
export function openEntryCount(db: DbOrTx, clientId?: number): number {
  const conditions = [inArray(waitlistEntries.status, [...OPEN_WAITLIST_STATUSES])];
  if (clientId !== undefined) conditions.push(eq(waitlistEntries.clientId, clientId));
  return db.select({ n: count() }).from(waitlistEntries).where(and(...conditions)).get()?.n ?? 0;
}

// ---------- the queue of freed time ----------

/** A master's time freed on a studio-local date: an appointment's old time or working time a schedule added. */
export interface FreedPiece {
  masterId: number;
  date: string;
  start: number;
  end: number;
}

/** The queue never grows past this (the oldest pieces go first): the check runs every minute. */
export const MAX_QUEUED_PIECES = 200;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function asPiece(raw: unknown): FreedPiece | null {
  if (!isRecord(raw)) return null;
  const { masterId, date, start, end } = raw;
  if (!Number.isSafeInteger(masterId) || typeof date !== 'string' || !DATE.test(date)) return null;
  if (typeof start !== 'number' || typeof end !== 'number' || !(end > start)) return null;
  return { masterId: masterId as number, date, start, end };
}

export function queuedFreedTime(db: DbOrTx): FreedPiece[] {
  const value = readWaitlistFreed(db);
  return Array.isArray(value) ? value.map(asPiece).filter((p): p is FreedPiece => p !== null) : [];
}

const sameKey = (a: FreedPiece, b: FreedPiece) => a.masterId === b.masterId && a.date === b.date && a.start === b.start && a.end === b.end;

/** Adds pieces to the queue (inside the caller's transaction), without repeats. */
export function queueFreedTime(db: DbOrTx, pieces: FreedPiece[]): void {
  if (pieces.length === 0) return;
  const queue = queuedFreedTime(db);
  for (const piece of pieces) if (!queue.some((q) => sameKey(q, piece))) queue.push(piece);
  writeWaitlistFreed(db, queue.slice(-MAX_QUEUED_PIECES));
}

/** Takes the whole queue, leaving it empty. */
export function takeFreedTime(db: DbOrTx): FreedPiece[] {
  return db.transaction((tx) => {
    const queue = queuedFreedTime(tx);
    if (queue.length > 0) writeWaitlistFreed(tx, []);
    return queue;
  });
}
