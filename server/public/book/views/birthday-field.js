// @ts-check
/** The optional «Дата рождения» field (contacts, the confirmation of a linked chat, the cabinet): «ДД.ММ.ГГГГ» mask. */
import { applyBirthdayInput, BIRTHDAY_PLACEHOLDER } from '../lib/birthday.js';
import { h } from '../lib/dom.js';

export const BIRTHDAY_HINT = 'Пришлём подарок в день рождения 🎁 Год можно не указывать';

/**
 * The masked input: digits only (the numeric keypad), the dots are put in as the client types.
 * @param {{ id: string, value: string, onValue: (value: string) => void, enterKey?: string }} options
 */
export function birthdayInput({ id, value, onValue, enterKey = 'next' }) {
  const input = /** @type {HTMLInputElement} */ (h('input', {
    id, name: 'bday', type: 'text', inputmode: 'numeric', autocomplete: 'bday', maxlength: '10',
    placeholder: BIRTHDAY_PLACEHOLDER, enterkeyhint: enterKey,
  }));
  input.value = value;
  let previous = value;
  input.addEventListener('input', (event) => {
    const caret = input.selectionStart ?? input.value.length;
    const inputType = /** @type {InputEvent} */ (event).inputType ?? '';
    const masked = applyBirthdayInput({ previous, raw: input.value, caret, inputType });
    input.value = masked.value;
    previous = masked.value;
    if (document.activeElement === input) input.setSelectionRange(masked.caret, masked.caret);
    onValue(masked.value);
  });
  return input;
}

/**
 * The field with its label («— необязательно»), hint and error line.
 * @param {{ id?: string, value: string, onValue: (value: string) => void, hint?: string, enterKey?: string }} options
 */
export function birthdayField({ id = 'birthday', value, onValue, hint = BIRTHDAY_HINT, enterKey }) {
  const input = birthdayInput({ id, value, onValue, enterKey });
  const error = h('p', { class: 'field-error', id: `${id}-error`, hidden: true });
  input.setAttribute('aria-describedby', `${id}-hint ${id}-error`);
  const node = h('div', { class: 'field' },
    h('label', { class: 'field-label', for: id }, 'Дата рождения', h('span', { class: 'optional' }, ' — необязательно')),
    input,
    h('p', { class: 'field-hint', id: `${id}-hint` }, hint),
    error);
  /** Shows `message`, or clears it with null. */
  function showError(message) {
    error.textContent = message ?? '';
    error.hidden = !message;
    if (message) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }
  return { node, input, error, showError };
}
