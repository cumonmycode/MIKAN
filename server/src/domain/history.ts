import { and, asc, eq, gt, inArray, isNotNull, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { appointments, appointmentServices, saleItems, sales, services } from '../db/schema.js';
import { notFound } from '../lib/errors.js';
import {
  clientRef,
  type AppointmentRow,
  type AppointmentServiceRow,
  type HistoryEntryOut,
  type SaleItemRow,
  type SaleRow,
} from '../lib/serialize.js';
import { normalizeSearchTerm } from '../lib/text.js';
import { toIso } from '../lib/time.js';
import { clientsByIds, employeeRefOrMissing, employeesByIds, serviceLinesByAppointment } from './refs.js';
import { getProductRow } from './stock.js';

/** All conditions are combined with AND. */
export interface HistoryFilter {
  clientId?: number;
  serviceId?: number;
  productId?: number;
  /** One size of `productId`. */
  variantId?: number;
}

export interface HistoryPage {
  limit: number;
  offset: number;
}

const HISTORY_SALE_STATUSES = ['completed', 'refunded'];
const UNTITLED_PROCEDURE = 'Процедура';

/** A history entry before its client, employee and sale are resolved. */
interface RawEntry {
  id: string;
  kind: HistoryEntryOut['kind'];
  date: number;
  name: string;
  serviceId: number | null;
  productId: number | null;
  variantId: number | null;
  variantName: string | null;
  quantity: number;
  price: number;
  total: number;
  clientId: number | null;
  employeeId: number;
  appointmentId: number | null;
  saleId: number | null;
  /** Its line was returned in full by a refund of a sale that is otherwise kept. */
  returned: boolean;
}

const lineEntry = (a: AppointmentRow, line: AppointmentServiceRow): RawEntry => ({
  id: `as${line.id}`,
  kind: 'service',
  date: a.startsAt,
  name: line.name,
  serviceId: line.serviceId,
  productId: null,
  variantId: null,
  variantName: null,
  quantity: 1,
  price: line.price,
  total: line.price,
  clientId: a.clientId,
  employeeId: a.masterId,
  appointmentId: a.id,
  saleId: a.saleId,
  returned: false,
});

/** An appointment without service lines is listed once, under its title. */
const titleEntry = (a: AppointmentRow): RawEntry => ({
  id: `at${a.id}`,
  kind: 'service',
  date: a.startsAt,
  name: a.title?.trim() || UNTITLED_PROCEDURE,
  serviceId: null,
  productId: null,
  variantId: null,
  variantName: null,
  quantity: 1,
  price: a.price,
  total: a.price,
  clientId: a.clientId,
  employeeId: a.masterId,
  appointmentId: a.id,
  saleId: a.saleId,
  returned: false,
});

const saleItemEntry = (sale: SaleRow, item: SaleItemRow): RawEntry => ({
  id: `si${item.id}`,
  kind: item.type === 'product' ? 'product' : 'service',
  date: sale.createdAt,
  name: item.name,
  serviceId: item.serviceId,
  productId: item.productId,
  variantId: item.variantId,
  variantName: item.variantName,
  quantity: item.quantity,
  price: item.price,
  total: item.total,
  clientId: sale.clientId,
  employeeId: sale.employeeId,
  appointmentId: sale.appointmentId,
  saleId: sale.id,
  returned: item.refundedQuantity >= item.quantity,
});

/** Services performed in completed appointments. */
function appointmentEntries(db: DbOrTx, f: HistoryFilter): RawEntry[] {
  if (f.productId !== undefined || f.variantId !== undefined) return [];
  const conditions: SQL[] = [eq(appointments.status, 'completed')];
  if (f.clientId !== undefined) conditions.push(eq(appointments.clientId, f.clientId));
  if (f.serviceId !== undefined) {
    // Only lines name a catalog service; an appointment without lines never matches.
    return db
      .select({ appointment: appointments, line: appointmentServices })
      .from(appointmentServices)
      .innerJoin(appointments, eq(appointments.id, appointmentServices.appointmentId))
      .where(and(...conditions, eq(appointmentServices.serviceId, f.serviceId)))
      .all()
      .map((r) => lineEntry(r.appointment, r.line));
  }
  const rows = db.select().from(appointments).where(and(...conditions)).all();
  const lines = serviceLinesByAppointment(db, rows.map((a) => a.id));
  return rows.flatMap((a) => {
    const own = lines.get(a.id) ?? [];
    return own.length > 0 ? own.map((line) => lineEntry(a, line)) : [titleEntry(a)];
  });
}

/**
 * Items of completed or refunded sales. A service item of a sale that pays for a completed appointment is left out
 * when that appointment's own entries already represent it (see `itemsCoveredByAppointments`).
 */
function saleItemEntries(db: DbOrTx, f: HistoryFilter): RawEntry[] {
  const conditions: SQL[] = [inArray(sales.status, HISTORY_SALE_STATUSES)];
  if (f.clientId !== undefined) conditions.push(eq(sales.clientId, f.clientId));
  if (f.serviceId !== undefined) conditions.push(eq(saleItems.type, 'service'), eq(saleItems.serviceId, f.serviceId));
  if (f.productId !== undefined) conditions.push(eq(saleItems.type, 'product'), eq(saleItems.productId, f.productId));
  if (f.variantId !== undefined) conditions.push(eq(saleItems.variantId, f.variantId));
  const rows = db
    .select({ sale: sales, item: saleItems })
    .from(saleItems)
    .innerJoin(sales, eq(sales.id, saleItems.saleId))
    .where(and(...conditions))
    .all();
  const covered = itemsCoveredByAppointments(
    db,
    rows.filter((r) => r.item.type === 'service' && r.sale.appointmentId != null).map((r) => r.sale),
  );
  return rows.filter((r) => !covered.has(r.item.id)).map((r) => saleItemEntry(r.sale, r.item));
}

/** Words the apps use for an appointment without services when they put it into a checkout cart. */
const VISIT_FALLBACK_NAMES = ['запись', 'процедура'];

const lineKey = (serviceId: number | null, name: string): string =>
  serviceId != null ? `s${serviceId}` : `n${normalizeSearchTerm(name)}`;

/**
 * Matches a sale's service items against the completed appointment it pays for and returns the ids of the items
 * the appointment already lists: items matching a service line (as a multiset keyed by `serviceId`, else by name),
 * plus at most one item standing for the whole visit (named like the joined line names or the title, as the apps
 * fill the cart when the line prices do not add up or the appointment has no lines). Anything else — e.g. a service
 * the cashier added at checkout — stays in the history as a sale item.
 */
function itemsCoveredByAppointments(db: DbOrTx, linkedSales: SaleRow[]): Set<number> {
  const covered = new Set<number>();
  const saleIds = [...new Set(linkedSales.map((s) => s.id))];
  const appointmentIds = [...new Set(linkedSales.map((s) => s.appointmentId).filter((x): x is number => x != null))];
  if (saleIds.length === 0 || appointmentIds.length === 0) return covered;
  const completed = new Map(
    db
      .select()
      .from(appointments)
      .where(and(inArray(appointments.id, appointmentIds), eq(appointments.status, 'completed')))
      .all()
      .map((a) => [a.id, a]),
  );
  if (completed.size === 0) return covered;
  const lines = serviceLinesByAppointment(db, [...completed.keys()]);
  const items = db
    .select()
    .from(saleItems)
    .where(and(inArray(saleItems.saleId, saleIds), eq(saleItems.type, 'service')))
    .orderBy(asc(saleItems.saleId), asc(saleItems.id))
    .all();
  const itemsBySale = new Map<number, SaleItemRow[]>();
  for (const item of items) itemsBySale.set(item.saleId, [...(itemsBySale.get(item.saleId) ?? []), item]);
  for (const sale of new Map(linkedSales.map((s) => [s.id, s])).values()) {
    const appointment = sale.appointmentId != null ? completed.get(sale.appointmentId) : undefined;
    if (!appointment) continue;
    const matched = matchVisitItems(appointment, lines.get(appointment.id) ?? [], itemsBySale.get(sale.id) ?? []);
    for (const id of matched) covered.add(id);
  }
  return covered;
}

function matchVisitItems(appointment: AppointmentRow, lines: AppointmentServiceRow[], items: SaleItemRow[]): number[] {
  const remaining = new Map<string, number>();
  for (const line of lines) {
    const key = lineKey(line.serviceId, line.name);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  const visitNames = new Set(
    [lines.map((l) => l.name).join(', '), appointment.title ?? '', ...VISIT_FALLBACK_NAMES]
      .map(normalizeSearchTerm)
      .filter((n) => n.length > 0),
  );
  let visitItemUsed = false;
  const matched: number[] = [];
  for (const item of items) {
    const key = lineKey(item.serviceId, item.name);
    const left = remaining.get(key) ?? 0;
    if (left > 0) {
      remaining.set(key, left - 1);
      matched.push(item.id);
    } else if (!visitItemUsed && visitNames.has(normalizeSearchTerm(item.name))) {
      visitItemUsed = true;
      matched.push(item.id);
    }
  }
  return matched;
}

/** The appointment (or, for sales without one, the sale) an entry belongs to. */
const visitKey = (e: RawEntry): string => (e.appointmentId != null ? `a${e.appointmentId}` : `s${e.saleId ?? 0}`);
const numeric = (a: string, b: string): number => a.localeCompare(b, 'en', { numeric: true });

/**
 * Newest first; ties by visit (newest appointment / sale first), and inside one visit in booking / receipt order
 * (service lines before the products of a linked sale).
 */
const newestFirst = (a: RawEntry, b: RawEntry): number =>
  b.date - a.date || numeric(visitKey(b), visitKey(a)) || numeric(a.id, b.id);

function collect(db: DbOrTx, f: HistoryFilter): RawEntry[] {
  return markReturnedVisitLines(db, [...appointmentEntries(db, f), ...saleItemEntries(db, f)].sort(newestFirst));
}

/**
 * A visit paid by a sale that was partly refunded: its service lines whose sale item came back in full read refunded —
 * matched like `itemsCoveredByAppointments` (by catalog service, else by name, each item once); a visit listed under
 * its title reads refunded once every service item of the sale came back.
 */
function markReturnedVisitLines(db: DbOrTx, entries: RawEntry[]): RawEntry[] {
  const partly = db
    .select({ item: saleItems })
    .from(saleItems)
    .innerJoin(sales, eq(sales.id, saleItems.saleId))
    .where(and(eq(sales.status, 'completed'), gt(sales.refundedTotal, 0), isNotNull(sales.appointmentId), eq(saleItems.type, 'service')))
    .all();
  if (partly.length === 0) return entries;
  const returnedKeys = new Map<number, Map<string, number>>();
  const allReturned = new Map<number, boolean>();
  for (const { item } of partly) {
    const done = item.refundedQuantity >= item.quantity;
    allReturned.set(item.saleId, (allReturned.get(item.saleId) ?? true) && done);
    if (!done) continue;
    const keys = returnedKeys.get(item.saleId) ?? new Map<string, number>();
    const key = lineKey(item.serviceId, item.name);
    keys.set(key, (keys.get(key) ?? 0) + 1);
    returnedKeys.set(item.saleId, keys);
  }
  return entries.map((e) => {
    if (e.kind !== 'service' || e.saleId == null || e.id.startsWith('si')) return e;
    if (e.id.startsWith('at')) return allReturned.get(e.saleId) ? { ...e, returned: true } : e;
    const keys = returnedKeys.get(e.saleId);
    const key = lineKey(e.serviceId, e.name);
    const left = keys?.get(key) ?? 0;
    if (left === 0) return e;
    keys!.set(key, left - 1);
    return { ...e, returned: true };
  });
}

function salesByIds(db: DbOrTx, ids: Array<number | null>): Map<number, SaleRow> {
  const list = [...new Set(ids.filter((x): x is number => x != null))];
  if (list.length === 0) return new Map();
  return new Map(db.select().from(sales).where(inArray(sales.id, list)).all().map((r) => [r.id, r]));
}

/** Resolves clients, employees and sales of the given entries with one query each. */
function hydrate(db: DbOrTx, raw: RawEntry[]): HistoryEntryOut[] {
  const clientMap = clientsByIds(db, raw.map((e) => e.clientId));
  const employeeMap = employeesByIds(db, raw.map((e) => e.employeeId));
  const saleMap = salesByIds(db, raw.map((e) => e.saleId));
  return raw.map((e) => {
    const client = e.clientId != null ? clientMap.get(e.clientId) : undefined;
    const sale = e.saleId != null ? saleMap.get(e.saleId) : undefined;
    return {
      id: e.id,
      kind: e.kind,
      date: toIso(e.date),
      name: e.name,
      serviceId: e.serviceId,
      productId: e.productId,
      variantId: e.variantId,
      variantName: e.variantName,
      quantity: e.quantity,
      price: e.price,
      total: e.total,
      client: client ? clientRef(client) : null,
      employee: employeeRefOrMissing(employeeMap, e.employeeId),
      appointmentId: e.appointmentId,
      saleId: e.saleId,
      saleNumber: sale?.number ?? null,
      refunded: sale?.status === 'refunded' || e.returned,
    };
  });
}

/** Every matching entry, newest first. */
export function historyEntries(db: DbOrTx, f: HistoryFilter): HistoryEntryOut[] {
  return hydrate(db, collect(db, f));
}

/** One page of matching entries, newest first; refs are resolved for that page only. */
export function historyEntriesPage(db: DbOrTx, f: HistoryFilter, page: HistoryPage): { items: HistoryEntryOut[]; total: number } {
  const all = collect(db, f);
  return { items: hydrate(db, all.slice(page.offset, page.offset + page.limit)), total: all.length };
}

export function serviceHistory(db: DbOrTx, serviceId: number, page: HistoryPage) {
  if (!db.select({ id: services.id }).from(services).where(eq(services.id, serviceId)).get()) {
    throw notFound('Услуга не найдена');
  }
  return historyEntriesPage(db, { serviceId }, page);
}

export function productHistory(db: DbOrTx, productId: number, page: HistoryPage & { variantId?: number }) {
  getProductRow(db, productId);
  return historyEntriesPage(db, { productId, variantId: page.variantId }, page);
}
