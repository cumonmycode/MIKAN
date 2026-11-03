// @ts-check
/**
 * Step 5: everything chosen, with «Изменить» links, the prepayment and cancellation rules, and the booking error. A
 * linked chat whose card has no birthday may add it here (its contacts step is skipped).
 */
import { birthdayFromInput, birthdayLabel } from '../lib/birthday.js';
import { h, mount } from '../lib/dom.js';
import { anyMasterLines, anyMasterPrice, contactErrors, selectedLines, totalDeposit, totalDuration } from '../lib/flow.js';
import { formatDateTime, formatDuration, formatRub, formatTime, totalPriceText } from '../lib/format.js';
import { birthdayField } from './birthday-field.js';
import { errorPanel, stepHeading, summaryRow } from './common.js';

/**
 * @param {{ state: any, catalog: Map<number, any>, masters: Array<{ id: number, name: string }>, config: any,
 *   me: { name: string, phone: string } | null, timeZone: string, today: string, edit: (step: string) => void,
 *   dispatch: (action: any) => void }} ctx
 */
export function renderConfirm(ctx) {
  const { state, catalog, config } = ctx;
  // A chosen master: their prices. «Any»: a line every master prices alike keeps its price, the total may be a range.
  const any = state.master === 'any';
  const lines = any ? anyMasterLines(state, catalog, ctx.masters) : selectedLines(state, catalog);
  const anyPrice = any ? anyMasterPrice(state, catalog, ctx.masters) : null;
  // «5 600–7 000 ₽» over a small «зависит от мастера» when the masters' totals differ.
  const total = anyPrice?.varies
    ? h('span', { class: 'total-price total-range' }, anyPrice.text, h('span', { class: 'total-note' }, 'зависит от мастера'))
    : h('span', { class: 'total-price' }, anyPrice ? anyPrice.text : totalPriceText(lines));
  const duration = totalDuration(lines);
  const deposit = totalDeposit(lines);
  const masterName = state.master === 'any'
    ? 'Любой свободный мастер'
    : ctx.masters.find((m) => m.id === state.master)?.name ?? 'Мастер';
  const startsAt = state.slot?.startsAt;
  const endsAt = startsAt ? new Date(Date.parse(startsAt) + duration * 60_000).toISOString() : null;
  const edit = (step, what) => ({ onClick: () => ctx.edit(step), ariaLabel: `Изменить ${what}` });

  const servicesValue = h('ul', { class: 'lines' }, lines.map((line) =>
    h('li', null, h('span', null, line.name), line.priceText ? h('span', { class: 'line-price' }, line.priceText) : null)));

  const contactsValue = state.linked
    ? h('span', null, [ctx.me?.name, ctx.me?.phone].filter(Boolean).join(', '), h('span', { class: 'muted' }, ' — из Telegram'))
    : h('span', null, `${state.name.trim()}, ${state.phone}`);
  const birthday = !state.linked && state.askBirthday ? birthdayFromInput(state.birthday ?? '').value : null;
  // A linked chat without a birthday: the optional field right under the summary.
  const linkedBirthday = state.linked && state.askBirthday
    ? birthdayField({
      id: 'confirm-birthday',
      value: state.birthday ?? '',
      enterKey: 'done',
      onValue: (value) => ctx.dispatch({ type: 'setField', field: 'birthday', value }),
    })
    : null;

  const card = h('div', { class: 'card summary' },
    summaryRow('Услуги', servicesValue, edit('services', 'услуги')),
    summaryRow('Мастер', masterName, edit('master', 'мастера')),
    summaryRow('Когда',
      startsAt ? `${formatDateTime(startsAt, ctx.timeZone)}–${formatTime(/** @type {string} */ (endsAt), ctx.timeZone)}` : '',
      edit('time', 'время')),
    summaryRow('Контакты', contactsValue, state.linked ? null : edit('contacts', 'контакты')),
    birthday ? summaryRow('Дата рождения', birthdayLabel(birthday), edit('contacts', 'дату рождения')) : null,
    state.comment.trim() ? summaryRow('Комментарий', state.comment.trim(), edit('contacts', 'комментарий')) : null,
    h('div', { class: 'summary-total' },
      h('span', null, `Итого · ${formatDuration(duration)}`),
      total));

  const notes = [
    deposit > 0
      ? h('div', { class: 'panel panel-accent' },
        h('p', { class: 'panel-title' }, `Предоплата ${formatRub(deposit)}`),
        h('p', { class: 'panel-text' }, 'Сразу после записи подскажем, как её внести. Она войдёт в стоимость, остальное — в студии.'))
      : h('p', { class: 'muted' }, 'Предоплата не нужна. Студия подтвердит запись в ближайшее время.'),
    config.note ? h('div', { class: 'panel' }, h('p', { class: 'panel-text' }, config.note)) : null,
    config.cancellationText ? h('p', { class: 'muted small' }, config.cancellationText) : null,
    h('p', { class: 'muted small' }, state.askBirthday
      ? 'Нажимая «Записаться», вы соглашаетесь, что студия обработает ваши имя, телефон и дату рождения, если вы её указали, для записи.'
      : 'Нажимая «Записаться», вы соглашаетесь, что студия обработает ваши имя и телефон для записи.'),
  ];

  const errorSlot = h('div', { class: 'error-slot' });
  const birthdayBlock = linkedBirthday ? h('div', { class: 'form confirm-birthday' }, linkedBirthday.node) : null;
  const node = h('section', { class: 'step' }, stepHeading('Проверьте запись'), errorSlot, card, birthdayBlock, notes);

  return {
    node,
    update(next) {
      // Clear the birthday error as soon as it is fixed.
      if (linkedBirthday && !contactErrors(next, ctx.today).birthday) linkedBirthday.showError(null);
    },
    /** The linked chat's birthday, if typed, must be a real one; returns whether the booking may go. */
    validate(next) {
      if (!linkedBirthday) return true;
      const message = contactErrors(next, ctx.today).birthday ?? null;
      linkedBirthday.showError(message);
      if (message) linkedBirthday.input.focus();
      return message === null;
    },
    /** @param {{ title: string, message: string }} description @param {Array<{ label: string, onClick: () => void, primary?: boolean }>} actions */
    showError(description, actions) {
      mount(errorSlot, errorPanel(description, actions));
      errorSlot.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    },
    clearError() {
      mount(errorSlot);
    },
  };
}
