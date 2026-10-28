// @ts-check
/**
 * The full-screen gallery of masters' works: swipe (scroll snap), arrows and the keyboard. Pictures are loaded lazily,
 * only the current one and its neighbours. «Назад» on the phone, Escape and the Mini App's BackButton close it.
 */
import { describeError } from '../lib/api.js';
import { h, nextId } from '../lib/dom.js';
import { counterText, indexFromScroll, photoAlt, photoDetails, slidesToLoad, stepIndex } from '../lib/portfolio.js';
import { safeHref } from '../lib/query.js';

const ICON_PATHS = {
  close: 'M6 6l12 12M18 6L6 18',
  prev: 'M15 5l-7 7 7 7',
  next: 'M9 5l7 7-7 7',
};

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICON_PATHS[name]);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

/** How long an arrow's scroll may take before the scroll position decides the current photo again. */
const SETTLE_MS = 700;

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

function slide(item, index, total, showMaster) {
  const details = photoDetails(item, { showMaster });
  const img = /** @type {HTMLImageElement} */ (h('img', {
    class: 'gallery-img', alt: photoAlt(item, index, total), decoding: 'async', draggable: 'false',
  }));
  img.addEventListener('error', () => img.replaceWith(h('p', { class: 'gallery-broken' }, 'Не удалось загрузить фото')));
  const caption = details.caption || details.meta
    ? h('figcaption', { class: 'gallery-caption' },
      details.caption ? h('p', { class: 'gallery-caption-text' }, details.caption) : null,
      details.meta ? h('p', { class: 'gallery-meta' }, details.meta) : null)
    : null;
  const node = h('li', { class: 'gallery-slide', 'aria-roledescription': 'слайд', 'aria-label': counterText(index, total) },
    h('figure', { class: 'gallery-figure' }, h('div', { class: 'gallery-frame' }, img), caption));
  return { node, img, src: safeHref(item.imageUrl) };
}

/**
 * Opens the gallery and loads its photos.
 * @param {{ title: string, load: () => Promise<{ items: any[] }>, showMaster?: boolean,
 *   tg: { mainButton: { hide: () => void }, backButton: { show: (fn: () => void) => void } },
 *   onClosed?: () => void }} options
 */
