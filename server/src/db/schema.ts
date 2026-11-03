import { sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** All instants are stored as integer milliseconds since epoch (UTC). Money is integer rubles. */

const bool = (name: string) => integer(name, { mode: 'boolean' });
const ms = (name: string) => integer(name);

export const employees = sqliteTable('employees', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  login: text('login').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  phone: text('phone'),
  color: text('color').notNull(),
  isMaster: bool('is_master').notNull().default(false),
  /** `owner` | `admin` | `master` — what the employee may do (docs/API.md «Roles»). */
  role: text('role').notNull().default('admin'),
  /**
   * JSON `WorkSchedule.weekly`: 7 entries Monday…Sunday, each `null` (day off) or `{ start, end, breaks }`;
   * NULL = no own schedule (the studio working hours every day).
   */
  weeklySchedule: text('weekly_schedule'),
  active: bool('active').notNull().default(true),
  /** Embedded in JWTs; bumped on password change / deactivation to revoke existing tokens. */
  tokenVersion: integer('token_version').notNull().default(0),
  createdAt: ms('created_at').notNull(),
  updatedAt: ms('updated_at').notNull(),
});

export const clients = sqliteTable(
  'clients',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** First name (older rows may hold the full name here). */
    name: text('name').notNull(),
    lastName: text('last_name'),
    /** Sort key of the full name (first + last). */
    nameSort: text('name_sort').notNull(),
    /** Required for clients created in the app; imported rows may have none. */
    phone: text('phone').unique(),
    instagram: text('instagram'),
    /** Telegram username typed by staff (without @); `telegramUsername` comes from the linked bot chat. */
    telegramNick: text('telegram_nick'),
    birthday: text('birthday'),
    notes: text('notes'),
    source: text('source'),
    telegramChatId: integer('telegram_chat_id').unique(),
    telegramUsername: text('telegram_username'),
    botEnabled: bool('bot_enabled').notNull().default(true),
    /** The client asked for no news and offers (campaigns, birthday, win-back); service messages still go. */
    marketingOptOut: bool('marketing_opt_out').notNull().default(false),
    /** When the bot asked this client for the birthday (asked once; null — not yet). */
    birthdayAskedAt: ms('birthday_asked_at'),
    archived: bool('archived').notNull().default(false),
    linkToken: text('link_token').unique(),
    searchText: text('search_text').notNull().default(''),
    createdAt: ms('created_at').notNull(),
    updatedAt: ms('updated_at').notNull(),
  },
  (t) => [index('clients_name_sort_idx').on(t.nameSort), index('clients_created_idx').on(t.createdAt)],
);

export const aftercareTemplates = sqliteTable('aftercare_templates', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  category: text('category').notNull(),
  stepsJson: text('steps_json').notNull(),
  createdAt: ms('created_at').notNull(),
  updatedAt: ms('updated_at').notNull(),
});

export const services = sqliteTable('services', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  category: text('category').notNull(),
  /** Free-text subgroup inside the category, e.g. «Ухо», «Лицо», «Доп. услуги». */
  groupName: text('group_name'),
  price: integer('price').notNull(),
  /** Upper bound of a price range («от 2 000 до 5 000 ₽», or «до 10 000 ₽» when `price` is 0). */
  priceMax: integer('price_max'),
  priceFrom: bool('price_from').notNull().default(false),
  durationMin: integer('duration_min').notNull(),
  description: text('description'),
  /** Schematic cover picture (upload path): the card/catalog image the bot also sends to clients. */
  imageUrl: text('image_url'),
  /** What the cover picture shows (prompt subject for regeneration); `null` = derived from name and description. */
  imagePrompt: text('image_prompt'),
  /** JSON array of upload paths: photos of real works. */
  photosJson: text('photos_json').notNull().default('[]'),
  /** JSON array of `{ name, price, durationMin | null }` — priced options such as «один / два». */
  variantsJson: text('variants_json').notNull().default('[]'),
  /** Prepayment required to book this service (rubles); 0 = none. */
  depositAmount: integer('deposit_amount').notNull().default(0),
  /**
   * JSON array of `{ employeeId, price, priceMax | null, variants: [{ name, price }] }` — a master's own prices
   * (docs/API.md «Service» `masterPrices`); `[]` = every master charges the catalog price.
   */
  masterPricesJson: text('master_prices_json').notNull().default('[]'),
  aftercareTemplateId: integer('aftercare_template_id').references(() => aftercareTemplates.id, {
    onDelete: 'set null',
  }),
  /**
   * «Свежий прокол» / «Свежее тату»: the service leaves a fresh wound, so completing it sends the aftercare memo.
   * Memos go out only for appointments with at least one such service.
   */
  freshProcedure: bool('fresh_procedure').notNull().default(false),
  /** Post-visit follow-ups (see domain/follow-ups.ts): «Как заживает?» after this many days (1…60), `null` = never. */
  healingCheckDays: integer('healing_check_days'),
  /** A jewelry change suggested this many weeks after the visit (1…52), `null` = never. */
  jewelryChangeWeeks: integer('jewelry_change_weeks'),
  active: bool('active').notNull().default(true),
  sort: integer('sort').notNull().default(0),
  createdAt: ms('created_at').notNull(),
  updatedAt: ms('updated_at').notNull(),
});

