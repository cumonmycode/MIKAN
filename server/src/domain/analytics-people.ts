import { and, count, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { appointments, clients, sales } from '../db/schema.js';
import { clientRef } from '../lib/serialize.js';
import type { PeriodSales } from './analytics-sales.js';
import { clientsByIds, employeeRefOrMissing, employeesByIds } from './refs.js';

/** Appointments, masters and clients of an analytics period. */

const TOP_CLIENTS_LIMIT = 10;
const OPEN_STATUSES = new Set(['scheduled', 'confirmed']);

/** Appointments starting in the period, by master and status (one grouped query). */
export interface AppointmentGroup {
  masterId: number;
  status: string;
  n: number;
  /** Σ price. */
  value: number;
  /** Service lines (an appointment without lines counts as one procedure). */
  services: number;
}

export function appointmentGroups(db: DbOrTx, from: number, to: number): AppointmentGroup[] {
  // Spelled out: drizzle leaves columns unqualified in a single-table select, so `id` would mean the line's own id.
  const lines = sql<number>`max(1, (select count(*) from appointment_services lines where lines.appointment_id = appointments.id))`;
  return db
    .select({
      masterId: appointments.masterId,
      status: appointments.status,
      n: count(),
      value: sql<number>`coalesce(sum(${appointments.price}), 0)`,
      services: sql<number>`coalesce(sum(${lines}), 0)`,
    })
    .from(appointments)
    .where(and(gte(appointments.startsAt, from), lt(appointments.startsAt, to)))
    .groupBy(appointments.masterId, appointments.status)
    .all();
}

export function appointmentsSection(groups: AppointmentGroup[]) {
  const sum = (pick: (g: AppointmentGroup) => number, keep: (status: string) => boolean) =>
    groups.filter((g) => keep(g.status)).reduce((s, g) => s + pick(g), 0);
  return {
    total: sum((g) => g.n, () => true),
    open: sum((g) => g.n, (st) => OPEN_STATUSES.has(st)),
    completed: sum((g) => g.n, (st) => st === 'completed'),
    cancelled: sum((g) => g.n, (st) => st === 'cancelled'),
    noShow: sum((g) => g.n, (st) => st === 'no_show'),
    noShowLoss: sum((g) => g.value, (st) => st === 'no_show'),
    cancelledValue: sum((g) => g.value, (st) => st === 'cancelled'),
  };
}

export type AppointmentsSection = ReturnType<typeof appointmentsSection>;

interface MasterSums {
  revenue: number;
  salesCount: number;
  appointmentsCompleted: number;
  noShows: number;
  servicesCount: number;
}

/** Revenue of the kept sales linked to each master's appointments, and the masters' appointments of the period. */
export function mastersSection(db: DbOrTx, s: PeriodSales, groups: AppointmentGroup[]) {
  const stats = new Map<number, MasterSums>();
  const entry = (id: number) => {
    const e = stats.get(id) ?? { revenue: 0, salesCount: 0, appointmentsCompleted: 0, noShows: 0, servicesCount: 0 };
    stats.set(id, e);
    return e;
  };
  for (const g of groups) {
    if (g.status === 'completed') {
      entry(g.masterId).appointmentsCompleted += g.n;
      entry(g.masterId).servicesCount += g.services;
    } else if (g.status === 'no_show') {
      entry(g.masterId).noShows += g.n;
    }
  }
  for (const sale of s.kept) {
    if (sale.masterId == null) continue;
    entry(sale.masterId).revenue += sale.keptRevenue;
    entry(sale.masterId).salesCount += 1;
  }
  const emps = employeesByIds(db, [...stats.keys()]);
  return [...stats.entries()]
    .map(([id, m]) => ({
      employee: employeeRefOrMissing(emps, id)!,
      ...m,
      averageCheck: m.salesCount ? Math.round(m.revenue / m.salesCount) : 0,
    }))
    .sort((a, b) => b.revenue - a.revenue || b.appointmentsCompleted - a.appointmentsCompleted || a.employee.id - b.employee.id);
}

/**
 * New client cards, buyers of the period split into first-time and returning ones, receipts without a client and
 * the top clients by spend. A buyer is returning when they had a completed sale or a completed appointment before
 * the period (appointments imported from another CRM count too).
 */
export function clientsSection(db: DbOrTx, s: PeriodSales, from: number, to: number, newClients: number) {
  const spend = new Map<number, { revenue: number; salesCount: number }>();
  let anonymousRevenue = 0;
  let anonymousSales = 0;
  for (const sale of s.kept) {
    if (sale.clientId == null) {
      anonymousRevenue += sale.keptRevenue;
      anonymousSales += 1;
      continue;
    }
    const e = spend.get(sale.clientId) ?? { revenue: 0, salesCount: 0 };
    spend.set(sale.clientId, { revenue: e.revenue + sale.keptRevenue, salesCount: e.salesCount + 1 });
  }
  const returning = returningClients(db, from, to);
  const split = { firstTime: { count: 0, revenue: 0 }, returning: { count: 0, revenue: 0 } };
  for (const [clientId, e] of spend) {
    const bucket = returning.has(clientId) ? split.returning : split.firstTime;
    bucket.count += 1;
    bucket.revenue += e.revenue;
  }
  const topIds = [...spend.entries()]
    .sort(([idA, a], [idB, b]) => b.revenue - a.revenue || b.salesCount - a.salesCount || idA - idB)
    .slice(0, TOP_CLIENTS_LIMIT)
    .map(([id]) => id);
  const cards = clientsByIds(db, topIds);
  const visits = visitsOf(db, topIds, from, to);
  return {
    newClients,
    buyers: spend.size,
    ...split,
    anonymous: { salesCount: anonymousSales, revenue: anonymousRevenue },
    top: topIds.flatMap((id) => {
      const card = cards.get(id);
      const e = spend.get(id);
      return card && e ? [{ client: clientRef(card), revenue: e.revenue, salesCount: e.salesCount, visits: visits.get(id) ?? 0 }] : [];
    }),
  };
}

/** Clients of the period's kept sales who had bought or visited before `from`. */
function returningClients(db: DbOrTx, from: number, to: number): Set<number> {
  const buyers = db
    .selectDistinct({ id: sales.clientId })
    .from(sales)
    .where(and(eq(sales.status, 'completed'), gte(sales.createdAt, from), lt(sales.createdAt, to), isNotNull(sales.clientId)));
  const bought = db
    .selectDistinct({ id: sales.clientId })
    .from(sales)
    .where(and(eq(sales.status, 'completed'), lt(sales.createdAt, from), inArray(sales.clientId, buyers)))
    .all();
  const visited = db
    .selectDistinct({ id: appointments.clientId })
    .from(appointments)
    .where(and(eq(appointments.status, 'completed'), lt(appointments.startsAt, from), inArray(appointments.clientId, buyers)))
    .all();
  return new Set([...bought, ...visited].map((r) => r.id).filter((id): id is number => id != null));
}

/** Completed appointments in the period of the given clients. */
function visitsOf(db: DbOrTx, clientIds: number[], from: number, to: number): Map<number, number> {
  if (clientIds.length === 0) return new Map();
  const rows = db
    .select({ clientId: appointments.clientId, n: count() })
    .from(appointments)
    .where(
      and(
        eq(appointments.status, 'completed'),
        gte(appointments.startsAt, from),
        lt(appointments.startsAt, to),
        inArray(appointments.clientId, clientIds),
      ),
    )
    .groupBy(appointments.clientId)
    .all();
  return new Map(rows.map((r) => [r.clientId, r.n]));
}

export function newClientsCount(db: DbOrTx, from: number, to: number): number {
  return db.select({ n: count() }).from(clients).where(and(gte(clients.createdAt, from), lt(clients.createdAt, to))).get()?.n ?? 0;
}
