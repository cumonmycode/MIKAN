import { and, eq, gt, or } from 'drizzle-orm';
import { notifyStaff } from '../bot/staff.js';
import type { AppContext } from '../context.js';
import type { DbOrTx } from '../db/client.js';
import { qrPayments } from '../db/schema.js';
import { AppError, badRequest, conflict, errorMessage, notFound } from '../lib/errors.js';
import { qrPaymentOut, type QrPaymentRow } from '../lib/serialize.js';
import { formatRub } from '../lib/text.js';
import { QrProviderError, type CreatedQr, type QrBankStatus, type QrProvider } from '../payments/qr-provider.js';
import { auditQrPaid } from './audit-events.js';
import { announceQrDeposit } from './deposit-messages.js';
import { recordQrDeposit } from './deposits.js';
import { announceHoldPaid, awaitsPayment, holdSettled, settlePaidHold } from './online-booking-lifecycle.js';
import { getSaleRow, serializeSale } from './refs.js';
import { sendSaleReceipt } from './sale-messages.js';
import { assertShiftOpen, createSale, prepareSale, type SaleInput } from './sales.js';
import { getStudioSettings } from './settings.js';

/** How long a QR code accepts payment. */
export const QR_TTL_MINUTES = 10;
/** The bank is still asked a while after expiry: a payment started at the last second may settle late. */
export const QR_SETTLE_GRACE_MS = 5 * 60_000;
/** Tochka keeps a paid code readable for 24 h, so a code the bank cannot be asked about is watched that long. */
export const QR_GIVE_UP_MS = 24 * 60 * 60_000;
/** App polls and the background sweep share this floor between bank requests for one code. */
export const QR_MIN_CHECK_INTERVAL_MS = 2_000;
export const QR_SWEEP_INTERVAL_MS = 15_000;
/** Prepayment links live up to days: the background check asks the bank about each at most this often. */
export const DEPOSIT_SWEEP_INTERVAL_MS = 60_000;

/** `pending` → `paid` | `expired`; `pending` → `cancelled` (→ `paid` with `error` if the client pays it anyway). */
export type QrPaymentStatus = 'pending' | 'paid' | 'expired' | 'cancelled';
/** `sale` — the QR part of a checkout; `deposit` — an appointment's prepayment. */
export type QrPaymentKind = 'sale' | 'deposit';

const BANK_UNAVAILABLE = 'Банк не ответил. Попробуйте ещё раз или выберите другой способ оплаты.';
const BANK_REFUSED = 'Банк не выдал QR-код. Проверьте подключение оплаты по QR (СБП) в Точке — подробности в журнале сервера.';
const BANK_CHECK_FAILED = 'Не удаётся связаться с банком — продолжаем проверять оплату.';
const REJECTED_HINT = 'Банк клиента отклонил оплату. Клиент может попробовать ещё раз по этому же QR-коду.';
const GAVE_UP = 'Банк так и не подтвердил оплату. Проверьте поступление в интернет-банке Точки.';
const paidAfterCancel = (amount: number) =>
  `Клиент оплатил ${formatRub(amount)} по QR-коду уже после отмены. Продажа не проведена: проверьте, не оплачен ли чек ` +
  'другим способом, и при необходимости верните деньги в интернет-банке Точки.';
const paidNotSold = (amount: number, reason: string) => `Оплата ${formatRub(amount)} получена, но продажа не проведена: ${reason}`;

export function requireQrProvider(ctx: AppContext): QrProvider {
  if (!ctx.qr) throw conflict('Оплата по QR-коду не настроена на сервере');
  return ctx.qr;
}

/** Asks the bank for a one-off code; bank failures become a `payment_provider_error` safe to show. */
export async function registerBankCode(
  ctx: AppContext,
  provider: QrProvider,
  input: { amount: number; purpose: string; ttlMinutes: number },
): Promise<CreatedQr> {
  try {
    return await provider.createQr(input);
  } catch (err) {
    ctx.log.error({ err: errorMessage(err), provider: provider.name }, 'QR code registration failed');
    const refused = err instanceof QrProviderError && err.status !== undefined && err.status < 500;
    throw new AppError('payment_provider_error', refused ? BANK_REFUSED : BANK_UNAVAILABLE);
  }
}

export function getQrPaymentRow(db: DbOrTx, id: number): QrPaymentRow {
  const row = db.select().from(qrPayments).where(eq(qrPayments.id, id)).get();
  if (!row) throw notFound('QR-платёж не найден');
  return row;
}

export function serializeQrPayment(db: DbOrTx, row: QrPaymentRow) {
  return qrPaymentOut(row, row.saleId != null ? serializeSale(db, getSaleRow(db, row.saleId)) : null);
}

/** Shown in the client's bank app next to the amount (SBP limits it to 140 characters). */
function purposeFor(db: DbOrTx): string {
  return `Оплата услуг, ${getStudioSettings(db).name}`.slice(0, 140);
}

