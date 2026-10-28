import { sql, type SQL } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { z } from 'zod';
import type { DbOrTx } from '../db/client.js';
import { clientRef, type ClientRef } from '../lib/serialize.js';
import { DAY_MS } from '../lib/time.js';
import { hasBonusBalanceSql } from './bonuses.js';
import { SERVICE_CATEGORIES } from './categories.js';
import { clientsByIds } from './refs.js';

/**
 * Who a campaign goes to (docs/API.md «Campaigns»): clients the bot may send news to, narrowed by a segment. One SQL
 * query per question (count, sample, the recipients fixed when sending starts) over completed appointments, their
 * service lines and the bonus ledger.
 */

/** A segment as stored and shown: every condition, `null` = not used. */
export interface CampaignSegment {
  /** The last completed visit was at least this many months ago. */
  lastVisitMonthsAgoMin: number | null;
  /** … and at most this many months ago. */
  lastVisitMonthsAgoMax: number | null;
  /** Only `true` filters: no completed visit at all. */
  neverVisited: boolean | null;
  /** Had a completed visit with a service of one of these categories. */
  categories: string[] | null;
  /** Had a completed visit with one of these masters. */
  masterIds: number[] | null;
  minVisits: number | null;
  /** 1…12 */
  birthdayMonth: number | null;
  /** Only `true` filters: holds bonuses that have not burnt. */
  hasBonuses: boolean | null;
  createdWithinDays: number | null;
}

export const EMPTY_SEGMENT: CampaignSegment = {
  lastVisitMonthsAgoMin: null,
  lastVisitMonthsAgoMax: null,
  neverVisited: null,
  categories: null,
  masterIds: null,
  minVisits: null,
  birthdayMonth: null,
  hasBonuses: null,
  createdWithinDays: null,
};

const months = (min: number) => z.number().int().min(min).max(120).nullish();

export const segmentSchema = z
  .object({
    lastVisitMonthsAgoMin: months(0),
    lastVisitMonthsAgoMax: months(1),
    neverVisited: z.boolean().nullish(),
    categories: z.array(z.enum(SERVICE_CATEGORIES)).max(SERVICE_CATEGORIES.length).nullish(),
    masterIds: z.array(z.number().int().positive()).max(50).nullish(),
    minVisits: z.number().int().min(1).max(1000).nullish(),
    birthdayMonth: z.number().int().min(1).max(12).nullish(),
    hasBonuses: z.boolean().nullish(),
    createdWithinDays: z.number().int().min(1).max(3650).nullish(),
  })
  .superRefine((s, ctx) => {
    if (s.lastVisitMonthsAgoMin != null && s.lastVisitMonthsAgoMax != null && s.lastVisitMonthsAgoMin > s.lastVisitMonthsAgoMax) {
      ctx.addIssue({ code: 'custom', path: ['lastVisitMonthsAgoMax'], message: 'должно быть не меньше, чем «от»' });
    }
  })
  .transform((s): CampaignSegment => normalizeSegment(s));

/** Missing keys and empty lists become `null`; duplicates in lists are dropped. */
export function normalizeSegment(input: Partial<Record<keyof CampaignSegment, unknown>>): CampaignSegment {
  const list = <T>(value: unknown): T[] | null => (Array.isArray(value) && value.length ? [...new Set(value as T[])] : null);
  const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  const flag = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);
  return {
    lastVisitMonthsAgoMin: num(input.lastVisitMonthsAgoMin),
    lastVisitMonthsAgoMax: num(input.lastVisitMonthsAgoMax),
    neverVisited: flag(input.neverVisited),
    categories: list<string>(input.categories),
    masterIds: list<number>(input.masterIds),
    minVisits: num(input.minVisits),
    birthdayMonth: num(input.birthdayMonth),
    hasBonuses: flag(input.hasBonuses),
    createdWithinDays: num(input.createdWithinDays),
  };
}

/** The stored JSON; anything unreadable counts as no condition. */
export function parseStoredSegment(json: string): CampaignSegment {
  try {
    const value: unknown = JSON.parse(json);
    return value !== null && typeof value === 'object' ? normalizeSegment(value as Record<string, unknown>) : EMPTY_SEGMENT;
  } catch {
    return EMPTY_SEGMENT;
  }
}