/**
 * Catalog categories of the warehouse sections (`jewelry` | `goods` | `consumable` | `service`), in staff order. Items
 * link to a category by name: `products.category` / `services.group_name` hold the category's exact name (services
 * within their `service_category`). Saving an item with a new name creates its category.
 */
export const catalogCategories = sqliteTable(
  'catalog_categories',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    section: text('section').notNull(),
    /** `tattoo` | `piercing` | `other` for the `service` section; '' otherwise. */
    serviceCategory: text('service_category').notNull().default(''),
    name: text('name').notNull(),
    position: integer('position').notNull().default(0),
    createdAt: ms('created_at').notNull(),
    updatedAt: ms('updated_at').notNull(),
  },
  (t) => [uniqueIndex('catalog_categories_name_unique').on(t.section, t.serviceCategory, t.name)],
);

/**
 * Jewelry, goods (sold, not jewelry) and consumables. Stock lives on `product_variants` (sizes); a product always has
 * at least one.
 */
export const products = sqliteTable(
  'products',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    nameSort: text('name_sort').notNull(),
    sku: text('sku'),
    category: text('category'),
    categorySort: text('category_sort').notNull().default(''),
    material: text('material'),
    /** `internal` | `external` | `threadless`; null — not specified. */
    threadType: text('thread_type'),
    /** Bar / wire thickness, mm. */
    thicknessMm: real('thickness_mm'),
    color: text('color'),
    stone: text('stone'),
    supplier: text('supplier'),
    description: text('description'),
    price: integer('price').notNull(),
    cost: integer('cost'),
    unit: text('unit').notNull().default('шт'),
    /** The cover photo: always `photos[0]` (kept as a column for the bot and the lists). */
    photoUrl: text('photo_url'),
    /** JSON array of upload paths, the cover first. */
    photosJson: text('photos_json').notNull().default('[]'),
    /** `quantity` — counted; `presence` — consumables only tracked as «есть / заканчивается / нет». */
    stockMode: text('stock_mode').notNull().default('quantity'),
    /** `ok` | `low` | `out` — meaningful for `presence` products only. */
    presenceStatus: text('presence_status').notNull().default('ok'),
    active: bool('active').notNull().default(true),
    /** Deleted by staff but kept for its history (sales, movements still name it); hidden everywhere else. */
    archived: bool('archived').notNull().default(false),
    /** Built from the product's text fields and its sizes (names, SKUs). */
    searchText: text('search_text').notNull().default(''),
    createdAt: ms('created_at').notNull(),
    updatedAt: ms('updated_at').notNull(),
  },
  (t) => [index('products_kind_idx').on(t.kind)],
);

/**
 * A size of a product («8 мм») with its own stock; a product without sizes has one variant named ''. `sku`, `price`
 * and `cost` override the product's when set. A removed size that has history is `archived` (hidden, never deleted).
 */
export const productVariants = sqliteTable(
  'product_variants',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    productId: integer('product_id')
      .notNull()
      .references(() => products.id),
    name: text('name').notNull().default(''),
    sku: text('sku'),
    price: integer('price'),
    cost: integer('cost'),
    quantity: integer('quantity').notNull().default(0),
    minQuantity: integer('min_quantity').notNull().default(0),
    archived: bool('archived').notNull().default(false),
    position: integer('position').notNull().default(0),
    createdAt: ms('created_at').notNull(),
    updatedAt: ms('updated_at').notNull(),
  },
  (t) => [
    index('product_variants_product_idx').on(t.productId, t.position),
    check('product_variants_quantity_non_negative', sql`${t.quantity} >= 0`),
  ],
);

/** Consumables one procedure of a service uses (deducted when an appointment with it is completed). */
export const serviceConsumables = sqliteTable(
  'service_consumables',
  {
    serviceId: integer('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'cascade' }),
    productId: integer('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    /** Per procedure; ignored for `presence` consumables. */
    quantity: integer('quantity').notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.serviceId, t.productId] }), index('service_consumables_product_idx').on(t.productId)],
);

/** Catalog services (piercing zones) a piece of jewelry suits. */
export const productServices = sqliteTable(
  'product_services',
  {
    productId: integer('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    serviceId: integer('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.productId, t.serviceId] }), index('product_services_service_idx').on(t.serviceId)],
);

export const cashShifts = sqliteTable(
  'cash_shifts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    openedAt: ms('opened_at').notNull(),
    openedById: integer('opened_by_id')
      .notNull()
      .references(() => employees.id),
    openingCash: integer('opening_cash').notNull(),
    closedAt: ms('closed_at'),
    closedById: integer('closed_by_id').references(() => employees.id),
    closingCash: integer('closing_cash'),
    expectedCash: integer('expected_cash'),
    note: text('note'),
  },
  (t) => [index('cash_shifts_opened_idx').on(t.openedAt)],
);

