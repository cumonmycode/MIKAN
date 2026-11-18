import { eq } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import type { DbOrTx } from '../db/client.js';
import { qrPayments } from '../db/schema.js';
import { badRequest, conflict, errorMessage } from '../lib/errors.js';
import type { AppointmentRow, QrPaymentRow } from '../lib/serialize.js';
import { MINUTE_MS } from '../lib/time.js';
import { deliveryProblem, depositLinkText, requireDepositChat, sendToClientChat, type DepositLinkText } from './deposit-messages.js';
import { assertDepositOpen, cancelPendingDepositCodes, heldDeposit, pendingDepositCodes, touchAppointment } from './deposits.js';
import { QR_TTL_MINUTES, refreshQrPayment, registerBankCode, requireQrProvider } from './qr-payments.js';
import { getAppointmentRow } from './refs.js';
import { getStudioSettings } from './settings.js';

/**
 * Prepayment QR codes: shown on the phone at the studio, or sent to the client by the bot as a link. Paying one is
 * recorded by `qr-payments.ts` (a `receive` with method `qr`), not here.
 */

export const DEPOSIT_DELIVERIES = ['screen', 'telegram', 'link'] as const;
export type DepositDelivery = (typeof DEPOSIT_DELIVERIES)[number];

/** A link stays valid until the appointment starts, within these bounds. */
export const DEPOSIT_LINK_MIN_TTL_MINUTES = 30;
/** NSPK's default lifetime of a dynamic code (3 days). */
export const DEPOSIT_LINK_MAX_TTL_MINUTES = 72 * 60;
/** A reminder resends the pending link only while it has at least this long left; otherwise a fresh link goes out. */
export const DEPOSIT_REMIND_MIN_LEFT_MS = 15 * MINUTE_MS;

export interface DepositLinkResult {
  appointment: AppointmentRow;
  payment: QrPaymentRow;
  /** Why the bot could not deliver the link (the code stays valid). */
  sendError: string | null;
}

export function depositLinkTtlMinutes(startsAt: number, now: number): number {
  const untilStart = Math.ceil((startsAt - now) / MINUTE_MS);
  return Math.min(DEPOSIT_LINK_MAX_TTL_MINUTES, Math.max(DEPOSIT_LINK_MIN_TTL_MINUTES, untilStart));
}

/** Shown in the client's bank app next to the amount (SBP limits it to 140 characters). */
function depositPurpose(db: DbOrTx): string {
  return `Предоплата, ${getStudioSettings(db).name}`.slice(0, 140);
}

/** Older codes of the appointment are asked about first, so a payment that has just arrived counts. */
async function settlePendingCodes(ctx: AppContext, appointmentId: number): Promise<void> {
  for (const code of pendingDepositCodes(ctx.db, appointmentId)) {
    try {
      await refreshQrPayment(ctx, code.id, { force: true });
    } catch (err) {
      ctx.log.warn({ err: errorMessage(err), qrPaymentId: code.id }, 'prepayment code check before a new one failed');
    }
  }
}

/** Sends the link of `code` to `chatId`; a failure is reported to staff, the code stays valid. */
async function deliver(
  ctx: AppContext,
  appointment: AppointmentRow,
  code: QrPaymentRow,
  chatId: number,
  kind: DepositLinkText,
): Promise<{ payment: QrPaymentRow; sendError: string | null }> {
  try {
    await sendToClientChat(ctx, chatId, appointment.clientId, depositLinkText(ctx.db, appointment, code, kind), appointment);
  } catch (err) {
    ctx.log.warn({ err: errorMessage(err), qrPaymentId: code.id, chatId }, 'prepayment link not delivered');
    return { payment: code, sendError: deliveryProblem(err) };
  }
  const now = Date.now();
  const payment = ctx.db.update(qrPayments).set({ sentAt: now, updatedAt: now }).where(eq(qrPayments.id, code.id)).returning().get()!;
  return { payment, sendError: null };
}

/** What is still to be paid: required − held. */
function missingDeposit(db: DbOrTx, appointment: AppointmentRow): number {
  return appointment.depositRequired - heldDeposit(db, appointment.id);
}

