import { and, count, eq, gte, inArray, lt, sql, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import {
  appointments,
  botChats,
  bookingRequests,
  clients,
  depositOperations,
  products,
  saleItems,
  sales,
  smmPosts,
} from '../db/schema.js';
import type { SaleItemRow, SaleRow } from '../lib/serialize.js';
import { localDate, localDatesInRange, toIso } from '../lib/time.js';
import { getSmmSettings } from '../smm/settings.js';
import { PROFILES } from '../smm/types.js';
import { hasLowStock } from './products.js';
import { employeeRefOrMissing, employeesByIds, productsByIds, variantsByIds } from './refs.js';
import { studioTimezone } from './settings.js';

const TOP_LIMIT = 10;

/** Prepayment operations in the period, and the amount held for appointments at its end. */
export interface ReportDeposits {
  received: number;
  cash: number;
  card: number;
  transfer: number;
  qr: number;
  /** Counted in sales, net of sale refunds that returned them to their appointments. */
  applied: number;
  refunded: number;
  retained: number;
  held: number;
}

export function reportDeposits(db: DbOrTx, from: number, to: number): ReportDeposits {
  const op = depositOperations;
  const sumOf = (condition: SQL) => sql<number>`coalesce(sum(case when ${condition} then ${op.amount} end), 0)`;
  const inPeriod = sql`${op.createdAt} >= ${from}`;
  const receive = sql`${op.type} = 'receive'`;
  const row = db
    .select({
      held: sql<number>`coalesce(sum(case when ${op.type} in ('receive', 'unapply') then ${op.amount} else -${op.amount} end), 0)`,
      received: sumOf(sql`${inPeriod} and ${receive}`),
      cash: sumOf(sql`${inPeriod} and ${receive} and ${op.method} = 'cash'`),
      card: sumOf(sql`${inPeriod} and ${receive} and ${op.method} = 'card'`),
      transfer: sumOf(sql`${inPeriod} and ${receive} and ${op.method} = 'transfer'`),
      qr: sumOf(sql`${inPeriod} and ${receive} and ${op.method} = 'qr'`),
      applied: sumOf(sql`${inPeriod} and ${op.type} = 'apply'`),
      unapplied: sumOf(sql`${inPeriod} and ${op.type} = 'unapply'`),
      refunded: sumOf(sql`${inPeriod} and ${op.type} = 'refund'`),
      retained: sumOf(sql`${inPeriod} and ${op.type} = 'retain'`),
    })
    .from(op)
    .where(lt(op.createdAt, to))
    .get();
  return {
    received: row?.received ?? 0,
    cash: row?.cash ?? 0,
    card: row?.card ?? 0,
    transfer: row?.transfer ?? 0,
    qr: row?.qr ?? 0,
    applied: (row?.applied ?? 0) - (row?.unapplied ?? 0),
    refunded: row?.refunded ?? 0,
    retained: row?.retained ?? 0,
    held: row?.held ?? 0,
  };
}

/**
 * Splits the sale discount across items proportionally to their totals (whole rubles);
 * the rounding remainder goes to the last item so item revenues sum exactly to the sale total.
 */
export function allocateDiscount(items: Array<Pick<SaleItemRow, 'total'>>, discount: number): number[] {
  const subtotal = items.reduce((s, i) => s + i.total, 0);
  if (subtotal === 0 || discount === 0) return items.map((i) => i.total);
  let allocated = 0;
  return items.map((item, index) => {
    const share = index === items.length - 1 ? discount - allocated : Math.round((discount * item.total) / subtotal);
    allocated += share;
    return item.total - share;
  });
}

interface TopEntry {
  id: number | null;
  name: string;
  quantity: number;
  revenue: number;
  /** Products: the same split by size. */
  sizes: Map<string, TopEntry>;
}

function addTop(map: Map<string, TopEntry>, key: string, id: number | null, name: string, quantity: number, revenue: number): TopEntry {
  const entry = map.get(key) ?? { id, name, quantity: 0, revenue: 0, sizes: new Map() };
  entry.quantity += quantity;
  entry.revenue += revenue;
  map.set(key, entry);
  return entry;
}

const byRevenue = (a: TopEntry, b: TopEntry) => b.revenue - a.revenue || b.quantity - a.quantity;
const topOf = (map: Map<string, TopEntry>) => [...map.values()].sort(byRevenue).slice(0, TOP_LIMIT);

export function reportSummary(db: DbOrTx, from: number, to: number) {
  const tz = studioTimezone(db);
  const rangeSales = db
    .select()
    .from(sales)
    .where(and(gte(sales.createdAt, from), lt(sales.createdAt, to), eq(sales.status, 'completed')))
    .all();
  const revenue = rangeSales.reduce((s, x) => s + x.total, 0);
  const payments = {
    cash: rangeSales.reduce((s, x) => s + x.payCash, 0),
    card: rangeSales.reduce((s, x) => s + x.payCard, 0),
    transfer: rangeSales.reduce((s, x) => s + x.payTransfer, 0),
    qr: rangeSales.reduce((s, x) => s + x.payQr, 0),
    deposit: rangeSales.reduce((s, x) => s + x.payDeposit, 0),
  };
  const refunds =
    db
      .select({ v: sql<number>`coalesce(sum(${sales.total}), 0)` })
      .from(sales)
      .where(and(eq(sales.status, 'refunded'), gte(sales.refundedAt, from), lt(sales.refundedAt, to)))
      .get()?.v ?? 0;

  const byDayMap = new Map(localDatesInRange(from, to, tz).map((d) => [d, { date: d, revenue: 0, salesCount: 0 }]));
  for (const sale of rangeSales) {
    const day = byDayMap.get(localDate(sale.createdAt, tz));
    if (day) {
      day.revenue += sale.total;
      day.salesCount += 1;
    }
  }

  const { servicesRevenue, productsRevenue, topProducts, topServices } = itemBreakdown(db, rangeSales);
  const byMaster = masterBreakdown(db, rangeSales, from, to);
  const countAppointments = (status: string) =>
    db
      .select({ n: count() })
      .from(appointments)
      .where(and(eq(appointments.status, status), gte(appointments.startsAt, from), lt(appointments.startsAt, to)))
      .get()?.n ?? 0;

  return {
    from: toIso(from),
    to: toIso(to),
    revenue,
    salesCount: rangeSales.length,
    averageCheck: rangeSales.length ? Math.round(revenue / rangeSales.length) : 0,
    refunds,
    payments,
    deposits: reportDeposits(db, from, to),
    servicesRevenue,
    productsRevenue,
    byDay: [...byDayMap.values()],
    topProducts: topProducts.map((t) => ({
      productId: t.id,
      name: t.name,
      quantity: t.quantity,
      revenue: t.revenue,
      variants: [...t.sizes.values()]
        .sort(byRevenue)
        .map((v) => ({ variantId: v.id, name: v.name, quantity: v.quantity, revenue: v.revenue })),
    })),
    topServices: topServices.map((t) => ({ serviceId: t.id, name: t.name, quantity: t.quantity, revenue: t.revenue })),
    byMaster,
    newClients:
      db.select({ n: count() }).from(clients).where(and(gte(clients.createdAt, from), lt(clients.createdAt, to))).get()?.n ?? 0,
    appointmentsCompleted: countAppointments('completed'),
    noShows: countAppointments('no_show'),
  };
}

function itemBreakdown(db: DbOrTx, rangeSales: SaleRow[]) {
  let servicesRevenue = 0;
  let productsRevenue = 0;
  const productTop = new Map<string, TopEntry>();
  const serviceTop = new Map<string, TopEntry>();
  if (rangeSales.length === 0) return { servicesRevenue, productsRevenue, topProducts: [], topServices: [] };
  const items = db
    .select()
    .from(saleItems)
    .where(inArray(saleItems.saleId, rangeSales.map((s) => s.id)))
    .all();
  const productNames = productsByIds(db, items.map((i) => i.productId));
  const sizeNames = variantsByIds(db, items.map((i) => i.variantId));
  const bySale = new Map<number, SaleItemRow[]>();
  for (const item of items) bySale.set(item.saleId, [...(bySale.get(item.saleId) ?? []), item]);
  for (const sale of rangeSales) {
    const saleItemsList = (bySale.get(sale.id) ?? []).sort((a, b) => a.id - b.id);
    const net = allocateDiscount(saleItemsList, sale.discount);
    saleItemsList.forEach((item, i) => {
      const value = net[i] ?? 0;
      if (item.type === 'product') {
        productsRevenue += value;
        const name = (item.productId != null ? productNames.get(item.productId)?.name : undefined) ?? item.name;
        const top = addTop(productTop, `p${item.productId ?? item.name}`, item.productId, name, item.quantity, value);
        if (item.variantId != null) {
          const sizeName = sizeNames.get(item.variantId)?.name ?? item.variantName ?? '';
          addTop(top.sizes, `v${item.variantId}`, item.variantId, sizeName, item.quantity, value);
        }
      } else {
        servicesRevenue += value;
        const key = item.serviceId != null ? `s${item.serviceId}` : `n${item.name.toLowerCase()}`;
        addTop(serviceTop, key, item.serviceId, item.name, item.quantity, value);
      }
    });
  }
  return { servicesRevenue, productsRevenue, topProducts: topOf(productTop), topServices: topOf(serviceTop) };
}

function masterBreakdown(db: DbOrTx, rangeSales: SaleRow[], from: number, to: number) {
  const completed = db
    .select({ masterId: appointments.masterId, n: count() })
    .from(appointments)
    .where(and(eq(appointments.status, 'completed'), gte(appointments.startsAt, from), lt(appointments.startsAt, to)))
    .groupBy(appointments.masterId)
    .all();
  const linkedIds = rangeSales.map((s) => s.appointmentId).filter((x): x is number => x != null);
  const linked = linkedIds.length
    ? db.select({ id: appointments.id, masterId: appointments.masterId }).from(appointments).where(inArray(appointments.id, linkedIds)).all()
    : [];
  const masterOfAppointment = new Map(linked.map((a) => [a.id, a.masterId]));
  const stats = new Map<number, { appointmentsCompleted: number; revenue: number }>();
  const entry = (id: number) => {
    const e = stats.get(id) ?? { appointmentsCompleted: 0, revenue: 0 };
    stats.set(id, e);
    return e;
  };
  for (const c of completed) entry(c.masterId).appointmentsCompleted = c.n;
  for (const sale of rangeSales) {
    const masterId = sale.appointmentId != null ? masterOfAppointment.get(sale.appointmentId) : undefined;
    if (masterId !== undefined) entry(masterId).revenue += sale.total;
  }
  const emps = employeesByIds(db, [...stats.keys()]);
  return [...stats.entries()]
    .map(([id, s]) => ({ employee: employeeRefOrMissing(emps, id)!, ...s }))
    .sort((a, b) => b.revenue - a.revenue || b.appointmentsCompleted - a.appointmentsCompleted);
}

export function badges(db: DbOrTx) {
  const n = (v: { n: number } | undefined) => v?.n ?? 0;
  return {
    unreadChats: n(db.select({ n: count() }).from(botChats).where(sql`${botChats.unreadCount} > 0`).get()),
    needsAttention: n(db.select({ n: count() }).from(botChats).where(eq(botChats.needsAttention, true)).get()),
    newBookingRequests: n(db.select({ n: count() }).from(bookingRequests).where(eq(bookingRequests.status, 'new')).get()),
    lowStock: n(db.select({ n: count() }).from(products).where(and(eq(products.active, true), hasLowStock)).get()),
    smmReview: smmReviewCount(db),
  };
}

/** SMM posts waiting for approval in the profiles that are on (a switched-off profile does not nag). */
function smmReviewCount(db: DbOrTx): number {
  const enabled = PROFILES.filter((profile) => getSmmSettings(db, profile).enabled);
  if (!enabled.length) return 0;
  const row = db
    .select({ n: count() })
    .from(smmPosts)
    .where(and(eq(smmPosts.status, 'review'), inArray(smmPosts.profile, enabled)))
    .get();
  return row?.n ?? 0;
}
