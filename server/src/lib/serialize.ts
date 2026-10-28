import type * as s from '../db/schema.js';
import type { AppointmentCancellationOut } from '../domain/cancellation.js';
import { toIso } from './time.js';

type Row<T extends { $inferSelect: unknown }> = T['$inferSelect'];
export type EmployeeRow = Row<typeof s.employees>;
export type ClientRow = Row<typeof s.clients>;
export type ServiceRow = Row<typeof s.services>;
export type TemplateRow = Row<typeof s.aftercareTemplates>;
export type ProductRow = Row<typeof s.products>;
export type VariantRow = Row<typeof s.productVariants>;
export type MovementRow = Row<typeof s.stockMovements>;
export type AppointmentRow = Row<typeof s.appointments>;
export type AppointmentServiceRow = Row<typeof s.appointmentServices>;
export type SaleRow = Row<typeof s.sales>;
export type SaleItemRow = Row<typeof s.saleItems>;
export type SaleRefundRow = Row<typeof s.saleRefunds>;
export type SaleRefundItemRow = Row<typeof s.saleRefundItems>;
export type ShiftRow = Row<typeof s.cashShifts>;
export type QrPaymentRow = Row<typeof s.qrPayments>;
export type DepositOperationRow = Row<typeof s.depositOperations>;
export type CashOpRow = Row<typeof s.cashOperations>;
export type BotChatRow = Row<typeof s.botChats>;
export type BotMessageRow = Row<typeof s.botMessages>;
export type ScheduledRow = Row<typeof s.scheduledMessages>;
export type BookingRow = Row<typeof s.bookingRequests>;
export type KnowledgeRow = Row<typeof s.knowledgeEntries>;
export type OpenReceiptRow = Row<typeof s.openReceipts>;

export interface EmployeeRef {
  id: number;
  name: string;
  color: string;
}
export interface ClientRef {
  id: number;
  name: string;
  lastName: string | null;
  phone: string | null;
  telegramLinked: boolean;
}
export interface ServiceRef {
  id: number;
  name: string;
  category: string;
}
export interface AftercareStep {
  dayOffset: number;
  text: string;
}
export interface ServiceVariant {
  name: string;
  price: number;
  durationMin: number | null;
}
/** A master's own prices of a service (docs/API.md «Service» `masterPrices`). */
export interface MasterPrice {
  employeeId: number;
  price: number;
  priceMax: number | null;
  /** Their price of a variant, by the variant's current name. */
  variants: Array<{ name: string; price: number }>;
}
export interface ClientStats {
  visits: number;
  totalSpent: number;
  lastVisitAt: string | null;
  upcomingAppointments: number;
}

export const employeeRef = (e: EmployeeRow): EmployeeRef => ({ id: e.id, name: e.name, color: e.color });

export const employeeOut = (e: EmployeeRow) => ({
  id: e.id,
  name: e.name,
  login: e.login,
  phone: e.phone,
  color: e.color,
  isMaster: e.isMaster,
  role: e.role,
  active: e.active,
  createdAt: toIso(e.createdAt),
});

/** "Имя Фамилия" — how staff, the bot and its notifications name a client. */
export const clientFullName = (c: Pick<ClientRow, 'name' | 'lastName'>): string =>
  [c.name, c.lastName].map((part) => part?.trim()).filter(Boolean).join(' ');

export const clientRef = (c: ClientRow): ClientRef => ({
  id: c.id,
  name: c.name,
  lastName: c.lastName,
  phone: c.phone,
  telegramLinked: c.telegramChatId != null,
});

/** `Client.loyalty` of the client card (domain/loyalty.ts); `null` in lists. */
export interface ClientLoyalty {
  bonusBalance: number;
  expiring: { amount: number; at: string } | null;
  birthdayDiscount: { percent: number; until: string } | null;
}

