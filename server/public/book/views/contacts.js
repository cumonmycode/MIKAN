// @ts-check
/** Step 4: name, phone (+7 mask), the optional birthday and comment. Skipped for a linked Telegram chat. */
import { h } from '../lib/dom.js';
import { COMMENT_MAX, NAME_MAX, contactErrors } from '../lib/flow.js';
import { applyPhoneInput } from '../lib/phone.js';
import { birthdayField } from './birthday-field.js';
import { stepHeading } from './common.js';

/** @param {{ id: string, label: string, optional?: boolean, input: HTMLElement, hint?: string }} options */
function field({ id, label, optional = false, input, hint }) {
  const error = h('p', { class: 'field-error', id: `${id}-error`, hidden: true });
  const hintNode = hint ? h('p', { class: 'field-hint', id: `${id}-hint` }, hint) : null;
  input.setAttribute('aria-describedby', [hintNode ? `${id}-hint` : '', `${id}-error`].filter(Boolean).join(' '));
  const node = h('div', { class: 'field' },
    h('label', { class: 'field-label', for: id }, label, optional ? h('span', { class: 'optional' }, ' — необязательно') : null),
    input,
    hintNode,
    error);
  return { node, input, error };
}

/**
 * @param {{ state: any, dispatch: (action: any) => void, onSubmit: () => void, today: string }} ctx
 *   `today` — the studio's date, so a birthday in the future is caught here.
 */
export function renderContacts(ctx) {
  const name = field({
    id: 'name',
    label: 'Имя',
    input: h('input', {
      id: 'name', name: 'name', type: 'text', autocomplete: 'name', maxlength: String(NAME_MAX), required: true,
      autocapitalize: 'words', enterkeyhint: 'next',
      onInput: (event) => ctx.dispatch({ type: 'setField', field: 'name', value: event.target.value }),
    }),
  });
  const phoneInput = /** @type {HTMLInputElement} */ (h('input', {
    id: 'phone', name: 'phone', type: 'tel', inputmode: 'tel', autocomplete: 'tel', required: true,
    placeholder: '+7 (999) 123-45-67', enterkeyhint: 'next',
  }));
  let previousPhone = '';
  phoneInput.addEventListener('input', (event) => {
    const caret = phoneInput.selectionStart ?? phoneInput.value.length;
    const inputType = /** @type {InputEvent} */ (event).inputType ?? '';
    const masked = applyPhoneInput({ previous: previousPhone, raw: phoneInput.value, caret, inputType });
    phoneInput.value = masked.value;
    previousPhone = masked.value;
    if (document.activeElement === phoneInput) phoneInput.setSelectionRange(masked.caret, masked.caret);
    ctx.dispatch({ type: 'setField', field: 'phone', value: masked.value });
  });
  const phone = field({
    id: 'phone',
    label: 'Телефон',
    input: phoneInput,
    hint: 'Позвоним или напишем, только если что-то изменится',
  });
  const birthday = birthdayField({
    value: ctx.state.birthday ?? '',
    onValue: (value) => ctx.dispatch({ type: 'setField', field: 'birthday', value }),
  });
  const comment = field({
    id: 'comment',
    label: 'Комментарий',
    optional: true,
    input: h('textarea', {
      id: 'comment', name: 'comment', rows: '3', maxlength: String(COMMENT_MAX),
      placeholder: 'Например: хочу украшение из титана',
      onInput: (event) => ctx.dispatch({ type: 'setField', field: 'comment', value: event.target.value }),
    }),
  });
  // Honeypot for bots: hidden from people and screen readers, never filled by a person.
  const website = h('div', { class: 'hp', 'aria-hidden': 'true' },
    h('label', null, 'Сайт', h('input', {
      name: 'website', type: 'text', tabindex: '-1', autocomplete: 'off',
      onInput: (event) => ctx.dispatch({ type: 'setField', field: 'website', value: event.target.value }),
    })));

  const form = h('form', {
    class: 'form', novalidate: true,
    onSubmit: (event) => {
      event.preventDefault();
      ctx.onSubmit();
    },
  }, name.node, phone.node, birthday.node, comment.node, website,
  // Lets «Enter» / «Go» on the keyboard submit the form.
  h('button', { type: 'submit', class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true' }, 'Дальше'));

  const node = h('section', { class: 'step' }, stepHeading('Ваши контакты', 'Чтобы студия могла связаться с вами'), form);

  // Restore what was typed before (coming back from the confirmation).
  /** @type {HTMLInputElement} */ (name.input).value = ctx.state.name;
  phoneInput.value = ctx.state.phone;
  previousPhone = ctx.state.phone;
  /** @type {HTMLTextAreaElement} */ (comment.input).value = ctx.state.comment;

  const fields = /** @type {const} */ ([['name', name], ['phone', phone], ['birthday', birthday]]);

  /** Shows what is wrong and focuses the first wrong field; returns whether everything is fine. */
  function validate(state) {
    const errors = contactErrors(state, ctx.today);
    let first = null;
    for (const [key, f] of fields) {
      const message = errors[key];
      f.error.textContent = message ?? '';
      f.error.hidden = !message;
      if (message) f.input.setAttribute('aria-invalid', 'true');
      else f.input.removeAttribute('aria-invalid');
      if (message && !first) first = f.input;
    }
    if (first) first.focus();
    return first === null;
  }

  function update(state) {
    // Clear an error as soon as the field becomes valid.
    const errors = contactErrors(state, ctx.today);
    for (const [key, f] of fields) {
      if (!errors[key] && !f.error.hidden) {
        f.error.hidden = true;
        f.input.removeAttribute('aria-invalid');
      }
    }
  }

  return { node, update, validate };
}
