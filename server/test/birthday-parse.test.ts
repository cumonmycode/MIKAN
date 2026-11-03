import { describe, expect, it } from 'vitest';
import {
  birthdayHasYear,
  formatBirthday,
  isBirthdayOn,
  isPlausibleBirthday,
  isStoredBirthday,
  parseBirthdayReply,
} from '../src/lib/birthday.js';

const TODAY = '2026-10-20';
const parse = (text: string) => parseBirthdayReply(text, TODAY);
const date = (birthday: string) => ({ kind: 'date', birthday });

describe('parseBirthdayReply', () => {
  it.each([
    ['12.04.1995', '1995-04-12'],
    ['12.4.1995', '1995-04-12'],
    ['1.5.2000', '2000-05-01'],
    ['12/04/95', '1995-04-12'],
    ['12/04/05', '2005-04-12'],
    ['12-04-1995', '1995-04-12'],
    ['12 04 1995', '1995-04-12'],
    ['12.04 1995', '1995-04-12'],
    ['1995-04-12', '1995-04-12'],
    ['1995.04.12', '1995-04-12'],
    ['12.04.1995г.', '1995-04-12'],
    ['12 апреля 1995', '1995-04-12'],
    ['12 апреля 1995 года', '1995-04-12'],
    ['12 апреля 95', '1995-04-12'],
    ['12-го апреля 1995 г.', '1995-04-12'],
    ['12апр. 1995', '1995-04-12'],
    ['1 сентября 2001', '2001-09-01'],
    ['  29 Февраля 2000 ', '2000-02-29'],
  ])('reads a full date «%s»', (text, expected) => {
    expect(parse(text)).toEqual(date(expected));
  });

  it.each([
    ['12.04', '1900-04-12'],
    ['12/04', '1900-04-12'],
    ['12 апреля', '1900-04-12'],
    ['12 Апрель', '1900-04-12'],
    ['3 мая', '1900-05-03'],
    ['31 декабря', '1900-12-31'],
    ['29 февраля', '1900-02-29'],
    ['5 ноября', '1900-11-05'],
  ])('stores a date without a year with the year 1900: «%s»', (text, expected) => {
    expect(parse(text)).toEqual(date(expected));
  });

  it.each([
    ['мой день рождения 12 апреля', '1900-04-12'],
    ['Мой ДР 12.04.1995', '1995-04-12'],
    ['у меня др 3 марта', '1900-03-03'],
    ['Я родилась 12 апреля 1995 года', '1995-04-12'],
    ['12 апреля, спасибо!', '1900-04-12'],
    ['Да, 1 мая 🙂', '1900-05-01'],
    ['Дата рождения: 07.11.1988', '1988-11-07'],
  ])('finds the date among the usual words: «%s»', (text, expected) => {
    expect(parse(text)).toEqual(date(expected));
  });

  it.each([
    ['31.02.1995', 'no 31 February'],
    ['29.02.1995', 'not a leap year'],
    ['32.01', 'no 32nd'],
    ['12.13.1995', 'no 13th month'],
    ['12.04.2030', 'in the future'],
    ['21.10.2026', 'tomorrow'],
    ['12.04.1900', 'the placeholder year as a real one'],
    ['12.04.1850', 'too long ago'],
    ['31 июня', 'no 31 June'],
    ['1204', 'digits only'],
    ['12', 'a lone number'],
    ['апрель', 'a month without a day'],
    ['12 04', 'two numbers'],
    ['12.04 и 13.05', 'two dates'],
  ])('asks again when it looks like a date but is not one: «%s» (%s)', (text) => {
    expect(parse(text)).toEqual({ kind: 'invalid' });
  });

  it.each([
    'Сколько стоит прокол мочки?',
    'На 12.04 есть время?',
    'хочу записаться 12.04',
    'запишите на 12 апреля к Фатиме',
    'Привет',
    '📅 Записаться',
    '[Фото]',
    'не помню',
    '',
  ])('leaves anything else to the usual pipeline: «%s»', (text) => {
    expect(parse(text)).toEqual({ kind: 'other' });
  });

  it.each(['Пропустить', 'пропусти', 'Не хочу', 'не скажу', 'Нет, спасибо', 'нет'])('understands a refusal: «%s»', (text) => {
    expect(parse(text)).toEqual({ kind: 'skip' });
  });

  it('reads two-digit years against today', () => {
    expect(parseBirthdayReply('12.04.26', '2026-10-20')).toEqual(date('2026-04-12'));
    expect(parseBirthdayReply('12.04.27', '2026-10-20')).toEqual(date('1927-04-12'));
    expect(parseBirthdayReply('12.04.00', '2026-10-20')).toEqual(date('2000-04-12'));
  });

  it('accepts today, not tomorrow', () => {
    expect(parse('20.10.2026')).toEqual(date('2026-10-20'));
    expect(parse('21.10.2026')).toEqual({ kind: 'invalid' });
  });
});

describe('stored birthdays', () => {
  it('a stored birthday is a real date or day and month with the year 1900 (29 February included)', () => {
    expect(isStoredBirthday('1995-04-12')).toBe(true);
    expect(isStoredBirthday('1900-04-12')).toBe(true);
    expect(isStoredBirthday('1900-02-29')).toBe(true);
    expect(isStoredBirthday('2000-02-29')).toBe(true);
    expect(isStoredBirthday('1995-02-29')).toBe(false);
    expect(isStoredBirthday('1900-02-30')).toBe(false);
    expect(isStoredBirthday('12.04.1995')).toBe(false);
    expect(isStoredBirthday('1995-4-12')).toBe(false);
  });

  it('a plausible one is also not in the future and not older than 120 years', () => {
    expect(isPlausibleBirthday('1995-04-12', TODAY)).toBe(true);
    expect(isPlausibleBirthday('1900-02-29', TODAY)).toBe(true);
    expect(isPlausibleBirthday('2026-10-20', TODAY)).toBe(true);
    expect(isPlausibleBirthday('2026-10-21', TODAY)).toBe(false);
    expect(isPlausibleBirthday('1905-01-01', TODAY)).toBe(false);
    expect(isPlausibleBirthday('1906-01-01', TODAY)).toBe(true);
    expect(isPlausibleBirthday('1995-02-30', TODAY)).toBe(false);
  });

  it('the year 1900 means «year unknown»: shown as day and month only', () => {
    expect(birthdayHasYear('1995-04-12')).toBe(true);
    expect(birthdayHasYear('1900-04-12')).toBe(false);
    expect(formatBirthday('1900-04-12')).toBe('12 апреля');
    expect(formatBirthday('1900-02-29')).toBe('29 февраля');
    expect(formatBirthday('1995-04-12')).toBe('12 апреля 1995');
    expect(formatBirthday('1988-11-07')).toBe('7 ноября 1988');
  });

  it('a birthday falls on its day and month whatever the year; 29 February on the 28th in other years', () => {
    expect(isBirthdayOn('1900-04-12', '2026-04-12')).toBe(true);
    expect(isBirthdayOn('1995-04-12', '2026-04-12')).toBe(true);
    expect(isBirthdayOn('1995-04-12', '2026-04-13')).toBe(false);
    expect(isBirthdayOn('1900-02-29', '2027-02-28')).toBe(true);
    expect(isBirthdayOn('2000-02-29', '2028-02-28')).toBe(false);
    expect(isBirthdayOn('2000-02-29', '2028-02-29')).toBe(true);
  });
});
