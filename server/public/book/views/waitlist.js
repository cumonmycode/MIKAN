// @ts-check
/**
 * «Встать в лист ожидания» from the time step: the date range, a note and (unless the Telegram chat is linked) name and
 * phone; then «Вы в листе ожидания ✅» with, on the website, the bot link that delivers the freed-time message.
 */
import { describeError } from '../lib/api.js';
import { h, mount } from '../lib/dom.js';
import { contactErrors, NAME_MAX, selectedLines } from '../lib/flow.js';
import { applyPhoneInput, toE164 } from '../lib/phone.js';
import { safeHref } from '../lib/query.js';
import { formatRange, NOTE_MAX, rangeError, waitlistBody } from '../lib/waitlist.js';
import { errorPanel, linkOrButton, stepHeading, summaryRow } from './common.js';

/**
 * @param {{ state: any, catalog: Map<number, any>, masters: Array<{ id: number, name: string }>,
 *   preset: { from: string, to: string }, today: string, lastDate: string, api: any, tg: any,
 *   onJoined: (entry: any) => void, onBack: () => void }} ctx
 */
export function renderWaitlist(ctx) {
  const { state } = ctx;
  const lines = selectedLines(state, ctx.catalog);
  const masterName = typeof state.master === 'number'
    ? ctx.masters.find((m) => m.id === state.master)?.name ?? 'Мастер'
    : 'Любой мастер';
  const form = { from: ctx.preset.from, to: ctx.preset.to, note: '', name: state.name, phone: state.phone, website: '' };
  let sending = false;

  const dateInput = (id, value, key) => /** @type {HTMLInputElement} */ (h('input', {
    id, type: 'date', value, min: ctx.today, max: ctx.lastDate, required: true,
    onChange: (event) => {
      form[key] = event.target.value;
      showRangeHint();
    },
  }));
  const fromInput = dateInput('wl-from', form.from, 'from');
  const toInput = dateInput('wl-to', form.to, 'to');
  const rangeHint = h('p', { class: 'field-hint', id: 'wl-range-hint', 'aria-live': 'polite' });
  const rangeErrorNode = h('p', { class: 'field-error', id: 'wl-range-error', hidden: true });

  function showRangeHint() {
    const problem = rangeError({ ...form, today: ctx.today, lastDate: ctx.lastDate });
    rangeHint.textContent = problem ? '' : `Ждём свободное время ${formatRange(form.from, form.to)}`;
    if (!problem && !rangeErrorNode.hidden) rangeErrorNode.hidden = true;
  }

  const contactNodes = [];
  /** @type {HTMLInputElement | null} */ let nameInput = null;
  /** @type {HTMLInputElement | null} */ let phoneInput = null;
  const nameError = h('p', { class: 'field-error', id: 'wl-name-error', hidden: true });
  const phoneError = h('p', { class: 'field-error', id: 'wl-phone-error', hidden: true });
  if (!state.linked) {
    nameInput = /** @type {HTMLInputElement} */ (h('input', {
      id: 'wl-name', type: 'text', autocomplete: 'name', maxlength: String(NAME_MAX), value: form.name,
      'aria-describedby': 'wl-name-error', onInput: (event) => { form.name = event.target.value; },
    }));
    phoneInput = /** @type {HTMLInputElement} */ (h('input', {
      id: 'wl-phone', type: 'tel', inputmode: 'tel', autocomplete: 'tel', placeholder: '+7 (999) 123-45-67', value: form.phone,
      'aria-describedby': 'wl-phone-error',
    }));
    let previous = form.phone;
    const phone = phoneInput;
    phone.addEventListener('input', (event) => {
      const caret = phone.selectionStart ?? phone.value.length;
      const masked = applyPhoneInput({ previous, raw: phone.value, caret, inputType: /** @type {InputEvent} */ (event).inputType ?? '' });
      phone.value = masked.value;
      previous = masked.value;
      form.phone = masked.value;
      if (document.activeElement === phone) phone.setSelectionRange(masked.caret, masked.caret);
    });
    contactNodes.push(
      h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'wl-name' }, 'Имя'), nameInput, nameError),
      h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'wl-phone' }, 'Телефон'), phoneInput, phoneError),
    );
  }

  const note = h('textarea', {
    id: 'wl-note', rows: '2', maxlength: String(NOTE_MAX), placeholder: 'Например: только после 18:00',
    onInput: (event) => { form.note = event.target.value; },
  });
  // Honeypot for bots, as on the contacts step.
  const website = h('div', { class: 'hp', 'aria-hidden': 'true' },
    h('label', null, 'Сайт', h('input', { name: 'website', type: 'text', tabindex: '-1', autocomplete: 'off', onInput: (event) => { form.website = event.target.value; } })));

  const submitButton = /** @type {HTMLButtonElement} */ (h('button', { type: 'submit', class: 'btn btn-primary' }, 'Встать в лист ожидания'));
  const errorSlot = h('div', { class: 'error-slot' });

  const card = h('div', { class: 'card summary' },
    summaryRow('Услуги', lines.map((line) => line.name).join(', ')),
    summaryRow('Мастер', masterName));

  const formNode = h('form', { class: 'form', novalidate: true, onSubmit: (event) => { event.preventDefault(); submit(); } },
    h('div', { class: 'field' },
      h('span', { class: 'field-label', id: 'wl-dates' }, 'Подходящие даты'),
      h('div', { class: 'date-range', role: 'group', 'aria-labelledby': 'wl-dates' },
        h('label', { class: 'date-field' }, h('span', { class: 'muted small' }, 'с'), fromInput),
        h('label', { class: 'date-field' }, h('span', { class: 'muted small' }, 'по'), toInput)),
      rangeHint, rangeErrorNode),
    contactNodes,
    h('div', { class: 'field' },
      h('label', { class: 'field-label', for: 'wl-note' }, 'Пожелания', h('span', { class: 'optional' }, ' — необязательно')),
      note),
    website,
    errorSlot,
    h('div', { class: 'stack' }, submitButton, h('button', { type: 'button', class: 'btn btn-quiet', onClick: ctx.onBack }, 'Вернуться к выбору времени')));

  const node = h('section', { class: 'step' },
    stepHeading('Лист ожидания', 'Если время освободится, мы напишем. Кто запишется первым, тому и время.'),
    card, formNode);
  showRangeHint();

  /** Shows what is wrong and focuses it; true when the form can be sent. */
  function validate() {
    const problem = rangeError({ ...form, today: ctx.today, lastDate: ctx.lastDate });
    rangeErrorNode.textContent = problem ?? '';
    rangeErrorNode.hidden = !problem;
    if (problem) {
      fromInput.focus();
      return false;
    }
    if (state.linked) return true;
    const errors = contactErrors({ name: form.name, phone: form.phone });
    const pairs = /** @type {const} */ ([[nameInput, nameError, errors.name], [phoneInput, phoneError, errors.phone]]);
    let first = null;
    for (const [input, errorNode, message] of pairs) {
      errorNode.textContent = message ?? '';
      errorNode.hidden = !message;
      if (message) input?.setAttribute('aria-invalid', 'true');
      else input?.removeAttribute('aria-invalid');
      if (message && !first) first = input;
    }
    first?.focus();
    return first === null;
  }

  async function submit() {
    if (sending || !validate()) return;
    sending = true;
    submitButton.disabled = true;
    submitButton.textContent = 'Отправляем…';
    mount(errorSlot);
    const body = waitlistBody({
      items: state.items, master: state.master, from: form.from, to: form.to, note: form.note,
      name: form.name, phone: state.linked ? null : toE164(form.phone), website: form.website, linked: state.linked,
    });
    try {
      const entry = await ctx.api.joinWaitlist(body);
      ctx.tg.haptic('success');
      ctx.onJoined(entry);
    } catch (error) {
      sending = false;
      submitButton.disabled = false;
      submitButton.textContent = 'Встать в лист ожидания';
      ctx.tg.haptic('error');
      mount(errorSlot, errorPanel(describeError(error)));
      errorSlot.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    }
  }

  return { node };
}