/**
 * Clients (`c`) the bot may send news and offers to: a linked Telegram chat, the bot allowed, not opted out, not
 * archived. Shared by campaigns, birthday greetings and win-back messages.
 */
export const MARKETING_AUDIENCE: SQL = sql`c.telegram_chat_id is not null and c.bot_enabled = 1 and c.marketing_opt_out = 0 and c.archived = 0`;

/** Completed visits per client (`v`): their count and the start of the last one. */
const VISITS: SQL = sql`(select client_id, count(*) as visits, max(starts_at) as last_visit
  from appointments where status = 'completed' group by client_id)`;

const listOf = <T>(values: T[]): SQL => sql.join(values.map((v) => sql`${v}`), sql`, `);
const monthsAgo = (now: number, tz: string, n: number) => DateTime.fromMillis(now, { zone: tz }).minus({ months: n }).toMillis();

function conditions(segment: CampaignSegment, now: number, tz: string): SQL[] {
  const where: SQL[] = [MARKETING_AUDIENCE];
  const s = segment;
  if (s.lastVisitMonthsAgoMin != null) where.push(sql`v.last_visit <= ${monthsAgo(now, tz, s.lastVisitMonthsAgoMin)}`);
  if (s.lastVisitMonthsAgoMax != null) where.push(sql`v.last_visit >= ${monthsAgo(now, tz, s.lastVisitMonthsAgoMax)}`);
  if (s.neverVisited === true) where.push(sql`v.client_id is null`);
  if (s.minVisits != null) where.push(sql`coalesce(v.visits, 0) >= ${s.minVisits}`);
  if (s.categories) {
    where.push(sql`exists (select 1 from appointments a
      join appointment_services l on l.appointment_id = a.id
      join services sv on sv.id = l.service_id
      where a.client_id = c.id and a.status = 'completed' and sv.category in (${listOf(s.categories)}))`);
  }
  if (s.masterIds) {
    where.push(sql`exists (select 1 from appointments a
      where a.client_id = c.id and a.status = 'completed' and a.master_id in (${listOf(s.masterIds)}))`);
  }
  if (s.birthdayMonth != null) where.push(sql`substr(c.birthday, 6, 2) = ${String(s.birthdayMonth).padStart(2, '0')}`);
  // The bonus module's own definition: a balance above 0 right now.
  if (s.hasBonuses === true) where.push(hasBonusBalanceSql(sql`c.id`, now));
  if (s.createdWithinDays != null) where.push(sql`c.created_at >= ${now - s.createdWithinDays * DAY_MS}`);
  return where;
}

/** `from … where …` of the segment's clients (`c`). */
function fromWhere(segment: CampaignSegment, now: number, tz: string): SQL {
  return sql`from clients c left join ${VISITS} v on v.client_id = c.id where ${sql.join(conditions(segment, now, tz), sql` and `)}`;
}

export function segmentCount(db: DbOrTx, segment: CampaignSegment, now: number, tz: string): number {
  return db.get<{ n: number }>(sql`select count(*) as n ${fromWhere(segment, now, tz)}`)?.n ?? 0;
}

/** `POST /campaigns/preview`: how many clients get it and the first few by name. */
export function previewSegment(
  db: DbOrTx,
  segment: CampaignSegment,
  now: number,
  tz: string,
  sampleSize = 5,
): { count: number; sample: ClientRef[] } {
  const ids = db
    .all<{ id: number }>(sql`select c.id as id ${fromWhere(segment, now, tz)} order by c.name_sort, c.id limit ${sampleSize}`)
    .map((r) => r.id);
  const rows = clientsByIds(db, ids);
  return {
    count: segmentCount(db, segment, now, tz),
    sample: ids.map((id) => rows.get(id)).filter((c) => c !== undefined).map(clientRef),
  };
}

/** Fixes the recipients of a campaign as `pending`, in name order; returns how many. */
export function insertRecipients(db: DbOrTx, campaignId: number, segment: CampaignSegment, now: number, tz: string): number {
  return db.run(
    sql`insert into campaign_recipients (campaign_id, client_id, chat_id, status, attempts)
      select ${campaignId}, c.id, c.telegram_chat_id, 'pending', 0 ${fromWhere(segment, now, tz)} order by c.name_sort, c.id`,
  ).changes;
}
