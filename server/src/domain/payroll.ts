import { DateTime } from 'luxon';
import type { DbOrTx } from '../db/client.js';
import { employees } from '../db/schema.js';
import { badRequest } from '../lib/errors.js';
import { employeeRef, type EmployeeRow, type SaleItemRow } from '../lib/serialize.js';
import { localDate } from '../lib/time.js';
import { adjustmentsInPeriod, adjustmentsOut, type AdjustmentRow } from './payroll-adjustments.js';
import { loadPayrollData, type PayrollData, type PayrollVisit } from './payroll-data.js';
import { ruleVersionsByEmployee, rulesOn, type PayRules, type RuleVersion } from './payroll-rules.js';
import { keptLineRevenues, keptUnits } from './sale-revenue.js';
import { studioTimezone } from './settings.js';

/**
 * Payroll statements (docs/API.md «PayrollStatement»). A visit counts on its own studio date (`startsAt`) with its
 * sales, whenever they were paid; a product line counts on the day of its sale. Lines count by their kept units (what
 * refunds have not returned), a line returned in full not at all. Every visit, sale and day
 * is counted by the pay rules version in force that day.
 */

export const MAX_PERIOD_DAYS = 400;
/** Category of service lines without a catalog service (custom lines, deleted services). */
const FALLBACK_CATEGORY = 'other';

export interface PayrollPeriod {
  from: string;
  to: string;
  /** Every studio date of the period. */
  dates: string[];
  /** `[start, end)` instants of the period in the studio timezone. */
  start: number;
  end: number;
  tz: string;
}

/** Validates a period of studio dates (inclusive) and resolves its instants. */
export function payrollPeriod(db: DbOrTx, from: string, to: string): PayrollPeriod {
  if (to < from) throw badRequest('Конец периода должен быть не раньше начала');
  const tz = studioTimezone(db);
  const first = DateTime.fromISO(from, { zone: tz }).startOf('day');
  const last = DateTime.fromISO(to, { zone: tz }).startOf('day');
  const count = Math.round(last.diff(first, 'days').days) + 1;
  if (count > MAX_PERIOD_DAYS) throw badRequest(`Период — не больше ${MAX_PERIOD_DAYS} дней`);
  const dates = Array.from({ length: count }, (_, i) => first.plus({ days: i }).toISODate() ?? '');
  return { from, to, dates, start: first.toMillis(), end: last.plus({ days: 1 }).toMillis(), tz };
}

export interface PayrollLine {
  date: string;
  kind: 'service' | 'product';
  appointmentId: number | null;
  saleId: number;
  name: string;
  category: string | null;
  revenue: number;
  materials: number;
  percent: number;
  amount: number;
}

/** A line with what orders it within its day (visit start or sale time, then the receipt line). */
type SortedLine = PayrollLine & { at: number; itemId: number };

/** Splits `amount` across `weights` proportionally (whole rubles, the rounding remainder to the last). */
export function splitByWeight(amount: number, weights: number[]): number[] {
  const total = weights.reduce((s, w) => s + w, 0);
  let given = 0;
  return weights.map((weight, index) => {
    const isLast = index === weights.length - 1;
    // Rounded-up shares never take more than is left, so the last one never goes negative.
    const rounded = total > 0 ? Math.min(Math.round((amount * weight) / total), amount - given) : 0;
    const share = isLast ? amount - given : Math.max(0, rounded);
    given += share;
    return share;
  });
}

const percentOf = (base: number, percent: number) => Math.round((Math.max(0, base) * percent) / 100);

function servicePercent(rules: PayRules | null, category: string): number {
  if (!rules) return 0;
  return (rules.categoryPercent as Record<string, number | null>)[category] ?? rules.servicePercent;
}

/**
 * Service lines of one visit: its sales' service items after the discount and the bonuses paid (a discount too),
 * minus the visit's materials. Gift certificate lines are neither services nor products.
 */
