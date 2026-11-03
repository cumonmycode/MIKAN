// @ts-check
/**
 * The booking page `/book/b/<token>`: status, the prepayment (QR, bank link, countdown, waiting for the bank),
 * details, calendar, Telegram notifications and cancellation.
 */
import { describeError } from '../lib/api.js';
import { canCancel, isUpcoming, paymentOpen, pollDelay, statusChangeMessage, statusInfo } from '../lib/booking.js';
import { h, mount } from '../lib/dom.js';
import { formatCountdown, formatRub, formatVisit, remainingMs } from '../lib/format.js';
import { encodeQr, qrSvg } from '../lib/qr.js';
import { PAGE_BASE, safeHref } from '../lib/query.js';
import { confirmDialog, errorPanel, linkOrButton, loadingBlock, messagePage, stepHeading, studioContacts, summaryRow } from './common.js';

const RETRY_POLL_MS = 15_000;

function qrFigure(payload) {
  try {
    const qr = encodeQr(payload, { level: 'M' });
    const figure = h('figure', { class: 'qr' });
    const box = h('div', { class: 'qr-code' });
    // The SVG holds only generated numbers and a fixed label, never user text.
    box.innerHTML = qrSvg(qr, { title: 'QR-код для оплаты через СБП' });
    figure.append(box, h('figcaption', null, 'Или отсканируйте QR-код камерой телефона или в приложении банка'));
    return figure;
  } catch {
    return null;
  }
}

/**
 * @param {{ api: any, tg: any, token: string, booking: any | null, timeZone: string, config: any | null,
 *   announce: (text: string) => void }} ctx
 */
