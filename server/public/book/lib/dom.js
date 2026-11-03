// @ts-check
/** A tiny DOM builder. Text always goes in as text nodes, never as HTML. */

/**
 * h('button', { class: 'primary', onClick: fn, 'aria-pressed': 'true' }, 'Дальше')
 * Props: `class`, `text`, `on<Event>` listeners, `dataset` object, boolean attributes (true → present,
 * false / null / undefined → absent), anything else as an attribute. Children: nodes, strings, numbers, arrays;
 * null / undefined / false are skipped.
 * @param {string} tag
 * @param {Record<string, any> | null} [props]
 * @param {...any} children
 * @returns {HTMLElement}
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = String(value);
    else if (key === 'text') el.textContent = String(value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  append(el, children);
  return el;
}

function append(parent, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(parent, child);
    else if (child instanceof Node) parent.append(child);
    else parent.append(document.createTextNode(String(child)));
  }
}

/** Replaces the content of `container` with `nodes`. */
export function mount(container, ...nodes) {
  container.replaceChildren();
  append(container, nodes);
}

/** A visually hidden span for screen readers. */
export function srOnly(text) {
  return h('span', { class: 'sr-only' }, text);
}

let uid = 0;
/** A unique element id with a readable prefix. */
export function nextId(prefix) {
  uid += 1;
  return `${prefix}-${uid}`;
}
