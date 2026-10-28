import { and, count, desc, eq, gte, inArray, lt, max, or, sql, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { appointments, clients, products, productVariants, saleItems, sales, services } from '../db/schema.js';
import { badRequest, conflict, insufficientStock } from '../lib/errors.js';
import { sizedName } from '../lib/jewelry.js';
import type { AppointmentRow, ProductRow, SaleRow } from '../lib/serialize.js';
import { formatRub, normalizeSearchTerm } from '../lib/text.js';
import { likePattern } from '../lib/validation.js';
import { assertBonusPayment, earnBonuses, spendBonuses } from './bonuses.js';
import { getOpenShift } from './cash.js';
import {
  assertDiscountSparesCertificates,
  CERTIFICATE_LINE_NAME,
  certificateLineName,
  certificateNominal,
  issueCertificate,
  redeemCertificates,
  resolveRedemptions,
  type CertificatePaymentInput,
  type CertificateRedemption,
} from './certificates.js';
import { applyDeposit, cancelPendingDepositCodes, heldDeposit } from './deposits.js';
import { getAppointmentRow, getSaleRow, serializeSales } from './refs.js';
import { applyConsumptionNorms, usageRecorded } from './consumption.js';
import { scheduleFollowUps } from './follow-ups.js';
import { closeReceipts } from './receipts.js';
import { CERTIFICATE_LINE } from './sale-revenue.js';
import { cancelPendingForAppointment } from './scheduling.js';
import { servicePriceFor, tillPricingMaster } from './service-prices.js';
import { applyMovement, assertInWarehouse, getProductRow, insufficientMessage, resolveVariant } from './stock.js';

export interface SaleItemInput {
  /** `certificate` — a gift certificate sold (issued by the sale; see certificates.ts). */
  type: 'product' | 'service' | 'certificate';
  productId?: number | null;
  /** The size sold; older builds omit it (allowed only for a product with one size). */
  variantId?: number | null;
  serviceId?: number | null;
  name?: string | null;
  quantity: number;
  price?: number | null;
  /** Certificate lines: whom it is for and a note, kept on the certificate. */
  recipientName?: string | null;
  note?: string | null;
}

export interface SalePayments {
  cash: number;
  card: number;
  transfer: number;
  /** Only from a QR payment the bank confirmed (see qr-payments.ts); `POST /sales` rejects it. */
  qr: number;
  /**
   * Covered by the appointment's held prepayment. `undefined` = the client predates prepayments (it never sends the
   * key), which is refused while the appointment holds one, so the prepayment cannot be charged a second time.
   */
  deposit?: number;
  /** Paid with the client's loyalty bonuses (older builds omit it). */
  bonus?: number;
  /** Gift certificates spent: their codes and amounts (their sum is `payCertificate`). */
  certificates?: CertificatePaymentInput[];
}

export interface SaleInput {
  clientId?: number | null;
  appointmentId?: number | null;
  items: SaleItemInput[];
  discount: number;
  payments: SalePayments;
  note?: string | null;
  /** The open receipt being paid: deleted with the sale. */
  receiptId?: number | null;
}

interface ResolvedItem {
  type: 'product' | 'service' | typeof CERTIFICATE_LINE;
  productId: number | null;
  variantId: number | null;
  variantName: string | null;
  serviceId: number | null;
  name: string;
  quantity: number;
  price: number;
  total: number;
  /** Certificate lines only. */
  recipientName: string | null;
  note: string | null;
}

const NO_CERTIFICATE = { recipientName: null, note: null };

function resolveCertificate(item: SaleItemInput, label: string): ResolvedItem {
  const price = certificateNominal(item, label);
  return {
    type: CERTIFICATE_LINE,
    productId: null,
    variantId: null,
    variantName: null,
    serviceId: null,
    name: CERTIFICATE_LINE_NAME,
    quantity: 1,
    price,
    total: price,
    recipientName: item.recipientName?.trim() || null,
    note: item.note?.trim() || null,
  };
}

function resolveItem(db: DbOrTx, item: SaleItemInput, position: number, masterId: number | null): ResolvedItem {
  const label = `Позиция №${position + 1}`;
  if (item.type === 'certificate') return resolveCertificate(item, label);
  if (item.type === 'product') {
    if (item.productId == null) throw badRequest(`${label}: выберите товар`);
    const product = db.select().from(products).where(eq(products.id, item.productId)).get();
    if (!product) throw badRequest(`${label}: товар не найден`);
    if (product.kind === 'consumable') throw badRequest(`«${product.name}» — расходник, его нельзя продать`);
    assertInWarehouse(product);
    const variant = resolveVariant(db, product, item.variantId, severalSizesForSale(product), `${label}: размер не найден`);
    const price = item.price ?? variant.price ?? product.price;
    return {
      type: 'product',
      productId: product.id,
      variantId: variant.id,
      variantName: variant.name.trim() || null,
      serviceId: null,
      name: sizedName(product.name, variant.name),
      quantity: item.quantity,
      price,
      total: price * item.quantity,
      ...NO_CERTIFICATE,
    };
  }
  const service = item.serviceId != null ? db.select().from(services).where(eq(services.id, item.serviceId)).get() : undefined;
  if (item.serviceId != null && !service) throw badRequest(`${label}: услуга не найдена`);
  const name = item.name?.trim() || service?.name;
  if (!name) throw badRequest(`${label}: укажите название услуги`);
  const price = item.price ?? (service ? servicePriceFor(service, null, masterId) : undefined);
  if (price == null) throw badRequest(`${label}: укажите цену`);
  return {
    type: 'service',
    productId: null,
    variantId: null,
    variantName: null,
    serviceId: service?.id ?? null,
    name,
    quantity: item.quantity,
    price,
    total: price * item.quantity,
    ...NO_CERTIFICATE,
  };
}

/**
 * Selling needs an open cash shift (docs/API.md «Sales (POS)»): `POST /sales` and a new QR code check it. A QR code the
 * bank confirms later still becomes a sale — the client has already paid.
 */
export function assertShiftOpen(db: DbOrTx): void {
  if (!getOpenShift(db)) throw conflict('Откройте кассовую смену, чтобы провести продажу');
}

/** An older build sold a product that now has several sizes: it cannot say which one. */
const severalSizesForSale = (product: ProductRow) => () =>
  conflict(`У «${product.name}» несколько размеров. Обновите приложение MIKAN, чтобы выбрать размер.`);

interface PreparedSale {
  items: ResolvedItem[];
  subtotal: number;
  total: number;
  clientId: number | null;
  appointment: AppointmentRow | null;
  /** Σ certificate lines sold (not revenue, earns no bonuses). */
  certificateTotal: number;
  bonus: number;
  /** Σ paid with certificates. */
  certificatePaid: number;
  redemptions: CertificateRedemption[];
}

/** Quantities summed per size, so two lines of one size are checked against its stock together. */
function assertInStock(db: DbOrTx, items: ResolvedItem[]): void {
  const wanted = new Map<number, { productId: number; quantity: number }>();
  for (const item of items) {
    if (item.productId == null || item.variantId == null) continue;
    const entry = wanted.get(item.variantId) ?? { productId: item.productId, quantity: 0 };
    entry.quantity += item.quantity;
    wanted.set(item.variantId, entry);
  }
  for (const [variantId, { productId, quantity }] of wanted) {
    const variant = db.select().from(productVariants).where(eq(productVariants.id, variantId)).get()!;
    if (variant.quantity < quantity) throw insufficientStock(insufficientMessage(getProductRow(db, productId), variant));
  }
}

/** The prepayment part of a checkout must be held for the appointment (and be sent at all while one is held). */
function assertDepositCovers(db: DbOrTx, appointmentId: number, deposit: number | undefined): void {
  const held = heldDeposit(db, appointmentId);
  if (deposit === undefined) {
    if (held > 0) {
      throw conflict(`По записи внесена предоплата ${formatRub(held)}. Обновите приложение MIKAN, чтобы зачесть её в чеке.`);
    }
    return;
  }
  if (deposit > held) {
    throw conflict(held > 0 ? `За записью только ${formatRub(held)} предоплаты` : 'По записи нет внесённой предоплаты');
  }
}

/**
 * A certificate line is never discounted (its nominal is what the buyer pays) and is paid with money only: a sale
 * selling one takes neither bonuses nor certificates.
 */
function assertCertificateSale(certificateTotal: number, subtotal: number, input: SaleInput): void {
  if (certificateTotal === 0) return;
  assertDiscountSparesCertificates(input.discount, subtotal, certificateTotal);
  if ((input.payments.bonus ?? 0) > 0 || (input.payments.certificates ?? []).length > 0) {
    throw badRequest('Подарочный сертификат нельзя оплатить бонусами или другим сертификатом');
  }
}

/** Validates a sale without writing anything: items, totals, payments, appointment, client and stock. */
export function prepareSale(db: DbOrTx, input: SaleInput, employeeId: number | null = null): PreparedSale {
  if (input.items.length === 0) throw badRequest('Добавьте хотя бы одну позицию');
  const masterId = tillPricingMaster(db, input.appointmentId, employeeId);
  const items = input.items.map((item, i) => resolveItem(db, item, i, masterId));
  const subtotal = items.reduce((sum, i) => sum + i.total, 0);
  if (input.discount > subtotal) throw badRequest('Скидка не может быть больше суммы чека');
  const certificateTotal = items.filter((i) => i.type === CERTIFICATE_LINE).reduce((sum, i) => sum + i.total, 0);
  assertCertificateSale(certificateTotal, subtotal, input);
  const total = subtotal - input.discount;
  const { cash, card, transfer, qr } = input.payments;
  const deposit = input.payments.deposit ?? 0;
  const bonus = input.payments.bonus ?? 0;
  const certificatePayments = input.payments.certificates ?? [];
  const certificatePaid = certificatePayments.reduce((sum, c) => sum + c.amount, 0);
  const paid = cash + card + transfer + qr + deposit + bonus + certificatePaid;
  if (paid !== total) {
    throw badRequest(`Сумма оплат (${formatRub(paid)}) не совпадает с итогом (${formatRub(total)})`);
  }
  if (deposit > 0 && input.appointmentId == null) throw badRequest('Предоплату можно зачесть только в чеке по записи');

  let clientId = input.clientId ?? null;
  const appointment = input.appointmentId != null ? getAppointmentRow(db, input.appointmentId) : null;
  if (appointment) {
    if (appointment.saleId != null) {
      const linked = db.select().from(sales).where(eq(sales.id, appointment.saleId)).get();
      if (linked && linked.status === 'completed') throw conflict(`Запись уже оплачена (чек №${linked.number})`);
    }
    clientId = clientId ?? appointment.clientId;
    assertDepositCovers(db, appointment.id, input.payments.deposit);
  }
  if (clientId != null && !db.select({ id: clients.id }).from(clients).where(eq(clients.id, clientId)).get()) {
    throw badRequest('Клиент не найден');
  }
  assertBonusPayment(db, clientId, bonus, total);
  const redemptions = resolveRedemptions(db, certificatePayments);
  assertInStock(db, items);
  return { items, subtotal, total, clientId, appointment, certificateTotal, bonus, certificatePaid, redemptions };
}

/** Issues the certificates of the sale's certificate lines and returns the rows to store, in order. */
function saleLines(db: DbOrTx, sale: SaleRow, items: ResolvedItem[], employeeId: number, now: number) {
  return items.map(({ recipientName, note, ...item }) => {
    if (item.type !== CERTIFICATE_LINE) return { ...item, saleId: sale.id, certificateId: null };
    const certificate = issueCertificate(db, {
      amount: item.total,
      recipientName,
      note,
      buyerClientId: sale.clientId,
      saleId: sale.id,
      employeeId,
      now,
    });
    return { ...item, name: certificateLineName(certificate.code), saleId: sale.id, certificateId: certificate.id };
  });
}

export function createSale(db: DbOrTx, input: SaleInput, employeeId: number): SaleRow {
  return db.transaction((tx) => {
    const prepared = prepareSale(tx, input, employeeId);
    const { items, subtotal, total, clientId, appointment } = prepared;

    const now = Date.now();
    const number = (tx.select({ n: max(sales.number) }).from(sales).get()?.n ?? 0) + 1;
    const sale = tx
      .insert(sales)
      .values({
        number,
        clientId,
        employeeId,
        appointmentId: appointment?.id ?? null,
        shiftId: getOpenShift(tx)?.id ?? null,
        subtotal,
        discount: input.discount,
        total,
        payCash: input.payments.cash,
        payCard: input.payments.card,
        payTransfer: input.payments.transfer,
        payQr: input.payments.qr,
        payDeposit: input.payments.deposit ?? 0,
        payBonus: prepared.bonus,
        payCertificate: prepared.certificatePaid,
        status: 'completed',
        note: input.note ?? null,
        createdAt: now,
      })
      .returning()
      .get();
    tx.insert(saleItems).values(saleLines(tx, sale, items, employeeId, now)).run();
    for (const item of items) {
      if (item.type === 'product' && item.productId != null && item.variantId != null) {
        applyMovement(tx, {
          productId: item.productId,
          variantId: item.variantId,
          delta: -item.quantity,
          type: 'sale',
          saleId: sale.id,
          employeeId,
        });
      }
    }
    applyDeposit(tx, sale, sale.payDeposit, employeeId);
    spendBonuses(tx, sale, employeeId, now);
    redeemCertificates(tx, prepared.redemptions, sale.id, employeeId, now);
    earnBonuses(tx, sale, total - prepared.bonus - prepared.certificatePaid - prepared.certificateTotal, employeeId, now);
    if (appointment) {
      const completing = appointment.status !== 'completed';
      tx.update(appointments)
        .set({
          saleId: sale.id,
          status: 'completed',
          completedAt: appointment.completedAt ?? (completing ? now : null),
          updatedAt: now,
        })
        .where(eq(appointments.id, appointment.id))
        .run();
      if (completing) cancelPendingForAppointment(tx, appointment.id, 'reminder');
      // A visit completed by its payment consumes its services' norms, unless staff already recorded usage.
      if (completing && !usageRecorded(tx, appointment.id)) applyConsumptionNorms(tx, appointment, employeeId);
      if (completing) scheduleFollowUps(tx, appointment, appointment.completedAt ?? now, now);
      cancelPendingDepositCodes(tx, appointment.id, now);
    }
    closeReceipts(tx, input.receiptId, appointment?.id);
    return sale;
  });
}

/** A bare number this short is a receipt number only; from this many digits it is also looked for in phones. */
const PHONE_DIGITS_MIN = 3;

/**
 * `GET /sales?search=`: «17» / «№17» — the receipt number; phone-like digits — the client's phone too (anywhere in
 * it); any other text — the client's name (the card's search text, as in the client list).
 */
function saleSearch(db: DbOrTx, search: string): SQL | undefined {
  const term = normalizeSearchTerm(search);
  if (!term) return undefined;
  const numbered = /^[№#]\s*(\d{1,9})$/.exec(term);
  if (numbered) return eq(sales.number, Number(numbered[1]));
  const clientsMatching = (pattern: string) =>
    inArray(sales.clientId, db.select({ id: clients.id }).from(clients).where(sql`${clients.searchText} like ${likePattern(pattern)} escape '\\'`));
  const digits = term.replace(/\D/g, '');
  if (!/^[\d\s+()-]+$/.test(term) || digits === '') return clientsMatching(term);
  if (!/^\d{1,9}$/.test(term)) return clientsMatching(digits);
  const byNumber = eq(sales.number, Number(term));
  return digits.length < PHONE_DIGITS_MIN ? byNumber : or(byNumber, clientsMatching(digits));
}

export function listSales(
  db: DbOrTx,
  f: { from?: number; to?: number; clientId?: number; search?: string; limit: number; offset: number },
) {
  const conditions = [];
  if (f.from !== undefined) conditions.push(gte(sales.createdAt, f.from));
  if (f.to !== undefined) conditions.push(lt(sales.createdAt, f.to));
  if (f.clientId !== undefined) conditions.push(eq(sales.clientId, f.clientId));
  const search = f.search ? saleSearch(db, f.search) : undefined;
  if (search) conditions.push(search);
  const where = conditions.length ? and(...conditions) : undefined;
  const rows = db.select().from(sales).where(where).orderBy(desc(sales.createdAt), desc(sales.id)).limit(f.limit).offset(f.offset).all();
  const total = db.select({ n: count() }).from(sales).where(where).get()?.n ?? 0;
  return { items: serializeSales(db, rows), total };
}
