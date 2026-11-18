import { and, asc, desc, eq, gte, isNull, lte, or } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { studioExpenses } from '../db/schema.js';
import { badRequest, notFound } from '../lib/errors.js';
import { toIso } from '../lib/time.js';
import { employeeRefOrMissing, employeesByIds } from './refs.js';

/**
 * Studio expenses outside the warehouse (docs/API.md «Expenses»): monthly ones (rent, electricity) are charged on the
 * day of their `date` every month until `endDate`; one-time ones (a wardrobe) on their `date`.
 */

export const EXPENSE_CATEGORIES = ['rent', 'utilities', 'internet', 'furniture', 'repair', 'marketing', 'other'] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];
export const EXPENSE_REPEATS = ['monthly', 'once'] as const;
export type ExpenseRepeat = (typeof EXPENSE_REPEATS)[number];

export type ExpenseRow = typeof studioExpenses.$inferSelect;

export interface ExpenseInput {
  name: string;
  category: ExpenseCategory;
  amount: number;
  repeat: ExpenseRepeat;
  date: string;
  endDate: string | null;
  note: string | null;
}

function assertValid(input: ExpenseInput): void {
  if (input.repeat === 'once' && input.endDate) throw badRequest('У разового расхода нет даты окончания');
  if (input.endDate && input.endDate < input.date) throw badRequest('Дата окончания раньше даты начала');
}

export function createExpense(db: DbOrTx, input: ExpenseInput, createdBy: number): ExpenseRow {
  assertValid(input);
  const now = Date.now();
  return db
    .insert(studioExpenses)
    .values({ ...input, createdBy, createdAt: now, updatedAt: now })
    .returning()
    .get();
}

export function getExpense(db: DbOrTx, id: number): ExpenseRow {
  const row = db.select().from(studioExpenses).where(eq(studioExpenses.id, id)).get();
  if (!row) throw notFound('Расход не найден');
  return row;
}

export function updateExpense(db: DbOrTx, id: number, patch: Partial<ExpenseInput>): ExpenseRow {
  const current = getExpense(db, id);
  const repeat = patch.repeat ?? (current.repeat as ExpenseRepeat);
  const next: ExpenseInput = {
    name: patch.name ?? current.name,
    category: patch.category ?? (current.category as ExpenseCategory),
    amount: patch.amount ?? current.amount,
    repeat,
    date: patch.date ?? current.date,
    // Turning a monthly expense into a one-time one drops its end date.
    endDate: repeat === 'once' ? null : patch.endDate !== undefined ? patch.endDate : current.endDate,
    note: patch.note !== undefined ? patch.note : current.note,
  };
  assertValid(next);
  return db
    .update(studioExpenses)
    .set({ ...next, updatedAt: Date.now() })
    .where(eq(studioExpenses.id, id))
    .returning()
    .get()!;
}

export function deleteExpense(db: DbOrTx, id: number): void {
  const removed = db.delete(studioExpenses).where(eq(studioExpenses.id, id)).returning({ id: studioExpenses.id }).get();
  if (!removed) throw notFound('Расход не найден');
}

/** Monthly ones first, then one-time ones; newest first in each. */
export function listExpenses(db: DbOrTx): ExpenseRow[] {
  return db
    .select()
    .from(studioExpenses)
    .orderBy(asc(studioExpenses.repeat), desc(studioExpenses.date), desc(studioExpenses.id))
    .all();
}

const pad = (n: number) => String(n).padStart(2, '0');

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The dates within `[from, to]` (studio dates, inclusive) an expense is charged on. A monthly one is charged on the
 * day of its `date`, or on the last day of a shorter month (rent of the 31st falls on 30 April).
 */
export function chargeDates(row: Pick<ExpenseRow, 'repeat' | 'date' | 'endDate'>, from: string, to: string): string[] {
  if (row.repeat !== 'monthly') return row.date >= from && row.date <= to ? [row.date] : [];
  const last = row.endDate && row.endDate < to ? row.endDate : to;
  const [startYear, startMonth, day] = row.date.split('-').map(Number) as [number, number, number];
  const [fromYear, fromMonth] = from.split('-').map(Number) as [number, number];
  const dates: string[] = [];
  // Months counted from year 0: `index = year * 12 + (month - 1)`.
  for (let index = Math.max(startYear * 12 + startMonth - 1, fromYear * 12 + fromMonth - 1); ; index++) {
    const year = Math.floor(index / 12);
    const month = (index % 12) + 1;
    const date = `${year}-${pad(month)}-${pad(Math.min(day, daysInMonth(year, month)))}`;
    if (date > last) break;
    if (date >= from) dates.push(date);
  }
  return dates;
}

/** The expenses charged within `[from, to]` (studio dates, inclusive): totals, by category and by expense. */
export function expensesInPeriod(db: DbOrTx, from: string, to: string) {
  const rows = db
    .select()
    .from(studioExpenses)
    .where(and(lte(studioExpenses.date, to), or(isNull(studioExpenses.endDate), gte(studioExpenses.endDate, from))))
    .all();
  const items = rows
    .map((row) => ({ row, times: chargeDates(row, from, to).length }))
    .filter((x) => x.times > 0)
    .map(({ row, times }) => ({
      id: row.id,
      name: row.name,
      category: row.category,
      repeat: row.repeat,
      times,
      amount: row.amount * times,
    }))
    .sort((a, b) => b.amount - a.amount || a.id - b.id);
  const sum = (repeat: ExpenseRepeat) => items.filter((i) => i.repeat === repeat).reduce((s, i) => s + i.amount, 0);
  const byCategory = EXPENSE_CATEGORIES.map((category) => ({
    category,
    amount: items.filter((i) => i.category === category).reduce((s, i) => s + i.amount, 0),
  }))
    .filter((c) => c.amount > 0)
    .sort((a, b) => b.amount - a.amount);
  const monthly = sum('monthly');
  const once = sum('once');
  return { total: monthly + once, monthly, once, byCategory, items };
}

export type ExpensesSection = ReturnType<typeof expensesInPeriod>;

export function expensesOut(db: DbOrTx, rows: ExpenseRow[]) {
  const people = employeesByIds(db, rows.map((r) => r.createdBy));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    category: r.category,
    amount: r.amount,
    repeat: r.repeat,
    date: r.date,
    endDate: r.endDate,
    note: r.note,
    createdBy: employeeRefOrMissing(people, r.createdBy),
    createdAt: toIso(r.createdAt),
    updatedAt: toIso(r.updatedAt),
  }));
}
