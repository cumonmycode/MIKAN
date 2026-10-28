import { and, asc, count, desc, eq, inArray, isNotNull, max, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { products, stockDeliveries, stockMovements } from '../db/schema.js';
import { badRequest, notFound } from '../lib/errors.js';
import { sizedName } from '../lib/jewelry.js';
import type { MovementRow, ProductRow } from '../lib/serialize.js';
import { normalizeSearchTerm } from '../lib/text.js';
import { toIso } from '../lib/time.js';
import { refreshProductSearch } from './product-search.js';
import { employeeRefOrMissing, employeesByIds, productsByIds, variantsByIds } from './refs.js';
import { applyMovement, applyReceiptCost, assertInWarehouse, getProductRow, resolveVariant } from './stock.js';

/** Deliveries (поставки, docs/API.md «Deliveries»): one receiving of many products and sizes from a supplier. */

type DeliveryRow = typeof stockDeliveries.$inferSelect;

export interface DeliveryLineInput {
  productId: number;
  /** A current size of the product; omitted → its only size. */
  variantId?: number | null;
  quantity: number;
  /** What one unit cost; omitted → the receipt has no amount and costs stay. */
  unitCost?: number | null;
}

export interface DeliveryInput {
  /** Trimmed; `null` / "" = none. */
  supplier?: string | null;
  note?: string | null;
  lines: DeliveryLineInput[];
}

/** Σ of a delivery's lines, read from its `receipt` movements. */
interface DeliveryTotals {
  total: number;
  itemCount: number;
  lineCount: number;
}

const NO_TOTALS: DeliveryTotals = { total: 0, itemCount: 0, lineCount: 0 };

function totalsByDelivery(db: DbOrTx, ids: number[]): Map<number, DeliveryTotals> {
  if (ids.length === 0) return new Map();
  const rows = db
    .select({
      id: stockMovements.deliveryId,
      total: sql<number>`coalesce(sum(${stockMovements.amount}), 0)`,
      itemCount: sql<number>`coalesce(sum(${stockMovements.delta}), 0)`,
      lineCount: count(),
    })
    .from(stockMovements)
    .where(inArray(stockMovements.deliveryId, ids))
    .groupBy(stockMovements.deliveryId)
    .all();
  return new Map(rows.map((r) => [r.id!, { total: r.total, itemCount: r.itemCount, lineCount: r.lineCount }]));
}

function linesOut(db: DbOrTx, movements: MovementRow[]) {
  const prods = productsByIds(db, movements.map((m) => m.productId));
  const sizes = variantsByIds(db, movements.map((m) => m.variantId));
  return movements.map((m) => {
    const product = prods.get(m.productId);
    return {
      movementId: m.id,
      productId: m.productId,
      productName: product?.name ?? 'Удалённый товар',
      productKind: product?.kind ?? 'goods',
      variantId: m.variantId,
      variantName: sizes.get(m.variantId)?.name ?? '',
      quantity: m.delta,
      unitCost: m.amount != null ? m.amount / m.delta : null,
      amount: m.amount,
    };
  });
}

/** `StockDelivery`: with its lines (in the order sent) when `movements` are given, `lines: []` in lists. */
function deliveriesOut(db: DbOrTx, rows: DeliveryRow[], movements: MovementRow[] = []) {
  const totals = totalsByDelivery(db, rows.map((r) => r.id));
  const employees = employeesByIds(db, rows.map((r) => r.employeeId));
  const lines = linesOut(db, movements);
  return rows.map((row) => ({
    id: row.id,
    number: row.number,
    supplier: row.supplier,
    note: row.note,
    ...(totals.get(row.id) ?? NO_TOTALS),
    employee: employeeRefOrMissing(employees, row.employeeId),
    createdAt: toIso(row.createdAt),
    lines: lines.filter((_line, i) => movements[i]!.deliveryId === row.id),
  }));
}
export type DeliveryOut = ReturnType<typeof deliveriesOut>[number];

function deliveryMovements(db: DbOrTx, id: number): MovementRow[] {
  return db.select().from(stockMovements).where(eq(stockMovements.deliveryId, id)).orderBy(asc(stockMovements.id)).all();
}

function getDeliveryRow(db: DbOrTx, id: number): DeliveryRow {
  const row = db.select().from(stockDeliveries).where(eq(stockDeliveries.id, id)).get();
  if (!row) throw notFound('Поставка не найдена');
  return row;
}

export function getDelivery(db: DbOrTx, id: number): DeliveryOut {
  return deliveriesOut(db, [getDeliveryRow(db, id)], deliveryMovements(db, id))[0]!;
}

/** A product counted in pieces that may take stock: not a presence consumable, not deleted. */
function lineProduct(db: DbOrTx, line: DeliveryLineInput, label: string): ProductRow {
  const product = db.select().from(products).where(eq(products.id, line.productId)).get();
  if (!product) throw badRequest(`${label}: товар не найден`);
  if (product.stockMode === 'presence') throw badRequest(`Покупку расходника «${product.name}» записывают суммой`);
  assertInWarehouse(product);
  return product;
}

/** Products whose supplier is empty learn it from the delivery (the search text includes the supplier). */
function fillSuppliers(db: DbOrTx, productIds: number[], supplier: string, now: number): void {
  for (const id of new Set(productIds)) {
    const product = getProductRow(db, id);
    if (product.supplier?.trim()) continue;
    db.update(products).set({ supplier, updatedAt: now }).where(eq(products.id, id)).run();
    refreshProductSearch(db, id);
  }
}

/**
 * `POST /stock/deliveries`: every line becomes a `receipt` movement «Поставка №N» (+ « · note») with the amount and
 * the new cost of a receipt with `unitCost`; all or nothing.
 */
export function createDelivery(db: DbOrTx, input: DeliveryInput, employeeId: number): DeliveryOut {
  return db.transaction((tx) => {
    if (input.lines.length === 0) throw badRequest('Добавьте хотя бы одну позицию');
    const resolved = input.lines.map((line, i) => {
      const label = `Позиция №${i + 1}`;
      const product = lineProduct(tx, line, label);
      const several = () => badRequest(`Выберите размер «${product.name}»`);
      const variant = resolveVariant(tx, product, line.variantId, several, `${label}: размер не найден`);
      return { line, product, variant };
    });
    const seen = new Set<number>();
    for (const { product, variant } of resolved) {
      if (seen.has(variant.id)) throw badRequest(`«${sizedName(product.name, variant.name)}» указан в поставке дважды`);
      seen.add(variant.id);
    }

    const now = Date.now();
    const supplier = input.supplier?.trim() || null;
    const note = input.note?.trim() || null;
    const number = (tx.select({ n: max(stockDeliveries.number) }).from(stockDeliveries).get()?.n ?? 0) + 1;
    const delivery = tx.insert(stockDeliveries).values({ number, supplier, note, employeeId, createdAt: now }).returning().get();
    const movementNote = note ? `Поставка №${number} · ${note}` : `Поставка №${number}`;
    const movements = resolved.map(({ line, product, variant }) => {
      const unitCost = line.unitCost ?? null;
      const { movement } = applyMovement(tx, {
        productId: product.id,
        variantId: variant.id,
        delta: line.quantity,
        type: 'receipt',
        note: movementNote,
        deliveryId: delivery.id,
        employeeId,
        amount: unitCost != null ? unitCost * line.quantity : null,
      });
      if (unitCost != null) applyReceiptCost(tx, getProductRow(tx, product.id), variant, unitCost);
      return movement;
    });
    if (supplier) fillSuppliers(tx, resolved.map((r) => r.product.id), supplier, now);
    return deliveriesOut(tx, [delivery], movements)[0]!;
  });
}

/** Case- and «ё»-insensitive key of a supplier name. */
const supplierKey = (name: string): string => normalizeSearchTerm(name);

/** `GET /stock/deliveries`: newest first, optionally of one supplier (its name in any case). */
export function listDeliveries(db: DbOrTx, f: { supplier?: string; limit: number; offset: number }) {
  const key = f.supplier ? supplierKey(f.supplier) : '';
  if (!key) {
    const rows = db.select().from(stockDeliveries).orderBy(desc(stockDeliveries.number)).limit(f.limit).offset(f.offset).all();
    const total = db.select({ n: count() }).from(stockDeliveries).get()?.n ?? 0;
    return { items: deliveriesOut(db, rows), total };
  }
  // SQLite lowercases ASCII only: a studio receives a few deliveries a month, so Cyrillic names are matched here.
  const found = db
    .select()
    .from(stockDeliveries)
    .where(isNotNull(stockDeliveries.supplier))
    .orderBy(desc(stockDeliveries.number))
    .all()
    .filter((row) => supplierKey(row.supplier!) === key);
  return { items: deliveriesOut(db, found.slice(f.offset, f.offset + f.limit)), total: found.length };
}

export interface SupplierOut {
  name: string;
  deliveries: number;
  lastAt: string | null;
}

/**
 * `GET /stock/suppliers`: the distinct supplier names of deliveries and products. A name keeps the spelling of its
 * latest delivery (of its latest edited product when it has none); recently used first, then the rest by name.
 */
export function listSuppliers(db: DbOrTx): SupplierOut[] {
  const found = new Map<string, { name: string; deliveries: number; lastAt: number | null }>();
  const deliveries = db
    .select({ supplier: stockDeliveries.supplier, createdAt: stockDeliveries.createdAt })
    .from(stockDeliveries)
    .where(isNotNull(stockDeliveries.supplier))
    .orderBy(desc(stockDeliveries.createdAt), desc(stockDeliveries.id))
    .all();
  for (const d of deliveries) {
    const name = d.supplier!.trim();
    const entry = found.get(supplierKey(name));
    if (entry) entry.deliveries += 1;
    else found.set(supplierKey(name), { name, deliveries: 1, lastAt: d.createdAt });
  }
  const named = db
    .select({ supplier: products.supplier })
    .from(products)
    .where(and(isNotNull(products.supplier), eq(products.archived, false)))
    .orderBy(desc(products.updatedAt), desc(products.id))
    .all();
  for (const p of named) {
    const name = p.supplier!.trim();
    if (name && !found.has(supplierKey(name))) found.set(supplierKey(name), { name, deliveries: 0, lastAt: null });
  }
  return [...found.values()]
    .sort((a, b) => (b.lastAt ?? -1) - (a.lastAt ?? -1) || a.name.localeCompare(b.name, 'ru'))
    .map((s) => ({ name: s.name, deliveries: s.deliveries, lastAt: toIso(s.lastAt) }));
}