export const clientOut = (c: ClientRow, stats: ClientStats | null = null, loyalty: ClientLoyalty | null = null) => ({
  id: c.id,
  name: c.name,
  lastName: c.lastName,
  phone: c.phone,
  instagram: c.instagram,
  telegramNick: c.telegramNick,
  birthday: c.birthday,
  notes: c.notes,
  source: c.source,
  telegramLinked: c.telegramChatId != null,
  telegramUsername: c.telegramUsername,
  botEnabled: c.botEnabled,
  archived: c.archived,
  createdAt: toIso(c.createdAt),
  updatedAt: toIso(c.updatedAt),
  marketingOptOut: c.marketingOptOut,
  stats,
  loyalty,
});

export const serviceRef = (sv: ServiceRow): ServiceRef => ({ id: sv.id, name: sv.name, category: sv.category });

export const serviceOut = (sv: ServiceRow) => ({
  id: sv.id,
  name: sv.name,
  category: sv.category,
  group: sv.groupName,
  price: sv.price,
  priceMax: sv.priceMax,
  priceFrom: sv.priceFrom,
  durationMin: sv.durationMin,
  description: sv.description,
  imageUrl: sv.imageUrl,
  imagePrompt: sv.imagePrompt,
  photos: parsePhotos(sv.photosJson),
  variants: parseVariants(sv.variantsJson),
  depositAmount: sv.depositAmount,
  masterPrices: parseMasterPrices(sv.masterPricesJson),
  aftercareTemplateId: sv.aftercareTemplateId,
  freshProcedure: sv.freshProcedure,
  healingCheckDays: sv.healingCheckDays,
  jewelryChangeWeeks: sv.jewelryChangeWeeks,
  active: sv.active,
  sort: sv.sort,
});

