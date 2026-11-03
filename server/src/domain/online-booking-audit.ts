import type { AppContext } from '../context.js';
import type { AppointmentRow } from '../lib/serialize.js';
import { auditSafely, writeAudit, type AuditSource } from './audit.js';
import { appointmentRef } from './audit-summaries-visits.js';
import { formatWhen } from './audit-text.js';
import { bookingFacts, CHANNEL_LABELS } from './online-booking-messages.js';
import { getStudioSettings } from './settings.js';

/**
 * Audit entries of online booking (docs/API.md «Audit log»): the booking by the client — source `bot` (the AI in
 * Telegram) or `online` (the booking page, the Mini App) — and what the server does by itself (`system`). Staff
 * confirming or rejecting in the app is captured like any app write.
 */

const sourceOf = (channel: string): AuditSource => (channel === 'bot' ? 'bot' : 'online');

function entry(ctx: AppContext, source: AuditSource, a: AppointmentRow, action: string, summary: string, changes: Record<string, { from: unknown; to: unknown }> | null): void {
  writeAudit(ctx.db, { source, employeeId: null, action, entity: 'appointment', entityId: a.id, summary, changes }, ctx.log);
}

/** «Запись №12 (Анна Иванова) создана онлайн (сайт) на 21 октября, 15:00 — Мочка, мастер Фатима · ждёт подтверждения» */
export function auditOnlineBooked(ctx: AppContext, a: AppointmentRow): void {
  auditSafely(() => {
    const f = bookingFacts(ctx.db, a);
    const state = a.onlineState === 'awaiting_payment' ? 'ждёт предоплату' : 'ждёт подтверждения';
    entry(
      ctx,
      sourceOf(a.channel),
      a,
      'appointment.create',
      `Запись ${appointmentRef(a.id, f.client)} создана онлайн (${CHANNEL_LABELS[a.channel] ?? a.channel}) на ${f.when} — ` +
        `${f.what}, мастер ${f.master} · ${state}`,
      null,
    );
  }, ctx.log);
}

/** The prepayment of a held booking arrived: it is confirmed by itself. */
export function auditHoldPaid(ctx: AppContext, a: AppointmentRow): void {
  auditSafely(() => {
    const f = bookingFacts(ctx.db, a);
    entry(ctx, 'system', a, 'appointment.confirm', `Онлайн-запись ${appointmentRef(a.id, f.client)} подтверждена: предоплата получена`, {
      onlineState: { from: 'awaiting_payment', to: null },
    });
  }, ctx.log);
}

/** An unpaid hold ran out: the server cancelled the booking. */
export function auditHoldReleased(ctx: AppContext, before: AppointmentRow, after: AppointmentRow): void {
  auditSafely(() => {
    const f = bookingFacts(ctx.db, after);
    entry(
      ctx,
      'system',
      after,
      'appointment.status',
      `Онлайн-запись ${appointmentRef(after.id, f.client)} на ${f.when} отменена: предоплата не внесена вовремя`,
      { status: { from: before.status, to: after.status } },
    );
  }, ctx.log);
}

/** Nobody confirmed the booking in time (`onlineBooking.confirmationHours`): the server rejected it. */
export function auditUnconfirmedRejected(ctx: AppContext, before: AppointmentRow, after: AppointmentRow): void {
  auditSafely(() => {
    const f = bookingFacts(ctx.db, after);
    entry(
      ctx,
      'system',
      after,
      'appointment.online_reject',
      `Онлайн-запись ${appointmentRef(after.id, f.client)} на ${f.when} отклонена: её не подтвердили вовремя`,
      { status: { from: before.status, to: after.status } },
    );
  }, ctx.log);
}

/** The client cancelled on their booking page. */
export function auditClientCancelled(ctx: AppContext, before: AppointmentRow, after: AppointmentRow): void {
  auditSafely(() => {
    const tz = getStudioSettings(ctx.db).timezone;
    const f = bookingFacts(ctx.db, after);
    entry(
      ctx,
      'online',
      after,
      'appointment.status',
      `Запись ${appointmentRef(after.id, f.client)} на ${formatWhen(after.startsAt, tz)} отменена клиентом на странице записи`,
      { status: { from: before.status, to: after.status } },
    );
  }, ctx.log);
}
