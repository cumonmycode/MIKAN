import { asc, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { DbOrTx } from '../db/client.js';
import { payRules } from '../db/schema.js';
import { toIso } from '../lib/time.js';
import { money } from '../lib/validation.js';
import { employeeRefOrMissing, employeesByIds } from './refs.js';

/**
 * Pay rules (docs/API.md «PayRules»): how an employee is paid, versioned by `effectiveFrom` (a studio date). Each day
 * is counted by the version in force that day; days before the first version earn nothing.
 */

export const SERVICE_CATEGORIES = ['tattoo', 'piercing', 'other'] as const;
export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number];

const percent = z.number().min(0).max(100);
const optionalPercent = percent.nullish().transform((v) => v ?? 0);

/** The rules of a version; every omitted number is 0 (`categoryPercent` entries: `null` = use `servicePercent`). */
export const payRulesInput = z.object({
  salaryMonthly: money.nullish().transform((v) => v ?? 0),
  perDay: money.nullish().transform((v) => v ?? 0),
  servicePercent: optionalPercent,
  categoryPercent: z
    .object({ tattoo: percent.nullish(), piercing: percent.nullish(), other: percent.nullish() })
    .nullish()
    .transform((v) => ({ tattoo: v?.tattoo ?? null, piercing: v?.piercing ?? null, other: v?.other ?? null })),
  productPercent: optionalPercent,
  deductMaterials: z.boolean().nullish().transform((v) => v ?? false),
});

export type PayRules = z.output<typeof payRulesInput>;

export interface RuleVersion {
  effectiveFrom: string;
  rules: PayRules;
  createdBy: number | null;
  createdAt: number;
}

type PayRulesRow = typeof payRules.$inferSelect;

/** Stored JSON → rules; anything unreadable falls back to the defaults rather than failing a statement. */
function parseStored(json: string): PayRules {
  let raw: unknown = {};
  try {
    raw = JSON.parse(json);
  } catch {
    raw = {};
  }
  const parsed = payRulesInput.safeParse(raw);
  return parsed.success ? parsed.data : payRulesInput.parse({});
}

const versionOf = (row: PayRulesRow): RuleVersion => ({
  effectiveFrom: row.effectiveFrom,
  rules: parseStored(row.rules),
  createdBy: row.createdBy,
  createdAt: row.createdAt,
});

/** Every version of each employee, oldest `effectiveFrom` first. */
export function ruleVersionsByEmployee(db: DbOrTx, employeeIds?: number[]): Map<number, RuleVersion[]> {
  const rows = db
    .select()
    .from(payRules)
    .where(employeeIds ? inArray(payRules.employeeId, employeeIds) : undefined)
    .orderBy(asc(payRules.employeeId), asc(payRules.effectiveFrom))
    .all();
  const result = new Map<number, RuleVersion[]>();
  for (const row of rows) result.set(row.employeeId, [...(result.get(row.employeeId) ?? []), versionOf(row)]);
  return result;
}

/** The version in force on a studio date (versions sorted oldest first); `null` before the first one. */
export function rulesOn(versions: readonly RuleVersion[], date: string): PayRules | null {
  let found: PayRules | null = null;
  for (const version of versions) {
    if (version.effectiveFrom > date) break;
    found = version.rules;
  }
  return found;
}

/** `GET /employees/:id/pay-rules`: the version in force today and the history, newest first. */
export function payRulesOut(db: DbOrTx, employeeId: number, today: string) {
  const versions = ruleVersionsByEmployee(db, [employeeId]).get(employeeId) ?? [];
  const authors = employeesByIds(db, versions.map((v) => v.createdBy));
  return {
    current: rulesOn(versions, today),
    history: [...versions].reverse().map((v) => ({
      effectiveFrom: v.effectiveFrom,
      rules: v.rules,
      createdBy: employeeRefOrMissing(authors, v.createdBy),
      createdAt: toIso(v.createdAt),
    })),
  };
}

/** Saves a version; the same `effectiveFrom` replaces that version. */
export function savePayRules(db: DbOrTx, employeeId: number, effectiveFrom: string, rules: PayRules, createdBy: number): void {
  const values = { employeeId, effectiveFrom, rules: JSON.stringify(rules), createdBy, createdAt: Date.now() };
  db.insert(payRules)
    .values(values)
    .onConflictDoUpdate({ target: [payRules.employeeId, payRules.effectiveFrom], set: { rules: values.rules, createdBy, createdAt: values.createdAt } })
    .run();
}