export function renderBooking(ctx) {
  let booking = ctx.booking;
  let pollTimer = null;
  let tickTimer = null;
  let destroyed = false;
  let busy = false;
  let actionError = null;
  /** Bumped by the client's own change (cancel), so a poll started before it cannot undo it. */
  let generation = 0;
  const node = h('section', { class: 'step booking' });

  const now = () => Date.now();
  const serverNow = () => now() + ctx.api.clockOffset();

  function stopTimers() {
    if (pollTimer) clearTimeout(pollTimer);
    if (tickTimer) clearInterval(tickTimer);
    pollTimer = null;
    tickTimer = null;
  }

  function schedulePoll(delay = pollDelay(booking, serverNow())) {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    if (destroyed || delay === null || document.hidden) return;
    pollTimer = setTimeout(poll, delay);
  }

  async function poll() {
    pollTimer = null;
    const asked = generation;
    try {
      const fresh = await ctx.api.booking(ctx.token);
      // A cancellation answered meanwhile is newer than this reply.
      if (destroyed || asked !== generation) return;
      // Re-render only on a change, so focus and the QR code stay put while nothing happens.
      if (JSON.stringify(fresh) === JSON.stringify(booking)) {
        // Once the page stops asking, show «Обновить» instead of «Проверяем…».
        if (pollDelay(booking, serverNow()) === null) render();
        else schedulePoll();
        return;
      }
      const message = statusChangeMessage(booking.status, fresh.status);
      booking = fresh;
      if (message) {
        ctx.announce(message);
        ctx.tg.haptic(fresh.status === 'confirmed' ? 'success' : 'warning');
      }
      render();
    } catch {
      if (!destroyed) schedulePoll(RETRY_POLL_MS);
    }
  }

  function onVisibility() {
    if (document.hidden) {
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = null;
    } else if (booking && pollDelay(booking, serverNow()) !== null) {
      poll();
    }
  }
  document.addEventListener('visibilitychange', onVisibility);

  function paymentBlock() {
    const payment = booking.payment;
    const link = safeHref(payment.payload);
    const hasDeadline = !Number.isNaN(Date.parse(booking.holdUntil ?? ''));
    const timer = h('strong', null, formatCountdown(remainingMs(booking.holdUntil, now(), ctx.api.clockOffset())));
    if (hasDeadline) {
      tickTimer = setInterval(() => {
        const left = remainingMs(booking.holdUntil, now(), ctx.api.clockOffset());
        timer.textContent = formatCountdown(left);
        if (left <= 0) {
          clearInterval(tickTimer);
          tickTimer = null;
          render();
        }
      }, 1000);
    }
    return h('div', { class: 'card pay' },
      h('p', { class: 'pay-amount' }, `Предоплата ${formatRub(payment.amount)}`),
      hasDeadline ? h('p', { class: 'pay-timer', role: 'timer', 'aria-live': 'off' }, 'Время за вами ещё ', timer) : null,
      link ? h('a', { class: 'btn btn-primary pay-link', href: link, target: '_blank', rel: 'noopener noreferrer', onClick: openExternal(link) }, 'Открыть приложение банка') : null,
      link ? qrFigure(link) : null,
      h('p', { class: 'muted small pay-note' }, 'Оплата через СБП. Страница обновится сама, как только деньги поступят.'));
  }

  function holdOverBlock() {
    const waiting = pollDelay(booking, serverNow()) !== null;
    return h('div', { class: 'panel panel-accent' },
      h('p', { class: 'panel-title' }, 'Время на оплату вышло'),
      h('p', { class: 'panel-text' }, waiting
        ? 'Проверяем, не поступила ли оплата… Если вы уже заплатили, мы увидим платёж — ничего делать не нужно.'
        : 'Оплату пока не видно. Обновите страницу чуть позже или позвоните в студию.'),
      waiting ? null : h('div', { class: 'panel-actions' }, h('button', { type: 'button', class: 'btn', onClick: () => poll() }, 'Обновить')));
  }

  /** Inside Telegram an external link opens through Telegram, otherwise the browser follows it. */
  function openExternal(url) {
    return (event) => {
      if (!ctx.tg.inTelegram) return;
      event.preventDefault();
      ctx.tg.openLink(url);
    };
  }

  async function cancelBooking() {
    const question = 'Отменить запись?';
    const details = ctx.config?.cancellationText ?? '';
    let ok = await ctx.tg.confirm(details ? `${question}\n\n${details}` : question);
    if (ok === null) ok = await confirmDialog({ title: question, text: details, confirmLabel: 'Да, отменить', cancelLabel: 'Нет' });
    if (!ok || busy) return;
    busy = true;
    actionError = null;
    render();
    try {
      booking = await ctx.api.cancel(ctx.token);
      generation += 1;
      ctx.announce('Запись отменена');
    } catch (error) {
      actionError = describeError(error);
    } finally {
      busy = false;
      render();
    }
  }

  function actions() {
    const t = serverNow();
    const calendar = safeHref(booking.calendarUrl);
    const telegram = safeHref(booking.telegramLink);
    const list = [];
    if (calendar && isUpcoming(booking, t)) {
      list.push(linkOrButton({ label: 'Добавить в календарь', href: calendar, onClick: openExternal(calendar) }));
    }
    if (telegram && !ctx.tg.inTelegram && isUpcoming(booking, t)) {
      const link = linkOrButton({ label: 'Получать уведомления в Telegram', href: telegram });
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
      list.push(link);
    }
    if (canCancel(booking, t)) {
      const button = linkOrButton({ label: busy ? 'Отменяем…' : 'Отменить запись', onClick: cancelBooking, danger: true });
      if (busy) button.setAttribute('disabled', '');
      list.push(button);
    }
    list.push(h('a', { class: 'btn btn-quiet', href: PAGE_BASE }, 'Записаться ещё'));
    return h('div', { class: 'stack' }, list);
  }

  function details() {
    const items = booking.items ?? [];
    return h('div', { class: 'card summary' },
      summaryRow('Когда', formatVisit(booking.startsAt, booking.endsAt, ctx.timeZone)),
      booking.master?.name ? summaryRow('Мастер', booking.master.name) : null,
      summaryRow('Услуги', h('ul', { class: 'lines' }, items.map((item) =>
        h('li', null, h('span', null, item.name), h('span', { class: 'line-price' }, formatRub(item.price)))))),
      booking.depositRequired > 0 ? summaryRow('Предоплата', formatRub(booking.depositRequired)) : null,
      h('div', { class: 'summary-total' }, h('span', null, 'Стоимость'), h('span', { class: 'total-price' }, formatRub(booking.price))),
      booking.studio ? h('div', { class: 'summary-row' },
        h('div', { class: 'summary-label' }, booking.studio.name || 'Студия'),
        studioContacts(booking.studio)) : null);
  }

  function updateMainButton() {
    if (!ctx.tg.inTelegram) return;
    const link = booking.payment ? safeHref(booking.payment.payload) : null;
    if (link && paymentOpen(booking, serverNow())) {
      ctx.tg.mainButton.set({ text: `Оплатить ${formatRub(booking.payment.amount)}`, onClick: () => ctx.tg.openLink(link) });
    } else {
      ctx.tg.mainButton.set({ text: 'Готово', onClick: () => ctx.tg.close() });
    }
  }

  function render() {
    if (destroyed) return;
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
    const t = serverNow();
    const info = statusInfo(booking.status);
    const holdOver = booking.status === 'awaiting_payment' && !paymentOpen(booking, t);
    mount(node,
      stepHeading(booking.number ? `Запись №${booking.number}` : 'Ваша запись'),
      h('p', { class: `status status-${info.tone}` }, info.label),
      info.text && !holdOver ? h('p', { class: 'lead' }, info.text) : null,
      actionError ? errorPanel(actionError, [{ label: 'Закрыть', onClick: () => { actionError = null; render(); } }]) : null,
      paymentOpen(booking, t) ? paymentBlock() : null,
      holdOver ? holdOverBlock() : null,
      details(),
      actions());
    updateMainButton();
    schedulePoll();
  }

  async function load() {
    mount(node, loadingBlock('Загружаем запись…'));
    try {
      booking = await ctx.api.booking(ctx.token);
    } catch (error) {
      if (destroyed) return;
      const description = describeError(error);
      mount(node, messagePage({
        title: description.title,
        message: description.message,
        actions: description.action === 'retry'
          ? [{ label: 'Попробовать ещё раз', onClick: load, primary: true }, { label: 'Записаться', href: PAGE_BASE }]
          : [{ label: 'Записаться', href: PAGE_BASE, primary: true }],
      }));
      return;
    }
    render();
  }

  if (booking) render();
  else load();

  return {
    node,
    destroy() {
      destroyed = true;
      stopTimers();
      document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
