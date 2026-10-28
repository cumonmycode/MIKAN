import { asc, eq, inArray } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import {
  appointments,
  appointmentServices,
  clients,
  employees,
  giftCertificates,
  openReceipts,
  products,
  productVariants,
  saleItems,
  sales,
  services,
} from '../db/schema.js';
import { notFound } from '../lib/errors.js';
import { earnedBySales } from './bonuses.js';
import { appointmentCancellation } from './cancellation.js';
import { depositLedgerByAppointment, depositStatusOf, heldAmount, latestDepositCodes } from './deposit-ledger.js';
import { refundsBySales } from './refund-rows.js';
import { getStudioSettings } from './settings.js';
import {
  appointmentOut,
  appointmentServiceOut,
  clientRef,
  depositOperationOut,
  employeeRef,
  qrPaymentOut,
  saleOut,
  saleRefundOut,
  serviceRef,
  type AppointmentOut,
  type AppointmentRow,
  type AppointmentServiceRow,
  type ClientRow,
  type EmployeeRow,
  type ProductRow,
  type SaleItemRow,
  type SaleOut,
  type SaleRow,
  type ServiceRow,
  type VariantRow,
} from '../lib/serialize.js';

const unique = (ids: Array<number | null | undefined>): number[] => [
  ...new Set(ids.filter((x): x is number => typeof x === 'number')),
];

export function employeesByIds(db: DbOrTx, ids: Array<number | null | undefined>): Map<number, EmployeeRow> {
  const list = unique(ids);
  if (list.length === 0) return new Map();
  return new Map(db.select().from(employees).where(inArray(employees.id, list)).all().map((r) => [r.id, r]));
}

export function clientsByIds(db: DbOrTx, ids: Array<number | null | undefined>): Map<number, ClientRow> {
  const list = unique(ids);
  if (list.length === 0) return new Map();
  return new Map(db.select().from(clients).where(inArray(clients.id, list)).all().map((r) => [r.id, r]));
}

export function servicesByIds(db: DbOrTx, ids: Array<number | null | undefined>): Map<number, ServiceRow> {
  const list = unique(ids);
  if (list.length === 0) return new Map();
  return new Map(db.select().from(services).where(inArray(services.id, list)).all().map((r) => [r.id, r]));
}

export function productsByIds(db: DbOrTx, ids: Array<number | null | undefined>): Map<number, ProductRow> {
  const list = unique(ids);
  if (list.length === 0) return new Map();
  return new Map(db.select().from(products).where(inArray(products.id, list)).all().map((r) => [r.id, r]));
}

/** Sizes by id, archived ones included (movements and sales still name them). */
export function variantsByIds(db: DbOrTx, ids: Array<number | null | undefined>): Map<number, VariantRow> {
  const list = unique(ids);
  if (list.length === 0) return new Map();
  return new Map(db.select().from(productVariants).where(inArray(productVariants.id, list)).all().map((r) => [r.id, r]));
}

/** Service lines of the given appointments, grouped by appointment and ordered by position. */
export function serviceLinesByAppointment(db: DbOrTx, appointmentIds: number[]): Map<number, AppointmentServiceRow[]> {
  const result = new Map<number, AppointmentServiceRow[]>();
  const ids = unique(appointmentIds);
  if (ids.length === 0) return result;
  const rows = db
    .select()
    .from(appointmentServices)
    .where(inArray(appointmentServices.appointmentId, ids))
    .orderBy(asc(appointmentServices.appointmentId), asc(appointmentServices.position), asc(appointmentServices.id))
    .all();
  for (const row of rows) {
    const list = result.get(row.appointmentId) ?? [];
    list.push(row);
    result.set(row.appointmentId, list);
  }
  return result;
}

/** The open receipt of each appointment that has one (an appointment has at most one). */
function openReceiptIdsByAppointment(db: DbOrTx, appointmentIds: number[]): Map<number, number> {
  const ids = unique(appointmentIds);
  if (ids.length === 0) return new Map();
  const rows = db
    .select({ id: openReceipts.id, appointmentId: openReceipts.appointmentId })
    .from(openReceipts)
    .where(inArray(openReceipts.appointmentId, ids))
    .all();
  return new Map(rows.map((r) => [r.appointmentId!, r.id]));
}

const missingEmployee = (id: number) => ({ id, name: 'Удалённый сотрудник', color: '#8E8E93' });
const missingClient = (id: number) => ({ id, name: 'Удалённый клиент', lastName: null, phone: null, telegramLinked: false });

