// @ts-check
/**
 * Pure formatting helpers for the booking page: money, durations, plurals, studio-local dates and the payment
 * countdown. Dates are built from numeric parts (not locale strings), so the output is the same in every browser.
 */

const NBSP = ' ';

const MONTHS_GENITIVE = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];
const MONTHS_NOMINATIVE = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
/** Sunday first, as `Date#getUTCDay()` counts. */
const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const WEEKDAYS_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/** «3 000» — whole rubles with non-breaking spaces between the thousands, no currency sign. */
export function formatAmount(amount) {
  const value = Math.round(Number(amount) || 0);
  const sign = value < 0 ? '−' : '';
  return `${sign}${String(Math.abs(value)).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP)}`;
}

/** «3 000 ₽» — whole rubles with non-breaking spaces. */
export function formatRub(amount) {
  return `${formatAmount(amount)}${NBSP}₽`;
}

/** Russian plural: plural(2, 'услуга', 'услуги', 'услуг') → «услуги». */
export function plural(n, one, few, many) {
  const abs = Math.abs(Math.trunc(n));
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** «45 мин», «1 ч», «1 ч 30 мин». */
export function formatDuration(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours === 0) return `${rest}${NBSP}мин`;
  if (rest === 0) return `${hours}${NBSP}ч`;
  return `${hours}${NBSP}ч ${rest}${NBSP}мин`;
}

/**
 * Total of the chosen lines. Exact when every line's price text is its plain price; otherwise «от …», since some
 * lines are priced per appointment («от 15 000 ₽», «до 10 000 ₽»).
 * @param {Array<{ price: number, priceText: string }>} lines
 */
export function totalPriceText(lines) {
  if (lines.length === 0) return '';
  const total = lines.reduce((sum, line) => sum + (Number(line.price) || 0), 0);
  const exact = lines.every((line) => line.priceText === plainPriceText(line.price));
  if (exact) return total === 0 ? 'Бесплатно' : formatRub(total);
  return total > 0 ? `от${NBSP}${formatRub(total)}` : 'Цена — на консультации';
}

/**
 * The totals of the same lines priced by several masters: «3 000–4 000 ₽» when every line is a plain price, else
 * «от 3 000 ₽» from the cheapest (some lines are priced per appointment).
 * @param {Array<Array<{ price: number, priceText: string }>>} lineSets
 */
export function priceRangeText(lineSets) {
  if (lineSets.length === 0) return '';
  const totals = lineSets.map((lines) => lines.reduce((sum, line) => sum + (Number(line.price) || 0), 0));
  const min = Math.min(...totals);
  const max = Math.max(...totals);
  const exact = lineSets.every((lines) => lines.every((line) => line.priceText === plainPriceText(line.price)));
  if (exact) return min === max ? plainPriceText(min) : `${formatAmount(min)}–${formatRub(max)}`;
  return min > 0 ? `от${NBSP}${formatRub(min)}` : 'Цена — на консультации';
}

/** How the server prints a fixed price: «2 500 ₽», or «Бесплатно» for 0. */
export function plainPriceText(price) {
  return Number(price) === 0 ? 'Бесплатно' : formatRub(price);
}

