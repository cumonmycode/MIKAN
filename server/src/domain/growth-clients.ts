import { and, asc, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import type { DbOrTx } from '../db/client.js';
import { appointments, clients, sales } from '../db/schema.js';
import { DAY_MS, localDate } from '../lib/time.js';
import { saleKeptRevenueSql } from './sale-revenue.js';

/**
 * `retention`, `value` and `sources` of the growth report (docs/API.md «Reports»). A visit is a completed appointment;
 * a client's first visit makes them a new client of that month. Days between visits are studio-local calendar days.
 */

const RETURN_WINDOW_DAYS = 90;
const COHORT_MONTHS = 12;
const COHORT_WINDOWS = [30, 90, 180] as const;
const TOP_SHARE = 0.1;
const NO_SOURCE = 'не указан';
/** Ids per `in (…)` query: well inside SQLite's parameter limit. */
const ID_CHUNK = 500;

/** One studio-local day with visits: its day number (days since 1970-01-01) and the first visit's start. */
interface VisitDay {
  day: number;
  at: number;
}

export interface ClientHistory {
  clientId: number;
  /** Distinct visit days, oldest first (never empty). */
  days: VisitDay[];
  /** "YYYY-MM" of the first visit, studio time. */
  firstMonth: string;
  /** Days from the first visit to the next one on a later day; null while there is none. */
  returnAfterDays: number | null;
  /** Visits (completed appointments) starting before `to`. */
  visitsBeforeTo: number;
}

const round1 = (x: number): number => Math.round(x * 10) / 10;
const dayNumber = (date: string): number => Math.round(Date.parse(`${date}T00:00:00Z`) / DAY_MS);

/** Every client's completed visits (all of them: returns are counted up to now). */
export function clientHistories(db: DbOrTx, to: number, tz: string): ClientHistory[] {
  const rows = db
    .select({ clientId: appointments.clientId, startsAt: appointments.startsAt })
    .from(appointments)
    .where(eq(appointments.status, 'completed'))
    .orderBy(asc(appointments.clientId), asc(appointments.startsAt))
    .all();
  const byClient = new Map<number, Array<{ startsAt: number; date: string }>>();
  for (const row of rows) {
    const list = byClient.get(row.clientId) ?? [];
    list.push({ startsAt: row.startsAt, date: localDate(row.startsAt, tz) });
    byClient.set(row.clientId, list);
  }
  return [...byClient.entries()].map(([clientId, visits]) => {
    const days: VisitDay[] = [];
    for (const v of visits) {
      const day = dayNumber(v.date);
      if (days.at(-1)?.day !== day) days.push({ day, at: v.startsAt });
    }
    const [first, second] = days;
    return {
      clientId,
      days,
      firstMonth: visits[0]!.date.slice(0, 7),
      returnAfterDays: first && second ? second.day - first.day : null,
      visitsBeforeTo: visits.filter((v) => v.startsAt < to).length,
    };
  });
}

const returnedWithin = (h: ClientHistory, days: number): boolean => h.returnAfterDays !== null && h.returnAfterDays <= days;

/** "YYYY-MM" of the 12 studio months up to `to` (the month of its last instant), oldest first. */
function cohortMonths(to: number, tz: string): string[] {
  const last = DateTime.fromMillis(to - 1, { zone: tz }).startOf('month');
  return Array.from({ length: COHORT_MONTHS }, (_, i) => last.minus({ months: COHORT_MONTHS - 1 - i }).toFormat('yyyy-MM'));
}

/** Mean gap in days between a visit of the period and the same client's previous visit day; null without any. */
function averageGap(histories: ClientHistory[], from: number, to: number): number | null {
  const gaps = histories.flatMap((h) =>
    h.days.flatMap((visit, i) => {
      const previous = h.days[i - 1];
      return previous && visit.at >= from && visit.at < to ? [visit.day - previous.day] : [];
    }),
  );
  return gaps.length ? Math.round(gaps.reduce((s, g) => s + g, 0) / gaps.length) : null;
}

/** The clients whose first visit falls in [from, to). */
export const newcomersOf = (histories: ClientHistory[], from: number, to: number): ClientHistory[] =>
  histories.filter((h) => h.days[0]!.at >= from && h.days[0]!.at < to);

export function retentionSection(histories: ClientHistory[], newcomers: ClientHistory[], from: number, to: number, tz: string) {
  const returned = newcomers.filter((h) => returnedWithin(h, RETURN_WINDOW_DAYS)).length;
  const [w30, w90, w180] = COHORT_WINDOWS;
  return {
    newClients: newcomers.length,
    returnedWithin90Days: returned,
    repeatRatePercent: newcomers.length ? round1((returned * 100) / newcomers.length) : null,
    averageDaysBetweenVisits: averageGap(histories, from, to),
    cohorts: cohortMonths(to, tz).map((month) => {
      const members = histories.filter((h) => h.firstMonth === month);
      const count = (days: number) => members.filter((h) => returnedWithin(h, days)).length;
      return { month, clients: members.length, returned30: count(w30), returned90: count(w90), returned180: count(w180) };
    }),
  };
}

/** Kept revenue (what refunds left of it) of the sales of each client made in [from, to) and not returned in full. */
function revenueByClient(db: DbOrTx, from: number | null, to: number): Map<number, number> {
  const rows = db
    .select({ clientId: sales.clientId, revenue: sql<number>`coalesce(sum(${saleKeptRevenueSql}), 0)` })
    .from(sales)
    .where(
      and(
        eq(sales.status, 'completed'),
        isNotNull(sales.clientId),
        lt(sales.createdAt, to),
        ...(from === null ? [] : [gte(sales.createdAt, from)]),
      ),
    )
    .groupBy(sales.clientId)
    .all();
  return new Map(rows.flatMap((r) => (r.clientId === null ? [] : [[r.clientId, r.revenue] as const])));
}

/** Over all time up to `to`: clients with a visit or a kept sale, their revenue and visits, the top 10 % share. */
export function valueSection(db: DbOrTx, histories: ClientHistory[], to: number) {
  const revenue = revenueByClient(db, null, to);
  const visits = new Map(histories.filter((h) => h.visitsBeforeTo > 0).map((h) => [h.clientId, h.visitsBeforeTo]));
  const ids = new Set([...revenue.keys(), ...visits.keys()]);
  const revenues = [...ids].map((id) => revenue.get(id) ?? 0).sort((a, b) => b - a);
  const total = revenues.reduce((s, r) => s + r, 0);
  const totalVisits = [...visits.values()].reduce((s, v) => s + v, 0);
  const top = revenues.slice(0, Math.ceil(ids.size * TOP_SHARE)).reduce((s, r) => s + r, 0);
  return {
    clientsWithVisits: ids.size,
    averageRevenuePerClient: ids.size ? Math.round(total / ids.size) : 0,
    averageVisitsPerClient: ids.size ? round1(totalVisits / ids.size) : 0,
    top10PercentShare: total > 0 ? round1((top * 100) / total) : null,
  };
}

const sourceKey = (source: string | null): string => source?.trim().toLowerCase() || NO_SOURCE;

function sourcesOf(db: DbOrTx, ids: number[]): Map<number, string | null> {
  const result = new Map<number, string | null>();
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const rows = db
      .select({ id: clients.id, source: clients.source })
      .from(clients)
      .where(inArray(clients.id, ids.slice(i, i + ID_CHUNK)))
      .all();
    for (const row of rows) result.set(row.id, row.source);
  }
  return result;
}

/** The new clients of the period by their card's source, with the revenue of their kept sales made in it. */
export function sourcesSection(db: DbOrTx, newcomers: ClientHistory[], from: number, to: number) {
  const ids = newcomers.map((h) => h.clientId);
  const cards = sourcesOf(db, ids);
  const revenue = revenueByClient(db, from, to);
  const groups = new Map<string, { source: string; newClients: number; revenue: number }>();
  for (const id of ids) {
    const source = sourceKey(cards.get(id) ?? null);
    const group = groups.get(source) ?? { source, newClients: 0, revenue: 0 };
    groups.set(source, { source, newClients: group.newClients + 1, revenue: group.revenue + (revenue.get(id) ?? 0) });
  }
  return [...groups.values()].sort((a, b) => b.newClients - a.newClients || b.revenue - a.revenue || a.source.localeCompare(b.source, 'ru'));
}