export const appointments = sqliteTable(
  'appointments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    clientId: integer('client_id')
      .notNull()
      .references(() => clients.id),
    masterId: integer('master_id')
      .notNull()
      .references(() => employees.id),
    serviceId: integer('service_id').references(() => services.id, { onDelete: 'set null' }),
    title: text('title'),
    startsAt: ms('starts_at').notNull(),
    endsAt: ms('ends_at').notNull(),
    status: text('status').notNull(),
    price: integer('price').notNull().default(0),
    /** Prepayment the studio asks for; what was actually received lives in `deposit_operations`. */
    depositRequired: integer('deposit_required').notNull().default(0),
    notes: text('notes'),
    saleId: integer('sale_id'),
    completedAt: ms('completed_at'),
    /** Where it was booked: `app` (staff) | `bot` | `miniapp` | `web` (docs/API.md «Online booking»). */
    channel: text('channel').notNull().default('app'),
    /** An online booking not settled yet: `awaiting_payment` (held until `hold_until`) | `awaiting_confirmation`. */
    onlineState: text('online_state'),
    holdUntil: ms('hold_until'),
    /** Secret of the client's booking page `/book/b/<token>` (online bookings only). */
    publicToken: text('public_token').unique(),
    createdAt: ms('created_at').notNull(),
    updatedAt: ms('updated_at').notNull(),
  },
  (t) => [
    index('appointments_starts_idx').on(t.startsAt),
    index('appointments_master_idx').on(t.masterId, t.startsAt),
    index('appointments_client_idx').on(t.clientId),
    index('appointments_online_idx').on(t.onlineState),
  ],
);

/**
 * Services booked into an appointment (one row per service line). `name`, `price` and `durationMin` are snapshots,
 * so the history keeps what was actually done even after the catalog changes. `appointments.service_id` mirrors the
 * first line with a catalog service for older app builds.
 */
export const appointmentServices = sqliteTable(
  'appointment_services',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    appointmentId: integer('appointment_id')
      .notNull()
      .references(() => appointments.id, { onDelete: 'cascade' }),
    serviceId: integer('service_id').references(() => services.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    price: integer('price').notNull(),
    durationMin: integer('duration_min'),
    position: integer('position').notNull(),
  },
  (t) => [
    index('appointment_services_appointment_idx').on(t.appointmentId, t.position),
    index('appointment_services_service_idx').on(t.serviceId),
  ],
);

export const sales = sqliteTable(
  'sales',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    number: integer('number').notNull().unique(),
    clientId: integer('client_id').references(() => clients.id),
    employeeId: integer('employee_id')
      .notNull()
      .references(() => employees.id),
    appointmentId: integer('appointment_id').references(() => appointments.id),
    shiftId: integer('shift_id').references(() => cashShifts.id),
    subtotal: integer('subtotal').notNull(),
    discount: integer('discount').notNull().default(0),
    total: integer('total').notNull(),
    payCash: integer('pay_cash').notNull().default(0),
    payCard: integer('pay_card').notNull().default(0),
    payTransfer: integer('pay_transfer').notNull().default(0),
    /** Paid by an SBP QR code; only set from a confirmed `qr_payments` row, never directly by the app. */
    payQr: integer('pay_qr').notNull().default(0),
    /** Covered by the appointment's prepayment (received earlier; see `deposit_operations` type `apply`). */
    payDeposit: integer('pay_deposit').notNull().default(0),
    /** Paid with the client's loyalty bonuses (1 bonus = 1 ₽; a discount, not revenue). */
    payBonus: integer('pay_bonus').notNull().default(0),
    /** Paid with gift certificates (money received when the certificate was sold). */
    payCertificate: integer('pay_certificate').notNull().default(0),
    status: text('status').notNull(),
    note: text('note'),
    refundedAt: ms('refunded_at'),
    refundReason: text('refund_reason'),
    refundShiftId: integer('refund_shift_id').references(() => cashShifts.id),
    refundedById: integer('refunded_by_id').references(() => employees.id),
    /** Σ `sale_refunds.amount` — what partial and full refunds have returned so far. */
    refundedTotal: integer('refunded_total').notNull().default(0),
    /** When the bot last sent the receipt to the client's Telegram (automatically after the sale or by staff). */
    receiptSentAt: ms('receipt_sent_at'),
    createdAt: ms('created_at').notNull(),
  },
  (t) => [
    index('sales_created_idx').on(t.createdAt),
    index('sales_client_idx').on(t.clientId),
    index('sales_shift_idx').on(t.shiftId),
    index('sales_refund_shift_idx').on(t.refundShiftId),
  ],
);

export const saleItems = sqliteTable(
  'sale_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    saleId: integer('sale_id')
      .notNull()
      .references(() => sales.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    productId: integer('product_id').references(() => products.id),
    /** The size sold (product items). */
    variantId: integer('variant_id').references(() => productVariants.id),
    /** The size's name at the moment of sale; null for services, unnamed sizes and items sold before sizes existed. */
    variantName: text('variant_name'),
    serviceId: integer('service_id').references(() => services.id),
    /** The gift certificate this line sold (`type: certificate`). */
    certificateId: integer('certificate_id'),
    /** Snapshot: «<product> — <size>» for products, the service line name otherwise. */
    name: text('name').notNull(),
    quantity: integer('quantity').notNull(),
    price: integer('price').notNull(),
    total: integer('total').notNull(),
    /** Units returned by refunds so far (Σ `sale_refund_items.quantity`); `quantity − refundedQuantity` are kept. */
    refundedQuantity: integer('refunded_quantity').notNull().default(0),
  },
  (t) => [index('sale_items_sale_idx').on(t.saleId)],
);

/**
 * A refund of a sale (docs/API.md «SaleRefund»): some lines or quantities, or everything left. A sale whose every unit
 * is refunded becomes `refunded`. The `pay*` columns are the parts of `amount` given back, by how the sale was paid.
 */
