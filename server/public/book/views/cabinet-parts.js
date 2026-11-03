// @ts-check
/** The cabinet's cards: an appointment, a past visit, a waitlist entry, a bonus operation, a certificate, a memo. */
import {
  appointmentStatus, appointmentTitle, bonusOperationLabel, dayMonth, freeCancellationLine, memoSteps, shortDate,
  signedAmount, stepDayLabel, waitlistSummary,
} from '../lib/cabinet.js';
import { h } from '../lib/dom.js';
import { dateIn, formatDateTime, formatRub, formatVisit } from '../lib/format.js';
import { bookingPagePath } from '../lib/query.js';

/**
 * An upcoming appointment with what the client may do.
 * @param {any} a `CabinetAppointment`
 * @param {{ timeZone: string, now: number, busy: boolean, onReschedule: (a: any) => void, onCancel: (a: any) => void }} ctx
 */
export function upcomingCard(a, ctx) {
  const status = appointmentStatus(a, ctx.now);
  const facts = [a.master?.name ? `Мастер ${a.master.name}` : null, a.price > 0 ? formatRub(a.price) : null].filter(Boolean).join(' · ');
  const deposit = a.deposit > 0
    ? `Предоплата ${formatRub(a.deposit)} внесена`
    : a.depositRequired > 0 ? `Предоплата ${formatRub(a.depositRequired)}` : null;
  const free = freeCancellationLine(a, ctx.now, ctx.timeZone);
  const page = a.bookingToken ? bookingPagePath(a.bookingToken) : null;
  const actions = [
    a.canReschedule
      ? h('button', { type: 'button', class: 'btn', disabled: ctx.busy, onClick: () => ctx.onReschedule(a) }, 'Перенести')
      : null,
    a.canCancel
      ? h('button', { type: 'button', class: 'btn btn-danger', disabled: ctx.busy, onClick: () => ctx.onCancel(a) }, ctx.busy ? 'Отменяем…' : 'Отменить')
      : null,
    page && a.onlineState === 'awaiting_payment'
      ? h('a', { class: 'btn btn-primary cab-wide', href: page }, 'Оплатить предоплату')
      : page ? h('a', { class: 'btn btn-quiet cab-wide', href: page }, 'Страница записи') : null,
  ].filter(Boolean);
  return h('article', { class: 'card cab-visit', 'aria-label': formatDateTime(a.startsAt, ctx.timeZone) },
    h('div', { class: 'cab-visit-head' },
      h('p', { class: 'cab-when' }, formatVisit(a.startsAt, a.endsAt, ctx.timeZone)),
      h('span', { class: `status status-${status.tone} cab-status` }, status.label)),
    h('p', { class: 'cab-what' }, appointmentTitle(a)),
    facts ? h('p', { class: 'muted small cab-line' }, facts) : null,
    deposit ? h('p', { class: 'muted small cab-line' }, deposit) : null,
    free ? h('p', { class: 'small cab-line cab-free' }, free) : null,
    actions.length ? h('div', { class: 'cab-actions' }, actions) : null);
}

/** A row of the history. */
export function pastRow(a, timeZone, now) {
  const status = appointmentStatus(a, now);
  return h('li', { class: 'cab-row' },
    h('div', { class: 'cab-row-main' },
      h('p', { class: 'cab-row-title' }, appointmentTitle(a)),
      h('p', { class: 'muted small' }, [formatDateTime(a.startsAt, timeZone), a.master?.name].filter(Boolean).join(' · '))),
    h('span', { class: `cab-row-side small${status.tone === 'muted' ? ' muted' : ''}` }, status.label));
}

/** @param {any} entry `WaitlistEntryPublic` @param {{ busy: boolean, onLeave: (entry: any) => void }} ctx */
export function waitlistCard(entry, ctx) {
  const summary = waitlistSummary(entry);
  return h('article', { class: 'card cab-visit' },
    h('p', { class: 'cab-what' }, summary.title),
    h('p', { class: 'muted small cab-line' }, summary.details),
    summary.notice ? h('p', { class: 'small cab-line cab-free' }, summary.notice) : null,
    entry.note ? h('p', { class: 'muted small cab-line' }, entry.note) : null,
    h('div', { class: 'cab-actions' },
      h('button', { type: 'button', class: 'btn btn-danger', disabled: ctx.busy, onClick: () => ctx.onLeave(entry) },
        ctx.busy ? 'Убираем…' : 'Не ждать')));
}

/** @param {any} op `{ type, amount, expiresAt, createdAt, note }` */
export function bonusRow(op, timeZone, today) {
  const credit = op.amount > 0;
  const until = credit && op.expiresAt ? `до ${shortDate(dateIn(new Date(Date.parse(op.expiresAt) - 1).toISOString(), timeZone), today)}` : null;
  return h('li', { class: 'cab-row' },
    h('div', { class: 'cab-row-main' },
      h('p', { class: 'cab-row-title' }, bonusOperationLabel(op)),
      h('p', { class: 'muted small' }, [shortDate(dateIn(op.createdAt, timeZone), today), until, op.note].filter(Boolean).join(' · '))),
    h('span', { class: `cab-row-side cab-amount${credit ? ' cab-plus' : ''}` }, signedAmount(op.amount)));
}

/** @param {{ code: string, balance: number, expiresAt: string | null }} c */
export function certificateCard(c, timeZone, today) {
  return h('article', { class: 'card cab-cert' },
    h('p', { class: 'cab-cert-code' }, c.code),
    h('p', { class: 'cab-cert-balance' }, `Осталось ${formatRub(c.balance)}`),
    h('p', { class: 'muted small' }, c.expiresAt ? `Действует до ${shortDate(dateIn(c.expiresAt, timeZone), today)}` : 'Бессрочный'));
}

/** @param {{ appointmentId: number, date: string, title: string, steps: Array<{ day: number, text: string }> }} memo */
export function memoCard(memo, today) {
  return h('article', { class: 'card cab-memo' },
    h('p', { class: 'cab-what' }, memo.title),
    h('p', { class: 'muted small cab-line' }, `Визит ${dayMonth(memo.date)}`),
    h('ol', { class: 'cab-steps' }, memoSteps(memo, today).map((step) => h('li', { class: `cab-step${step.today ? ' cab-step-today' : ''}` },
      h('p', { class: 'cab-step-day small' }, stepDayLabel(step.day), ` · ${dayMonth(step.date)}`, step.today ? h('span', { class: 'cab-today' }, 'Сегодня') : null),
      h('p', { class: 'cab-step-text' }, step.text)))));
}