function visitLines(data: PayrollData, visit: PayrollVisit, versions: RuleVersion[], tz: string): SortedLine[] {
  const date = localDate(visit.startsAt, tz);
  const rules = rulesOn(versions, date);
  const served: Array<{ saleId: number; item: SaleItemRow; revenue: number }> = [];
  for (const sale of data.visitSales.get(visit.id) ?? []) {
    const items = data.visitItems.get(sale.id) ?? [];
    const net = keptLineRevenues(sale, items);
    items.forEach((item, i) => {
      if (item.type === 'service' && keptUnits(item) > 0) served.push({ saleId: sale.id, item, revenue: net[i] ?? 0 });
    });
  }
  const materials = rules?.deductMaterials ? (data.materials.get(visit.id) ?? 0) : 0;
  const shares = splitByWeight(materials, served.map((s) => s.revenue));
  return served.map(({ saleId, item, revenue }, i) => {
    const category = (item.serviceId != null ? data.categories.get(item.serviceId) : undefined) ?? FALLBACK_CATEGORY;
    const percent = servicePercent(rules, category);
    const share = shares[i] ?? 0;
    return {
      date, kind: 'service', appointmentId: visit.id, saleId, name: item.name, category,
      revenue, materials: share, percent, amount: percentOf(revenue - share, percent), at: visit.startsAt, itemId: item.id,
    };
  });
}

/** Whom a sale's products count for: the master of its visit, else the employee who made the sale. */
const sellerOf = (sale: { appointmentId: number | null; masterId: number | null; employeeId: number }) =>
  sale.appointmentId != null && sale.masterId != null ? sale.masterId : sale.employeeId;

function productLines(data: PayrollData, employeeId: number, versions: RuleVersion[], tz: string): SortedLine[] {
  const lines: SortedLine[] = [];
  for (const sale of data.sales.kept) {
    if (sellerOf(sale) !== employeeId) continue;
    const date = localDate(sale.createdAt, tz);
    const percent = rulesOn(versions, date)?.productPercent ?? 0;
    const items = data.sales.itemsBySale.get(sale.id) ?? [];
    const net = keptLineRevenues(sale, items);
    items.forEach((item, i) => {
      if (item.type !== 'product' || keptUnits(item) <= 0) return;
      const revenue = net[i] ?? 0;
      lines.push({
        date, kind: 'product', appointmentId: sale.appointmentId, saleId: sale.id, name: item.name, category: null,
        revenue, materials: 0, percent, amount: percentOf(revenue, percent), at: sale.createdAt, itemId: item.id,
      });
    });
  }
  return lines;
}

/** `salaryMonthly / days in that month` for every day of the period with rules in force. */
function salaryOf(period: PayrollPeriod, versions: RuleVersion[]): number {
  const total = period.dates.reduce((sum, date) => {
    const rules = rulesOn(versions, date);
    if (!rules) return sum;
    return sum + rules.salaryMonthly / (DateTime.fromISO(date).daysInMonth ?? 30);
  }, 0);
  return Math.round(total);
}

const sumOf = <T>(list: readonly T[], pick: (x: T) => number) => list.reduce((s, x) => s + pick(x), 0);

interface Computed {
  summary: ReturnType<typeof summarize>;
  lines: PayrollLine[];
  adjustments: AdjustmentRow[];
}

/** What a statement is added up from: the lines, the visits and worked days of the period, the rules and adjustments. */
interface Counted {
  employee: EmployeeRow;
  period: PayrollPeriod;
  lines: PayrollLine[];
  visits: number;
  days: string[];
  versions: RuleVersion[];
  adjustments: AdjustmentRow[];
}