export const saleRefunds = sqliteTable(
  'sale_refunds',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    saleId: integer('sale_id')
      .notNull()
      .references(() => sales.id),
    amount: integer('amount').notNull(),
    payCash: integer('pay_cash').notNull().default(0),
    payCard: integer('pay_card').notNull().default(0),
    payTransfer: integer('pay_transfer').notNull().default(0),
    payQr: integer('pay_qr').notNull().default(0),
    payDeposit: integer('pay_deposit').notNull().default(0),
    payBonus: integer('pay_bonus').notNull().default(0),
    payCertificate: integer('pay_certificate').notNull().default(0),
    /** Bonuses the sale had earned that this refund took back. */
    bonusTakenBack: integer('bonus_taken_back').notNull().default(0),
    restock: bool('restock').notNull(),
    reason: text('reason').notNull(),
    employeeId: integer('employee_id').references(() => employees.id),
    /** The cash shift open at the refund (always set when `payCash > 0`). */
    shiftId: integer('shift_id').references(() => cashShifts.id),
    createdAt: ms('created_at').notNull(),
  },
  (t) => [
    index('sale_refunds_sale_idx').on(t.saleId),
    index('sale_refunds_shift_idx').on(t.shiftId),
    index('sale_refunds_created_idx').on(t.createdAt),
  ],
);

export const saleRefundItems = sqliteTable(
  'sale_refund_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    refundId: integer('refund_id')
      .notNull()
      .references(() => saleRefunds.id, { onDelete: 'cascade' }),
    saleItemId: integer('sale_item_id')
      .notNull()
      .references(() => saleItems.id),
    quantity: integer('quantity').notNull(),
    /** What this line's units returned (after their share of the sale discount). */
    amount: integer('amount').notNull(),
  },
  (t) => [index('sale_refund_items_refund_idx').on(t.refundId), index('sale_refund_items_item_idx').on(t.saleItemId)],
);

/**
 * An open receipt (открытый чек): a sale being put together before payment — at a visit started in the POS or for a
 * walk-in. Nothing is sold yet (no stock movement, a prepayment stays held); paying it creates a `sales` row and
 * deletes this one. `itemsJson` holds the lines as the app saved them (`ReceiptItem[]` in domain/receipts.ts).
 */
export const openReceipts = sqliteTable(
  'open_receipts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    appointmentId: integer('appointment_id').references(() => appointments.id),
    clientId: integer('client_id').references(() => clients.id),
    /** Who opened it. */
    employeeId: integer('employee_id')
      .notNull()
      .references(() => employees.id),
    itemsJson: text('items_json').notNull().default('[]'),
    discount: integer('discount').notNull().default(0),
    note: text('note'),
    createdAt: ms('created_at').notNull(),
    updatedAt: ms('updated_at').notNull(),
  },
  // One open receipt per appointment (receipts without one are unlimited: NULLs never collide).
  (t) => [uniqueIndex('open_receipts_appointment_unique').on(t.appointmentId)],
);

/**
 * A dynamic SBP QR code: the QR part of a checkout (`kind = sale`) or an appointment's prepayment (`kind = deposit`).
 * A sale is created on the server only once the bank confirms the payment, from the cart stored in `saleInputJson`,
 * so a paid QR maps to exactly one sale; a paid prepayment code records one `receive` deposit operation.
 */
export const qrPayments = sqliteTable(
  'qr_payments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** `sale` | `deposit` */
    kind: text('kind').notNull().default('sale'),
    /** The appointment of a `deposit` code. */
    appointmentId: integer('appointment_id').references(() => appointments.id),
    /** `tochka` */
    provider: text('provider').notNull(),
    /** The bank's QR id (Tochka `qrcId`). */
    externalId: text('external_id').notNull().unique(),
    /** The link encoded into the QR image (`https://qr.nspk.ru/...`). */
    payload: text('payload').notNull(),
    amount: integer('amount').notNull(),
    /** `pending` | `paid` | `expired` | `cancelled` */
    status: text('status').notNull(),
    /** The frozen cart of a `sale` code; null for `deposit`. */
    saleInputJson: text('sale_input_json'),
    saleId: integer('sale_id').references(() => sales.id),
    /** For staff: a declined attempt / unreachable bank while pending, or why paid money was not sold. */
    error: text('error'),
    employeeId: integer('employee_id')
      .notNull()
      .references(() => employees.id),
    expiresAt: ms('expires_at').notNull(),
    /** Last successful bank check. */
    checkedAt: ms('checked_at'),
    paidAt: ms('paid_at'),
    /** When the bot last sent the link to the client (`deposit` codes). */
    sentAt: ms('sent_at'),
    createdAt: ms('created_at').notNull(),
    updatedAt: ms('updated_at').notNull(),
  },
  (t) => [index('qr_payments_status_idx').on(t.status, t.expiresAt), index('qr_payments_appointment_idx').on(t.appointmentId)],
);

/**
 * The prepayment ledger: every movement of an appointment's prepayment. The held amount is
 * Σ receive − Σ apply + Σ unapply − Σ refund − Σ retain; rows are never updated.
 */
