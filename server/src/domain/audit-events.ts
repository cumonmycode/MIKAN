import { eq } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import type { DbOrTx } from '../db/client.js';
import { appointments, clients, sales } from '../db/schema.js';
import type { AppointmentRow, BookingRow, QrPaymentRow } from '../lib/serialize.js';
import { formatRub } from '../lib/text.js';
import { toIso } from '../lib/time.js';
import { auditSafely, writeAudit } from './audit.js';
import { appointmentRef } from './audit-summaries-visits.js';
import { formatWhen } from './audit-text.js';
import { studioTimezone } from './settings.js';

/**
 * Entries of what is not an app request: client actions in the bot (`bot`) and what the server does by itself
 * (`system`). Like every audit write, these never fail the action they describe.
 */

const clientOf = (db: DbOrTx, clientId: number) => db.select().from(clients).where(eq(clients.id, clientId)).get() ?? null;
/** «№1846 (Анна Иванова)» of an appointment row. */
const refOf = (db: DbOrTx, a: AppointmentRow) => appointmentRef(a.id, clientOf(db, a.clientId));

/** The client moved their appointment through the bot. */
export function auditClientReschedule(ctx: AppContext, before: AppointmentRow, after: AppointmentRow): void {
  auditSafely(() => {
    const tz = studioTimezone(ctx.db);
    writeAudit(
      ctx.db,
      {
        source: 'bot',
        employeeId: null,
        action: 'appointment.move',
        entity: 'appointment',
        entityId: after.id,
        summary:
          `Запись ${refOf(ctx.db, after)} перенесена клиентом через бота с ${formatWhen(before.startsAt, tz)} ` +
          `на ${formatWhen(after.startsAt, tz)}`,
        changes: {
          startsAt: { from: toIso(before.startsAt), to: toIso(after.startsAt) },
          endsAt: { from: toIso(before.endsAt), to: toIso(after.endsAt) },
        },
      },
      ctx.log,
    );
  }, ctx.log);
}

/** «✅ Приду» under a reminder. */
export function auditClientConfirm(ctx: AppContext, before: AppointmentRow, after: AppointmentRow): void {
  auditSafely(() => {
    writeAudit(
      ctx.db,
      {
        source: 'bot',
        employeeId: null,
        action: 'appointment.confirm',
        entity: 'appointment',
        entityId: after.id,
        summary: `Запись ${refOf(ctx.db, after)} подтверждена клиентом в боте`,
        changes: { status: { from: before.status, to: after.status } },
      },
      ctx.log,
    );
  }, ctx.log);
}

/** A booking request the bot took from a client. */
export function auditBookingRequest(ctx: AppContext, row: BookingRow): void {
  const what = [row.serviceName, row.preferredTime].filter(Boolean).join(', ');
  writeAudit(
    ctx.db,
    {
      source: 'bot',
      employeeId: null,
      action: 'bot.booking_create',
      entity: 'bot',
      entityId: row.id,
      summary: `Заявка на запись №${row.id} из бота: ${row.contactName || 'клиент'}${what ? ` — ${what}` : ''}`,
    },
    ctx.log,
  );
}

/**
 * The cancellation rules kept (part of) the prepayment by themselves (`StudioSettings.cancellation.autoRetain`).
 * Written in the same transaction as the retain.
 */
export function auditAutoRetain(db: DbOrTx, appointment: AppointmentRow, retain: { amount: number; reason: string }): void {
  auditSafely(() => {
    writeAudit(db, {
      source: 'system',
      employeeId: null,
      action: 'deposit.retain',
      entity: 'deposit',
      entityId: appointment.id,
      summary: `Предоплата по записи ${refOf(db, appointment)} удержана автоматически: ${formatRub(retain.amount)} — ${retain.reason}`,
    });
  });
}

/** The bank confirmed a QR payment: a checkout sold (or why it was not), or a prepayment received. */
export function auditQrPaid(ctx: AppContext, row: QrPaymentRow): void {
  auditSafely(() => {
    const amount = formatRub(row.amount);
    const warning = row.error ? `. ${row.error}` : '';
    if (row.kind === 'deposit') {
      const id = row.appointmentId;
      const appointment = id != null ? ctx.db.select().from(appointments).where(eq(appointments.id, id)).get() : undefined;
      const ref = appointment ? refOf(ctx.db, appointment) : `№${id ?? '—'}`;
      writeAudit(
        ctx.db,
        {
          source: 'system',
          employeeId: null,
          action: 'deposit.qr_paid',
          entity: 'deposit',
          entityId: id,
          summary: `Предоплата по записи ${ref} получена по QR-коду: ${amount}${warning}`,
        },
        ctx.log,
      );
      return;
    }
    const sale = row.saleId != null ? ctx.db.select().from(sales).where(eq(sales.id, row.saleId)).get() : undefined;
    writeAudit(
      ctx.db,
      {
        source: 'system',
        employeeId: null,
        action: 'sale.qr_paid',
        entity: 'sale',
        entityId: sale?.id ?? null,
        summary: sale
          ? `Оплата по QR-коду №${row.id} подтверждена банком: продажа №${sale.number}, ${amount}`
          : `Оплата по QR-коду №${row.id} подтверждена банком: ${amount}${warning}`,
      },
      ctx.log,
    );
  }, ctx.log);
}
