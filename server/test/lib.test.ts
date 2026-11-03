import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadConfig } from '../src/config.js';
import { allocateDiscount } from '../src/domain/reports.js';
import { AppError, errorMessage, notFound } from '../src/lib/errors.js';
import { isPlausiblePhone, normalizePhone, phoneSearchVariants } from '../src/lib/phone.js';
import { parseSteps } from '../src/lib/serialize.js';
import { formatRub, searchKey, splitMessage, truncate } from '../src/lib/text.js';
import {
  aftercareSendAt,
  formatHumanDateTime,
  isValidCalendarDate,
  isValidTimezone,
  localDate,
  localDatesInRange,
  localDayBounds,
  localDaysBetween,
  parseInstant,
  toIso,
} from '../src/lib/time.js';
import { formatZodError, likePattern, parse, phoneInput } from '../src/lib/validation.js';
import { sniffImage } from '../src/lib/image-type.js';

describe('phone normalization', () => {
  it.each([
    ['89991234567', '+79991234567'],
    ['79991234567', '+79991234567'],
    ['+7 (999) 123-45-67', '+79991234567'],
    ['9991234567', '+79991234567'],
    ['+1 202 555 0143', '+12025550143'],
    ['8 (999) 123 45 67', '+79991234567'],
    // Telegram's contact `phone_number`: usually without «+», sometimes with it.
    ['79931234567', '+79931234567'],
    ['+79931234567', '+79931234567'],
    // Employee profile phones as people type them.
    ['8 (993) 123-45-67', '+79931234567'],
    ['8-993-123-45-67', '+79931234567'],
    ['+7 993 123 45 67', '+79931234567'],
    ['(993) 123-45-67', '+79931234567'],
    [' +7 993 123-45-67 ', '+79931234567'],
  ])('normalizes %s → %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it('returns null without digits and validates length', () => {
    expect(normalizePhone('---')).toBeNull();
    expect(normalizePhone(null)).toBeNull();
    expect(isPlausiblePhone('+123')).toBe(false);
    expect(isPlausiblePhone('+79991234567')).toBe(true);
  });

  it('builds search variants for Russian numbers', () => {
    expect(phoneSearchVariants('+79991234567')).toBe('79991234567 89991234567 9991234567');
    expect(phoneSearchVariants('+12025550143')).toBe('12025550143');
    expect(phoneSearchVariants(null)).toBe('');
  });
});

describe('time helpers (studio timezone, independent of the OS clock)', () => {
  const tz = 'Europe/Moscow';

  it('parses ISO instants, treating offset-less strings as UTC', () => {
    expect(parseInstant('2026-10-15T11:00:00.000Z')).toBe(Date.UTC(2026, 9, 15, 11));
    expect(parseInstant('2026-10-15T14:00:00+03:00')).toBe(Date.UTC(2026, 9, 15, 11));
    expect(parseInstant('2026-10-15T11:00:00')).toBe(Date.UTC(2026, 9, 15, 11));
    expect(parseInstant('nope')).toBeNull();
    expect(toIso(Date.UTC(2026, 9, 15, 11))).toBe('2026-10-15T11:00:00.000Z');
    expect(toIso(null)).toBeNull();
  });

  it('computes aftercare send times', () => {
    // Completed at 23:30 Moscow on Oct 15 (20:30 UTC).
    const completed = Date.UTC(2026, 9, 15, 20, 30);
    expect(aftercareSendAt(completed, 0, 12, tz)).toBe(completed + 5 * 60_000);
    // Day 1 → Oct 16 12:00 Moscow = 09:00 UTC.
    expect(aftercareSendAt(completed, 1, 12, tz)).toBe(Date.UTC(2026, 9, 16, 9));
    expect(aftercareSendAt(completed, 7, 10, tz)).toBe(Date.UTC(2026, 9, 22, 7));
  });

  it('lists every local day in a range and computes bounds', () => {
    const from = Date.UTC(2026, 9, 31, 21); // Nov 1 00:00 Moscow
    const to = Date.UTC(2026, 10, 3, 21); // Nov 4 00:00 Moscow
    expect(localDatesInRange(from, to, tz)).toEqual(['2026-11-01', '2026-11-02', '2026-11-03']);
    expect(localDatesInRange(to, from, tz)).toEqual([]);
    expect(localDayBounds(Date.UTC(2026, 9, 15, 22), tz)).toEqual({
      start: Date.UTC(2026, 9, 15, 21),
      end: Date.UTC(2026, 9, 16, 21),
      date: '2026-10-16',
    });
    expect(localDate(Date.UTC(2026, 9, 15, 22), 'UTC')).toBe('2026-10-15');
    expect(localDaysBetween(Date.UTC(2026, 9, 12, 10), Date.UTC(2026, 9, 15, 10), tz)).toBe(3);
  });

  it('validates timezones, dates and formats Russian date-time', () => {
    expect(isValidTimezone('Europe/Moscow')).toBe(true);
    expect(isValidTimezone('Mars/Base')).toBe(false);
    expect(isValidCalendarDate('1995-04-12')).toBe(true);
    expect(isValidCalendarDate('1995-02-30')).toBe(false);
    expect(formatHumanDateTime(Date.UTC(2026, 9, 15, 11), tz)).toBe('четверг, 15 октября в 14:00');
  });
});

