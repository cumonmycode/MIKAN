import { describe, expect, it } from 'vitest';
import {
  addDays,
  dateIn,
  dayChip,
  daysBetween,
  formatCountdown,
  formatDateTime,
  formatDayLong,
  formatDuration,
  formatRub,
  formatTime,
  formatVisit,
  groupSlotsByPartOfDay,
  monthTitle,
  plainPriceText,
  plural,
  remainingMs,
  timezoneHint,
  todayIn,
  totalPriceText,
} from '../public/book/lib/format.js';

// The vitest config runs with the OS timezone Asia/Tomsk (UTC+7): every expectation below is in Moscow time (UTC+3),
// so a formatter that leaked the device timezone would fail.
const MSK = 'Europe/Moscow';
const NBSP = ' ';

describe('booking page: money and plurals', () => {
  it('formats whole rubles with non-breaking thousands', () => {
    expect(formatRub(0)).toBe(`0${NBSP}₽`);
    expect(formatRub(500)).toBe(`500${NBSP}₽`);
    expect(formatRub(3000)).toBe(`3${NBSP}000${NBSP}₽`);
    expect(formatRub(1234567)).toBe(`1${NBSP}234${NBSP}567${NBSP}₽`);
    expect(formatRub(-2500)).toBe(`−2${NBSP}500${NBSP}₽`);
  });

  it('prints a fixed price the way the server does', () => {
    expect(plainPriceText(0)).toBe('Бесплатно');
    expect(plainPriceText(2500)).toBe(`2${NBSP}500${NBSP}₽`);
  });

  it('picks the Russian plural form', () => {
    const forms = (n: number) => plural(n, 'услуга', 'услуги', 'услуг');
    expect([1, 2, 4, 5, 11, 12, 14, 21, 22, 25, 101, 111].map(forms)).toEqual([
      'услуга', 'услуги', 'услуги', 'услуг', 'услуг', 'услуг', 'услуг', 'услуга', 'услуги', 'услуг', 'услуга', 'услуг',
    ]);
  });

  it('totals exact prices exactly and marks per-appointment prices with «от»', () => {
    const fixed = (price: number) => ({ price, priceText: plainPriceText(price) });
    expect(totalPriceText([])).toBe('');
    expect(totalPriceText([fixed(2500), fixed(1500)])).toBe(`4${NBSP}000${NBSP}₽`);
    expect(totalPriceText([fixed(0)])).toBe('Бесплатно');
    expect(totalPriceText([fixed(2500), { price: 15000, priceText: `от${NBSP}15${NBSP}000${NBSP}₽` }])).toBe(
      `от${NBSP}17${NBSP}500${NBSP}₽`,
    );
    expect(totalPriceText([{ price: 0, priceText: `до${NBSP}10${NBSP}000${NBSP}₽` }])).toBe('Цена — на консультации');
  });
});

describe('booking page: durations and countdown', () => {
  it('formats durations in hours and minutes', () => {
    expect(formatDuration(45)).toBe(`45${NBSP}мин`);
    expect(formatDuration(60)).toBe(`1${NBSP}ч`);
    expect(formatDuration(90)).toBe(`1${NBSP}ч 30${NBSP}мин`);
    expect(formatDuration(180)).toBe(`3${NBSP}ч`);
    expect(formatDuration(0)).toBe(`0${NBSP}мин`);
  });

  it('counts down in m:ss, h:mm:ss from an hour, never below zero', () => {
    expect(formatCountdown(14 * 60_000 + 32_000)).toBe('14:32');
    expect(formatCountdown(5_000)).toBe('0:05');
    expect(formatCountdown(4_001)).toBe('0:05'); // a started second still counts
    expect(formatCountdown(3_723_000)).toBe('1:02:03');
    expect(formatCountdown(0)).toBe('0:00');
    expect(formatCountdown(-10_000)).toBe('0:00');
  });

  it('measures the time left on the server clock', () => {
    const now = Date.parse('2026-10-21T11:00:00.000Z');
    expect(remainingMs('2026-10-21T11:15:00.000Z', now)).toBe(15 * 60_000);
    // The device clock is 2 minutes behind the server: 2 minutes less are left.
    expect(remainingMs('2026-10-21T11:15:00.000Z', now, 120_000)).toBe(13 * 60_000);
    expect(remainingMs('not a date', now)).toBe(0);
  });
});

