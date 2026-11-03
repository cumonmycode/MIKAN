import { asc, eq, inArray, or } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { appointments, clients, openReceipts, products, sales, services } from '../db/schema.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { sizedName } from '../lib/jewelry.js';
import { clientRef, type AppointmentRow, type OpenReceiptRow } from '../lib/serialize.js';
import { toIso } from '../lib/time.js';
import {
  clientsByIds,
  employeeRefOrMissing,
  employeesByIds,
  productsByIds,
  serializeAppointments,
  serviceLinesByAppointment,
  servicesByIds,
  variantsByIds,
} from './refs.js';
import { assertDiscountSparesCertificates, CERTIFICATE_LINE_NAME, certificateNominal } from './certificates.js';
import { servicePriceFor, tillPricingMaster } from './service-prices.js';
import { assertInWarehouse, resolveVariant } from './stock.js';

/** A line of an open receipt as stored in `open_receipts.items_json`. */
export interface ReceiptItem {
  /** `certificate` — a gift certificate to sell (issued by the sale that pays the receipt). */
  type: 'product' | 'service' | 'certificate';
  productId: number | null;
  variantId: number | null;
  serviceId: number | null;
  /** The sized product name or the service line name, as resolved when saved. */
  name: string;
  quantity: number;
  price: number;
  /** Certificate lines: whom it is for and a note. */
  recipientName?: string | null;
  note?: string | null;
}

/** A line as the app sends it: the shape of a sale item. */
export interface ReceiptItemInput {
  type: 'product' | 'service' | 'certificate';
  productId?: number | null;
  variantId?: number | null;
  serviceId?: number | null;
  name?: string | null;
  quantity: number;
  price?: number | null;
  recipientName?: string | null;
  note?: string | null;
}

export interface ReceiptInput {
  appointmentId?: number | null;
  clientId?: number | null;
  /** `undefined` on create with an appointment — its service lines. */
  items?: ReceiptItemInput[];
  discount?: number;
  note?: string | null;
}

const RECEIPT_GONE = 'Чек уже оплачен или удалён';

/** `masterId` — whose prices a service line without a price gets (see `tillPricingMaster`). */
function resolveItem(db: DbOrTx, item: ReceiptItemInput, position: number, masterId: number | null): ReceiptItem {
  const label = `Позиция №${position + 1}`;
  if (item.type === 'certificate') {
    return {
      type: 'certificate',
      productId: null,
      variantId: null,
      serviceId: null,
      name: CERTIFICATE_LINE_NAME,
      quantity: 1,
      price: certificateNominal(item, label),
      recipientName: item.recipientName?.trim() || null,
      note: item.note?.trim() || null,
    };
  }
  if (item.type === 'product') {
    if (item.productId == null) throw badRequest(`${label}: выберите товар`);
    const product = db.select().from(products).where(eq(products.id, item.productId)).get();
    if (!product) throw badRequest(`${label}: товар не найден`);
    if (product.kind === 'consumable') throw badRequest(`«${product.name}» — расходник, его нельзя продать`);
    assertInWarehouse(product);
    const variant = resolveVariant(
      db,
      product,
      item.variantId,
      () => badRequest(`Выберите размер «${product.name}»`),
      `${label}: размер не найден`,
    );
    return {
      type: 'product',
      productId: product.id,
      variantId: variant.id,
      serviceId: null,
      name: sizedName(product.name, variant.name),
      quantity: item.quantity,
      price: item.price ?? variant.price ?? product.price,
    };
  }
  const service = item.serviceId != null ? db.select().from(services).where(eq(services.id, item.serviceId)).get() : undefined;
  if (item.serviceId != null && !service) throw badRequest(`${label}: услуга не найдена`);
  const name = item.name?.trim() || service?.name;
  if (!name) throw badRequest(`${label}: укажите название услуги`);
  return {
    type: 'service',
    productId: null,
    variantId: null,
    serviceId: service?.id ?? null,
    name,
    quantity: item.quantity,
    price: item.price ?? (service ? servicePriceFor(service, null, masterId) : 0),
  };
}

const resolveItems = (db: DbOrTx, items: ReceiptItemInput[], masterId: number | null): ReceiptItem[] =>
  items.map((item, i) => resolveItem(db, item, i, masterId));

const subtotalOf = (items: Array<Pick<ReceiptItem, 'price' | 'quantity'>>) =>
  items.reduce((sum, i) => sum + i.price * i.quantity, 0);

function assertDiscount(items: ReceiptItem[], discount: number): void {
  const subtotal = subtotalOf(items);
  if (discount > subtotal) throw badRequest('Скидка не может быть больше суммы чека');
  assertDiscountSparesCertificates(discount, subtotal, subtotalOf(items.filter((i) => i.type === 'certificate')));
}

