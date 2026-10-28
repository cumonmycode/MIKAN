// @ts-check
/** Pure URL helpers: the public API query strings, the booking body, preselection and the page routes. */
import { birthdayFromInput } from './birthday.js';

export const API_BASE = '/api/public/booking';
export const PAGE_BASE = '/book';

/**
 * The `items` parameter: `serviceId[:variant]` comma-separated, the variant URL-encoded so that commas and colons in
 * its name cannot break the list. The whole value is encoded once more as a query parameter by `buildUrl`.
 * @param {Array<{ serviceId: number, variant: string | null }>} items
 */
export function itemsParam(items) {
  return items
    .map((item) => (item.variant ? `${item.serviceId}:${encodeURIComponent(item.variant)}` : String(item.serviceId)))
    .join(',');
}

/** `path` + query from `params`, skipping null / undefined / '' values. */
export function buildUrl(path, params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    query.set(key, String(value));
  }
  const text = query.toString();
  return text ? `${path}?${text}` : path;
}

/** The chosen master as an id for the API: «any» (or nothing chosen yet) is omitted. */
export function masterParam(master) {
  return typeof master === 'number' ? master : null;
}

export function daysUrl({ from, to, items, master }) {
  return buildUrl(`${API_BASE}/days`, { from, to, items: itemsParam(items), masterId: masterParam(master) });
}

export function slotsUrl({ date, items, master }) {
  return buildUrl(`${API_BASE}/slots`, { date, items: itemsParam(items), masterId: masterParam(master) });
}

export function bookingUrl(token) {
  return `${API_BASE}/b/${encodeURIComponent(token)}`;
}

export function bookingPagePath(token) {
  return `${PAGE_BASE}/b/${encodeURIComponent(token)}`;
}

/**
 * The `POST /public/booking` body. A linked Telegram chat books for its client, so name and phone are left out. The
 * birthday goes as `YYYY-MM-DD` (1900 without the year) when the field was shown and filled in correctly.
 * @param {{ items: Array<{ serviceId: number, variant: string | null }>, master: number | 'any' | null,
 *   startsAt: string, name: string, phone: string | null, comment: string, website: string, linked: boolean,
 *   birthday?: string, askBirthday?: boolean }} input
 */
export function bookingBody(input) {
  /** @type {Record<string, unknown>} */
  const body = {
    items: input.items.map((item) => (item.variant ? { serviceId: item.serviceId, variant: item.variant } : { serviceId: item.serviceId })),
    startsAt: input.startsAt,
  };
  const masterId = masterParam(input.master);
  if (masterId !== null) body.masterId = masterId;
  if (!input.linked) {
    body.name = input.name.trim();
    body.phone = input.phone;
  }
  const comment = input.comment.trim();
  if (comment) body.comment = comment;
  const birthday = input.askBirthday ? birthdayFromInput(input.birthday ?? '').value : null;
  if (birthday) body.birthday = birthday;
  if (input.website) body.website = input.website;
  return body;
}

const positiveId = (value) => {
  if (value === null || !/^\d{1,9}$/.test(value)) return null;
  const n = Number(value);
  return n > 0 ? n : null;
};

/** `?service=<id>&master=<id>` → ids (null when absent or not a positive integer). */
export function parsePreselect(search) {
  const params = new URLSearchParams(search);
  return { serviceId: positiveId(params.get('service')), masterId: positiveId(params.get('master')) };
}

/** `/book/b/<token>` → the token, else null. */
export function bookingTokenFromPath(pathname) {
  const match = /^\/book\/b\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  try {
    const token = decodeURIComponent(match[1]);
    return token.length > 0 && token.length <= 200 ? token : null;
  } catch {
    return null;
  }
}

/** Only http(s) links (absolute or same-origin paths) are put into `href`. */
export function safeHref(url) {
  if (typeof url !== 'string' || url === '') return null;
  // «//host» and «/\host» leave the site, as browsers read the backslash as a slash.
  if (url.startsWith('/') && !/^\/[\\/]/.test(url)) return url;
  return /^https?:\/\//i.test(url) ? url : null;
}
