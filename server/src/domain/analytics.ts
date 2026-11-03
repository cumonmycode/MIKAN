import type { DbOrTx } from '../db/client.js';
import { toIso } from '../lib/time.js';
import { itemBreakdown, type ItemBreakdown } from './analytics-items.js';
import { loyaltySection } from './analytics-loyalty.js';
import { cashSection, stockExpenses, stockOnHand, type StockExpenses } from './analytics-operations.js';
import {
  appointmentGroups,
  appointmentsSection,
  clientsSection,
  mastersSection,
  newClientsCount,
  type AppointmentGroup,
  type AppointmentsSection,
} from './analytics-people.js';
import { loadPeriodSales, revenueSection, timeSeries, type PeriodSales, type RevenueSection } from './analytics-sales.js';
import { reportDeposits, type ReportDeposits } from './reports.js';
import { studioTimezone } from './settings.js';

/**
 * `GET /reports/analytics`: the financial picture of a period and the KPIs of the previous period of the same
 * length (for deltas). See docs/API.md «Reports» for every field.
 */

/** What both periods compute; the detailed sections are built only for the requested one. */
interface PeriodCore {
  sales: PeriodSales;
  revenue: RevenueSection;
  items: ItemBreakdown;
  groups: AppointmentGroup[];
  appointments: AppointmentsSection;
  stock: StockExpenses;
  deposits: ReportDeposits;
  newClients: number;
}

function periodCore(db: DbOrTx, from: number, to: number): PeriodCore {
  const sales = loadPeriodSales(db, from, to);
  const groups = appointmentGroups(db, from, to);
  return {
    sales,
    revenue: revenueSection(sales),
    items: itemBreakdown(db, sales),
    groups,
    appointments: appointmentsSection(groups),
    stock: stockExpenses(db, from, to),
    deposits: reportDeposits(db, from, to),
    newClients: newClientsCount(db, from, to),
  };
}

/** The headline numbers, the same shape for the period and the previous one. */
function totalsOf(core: PeriodCore) {
  const { revenue, items, appointments, stock } = core;
  return {
    net: revenue.net,
    gross: revenue.gross,
    refunds: revenue.refunds,
    salesCount: revenue.salesCount,
    averageCheck: revenue.averageCheck,
    discounts: revenue.discounts,
    servicesRevenue: items.services.revenue,
    productsRevenue: items.products.revenue,
    cogs: items.products.cogs,
    grossProfit: items.products.grossProfit,
    marginPercent: items.products.marginPercent,
    stockExpenses: stock.expenses,
    newClients: core.newClients,
    appointmentsCompleted: appointments.completed,
    noShows: appointments.noShow,
    noShowLoss: appointments.noShowLoss,
    depositsReceived: core.deposits.received,
  };
}

export function reportAnalytics(db: DbOrTx, from: number, to: number) {
  const tz = studioTimezone(db);
  const previousFrom = from - (to - from);
  const current = periodCore(db, from, to);
  const previous = periodCore(db, previousFrom, from);
  return {
    from: toIso(from),
    to: toIso(to),
    previousFrom: toIso(previousFrom),
    previousTo: toIso(from),
    timezone: tz,
    totals: totalsOf(current),
    previous: totalsOf(previous),
    revenue: current.revenue,
    ...timeSeries(current.sales, from, to, tz),
    services: current.items.services,
    products: current.items.products,
    stock: { ...current.stock, onHand: stockOnHand(db) },
    deposits: current.deposits,
    cash: cashSection(db, from, to),
    masters: mastersSection(db, current.sales, current.groups),
    clients: clientsSection(db, current.sales, from, to, current.newClients),
    appointments: current.appointments,
    loyalty: loyaltySection(db, from, to),
  };
}