export const depositOperations = sqliteTable(
  'deposit_operations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    appointmentId: integer('appointment_id')
      .notNull()
      .references(() => appointments.id),
    /** `receive` | `apply` | `unapply` | `refund` | `retain` */
    type: text('type').notNull(),
    amount: integer('amount').notNull(),
    /** `cash` | `card` | `transfer` | `qr` for receive/refund; null otherwise. */
    method: text('method'),
    /** The shift open at that moment (always set for cash). */
    shiftId: integer('shift_id').references(() => cashShifts.id),
    /** apply / unapply: the sale. */
    saleId: integer('sale_id').references(() => sales.id),
    /** receive by QR: the code it came from. */
    qrPaymentId: integer('qr_payment_id').references(() => qrPayments.id),
    note: text('note'),
    employeeId: integer('employee_id').references(() => employees.id),
    createdAt: ms('created_at').notNull(),
  },
  (t) => [
    index('deposit_operations_appointment_idx').on(t.appointmentId, t.id),
    index('deposit_operations_shift_idx').on(t.shiftId),
    index('deposit_operations_created_idx').on(t.createdAt),
    // A paid QR code is recorded once; a sale applies (and, when refunded, returns) a prepayment once.
    uniqueIndex('deposit_operations_qr_receive_unique').on(t.qrPaymentId).where(sql`type = 'receive'`),
    // Partial refunds may return a prepayment in several `unapply` steps; a sale applies it once.
    uniqueIndex('deposit_operations_sale_apply_unique').on(t.saleId).where(sql`sale_id is not null and type = 'apply'`),
    check('deposit_operations_amount_positive', sql`${t.amount} > 0`),
  ],
);

/** A stock count (ревизия): its adjustments are stock movements with `revision_id`. */
export const stockRevisions = sqliteTable('stock_revisions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  number: integer('number').notNull().unique(),
  /** The warehouse section counted, or null for several. */
  section: text('section'),
  note: text('note'),
  employeeId: integer('employee_id').references(() => employees.id),
  /** Lines checked (sizes counted + presence consumables marked). */
  counted: integer('counted').notNull(),
  /** Lines that differed. */
  changed: integer('changed').notNull(),
  /** Units found above / below the expected stock. */
  surplus: integer('surplus').notNull(),
  shortage: integer('shortage').notNull(),
  /** The same at cost (sizes with a known cost). */
  surplusCost: integer('surplus_cost').notNull(),
  shortageCost: integer('shortage_cost').notNull(),
  /** JSON array of `{ productId, productName, from, to }` presence status changes. */
  presenceJson: text('presence_json').notNull().default('[]'),
  createdAt: ms('created_at').notNull(),
});

/** A delivery (поставка): one receiving of many products and sizes; its lines are `receipt` movements. */
export const stockDeliveries = sqliteTable('stock_deliveries', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  number: integer('number').notNull().unique(),
  supplier: text('supplier'),
  note: text('note'),
  employeeId: integer('employee_id').references(() => employees.id),
  createdAt: ms('created_at').notNull(),
});

export const stockMovements = sqliteTable(
  'stock_movements',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    productId: integer('product_id')
      .notNull()
      .references(() => products.id),
    variantId: integer('variant_id')
      .notNull()
      .references(() => productVariants.id),
    delta: integer('delta').notNull(),
    /** Stock of the size after the movement. */
    quantityAfter: integer('quantity_after').notNull(),
    type: text('type').notNull(),
    note: text('note'),
    saleId: integer('sale_id').references(() => sales.id),
    appointmentId: integer('appointment_id').references(() => appointments.id),
    /** The stock count this adjustment came from. */
    revisionId: integer('revision_id').references(() => stockRevisions.id),
    /** The delivery this receipt belongs to. */
    deliveryId: integer('delivery_id').references(() => stockDeliveries.id),
    /** Rubles paid: set on `purchase` (a restock of a presence consumable), null otherwise. */
    amount: integer('amount'),
    employeeId: integer('employee_id').references(() => employees.id),
    createdAt: ms('created_at').notNull(),
  },
  (t) => [
    index('stock_movements_product_idx').on(t.productId, t.id),
    index('stock_movements_variant_idx').on(t.variantId, t.id),
    index('stock_movements_type_idx').on(t.type),
    index('stock_movements_delivery_idx').on(t.deliveryId),
  ],
);

export const cashOperations = sqliteTable(
  'cash_operations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    shiftId: integer('shift_id')
      .notNull()
      .references(() => cashShifts.id),
    type: text('type').notNull(),
    amount: integer('amount').notNull(),
    reason: text('reason').notNull(),
    employeeId: integer('employee_id')
      .notNull()
      .references(() => employees.id),
    createdAt: ms('created_at').notNull(),
  },
  (t) => [index('cash_operations_shift_idx').on(t.shiftId)],
);

export const botChats = sqliteTable('bot_chats', {
  chatId: integer('chat_id').primaryKey(),
  clientId: integer('client_id').references(() => clients.id, { onDelete: 'set null' }),
  /** Set when the chat shared the phone number of an employee: the bot treats it as staff. */
  employeeId: integer('employee_id').references(() => employees.id),
  telegramName: text('telegram_name'),
  username: text('username'),
  aiPaused: bool('ai_paused').notNull().default(false),
  needsAttention: bool('needs_attention').notNull().default(false),
  unreadCount: integer('unread_count').notNull().default(0),
  createdAt: ms('created_at').notNull(),
  updatedAt: ms('updated_at').notNull(),
});