function requireMissing(appointment: AppointmentRow, missing: number): number {
  if (missing > 0) return missing;
  throw conflict(
    appointment.depositRequired > 0
      ? 'Предоплата по записи уже внесена'
      : 'Для записи не указана предоплата — задайте сумму в записи или в ссылке',
  );
}

/**
 * Registers a prepayment code for `amount` (default: what is still missing), cancelling the appointment's other
 * pending codes, and — for `telegram` — sends it to the client.
 */
export async function issueDepositCode(
  ctx: AppContext,
  appointmentId: number,
  input: { delivery: DepositDelivery; amount?: number; chatId?: number | null },
  employeeId: number,
): Promise<DepositLinkResult> {
  const provider = requireQrProvider(ctx);
  assertDepositOpen(getAppointmentRow(ctx.db, appointmentId));
  if (input.amount !== undefined && input.amount <= 0) throw badRequest('«Сумма»: должно быть больше 0');
  await settlePendingCodes(ctx, appointmentId);
  const appointment = getAppointmentRow(ctx.db, appointmentId);
  assertDepositOpen(appointment);
  const chatId = input.delivery === 'telegram' ? requireDepositChat(ctx, appointment, input.chatId) : null;
  const amount = input.amount ?? requireMissing(appointment, missingDeposit(ctx.db, appointment));

  const started = Date.now();
  const ttlMinutes = input.delivery === 'screen' ? QR_TTL_MINUTES : depositLinkTtlMinutes(appointment.startsAt, started);
  const created = await registerBankCode(ctx, provider, { amount, purpose: depositPurpose(ctx.db), ttlMinutes });
  const now = Date.now();
  const code = ctx.db.transaction((tx) => {
    // The appointment may have changed during the bank call (cancelled, paid another way): an unrecorded code
    // is never shown to anyone and simply expires at the bank.
    const current = getAppointmentRow(tx, appointmentId);
    assertDepositOpen(current);
    if (input.amount === undefined && missingDeposit(tx, current) !== amount) {
      throw conflict('Пока создавался QR-код, предоплата по записи изменилась — попробуйте ещё раз');
    }
    cancelPendingDepositCodes(tx, appointmentId, now);
    touchAppointment(tx, appointmentId, now);
    return tx
      .insert(qrPayments)
      .values({
        kind: 'deposit',
        appointmentId,
        provider: provider.name,
        externalId: created.externalId,
        payload: created.payload,
        amount,
        status: 'pending',
        saleInputJson: null,
        employeeId,
        expiresAt: started + ttlMinutes * MINUTE_MS,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
  });
  const sent = chatId !== null ? await deliver(ctx, appointment, code, chatId, 'link') : { payment: code, sendError: null };
  return { appointment: getAppointmentRow(ctx.db, appointmentId), ...sent };
}

/**
 * «Напомнить клиенту»: resends the pending link while it is for the missing amount and has time left, otherwise
 * sends a fresh one. Nothing is sent when the prepayment is already covered.
 */
export async function remindDeposit(
  ctx: AppContext,
  appointmentId: number,
  input: { chatId?: number | null },
  employeeId: number,
): Promise<DepositLinkResult> {
  requireQrProvider(ctx);
  assertDepositOpen(getAppointmentRow(ctx.db, appointmentId));
  await settlePendingCodes(ctx, appointmentId);
  const appointment = getAppointmentRow(ctx.db, appointmentId);
  assertDepositOpen(appointment);
  const missing = requireMissing(appointment, missingDeposit(ctx.db, appointment));
  const chatId = requireDepositChat(ctx, appointment, input.chatId);
  const [pending] = pendingDepositCodes(ctx.db, appointmentId);
  const reusable = pending && pending.amount === missing && pending.expiresAt - Date.now() >= DEPOSIT_REMIND_MIN_LEFT_MS;
  if (!reusable) return issueDepositCode(ctx, appointmentId, { delivery: 'telegram', chatId }, employeeId);
  const sent = await deliver(ctx, appointment, pending, chatId, 'reminder');
  return { appointment: getAppointmentRow(ctx.db, appointmentId), ...sent };
}