/** A time left as «14:32» (or «1:02:03» from an hour); «0:00» once it has run out. */
export function formatCountdown(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const ss = String(seconds).padStart(2, '0');
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${ss}`;
  return `${minutes}:${ss}`;
}

/** Milliseconds left until `untilIso`, measured on the server's clock (`offsetMs` = server − device). */
export function remainingMs(untilIso, nowMs, offsetMs = 0) {
  const until = Date.parse(untilIso);
  if (Number.isNaN(until)) return 0;
  return until - (nowMs + offsetMs);
}

const PARTS_OPTIONS = /** @type {const} */ ({
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
/** @type {Map<string, Intl.DateTimeFormat>} */
const formatters = new Map();

/** One formatter per timezone (building one is slow and a day of slots needs dozens of calls). */
function partsFormatter(timeZone) {
  const key = timeZone || '';
  let formatter = formatters.get(key);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat('en-US', { ...PARTS_OPTIONS, timeZone: key || undefined });
    } catch {
      formatter = new Intl.DateTimeFormat('en-US', PARTS_OPTIONS);
    }
    formatters.set(key, formatter);
  }
  return formatter;
}

/**
 * Wall-clock parts of an instant in a timezone. An unknown timezone falls back to the device's.
 * @returns {{ year: number, month: number, day: number, hour: number, minute: number }}
 */
export function zonedParts(iso, timeZone) {
  const parts = Object.fromEntries(partsFormatter(timeZone).formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
  };
}

const pad2 = (n) => String(n).padStart(2, '0');

/** «15:00» in the studio timezone. */
export function formatTime(iso, timeZone) {
  const p = zonedParts(iso, timeZone);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** The studio-local calendar date of an instant, «YYYY-MM-DD». */
export function dateIn(iso, timeZone) {
  const p = zonedParts(iso, timeZone);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** Today in the studio timezone. */
export function todayIn(timeZone, now = new Date()) {
  return dateIn(now.toISOString(), timeZone);
}

function parseDate(date) {
  const m = DATE_RE.exec(date);
  if (!m) throw new RangeError(`Bad date: ${date}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** «2026-10-31» + 1 → «2026-11-01». */
export function addDays(date, days) {
  const d = new Date(parseDate(date) + days * DAY_MS);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Whole days from `from` to `to` (both «YYYY-MM-DD»). */
export function daysBetween(from, to) {
  return Math.round((parseDate(to) - parseDate(from)) / DAY_MS);
}

/** What a day chip shows: { weekday: 'пн', day: 21, month: 'окт', weekend: false }. */
export function dayChip(date) {
  const d = new Date(parseDate(date));
  const weekday = d.getUTCDay();
  return {
    weekday: WEEKDAYS_SHORT[weekday],
    day: d.getUTCDate(),
    month: MONTHS_SHORT[d.getUTCMonth()],
    weekend: weekday === 0 || weekday === 6,
  };
}

/** «Октябрь 2026» — the month above the day strip. */
export function monthTitle(date) {
  const d = new Date(parseDate(date));
  return `${MONTHS_NOMINATIVE[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** «вторник, 21 октября» for a calendar date. */
export function formatDayLong(date) {
  const d = new Date(parseDate(date));
  return `${WEEKDAYS[d.getUTCDay()]}, ${d.getUTCDate()}${NBSP}${MONTHS_GENITIVE[d.getUTCMonth()]}`;
}

/** «вторник, 21 октября, 15:00» for an instant, in the studio timezone. */
export function formatDateTime(iso, timeZone) {
  return `${formatDayLong(dateIn(iso, timeZone))}, ${formatTime(iso, timeZone)}`;
}

/** «вторник, 21 октября, 15:00–16:30». */
export function formatVisit(startsAt, endsAt, timeZone) {
  const start = formatDateTime(startsAt, timeZone);
  if (!endsAt) return start;
  return `${start}–${formatTime(endsAt, timeZone)}`;
}

/** The device's IANA timezone, or '' when the browser does not tell. */
export function deviceTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  } catch {
    return '';
  }
}

/** «Время указано по Москве» when the device is in another timezone than the studio, else ''. */
export function timezoneHint(studioZone, deviceZone) {
  if (!studioZone || !deviceZone || studioZone === deviceZone) return '';
  if (studioZone === 'Europe/Moscow') return 'Время указано по Москве';
  return 'Время указано по часовому поясу студии';
}

const PARTS_OF_DAY = [
  { title: 'Утро', until: 12 },
  { title: 'День', until: 17 },
  { title: 'Вечер', until: 24 },
];

/**
 * Free starts grouped into «Утро» (before 12:00), «День» (before 17:00) and «Вечер», in the studio timezone;
 * empty groups are left out.
 * @template {{ startsAt: string }} T
 * @param {T[]} slots
 * @returns {Array<{ title: string, slots: T[] }>}
 */
export function groupSlotsByPartOfDay(slots, timeZone) {
  return PARTS_OF_DAY.map((part, index) => ({
    title: part.title,
    slots: slots.filter((slot) => {
      const { hour } = zonedParts(slot.startsAt, timeZone);
      const from = index === 0 ? 0 : PARTS_OF_DAY[index - 1].until;
      return hour >= from && hour < part.until;
    }),
  })).filter((group) => group.slots.length > 0);
}
