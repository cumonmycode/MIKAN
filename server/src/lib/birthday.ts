/**
 * Client birthdays (docs/API.md «Collecting birthdays»): `YYYY-MM-DD`, where the year 1900 stands for «year unknown» —
 * only the day and the month count then, and no age is ever computed from it. Pure: no DB, no clock.
 */

export const UNKNOWN_BIRTH_YEAR = 1900;
/** Nobody is older than this: an earlier year is a typo. */
const MAX_AGE_YEARS = 120;

const MONTHS_GENITIVE = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
] as const;

interface BirthdayParts {
  /** null — the year is unknown (stored as 1900). */
  year: number | null;
  month: number;
  day: number;
}

function partsOf(value: string): BirthdayParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  return { year: year === UNKNOWN_BIRTH_YEAR ? null : year, month: Number(match[2]), day: Number(match[3]) };
}

const isLeapYear = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/** Days in the month; a year-less month may hold 29 February. */
function daysInMonth(year: number | null, month: number): number {
  if (month === 2) return year === null || isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

const realDay = (p: BirthdayParts) => p.month >= 1 && p.month <= 12 && p.day >= 1 && p.day <= daysInMonth(p.year, p.month);

const pad = (n: number) => String(n).padStart(2, '0');
const valueOf = (p: BirthdayParts) => `${p.year ?? UNKNOWN_BIRTH_YEAR}-${pad(p.month)}-${pad(p.day)}`;

/** A birthday as stored: a real calendar date, or a day and month with the year 1900 (29 February included). */
export function isStoredBirthday(value: string): boolean {
  const parts = partsOf(value);
  return parts !== null && realDay(parts);
}

/** A birthday a client gives: stored-valid, not after `today` and not older than 120 years (both `YYYY-MM-DD`). */
export function isPlausibleBirthday(value: string, today: string): boolean {
  const parts = partsOf(value);
  return parts !== null && plausible(parts, today);
}

function plausible(parts: BirthdayParts, today: string): boolean {
  if (!realDay(parts)) return false;
  if (parts.year === null) return true;
  return parts.year > UNKNOWN_BIRTH_YEAR && parts.year >= Number(today.slice(0, 4)) - MAX_AGE_YEARS && valueOf(parts) <= today;
}

/** Whether the year is known (not the 1900 placeholder). */
export function birthdayHasYear(value: string): boolean {
  return partsOf(value)?.year != null;
}

/** «12 апреля» when the year is unknown, else «12 апреля 1995». */
export function formatBirthday(value: string): string {
  const parts = partsOf(value);
  if (!parts || !realDay(parts)) return value;
  const dayMonth = `${parts.day} ${MONTHS_GENITIVE[parts.month - 1]}`;
  return parts.year === null ? dayMonth : `${dayMonth} ${parts.year}`;
}

/** Whether `date` (`YYYY-MM-DD`) is the birthday: day and month only; 29 February falls on the 28th in other years. */
export function isBirthdayOn(birthday: string, date: string): boolean {
  const dayMonth = birthday.slice(5);
  const target = date.slice(5);
  if (dayMonth === target) return true;
  return dayMonth === '02-29' && target === '02-28' && !isLeapYear(Number(date.slice(0, 4)));
}

// ---- reading a client's reply ----

export type BirthdayReply =
  /** A date: `YYYY-MM-DD` (1900 when the year was not given). */
  | { kind: 'date'; birthday: string }
  /** Looks like a date but is not one (impossible, in the future, garbled): worth one more question. */
  | { kind: 'invalid' }
  /** «Пропустить», «не хочу». */
  | { kind: 'skip' }
  /** Anything else — a question or a request: for the usual pipeline. */
  | { kind: 'other' };

const MONTHS: ReadonlyArray<[RegExp, number]> = [
  [/^янв(ар[ьяе])?$/, 1],
  [/^фев(р(ал[ьяе])?)?$/, 2],
  [/^мар(т|та|те)?$/, 3],
  [/^апр(ел[ьяе])?$/, 4],
  [/^ма[йяе]$/, 5],
  [/^июн[ьяе]?$/, 6],
  [/^июл[ьяе]?$/, 7],
  [/^авг(уст|уста|усте)?$/, 8],
  [/^сен(т(ябр[ьяе])?)?$/, 9],
  [/^окт(ябр[ьяе])?$/, 10],
  [/^ноя(б(р[ьяе])?)?$/, 11],
  [/^дек(абр[ьяе])?$/, 12],
];

const monthOf = (word: string): number | null => MONTHS.find(([pattern]) => pattern.test(word))?.[1] ?? null;

/** Words that may surround a date in a reply to «Подскажите дату рождения». */
const FILLER = new Set([
  'мой', 'моя', 'мое', 'у', 'меня', 'я', 'мне', 'день', 'дня', 'рождения', 'рожденья', 'др', 'д', 'р', 'дата', 'число',
  'это', 'вот', 'так', 'ну', 'а', 'и', 'же', 'да', 'родился', 'родилась', 'год', 'года', 'г', 'гг', 'спасибо',
  'пожалуйста', 'ок', 'окей', 'ok', 'хорошо', 'конечно', 'привет', 'здравствуйте', 'добрый',
]);

const SKIP = new Set([
  'пропустить', 'пропусти', 'пропускаю', 'пропуск', 'не хочу', 'не скажу', 'не буду', 'не надо', 'не нужно', 'нет',
  'нет спасибо', 'не сейчас', 'потом', 'позже',
]);

const DIGITS = /^\d+$/;

interface Found {
  day: string;
  month: number;
  year: string | undefined;
  /** The text without the date. */
  rest: string;
}

/** `(day, month, year?)` patterns, tried in this order on the whole reply. */
const NUMERIC: ReadonlyArray<{ pattern: RegExp; read: (m: RegExpExecArray) => [string, string, string | undefined] }> = [
  // 1995-04-12, 1995.04.12
  { pattern: /(?<!\d)(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?!\d)/, read: (m) => [m[3]!, m[2]!, m[1]!] },
  // 12.04.1995, 12/04/95, 12-04, 12.04 1995
  { pattern: /(?<!\d)(\d{1,2})[-./](\d{1,2})(?:[-./](\d{4}|\d{2})|\s+(\d{4}))?(?![\d])/, read: (m) => [m[1]!, m[2]!, m[3] ?? m[4]] },
  // 12 04 1995
  { pattern: /(?<!\d)(\d{1,2})\s+(\d{1,2})\s+(\d{4})(?!\d)/, read: (m) => [m[1]!, m[2]!, m[3]!] },
];

/** 12 апреля 1995, 12-го апр. 95, 3 мая */
const WORDS = /(?<!\d)(\d{1,2})(?:-?го)?\s*([а-я]+)\.?(?:\s*(\d{4}|\d{2})(?!\d))?/g;

function findDate(text: string): Found | null {
  const cut = (m: RegExpExecArray) => `${text.slice(0, m.index)} ${text.slice(m.index + m[0].length)}`;
  for (const { pattern, read } of NUMERIC) {
    const m = pattern.exec(text);
    if (!m) continue;
    const [day, month, year] = read(m);
    return { day, month: Number(month), year, rest: cut(m) };
  }
  for (const m of text.matchAll(WORDS)) {
    const month = monthOf(m[2]!);
    if (month !== null) return { day: m[1]!, month, year: m[3], rest: cut(m as RegExpExecArray) };
  }
  return null;
}

/** A two-digit year: this century up to this year, else the last one. */
function fullYear(raw: string | undefined, today: string): number | null {
  if (raw === undefined) return null;
  if (raw.length === 4) return Number(raw);
  const short = Number(raw);
  return short <= Number(today.slice(2, 4)) ? 2000 + short : 1900 + short;
}

const tokensOf = (text: string) => text.split(/[^a-zа-я0-9]+/).filter(Boolean);

/**
 * Reads a reply to «Подскажите дату рождения»: «12.04.1995», «12.04», «12/04/95», «12 апреля», «12 апреля 1995»,
 * «1995-04-12», also inside «мой день рождения 12 апреля». `today` (`YYYY-MM-DD`, studio-local) rules out future dates
 * and reads two-digit years. Any other word around the date, or a question mark, makes it something else.
 */
export function parseBirthdayReply(text: string, today: string): BirthdayReply {
  const normalized = text.toLowerCase().replaceAll('ё', 'е').replace(/[‐-―−]/g, '-').trim();
  if (normalized.includes('?')) return { kind: 'other' };
  const words = tokensOf(normalized);
  if (SKIP.has(words.join(' '))) return { kind: 'skip' };
  const found = findDate(normalized);
  if (!found) {
    const dateLike = words.some((w) => DIGITS.test(w) || monthOf(w) !== null);
    const onlyDateWords = words.every((w) => DIGITS.test(w) || monthOf(w) !== null || FILLER.has(w));
    return dateLike && onlyDateWords ? { kind: 'invalid' } : { kind: 'other' };
  }
  const rest = tokensOf(found.rest);
  if (rest.some((w) => !DIGITS.test(w) && !FILLER.has(w))) return { kind: 'other' };
  if (rest.some((w) => DIGITS.test(w))) return { kind: 'invalid' };
  const year = fullYear(found.year, today);
  if (year === UNKNOWN_BIRTH_YEAR) return { kind: 'invalid' };
  const parts: BirthdayParts = { year, month: found.month, day: Number(found.day) };
  return plausible(parts, today) ? { kind: 'date', birthday: valueOf(parts) } : { kind: 'invalid' };
}