export const botMessages = sqliteTable(
  'bot_messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    chatId: integer('chat_id')
      .notNull()
      .references(() => botChats.chatId),
    role: text('role').notNull(),
    text: text('text').notNull(),
    employeeId: integer('employee_id').references(() => employees.id),
    /** The picture a client sent, under DATA_DIR/chat-photos (see domain/chat-photos.ts). */
    photoFile: text('photo_file'),
    createdAt: ms('created_at').notNull(),
  },
  (t) => [index('bot_messages_chat_idx').on(t.chatId, t.id)],
);

export const scheduledMessages = sqliteTable(
  'scheduled_messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    chatId: integer('chat_id').notNull(),
    clientId: integer('client_id')
      .notNull()
      .references(() => clients.id),
    appointmentId: integer('appointment_id').references(() => appointments.id),
    kind: text('kind').notNull(),
    sendAt: ms('send_at').notNull(),
    text: text('text').notNull(),
    status: text('status').notNull(),
    sentAt: ms('sent_at'),
    error: text('error'),
    attempts: integer('attempts').notNull().default(0),
    createdAt: ms('created_at').notNull(),
  },
  (t) => [
    index('scheduled_status_send_idx').on(t.status, t.sendAt),
    index('scheduled_appointment_idx').on(t.appointmentId),
  ],
);

export const bookingRequests = sqliteTable('booking_requests', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id'),
  clientId: integer('client_id').references(() => clients.id, { onDelete: 'set null' }),
  contactName: text('contact_name').notNull(),
  phone: text('phone'),
  serviceName: text('service_name'),
  preferredTime: text('preferred_time'),
  comment: text('comment'),
  status: text('status').notNull(),
  createdAt: ms('created_at').notNull(),
  updatedAt: ms('updated_at').notNull(),
});

export const knowledgeEntries = sqliteTable('knowledge_entries', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  content: text('content').notNull(),
  active: bool('active').notNull().default(true),
  sort: integer('sort').notNull().default(0),
  createdAt: ms('created_at').notNull(),
  updatedAt: ms('updated_at').notNull(),
});

/** Key-value store for studio/bot settings and small runtime state (staff chat, staff code, bot username). */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: ms('updated_at').notNull(),
});

/** One row per AI pipeline run, used for cost guards (per-chat hourly, global daily). */
export const aiUsage = sqliteTable(
  'ai_usage',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    chatId: integer('chat_id'),
    outcome: text('outcome').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    createdAt: ms('created_at').notNull(),
  },
  (t) => [index('ai_usage_created_idx').on(t.createdAt), index('ai_usage_chat_idx').on(t.chatId, t.createdAt)],
);

/**
 * Responses of write requests sent with an `Idempotency-Key` header, kept ~24 h so a retried request
 * (lost response, timeout) returns the original result instead of being applied twice.
 */
export const idempotencyKeys = sqliteTable(
  'idempotency_keys',
  {
    key: text('key').notNull(),
    employeeId: integer('employee_id').notNull(),
    /** `METHOD /path` of the original request, e.g. `POST /api/sales/12/refund`. */
    endpoint: text('endpoint').notNull(),
    /** SHA-256 of the endpoint and the canonical JSON body; a reused key with another body is a conflict. */
    requestHash: text('request_hash').notNull(),
    responseJson: text('response_json').notNull(),
    createdAt: ms('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.employeeId, t.key] }), index('idempotency_keys_created_idx').on(t.createdAt)],
);

/**
 * The action log (docs/API.md «Audit log»): who changed what and when — every successful write from the app, staff
 * actions in the bot and what the server does by itself. Rows are never edited; old ones are pruned after 2 years.
 */
export const auditLog = sqliteTable(
  'audit_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    at: ms('at').notNull(),
    /** NULL for the server itself or a client in the bot. */
    employeeId: integer('employee_id').references(() => employees.id),
    /** `app` | `bot_staff` | `bot` | `system`. */
    source: text('source').notNull(),
    /** `<entity>.<verb>`, e.g. `appointment.update`, `sale.refund`. */
    action: text('action').notNull(),
    /** `appointment`, `sale`, `client`, `product`, `service`, `employee`, `settings`, … */
    entity: text('entity').notNull(),
    entityId: integer('entity_id'),
    /** Russian sentence for people, e.g. «Перенесла запись №1846 (Анна Иванова) на 21 октября, 14:00». */
    summary: text('summary').notNull(),
    /** JSON `{ field: { from, to } }` of what changed, when known. */
    changes: text('changes'),
  },
  (t) => [
    index('audit_log_at_idx').on(t.at),
    index('audit_log_entity_idx').on(t.entity, t.entityId, t.at),
    index('audit_log_employee_idx').on(t.employeeId, t.at),
  ],
);

/** One day that differs from the employee's weekly schedule: a day off, other hours or other breaks. */
export const scheduleDays = sqliteTable(
  'schedule_days',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    employeeId: integer('employee_id')
      .notNull()
      .references(() => employees.id),
    /** Studio-local "YYYY-MM-DD". */
    date: text('date').notNull(),
    off: bool('off').notNull().default(false),
    /** "HH:MM" studio time; NULL when `off`. */
    start: text('start'),
    end: text('end'),
    /** JSON `[{ start, end }]`. */
    breaks: text('breaks').notNull().default('[]'),
    note: text('note'),
    createdAt: ms('created_at').notNull(),
    updatedAt: ms('updated_at').notNull(),
  },
  (t) => [uniqueIndex('schedule_days_employee_date_unique').on(t.employeeId, t.date)],
);