function summarize({ employee, period, lines, visits, days, versions, adjustments }: Counted) {
  const services = lines.filter((l) => l.kind === 'service');
  const products = lines.filter((l) => l.kind === 'product');
  const adjusted = (kind: string) => sumOf(adjustments.filter((a) => a.kind === kind), (a) => a.amount);
  const servicesAmount = sumOf(services, (l) => l.amount);
  const productsAmount = sumOf(products, (l) => l.amount);
  const salary = salaryOf(period, versions);
  const perDay = sumOf(days, (date) => rulesOn(versions, date)?.perDay ?? 0);
  const totals = { bonus: adjusted('bonus'), penalty: adjusted('penalty'), advance: adjusted('advance'), payout: adjusted('payout') };
  const earned = servicesAmount + productsAmount + salary + perDay + totals.bonus - totals.penalty;
  const paid = totals.advance + totals.payout;
  return {
    employee: employeeRef(employee),
    from: period.from,
    to: period.to,
    services: { visits, revenue: sumOf(services, (l) => l.revenue), materials: sumOf(services, (l) => l.materials), amount: servicesAmount },
    products: { revenue: sumOf(products, (l) => l.revenue), amount: productsAmount },
    salary,
    days: days.length,
    perDay,
    adjustments: totals,
    earned,
    paid,
    due: earned - paid,
  };
}

function compute(employee: EmployeeRow, period: PayrollPeriod, data: PayrollData, versions: RuleVersion[], adjustments: AdjustmentRow[]): Computed {
  const visits = data.visits.filter((v) => v.masterId === employee.id);
  const sorted = [...visits.flatMap((v) => visitLines(data, v, versions, period.tz)), ...productLines(data, employee.id, versions, period.tz)].sort(
    (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.at - b.at || a.itemId - b.itemId),
  );
  const lines = sorted.map(({ at: _at, itemId: _itemId, ...line }) => line);
  const days = new Set(visits.map((v) => localDate(v.startsAt, period.tz)));
  for (const sale of data.sales.made) if (sale.employeeId === employee.id) days.add(localDate(sale.createdAt, period.tz));
  return {
    summary: summarize({ employee, period, lines, visits: visits.length, days: [...days], versions, adjustments }),
    lines,
    adjustments,
  };
}

function hasActivity(employeeId: number, data: PayrollData, adjustments: AdjustmentRow[]): boolean {
  return (
    data.visits.some((v) => v.masterId === employeeId) ||
    data.sales.made.some((s) => s.employeeId === employeeId || sellerOf(s) === employeeId) ||
    adjustments.some((a) => a.employeeId === employeeId)
  );
}

/**
 * Statements of the `only` employees, or (`null`) of every employee with rules in force by the end of the period or any
 * activity in it; by name.
 */
function computeAll(db: DbOrTx, period: PayrollPeriod, only: EmployeeRow[] | null): Computed[] {
  const data = loadPayrollData(db, period.start, period.end);
  const versions = ruleVersionsByEmployee(db);
  const adjustments = adjustmentsInPeriod(db, period.from, period.to);
  const candidates = only ?? db.select().from(employees).all().filter((e) => {
    const hasRules = (versions.get(e.id) ?? []).some((v) => v.effectiveFrom <= period.to);
    return hasRules || hasActivity(e.id, data, adjustments);
  });
  return [...candidates]
    .sort((a, b) => a.name.localeCompare(b.name, 'ru') || a.id - b.id)
    .map((e) => compute(e, period, data, versions.get(e.id) ?? [], adjustments.filter((a) => a.employeeId === e.id)));
}

/** `GET /payroll`: every statement for the owner, `only` the given employees for everyone else. */
export function payrollList(db: DbOrTx, period: PayrollPeriod, only: EmployeeRow[] | null) {
  return { from: period.from, to: period.to, items: computeAll(db, period, only).map((c) => c.summary) };
}

/** `GET /payroll/:employeeId`: the statement with its lines and adjustments. */
export function payrollStatement(db: DbOrTx, period: PayrollPeriod, employee: EmployeeRow) {
  const [computed] = computeAll(db, period, [employee]);
  return { ...computed!.summary, lines: computed!.lines, adjustmentItems: adjustmentsOut(db, computed!.adjustments) };
}
