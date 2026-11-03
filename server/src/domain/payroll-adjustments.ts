import { and, asc, eq, gte, lte } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { employees, payrollAdjustments } from '../db/schema.js';
import { badRequest, notFound } from '../lib/errors.js';
import { toIso } from '../lib/time.js';
import { addCashOperation } from './cash.js';
import { employeeRefOrMissing, employeesByIds } from './refs.js';

/** Manual payroll entries (docs/API.md «PayrollAdjustment»): bonuses and penalties change pay, advances and payouts pay it. */

export const ADJUSTMENT_KINDS = ['bonus', 'penalty', 'advance', 'payout'] as const;
export type AdjustmentKind = (typeof ADJUSTMENT_KINDS)[number];

/** How a cash withdrawal for a kind paid from the till is named: «Аванс: Фатима». */
const CASH_REASON: Partial<Record<AdjustmentKind, string>> = { advance: 'Аванс', payout: 'Выплата' };

export type AdjustmentRow = typeof payrollAdjustments.$inferSelect;

export interface AdjustmentInput {
  employeeId: number;
  date: string;
  kind: AdjustmentKind;
  amount: number;
  note: string | null;
  fromCash: boolean;
}

/** Records an adjustment; `fromCash` also withdraws the amount from the open shift (`409` without one). */
export function createAdjustment(db: DbOrTx, input: AdjustmentInput, createdBy: number): AdjustmentRow {
  const reason = CASH_REASON[input.kind];
  if (input.fromCash && !reason) throw badRequest('Из кассы можно выдать только аванс или выплату');
  return db.transaction((tx) => {
    const employee = tx.select().from(employees).where(eq(employees.id, input.employeeId)).get();
    if (!employee) throw notFound('Сотрудник не найден');
    const cash = input.fromCash && reason
      ? addCashOperation(tx, { type: 'out', amount: input.amount, reason: `${reason}: ${employee.name}` }, createdBy)
      : null;
    return tx
      .insert(payrollAdjustments)
      .values({
        employeeId: input.employeeId,
        date: input.date,
        kind: input.kind,
        amount: input.amount,
        note: input.note,
        cashOperationId: cash?.id ?? null,
        createdBy,
        createdAt: Date.now(),
      })
      .returning()
      .get();
  });
}

/** Removes an adjustment; its cash withdrawal, if any, stays (corrected in the till). */
export function deleteAdjustment(db: DbOrTx, id: number): void {
  const removed = db.delete(payrollAdjustments).where(eq(payrollAdjustments.id, id)).returning({ id: payrollAdjustments.id }).get();
  if (!removed) throw notFound('Операция по зарплате не найдена');
}

/** Adjustments dated within `[from, to]` (studio dates), by date. */
export function adjustmentsInPeriod(db: DbOrTx, from: string, to: string): AdjustmentRow[] {
  return db
    .select()
    .from(payrollAdjustments)
    .where(and(gte(payrollAdjustments.date, from), lte(payrollAdjustments.date, to)))
    .orderBy(asc(payrollAdjustments.date), asc(payrollAdjustments.id))
    .all();
}

export function adjustmentsOut(db: DbOrTx, rows: AdjustmentRow[]) {
  const people = employeesByIds(db, rows.flatMap((r) => [r.employeeId, r.createdBy]));
  return rows.map((r) => ({
    id: r.id,
    employee: employeeRefOrMissing(people, r.employeeId)!,
    date: r.date,
    kind: r.kind,
    amount: r.amount,
    note: r.note,
    cashOperationId: r.cashOperationId,
    createdBy: employeeRefOrMissing(people, r.createdBy),
    createdAt: toIso(r.createdAt),
  }));
}