/** How an employee is paid from `effectiveFrom` on (each version kept: a past period is counted by its rules). */
export const payRules = sqliteTable(
  'pay_rules',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    employeeId: integer('employee_id')
      .notNull()
      .references(() => employees.id),
    /** Studio-local "YYYY-MM-DD". */
    effectiveFrom: text('effective_from').notNull(),
    /** JSON `PayRules`. */
    rules: text('rules').notNull(),
    createdBy: integer('created_by').references(() => employees.id),
    createdAt: ms('created_at').notNull(),
  },
  (t) => [uniqueIndex('pay_rules_employee_from_unique').on(t.employeeId, t.effectiveFrom)],
);

/** Manual payroll entries: `bonus`, `penalty`, `advance`, `payout` (amount always positive). */
export const payrollAdjustments = sqliteTable(
  'payroll_adjustments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    employeeId: integer('employee_id')
      .notNull()
      .references(() => employees.id),
    /** Studio-local "YYYY-MM-DD". */
    date: text('date').notNull(),
    kind: text('kind').notNull(),
    amount: integer('amount').notNull(),
    note: text('note'),
    /** The cash withdrawal when it was paid from the till. */
    cashOperationId: integer('cash_operation_id').references(() => cashOperations.id),
    createdBy: integer('created_by').references(() => employees.id),
    createdAt: ms('created_at').notNull(),
  },
  (t) => [index('payroll_adjustments_employee_idx').on(t.employeeId, t.date)],
);

/** Staff iPhones that get push notifications (docs/API.md «Push notifications»). */
export const pushDevices = sqliteTable(
  'push_devices',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    employeeId: integer('employee_id')
      .notNull()
      .references(() => employees.id),
    /** APNs device token, hex. */
    token: text('token').notNull().unique(),
    /** `production` (TestFlight, App Store) | `sandbox` (debug builds). */
    environment: text('environment').notNull(),
    createdAt: ms('created_at').notNull(),
    lastSeenAt: ms('last_seen_at').notNull(),
  },
  (t) => [index('push_devices_employee_idx').on(t.employeeId)],
);

/**
 * The loyalty bonus ledger (docs/API.md «Loyalty bonuses»): every change of a client's balance. Credits (`earn`,
 * `gift`, positive `adjust`) are lots spent oldest first; `remaining` is what is left of a lot, `expires_at` when
 * the rest of it burns.
 */
export const bonusOperations = sqliteTable(
  'bonus_operations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    clientId: integer('client_id')
      .notNull()
      .references(() => clients.id),
    /** `earn` | `spend` | `gift` | `expire` | `adjust` | `reverse` (a refunded sale's bonuses taken back or returned). */
    type: text('type').notNull(),
    /** Signed: credits > 0, debits < 0. */
    amount: integer('amount').notNull(),
    /** Unspent part of a credit; 0 for debits. */
    remaining: integer('remaining').notNull().default(0),
    expiresAt: ms('expires_at'),
    saleId: integer('sale_id').references(() => sales.id),
    note: text('note'),
    employeeId: integer('employee_id').references(() => employees.id),
    createdAt: ms('created_at').notNull(),
  },
  (t) => [
    index('bonus_operations_client_idx').on(t.clientId, t.createdAt),
    index('bonus_operations_expiry_idx').on(t.expiresAt),
  ],
);

/** Gift certificates (docs/API.md «Gift certificates»): sold at the till, spent in parts until the balance is 0. */
export const giftCertificates = sqliteTable(
  'gift_certificates',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** «MIKAN-7K3Q-9F2D»: what the client shows; unique. */
    code: text('code').notNull().unique(),
    amount: integer('amount').notNull(),
    balance: integer('balance').notNull(),
    /** `active` | `used` | `expired` | `cancelled`. */
    status: text('status').notNull(),
    expiresAt: ms('expires_at'),
    buyerClientId: integer('buyer_client_id').references(() => clients.id),
    recipientName: text('recipient_name'),
    note: text('note'),
    saleId: integer('sale_id').references(() => sales.id),
    createdBy: integer('created_by').references(() => employees.id),
    createdAt: ms('created_at').notNull(),
    updatedAt: ms('updated_at').notNull(),
  },
  (t) => [index('gift_certificates_status_idx').on(t.status, t.expiresAt)],
);

/** Every change of a certificate's balance. */
export const certificateOperations = sqliteTable(
  'certificate_operations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    certificateId: integer('certificate_id')
      .notNull()
      .references(() => giftCertificates.id),
    /** `issue` | `redeem` | `refund` (a refunded sale gives it back) | `cancel` | `expire`. */
    type: text('type').notNull(),
    /** Signed change of the balance. */
    amount: integer('amount').notNull(),
    saleId: integer('sale_id').references(() => sales.id),
    employeeId: integer('employee_id').references(() => employees.id),
    createdAt: ms('created_at').notNull(),
  },
  (t) => [index('certificate_operations_certificate_idx').on(t.certificateId, t.createdAt)],
);