export function serializeAppointments(db: DbOrTx, rows: AppointmentRow[]): AppointmentOut[] {
  const ids = rows.map((r) => r.id);
  const cl = clientsByIds(
    db,
    rows.map((r) => r.clientId),
  );
  const lines = serviceLinesByAppointment(db, ids);
  const ledgers = depositLedgerByAppointment(db, ids);
  const links = latestDepositCodes(db, ids);
  const receipts = openReceiptIdsByAppointment(db, ids);
  const em = employeesByIds(db, [
    ...rows.map((r) => r.masterId),
    ...[...ledgers.values()].flat().map((op) => op.employeeId),
  ]);
  const sv = servicesByIds(db, [
    ...rows.map((r) => r.serviceId),
    ...[...lines.values()].flat().map((l) => l.serviceId),
  ]);
  const rules = getStudioSettings(db).cancellation;
  return rows.map((a) => {
    const client = cl.get(a.clientId);
    const master = em.get(a.masterId);
    const service = a.serviceId != null ? sv.get(a.serviceId) : undefined;
    const ledger = ledgers.get(a.id) ?? [];
    const held = heldAmount(ledger);
    const link = links.get(a.id);
    return appointmentOut(
      a,
      client ? clientRef(client) : missingClient(a.clientId),
      master ? employeeRef(master) : missingEmployee(a.masterId),
      service ? serviceRef(service) : null,
      (lines.get(a.id) ?? []).map((l) =>
        appointmentServiceOut(l, l.serviceId != null ? (sv.get(l.serviceId)?.category ?? null) : null),
      ),
      {
        held,
        status: depositStatusOf(ledger, a.depositRequired, a.status),
        operations: ledger.map((op) => depositOperationOut(op, employeeRefOrMissing(em, op.employeeId))),
        link: link ? qrPaymentOut(link, null) : null,
      },
      receipts.get(a.id) ?? null,
      appointmentCancellation(a, held, rules),
    );
  });
}

export function getAppointmentRow(db: DbOrTx, id: number): AppointmentRow {
  const row = db.select().from(appointments).where(eq(appointments.id, id)).get();
  if (!row) throw notFound('Запись не найдена');
  return row;
}

export function serializeAppointment(db: DbOrTx, row: AppointmentRow): AppointmentOut {
  const [out] = serializeAppointments(db, [row]);
  return out!;
}

export function serializeSales(db: DbOrTx, rows: SaleRow[]): SaleOut[] {
  if (rows.length === 0) return [];
  const items = db
    .select()
    .from(saleItems)
    .where(
      inArray(
        saleItems.saleId,
        rows.map((r) => r.id),
      ),
    )
    .all();
  const bySale = new Map<number, SaleItemRow[]>();
  for (const item of items) {
    const list = bySale.get(item.saleId) ?? [];
    list.push(item);
    bySale.set(item.saleId, list);
  }
  const cl = clientsByIds(
    db,
    rows.map((r) => r.clientId),
  );
  const refunds = refundsBySales(
    db,
    rows.map((r) => r.id),
  );
  const refundRows = [...refunds.values()].flat().map((r) => r.row);
  const em = employeesByIds(db, [...rows.map((r) => r.employeeId), ...refundRows.map((r) => r.employeeId)]);
  const itemNames = new Map(items.map((i) => [i.id, i.name]));
  const earned = earnedBySales(
    db,
    rows.map((r) => r.id),
  );
  const codes = certificateCodes(
    db,
    items.map((i) => i.certificateId),
  );
  return rows.map((sale) => {
    const client = sale.clientId != null ? cl.get(sale.clientId) : undefined;
    const employee = em.get(sale.employeeId);
    return saleOut(
      sale,
      (bySale.get(sale.id) ?? []).sort((a, b) => a.id - b.id),
      client ? clientRef(client) : null,
      employee ? employeeRef(employee) : missingEmployee(sale.employeeId),
      earned.get(sale.id) ?? 0,
      codes,
      (refunds.get(sale.id) ?? []).map(({ row, items: lines }) =>
        saleRefundOut(
          row,
          lines.map((l) => ({ saleItemId: l.saleItemId, name: itemNames.get(l.saleItemId) ?? '', quantity: l.quantity, amount: l.amount })),
          employeeRefOrMissing(em, row.employeeId),
        ),
      ),
    );
  });
}

/** Codes of the given gift certificates, by id. */
function certificateCodes(db: DbOrTx, ids: Array<number | null | undefined>): Map<number, string> {
  const list = unique(ids);
  if (list.length === 0) return new Map();
  return new Map(
    db
      .select({ id: giftCertificates.id, code: giftCertificates.code })
      .from(giftCertificates)
      .where(inArray(giftCertificates.id, list))
      .all()
      .map((r) => [r.id, r.code]),
  );
}

export function getSaleRow(db: DbOrTx, id: number): SaleRow {
  const row = db.select().from(sales).where(eq(sales.id, id)).get();
  if (!row) throw notFound('Чек не найден');
  return row;
}

export function serializeSale(db: DbOrTx, row: SaleRow): SaleOut {
  const [out] = serializeSales(db, [row]);
  return out!;
}

export function getClientRow(db: DbOrTx, id: number): ClientRow {
  const row = db.select().from(clients).where(eq(clients.id, id)).get();
  if (!row) throw notFound('Клиент не найден');
  return row;
}

export function employeeRefOrMissing(map: Map<number, EmployeeRow>, id: number | null) {
  if (id == null) return null;
  const e = map.get(id);
  return e ? employeeRef(e) : missingEmployee(id);
}
