import { sql, type SQL } from 'drizzle-orm';
import { saleRefunds, sales } from '../db/schema.js';
import type { SaleItemRow, SaleRow } from '../lib/serialize.js';

/**
 * What of a sale is revenue (docs/API.md «Loyalty bonuses», «Gift certificates», «Analytics»): a gift certificate
 * sold is money received for later, not revenue; bonuses paid are a discount. Paying with a certificate is revenue of
 * the sale it pays.
 */

/**
 * Splits the sale discount across items proportionally to their totals (whole rubles);
 * the rounding remainder goes to the last item so item revenues sum exactly to the sale total.
 */
export function allocateDiscount(items: Array<Pick<SaleItemRow, 'total'>>, discount: number): number[] {
  const subtotal = items.reduce((s, i) => s + i.total, 0);
  if (subtotal === 0 || discount === 0) return items.map((i) => i.total);
  let allocated = 0;
  return items.map((item, index) => {
    const share = index === items.length - 1 ? discount - allocated : Math.round((discount * item.total) / subtotal);
    allocated += share;
    return item.total - share;
  });
}

/** Stored `sale_items.type` of a gift certificate line (sent to the apps as `service` with `certificateId`). */
export const CERTIFICATE_LINE = 'certificate';

export const isCertificateLine = (item: Pick<SaleItemRow, 'type'>): boolean => item.type === CERTIFICATE_LINE;

/**
 * Revenue of each line, in order: certificate lines earn 0; the other lines share the sale discount and the bonus
 * payment proportionally (whole rubles, the remainder to the last such line), so they add up to the sale's revenue.
 * A sale without certificates or bonuses splits exactly like `allocateDiscount`.
 */
export function lineRevenues(
  sale: Pick<SaleRow, 'discount' | 'payBonus'>,
  items: Array<Pick<SaleItemRow, 'type' | 'total'>>,
): number[] {
  const regular = items.filter((item) => !isCertificateLine(item));
  const shared = allocateDiscount(regular, sale.discount + sale.payBonus);
  let next = 0;
  return items.map((item) => (isCertificateLine(item) ? 0 : (shared[next++] ?? 0)));
}

/** Σ totals of a sale's certificate lines (they never take a share of the discount). */
export const certificateLinesTotal = (items: Array<Pick<SaleItemRow, 'type' | 'total'>>): number =>
  items.filter(isCertificateLine).reduce((sum, item) => sum + item.total, 0);

/**
 * SQL for a sale row's revenue: `total − payBonus − its certificate lines`. The subquery names `"sales"."id"` in full:
 * drizzle leaves columns of a single-table select unqualified, and a bare `"id"` would mean the sale line's own id.
 */
export const saleRevenueSql = sql<number>`(${sales.total} - ${sales.payBonus} - coalesce((select sum(si.total) from sale_items si where si.sale_id = "sales"."id" and si.type = ${CERTIFICATE_LINE}), 0))`;

/** SQL for the money a sale brought into the till now: everything except bonuses and certificate payments. */
export const saleMoneySql = sql<number>`(${sales.total} - ${sales.payBonus} - ${sales.payCertificate})`;

// ---------- partial refunds (docs/API.md «Reports»: a sale counts by what of it is kept) ----------

/** SQL: Σ amounts of the certificate lines returned by refunds — the refund lines `ri` (with their sale line `si`) matching `refundCondition`. */
const refundedCertificateLinesSql = (refundCondition: SQL) =>
  sql`coalesce((select sum(ri.amount) from sale_refund_items ri join sale_items si on si.id = ri.sale_item_id where ${refundCondition} and si.type = ${CERTIFICATE_LINE}), 0)`;

/**
 * SQL for a refund row's revenue — the analytics counterpart of a sale's: `amount − payments.bonus −` the certificate
 * lines it returned (they were never revenue). Σ over a sale's refunds = the sale's revenue once it is returned in full.
 */
export const refundRevenueSql = sql<number>`(${saleRefunds.amount} - ${saleRefunds.payBonus} - ${refundedCertificateLinesSql(sql`ri.refund_id = "sale_refunds"."id"`)})`;

/** SQL for the money a refund gave back: its `cash + card + transfer + qr + deposit` parts (bonuses and certificates are not money). */
export const refundMoneySql = sql<number>`(${saleRefunds.payCash} + ${saleRefunds.payCard} + ${saleRefunds.payTransfer} + ${saleRefunds.payQr} + ${saleRefunds.payDeposit})`;

/** SQL: Σ `refundRevenueSql` over a sale row's refunds. */
const saleRefundsRevenueSql = sql`(coalesce((select sum(r.amount - r.pay_bonus) from sale_refunds r where r.sale_id = "sales"."id"), 0)
  - ${refundedCertificateLinesSql(sql`si.sale_id = "sales"."id"`)})`;

/**
 * SQL for a sale row's kept revenue: its revenue less the revenue of its refunds (`refundRevenueSql`); 0 once it is
 * returned in full, the whole revenue while nothing is returned.
 */
export const saleKeptRevenueSql = sql<number>`(case when ${sales.status} = 'refunded' then 0
  when ${sales.refundedTotal} = 0 then ${saleRevenueSql} else ${saleRevenueSql} - ${saleRefundsRevenueSql} end)`;

/** Units of a line no refund has returned. */
export const keptUnits = (item: Pick<SaleItemRow, 'quantity' | 'refundedQuantity'>): number => item.quantity - item.refundedQuantity;

/**
 * Kept revenue of each line, in order (docs/API.md «Reports»): a line counts by its kept units at its net price. The
 * sale's kept revenue is split across the kept units of the lines that are not certificates the way `lineRevenues`
 * splits a sale's discount and bonuses, so the lines add up to it; certificate lines and lines returned in full
 * earn 0. A sale nothing was returned from splits exactly like `lineRevenues`.
 */
export function keptLineRevenues(
  sale: Pick<SaleRow, 'discount' | 'payBonus' | 'refundedTotal'> & { keptRevenue: number },
  items: Array<Pick<SaleItemRow, 'type' | 'total' | 'price' | 'quantity' | 'refundedQuantity'>>,
): number[] {
  if (sale.refundedTotal === 0) return lineRevenues(sale, items);
  const counted = (item: (typeof items)[number]) => !isCertificateLine(item) && keptUnits(item) > 0;
  const kept = items.filter(counted).map((item) => ({ total: item.price * keptUnits(item) }));
  const keptSubtotal = kept.reduce((sum, item) => sum + item.total, 0);
  const shared = allocateDiscount(kept, Math.min(keptSubtotal, Math.max(0, keptSubtotal - sale.keptRevenue)));
  let next = 0;
  return items.map((item) => (counted(item) ? (shared[next++] ?? 0) : 0));
}