/** Telegram campaigns (docs/API.md «Campaigns»): one message to a segment of clients. */
export const campaigns = sqliteTable(
  'campaigns',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    title: text('title').notNull(),
    text: text('text').notNull(),
    imageUrl: text('image_url'),
    /** JSON `{ text, kind: "book" | "url", url? }` or NULL. */
    button: text('button'),
    /** JSON `CampaignSegment`. */
    segment: text('segment').notNull(),
    /** `draft` | `scheduled` | `sending` | `sent` | `cancelled`. */
    status: text('status').notNull(),
    scheduledAt: ms('scheduled_at'),
    startedAt: ms('started_at'),
    finishedAt: ms('finished_at'),
    createdBy: integer('created_by').references(() => employees.id),
    createdAt: ms('created_at').notNull(),
    updatedAt: ms('updated_at').notNull(),
  },
  (t) => [index('campaigns_status_idx').on(t.status, t.scheduledAt)],
);

/** One client of a campaign: fixed when sending starts, delivered at a safe rate. */
export const campaignRecipients = sqliteTable(
  'campaign_recipients',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    campaignId: integer('campaign_id')
      .notNull()
      .references(() => campaigns.id),
    clientId: integer('client_id')
      .notNull()
      .references(() => clients.id),
    chatId: integer('chat_id').notNull(),
    /** `pending` | `sent` | `failed` | `blocked` | `skipped`. */
    status: text('status').notNull(),
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),
    sentAt: ms('sent_at'),
  },
  (t) => [
    uniqueIndex('campaign_recipients_unique').on(t.campaignId, t.clientId),
    index('campaign_recipients_status_idx').on(t.campaignId, t.status),
  ],
);

/** Automatic retention messages already sent: a birthday once a year, a win-back once per absence. */
export const retentionSends = sqliteTable(
  'retention_sends',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    clientId: integer('client_id')
      .notNull()
      .references(() => clients.id),
    /** `birthday` | `winback`. */
    kind: text('kind').notNull(),
    /** `2026` for a birthday; the date of the last visit for a win-back. */
    periodKey: text('period_key').notNull(),
    sentAt: ms('sent_at').notNull(),
  },
  (t) => [uniqueIndex('retention_sends_unique').on(t.clientId, t.kind, t.periodKey)],
);

/**
 * Sign-ins of employees (docs/API.md «Sessions»): one row per login on a device. The JWT carries the session id, so
 * signing out ends that device only and the owner can end any session.
 */
export const authSessions = sqliteTable(
  'auth_sessions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    employeeId: integer('employee_id')
      .notNull()
      .references(() => employees.id),
    /** «iPhone 16 Pro · MIKAN 13» — from the app's `X-Device` header, else the user agent. */
    device: text('device'),
    ip: text('ip'),
    createdAt: ms('created_at').notNull(),
    lastSeenAt: ms('last_seen_at').notNull(),
    revokedAt: ms('revoked_at'),
  },
  (t) => [index('auth_sessions_employee_idx').on(t.employeeId, t.revokedAt)],
);

/** Photos of masters' work (docs/API.md «Portfolio»): shown when clients choose a master online and by the bot. */
export const portfolioPhotos = sqliteTable(
  'portfolio_photos',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    employeeId: integer('employee_id')
      .notNull()
      .references(() => employees.id),
    serviceId: integer('service_id').references(() => services.id, { onDelete: 'set null' }),
    /** `/uploads/…` */
    imageUrl: text('image_url').notNull(),
    caption: text('caption'),
    sort: integer('sort').notNull().default(0),
    createdBy: integer('created_by').references(() => employees.id),
    createdAt: ms('created_at').notNull(),
  },
  (t) => [index('portfolio_photos_employee_idx').on(t.employeeId, t.sort)],
);

/** Clients waiting for free time (docs/API.md «Waitlist»). */
export const waitlistEntries = sqliteTable(
  'waitlist_entries',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    clientId: integer('client_id')
      .notNull()
      .references(() => clients.id),
    /** JSON `[{ serviceId, variant? }]` — what the client wants booked. */
    items: text('items').notNull(),
    /** NULL — any master. */
    masterId: integer('master_id').references(() => employees.id),
    /** Studio-local "YYYY-MM-DD", inclusive. */
    dateFrom: text('date_from').notNull(),
    dateTo: text('date_to').notNull(),
    /** `waiting` | `notified` | `booked` | `cancelled` | `expired`. */
    status: text('status').notNull(),
    /** `bot` | `miniapp` | `web` | `app`. */
    channel: text('channel').notNull(),
    notifiedAt: ms('notified_at'),
    appointmentId: integer('appointment_id').references(() => appointments.id),
    note: text('note'),
    createdAt: ms('created_at').notNull(),
    updatedAt: ms('updated_at').notNull(),
  },
  (t) => [index('waitlist_entries_status_idx').on(t.status, t.dateFrom)],
);

/** Sign-in links of the client cabinet on the website (docs/API.md «Client cabinet»); the Mini App needs none. */
export const clientAccessTokens = sqliteTable(
  'client_access_tokens',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    clientId: integer('client_id')
      .notNull()
      .references(() => clients.id),
    /** SHA-256 of the token; the token itself is only in the link. */
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: ms('created_at').notNull(),
    expiresAt: ms('expires_at').notNull(),
    lastUsedAt: ms('last_used_at'),
  },
  (t) => [index('client_access_tokens_client_idx').on(t.clientId)],
);
export * from './schema-smm.js';
