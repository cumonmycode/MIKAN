// @ts-check
/** Pure helpers of the masters' works (docs/API.md «Portfolio»): labels, API paths, gallery paging and photo texts. */
import { API_BASE, buildUrl } from './query.js';

/** Photos on each side of the current one that get their picture loaded. */
export const GALLERY_PRELOAD = 1;

/** «Работы (12)» on a master's card; null without works. */
export function worksLabel(count) {
  return typeof count === 'number' && count > 0 ? `Работы (${count})` : null;
}

/** What a screen reader hears on the master's works button. */
export function worksAriaLabel(masterName, count) {
  return `Работы мастера ${masterName}: ${count} фото`;
}

/** «Работы мастеров» on a service card; null without works. */
export function serviceWorksLabel(count) {
  return typeof count === 'number' && count > 0 ? 'Работы мастеров' : null;
}

export function masterPortfolioUrl(masterId) {
  return `${API_BASE}/masters/${encodeURIComponent(String(masterId))}/portfolio`;
}

export function servicePortfolioUrl(serviceId) {
  return buildUrl(`${API_BASE}/portfolio`, { serviceId });
}

/** The photo `delta` steps away, kept inside the list (no wrapping around). */
export function stepIndex(index, delta, total) {
  if (total <= 0) return 0;
  return Math.min(total - 1, Math.max(0, index + delta));
}

/** Indices whose pictures should be loaded around the current one. */
export function slidesToLoad(index, total, radius = GALLERY_PRELOAD) {
  const result = [];
  for (let i = Math.max(0, index - radius); i <= Math.min(total - 1, index + radius); i += 1) result.push(i);
  return result;
}

/** The photo a horizontally scrolled track rests on. */
export function indexFromScroll(scrollLeft, slideWidth, total) {
  if (!(slideWidth > 0) || total <= 0) return 0;
  return stepIndex(Math.round(scrollLeft / slideWidth), 0, total);
}

export function counterText(index, total) {
  return `${index + 1} из ${total}`;
}

const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

/**
 * The picture's `alt`: its caption, else what it shows and where it is in the gallery.
 * @param {{ caption?: string | null, service?: { name: string } | null, master?: { name: string } | null }} item
 */
export function photoAlt(item, index, total) {
  const caption = text(item.caption);
  if (caption) return caption;
  const position = `фото ${index + 1} из ${total}`;
  const master = text(item.master?.name);
  const service = text(item.service?.name);
  if (!master) return `Фото работы ${index + 1} из ${total}`;
  return service ? `Работа мастера ${master}: ${service}, ${position}` : `Работа мастера ${master}, ${position}`;
}

/**
 * The lines under a picture: its caption, and the service (with the master when works of several masters are shown).
 * @param {{ caption?: string | null, service?: { name: string } | null, master?: { name: string } | null }} item
 * @param {{ showMaster: boolean }} options
 */
export function photoDetails(item, { showMaster }) {
  const parts = [text(item.service?.name), showMaster && text(item.master?.name) ? `мастер ${text(item.master?.name)}` : null];
  const meta = parts.filter(Boolean).join(' · ');
  return { caption: text(item.caption), meta: meta || null };
}