/**
 * Validates the cart, asks the bank for a one-off QR code for `payments.qr` and remembers the cart with its prices
 * fixed. Nothing is sold yet: the sale is created by `refreshQrPayment` once the bank reports the money received.
 */
export async function createQrPayment(ctx: AppContext, input: SaleInput, employeeId: number): Promise<QrPaymentRow> {
  const provider = requireQrProvider(ctx);
  if (input.payments.qr <= 0) throw badRequest('Укажите сумму оплаты по QR-коду');
  assertShiftOpen(ctx.db);
  const prepared = prepareSale(ctx.db, input, employeeId);
  // A catalog price edited (or a size added) before the client pays must not change what is sold: the stored cart
  // keeps every item's price and size as validated now.
  const frozen: SaleInput = {
    ...input,
    items: input.items.map((item, i) => {
      const resolved = prepared.items[i]!;
      return resolved.variantId != null ? { ...item, price: resolved.price, variantId: resolved.variantId } : { ...item, price: resolved.price };
    }),
  };
  const created = await registerBankCode(ctx, provider, {
    amount: input.payments.qr,
    purpose: purposeFor(ctx.db),
    ttlMinutes: QR_TTL_MINUTES,
  });
  const now = Date.now();
  return ctx.db
    .insert(qrPayments)
    .values({
      kind: 'sale',
      provider: provider.name,
      externalId: created.externalId,
      payload: created.payload,
      amount: input.payments.qr,
      status: 'pending',
      saleInputJson: JSON.stringify(frozen),
      employeeId,
      expiresAt: now + QR_TTL_MINUTES * 60_000,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
}

/**
 * Still worth asking the bank about: unresolved, or cancelled while the client could still pay it (until a
 * successful check after expiry — `checkedAt` only moves on successful checks).
 */
function isWatched(row: QrPaymentRow, now: number): boolean {
  if (row.status === 'pending') return true;
  if (row.status !== 'cancelled') return false;
  const settled = row.checkedAt != null && row.checkedAt > row.expiresAt + QR_SETTLE_GRACE_MS;
  return !settled && now <= row.expiresAt + QR_GIVE_UP_MS;
}

function update(db: DbOrTx, id: number, values: Partial<QrPaymentRow>): QrPaymentRow {
  return db.update(qrPayments).set(values).where(eq(qrPayments.id, id)).returning().get()!;
}

/**
 * Money arrived. A prepayment code records the prepayment (always — see `recordQrDeposit`). A checkout code sells the
 * remembered cart; a cancelled one is not sold — staff may have taken the money another way — and neither is a cart
 * that no longer validates; both leave the payment flagged for staff.
 */
function completePaid(db: DbOrTx, row: QrPaymentRow, now: number): QrPaymentRow {
  const paid = { status: 'paid', paidAt: now, checkedAt: now, updatedAt: now };
  if (row.kind === 'deposit') {
    const error = recordQrDeposit(db, row, now);
    settlePaidHold(db, row, now); // an online booking waiting for this prepayment is confirmed
    return update(db, row.id, { ...paid, error });
  }
  if (row.status === 'cancelled') return update(db, row.id, { ...paid, error: paidAfterCancel(row.amount) });
  if (row.saleInputJson == null) throw new Error(`QR payment ${row.id} has no cart to sell`);
  const input = JSON.parse(row.saleInputJson) as SaleInput;
  try {
    const sale = createSale(db, { ...input, payments: { ...input.payments, qr: row.amount } }, row.employeeId);
    return update(db, row.id, { ...paid, saleId: sale.id, error: null });
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    return update(db, row.id, { ...paid, error: paidNotSold(row.amount, err.message) });
  }
}

/** Applies the bank's answer atomically, so a paid code yields exactly one sale however many polls race. */
export function applyBankStatus(db: DbOrTx, id: number, bank: QrBankStatus, now: number): QrPaymentRow {
  return db.transaction((tx) => {
    const row = getQrPaymentRow(tx, id);
    if (!isWatched(row, now)) return row;
    if (bank === 'paid') return completePaid(tx, row, now);
    const values: Partial<QrPaymentRow> = { checkedAt: now, updatedAt: now };
    if (row.status === 'pending') {
      const expired = now > row.expiresAt + QR_SETTLE_GRACE_MS;
      if (expired) values.status = 'expired';
      values.error = !expired && bank === 'rejected' ? REJECTED_HINT : null;
    }
    return update(tx, row.id, values);
  });
}

/** The bank could not be asked: tell the cashier, and give a pending code up once a paid one would be unreadable. */
function applyCheckFailure(db: DbOrTx, id: number, now: number): QrPaymentRow {
  return db.transaction((tx) => {
    const row = getQrPaymentRow(tx, id);
    if (row.status !== 'pending') return row;
    const gaveUp = now > row.expiresAt + QR_GIVE_UP_MS;
    return update(tx, id, gaveUp ? { status: 'expired', error: GAVE_UP, updatedAt: now } : { error: BANK_CHECK_FAILED, updatedAt: now });
  });
}

/** Money that needs a person: logged as an error and sent to the staff Telegram chat. */
async function alertStaff(ctx: AppContext, row: QrPaymentRow): Promise<void> {
  ctx.log.error({ qrPaymentId: row.id, amount: row.amount, status: row.status, error: row.error }, 'QR payment needs attention');
  await notifyStaff(ctx, `⚠️ Оплата по QR №${row.id} (${formatRub(row.amount)}): ${row.error}`);
}

async function checkBank(ctx: AppContext, id: number, force: boolean): Promise<QrPaymentRow> {
  const row = getQrPaymentRow(ctx.db, id);
  const now = Date.now();
  if (!ctx.qr || !isWatched(row, now)) return row;
  if (!force && row.checkedAt != null && now - row.checkedAt < QR_MIN_CHECK_INTERVAL_MS) return row;
  const holdWaiting = awaitsPayment(ctx.db, row);
  let bank: QrBankStatus;
  try {
    bank = await ctx.qr.paymentStatus(row.externalId);
  } catch (err) {
    ctx.log.warn({ err: errorMessage(err), qrPaymentId: id }, 'QR payment status check failed');
    const failed = applyCheckFailure(ctx.db, id, Date.now());
    if (failed.status === 'expired' && row.status === 'pending') await alertStaff(ctx, failed);
    return failed;
  }
  const updated = applyBankStatus(ctx.db, id, bank, Date.now());
  if (updated.status === 'paid' && row.status !== 'paid') {
    ctx.log.info({ qrPaymentId: id, kind: updated.kind, saleId: updated.saleId, amount: updated.amount }, 'QR payment received');
    auditQrPaid(ctx, updated);
    if (updated.error) await alertStaff(ctx, updated);
    if (holdWaiting && holdSettled(ctx.db, updated)) await announceHoldPaid(ctx, updated.appointmentId!, updated.amount);
    else if (updated.kind === 'deposit') await announceQrDeposit(ctx, updated);
    // The poll that found the payment does not wait for Telegram (sendSaleReceipt never throws).
    if (updated.saleId != null) void sendSaleReceipt(ctx, updated.saleId);
  }
  return updated;
}

/** Bank checks in progress per app, so overlapping polls of one code share a single bank request. */
const inFlight = new WeakMap<AppContext, Map<number, Promise<QrPaymentRow>>>();

/** Asks the bank (at most every QR_MIN_CHECK_INTERVAL_MS after a successful check unless `force`) and applies it. */
export function refreshQrPayment(ctx: AppContext, id: number, opts: { force?: boolean } = {}): Promise<QrPaymentRow> {
  let running = inFlight.get(ctx);
  if (!running) {
    running = new Map();
    inFlight.set(ctx, running);
  }
  const existing = running.get(id);
  if (existing) return existing;
  const check = checkBank(ctx, id, opts.force ?? false).finally(() => running.delete(id));
  running.set(id, check);
  return check;
}

/**
 * Stops waiting for a code (the client chose another way to pay). Asks the bank first, so a payment that has
 * just arrived completes the sale instead. A later payment by this code is flagged for staff, not sold.
 */
export async function cancelQrPayment(ctx: AppContext, id: number): Promise<QrPaymentRow> {
  const row = await refreshQrPayment(ctx, id, { force: true });
  if (row.status !== 'pending') return row;
  const cancelled = ctx.db
    .update(qrPayments)
    .set({ status: 'cancelled', error: null, updatedAt: Date.now() })
    .where(and(eq(qrPayments.id, id), eq(qrPayments.status, 'pending')))
    .returning()
    .get();
  return cancelled ?? getQrPaymentRow(ctx.db, id);
}

/** Prepayment links are checked less often than checkout codes, which someone is waiting at the counter for. */
function dueForSweep(row: Pick<QrPaymentRow, 'kind' | 'checkedAt'>, now: number): boolean {
  return row.kind !== 'deposit' || row.checkedAt == null || now - row.checkedAt >= DEPOSIT_SWEEP_INTERVAL_MS;
}

/** Background check of every watched code, so a payment is recorded even if the app was closed. */
export async function sweepQrPayments(ctx: AppContext): Promise<void> {
  if (!ctx.qr) return;
  const now = Date.now();
  const rows = ctx.db
    .select({ id: qrPayments.id, kind: qrPayments.kind, checkedAt: qrPayments.checkedAt })
    .from(qrPayments)
    .where(
      or(
        eq(qrPayments.status, 'pending'),
        and(eq(qrPayments.status, 'cancelled'), gt(qrPayments.expiresAt, now - QR_GIVE_UP_MS)),
      ),
    )
    .all()
    .filter((row) => dueForSweep(row, now));
  for (const { id } of rows) {
    try {
      await refreshQrPayment(ctx, id);
    } catch (err) {
      ctx.log.error({ err: errorMessage(err), qrPaymentId: id }, 'QR payment sweep failed for a code');
    }
  }
}
