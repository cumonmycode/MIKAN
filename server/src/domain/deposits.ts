import { and, eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { appointments, depositOperations, qrPayments } from '../db/schema.js';
import { badRequest, conflict } from '../lib/errors.js';
import type { AppointmentRow, DepositOperationRow, QrPaymentRow, SaleRow } from '../lib/serialize.js';
import { formatRub } from '../lib/text.js';
import { auditAutoRetain } from './audit-events.js';
import { closingRetain } from './cancellation.js';
import { getOpenShift } from './cash.js';
import {
  appointmentLedger,
  DEPOSIT_OPEN_STATUSES,
  heldAmount,
  lastReceiveMethod,
  type DepositMethod,
  type DepositOperationType,
} from './deposit-ledger.js';
import { getAppointmentRow } from './refs.js';
import { getStudioSettings } from './settings.js';

/**
 * The prepayment ledger write side. Every movement is a new `deposit_operations` row; money is counted once, when it
 * is received (cash goes into the open shift's drawer), and a sale only records which part of it it consumed.
 */

/** Methods staff record by hand; `qr` receipts come only from a paid prepayment QR code. */
export const MANUAL_DEPOSIT_METHODS = ['cash', 'card', 'transfer'] as const;
export type ManualDepositMethod = (typeof MANUAL_DEPOSIT_METHODS)[number];

const RETAINABLE_STATUSES = ['cancelled', 'no_show'];

interface OperationInput {
  appointmentId: number;
  type: DepositOperationType;
  amount: number;
  method?: DepositMethod | null;
  shiftId?: number | null;
  saleId?: number | null;
  qrPaymentId?: number | null;
  note?: string | null;
  employeeId: number | null;
  createdAt: number;
}

function insertOperation(db: DbOrTx, input: OperationInput): DepositOperationRow {
  return db
    .insert(depositOperations)
    .values({
      appointmentId: input.appointmentId,
      type: input.type,
      amount: input.amount,
      method: input.method ?? null,
      shiftId: input.shiftId ?? null,
      saleId: input.saleId ?? null,
      qrPaymentId: input.qrPaymentId ?? null,
      note: input.note ?? null,
      employeeId: input.employeeId,
      createdAt: input.createdAt,
    })
    .returning()
    .get();
}

/** Bumps `updatedAt` so apps refreshing by change time see the new prepayment state. */
export function touchAppointment(db: DbOrTx, appointmentId: number, now: number): AppointmentRow {
  return db.update(appointments).set({ updatedAt: now }).where(eq(appointments.id, appointmentId)).returning().get()!;
}

export function heldDeposit(db: DbOrTx, appointmentId: number): number {
  return heldAmount(appointmentLedger(db, appointmentId));
}

/** The open shift for the operation; cash moves through the drawer, so it needs one. */
function shiftFor(db: DbOrTx, method: DepositMethod, action: string): number | null {
  const open = getOpenShift(db);
  if (method === 'cash' && !open) throw conflict(`Чтобы ${action} наличными, сначала откройте кассовую смену`);
  return open?.id ?? null;
}

export function assertDepositOpen(appointment: AppointmentRow): void {
  if (DEPOSIT_OPEN_STATUSES.includes(appointment.status)) return;
  if (appointment.status === 'completed') throw conflict('Запись уже завершена — оплату примите на кассе');
  throw conflict('Запись отменена — предоплату по ней не принимают');
}

/** What to give back / keep: the whole held amount by default, never more than it. */
function resolvedAmount(requested: number | undefined, held: number, verb: string): number {
  if (held <= 0) throw conflict('По записи нет внесённой предоплаты');
  const amount = requested ?? held;
  if (amount <= 0) throw badRequest('«Сумма»: должно быть больше 0');
  if (amount > held) throw conflict(`${verb} можно не больше ${formatRub(held)} — столько предоплаты за записью`);
  return amount;
}

/** The client paid the prepayment at the studio. */
export function receiveDeposit(
  db: DbOrTx,
  appointmentId: number,
  input: { amount: number; method: ManualDepositMethod; note?: string | null },
  employeeId: number,
): AppointmentRow {
  return db.transaction((tx) => {
    const appointment = getAppointmentRow(tx, appointmentId);
    assertDepositOpen(appointment);
    if (input.amount <= 0) throw badRequest('«Сумма»: должно быть больше 0');
    const now = Date.now();
    insertOperation(tx, {
      appointmentId,
      type: 'receive',
      amount: input.amount,
      method: input.method,
      shiftId: shiftFor(tx, input.method, `принять ${formatRub(input.amount)}`),
      note: input.note,
      employeeId,
      createdAt: now,
    });
    return touchAppointment(tx, appointmentId, now);
  });
}

/** Gives (part of) the held prepayment back; by default all of it, the way it was received. */
export function refundDeposit(
  db: DbOrTx,
  appointmentId: number,
  input: { amount?: number; method?: DepositMethod; reason?: string | null },
  employeeId: number,
): AppointmentRow {
  return db.transaction((tx) => {
    getAppointmentRow(tx, appointmentId);
    const ledger = appointmentLedger(tx, appointmentId);
    const amount = resolvedAmount(input.amount, heldAmount(ledger), 'Вернуть');
    const method = input.method ?? lastReceiveMethod(ledger) ?? 'transfer';
    const now = Date.now();
    insertOperation(tx, {
      appointmentId,
      type: 'refund',
      amount,
      method,
      shiftId: shiftFor(tx, method, `вернуть ${formatRub(amount)}`),
      note: input.reason,
      employeeId,
      createdAt: now,
    });
    return touchAppointment(tx, appointmentId, now);
  });
}

/** The studio keeps the prepayment of a cancelled appointment or a no-show. */
export function retainDeposit(
  db: DbOrTx,
  appointmentId: number,
  input: { amount?: number; reason?: string | null },
  employeeId: number | null,
): AppointmentRow {
  return db.transaction((tx) => {
    const appointment = getAppointmentRow(tx, appointmentId);
    if (!RETAINABLE_STATUSES.includes(appointment.status)) {
      throw conflict('Удержать предоплату можно только по отменённой записи или при неявке');
    }
    const amount = resolvedAmount(input.amount, heldDeposit(tx, appointmentId), 'Удержать');
    const now = Date.now();
    insertOperation(tx, {
      appointmentId,
      type: 'retain',
      amount,
      shiftId: getOpenShift(tx)?.id ?? null,
      note: input.reason || (appointment.status === 'no_show' ? 'Неявка' : 'Отмена записи'),
      employeeId,
      createdAt: now,
    });
    return touchAppointment(tx, appointmentId, now);
  });
}

/**
 * `StudioSettings.cancellation.autoRetain`: the appointment has just been cancelled (at `at`) or marked a no-show —
 * keep the share the rules name of what it holds (nothing for a free cancellation). The remainder stays held for
 * staff to refund. Returns the updated row, or null when nothing was retained.
 */
export function autoRetainDeposit(
  db: DbOrTx,
  appointment: AppointmentRow,
  at: number,
  employeeId: number | null,
): AppointmentRow | null {
  const rules = getStudioSettings(db).cancellation;
  if (!rules.autoRetain) return null;
  const held = heldDeposit(db, appointment.id);
  if (held <= 0) return null;
  const retain = closingRetain(appointment.status, appointment.startsAt, at, held, rules);
  if (!retain || retain.amount <= 0) return null;
  const row = retainDeposit(db, appointment.id, retain, employeeId);
  auditAutoRetain(db, row, retain);
  return row;
}

/** Checkout: `amount` of the held prepayment is counted in `sale` (validated by `prepareSale`). */
export function applyDeposit(db: DbOrTx, sale: SaleRow, amount: number, employeeId: number): void {
  if (amount <= 0 || sale.appointmentId == null) return;
  insertOperation(db, {
    appointmentId: sale.appointmentId,
    type: 'apply',
    amount,
    shiftId: sale.shiftId,
    saleId: sale.id,
    note: `Чек №${sale.number}`,
    employeeId,
    createdAt: sale.createdAt,
  });
}

/**
 * Sale refund: the refund's prepayment part (`amount`) is not paid out — it is held for the appointment again. A sale
 * refunded in parts may unapply its prepayment in several steps.
 */
export function unapplyDeposit(
  db: DbOrTx,
  sale: SaleRow,
  refund: { amount: number; shiftId: number | null; note: string },
  employeeId: number,
  now: number,
): void {
  if (refund.amount <= 0 || sale.appointmentId == null) return;
  insertOperation(db, {
    appointmentId: sale.appointmentId,
    type: 'unapply',
    amount: refund.amount,
    shiftId: refund.shiftId,
    saleId: sale.id,
    note: refund.note,
    employeeId,
    createdAt: now,
  });
  touchAppointment(db, sale.appointmentId, now);
}

/** Why a paid prepayment code needs a person, or null when it is an ordinary prepayment. */
function qrDepositWarning(code: QrPaymentRow, appointment: AppointmentRow, heldBefore: number): string | null {
  const amount = formatRub(code.amount);
  // The appointment's state first: closing it is what cancelled its codes.
  if (appointment.status === 'cancelled' || appointment.status === 'no_show') {
    return `Предоплата ${amount} поступила по отменённой записи — верните её клиенту или удержите в карточке записи.`;
  }
  if (appointment.saleId != null && appointment.status === 'completed') {
    return `Предоплата ${amount} поступила, когда запись уже была оплачена, — верните её клиенту в карточке записи.`;
  }
  // A code cancelled by completing the appointment is fine: checkout will count the prepayment.
  if (code.status === 'cancelled' && appointment.status !== 'completed') {
    return `Клиент оплатил предоплату ${amount} по ссылке, которая уже была заменена или отменена. Проверьте, не внесена ли ` +
      'предоплата дважды, и при необходимости верните лишнее в карточке записи.';
  }
  const held = heldBefore + code.amount;
  if (appointment.depositRequired > 0 && held > appointment.depositRequired) {
    return `Предоплата внесена сверх нужной суммы: за записью ${formatRub(held)} при ${formatRub(appointment.depositRequired)}. ` +
      'Верните лишнее клиенту в карточке записи.';
  }
  return null;
}

/**
 * The bank confirmed a prepayment code: the money is recorded whatever happened to the code or the appointment
 * meanwhile (it is on the account either way). Returns a warning for staff when the payment is unexpected.
 */
export function recordQrDeposit(db: DbOrTx, code: QrPaymentRow, now: number): string | null {
  const appointment =
    code.appointmentId != null ? db.select().from(appointments).where(eq(appointments.id, code.appointmentId)).get() : undefined;
  if (!appointment) {
    return `Предоплата ${formatRub(code.amount)} получена, но запись не найдена — проверьте поступление в интернет-банке Точки.`;
  }
  const heldBefore = heldDeposit(db, appointment.id);
  insertOperation(db, {
    appointmentId: appointment.id,
    type: 'receive',
    amount: code.amount,
    method: 'qr',
    shiftId: getOpenShift(db)?.id ?? null,
    qrPaymentId: code.id,
    employeeId: code.employeeId,
    createdAt: now,
  });
  touchAppointment(db, appointment.id, now);
  return qrDepositWarning(code, appointment, heldBefore);
}

/** Pending prepayment codes of the appointment, newest first. */
export function pendingDepositCodes(db: DbOrTx, appointmentId: number): QrPaymentRow[] {
  return db
    .select()
    .from(qrPayments)
    .where(and(eq(qrPayments.kind, 'deposit'), eq(qrPayments.appointmentId, appointmentId), eq(qrPayments.status, 'pending')))
    .all()
    .sort((a, b) => b.id - a.id);
}

/**
 * Stops waiting for the appointment's pending prepayment codes. They stay watched by the background check, so a
 * payment that still arrives is recorded (with a warning) instead of being lost.
 */
export function cancelPendingDepositCodes(db: DbOrTx, appointmentId: number, now = Date.now()): number {
  return db
    .update(qrPayments)
    .set({ status: 'cancelled', updatedAt: now })
    .where(and(eq(qrPayments.kind, 'deposit'), eq(qrPayments.appointmentId, appointmentId), eq(qrPayments.status, 'pending')))
    .run().changes;
}
