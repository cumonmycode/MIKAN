import { and, asc, count, desc, eq, inArray } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { products, productVariants, saleItems, stockMovements } from '../db/schema.js';
import { badRequest, conflict, insufficientStock, notFound } from '../lib/errors.js';
import { sizedName } from '../lib/jewelry.js';
import { movementOut, type MovementRow, type ProductRow, type VariantRow } from '../lib/serialize.js';
import { normalizeSearchTerm } from '../lib/text.js';
import { refreshProductSearch } from './product-search.js';
import { employeeRefOrMissing, employeesByIds, productsByIds, variantsByIds } from './refs.js';

export type MovementType = 'receipt' | 'sale' | 'return' | 'writeoff' | 'usage' | 'adjustment' | 'purchase';
export type ManualMovementType = 'receipt' | 'writeoff' | 'usage' | 'adjustment';

export interface MovementInput {
  productId: number;
  variantId: number;
  delta: number;
  type: MovementType;
  note?: string | null;
  saleId?: number | null;
  appointmentId?: number | null;
  revisionId?: number | null;
  /** The delivery (поставка) a receipt belongs to. */
  deliveryId?: number | null;
  employeeId?: number | null;
  /** Rubles paid (a receipt with a unit cost). */
  amount?: number | null;
}

export function getProductRow(db: DbOrTx, id: number): ProductRow {
  const row = db.select().from(products).where(eq(products.id, id)).get();
  if (!row) throw notFound('Товар не найден');
  return row;
}

/** The product's current sizes (archived ones excluded), in the order staff arranged them. */
export function currentVariants(db: DbOrTx, productId: number): VariantRow[] {
  return db
    .select()
    .from(productVariants)
    .where(and(eq(productVariants.productId, productId), eq(productVariants.archived, false)))
    .orderBy(asc(productVariants.position), asc(productVariants.id))
    .all();
}

/**
 * The size an operation applies to: `variantId` must be a current size of the product (`400` otherwise); without it
 * (older app builds) the product's only size, and `409` with `severalSizes` when it has more than one.
 */
export function resolveVariant(
  db: DbOrTx,
  product: ProductRow,
  variantId: number | null | undefined,
  severalSizes: () => Error,
  notFoundMessage = 'Размер не найден',
): VariantRow {
  if (variantId != null) {
    const row = db.select().from(productVariants).where(eq(productVariants.id, variantId)).get();
    if (!row || row.productId !== product.id || row.archived) throw badRequest(notFoundMessage);
    return row;
  }
  const sizes = currentVariants(db, product.id);
  if (sizes.length !== 1) throw severalSizes();
  return sizes[0]!;
}

/** A product deleted by staff keeps its history but takes no new sales or movements. */
export function assertInWarehouse(product: ProductRow): void {
  if (product.archived) throw badRequest(`«${product.name}»: позиция удалена со склада`);
}

/**
 * A receipt with what one unit cost: the cost becomes the new cost of what was received — the size's own cost when it
 * has one, else the product's — and the movement keeps the total paid.
 */
export function applyReceiptCost(db: DbOrTx, product: ProductRow, variant: VariantRow, unitCost: number): void {
  const now = Date.now();
  if (variant.cost != null) {
    db.update(productVariants).set({ cost: unitCost, updatedAt: now }).where(eq(productVariants.id, variant.id)).run();
  } else {
    db.update(products).set({ cost: unitCost, updatedAt: now }).where(eq(products.id, product.id)).run();
  }
}

/** Presence consumables are marked «есть / заканчивается / нет», never counted in movements. */
export function assertCounted(product: ProductRow): void {
  if (product.stockMode === 'presence') {
    throw badRequest(`«${product.name}» учитывается как «есть / нет» — отметьте наличие в карточке расходника`);
  }
}

export const severalSizesForMovement = (product: ProductRow) => () =>
  conflict(`У «${product.name}» несколько размеров — обновите приложение MIKAN, чтобы провести операцию по размеру`);

export function insufficientMessage(product: Pick<ProductRow, 'name'>, variant: Pick<VariantRow, 'name' | 'quantity'>): string {
  return `Недостаточно на складе: ${sizedName(product.name, variant.name)} (осталось ${variant.quantity})`;
}

/**
 * Applies a stock delta to one size and records the movement. Must run inside a transaction when combined with
 * other writes. Throws `insufficient_stock` if the result would be negative. A size that gets stock back (a refund
 * to an archived size) returns to the product's list.
 */