describe('text helpers', () => {
  it('splits long messages on boundaries within the limit', () => {
    const paragraph = 'Слово '.repeat(300).trim();
    const chunks = splitMessage(`${paragraph}\n\n${paragraph}`, 1000);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((c) => c.length <= 1000)).toBe(true);
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toBe(`${paragraph} ${paragraph}`);
    expect(splitMessage('   ')).toEqual([]);
    expect(splitMessage('x'.repeat(25), 10)).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)]);
  });

  it('builds search keys and formats money', () => {
    expect(searchKey('Ёлка  ИВАН', null, 'ivan.P')).toBe('елка иван ivan.p');
    expect(formatRub(12500)).toBe('12 500 ₽');
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(truncate('abc', 4)).toBe('abc');
  });
});

describe('validation', () => {
  it('produces Russian messages with field labels', () => {
    const schema = z.object({ price: z.number().int().min(0), items: z.array(z.object({ name: z.string().min(1) })) });
    const r1 = schema.safeParse({ price: -1, items: [] });
    expect(formatZodError(r1.error!)).toBe('«Цена»: должно быть не меньше 0');
    const r2 = schema.safeParse({ price: 1, items: [{ name: '' }] });
    expect(formatZodError(r2.error!)).toBe('«Название / имя (№1)»: не может быть пустым');
    const r3 = schema.safeParse({ items: [] });
    expect(formatZodError(r3.error!)).toBe('«Цена»: обязательное поле');
    expect(() => parse(schema, { price: 'x', items: [] })).toThrowError(/должно быть числом/);
  });

  it('normalizes phone input and rejects garbage', () => {
    expect(parse(z.object({ phone: phoneInput }), { phone: '8 999 123 45 67' }).phone).toBe('+79991234567');
    expect(parse(z.object({ phone: phoneInput }), { phone: '' }).phone).toBeNull();
    expect(() => parse(z.object({ phone: phoneInput }), { phone: '12' })).toThrowError(/некорректный номер/);
  });

  it('escapes LIKE wildcards', () => {
    expect(likePattern('50%_a\\b')).toBe('%50\\%\\_a\\\\b%');
  });
});

describe('misc', () => {
  it('allocates discounts proportionally with exact totals', () => {
    expect(allocateDiscount([{ total: 1000 }, { total: 2000 }], 300)).toEqual([900, 1800]);
    const net = allocateDiscount([{ total: 333 }, { total: 333 }, { total: 334 }], 100);
    expect(net.reduce((a, b) => a + b, 0)).toBe(900);
    expect(allocateDiscount([{ total: 500 }], 0)).toEqual([500]);
  });

  it('sniffs image signatures', () => {
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpg');
    expect(sniffImage(Buffer.from('89504e470d0a1a0a0000', 'hex'))).toBe('png');
    expect(sniffImage(Buffer.from('RIFF0000WEBPVP8 ', 'ascii'))).toBe('webp');
    expect(sniffImage(Buffer.from('0000ftypheic0000', 'ascii'))).toBe('heic');
    expect(sniffImage(Buffer.from('hello world!', 'ascii'))).toBeNull();
  });

  it('parses aftercare steps defensively', () => {
    expect(parseSteps('[{"dayOffset":1,"text":"a"},{"x":1}]')).toEqual([{ dayOffset: 1, text: 'a' }]);
    expect(parseSteps('not json')).toEqual([]);
    expect(parseSteps('{}')).toEqual([]);
  });

  it('wraps errors', () => {
    const err = notFound('Нет');
    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(404);
    expect(err.toBody()).toEqual({ error: { code: 'not_found', message: 'Нет' } });
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('plain')).toBe('plain');
  });
});

describe('config', () => {
  const base = { JWT_SECRET: 'x'.repeat(32), ADMIN_PASSWORD: 'secret1' };

  it('fails fast on a short JWT secret', () => {
    expect(() => loadConfig({ JWT_SECRET: 'short', ADMIN_PASSWORD: 'secret1' })).toThrowError(/JWT_SECRET/);
  });

  it('applies defaults and gateway auth rules', () => {
    const c = loadConfig({ ...base, AI_API_KEY: 'k', AI_BASE_URL: 'https://polza.ai/api', TELEGRAM_API_ROOT: 'https://tg.example.workers.dev/' });
    expect(c.ai.auth).toBe('bearer');
    expect(c.ai.model).toBe('claude-opus-5-5');
    expect(c.telegram.apiRoot).toBe('https://tg.example.workers.dev');
    expect(c.telegram.enabled).toBe(false);
    const direct = loadConfig({ ...base, AI_API_KEY: '', BOT_ENABLED: 'true' });
    expect(direct.ai.apiKey).toBeNull();
    expect(direct.ai.auth).toBe('x-api-key');
    expect(direct.telegram.apiRoot).toBe('https://api.telegram.org');
    expect(direct.telegram.enabled).toBe(true);
  });
});
