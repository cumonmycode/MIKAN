import { and, asc, eq, getTableColumns, gte, lt } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { appointments, saleItems, saleRefunds, sales } from '../db/schema.js';
import type { SaleItemRow, SaleRow } from '../lib/serialize.js';
import { localDate, localDatesInRange, localWeekdayHour } from '../lib/time.js';
import { refundRevenueSql, saleKeptRevenueSql, saleRevenueSql } from './sale-revenue.js';

/**
 * Sales of an analytics period. Revenue counts every sale made in the period and subtracts refunds made in it
 * (cash basis, like a shift; a partial refund by what it returned); the breakdowns (items, masters, clients, hours)
 * count what is kept of the sales that were not returned in full, so a returned receipt or line never inflates tops
 * or margins. A sale's revenue leaves out bonuses paid and gift certificates sold (see sale-revenue.ts).
 */

/** A sale with its revenue and what of it is kept after its refunds (docs/API.md «Reports»). */
export type RevenueSale = SaleRow & { revenue: number; keptRevenue: number };

/** A sale with the master of the appointment it paid for (`null` when not linked to an appointment). */
export type PeriodSale = RevenueSale & { masterId: number | null };

/** A refund made in the period, with its revenue (`refundRevenueSql`). */
export interface PeriodRefund {
  createdAt: number;
  revenue: number;
}

export interface PeriodSales {
  /** Every sale made in the period, refunded later or not. */
  made: PeriodSale[];
  /** The made sales that are still `completed` (something of them is kept); they count by `keptRevenue`. */
  kept: PeriodSale[];
  /** Refunds (whole or partial) made during the period, whenever their sales were made. */
  refunds: PeriodRefund[];
  /** Items of the kept sales, by sale, ordered by id (`refundedQuantity` — what of each is returned). */
  itemsBySale: Map<number, SaleItemRow[]>;
}

export function loadPeriodSales(db: DbOrTx, from: number, to: number): PeriodSales {
  const made = db
    .select({ ...getTableColumns(sales), masterId: appointments.masterId, revenue: saleRevenueSql, keptRevenue: saleKeptRevenueSql })
    .from(sales)
    .leftJoin(appointments, eq(sales.appointmentId, appointments.id))
    .where(and(gte(sales.createdAt, from), lt(sales.createdAt, to)))
    .orderBy(asc(sales.id))
    .all();
  const refunds = db
    .select({ createdAt: saleRefunds.createdAt, revenue: refundRevenueSql })
    .from(saleRefunds)
    .where(and(gte(saleRefunds.createdAt, from), lt(saleRefunds.createdAt, to)))
    .orderBy(asc(saleRefunds.id))
    .all();
  // A join instead of `sale_id in (…)`: a year of receipts would not fit into SQL parameters.
  const items = db
    .select(getTableColumns(saleItems))
    .from(saleItems)
    .innerJoin(sales, eq(saleItems.saleId, sales.id))
    .where(and(gte(sales.createdAt, from), lt(sales.createdAt, to), eq(sales.status, 'completed')))
    .orderBy(asc(saleItems.id))
    .all();
  const itemsBySale = new Map<number, SaleItemRow[]>();
  for (const item of items) itemsBySale.set(item.saleId, [...(itemsBySale.get(item.saleId) ?? []), item]);
  return { made, kept: made.filter((s) => s.status === 'completed'), refunds, itemsBySale };
}

const sumOf = <T>(list: readonly T[], pick: (x: T) => number) => list.reduce((s, x) => s + pick(x), 0);

export function revenueSection(s: PeriodSales) {
  const gross = sumOf(s.made, (x) => x.revenue);
  const refunds = sumOf(s.refunds, (x) => x.revenue);
  return {
    gross,
    refunds,
    refundsCount: s.refunds.length,
    net: gross - refunds,
    salesCount: s.made.length,
    averageCheck: s.made.length ? Math.round(gross / s.made.length) : 0,
    discounts: sumOf(s.made, (x) => x.discount),
    kept: sumOf(s.kept, (x) => x.keptRevenue),
    // Every way the made sales were paid: Σ = gross + bonus + the certificates they sold.
    payments: {
      cash: sumOf(s.made, (x) => x.payCash),
      card: sumOf(s.made, (x) => x.payCard),
      transfer: sumOf(s.made, (x) => x.payTransfer),
      qr: sumOf(s.made, (x) => x.payQr),
      deposit: sumOf(s.made, (x) => x.payDeposit),
      bonus: sumOf(s.made, (x) => x.payBonus),
      certificate: sumOf(s.made, (x) => x.payCertificate),
    },
  };
}

export type RevenueSection = ReturnType<typeof revenueSection>;

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

/**
 * Every studio-local day of the range (zeros included) with sales made and refunds that day; and the kept sales
 * bucketed by weekday (Mon…Sun) and hour of day.
 */
export function timeSeries(s: PeriodSales, from: number, to: number, tz: string) {
  const days = new Map(localDatesInRange(from, to, tz).map((date) => [date, { date, gross: 0, refunds: 0, net: 0, salesCount: 0 }]));
  for (const sale of s.made) {
    const day = days.get(localDate(sale.createdAt, tz));
    if (!day) continue;
    day.gross += sale.revenue;
    day.salesCount += 1;
  }
  for (const refund of s.refunds) {
    const day = days.get(localDate(refund.createdAt, tz));
    if (day) day.refunds += refund.revenue;
  }
  const byWeekday = WEEKDAYS.map((weekday) => ({ weekday, revenue: 0, salesCount: 0 }));
  const byHour = HOURS.map((hour) => ({ hour, revenue: 0, salesCount: 0 }));
  for (const sale of s.kept) {
    const { weekday, hour } = localWeekdayHour(sale.createdAt, tz);
    for (const bucket of [byWeekday[weekday - 1], byHour[hour]]) {
      if (!bucket) continue;
      bucket.revenue += sale.keptRevenue;
      bucket.salesCount += 1;
    }
  }
  return {
    byDay: [...days.values()].map((d) => ({ ...d, net: d.gross - d.refunds })),
    byWeekday,
    byHour,
  };
}