export function applyMovement(db: DbOrTx, input: MovementInput): { product: ProductRow; variant: VariantRow; movement: MovementRow } {
  const product = getProductRow(db, input.productId);
  assertInWarehouse(product);
  const variant = db.select().from(productVariants).where(eq(productVariants.id, input.variantId)).get();
  if (!variant || variant.productId !== product.id) throw notFound('Размер не найден');
  const quantityAfter = variant.quantity + input.delta;
  if (quantityAfter < 0) throw insufficientStock(insufficientMessage(product, variant));
  const now = Date.now();
  const updatedVariant = db
    .update(productVariants)
    .set({ quantity: quantityAfter, archived: variant.archived && quantityAfter === 0, updatedAt: now })
    .where(eq(productVariants.id, variant.id))
    .returning()
    .get();
  if (variant.archived && !updatedVariant.archived) refreshProductSearch(db, product.id);
  const updatedProduct = db.update(products).set({ updatedAt: now }).where(eq(products.id, product.id)).returning().get();
  const movement = db
    .insert(stockMovements)
    .values({
      productId: product.id,
      variantId: variant.id,
      delta: input.delta,
      quantityAfter,
      type: input.type,
      note: input.note ?? null,
      saleId: input.saleId ?? null,
      appointmentId: input.appointmentId ?? null,
      revisionId: input.revisionId ?? null,
      deliveryId: input.deliveryId ?? null,
      amount: input.amount ?? null,
      employeeId: input.employeeId ?? null,
      createdAt: now,
    })
    .returning()
    .get();
  return { product: updatedProduct, variant: updatedVariant, movement };
}

/** Converts the API's movement `quantity` semantics into a signed delta. */
export function deltaFor(type: ManualMovementType, quantity: number, current: number): number {
  switch (type) {
    case 'receipt':
      if (quantity <= 0) throw badRequest('«Количество»: должно быть больше 0');
      return quantity;
    case 'writeoff':
    case 'usage':
      if (quantity <= 0) throw badRequest('«Количество»: должно быть больше 0');
      return -quantity;
    case 'adjustment':
      if (quantity < 0) throw badRequest('«Количество»: остаток не может быть отрицательным');
      return quantity - current;
  }
}

export interface ManualMovement {
  type: ManualMovementType;
  quantity: number;
  variantId?: number | null;
  note?: string | null;
  /** Receipts: what one unit cost (see `applyReceiptCost`). */
  unitCost?: number | null;
}

export interface PurchaseInput {
  /** Rubles paid. */
  amount: number;
  note?: string | null;
  /** The status after the restock; `ok` by default. */
  presenceStatus?: 'ok' | 'low' | 'out' | null;
}

/**
 * `POST /products/:id/purchases`: a restock of a presence consumable with what it cost — a `purchase` movement on its
 * only size (`delta` 0) carrying the amount, and the new status. The analytics counts the amount as an expense.
 */
export function recordPurchase(db: DbOrTx, productId: number, input: PurchaseInput, employeeId: number) {
  return db.transaction((tx) => {
    const product = getProductRow(tx, productId);
    assertInWarehouse(product);
    if (product.stockMode !== 'presence') {
      throw badRequest('Сумму покупки записывают для расходников «есть / нет». Для остальных — приход количеством.');
    }
    const variant = currentVariants(tx, product.id)[0];
    if (!variant) throw badRequest(`У «${product.name}» нет размера для записи покупки`);
    const now = Date.now();
    const movement = tx
      .insert(stockMovements)
      .values({
        productId,
        variantId: variant.id,
        delta: 0,
        quantityAfter: variant.quantity,
        type: 'purchase',
        note: input.note ?? null,
        amount: input.amount,
        employeeId,
        createdAt: now,
      })
      .returning()
      .get();
    const updated = tx
      .update(products)
      .set({ presenceStatus: input.presenceStatus ?? 'ok', updatedAt: now })
      .where(eq(products.id, productId))
      .returning()
      .get()!;
    return { product: updated, movement };
  });
}

/** `POST /products/:id/movements`: one operation on one size. */
export function recordManualMovement(db: DbOrTx, productId: number, input: ManualMovement, employeeId: number) {
  return db.transaction((tx) => {
    const product = getProductRow(tx, productId);
    assertCounted(product);
    const variant = resolveVariant(tx, product, input.variantId, severalSizesForMovement(product));
    const delta = deltaFor(input.type, input.quantity, variant.quantity);
    const unitCost = input.type === 'receipt' ? (input.unitCost ?? null) : null;
    const amount = unitCost != null ? unitCost * delta : null;
    const result = applyMovement(tx, { productId, variantId: variant.id, delta, type: input.type, note: input.note, employeeId, amount });
    if (unitCost == null) return result;
    applyReceiptCost(tx, product, variant, unitCost);
    return { ...result, product: getProductRow(tx, productId) };
  });
}

