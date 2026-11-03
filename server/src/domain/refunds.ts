import { asc, eq, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { productVariants, saleItems, saleRefundItems, saleRefunds, sales } from '../db/schema.js';
import { badRequest, conflict } from '../lib/errors.js';
import type { SaleItemRow, SaleRow } from '../lib/serialize.js';
import { previewTakeBack, reverseSaleBonuses, saleEarnings, type BonusRow } from './bonuses.js';
import { getOpenShift } from './cash.js';
import { assertCertificatesRefundable, cancelSoldCertificates, returnCertificatePayment } from './certificates.js';
import { unapplyDeposit } from './deposits.js';
import { getSaleRow } from './refs.js';
import { refundsBySales, type RefundRecord } from './refund-rows.js';
import { allocateDiscount, certificateLinesTotal, isCertificateLine, keptUnits } from './sale-revenue.js';
import { applyMovement, getProductRow, returnVariantId } from './stock.js';

/**
 * Refunds of sales (docs/API.md «SaleRefund», «Sales (POS)»): some lines or units, or everything left. The money of a
 * refund is planned first (`planRefund`, nothing written — also the preview), then recorded in one transaction.
 */

export interface RefundLineInput {
  saleItemId: number;
  quantity: number;
}

export interface RefundInput {
  reason: string;
  restock: boolean;
  /** Omitted — every unit not returned yet. */
  items?: RefundLineInput[] | null;
}

/** Payment parts in the order the leftover rubles of a proportional split go to. */
const PAYMENT_PARTS = ['cash', 'transfer', 'card', 'qr', 'certificate', 'bonus', 'deposit'] as const;
type PaymentPart = (typeof PAYMENT_PARTS)[number];
export type RefundPayments = Record<PaymentPart, number>;

/** The column of each part on both `sales` and `sale_refunds`. */
const COLUMN = {
  cash: 'payCash',
  transfer: 'payTransfer',
  card: 'payCard',
  qr: 'payQr',
  certificate: 'payCertificate',
  bonus: 'payBonus',
  deposit: 'payDeposit',
} as const satisfies Record<PaymentPart, keyof SaleRow>;

export const NEEDS_SHIFT_MESSAGE = 'Откройте смену, чтобы вернуть наличные';

interface PlannedLine {
  item: SaleItemRow;
  quantity: number;
  amount: number;
}

export interface RefundPlan {
  lines: PlannedLine[];
  amount: number;
  payments: RefundPayments;
  /** Earned bonuses the refund owes back; `bonusTakenBack` — what of them the client's lots let it take. */
  bonusOwed: number;
  bonusTakenBack: number;
  /** Every unit of the sale is returned once it is recorded. */
  final: boolean;
  /** It returns the whole sale at once (nothing was returned before). */
  whole: boolean;
}

/** Units to return per line: the request checked against what each line has left, or everything left. */
function requestedUnits(sale: SaleRow, items: SaleItemRow[], requested: RefundLineInput[] | null | undefined): Map<number, number> {
  if (!requested) return new Map(items.filter((i) => keptUnits(i) > 0).map((i) => [i.id, keptUnits(i)]));
  const byId = new Map(items.map((i) => [i.id, i]));
  const wanted = new Map<number, number>();
  for (const line of requested) {
    const item = byId.get(line.saleItemId);
    if (!item) throw badRequest(`Позиция не найдена в чеке №${sale.number}`);
    if (wanted.has(item.id)) throw badRequest(`Позиция «${item.name}» указана дважды`);
    const left = keptUnits(item);
    if (left === 0) throw badRequest(`Позиция «${item.name}» уже возвращена`);
    if (line.quantity > left) throw badRequest(`Можно вернуть не больше ${left} шт «${item.name}»`);
    wanted.set(item.id, line.quantity);
  }
  return wanted;
}

/** What each line was paid: its total less its share of the discount (certificate lines take none); Σ = the sale total. */
function lineNets(sale: SaleRow, items: SaleItemRow[]): Map<number, number> {
  const regular = items.filter((i) => !isCertificateLine(i));
  const shared = allocateDiscount(regular, sale.discount);
  const nets = new Map(items.filter(isCertificateLine).map((i) => [i.id, i.total]));
  regular.forEach((item, index) => nets.set(item.id, shared[index] ?? item.total));
  return nets;
}

/**
 * What `quantity` units of a line return: the net per unit rounded down, and exactly the line's rest for its last
 * units — so a line returned in full gives back its net and a sale returned in full its total.
 */
function lineAmount(item: SaleItemRow, quantity: number, net: number, returned: number): number {
  const rest = net - returned;
  if (quantity === keptUnits(item)) return rest;
  return Math.max(0, Math.min(rest, quantity * Math.floor(net / item.quantity)));
}

/** What of each payment part no refund has given back yet. */
function paymentRests(sale: SaleRow, previous: RefundRecord[]): RefundPayments {
  const rests = {} as RefundPayments;
  for (const part of PAYMENT_PARTS) {
    rests[part] = sale[COLUMN[part]] - previous.reduce((sum, r) => sum + r.row[COLUMN[part]], 0);
  }
  return rests;
}

/** `amount` split in proportion to the rests, rounded down; the leftover rubles to the parts in order, within their rests. */
function splitPayments(amount: number, rests: RefundPayments): RefundPayments {
  const total = PAYMENT_PARTS.reduce((sum, part) => sum + rests[part], 0);
  const parts = {} as RefundPayments;
  for (const part of PAYMENT_PARTS) parts[part] = total > 0 ? Math.floor((amount * rests[part]) / total) : 0;
  let left = amount - PAYMENT_PARTS.reduce((sum, part) => sum + parts[part], 0);
  for (const part of PAYMENT_PARTS) {
    const extra = Math.max(0, Math.min(left, rests[part] - parts[part]));
    parts[part] += extra;
    left -= extra;
  }
  return parts;
}

interface RefundMoney {
  amount: number;
  payBonus: number;
  payCertificate: number;
  /** Σ certificate lines it returns. */
  certificateLines: number;
}

/**
 * Earned bonuses a refund takes back: its share in proportion to the part of the bonus base it returns, rounded down —
 * the refund of the rest takes the rest. What of the sale's lot has burnt is never taken back: it comes off the last
 * shares, so a sale returned in parts gives up exactly what a whole refund would.
 */
function bonusOwed(
  sale: SaleRow,
  items: SaleItemRow[],
  earnings: { lot: BonusRow | null; burnt: number },
  previous: RefundMoney[],
  current: RefundMoney,
  final: boolean,
): number {
  const earned = earnings.lot?.amount ?? 0;
  if (earned <= 0) return 0;
  const base = sale.total - sale.payBonus - sale.payCertificate - certificateLinesTotal(items);
  const shareOf = (r: RefundMoney) =>
    base > 0 ? Math.floor((earned * Math.max(0, r.amount - r.payBonus - r.payCertificate - r.certificateLines)) / base) : 0;
  const before = previous.reduce((sum, r) => sum + shareOf(r), 0);
  const upTo = final ? earned : before + shareOf(current);
  const alive = Math.max(0, earned - earnings.burnt);
  return Math.max(0, Math.min(alive, upTo) - Math.min(alive, before));
}

/**
 * The lines a refund returns with their amounts. The refund of the rest returns exactly what is left of the sale: the
 * lines always add up to it, and should stored refunds ever disagree, the last line squares the receipt.
 */
function refundLines(sale: SaleRow, items: SaleItemRow[], wanted: Map<number, number>, previous: RefundRecord[], final: boolean) {
  const returned = new Map<number, number>();
  for (const line of previous.flatMap((r) => r.items)) returned.set(line.saleItemId, (returned.get(line.saleItemId) ?? 0) + line.amount);
  const nets = lineNets(sale, items);
  const lines: PlannedLine[] = items
    .filter((item) => wanted.has(item.id))
    .map((item) => {
      const quantity = wanted.get(item.id)!;
      return { item, quantity, amount: lineAmount(item, quantity, nets.get(item.id) ?? 0, returned.get(item.id) ?? 0) };
    });
  const amount = lines.reduce((sum, line) => sum + line.amount, 0);
  const leftToReturn = sale.total - sale.refundedTotal;
  if (!final || amount === leftToReturn || lines.length === 0) return { lines, amount };
  const last = lines[lines.length - 1]!;
  return { lines: [...lines.slice(0, -1), { ...last, amount: last.amount + leftToReturn - amount }], amount: leftToReturn };
}

/** The bonus base parts of a refund: its amount, bonus and certificate payment parts and the certificate lines it returns. */
function moneyOfRefund(certificateLineIds: ReadonlySet<number>) {
  return (r: RefundRecord): RefundMoney => ({
    amount: r.row.amount,
    payBonus: r.row.payBonus,
    payCertificate: r.row.payCertificate,
    certificateLines: r.items.filter((i) => certificateLineIds.has(i.saleItemId)).reduce((sum, i) => sum + i.amount, 0),
  });
}

/** Validates a refund of `sale` and works out its money — nothing is written (the preview and the refund share it). */
export function planRefund(db: DbOrTx, sale: SaleRow, requested: RefundLineInput[] | null | undefined, now: number): RefundPlan {
  const items = db.select().from(saleItems).where(eq(saleItems.saleId, sale.id)).orderBy(asc(saleItems.id)).all();
  if (sale.status === 'refunded' || items.every((i) => keptUnits(i) === 0)) throw conflict(`Чек №${sale.number} уже возвращён`);
  const wanted = requestedUnits(sale, items, requested);
  const previous = refundsBySales(db, [sale.id]).get(sale.id) ?? [];
  const final = items.every((item) => keptUnits(item) === (wanted.get(item.id) ?? 0));
  const { lines, amount } = refundLines(sale, items, wanted, previous, final);
  const rests = paymentRests(sale, previous);
  const payments = final ? rests : splitPayments(amount, rests);
  assertCertificatesRefundable(db, lines.flatMap((l) => (l.item.certificateId != null ? [l.item.certificateId] : [])));

  const current: RefundMoney = {
    amount,
    payBonus: payments.bonus,
    payCertificate: payments.certificate,
    certificateLines: lines.filter((l) => isCertificateLine(l.item)).reduce((sum, l) => sum + l.amount, 0),
  };
  const moneyOf = moneyOfRefund(new Set(items.filter(isCertificateLine).map((i) => i.id)));
  const earnings = saleEarnings(db, sale.id);
  const owed = bonusOwed(sale, items, earnings, previous.map(moneyOf), current, final);
  return {
    lines,
    amount,
    payments,
    bonusOwed: owed,
    bonusTakenBack: previewTakeBack(db, sale.clientId, earnings.lot, owed, payments.bonus, now),
    final,
    whole: final && previous.length === 0,
  };
}

/** Payments in the order of `Sale.payments`. */
const paymentsOut = (p: RefundPayments) => ({
  cash: p.cash,
  card: p.card,
  transfer: p.transfer,
  qr: p.qr,
  deposit: p.deposit,
  bonus: p.bonus,
  certificate: p.certificate,
});

/** `POST /sales/:id/refund/preview`: the refund as it would be recorded; `needsShift` when it returns cash without a shift. */
export function previewRefund(db: DbOrTx, saleId: number, requested: RefundLineInput[] | null | undefined) {
  const plan = planRefund(db, getSaleRow(db, saleId), requested, Date.now());
  return {
    amount: plan.amount,
    items: plan.lines.map((l) => ({ saleItemId: l.item.id, name: l.item.name, quantity: l.quantity, amount: l.amount })),
    payments: paymentsOut(plan.payments),
    bonusTakenBack: plan.bonusTakenBack,
    needsShift: plan.payments.cash > 0 && !getOpenShift(db),
  };
}

/**
 * The size a sold item goes back to. Every product item names one (items sold before sizes existed were linked to
 * their product's only size by the migration); a hand-edited row without it falls back to the product's first size.
 */
function soldVariantId(db: DbOrTx, productId: number, item: SaleItemRow): number {
  if (item.variantId != null) return item.variantId;
  const first = db
    .select({ id: productVariants.id })
    .from(productVariants)
    .where(eq(productVariants.productId, productId))
    .orderBy(asc(productVariants.archived), asc(productVariants.position), asc(productVariants.id))
    .get();
  if (!first) throw conflict(`Не найден размер товара «${item.name}» для возврата на склад`);
  return first.id;
}

/** Returned product units go back to the sold size (`return` movements). */
function restock(db: DbOrTx, lines: PlannedLine[], saleId: number, employeeId: number, reason: string): void {
  for (const { item, quantity } of lines) {
    if (item.type !== 'product' || item.productId == null) continue;
    // A product deleted since the sale has nowhere to return to: the money is refunded, the stock is not.
    if (getProductRow(db, item.productId).archived) continue;
    applyMovement(db, {
      productId: item.productId,
      variantId: returnVariantId(db, soldVariantId(db, item.productId, item)),
      delta: quantity,
      type: 'return',
      saleId,
      employeeId,
      note: reason,
    });
  }
}

interface RefundContext {
  sale: SaleRow;
  plan: RefundPlan;
  input: RefundInput;
  shiftId: number | null;
  employeeId: number;
  now: number;
}

/** Writes the refund and its lines, and moves the returned units and money onto the sale. Returns the updated sale. */
function recordRefund(tx: DbOrTx, { sale, plan, input, shiftId, employeeId, now }: RefundContext, bonusTakenBack: number): SaleRow {
  const p = plan.payments;
  const refund = tx
    .insert(saleRefunds)
    .values({
      saleId: sale.id,
      amount: plan.amount,
      payCash: p.cash,
      payCard: p.card,
      payTransfer: p.transfer,
      payQr: p.qr,
      payDeposit: p.deposit,
      payBonus: p.bonus,
      payCertificate: p.certificate,
      bonusTakenBack,
      restock: input.restock,
      reason: input.reason,
      employeeId,
      shiftId,
      createdAt: now,
    })
    .returning()
    .get();
  tx.insert(saleRefundItems)
    .values(plan.lines.map((l) => ({ refundId: refund.id, saleItemId: l.item.id, quantity: l.quantity, amount: l.amount })))
    .run();
  for (const line of plan.lines) {
    tx.update(saleItems)
      .set({ refundedQuantity: sql`${saleItems.refundedQuantity} + ${line.quantity}` })
      .where(eq(saleItems.id, line.item.id))
      .run();
  }
  // The legacy refund columns describe the refund that returned the rest.
  const closing = plan.final
    ? { status: 'refunded', refundedAt: now, refundReason: input.reason, refundShiftId: shiftId, refundedById: employeeId }
    : {};
  return tx
    .update(sales)
    .set({ refundedTotal: sale.refundedTotal + plan.amount, ...closing })
    .where(eq(sales.id, sale.id))
    .returning()
    .get()!;
}

/** `POST /sales/:id/refund`: records the refund and everything it gives back; returns the updated sale. */
export function refundSale(db: DbOrTx, saleId: number, input: RefundInput, employeeId: number): SaleRow {
  return db.transaction((tx) => {
    const sale = getSaleRow(tx, saleId);
    const now = Date.now();
    const plan = planRefund(tx, sale, input.items, now);
    const shift = getOpenShift(tx);
    // Cash handed back must be recorded against a shift, otherwise the drawer stops balancing.
    if (plan.payments.cash > 0 && !shift) throw conflict(NEEDS_SHIFT_MESSAGE);
    const context: RefundContext = { sale, plan, input, shiftId: shift?.id ?? null, employeeId, now };
    const p = plan.payments;
    const bonusTakenBack = reverseSaleBonuses(tx, sale, { givenBack: p.bonus, owed: plan.bonusOwed, whole: plan.whole }, employeeId, now);
    const updated = recordRefund(tx, context, bonusTakenBack);
    const note = `${plan.whole ? 'Возврат' : 'Частичный возврат'} чека №${sale.number}`;
    unapplyDeposit(tx, sale, { amount: p.deposit, shiftId: context.shiftId, note }, employeeId, now);
    returnCertificatePayment(tx, sale.id, p.certificate, employeeId, now);
    const sold = plan.lines.flatMap((l) => (l.item.certificateId != null ? [l.item.certificateId] : []));
    cancelSoldCertificates(tx, sold, sale.id, employeeId, now);
    if (input.restock) restock(tx, plan.lines, sale.id, employeeId, input.reason);
    return updated;
  });
}
