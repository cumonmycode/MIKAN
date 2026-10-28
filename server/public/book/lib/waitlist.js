// @ts-check
/**
 * The waitlist on the booking page, pure parts: the date range of a wish and its checks, the join body, the freed-time
 * link `?wait=<id>&start=<iso>&items=<items>&master=<id>` and how it preselects the flow.
 */
import { firstIncompleteStep, reduce, stepsFor } from './flow.js';
import { addDays, dateIn, daysBetween, formatDayLong } from './format.js';
import { masterParam } from './query.js';

export const MAX_RANGE_DAYS = 30;
export const NOTE_MAX = 500;
/** The range offered when the whole strip is busy: the next two weeks. */
export const DEFAULT_RANGE_DAYS = 14;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The range the form starts with: the busy day itself, else the next two weeks (never past the last bookable date).
 * @param {{ today: string, lastDate: string, date?: string | null }} q
 * @returns {{ from: string, to: string }}
 */
export function presetRange({ today, lastDate, date = null }) {
  if (date && date >= today && date <= lastDate) return { from: date, to: date };
  const to = addDays(today, DEFAULT_RANGE_DAYS - 1);
  return { from: today, to: to > lastDate ? lastDate : to };
}

/**
 * Why the range cannot be sent, or null. The server checks the same.
 * @param {{ from: string, to: string, today: string, lastDate: string }} q
 */
export function rangeError({ from, to, today, lastDate }) {
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) return 'Выберите даты';
  if (from < today) return 'Начало — не раньше сегодняшнего дня';
  if (to < from) return 'Конец периода — не раньше начала';
  if (daysBetween(from, to) + 1 > MAX_RANGE_DAYS) return `Период — не больше ${MAX_RANGE_DAYS} дней`;
  if (to > lastDate) return `Онлайн-запись открыта до ${dayMonth(lastDate)} — выберите даты пораньше`;
  return null;
}

/** «21 октября» */
function dayMonth(date) {
  return formatDayLong(date).split(', ')[1] ?? date;
}

/** «21 октября», «21–25 октября», «30 октября – 3 ноября». */
export function formatRange(from, to) {
  if (from === to) return dayMonth(from);
  if (from.slice(0, 7) === to.slice(0, 7)) return `${Number(from.slice(8))}–${dayMonth(to)}`;
  return `${dayMonth(from)} – ${dayMonth(to)}`;
}

/**
 * The `POST /public/booking/waitlist` body. A linked Telegram chat joins for its client: no name and phone.
 * @param {{ items: Array<{ serviceId: number, variant: string | null }>, master: number | 'any' | null, from: string,
 *   to: string, note: string, name: string, phone: string | null, website: string, linked: boolean }} input
 */
export function waitlistBody(input) {
  /** @type {Record<string, unknown>} */
  const body = {
    items: input.items.map((item) => (item.variant ? { serviceId: item.serviceId, variant: item.variant } : { serviceId: item.serviceId })),
    dateFrom: input.from,
    dateTo: input.to,
  };
  const masterId = masterParam(input.master);
  if (masterId !== null) body.masterId = masterId;
  if (!input.linked) {
    body.name = input.name.trim();
    body.phone = input.phone;
  }
  const note = input.note.trim();
  if (note) body.note = note;
  if (input.website) body.website = input.website;
  return body;
}

const positiveId = (value) => {
  if (value === null || !/^\d{1,9}$/.test(value)) return null;
  const n = Number(value);
  return n > 0 ? n : null;
};

/**
 * `?wait=<id>&start=<iso>&items=<serviceId[:variant]…>&master=<id>` (the freed-time button in Telegram) → what to
 * preselect, or null when the link is not one (or is broken).
 * @returns {{ waitId: number, start: string, items: Array<{ serviceId: number, variant: string | null }>, masterId: number | null } | null}
 */
export function parseWaitPreselect(search) {
  const params = new URLSearchParams(search);
  const waitId = positiveId(params.get('wait'));
  const startMs = Date.parse(params.get('start') ?? '');
  if (waitId === null || Number.isNaN(startMs)) return null;
  const items = [];
  for (const part of (params.get('items') ?? '').split(',').map((p) => p.trim()).filter(Boolean)) {
    const at = part.indexOf(':');
    const serviceId = positiveId(at < 0 ? part : part.slice(0, at));
    if (serviceId === null) return null;
    let variant = at < 0 ? null : part.slice(at + 1);
    try {
      if (variant !== null) variant = decodeURIComponent(variant);
    } catch {
      // Already decoded: keep it as is.
    }
    items.push({ serviceId, variant: variant || null });
  }
  if (items.length === 0) return null;
  return { waitId, start: new Date(startMs).toISOString(), items, masterId: positiveId(params.get('master')) };
}

/**
 * Opens the flow on the freed time: the wished services, the master (or «any»), the day and the time chosen, on the
 * time step. Anything the catalog no longer has leaves the flow as it was.
 * @param {any} state a new flow
 * @param {{ start: string, items: Array<{ serviceId: number, variant: string | null }>, masterId: number | null }} wait
 * @param {Map<number, any>} catalog
 * @param {Array<{ id: number }>} masters
 * @param {string} timeZone
 */
export function applyWaitPreselect(state, wait, catalog, masters, timeZone) {
  let next = state;
  for (const item of wait.items) next = reduce(next, { type: 'toggleItem', serviceId: item.serviceId, variant: item.variant }, catalog);
  const master = wait.masterId !== null && masters.some((m) => m.id === wait.masterId) ? wait.masterId : 'any';
  next = reduce(next, { type: 'setMaster', master }, catalog);
  const steps = stepsFor(next);
  if (steps.indexOf(firstIncompleteStep(next, catalog)) < steps.indexOf('time')) return state;
  next = reduce(next, { type: 'setDate', date: dateIn(wait.start, timeZone) }, catalog);
  next = reduce(next, { type: 'setSlot', slot: { startsAt: wait.start, masterIds: [] } }, catalog);
  return { ...next, step: 'time' };
}
