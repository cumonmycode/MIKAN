// @ts-check
/**
 * The optional birthday of the booking page and the cabinet: typed as «ДД.ММ.ГГГГ» or just «ДД.ММ» (the dots are put in
 * by the mask, so the numeric keypad is enough). Sent as `YYYY-MM-DD`; a date without the year as 1900 («year unknown»).
 * Pure: no DOM, no clock.
 */

export const UNKNOWN_BIRTH_YEAR = 1900;
const MAX_DIGITS = 8;
/** Nobody is older than this: an earlier year is a typo. */
const MAX_AGE_YEARS = 120;

const MONTHS_GENITIVE = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

export const BIRTHDAY_PLACEHOLDER = 'ДД.ММ.ГГГГ';
export const BIRTHDAY_ERROR = 'Проверьте дату: например, 12.04.1995 — или только 12.04';

const digitsOf = (text) => String(text ?? '').replace(/\D/g, '').slice(0, MAX_DIGITS);

/** «12041995» → «12.04.1995»; partial input as far as it goes («120» → «12.0»). */
export function formatBirthdayDigits(digits) {
  const d = digitsOf(digits);
  if (d.length <= 2) return d;
  if (d.length <= 4) return `${d.slice(0, 2)}.${d.slice(2)}`;
  return `${d.slice(0, 2)}.${d.slice(2, 4)}.${d.slice(4)}`;
}

/** Index in `formatted` right after its `count`-th digit. */
function caretAfterDigits(formatted, count) {
  if (count <= 0) return 0;
  let seen = 0;
  for (let i = 0; i < formatted.length; i += 1) {
    if (/\d/.test(formatted[i])) {
      seen += 1;
      if (seen === count) return i + 1;
    }
  }
  return formatted.length;
}

/**
 * Re-masks the field after an edit (like the phone mask).
 * @param {{ previous: string, raw: string, caret: number, inputType?: string }} edit
 * @returns {{ value: string, caret: number }}
 */
export function applyBirthdayInput({ previous, raw, caret, inputType = '' }) {
  // A browser's autofill («bday») may bring the ISO form.
  const iso = /^\s*(\d{4})-(\d{2})-(\d{2})\s*$/.exec(raw);
  if (iso) {
    const value = formatBirthdayDigits(`${iso[3]}${iso[2]}${iso[1]}`);
    return { value, caret: value.length };
  }
  let digits = digitsOf(raw);
  let before = Math.min(digitsOf(raw.slice(0, Math.max(0, caret))).length, digits.length);
  // Backspace over a dot removes no digit and the mask would put it right back: delete the digit before it instead.
  if (inputType === 'deleteContentBackward' && digits === digitsOf(previous) && before > 0) {
    digits = digits.slice(0, before - 1) + digits.slice(before);
    before -= 1;
  }
  const value = formatBirthdayDigits(digits);
  return { value, caret: caretAfterDigits(value, before) };
}

const isLeapYear = (year) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

function daysInMonth(year, month) {
  if (month === 2) return year === null || isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

const pad = (n) => String(n).padStart(2, '0');

/**
 * What was typed → `{ value }`: `YYYY-MM-DD` (1900 without the year) or null when the field is empty; `{ error }` when
 * it is not a real birthday (impossible, an incomplete year, the year 1900 or earlier; with `today` also in the future
 * or 120+ years ago).
 * @param {string} text
 * @param {string | null} [today] `YYYY-MM-DD`, the studio's today; null — not known here (the server checks it)
 * @returns {{ value: string | null, error: null } | { value: null, error: string }}
 */
export function birthdayFromInput(text, today = null) {
  const digits = digitsOf(text);
  if (digits.length === 0) return { value: null, error: null };
  if (digits.length !== 4 && digits.length !== MAX_DIGITS) return { value: null, error: BIRTHDAY_ERROR };
  const day = Number(digits.slice(0, 2));
  const month = Number(digits.slice(2, 4));
  const year = digits.length === MAX_DIGITS ? Number(digits.slice(4)) : null;
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return { value: null, error: BIRTHDAY_ERROR };
  const value = `${year ?? UNKNOWN_BIRTH_YEAR}-${pad(month)}-${pad(day)}`;
  if (year !== null && year <= UNKNOWN_BIRTH_YEAR) return { value: null, error: BIRTHDAY_ERROR };
  if (year !== null && today !== null && (year < Number(today.slice(0, 4)) - MAX_AGE_YEARS || value > today)) {
    return { value: null, error: BIRTHDAY_ERROR };
  }
  return { value, error: null };
}

/** «12 апреля 1995», or «12 апреля» when the year is unknown (1900). */
export function birthdayLabel(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''));
  if (!match) return '';
  const dayMonth = `${Number(match[3])} ${MONTHS_GENITIVE[Number(match[2]) - 1] ?? ''}`.trim();
  return Number(match[1]) === UNKNOWN_BIRTH_YEAR ? dayMonth : `${dayMonth} ${match[1]}`;
}
