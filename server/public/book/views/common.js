// @ts-check
/** Pieces shared by the views: step headings, loading and error blocks, studio contacts. */
import { h } from '../lib/dom.js';
import { safeHref } from '../lib/query.js';

/** The step heading; the controller focuses it when the step appears (screen readers read it). */
export function stepHeading(title, subtitle) {
  return h('div', { class: 'step-head' },
    h('h1', { class: 'step-title', tabindex: '-1' }, title),
    subtitle ? h('p', { class: 'step-sub' }, subtitle) : null);
}

export function loadingBlock(text = 'Загружаем…') {
  return h('div', { class: 'loading', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), text);
}

/** «+7 (999) 123-45-67» → «tel:+79991234567». */
function telHref(phone) {
  const digits = String(phone).replace(/[^\d+]/g, '');
  return digits.length >= 6 ? `tel:${digits}` : null;
}

/** The studio's phone and address, for screens where the client may want to call instead. */
export function studioContacts(studio) {
  if (!studio) return null;
  const phoneHref = studio.phone ? telHref(studio.phone) : null;
  const rows = [
    studio.address ? h('p', { class: 'contact-row' }, studio.address) : null,
    phoneHref ? h('p', { class: 'contact-row' }, h('a', { href: phoneHref }, studio.phone)) : null,
  ].filter(Boolean);
  return rows.length ? h('div', { class: 'contacts' }, rows) : null;
}

/**
 * An error box with the actions that make sense for it.
 * @param {{ title: string, message: string }} description
 * @param {Array<{ label: string, onClick: () => void, primary?: boolean }>} actions
 */
export function errorPanel(description, actions = []) {
  return h('div', { class: 'panel panel-error', role: 'alert' },
    h('p', { class: 'panel-title' }, description.title),
    h('p', { class: 'panel-text' }, description.message),
    actions.length
      ? h('div', { class: 'panel-actions' }, actions.map((action) =>
        h('button', { type: 'button', class: action.primary ? 'btn btn-primary' : 'btn', onClick: action.onClick }, action.label)))
      : null);
}

/** A full-page message (booking disabled, nothing found…). */
export function messagePage({ title, message, studio = null, actions = [] }) {
  return h('section', { class: 'step' },
    stepHeading(title),
    h('p', { class: 'lead' }, message),
    studioContacts(studio),
    actions.length
      ? h('div', { class: 'stack' }, actions.map((action) => linkOrButton(action)))
      : null);
}

/**
 * `{ label, href }` → a link styled as a button; `{ label, onClick }` → a button.
 * @param {{ label: string, href?: string, onClick?: (event: Event) => void, primary?: boolean, danger?: boolean }} options
 */
export function linkOrButton({ label, href, onClick, primary = false, danger = false }) {
  const cls = ['btn', primary ? 'btn-primary' : '', danger ? 'btn-danger' : ''].filter(Boolean).join(' ');
  const safe = href ? safeHref(href) : null;
  if (safe) return h('a', { class: cls, href: safe, onClick }, label);
  return h('button', { type: 'button', class: cls, onClick }, label);
}

/**
 * Asks a yes / no question in a modal dialog (the safe answer is focused first). Falls back to `window.confirm`
 * where `<dialog>` is not supported.
 * @returns {Promise<boolean>}
 */
export function confirmDialog({ title, text = '', confirmLabel, cancelLabel = 'Нет' }) {
  const probe = document.createElement('dialog');
  if (typeof probe.showModal !== 'function') {
    return Promise.resolve(window.confirm(text ? `${title}\n\n${text}` : title));
  }
  return new Promise((resolve) => {
    const finish = (answer) => {
      dialog.close();
      dialog.remove();
      resolve(answer);
    };
    const cancel = h('button', { type: 'button', class: 'btn', onClick: () => finish(false) }, cancelLabel);
    const confirm = h('button', { type: 'button', class: 'btn btn-danger', onClick: () => finish(true) }, confirmLabel);
    const dialog = /** @type {HTMLDialogElement} */ (h('dialog', { class: 'dialog', 'aria-labelledby': 'dialog-title' },
      h('h2', { class: 'dialog-title', id: 'dialog-title' }, title),
      text ? h('p', { class: 'dialog-text' }, text) : null,
      h('div', { class: 'dialog-actions' }, cancel, confirm)));
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      finish(false);
    });
    document.body.append(dialog);
    dialog.showModal();
    cancel.focus();
  });
}

/** A labelled value row inside a summary card. */
export function summaryRow(label, value, editAction) {
  return h('div', { class: 'summary-row' },
    h('div', { class: 'summary-label' }, label,
      editAction
        ? h('button', { type: 'button', class: 'link-btn', onClick: editAction.onClick, 'aria-label': editAction.ariaLabel }, 'Изменить')
        : null),
    h('div', { class: 'summary-value' }, value));
}
