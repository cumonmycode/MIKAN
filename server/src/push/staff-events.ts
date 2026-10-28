import { DateTime } from 'luxon';
import { appointmentWhat } from '../bot/client-appointments.js';
import type { DbOrTx } from '../db/client.js';
import { clientsByIds } from '../domain/refs.js';
import { studioTimezone } from '../domain/settings.js';
import { clientFullName, type AppointmentRow, type BookingRow, type BotChatRow } from '../lib/serialize.js';
import { formatRub, truncate } from '../lib/text.js';
import { formatTime } from '../lib/time.js';
import type { StaffPush } from './staff-push.js';

/**
 * The push texts of the staff events (docs/API.md «Push notifications»). Each is passed to `notifyStaff` next to
 * the staff chat message about the same thing: `notifyStaff(ctx, text, onlineBookingPush(ctx.db, appointment))`.
 */

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const MESSAGE_PREVIEW = 200;

/** «21 окт, 15:00» in the studio timezone. */
export function pushDateTime(ms: number, tz: string): string {
  const local = DateTime.fromMillis(ms, { zone: tz });
  return `${local.day} ${MONTHS[local.month - 1]}, ${local.toFormat('HH:mm')}`;
}

/** The client's full name; null for a missing card (building a push never throws). */
function clientName(db: DbOrTx, clientId: number): string | null {
  const client = clientsByIds(db, [clientId]).get(clientId);
  return (client && clientFullName(client)) || null;
}

/** «· ждёт подтверждения» / «· ждёт оплату до 14:35» of an unsettled online booking. */
function onlineStateText(appointment: AppointmentRow, tz: string): string | null {
  if (appointment.onlineState === 'awaiting_confirmation') return 'ждёт подтверждения';
  if (appointment.onlineState === 'awaiting_payment') {
    return appointment.holdUntil != null ? `ждёт оплату до ${formatTime(appointment.holdUntil, tz)}` : 'ждёт оплату';
  }
  return null;
}

/** «Новая онлайн-запись» · «Анна · Мочка · 21 окт, 15:00 · ждёт подтверждения» — owners, admins and the master. */
export function onlineBookingPush(db: DbOrTx, appointment: AppointmentRow): StaffPush {
  const tz = studioTimezone(db);
  const parts = [
    clientName(db, appointment.clientId) ?? 'Клиент',
    appointmentWhat(db, [appointment]).get(appointment.id),
    pushDateTime(appointment.startsAt, tz),
    onlineStateText(appointment, tz),
  ];
  return {
    type: 'online_booking',
    title: 'Новая онлайн-запись',
    body: parts.filter(Boolean).join(' · '),
    data: { appointmentId: appointment.id },
    masterId: appointment.masterId,
  };
}

/** «Клиент отменил запись» · «Анна · 21 окт, 15:00» — owners, admins and the master. */
export function clientCancelledPush(db: DbOrTx, appointment: AppointmentRow): StaffPush {
  return {
    type: 'client_cancelled',
    title: 'Клиент отменил запись',
    body: `${clientName(db, appointment.clientId) ?? 'Клиент'} · ${pushDateTime(appointment.startsAt, studioTimezone(db))}`,
    data: { appointmentId: appointment.id },
    masterId: appointment.masterId,
  };
}

/** «Предоплата получена» · «Анна · 2 000 ₽ · запись 21 окт, 15:00» — owners, admins and the master. */
export function depositPaidPush(db: DbOrTx, appointment: AppointmentRow, amount: number): StaffPush {
  const when = pushDateTime(appointment.startsAt, studioTimezone(db));
  return {
    type: 'deposit_paid',
    title: 'Предоплата получена',
    body: `${clientName(db, appointment.clientId) ?? 'Клиент'} · ${formatRub(amount)} · запись ${when}`,
    data: { appointmentId: appointment.id },
    masterId: appointment.masterId,
  };
}

/** «Новая заявка» · «Анна · Мочка · в субботу после 15:00» — owners and admins. */
export function bookingRequestPush(request: BookingRow): StaffPush {
  return {
    type: 'booking_request',
    title: 'Новая заявка',
    body: [request.contactName, request.serviceName, request.preferredTime].map((p) => p?.trim()).filter(Boolean).join(' · '),
    data: { bookingRequestId: request.id },
  };
}

/** «Клиент ждёт ответа» · «Анна: …» — a chat got `needsAttention`; everyone. */
export function clientMessagePush(db: DbOrTx, chat: BotChatRow, text: string): StaffPush {
  const name = (chat.clientId != null ? clientName(db, chat.clientId) : null) || chat.telegramName?.trim() || 'Клиент';
  return {
    type: 'client_message',
    title: 'Клиент ждёт ответа',
    body: `${name}: ${truncate(text.trim(), MESSAGE_PREVIEW)}`,
    data: { chatId: chat.chatId },
  };
}
