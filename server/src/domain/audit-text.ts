import { DateTime } from 'luxon';
import { formatAmount, formatRub, pluralWord } from '../lib/text.js';
import type { AuditChanges } from './audit.js';

/** Small Russian wording helpers for audit summaries (domain/audit-summaries*.ts). */

export const ROLE_TITLES: Record<string, string> = { owner: 'Владелец', admin: 'Администратор', master: 'Мастер' };

export const STATUS_TITLES: Record<string, string> = {
  scheduled: 'Ожидает',
  confirmed: 'Подтверждена',
  completed: 'Завершена',
  cancelled: 'Отменена',
  no_show: 'Неявка',
};

export const quote = (text: string): string => `«${text}»`;

/** "Имя Фамилия" of a `ClientRef` (blank parts skipped); «клиент» when unknown. */
export function personName(ref: { name?: unknown; lastName?: unknown } | null | undefined): string {
  if (!ref) return 'клиент';
  const parts = [ref.name, ref.lastName].map((p) => (typeof p === 'string' ? p.trim() : '')).filter(Boolean);
  return parts.join(' ') || 'клиент';
}

const toMillis = (value: number | string): number => (typeof value === 'number' ? value : Date.parse(value));

/** «20 октября, 14:00» in the studio timezone; the year is added when it is not the current one. */
export function formatWhen(value: number | string, tz: string, now = Date.now()): string {
  const dt = DateTime.fromMillis(toMillis(value), { zone: tz }).setLocale('ru');
  const sameYear = dt.year === DateTime.fromMillis(now, { zone: tz }).year;
  return dt.toFormat(sameYear ? "d MMMM, HH:mm" : "d MMMM yyyy, HH:mm");
}

/** "2026-10-23" → «23 октября» (with the year when it is not the current one). */
export function formatDay(date: string, now = Date.now(), tz = 'utc'): string {
  const dt = DateTime.fromISO(date, { zone: 'utc' }).setLocale('ru');
  if (!dt.isValid) return date;
  const sameYear = dt.year === DateTime.fromMillis(now, { zone: tz }).year;
  return dt.toFormat(sameYear ? 'd MMMM' : 'd MMMM yyyy');
}

/** «23 октября», «23–25 октября», «30 октября – 2 ноября». */
export function formatDayRange(from: string, to: string, now = Date.now(), tz = 'utc'): string {
  if (!to || from === to) return formatDay(from, now, tz);
  const a = DateTime.fromISO(from, { zone: 'utc' });
  const b = DateTime.fromISO(to, { zone: 'utc' });
  if (!a.isValid || !b.isValid) return `${from} – ${to}`;
  if (a.year === b.year && a.month === b.month) return `${a.day}–${formatDay(to, now, tz)}`;
  return `${formatDay(from, now, tz)} – ${formatDay(to, now, tz)}`;
}

/** «1 600 → 1 800 ₽» */
export const rubChange = (from: number, to: number): string => `${formatAmount(from)} → ${formatRub(to)}`;

const CYRILLIC_WORD = /^[А-ЯЁ][а-яё]+$/;
const HARD_CONSONANT_END = /[бвгджзклмнпрстфхцчшщ]$/;

/**
 * A first name in the dative («кому?»): Фатима → Фатиме, Мария → Марии, Иван → Ивану, Андрей → Андрею. Null when the
 * form is not certain (several words, Latin letters, names ending in «ь» or indeclinable ones) — then callers word
 * the sentence without it.
 */
export function dativeName(name: string): string | null {
  const word = name.trim();
  if (!CYRILLIC_WORD.test(word)) return null;
  if (word.endsWith('ия')) return `${word.slice(0, -1)}и`;
  if (word.endsWith('а') || word.endsWith('я')) return `${word.slice(0, -1)}е`;
  if (word.endsWith('й')) return `${word.slice(0, -1)}ю`;
  if (HARD_CONSONANT_END.test(word)) return `${word}у`;
  return null;
}

/** Turns one changed field into words, e.g. «цена 1 600 → 1 800 ₽»; null falls back to its label. */
export type ChangeDetail = (from: unknown, to: unknown) => string | null;

/**
 * What changed, in Russian and in the order of `labels` (unknown fields are skipped): the field's `details` wording
 * when given, else its label.
 */
export function describeChanges(
  changes: AuditChanges | null | undefined,
  labels: Record<string, string>,
  details: Record<string, ChangeDetail> = {},
): string[] {
  if (!changes) return [];
  const words = Object.keys(labels)
    .filter((key) => key in changes)
    .map((key) => details[key]?.(changes[key]!.from, changes[key]!.to) ?? labels[key]!);
  return words.filter((word, i) => words.indexOf(word) === i);
}

/** «цена 1 600 → 1 800 ₽» for two amounts. */
export const priceDetail: ChangeDetail = (from, to) =>
  typeof from === 'number' && typeof to === 'number' ? `цена ${rubChange(from, to)}` : null;

/** «: телефон, заметки» — or an empty string when nothing is listed. */
export const labelsSuffix = (labels: string[]): string => (labels.length ? `: ${labels.join(', ')}` : '');

interface DayHours {
  start: string;
  end: string;
  breaks?: Array<{ start: string; end: string }>;
}

const WEEKDAYS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];

export function hoursText(day: DayHours): string {
  const breaks = day.breaks?.length ? ` (перерыв ${day.breaks.map((b) => `${b.start}–${b.end}`).join(', ')})` : '';
  return `${day.start}–${day.end}${breaks}`;
}

/**
 * A weekly schedule in one line, neighbouring days with the same hours joined: «пн–пт 11:00–20:00, сб–вс выходной».
 * `null` — no own schedule.
 */
export function weeklyText(weekly: ReadonlyArray<DayHours | null> | null | undefined): string {
  if (!weekly) return 'часы студии каждый день';
  const texts = WEEKDAYS.map((_, i) => {
    const day = weekly[i];
    return day ? hoursText(day) : 'выходной';
  });
  const parts: string[] = [];
  let start = 0;
  for (let i = 1; i <= texts.length; i++) {
    if (i < texts.length && texts[i] === texts[start]) continue;
    const days = i - 1 === start ? WEEKDAYS[start]! : `${WEEKDAYS[start]}–${WEEKDAYS[i - 1]}`;
    parts.push(`${days} ${texts[start]}`);
    start = i;
  }
  return parts.join(', ');
}

/** «3 позиции» */
export const countText = (n: number, one: string, few: string, many: string): string => `${n} ${pluralWord(n, one, few, many)}`;

// ---------- reading loosely typed request data ----------

/** The value as an entity with a numeric `id`; throws (→ the default entry) when the route answered otherwise. */
export function entityOf<T extends { id: number }>(value: unknown): T {
  if (value === null || typeof value !== 'object' || typeof (value as { id?: unknown }).id !== 'number') {
    throw new Error('unexpected audit payload');
  }
  return value as T;
}

/** The value as an entity when it is one (snapshots may be missing). */
export function maybeEntity<T extends { id: number }>(value: unknown): T | undefined {
  const id = (value as { id?: unknown } | null | undefined)?.id;
  return typeof id === 'number' ? (value as T) : undefined;
}

export const textOf = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);
export const numberOf = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
