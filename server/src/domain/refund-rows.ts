import { asc, inArray } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { saleRefundItems, saleRefunds } from '../db/schema.js';
import type { SaleRefundItemRow, SaleRefundRow } from '../lib/serialize.js';

/** A stored refund of a sale (docs/API.md «SaleRefund») with its lines. */
export interface RefundRecord {
  row: SaleRefundRow;
  items: SaleRefundItemRow[];
}

/** The refunds of the given sales, oldest first, by sale id — two queries for any number of sales. */
export function refundsBySales(db: DbOrTx, saleIds: readonly number[]): Map<number, RefundRecord[]> {
  const ids = [...new Set(saleIds)];
  const result = new Map<number, RefundRecord[]>();
  if (ids.length === 0) return result;
  const rows = db.select().from(saleRefunds).where(inArray(saleRefunds.saleId, ids)).orderBy(asc(saleRefunds.id)).all();
  if (rows.length === 0) return result;
  const items = db
    .select()
    .from(saleRefundItems)
    .where(
      inArray(
        saleRefundItems.refundId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(asc(saleRefundItems.id))
    .all();
  const itemsByRefund = new Map<number, SaleRefundItemRow[]>();
  for (const item of items) itemsByRefund.set(item.refundId, [...(itemsByRefund.get(item.refundId) ?? []), item]);
  for (const row of rows) {
    result.set(row.saleId, [...(result.get(row.saleId) ?? []), { row, items: itemsByRefund.get(row.id) ?? [] }]);
  }
  return result;
}