export function openGallery({ title, load, showMaster = false, tg, onClosed }) {
  const titleId = nextId('gallery-title');
  const opener = /** @type {HTMLElement | null} */ (document.activeElement);
  const counter = h('p', { class: 'gallery-counter', 'aria-live': 'polite' });
  const body = h('div', { class: 'gallery-body' },
    h('div', { class: 'loading gallery-loading', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Загружаем фото…'));
  const closeButton = h('button', { type: 'button', class: 'gallery-icon-btn', 'aria-label': 'Закрыть', onClick: () => close() }, icon('close'));
  const dialog = /** @type {HTMLDialogElement} */ (h('dialog', { class: 'gallery', 'aria-labelledby': titleId },
    h('div', { class: 'gallery-top' },
      h('div', { class: 'gallery-heading' }, h('h2', { class: 'gallery-title', id: titleId }, title), counter),
      closeButton),
    body));

  /** @type {Array<{ node: HTMLElement, img: HTMLImageElement, src: string | null }>} */
  let slides = [];
  let index = 0;
  let closed = false;
  let pushed = false;
  let frame = 0;
  let width = 0;
  /** The photo an arrow or a key is scrolling to: the passing ones do not count while it scrolls. */
  /** @type {number | null} */ let pending = null;
  let settleTimer = 0;
  /** @type {HTMLElement | null} */ let track = null;
  /** @type {HTMLButtonElement | null} */ let prev = null;
  /** @type {HTMLButtonElement | null} */ let next = null;

  function show(at) {
    index = stepIndex(at, 0, slides.length);
    counter.textContent = slides.length > 1 ? counterText(index, slides.length) : '';
    for (const i of slidesToLoad(index, slides.length)) {
      const s = slides[i];
      if (s && s.src && !s.img.getAttribute('src')) s.img.src = s.src;
    }
    if (prev) prev.disabled = index === 0;
    if (next) next.disabled = index >= slides.length - 1;
    // An arrow that just got disabled would drop the keyboard focus out of the gallery.
    if (prev?.disabled && document.activeElement === prev) next?.focus();
    if (next?.disabled && document.activeElement === next) prev?.focus();
  }

  function goTo(at) {
    if (!track || slides.length === 0) return;
    const target = stepIndex(at, 0, slides.length);
    pending = target;
    clearTimeout(settleTimer);
    settleTimer = window.setTimeout(() => {
      pending = null;
    }, SETTLE_MS);
    track.scrollTo({ left: target * track.clientWidth, behavior: reducedMotion() ? 'auto' : 'smooth' });
    show(target);
  }

  function onScroll() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!track) return;
      if (pending !== null) {
        if (Math.abs(track.scrollLeft - pending * track.clientWidth) < 2) pending = null;
        return;
      }
      const at = indexFromScroll(track.scrollLeft, track.clientWidth, slides.length);
      if (at !== index) show(at);
    });
  }

  /** A new width (rotation) keeps the current photo in place; height changes (the browser's bars) change nothing. */
  function onResize() {
    if (!track || track.clientWidth === width) return;
    width = track.clientWidth;
    track.scrollLeft = index * width;
  }

  function onKey(event) {
    const moves = { ArrowLeft: -1, ArrowRight: 1, Home: -Infinity, End: Infinity };
    if (!(event.key in moves) || slides.length < 2) return;
    event.preventDefault();
    const delta = moves[event.key];
    goTo(Number.isFinite(delta) ? index + delta : delta < 0 ? 0 : slides.length - 1);
  }

  function renderItems(items) {
    if (items.length === 0) {
      body.replaceChildren(h('p', { class: 'gallery-empty' }, 'Пока нет фото работ'));
      return;
    }
    slides = items.map((item, i) => slide(item, i, items.length, showMaster));
    track = h('ul', { class: 'gallery-track', 'aria-label': 'Фото работ', onScroll }, slides.map((s) => s.node));
    const nav = items.length > 1;
    prev = nav ? /** @type {HTMLButtonElement} */ (h('button', {
      type: 'button', class: 'gallery-icon-btn gallery-nav gallery-prev', 'aria-label': 'Предыдущее фото', disabled: true,
      onClick: () => goTo(index - 1),
    }, icon('prev'))) : null;
    next = nav ? /** @type {HTMLButtonElement} */ (h('button', {
      type: 'button', class: 'gallery-icon-btn gallery-nav gallery-next', 'aria-label': 'Следующее фото', onClick: () => goTo(index + 1),
    }, icon('next'))) : null;
    body.replaceChildren(...[track, prev, next].filter((node) => node !== null));
    width = track.clientWidth;
    show(0);
  }

  async function fill() {
    try {
      const result = await load();
      if (!closed) renderItems(Array.isArray(result?.items) ? result.items : []);
    } catch (error) {
      if (closed) return;
      const description = describeError(error);
      body.replaceChildren(h('div', { class: 'gallery-empty' },
        h('p', null, description.message),
        h('button', { type: 'button', class: 'btn', onClick: () => {
          body.replaceChildren(h('div', { class: 'loading gallery-loading', role: 'status' },
            h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Загружаем фото…'));
          fill();
        } }, 'Попробовать ещё раз')));
    }
  }

  /** Closing for any reason: the dialog, the listeners, the page scroll lock and the Telegram buttons. */
  function teardown() {
    if (closed) return;
    closed = true;
    if (frame) cancelAnimationFrame(frame);
    clearTimeout(settleTimer);
    window.removeEventListener('popstate', onPopState);
    window.removeEventListener('resize', onResize);
    document.removeEventListener('keydown', onKey);
    if (dialog.open) dialog.close();
    dialog.remove();
    document.documentElement.classList.remove('gallery-open');
    onClosed?.();
    opener?.focus?.({ preventScroll: true });
  }

  function onPopState() {
    pushed = false;
    teardown();
  }

  /** Our own history entry goes too, so «Назад» afterwards leaves the step as usual. */
  function close() {
    if (closed) return;
    const ours = pushed && history.state?.gallery === titleId;
    teardown();
    if (ours) history.back();
  }

  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  document.addEventListener('keydown', onKey);
  document.body.append(dialog);
  document.documentElement.classList.add('gallery-open');
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  try {
    history.pushState({ ...(history.state ?? {}), gallery: titleId }, '');
    pushed = true;
  } catch {
    pushed = false;
  }
  window.addEventListener('popstate', onPopState);
  window.addEventListener('resize', onResize);
  tg.mainButton.hide();
  tg.backButton.show(close);
  closeButton.focus();
  fill();
  return { close };
}