describe('booking page: studio-local dates', () => {
  it('shows times in the studio timezone, not the device one', () => {
    expect(formatTime('2026-10-21T12:00:00.000Z', MSK)).toBe('15:00');
    expect(formatTime('2026-10-21T21:30:00.000Z', MSK)).toBe('00:30');
    expect(dateIn('2026-10-21T21:30:00.000Z', MSK)).toBe('2026-10-22');
  });

  it('knows today in the studio around midnight', () => {
    expect(todayIn(MSK, new Date('2026-10-21T20:59:00.000Z'))).toBe('2026-10-21');
    expect(todayIn(MSK, new Date('2026-10-21T21:01:00.000Z'))).toBe('2026-10-22');
  });

  it('falls back to the device timezone for an unknown zone instead of failing', () => {
    expect(formatTime('2026-10-21T12:00:00.000Z', 'Not/AZone')).toMatch(/^\d{2}:\d{2}$/);
  });

  it('does calendar arithmetic on plain dates', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(daysBetween('2026-10-21', '2026-11-20')).toBe(30);
    expect(() => addDays('21.10.2026', 1)).toThrow(RangeError);
  });

  it('describes a day for the strip and the headings', () => {
    expect(dayChip('2026-10-21')).toEqual({ weekday: 'ср', day: 21, month: 'окт', weekend: false });
    expect(dayChip('2026-10-25')).toEqual({ weekday: 'вс', day: 25, month: 'окт', weekend: true });
    expect(monthTitle('2026-10-21')).toBe('Октябрь 2026');
    expect(formatDayLong('2026-10-21')).toBe(`среда, 21${NBSP}октября`);
    expect(formatDateTime('2026-10-21T12:00:00.000Z', MSK)).toBe(`среда, 21${NBSP}октября, 15:00`);
    expect(formatVisit('2026-10-21T12:00:00.000Z', '2026-10-21T13:30:00.000Z', MSK)).toBe(
      `среда, 21${NBSP}октября, 15:00–16:30`,
    );
    expect(formatVisit('2026-10-21T12:00:00.000Z', null, MSK)).toBe(`среда, 21${NBSP}октября, 15:00`);
  });

  it('mentions the timezone only when the device is elsewhere', () => {
    expect(timezoneHint(MSK, MSK)).toBe('');
    expect(timezoneHint(MSK, 'Asia/Tomsk')).toBe('Время указано по Москве');
    expect(timezoneHint('Asia/Novosibirsk', 'Europe/Moscow')).toBe('Время указано по часовому поясу студии');
    expect(timezoneHint(MSK, '')).toBe('');
  });

  it('groups free starts into morning, day and evening', () => {
    const at = (hhmm: string) => ({ startsAt: new Date(`2026-10-21T${hhmm}:00.000+03:00`).toISOString() });
    const groups = groupSlotsByPartOfDay([at('10:00'), at('11:30'), at('12:00'), at('16:30'), at('17:00'), at('20:00')], MSK);
    expect(groups.map((g) => [g.title, g.slots.map((s) => formatTime(s.startsAt, MSK))])).toEqual([
      ['Утро', ['10:00', '11:30']],
      ['День', ['12:00', '16:30']],
      ['Вечер', ['17:00', '20:00']],
    ]);
    expect(groupSlotsByPartOfDay([at('18:00')], MSK).map((g) => g.title)).toEqual(['Вечер']);
  });
});