/**
 * «Вы в листе ожидания ✅»: what was wished and how the message comes — in this chat (Telegram) or through the bot
 * link (website).
 * @param {{ entry: any, linked: boolean, tg: any, onAgain: () => void }} ctx
 */
export function renderWaitlistDone(ctx) {
  const { entry } = ctx;
  const what = (entry.items ?? []).map((item) => (item.variant ? `${item.name} — ${item.variant}` : item.name)).join(', ');
  const telegram = safeHref(entry.telegramLink);
  let how;
  if (ctx.tg.inTelegram) {
    how = ctx.linked
      ? 'Как только время освободится, мы напишем вам в этот чат с кнопкой записи. Кто запишется первым, тому и время.'
      : 'Сообщение о свободном времени придёт в чат со студией — поделитесь там номером кнопкой «📱 Поделиться номером».';
  } else {
    how = telegram
      ? 'Сообщение о свободном времени приходит в Telegram. Откройте бота студии и поделитесь номером — так мы сможем вам написать.'
      : 'Если время освободится, студия свяжется с вами.';
  }
  const actions = [];
  if (telegram && !ctx.tg.inTelegram) {
    const link = linkOrButton({ label: 'Получить сообщение в Telegram', href: telegram, primary: true });
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener noreferrer');
    actions.push(link);
  }
  actions.push(linkOrButton({ label: 'Выбрать другое время', onClick: ctx.onAgain }));
  const node = h('section', { class: 'step' },
    stepHeading('Вы в листе ожидания ✅'),
    h('div', { class: 'card summary' },
      summaryRow('Услуги', what),
      summaryRow('Мастер', entry.master?.name ?? 'Любой мастер'),
      summaryRow('Даты', formatRange(entry.dateFrom, entry.dateTo))),
    h('p', { class: 'lead' }, how),
    h('div', { class: 'stack' }, actions));
  return { node };
}
