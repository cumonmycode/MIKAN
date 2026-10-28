import { asc, count, desc, eq, isNull, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { cashOperations, cashShifts, depositOperations, saleRefunds, sales } from '../db/schema.js';
import { conflict, notFound } from '../lib/errors.js';
import { cashOpOut, type ShiftRow } from '../lib/serialize.js';
import { formatShortDateTime, toIso } from '../lib/time.js';
import { employeeRefOrMissing, employeesByIds } from './refs.js';
import { refundMoneySql, saleMoneySql } from './sale-revenue.js';
import { studioTimezone } from './settings.js';

/** Prepayment operations recorded while the shift was open (`deposit_operations.shift_id`). */
export interface ShiftDeposits {
  received: number;
  cash: number;
  card: number;
  transfer: number;
  qr: number;
  refunded: number;
  cashRefunded: number;
  retained: number;
}

export interface ShiftSummary {
  salesCount: number;
  revenue: number;
  cash: number;
  card: number;
  transfer: number;
  qr: number;
  /** Part of `revenue` covered by prepayments received earlier (not cash in the drawer now). */
  deposit: number;
  refunds: number;
  cashRefunds: number;
  cashIn: number;
  cashOut: number;
  deposits: ShiftDeposits;
}

const sumWhen = (condition: ReturnType<typeof sql>) =>
  sql<number>`coalesce(sum(case when ${condition} then ${depositOperations.amount} end), 0)`;

function shiftDeposits(db: DbOrTx, shiftId: number): ShiftDeposits {
  const receive = sql`${depositOperations.type} = 'receive'`;
  const refund = sql`${depositOperations.type} = 'refund'`;
  const row = db
    .select({
      received: sumWhen(receive),
      cash: sumWhen(sql`${receive} and ${depositOperations.method} = 'cash'`),
      card: sumWhen(sql`${receive} and ${depositOperations.method} = 'card'`),
      transfer: sumWhen(sql`${receive} and ${depositOperations.method} = 'transfer'`),
      qr: sumWhen(sql`${receive} and ${depositOperations.method} = 'qr'`),
      refunded: sumWhen(refund),
      cashRefunded: sumWhen(sql`${refund} and ${depositOperations.method} = 'cash'`),
      retained: sumWhen(sql`${depositOperations.type} = 'retain'`),
    })
    .from(depositOperations)
    .where(eq(depositOperations.shiftId, shiftId))
    .get();
  return {
    received: row?.received ?? 0,
    cash: row?.cash ?? 0,
    card: row?.card ?? 0,
    transfer: row?.transfer ?? 0,
    qr: row?.qr ?? 0,
    refunded: row?.refunded ?? 0,
    cashRefunded: row?.cashRefunded ?? 0,
    retained: row?.retained ?? 0,
  };
}

export function getOpenShift(db: DbOrTx): ShiftRow | null {
  return db.select().from(cashShifts).where(isNull(cashShifts.closedAt)).orderBy(desc(cashShifts.id)).get() ?? null;
}

/**
 * Sales made in the shift (whatever their later status) are counted as income; refunds (whole or partial) made
 * while the shift was open are counted separately by their money, so cash in the drawer stays consistent. Prepayments enter the
 * drawer when received (`deposits.cash`); a sale only consumes them (`deposit`), so they are never counted twice.
 */
export function shiftSummary(db: DbOrTx, shiftId: number): ShiftSummary {
  const salesAgg = db
    .select({
      n: count(),
      revenue: sql<number>`coalesce(sum(${saleMoneySql}), 0)`,
      cash: sql<number>`coalesce(sum(${sales.payCash}), 0)`,
      card: sql<number>`coalesce(sum(${sales.payCard}), 0)`,
      transfer: sql<number>`coalesce(sum(${sales.payTransfer}), 0)`,
      qr: sql<number>`coalesce(sum(${sales.payQr}), 0)`,
      deposit: sql<number>`coalesce(sum(${sales.payDeposit}), 0)`,
    })
    .from(sales)
    .where(eq(sales.shiftId, shiftId))
    .get();
  const refundAgg = db
    .select({
      refunds: sql<number>`coalesce(sum(${refundMoneySql}), 0)`,
      cashRefunds: sql<number>`coalesce(sum(${saleRefunds.payCash}), 0)`,
    })
    .from(saleRefunds)
    .where(eq(saleRefunds.shiftId, shiftId))
    .get();
  const opsAgg = db
    .select({
      cashIn: sql<number>`coalesce(sum(case when ${cashOperations.type} = 'in' then ${cashOperations.amount} end), 0)`,
      cashOut: sql<number>`coalesce(sum(case when ${cashOperations.type} = 'out' then ${cashOperations.amount} end), 0)`,
    })
    .from(cashOperations)
    .where(eq(cashOperations.shiftId, shiftId))
    .get();
  return {
    salesCount: salesAgg?.n ?? 0,
    revenue: salesAgg?.revenue ?? 0,
    cash: salesAgg?.cash ?? 0,
    card: salesAgg?.card ?? 0,
    transfer: salesAgg?.transfer ?? 0,
    qr: salesAgg?.qr ?? 0,
    deposit: salesAgg?.deposit ?? 0,
    refunds: refundAgg?.refunds ?? 0,
    cashRefunds: refundAgg?.cashRefunds ?? 0,
    cashIn: opsAgg?.cashIn ?? 0,
    cashOut: opsAgg?.cashOut ?? 0,
    deposits: shiftDeposits(db, shiftId),
  };
}

export function expectedCashFor(openingCash: number, s: ShiftSummary): number {
  return openingCash + s.cash - s.cashRefunds + s.deposits.cash - s.deposits.cashRefunded + s.cashIn - s.cashOut;
}

export function serializeShift(db: DbOrTx, shift: ShiftRow, withOperations: boolean) {
  const summary = shiftSummary(db, shift.id);
  const expectedCash = shift.closedAt != null && shift.expectedCash != null
    ? shift.expectedCash
    : expectedCashFor(shift.openingCash, summary);
  const ops = withOperations
    ? db.select().from(cashOperations).where(eq(cashOperations.shiftId, shift.id)).orderBy(asc(cashOperations.id)).all()
    : [];
  const emps = employeesByIds(db, [shift.openedById, shift.closedById, ...ops.map((o) => o.employeeId)]);
  return {
    id: shift.id,
    openedAt: toIso(shift.openedAt),
    openedBy: employeeRefOrMissing(emps, shift.openedById),
    openingCash: shift.openingCash,
    closedAt: toIso(shift.closedAt),
    closedBy: employeeRefOrMissing(emps, shift.closedById),
    closingCash: shift.closingCash,
    note: shift.note,
    expectedCash,
    difference: shift.closedAt != null && shift.closingCash != null ? shift.closingCash - expectedCash : null,
    summary,
    operations: ops.map((o) => cashOpOut(o, employeeRefOrMissing(emps, o.employeeId)!)),
  };
}

export function getShiftRow(db: DbOrTx, id: number): ShiftRow {
  const row = db.select().from(cashShifts).where(eq(cashShifts.id, id)).get();
  if (!row) throw notFound('Смена не найдена');
  return row;
}

export function openShift(db: DbOrTx, openingCash: number, employeeId: number): ShiftRow {
  return db.transaction((tx) => {
    const open = getOpenShift(tx);
    if (open) {
      throw conflict(`Смена уже открыта (с ${formatShortDateTime(open.openedAt, studioTimezone(tx))})`);
    }
    return tx
      .insert(cashShifts)
      .values({ openedAt: Date.now(), openedById: employeeId, openingCash })
      .returning()
      .get();
  });
}

export function closeShift(db: DbOrTx, input: { closingCash: number; note?: string | null }, employeeId: number) {
  return db.transaction((tx) => {
    const open = getOpenShift(tx);
    if (!open) throw conflict('Нет открытой смены');
    const expected = expectedCashFor(open.openingCash, shiftSummary(tx, open.id));
    return tx
      .update(cashShifts)
      .set({
        closedAt: Date.now(),
        closedById: employeeId,
        closingCash: input.closingCash,
        expectedCash: expected,
        note: input.note ?? open.note,
      })
      .where(eq(cashShifts.id, open.id))
      .returning()
      .get();
  });
}

export function addCashOperation(
  db: DbOrTx,
  input: { type: 'in' | 'out'; amount: number; reason: string },
  employeeId: number,
) {
  return db.transaction((tx) => {
    const open = getOpenShift(tx);
    if (!open) throw conflict('Сначала откройте кассовую смену');
    return tx
      .insert(cashOperations)
      .values({ shiftId: open.id, type: input.type, amount: input.amount, reason: input.reason, employeeId, createdAt: Date.now() })
      .returning()
      .get();
  });
}

export function listShifts(db: DbOrTx, limit: number, offset: number) {
  const rows = db.select().from(cashShifts).orderBy(desc(cashShifts.openedAt), desc(cashShifts.id)).limit(limit).offset(offset).all();
  const total = db.select({ n: count() }).from(cashShifts).get()?.n ?? 0;
  return { items: rows.map((r) => serializeShift(db, r, false)), total };
}
