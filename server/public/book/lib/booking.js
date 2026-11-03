// @ts-check
/** Pure rules of the booking page `/book/b/<token>`: status texts, when to poll, what the client may do. */

export const POLL_PAYMENT_MS = 3000;
export const POLL_AFTER_HOLD_MS = 10_000;
export const POLL_CONFIRMATION_MS = 30_000;
/** After the hold ends the server needs the bank's answer (checked every minute) before it releases the time. */
export const AFTER_HOLD_GRACE_MS = 3 * 60_000;

const STATUS = {
  awaiting_payment: {
    label: 'Ждёт предоплату',
    tone: 'warning',
    text: 'Внесите предоплату, чтобы закрепить время за собой.',
  },
  awaiting_confirmation: {
    label: 'Ждёт подтверждения',
    tone: 'warning',
    text: 'Заявка принята, время за вами. Студия подтвердит запись в ближайшее время.',
  },
  confirmed: { label: 'Запись подтверждена', tone: 'success', text: 'Ждём вас!' },
  cancelled: { label: 'Запись отменена', tone: 'muted', text: 'Если планы поменяются — запишитесь снова, будем рады.' },
  completed: { label: 'Визит состоялся', tone: 'muted', text: 'Спасибо, что выбрали нас!' },
};

/** { label, tone: 'warning' | 'success' | 'muted', text } for a booking status. */
export function statusInfo(status) {
  return STATUS[status] ?? { label: 'Запись', tone: 'muted', text: '' };
}

const ACTIVE = new Set(['awaiting_payment', 'awaiting_confirmation', 'confirmed']);

/** The client may cancel an unsettled or confirmed booking until it starts. */
export function canCancel(booking, nowMs) {
  return ACTIVE.has(booking.status) && Date.parse(booking.startsAt) > nowMs;
}

/** Calendar and Telegram links make sense while the visit is ahead. */
export function isUpcoming(booking, nowMs) {
  return ACTIVE.has(booking.status) && Date.parse(booking.endsAt ?? booking.startsAt) > nowMs;
}

/** Whether the QR / bank link should be shown: awaiting payment, a payment issued, the hold not over yet. */
export function paymentOpen(booking, nowMs) {
  if (booking.status !== 'awaiting_payment' || !booking.payment) return false;
  const until = Date.parse(booking.holdUntil ?? booking.payment.expiresAt ?? '');
  return Number.isNaN(until) || until > nowMs;
}

/**
 * Milliseconds until the page asks for the booking again, or null to stop: often while a payment is awaited,
 * a little longer right after the hold ends, rarely while staff confirm, never once it is settled.
 */
export function pollDelay(booking, nowMs) {
  if (booking.status === 'awaiting_confirmation') return POLL_CONFIRMATION_MS;
  if (booking.status !== 'awaiting_payment') return null;
  const until = Date.parse(booking.holdUntil ?? '');
  if (Number.isNaN(until) || nowMs < until) return POLL_PAYMENT_MS;
  return nowMs < until + AFTER_HOLD_GRACE_MS ? POLL_AFTER_HOLD_MS : null;
}

/** A line for the screen reader / haptics when the status changed while the page was open, else null. */
export function statusChangeMessage(previous, next) {
  if (!previous || previous === next) return null;
  if (previous === 'awaiting_payment' && next === 'confirmed') return 'Предоплата получена — запись подтверждена';
  if (previous === 'awaiting_payment' && next === 'cancelled') return 'Предоплата не поступила вовремя — запись отменена';
  if (next === 'confirmed') return 'Студия подтвердила запись';
  if (next === 'cancelled') return 'Запись отменена';
  return null;
}
