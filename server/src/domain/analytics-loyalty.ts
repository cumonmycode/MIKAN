import { and, count, eq, gte, lt, sql, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { bonusOperations, certificateOperations } from '../db/schema.js';

/**
 * Analytics `loyalty` (docs/API.md «Analytics»): the bonus and gift certificate ledgers over `[from, to)` and what is
 * outstanding at `to`. For each ledger `outstanding(to) = outstanding(from) + credited − spent − burnt`.
 */

export interface LoyaltySection {
  /** Credited: cashback earned net of what refunds took back, gifts and manual adjustments (signed). */
  bonusEarned: number;
  /** Paid with bonuses, net of what refunds gave back. */
  bonusSpent: number;
  bonusExpired: number;
  /** Bonuses on the clients' accounts at `to`. */
  bonusOutstanding: number;
  certificatesSold: number;
  /** Spent with certificates, net of what refunds gave back. */
  certificatesRedeemed: number;
  certificatesExpired: number;
  /** Burnt by the owner or by refunding the sale that sold the certificate. */
  certificatesCancelled: number;
  /** The balance of every certificate at `to`. */
  certificatesOutstanding: number;
}

/** `Σ amount` of the ledger rows matching `condition` inside the period. */
const sumWhere = (amount: SQL | unknown, createdAt: unknown, from: number, condition: SQL) =>
  sql<number>`coalesce(sum(case when ${createdAt} >= ${from} and ${condition} then ${amount} end), 0)`;

export function loyaltySection(db: DbOrTx, from: number, to: number): LoyaltySection {
  const b = bonusOperations;
  const bonusSum = (condition: SQL) => sumWhere(b.amount, b.createdAt, from, condition);
  const bonus = db
    .select({
      outstanding: sql<number>`coalesce(sum(${b.amount}), 0)`,
      credited: bonusSum(sql`(${b.type} in ('earn', 'gift', 'adjust') or (${b.type} = 'reverse' and ${b.amount} < 0))`),
      spent: bonusSum(sql`(${b.type} = 'spend' or (${b.type} = 'reverse' and ${b.amount} > 0))`),
      expired: bonusSum(sql`${b.type} = 'expire'`),
    })
    .from(b)
    .where(lt(b.createdAt, to))
    .get();
  const c = certificateOperations;
  const certificateSum = (condition: SQL) => sumWhere(c.amount, c.createdAt, from, condition);
  const certificates = db
    .select({
      outstanding: sql<number>`coalesce(sum(${c.amount}), 0)`,
      sold: certificateSum(sql`${c.type} = 'issue'`),
      redeemed: certificateSum(sql`${c.type} in ('redeem', 'refund')`),
      expired: certificateSum(sql`${c.type} = 'expire'`),
      cancelled: certificateSum(sql`${c.type} = 'cancel'`),
    })
    .from(c)
    .where(lt(c.createdAt, to))
    .get();
  return {
    bonusEarned: bonus?.credited ?? 0,
    bonusSpent: -(bonus?.spent ?? 0),
    bonusExpired: -(bonus?.expired ?? 0),
    bonusOutstanding: bonus?.outstanding ?? 0,
    certificatesSold: certificates?.sold ?? 0,
    certificatesRedeemed: -(certificates?.redeemed ?? 0),
    certificatesExpired: -(certificates?.expired ?? 0),
    certificatesCancelled: -(certificates?.cancelled ?? 0),
    certificatesOutstanding: certificates?.outstanding ?? 0,
  };
}

/** Gift certificates sold in `[from, to)`: how many and their nominals (`certificatesSold`). */
export function certificatesIssued(db: DbOrTx, from: number, to: number): { count: number; amount: number } {
  const c = certificateOperations;
  const row = db
    .select({ count: count(), amount: sql<number>`coalesce(sum(${c.amount}), 0)` })
    .from(c)
    .where(and(eq(c.type, 'issue'), gte(c.createdAt, from), lt(c.createdAt, to)))
    .get();
  return { count: row?.count ?? 0, amount: row?.amount ?? 0 };
}
