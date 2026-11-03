import { and, eq, gte, inArray, isNull, lte, or } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { clients, employees, waitlistEntries } from '../db/schema.js';
import { clientFullName, type AppointmentRow } from '../lib/serialize.js';
import { localDate } from '../lib/time.js';
import { writeAudit } from './audit.js';
import { bookingDates } from './online-booking-slots.js';
import { getStudioSettings } from './settings.js';
import { datesBetween, scheduleDaysFor, workingIntervals, type Interval } from './work-schedule.js';
import {
  OPEN_WAITLIST_STATUSES,
  openEntriesOn,
  parseWaitlistItems,
  queueFreedTime,
  type FreedPiece,
} from './waitlist-store.js';

/**
 * Where the rest of the server touches the waitlist (docs/API.md «Waitlist»): an appointment change that frees time
 * and a schedule write that adds working time queue the freed time (checked within a minute by
 * domain/waitlist-matcher.ts); a new appointment of a waiting client closes the matching entries. Everything here is
 * synchronous and runs inside the caller's transaction.
 */

const INACTIVE = ['cancelled', 'no_show'];
const noop = (): void => undefined;

/** Called by `updateAppointment`: a cancellation, no-show or move frees the appointment's old time. */
export function noteFreedTime(db: DbOrTx, before: AppointmentRow, after: AppointmentRow, now = Date.now()): void {
  if (INACTIVE.includes(before.status) || before.status === 'completed') return;
  const closed = INACTIVE.includes(after.status);
  const moved = after.startsAt !== before.startsAt || after.endsAt !== before.endsAt || after.masterId !== before.masterId;
  if (!closed && !moved) return;
  const start = Math.max(before.startsAt, now);
  if (before.endsAt <= start) return;
  const date = localDate(before.startsAt, getStudioSettings(db).timezone);
  if (openEntriesOn(db, date, before.masterId).length === 0) return;
  queueFreedTime(db, [{ masterId: before.masterId, date, start, end: before.endsAt }]);
}

/** The parts of `after` that no interval of `before` covers (working time a schedule change added). */
export function addedIntervals(after: Interval[], before: Interval[]): Interval[] {
  const cut = (piece: Interval, taken: Interval): Interval[] => {
    if (taken.end <= piece.start || taken.start >= piece.end) return [piece];
    return [
      ...(taken.start > piece.start ? [{ start: piece.start, end: taken.start }] : []),
      ...(taken.end < piece.end ? [{ start: taken.end, end: piece.end }] : []),
    ];
  };
  return after.flatMap((interval) => before.reduce<Interval[]>((pieces, taken) => pieces.flatMap((p) => cut(p, taken)), [interval]));
}

/** Bookable dates (today … the online horizon) that some open entry for this master (or «any») covers. */
function wantedDates(db: DbOrTx, masterId: number, now: number): string[] {
  const { first, last } = bookingDates(db, now);
  const ranges = db
    .select({ from: waitlistEntries.dateFrom, to: waitlistEntries.dateTo })
    .from(waitlistEntries)
    .where(
      and(
        inArray(waitlistEntries.status, [...OPEN_WAITLIST_STATUSES]),
        lte(waitlistEntries.dateFrom, last),
        gte(waitlistEntries.dateTo, first),
        or(isNull(waitlistEntries.masterId), eq(waitlistEntries.masterId, masterId)),
      ),
    )
    .all();
  const dates = new Set<string>();
  for (const r of ranges) {
    for (const date of datesBetween(r.from < first ? first : r.from, r.to > last ? last : r.to)) dates.add(date);
  }
  return [...dates].sort();
}

/**
 * Around a work schedule write: call before writing, then call the returned function after it. Working time the write
 * added on dates the waitlist wants is queued as freed time.
 */
export function trackWorkingTime(db: DbOrTx, employeeId: number, now = Date.now()): () => void {
  const load = () => db.select().from(employees).where(eq(employees.id, employeeId)).get();
  const master = load();
  if (!master || !master.active || !master.isMaster) return noop;
  const dates = wantedDates(db, employeeId, now);
  if (dates.length === 0) return noop;
  const tz = getStudioSettings(db).timezone;
  const before = new Map(scheduleDaysFor(db, [master], dates).map((day) => [day.date, workingIntervals(day, tz)]));
  return () => {
    const fresh = load();
    if (!fresh) return;
    const pieces = scheduleDaysFor(db, [fresh], dates).flatMap((day): FreedPiece[] =>
      addedIntervals(workingIntervals(day, tz), before.get(day.date) ?? [])
        .map((i) => ({ masterId: employeeId, date: day.date, start: Math.max(i.start, now), end: i.end }))
        .filter((p) => p.end > p.start),
    );
    queueFreedTime(db, pieces);
  };
}

/**
 * Called by `createAppointment`: an appointment of the client inside an open entry's range, with its master (when one
 * was chosen) and one of its services, books the entry.
 */
export function markWaitlistBooked(db: DbOrTx, a: AppointmentRow, serviceIds: Array<number | null>, now = Date.now()): void {
  if (INACTIVE.includes(a.status)) return;
  const ids = new Set(serviceIds.filter((id): id is number => id != null));
  if (ids.size === 0) return;
  const date = localDate(a.startsAt, getStudioSettings(db).timezone);
  const matching = db
    .select()
    .from(waitlistEntries)
    .where(
      and(
        eq(waitlistEntries.clientId, a.clientId),
        inArray(waitlistEntries.status, [...OPEN_WAITLIST_STATUSES]),
        lte(waitlistEntries.dateFrom, date),
        gte(waitlistEntries.dateTo, date),
        or(isNull(waitlistEntries.masterId), eq(waitlistEntries.masterId, a.masterId)),
      ),
    )
    .all()
    .filter((entry) => parseWaitlistItems(entry.items).some((item) => ids.has(item.serviceId)));
  if (matching.length === 0) return;
  const client = db.select().from(clients).where(eq(clients.id, a.clientId)).get();
  const who = client ? clientFullName(client) : `клиент №${a.clientId}`;
  for (const entry of matching) {
    db.update(waitlistEntries)
      .set({ status: 'booked', appointmentId: a.id, updatedAt: now })
      .where(eq(waitlistEntries.id, entry.id))
      .run();
    writeAudit(db, {
      source: 'system',
      employeeId: null,
      action: 'waitlist.book',
      entity: 'waitlist',
      entityId: entry.id,
      summary: `Лист ожидания №${entry.id} (${who}) закрыт записью №${a.id}`,
      changes: { status: { from: entry.status, to: 'booked' }, appointmentId: { from: null, to: a.id } },
    });
  }
}
