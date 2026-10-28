import { eq, inArray } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { appointments, employees } from '../db/schema.js';
import { badRequest } from '../lib/errors.js';
import { parseMasterPrices, parseVariants, type MasterPrice, type ServiceRow, type ServiceVariant } from '../lib/serialize.js';

/**
 * Masters' own prices (docs/API.md «Service» `masterPrices`): the one rule every channel prices a booked or sold line
 * by — appointments, online booking, open receipts and sales.
 */

type PricedService = Pick<ServiceRow, 'price' | 'variantsJson' | 'masterPricesJson'>;

/** Variant names match the way online booking picks them: trimmed, any case. */
export const variantKey = (name: string): string => name.trim().toLowerCase();

/** The master's own prices of the service, `null` when they charge the catalog price (or no master is known). */
export function masterPriceOf(service: Pick<ServiceRow, 'masterPricesJson'>, masterId: number | null): MasterPrice | null {
  if (masterId == null) return null;
  return parseMasterPrices(service.masterPricesJson).find((m) => m.employeeId === masterId) ?? null;
}

/**
 * The price of a line for a master: their variant override ?? the variant's `price` (a variant line), or their
 * `price` ?? the service's `price` (no variant, or a variant the service no longer has). `masterId` null = catalog.
 */
export function servicePriceFor(service: PricedService, variantName: string | null, masterId: number | null): number {
  const own = masterPriceOf(service, masterId);
  if (variantName != null) {
    const key = variantKey(variantName);
    const variant = parseVariants(service.variantsJson).find((v) => variantKey(v.name) === key);
    if (variant) return own?.variants.find((v) => variantKey(v.name) === key)?.price ?? variant.price;
  }
  return own?.price ?? service.price;
}

/** `employeeId` when that employee is an active master (their own prices apply), else null — the catalog price. */
export function pricingMaster(db: DbOrTx, employeeId: number | null | undefined): number | null {
  if (employeeId == null) return null;
  const row = db
    .select({ active: employees.active, isMaster: employees.isMaster })
    .from(employees)
    .where(eq(employees.id, employeeId))
    .get();
  return row?.active && row.isMaster ? employeeId : null;
}

/**
 * Whose prices a receipt or sale line defaults to: the appointment's master, else the employee at the till when they
 * are a master, else nobody (the catalog price).
 */
export function tillPricingMaster(db: DbOrTx, appointmentId: number | null | undefined, employeeId: number | null): number | null {
  if (appointmentId != null) {
    const appointment = db.select({ masterId: appointments.masterId }).from(appointments).where(eq(appointments.id, appointmentId)).get();
    if (appointment) return pricingMaster(db, appointment.masterId);
  }
  return pricingMaster(db, employeeId);
}

/** A master's prices as staff send them (`POST/PATCH /services` `masterPrices`). */
export interface MasterPriceInput {
  employeeId: number;
  price: number;
  priceMax?: number | null;
  variants?: Array<{ name: string; price: number }>;
}

/**
 * Validates the masters' prices against the service as it will be saved and returns the JSON to store: distinct
 * masters, each an existing employee with `isMaster` (one already stored keeps their entry after losing it), a range
 * that grows, overrides of current variants only (stored under the variant's own name), each at most once.
 */
export function masterPricesJson(
  db: DbOrTx,
  list: MasterPriceInput[],
  service: { name: string; variants: ServiceVariant[] },
  stored: MasterPrice[] = [],
): string {
  const ids = list.map((m) => m.employeeId);
  if (new Set(ids).size !== ids.length) throw badRequest('Цены мастеров: мастер указан дважды');
  const found = ids.length
    ? db.select({ id: employees.id, isMaster: employees.isMaster }).from(employees).where(inArray(employees.id, ids)).all()
    : [];
  const masters = new Map(found.map((e) => [e.id, e]));
  const kept = new Set(stored.map((m) => m.employeeId));
  const clean = list.map((entry): MasterPrice => {
    const employee = masters.get(entry.employeeId);
    if (!employee || (!employee.isMaster && !kept.has(entry.employeeId))) throw badRequest('Мастер не найден');
    const priceMax = entry.priceMax ?? null;
    if (priceMax != null && priceMax <= entry.price) throw badRequest('Максимальная цена должна быть больше минимальной');
    return { employeeId: entry.employeeId, price: entry.price, priceMax, variants: variantOverrides(entry.variants ?? [], service) };
  });
  return JSON.stringify(clean);
}

function variantOverrides(list: Array<{ name: string; price: number }>, service: { name: string; variants: ServiceVariant[] }) {
  const current = new Map(service.variants.map((v) => [variantKey(v.name), v.name]));
  const seen = new Set<string>();
  return list.map((override) => {
    const key = variantKey(override.name);
    const name = current.get(key);
    if (name === undefined) throw badRequest(`Нет варианта «${override.name.trim()}» у услуги «${service.name}»`);
    if (seen.has(key)) throw badRequest(`Цены мастеров: вариант «${name}» указан дважды`);
    seen.add(key);
    return { name, price: override.price };
  });
}

/** After the variants changed: overrides of names that no longer exist are dropped, the rest follow the new spelling. */
export function pruneMasterVariants(json: string, variants: ServiceVariant[]): string {
  const current = new Map(variants.map((v) => [variantKey(v.name), v.name]));
  const pruned = parseMasterPrices(json).map((entry) => ({
    ...entry,
    variants: entry.variants.flatMap((v) => {
      const name = current.get(variantKey(v.name));
      return name === undefined ? [] : [{ name, price: v.price }];
    }),
  }));
  return JSON.stringify(pruned);
}