function clientMustExist(db: DbOrTx, clientId: number | null): void {
  if (clientId != null && !db.select({ id: clients.id }).from(clients).where(eq(clients.id, clientId)).get()) {
    throw badRequest('Клиент не найден');
  }
}

/** Only a visit that can still be paid moves to the POS. */
function assertReceiptable(db: DbOrTx, appointment: AppointmentRow): void {
  if (appointment.saleId != null) {
    const sale = db.select().from(sales).where(eq(sales.id, appointment.saleId)).get();
    if (sale && sale.status === 'completed') throw conflict(`Запись уже оплачена (чек №${sale.number})`);
  }
  if (appointment.status === 'cancelled') throw conflict('Запись отменена — верните её в расписание, чтобы открыть чек');
  if (appointment.status === 'no_show') throw conflict('Запись отмечена неявкой — верните её в расписание, чтобы открыть чек');
}

/**
 * The appointment's service lines, one per booked line when their prices add up to the appointment price; otherwise
 * (no lines, or a price set for the whole appointment) one line at the appointment price. Mirrors the app's rule.
 */
export function appointmentItems(db: DbOrTx, appointment: AppointmentRow): ReceiptItem[] {
  const lines = serviceLinesByAppointment(db, [appointment.id]).get(appointment.id) ?? [];
  if (lines.length > 0 && subtotalOf(lines.map((l) => ({ price: l.price, quantity: 1 }))) === appointment.price) {
    return lines.map((l) => ({
      type: 'service',
      productId: null,
      variantId: null,
      serviceId: l.serviceId,
      name: l.name,
      quantity: 1,
      price: l.price,
    }));
  }
  const legacyService =
    lines.length === 0 && appointment.serviceId != null
      ? servicesByIds(db, [appointment.serviceId]).get(appointment.serviceId)
      : undefined;
  const name =
    (lines.length > 0 ? lines.map((l) => l.name).join(', ') : legacyService?.name) || appointment.title?.trim() || 'Услуга';
  return [
    {
      type: 'service',
      productId: null,
      variantId: null,
      serviceId: lines.length === 1 ? lines[0]!.serviceId : appointment.serviceId,
      name,
      quantity: 1,
      price: appointment.price,
    },
  ];
}

export function getReceiptRow(db: DbOrTx, id: number): OpenReceiptRow {
  const row = db.select().from(openReceipts).where(eq(openReceipts.id, id)).get();
  if (!row) throw notFound(RECEIPT_GONE);
  return row;
}

function receiptOfAppointment(db: DbOrTx, appointmentId: number): OpenReceiptRow | undefined {
  return db.select().from(openReceipts).where(eq(openReceipts.appointmentId, appointmentId)).get();
}

function getAppointmentOrMissing(db: DbOrTx, id: number): AppointmentRow {
  const row = db.select().from(appointments).where(eq(appointments.id, id)).get();
  if (!row) throw badRequest('Запись не найдена');
  return row;
}

/**
 * Opens a receipt. With `appointmentId` this is «Начать визит»: the appointment's open receipt is returned unchanged
 * when there is one, so two devices starting the same visit share it.
 */
