import { and, asc, eq, getTableColumns, gte, lt, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { appointments, products, productVariants, saleItems, sales, stockMovements } from '../db/schema.js';
import type { SaleItemRow, SaleRow } from '../lib/serialize.js';
import { loadPeriodSales, type PeriodSales } from './analytics-sales.js';
import { servicesByIds } from './refs.js';
import { saleKeptRevenueSql } from './sale-revenue.js';

/** A sale with its kept revenue (its revenue less what its refunds returned). */
export type KeptSale = SaleRow & { keptRevenue: number };

/**
 * Everything a payroll period is counted from, loaded once for all employees: the completed visits starting in the
 * period with their sales not returned in full (paid whenever; their lines count by kept units) and the consumables
 * written off for them, and the sales made in the period (analytics' `loadPeriodSales`: product lines and the days
 * people worked at the till).
 */

export interface PayrollVisit {
  id: number;
  masterId: number;
  startsAt: number;
}

export interface PayrollData {
  visits: PayrollVisit[];
  /** Sales of each visit not returned in full (with what of them is kept), by id. */
  visitSales: Map<number, KeptSale[]>;
  /** Items of those sales, by sale, by id. */
  visitItems: Map<number, SaleItemRow[]>;
  /** Cost of the consumables used for each visit (usage × the current unit cost; units without a cost count 0). */
  materials: Map<number, number>;
  /** Category of every catalog service named by a service line above. */
  categories: Map<number, string>;
  sales: PeriodSales;
}

/** Completed visits starting in `[start, end)`. */
const visitInPeriod = (start: number, end: number) =>
  and(eq(appointments.status, 'completed'), gte(appointments.startsAt, start), lt(appointments.startsAt, end));

function group<T>(rows: T[], keyOf: (row: T) => number): Map<number, T[]> {
  const result = new Map<number, T[]>();
  for (const row of rows) {
    const list = result.get(keyOf(row));
    if (list) list.push(row);
    else result.set(keyOf(row), [row]);
  }
  return result;
}

function visitMaterials(db: DbOrTx, start: number, end: number): Map<number, number> {
  const unitCost = sql<number | null>`coalesce(${productVariants.cost}, ${products.cost})`;
  // Joins instead of `appointment_id in (…)`: a year of visits would not fit into SQL parameters.
  const rows = db
    .select({
      appointmentId: stockMovements.appointmentId,
      value: sql<number>`coalesce(sum(-${stockMovements.delta} * ${unitCost}), 0)`,
    })
    .from(stockMovements)
    .innerJoin(appointments, eq(stockMovements.appointmentId, appointments.id))
    .innerJoin(productVariants, eq(stockMovements.variantId, productVariants.id))
    .innerJoin(products, eq(stockMovements.productId, products.id))
    .where(and(eq(stockMovements.type, 'usage'), visitInPeriod(start, end)))
    .groupBy(stockMovements.appointmentId)
    .all();
  return new Map(rows.map((r) => [r.appointmentId!, r.value]));
}

export function loadPayrollData(db: DbOrTx, start: number, end: number): PayrollData {
  const visits = db
    .select({ id: appointments.id, masterId: appointments.masterId, startsAt: appointments.startsAt })
    .from(appointments)
    .where(visitInPeriod(start, end))
    .orderBy(asc(appointments.startsAt), asc(appointments.id))
    .all();
  const keptOfVisits = and(visitInPeriod(start, end), eq(sales.status, 'completed'));
  const visitSales = db
    .select({ ...getTableColumns(sales), keptRevenue: saleKeptRevenueSql })
    .from(sales)
    .innerJoin(appointments, eq(sales.appointmentId, appointments.id))
    .where(keptOfVisits)
    .orderBy(asc(sales.id))
    .all();
  const visitItems = db
    .select(getTableColumns(saleItems))
    .from(saleItems)
    .innerJoin(sales, eq(saleItems.saleId, sales.id))
    .innerJoin(appointments, eq(sales.appointmentId, appointments.id))
    .where(keptOfVisits)
    .orderBy(asc(saleItems.id))
    .all();
  const services = servicesByIds(db, visitItems.map((i) => i.serviceId));
  return {
    visits,
    visitSales: group(visitSales, (s) => s.appointmentId!),
    visitItems: group(visitItems, (i) => i.saleId),
    materials: visitMaterials(db, start, end),
    categories: new Map([...services.values()].map((s) => [s.id, s.category])),
    sales: loadPeriodSales(db, start, end),
  };
}
