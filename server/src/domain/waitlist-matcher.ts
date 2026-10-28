import { and, eq, inArray } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { waitlistEntries } from '../db/schema.js';
import { errorMessage } from '../lib/errors.js';
import type { ClientRow, EmployeeRow } from '../lib/serialize.js';
import { DAY_MS, MINUTE_MS } from '../lib/time.js';
import { resolveItems } from './online-booking-items.js';
import { deliverToChat } from './online-booking-messages.js';
import { availableStarts, bookingDates, onlineMasters } from './online-booking-slots.js';
import { clientsByIds } from './refs.js';
import { getStudioSettings } from './settings.js';
import { auditNotified } from './waitlist-audit.js';
import { freedTimeMessage } from './waitlist-messages.js';
import {
  isOpenStatus,
  OPEN_WAITLIST_STATUSES,
  openEntriesOn,
  parseWaitlistItems,
  takeFreedTime,
  type FreedPiece,
  type WaitlistRow,
} from './waitlist-store.js';

/**
 * Freed time → the waitlist (docs/API.md «Waitlist» → «Freed time»): every minute the queued pieces of freed time are
 * offered to the oldest open entries that fit them, at most 3 per piece, each entry at most once a day, only to
 * clients with a linked Telegram chat. Whoever books first gets the time.
 */

/** How often the queue is checked (index.ts). */
export const FREED_CHECK_INTERVAL_MS = 60_000;
/** Entries told about one piece of freed time. */
export const MAX_TOLD_PER_PIECE = 3;
/** An entry is told at most once in this long. */
export const TELL_GAP_MS = DAY_MS;
/** How often entries past their range are expired (index.ts). */
export const WAITLIST_EXPIRY_INTERVAL_MS = 60 * MINUTE_MS;

const toldRecently = (row: WaitlistRow, now: number) => row.notifiedAt != null && row.notifiedAt > now - TELL_GAP_MS;

/** The first free start of the piece's master that day for the entry's items, overlapping the freed interval. */
export function fittingStart(ctx: AppContext, row: WaitlistRow, piece: FreedPiece, now: number): number | null {
  let durationMin: number;
  try {
    durationMin = resolveItems(ctx.db, parseWaitlistItems(row.items)).durationMin;
  } catch {
    // A service went out of the catalog: nothing can be booked for this wish.
    return null;
  }
  const starts = availableStarts(ctx.db, { date: piece.date, durationMin, masterId: piece.masterId, now });
  const hit = starts.find((s) => s.startsAt < piece.end && s.startsAt + durationMin * MINUTE_MS > piece.start);
  return hit?.startsAt ?? null;
}

/** Tells one entry; marks it `notified` only when the message went out. */
async function tell(ctx: AppContext, row: WaitlistRow, client: ClientRow, master: EmployeeRow, start: number, now: number): Promise<boolean> {
  const message = freedTimeMessage(ctx.db, ctx.config, row, master, start, now);
  if (!(await deliverToChat(ctx, client.telegramChatId!, message))) return false;
  const told = ctx.db
    .update(waitlistEntries)
    .set({ status: 'notified', notifiedAt: now, updatedAt: now })
    .where(and(eq(waitlistEntries.id, row.id), inArray(waitlistEntries.status, [...OPEN_WAITLIST_STATUSES])))
    .returning()
    .get();
  if (told) auditNotified(ctx, told, client, master, start, getStudioSettings(ctx.db).timezone);
  return true;
}

/** Offers one piece of freed time; returns how many entries were told. */
async function offerPiece(ctx: AppContext, piece: FreedPiece, now: number): Promise<number> {
  const master = onlineMasters(ctx.db).find((m) => m.id === piece.masterId);
  if (!master) return 0;
  const entries = openEntriesOn(ctx.db, piece.date, piece.masterId).filter((row) => !toldRecently(row, now));
  const people = clientsByIds(ctx.db, entries.map((e) => e.clientId));
  let told = 0;
  for (const row of entries) {
    if (told >= MAX_TOLD_PER_PIECE) break;
    const client = people.get(row.clientId);
    if (!client || client.telegramChatId == null || !client.botEnabled) continue;
    // Told about an earlier piece in this run (the rows were read before that).
    const fresh = ctx.db.select().from(waitlistEntries).where(eq(waitlistEntries.id, row.id)).get();
    if (!fresh || !isOpenStatus(fresh.status) || toldRecently(fresh, now)) continue;
    const start = fittingStart(ctx, fresh, piece, now);
    if (start === null) continue;
    if (await tell(ctx, fresh, client, master, start, now)) told += 1;
  }
  return told;
}

/**
 * The background check: takes the queued freed time and offers it. Nothing is sent while online booking is off (the
 * queue is dropped: the button could not be used) or while the bot does not run (the queue waits). Returns how many
 * entries were told.
 */
export async function offerFreedTime(ctx: AppContext, now = Date.now()): Promise<number> {
  const { db } = ctx;
  if (!getStudioSettings(db).onlineBooking.enabled) {
    takeFreedTime(db);
    return 0;
  }
  if (!ctx.gateway.isRunning()) return 0;
  const { first, last } = bookingDates(db, now);
  let told = 0;
  for (const piece of takeFreedTime(db)) {
    if (piece.end <= now || piece.date < first || piece.date > last) continue;
    try {
      told += await offerPiece(ctx, piece, now);
    } catch (err) {
      ctx.log.error({ piece, err: errorMessage(err) }, 'waitlist: freed time check failed');
    }
  }
  return told;
}
