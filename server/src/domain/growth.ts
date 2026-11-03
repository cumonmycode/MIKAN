import { and, count, gte, lt, ne } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { appointments, bookingRequests } from '../db/schema.js';
import { toIso } from '../lib/time.js';
import { clientHistories, newcomersOf, retentionSection, sourcesSection, valueSection } from './growth-clients.js';
import { loadSection } from './growth-load.js';
import { ONLINE_CHANNELS } from './online-booking.js';
import { CLIENT_CANCELLED_NOTE, NOT_PAID_NOTE, REJECTED_NOTE } from './online-booking-lifecycle.js';
import { studioTimezone } from './settings.js';

/**
 * `GET /reports/growth`: how the studio grows over [from, to) — the booking funnel, master load against work
 * schedules, retention and cohorts, client value and sources. See docs/API.md «Reports» for every field.
 */

const APPOINTMENT_CHANNELS = ['app', ...ONLINE_CHANNELS];
const OPEN_STATUSES = new Set(['scheduled', 'confirmed']);

export type OnlineOutcome = 'awaiting' | 'confirmed' | 'rejected' | 'expired' | 'cancelledByClient';

/**
 * What became of an online booking. Open and still unsettled → `awaiting`. A cancelled one is `expired` (its hold ran
 * out unpaid), `cancelledByClient` (on the booking page) or `rejected` (by staff: rejected, or cancelled while it
 * still waited) by the note the server added; everything else got past the online stage — `confirmed`, whatever
 * happened to the visit afterwards.
 */
export function onlineOutcome(a: { status: string; onlineState: string | null; notes: string | null }): OnlineOutcome {
  if (OPEN_STATUSES.has(a.status)) return a.onlineState != null ? 'awaiting' : 'confirmed';
  if (a.status !== 'cancelled') return 'confirmed';
  const lines = (a.notes ?? '').split('\n').map((line) => line.trim());
  const noted = (marker: string) => lines.some((line) => line.startsWith(marker));
  if (noted(NOT_PAID_NOTE)) return 'expired';
  if (noted(CLIENT_CANCELLED_NOTE)) return 'cancelledByClient';
  if (noted(REJECTED_NOTE) || a.onlineState != null) return 'rejected';
  return 'confirmed';
}

/** Counts per key: every known key present (zeros included), unknown ones added as they come. */
function tally(known: readonly string[], keys: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries(known.map((k) => [k, 0]));
  for (const key of keys) counts[key] = (counts[key] ?? 0) + 1;
  return counts;
}

function bookingRequestsFunnel(db: DbOrTx, from: number, to: number) {
  const rows = db
    .select({ status: bookingRequests.status, n: count() })
    .from(bookingRequests)
    .where(and(gte(bookingRequests.createdAt, from), lt(bookingRequests.createdAt, to)))
    .groupBy(bookingRequests.status)
    .all();
  const of = (status: string) => rows.find((r) => r.status === status)?.n ?? 0;
  return { created: rows.reduce((s, r) => s + r.n, 0), processed: of('processed'), rejected: of('rejected'), open: of('new') };
}

function onlineFunnel(db: DbOrTx, from: number, to: number) {
  const rows = db
    .select({ channel: appointments.channel, status: appointments.status, onlineState: appointments.onlineState, notes: appointments.notes })
    .from(appointments)
    .where(and(gte(appointments.createdAt, from), lt(appointments.createdAt, to), ne(appointments.channel, 'app')))
    .all();
  const outcomes = rows.map(onlineOutcome);
  const of = (outcome: OnlineOutcome) => outcomes.filter((o) => o === outcome).length;
  return {
    created: rows.length,
    byChannel: tally(ONLINE_CHANNELS, rows.map((r) => r.channel)),
    confirmed: of('confirmed'),
    rejected: of('rejected'),
    expired: of('expired'),
    cancelledByClient: of('cancelledByClient'),
    completed: rows.filter((r) => r.status === 'completed').length,
    awaiting: of('awaiting'),
  };
}

function appointmentsFunnel(db: DbOrTx, from: number, to: number) {
  const rows = db
    .select({ channel: appointments.channel, status: appointments.status, n: count() })
    .from(appointments)
    .where(and(gte(appointments.createdAt, from), lt(appointments.createdAt, to)))
    .groupBy(appointments.channel, appointments.status)
    .all();
  const byChannel = tally(APPOINTMENT_CHANNELS, []);
  for (const r of rows) byChannel[r.channel] = (byChannel[r.channel] ?? 0) + r.n;
  const of = (status: string) => rows.filter((r) => r.status === status).reduce((s, r) => s + r.n, 0);
  return {
    created: rows.reduce((s, r) => s + r.n, 0),
    byChannel,
    completed: of('completed'),
    cancelled: of('cancelled'),
    noShow: of('no_show'),
  };
}

export function reportGrowth(db: DbOrTx, from: number, to: number) {
  const tz = studioTimezone(db);
  const histories = clientHistories(db, to, tz);
  const newcomers = newcomersOf(histories, from, to);
  return {
    from: toIso(from),
    to: toIso(to),
    funnel: {
      bookingRequests: bookingRequestsFunnel(db, from, to),
      online: onlineFunnel(db, from, to),
      appointments: appointmentsFunnel(db, from, to),
    },
    load: loadSection(db, from, to, tz),
    retention: retentionSection(histories, newcomers, from, to, tz),
    value: valueSection(db, histories, to),
    sources: sourcesSection(db, newcomers, from, to),
  };
}
