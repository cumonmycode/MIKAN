import { and, count, eq, gte, lt, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import type { DbOrTx } from '../db/client.js';
import { retentionSends } from '../db/schema.js';
import { localDate, localDayBounds } from '../lib/time.js';
import { MARKETING_AUDIENCE } from './campaign-segment.js';

/**
 * Who gets the automatic retention messages today (docs/API.md «Birthday and win-back»), and the log that makes each
 * of them go out once: a birthday once a year, a win-back once per absence. Both only reach clients the bot may send
 * news to (see MARKETING_AUDIENCE).
 */

export type RetentionKind = 'birthday' | 'winback';

export interface RetentionCandidate {
  clientId: number;
  /** First name, for `{name}`. */
  name: string;
  chatId: number;
  /** `retention_sends.period_key`: the year of a birthday, the date of the last visit of a win-back. */
  periodKey: string;
}

const listOf = (values: string[]) => sql.join(values.map((v) => sql`${v}`), sql`, `);

/** Clients whose birthday is today (29 February counts on 28 February in other years), not greeted this year. */
export function birthdayCandidates(db: DbOrTx, now: number, tz: string): RetentionCandidate[] {
  const today = DateTime.fromMillis(now, { zone: tz });
  const days = [today.toFormat('MM-dd')];
  if (days[0] === '02-28' && !today.isInLeapYear) days.push('02-29');
  const year = String(today.year);
  return db
    .all<Omit<RetentionCandidate, 'periodKey'>>(
      sql`select c.id as clientId, c.name as name, c.telegram_chat_id as chatId from clients c
        where ${MARKETING_AUDIENCE} and substr(c.birthday, 6, 5) in (${listOf(days)})
          and not exists (select 1 from retention_sends r where r.client_id = c.id and r.kind = 'birthday' and r.period_key = ${year})
        order by c.id`,
    )
    .map((row) => ({ ...row, periodKey: year }));
}

/**
 * Clients whose last completed visit was at least `afterMonths` ago, with no appointment ahead and no win-back since
 * that visit (a new visit starts a new absence) — the longest absent first, at most `limit`.
 */
export function winbackCandidates(db: DbOrTx, now: number, tz: string, afterMonths: number, limit: number): RetentionCandidate[] {
  if (limit <= 0) return [];
  const cutoff = DateTime.fromMillis(now, { zone: tz }).minus({ months: afterMonths }).toMillis();
  return db
    .all<Omit<RetentionCandidate, 'periodKey'> & { lastVisit: number }>(
      sql`select c.id as clientId, c.name as name, c.telegram_chat_id as chatId, v.last_visit as lastVisit from clients c
        join (select client_id, max(starts_at) as last_visit from appointments where status = 'completed' group by client_id) v
          on v.client_id = c.id
        where ${MARKETING_AUDIENCE} and v.last_visit <= ${cutoff}
          and not exists (select 1 from appointments f
            where f.client_id = c.id and f.status in ('scheduled', 'confirmed') and f.starts_at > ${now})
          and not exists (select 1 from retention_sends r
            where r.client_id = c.id and r.kind = 'winback' and r.sent_at > v.last_visit)
        order by v.last_visit, c.id limit ${limit}`,
    )
    .map(({ lastVisit, ...row }) => ({ ...row, periodKey: localDate(lastVisit, tz) }));
}

/** Win-back messages logged today (studio day). */
export function winbacksToday(db: DbOrTx, now: number, tz: string): number {
  const day = localDayBounds(now, tz);
  return (
    db
      .select({ n: count() })
      .from(retentionSends)
      .where(and(eq(retentionSends.kind, 'winback'), gte(retentionSends.sentAt, day.start), lt(retentionSends.sentAt, day.end)))
      .get()?.n ?? 0
  );
}

/** Logs the send before it goes out; false when it is already logged (sent before, or by a parallel run). */
export function claimRetentionSend(db: DbOrTx, kind: RetentionKind, candidate: RetentionCandidate, now: number): boolean {
  const row = db
    .insert(retentionSends)
    .values({ clientId: candidate.clientId, kind, periodKey: candidate.periodKey, sentAt: now })
    .onConflictDoNothing()
    .returning({ id: retentionSends.id })
    .get();
  return row !== undefined;
}

/** Forgets a claim whose message did not go out, so a later run tries again. */
export function releaseRetentionSend(db: DbOrTx, kind: RetentionKind, candidate: RetentionCandidate): void {
  db.delete(retentionSends)
    .where(
      and(eq(retentionSends.clientId, candidate.clientId), eq(retentionSends.kind, kind), eq(retentionSends.periodKey, candidate.periodKey)),
    )
    .run();
}