function parseJsonArray(json: string): unknown[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

export function parsePhotos(json: string): string[] {
  return parseJsonArray(json).filter((x): x is string => typeof x === 'string');
}

export function parseVariants(json: string): ServiceVariant[] {
  return parseJsonArray(json)
    .filter((x): x is ServiceVariant => typeof (x as ServiceVariant)?.name === 'string' && typeof (x as ServiceVariant)?.price === 'number')
    .map((x) => ({ name: x.name, price: x.price, durationMin: typeof x.durationMin === 'number' ? x.durationMin : null }));
}

const isAmount = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

export function parseMasterPrices(json: string): MasterPrice[] {
  return parseJsonArray(json)
    .filter((x): x is MasterPrice => Number.isInteger((x as MasterPrice)?.employeeId) && isAmount((x as MasterPrice)?.price))
    .map((x) => ({
      employeeId: x.employeeId,
      price: x.price,
      priceMax: isAmount(x.priceMax) ? x.priceMax : null,
      variants: (Array.isArray(x.variants) ? x.variants : [])
        .filter((v) => typeof v?.name === 'string' && isAmount(v?.price))
        .map((v) => ({ name: v.name, price: v.price })),
    }));
}

export function parseSteps(json: string): AftercareStep[] {
  try {
    const value: unknown = JSON.parse(json);
    if (!Array.isArray(value)) return [];
    return value
      .filter((x): x is AftercareStep => typeof x?.dayOffset === 'number' && typeof x?.text === 'string')
      .map((x) => ({ dayOffset: x.dayOffset, text: x.text }));
  } catch {
    return [];
  }
}

export const templateOut = (t: TemplateRow) => ({
  id: t.id,
  name: t.name,
  category: t.category,
  steps: parseSteps(t.stepsJson),
  createdAt: toIso(t.createdAt),
  updatedAt: toIso(t.updatedAt),
});

export const isLowStock = (v: Pick<VariantRow, 'quantity' | 'minQuantity'>): boolean => v.quantity <= v.minQuantity;

export const variantOut = (v: VariantRow) => ({
  id: v.id,
  name: v.name,
  sku: v.sku,
  price: v.price,
  cost: v.cost,
  quantity: v.quantity,
  minQuantity: v.minQuantity,
  lowStock: isLowStock(v),
});

/**
 * `variants` — the product's current (not archived) sizes in order. Product-level `quantity`, `minQuantity`,
 * `lowStock` and `size` are derived from them for older app builds.
 */
export const productOut = (p: ProductRow, variants: VariantRow[], serviceIds: number[]) => {
  const photos = parsePhotos(p.photosJson);
  const sizeNames = variants.map((v) => v.name.trim()).filter(Boolean);
  return {
    id: p.id,
    kind: p.kind,
    name: p.name,
    sku: p.sku,
    category: p.category,
    material: p.material,
    threadType: p.threadType,
    thicknessMm: p.thicknessMm,
    color: p.color,
    stone: p.stone,
    supplier: p.supplier,
    description: p.description,
    price: p.price,
    cost: p.cost,
    unit: p.unit,
    photos,
    photoUrl: photos[0] ?? null,
    serviceIds,
    stockMode: p.stockMode,
    presenceStatus: p.stockMode === 'presence' ? p.presenceStatus : null,
    active: p.active,
    archived: p.archived,
    variants: variants.map(variantOut),
    quantity: variants.reduce((sum, v) => sum + v.quantity, 0),
    minQuantity: variants.reduce((sum, v) => sum + v.minQuantity, 0),
    lowStock: p.stockMode === 'presence' ? p.presenceStatus !== 'ok' : variants.some(isLowStock),
    size: sizeNames.length ? sizeNames.join(', ') : null,
    createdAt: toIso(p.createdAt),
    updatedAt: toIso(p.updatedAt),
  };
};
export type ProductOut = ReturnType<typeof productOut>;

export const movementOut = (m: MovementRow, productName: string, variantName: string, employee: EmployeeRef | null) => ({
  id: m.id,
  productId: m.productId,
  productName,
  variantId: m.variantId,
  variantName,
  delta: m.delta,
  quantityAfter: m.quantityAfter,
  type: m.type,
  note: m.note,
  saleId: m.saleId,
  appointmentId: m.appointmentId,
  revisionId: m.revisionId,
  deliveryId: m.deliveryId,
  amount: m.amount,
  employee,
  createdAt: toIso(m.createdAt),
});

export const appointmentServiceOut = (line: AppointmentServiceRow, category: string | null) => ({
  id: line.id,
  serviceId: line.serviceId,
  name: line.name,
  category,
  price: line.price,
  durationMin: line.durationMin,
});
export type AppointmentServiceOut = ReturnType<typeof appointmentServiceOut>;

export const depositOperationOut = (op: DepositOperationRow, employee: EmployeeRef | null) => ({
  id: op.id,
  appointmentId: op.appointmentId,
  type: op.type,
  amount: op.amount,
  method: op.method,
  saleId: op.saleId,
  shiftId: op.shiftId,
  qrPaymentId: op.qrPaymentId,
  note: op.note,
  employee,
  createdAt: toIso(op.createdAt),
});
export type DepositOperationOut = ReturnType<typeof depositOperationOut>;

/** `sale` is the sale created from a paid checkout code (always `null` for prepayment codes). */
export const qrPaymentOut = (row: QrPaymentRow, sale: SaleOut | null) => ({
  id: row.id,
  kind: row.kind,
  appointmentId: row.appointmentId,
  status: row.status,
  amount: row.amount,
  payload: row.payload,
  expiresAt: toIso(row.expiresAt),
  sentAt: toIso(row.sentAt),
  error: row.error,
  sale,
  createdAt: toIso(row.createdAt),
});
export type QrPaymentOut = ReturnType<typeof qrPaymentOut>;

/** An appointment's prepayment as shown with it (see `deposit-ledger.ts`). */
export interface AppointmentDepositOut {
  held: number;
  status: string;
  operations: DepositOperationOut[];
  link: QrPaymentOut | null;
}

export const appointmentOut = (
  a: AppointmentRow,
  client: ClientRef,
  master: EmployeeRef,
  service: ServiceRef | null,
  services: AppointmentServiceOut[],
  deposit: AppointmentDepositOut,
  /** Its open receipt in the POS (the visit has started). */
  receiptId: number | null,
  /** What the studio's cancellation rules mean for it (see domain/cancellation.ts). */
  cancellation: AppointmentCancellationOut | null,
) => ({
  id: a.id,
  client,
  master,
  service,
  services,
  title: a.title,
  startsAt: toIso(a.startsAt),
  endsAt: toIso(a.endsAt),
  status: a.status,
  price: a.price,
  deposit: deposit.held,
  depositRequired: a.depositRequired,
  depositStatus: deposit.status,
  depositOperations: deposit.operations,
  depositLink: deposit.link,
  notes: a.notes,
  saleId: a.saleId,
  receiptId,
  completedAt: toIso(a.completedAt),
  createdAt: toIso(a.createdAt),
  updatedAt: toIso(a.updatedAt),
  cancellation,
  channel: a.channel,
  ...onlineOut(a),
});
export type AppointmentOut = ReturnType<typeof appointmentOut>;

/** Statuses in which an online booking may still wait to be settled. */
const UNSETTLED_STATUSES = ['scheduled', 'confirmed'];

/**
 * `onlineState` / `holdUntil` of an appointment: an online booking not settled yet. Once it is closed (cancelled,
 * completed, no-show) it waits for nothing, whatever the stored state says.
 */
function onlineOut(a: AppointmentRow): { onlineState: string | null; holdUntil: string | null } {
  const onlineState = a.onlineState != null && UNSETTLED_STATUSES.includes(a.status) ? a.onlineState : null;
  return { onlineState, holdUntil: onlineState === 'awaiting_payment' ? toIso(a.holdUntil) : null };
}

/**
 * A sale line on the wire. A gift certificate line is stored as `certificate` and sent as `service` with
 * `certificateId` and `certificateCode` (older builds know only `product` | `service`).
 */
export const saleItemOut = (i: SaleItemRow, certificateCode: string | null = null) => ({
  id: i.id,
  type: i.type === 'certificate' ? 'service' : i.type,
  productId: i.productId,
  variantId: i.variantId,
  variantName: i.variantName,
  serviceId: i.serviceId,
  certificateId: i.certificateId,
  certificateCode,
  name: i.name,
  quantity: i.quantity,
  price: i.price,
  total: i.total,
  refundedQuantity: i.refundedQuantity,
});

/** A refund of a sale (docs/API.md «SaleRefund»); `items` carry the sale line's name. */
export const saleRefundOut = (
  r: SaleRefundRow,
  items: Array<{ saleItemId: number; name: string; quantity: number; amount: number }>,
  employee: EmployeeRef | null,
) => ({
  id: r.id,
  saleId: r.saleId,
  items,
  amount: r.amount,
  payments: {
    cash: r.payCash,
    card: r.payCard,
    transfer: r.payTransfer,
    qr: r.payQr,
    deposit: r.payDeposit,
    bonus: r.payBonus,
    certificate: r.payCertificate,
  },
  bonusTakenBack: r.bonusTakenBack,
  restock: r.restock,
  reason: r.reason,
  employee,
  shiftId: r.shiftId,
  createdAt: toIso(r.createdAt),
});
export type SaleRefundOut = ReturnType<typeof saleRefundOut>;

export const saleOut = (
  sale: SaleRow,
  items: SaleItemRow[],
  client: ClientRef | null,
  employee: EmployeeRef,
  /** Bonuses credited for the sale (0 when none). */
  bonusEarned = 0,
  /** Codes of the certificates its lines sold, by certificate id. */
  certificateCodes: ReadonlyMap<number, string> = new Map(),
  /** Its refunds, oldest first. */
  refunds: SaleRefundOut[] = [],
) => ({
  id: sale.id,
  number: sale.number,
  client,
  employee,
  appointmentId: sale.appointmentId,
  shiftId: sale.shiftId,
  items: items.map((i) => saleItemOut(i, i.certificateId != null ? (certificateCodes.get(i.certificateId) ?? null) : null)),
  subtotal: sale.subtotal,
  discount: sale.discount,
  total: sale.total,
  payments: {
    cash: sale.payCash,
    card: sale.payCard,
    transfer: sale.payTransfer,
    qr: sale.payQr,
    deposit: sale.payDeposit,
    bonus: sale.payBonus,
    certificate: sale.payCertificate,
  },
  bonusEarned,
  status: sale.status,
  note: sale.note,
  refundedAt: toIso(sale.refundedAt),
  refundReason: sale.refundReason,
  refundedTotal: sale.refundedTotal,
  refunds,
  receiptSentAt: toIso(sale.receiptSentAt),
  createdAt: toIso(sale.createdAt),
});
export type SaleOut = ReturnType<typeof saleOut>;

/**
 * One line of a client's / service's / product's history: a service performed in a completed appointment, or an
 * item of a sale. Built by `domain/history.ts`.
 */
export interface HistoryEntryOut {
  /** Stable key: `as<line id>` (appointment service line), `at<appointment id>` (appointment without lines),
   *  `si<sale item id>` (sale item). */
  id: string;
  kind: 'service' | 'product';
  date: string;
  name: string;
  serviceId: number | null;
  productId: number | null;
  /** The size sold (product entries). */
  variantId: number | null;
  variantName: string | null;
  quantity: number;
  price: number;
  total: number;
  client: ClientRef | null;
  employee: EmployeeRef | null;
  appointmentId: number | null;
  saleId: number | null;
  saleNumber: number | null;
  refunded: boolean;
}

export const cashOpOut = (o: CashOpRow, employee: EmployeeRef) => ({
  id: o.id,
  shiftId: o.shiftId,
  type: o.type,
  amount: o.amount,
  reason: o.reason,
  employee,
  createdAt: toIso(o.createdAt),
});

export const botMessageOut = (m: BotMessageRow, employee: EmployeeRef | null) => ({
  id: m.id,
  chatId: m.chatId,
  role: m.role,
  text: m.text,
  employee,
  createdAt: toIso(m.createdAt),
});
export type BotMessageOut = ReturnType<typeof botMessageOut>;

export const botChatOut = (
  c: BotChatRow,
  client: ClientRef | null,
  lastMessage: BotMessageOut | null,
  employee: EmployeeRef | null = null,
) => ({
  chatId: c.chatId,
  client,
  employee,
  telegramName: c.telegramName,
  username: c.username,
  aiPaused: c.aiPaused,
  needsAttention: c.needsAttention,
  unreadCount: c.unreadCount,
  lastMessage,
  updatedAt: toIso(c.updatedAt),
});

export const scheduledOut = (m: ScheduledRow, client: ClientRef) => ({
  id: m.id,
  chatId: m.chatId,
  client,
  appointmentId: m.appointmentId,
  kind: m.kind,
  sendAt: toIso(m.sendAt),
  text: m.text,
  status: m.status,
  sentAt: toIso(m.sentAt),
  error: m.error,
});

export const bookingOut = (b: BookingRow, client: ClientRef | null) => ({
  id: b.id,
  chatId: b.chatId,
  client,
  contactName: b.contactName,
  phone: b.phone,
  serviceName: b.serviceName,
  preferredTime: b.preferredTime,
  comment: b.comment,
  status: b.status,
  createdAt: toIso(b.createdAt),
  updatedAt: toIso(b.updatedAt),
});

export const knowledgeOut = (k: KnowledgeRow) => ({
  id: k.id,
  title: k.title,
  content: k.content,
  active: k.active,
  sort: k.sort,
  updatedAt: toIso(k.updatedAt),
});