export interface BatchMovement {
  type: ManualMovementType;
  note?: string | null;
  /** Receipts: what one unit cost, for every line without its own. */
  unitCost?: number | null;
  lines: Array<{ variantId: number; quantity: number; unitCost?: number | null }>;
}

/**
 * `POST /products/:id/movements/batch`: one operation over several sizes in one transaction (a delivery, a stock
 * count). A count line that matches the current stock is skipped; a count that changes nothing is refused.
 */
export function recordBatchMovement(db: DbOrTx, productId: number, input: BatchMovement, employeeId: number) {
  return db.transaction((tx) => {
    const product = getProductRow(tx, productId);
    assertCounted(product);
    const ids = input.lines.map((l) => l.variantId);
    if (new Set(ids).size !== ids.length) throw badRequest('Размер указан дважды');
    const movements: MovementRow[] = [];
    for (const line of input.lines) {
      const variant = resolveVariant(tx, product, line.variantId, severalSizesForMovement(product));
      const delta = deltaFor(input.type, line.quantity, variant.quantity);
      if (input.type === 'adjustment' && delta === 0) continue;
      const unitCost = input.type === 'receipt' ? (line.unitCost ?? input.unitCost ?? null) : null;
      const amount = unitCost != null ? unitCost * delta : null;
      movements.push(
        applyMovement(tx, { productId, variantId: variant.id, delta, type: input.type, note: input.note, employeeId, amount }).movement,
      );
      if (unitCost != null) applyReceiptCost(tx, getProductRow(tx, productId), variant, unitCost);
    }
    if (movements.length === 0) throw badRequest('Остатки не изменились');
    return { product: getProductRow(tx, productId), movements };
  });
}

export function serializeMovements(db: DbOrTx, rows: MovementRow[]) {
  const prods = productsByIds(
    db,
    rows.map((r) => r.productId),
  );
  const sizes = variantsByIds(
    db,
    rows.map((r) => r.variantId),
  );
  const emps = employeesByIds(
    db,
    rows.map((r) => r.employeeId),
  );
  return rows.map((m) =>
    movementOut(
      m,
      prods.get(m.productId)?.name ?? 'Удалённый товар',
      sizes.get(m.variantId)?.name ?? '',
      employeeRefOrMissing(emps, m.employeeId),
    ),
  );
}

export function listMovements(
  db: DbOrTx,
  filter: { productId?: number; variantId?: number; type?: string; limit: number; offset: number },
) {
  const conditions = [];
  if (filter.productId !== undefined) conditions.push(eq(stockMovements.productId, filter.productId));
  if (filter.variantId !== undefined) conditions.push(eq(stockMovements.variantId, filter.variantId));
  if (filter.type) conditions.push(eq(stockMovements.type, filter.type));
  const where = conditions.length ? and(...conditions) : undefined;
  const rows = db
    .select()
    .from(stockMovements)
    .where(where)
    .orderBy(desc(stockMovements.createdAt), desc(stockMovements.id))
    .limit(filter.limit)
    .offset(filter.offset)
    .all();
  const total = db.select({ n: count() }).from(stockMovements).where(where).get()?.n ?? 0;
  return { items: serializeMovements(db, rows), total };
}

/**
 * Where returned stock goes: the sold size, or — when that size was archived and the product now has a current size
 * with the same name — that current size, so a refund never brings back a duplicate.
 */
export function returnVariantId(db: DbOrTx, soldVariantId: number): number {
  const sold = db.select().from(productVariants).where(eq(productVariants.id, soldVariantId)).get();
  if (!sold?.archived) return soldVariantId;
  const twin = currentVariants(db, sold.productId).find((v) => normalizeSearchTerm(v.name) === normalizeSearchTerm(sold.name));
  return twin?.id ?? soldVariantId;
}

/** Sizes that have any stock history (movements or sold items) — they are archived, never deleted. */
export function variantsWithHistory(db: DbOrTx, variantIds: number[]): Set<number> {
  if (variantIds.length === 0) return new Set();
  const moved = db
    .selectDistinct({ id: stockMovements.variantId })
    .from(stockMovements)
    .where(inArray(stockMovements.variantId, variantIds))
    .all()
    .map((r) => r.id);
  const sold = db
    .selectDistinct({ id: saleItems.variantId })
    .from(saleItems)
    .where(inArray(saleItems.variantId, variantIds))
    .all()
    .map((r) => r.id)
    .filter((id): id is number => id != null);
  return new Set([...moved, ...sold]);
}