export function createReceipt(db: DbOrTx, input: ReceiptInput, employeeId: number): OpenReceiptRow {
  return db.transaction((tx) => {
    let items: ReceiptItem[];
    let clientId = input.clientId ?? null;
    if (input.appointmentId != null) {
      const existing = receiptOfAppointment(tx, input.appointmentId);
      if (existing) return existing;
      const appointment = getAppointmentOrMissing(tx, input.appointmentId);
      assertReceiptable(tx, appointment);
      items = input.items ? resolveItems(tx, input.items, tillPricingMaster(tx, appointment.id, employeeId)) : appointmentItems(tx, appointment);
      clientId = clientId ?? appointment.clientId;
    } else {
      items = resolveItems(tx, input.items ?? [], tillPricingMaster(tx, null, employeeId));
    }
    clientMustExist(tx, clientId);
    const discount = input.discount ?? 0;
    assertDiscount(items, discount);
    const now = Date.now();
    return tx
      .insert(openReceipts)
      .values({
        appointmentId: input.appointmentId ?? null,
        clientId,
        employeeId,
        itemsJson: JSON.stringify(items),
        discount,
        note: input.note ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
  });
}

/** Replaces the whole receipt with what the app sends (omitted appointment, client and note = none). */
export function updateReceipt(db: DbOrTx, id: number, input: ReceiptInput): OpenReceiptRow {
  return db.transaction((tx) => {
    const current = getReceiptRow(tx, id);
    const appointmentId = input.appointmentId ?? null;
    if (appointmentId != null && appointmentId !== current.appointmentId) {
      const other = receiptOfAppointment(tx, appointmentId);
      if (other && other.id !== id) throw conflict('По этой записи уже открыт другой чек');
      assertReceiptable(tx, getAppointmentOrMissing(tx, appointmentId));
    }
    // Service prices of the appointment's master, else of the employee who opened the receipt.
    const items = resolveItems(tx, input.items ?? [], tillPricingMaster(tx, appointmentId, current.employeeId));
    const clientId = input.clientId ?? null;
    clientMustExist(tx, clientId);
    const discount = input.discount ?? 0;
    assertDiscount(items, discount);
    return tx
      .update(openReceipts)
      .set({ appointmentId, clientId, itemsJson: JSON.stringify(items), discount, note: input.note ?? null, updatedAt: Date.now() })
      .where(eq(openReceipts.id, id))
      .returning()
      .get()!;
  });
}

/** Removes an open receipt and nothing else: no stock moves, a prepayment stays held. */
export function deleteReceipt(db: DbOrTx, id: number): void {
  const deleted = db.delete(openReceipts).where(eq(openReceipts.id, id)).returning({ id: openReceipts.id }).get();
  if (!deleted) throw notFound(RECEIPT_GONE);
}

/** A sale closes the receipt it paid and the open receipt of its appointment (sales from older builds, QR). */
export function closeReceipts(db: DbOrTx, receiptId: number | null | undefined, appointmentId: number | null | undefined): void {
  const conditions = [];
  if (receiptId != null) conditions.push(eq(openReceipts.id, receiptId));
  if (appointmentId != null) conditions.push(eq(openReceipts.appointmentId, appointmentId));
  if (conditions.length > 0) db.delete(openReceipts).where(or(...conditions)).run();
}

/** A cancelled visit or a no-show leaves the POS. */
export function deleteReceiptOfAppointment(db: DbOrTx, appointmentId: number): void {
  db.delete(openReceipts).where(eq(openReceipts.appointmentId, appointmentId)).run();
}

export function listReceipts(db: DbOrTx): OpenReceiptRow[] {
  return db.select().from(openReceipts).orderBy(asc(openReceipts.createdAt), asc(openReceipts.id)).all();
}

function parseItems(json: string): ReceiptItem[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as ReceiptItem[]) : [];
  } catch {
    return [];
  }
}

export function serializeReceipts(db: DbOrTx, rows: OpenReceiptRow[]) {
  if (rows.length === 0) return [];
  const parsed = rows.map((row) => ({ row, items: parseItems(row.itemsJson) }));
  const allItems = parsed.flatMap((p) => p.items);
  const productMap = productsByIds(db, allItems.map((i) => i.productId));
  const variantMap = variantsByIds(db, allItems.map((i) => i.variantId));
  const clientMap = clientsByIds(db, rows.map((r) => r.clientId));
  const employeeMap = employeesByIds(db, rows.map((r) => r.employeeId));
  const appointmentIds = rows.map((r) => r.appointmentId).filter((id): id is number => id != null);
  const appointmentRows = appointmentIds.length
    ? db.select().from(appointments).where(inArray(appointments.id, appointmentIds)).all()
    : [];
  const appointmentMap = new Map(serializeAppointments(db, appointmentRows).map((a) => [a.id, a]));

  return parsed.map(({ row, items }) => {
    const lines = items.map((item) => {
      const product = item.productId != null ? productMap.get(item.productId) : undefined;
      const variant = item.variantId != null ? variantMap.get(item.variantId) : undefined;
      const isProduct = item.type === 'product';
      const isCertificate = item.type === 'certificate';
      return {
        // A certificate to sell goes out as a service line with `certificate` (older builds know two types).
        type: isCertificate ? 'service' : item.type,
        productId: item.productId,
        variantId: item.variantId,
        variantName: isProduct && variant ? variant.name.trim() || null : null,
        productKind: isProduct ? (product?.kind ?? null) : null,
        serviceId: item.serviceId,
        name: isProduct && product ? sizedName(product.name, variant?.name) : item.name,
        quantity: item.quantity,
        price: item.price,
        total: item.price * item.quantity,
        stock: isProduct && variant && !variant.archived ? variant.quantity : null,
        certificate: isCertificate ? { recipientName: item.recipientName ?? null, note: item.note ?? null } : null,
      };
    });
    const subtotal = lines.reduce((sum, l) => sum + l.total, 0);
    const client = row.clientId != null ? clientMap.get(row.clientId) : undefined;
    return {
      id: row.id,
      appointment: row.appointmentId != null ? (appointmentMap.get(row.appointmentId) ?? null) : null,
      client: client ? clientRef(client) : null,
      items: lines,
      subtotal,
      discount: row.discount,
      total: Math.max(0, subtotal - row.discount),
      itemCount: lines.reduce((sum, l) => sum + l.quantity, 0),
      note: row.note,
      openedBy: employeeRefOrMissing(employeeMap, row.employeeId),
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    };
  });
}

export function serializeReceipt(db: DbOrTx, row: OpenReceiptRow) {
  return serializeReceipts(db, [row])[0]!;
}
