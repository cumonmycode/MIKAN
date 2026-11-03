import { describe, expect, it } from 'vitest';
import {
  bookingBody,
  bookingPagePath,
  bookingTokenFromPath,
  bookingUrl,
  buildUrl,
  daysUrl,
  itemsParam,
  parsePreselect,
  safeHref,
  slotsUrl,
} from '../public/book/lib/query.js';

/** How the server reads `items`: the query parser decodes once, then each variant is decoded after the split. */
function serverItems(url: string) {
  const raw = new URL(url, 'https://studio.test').searchParams.get('items') ?? '';
  return raw.split(',').map((part) => {
    const [id, variant] = part.split(':');
    return { serviceId: Number(id), variant: variant === undefined ? null : decodeURIComponent(variant) };
  });
}

describe('booking page: API query strings', () => {
  it('builds items as serviceId[:variant] with the variant URL-encoded', () => {
    expect(itemsParam([{ serviceId: 3, variant: null }])).toBe('3');
    expect(itemsParam([{ serviceId: 3, variant: null }, { serviceId: 5, variant: 'Два' }])).toBe('3,5:%D0%94%D0%B2%D0%B0');
    expect(itemsParam([{ serviceId: 7, variant: 'a,b:c 50%' }])).toBe('7:a%2Cb%3Ac%2050%25');
  });

  it('survives the round trip through the URL for awkward variant names', () => {
    const items = [
      { serviceId: 3, variant: null },
      { serviceId: 5, variant: 'Два, с украшением: титан 100%' },
      { serviceId: 8, variant: 'a&b=c' },
    ];
    const url = slotsUrl({ date: '2026-10-21', items, master: 'any' });
    expect(serverItems(url)).toEqual(items);
  });

  it('adds the master only when a particular one is chosen', () => {
    const items = [{ serviceId: 3, variant: null }];
    expect(daysUrl({ from: '2026-10-21', to: '2026-11-20', items, master: 'any' })).toBe(
      '/api/public/booking/days?from=2026-10-21&to=2026-11-20&items=3',
    );
    expect(daysUrl({ from: '2026-10-21', to: '2026-11-20', items, master: 5 })).toBe(
      '/api/public/booking/days?from=2026-10-21&to=2026-11-20&items=3&masterId=5',
    );
    expect(slotsUrl({ date: '2026-10-21', items, master: 5 })).toBe('/api/public/booking/slots?date=2026-10-21&items=3&masterId=5');
  });

  it('skips empty parameters', () => {
    expect(buildUrl('/x', { a: '', b: null, c: undefined, d: 0 })).toBe('/x?d=0');
    expect(buildUrl('/x')).toBe('/x');
  });

  it('encodes the booking token in paths', () => {
    expect(bookingUrl('abc')).toBe('/api/public/booking/b/abc');
    expect(bookingUrl('a/b')).toBe('/api/public/booking/b/a%2Fb');
    expect(bookingPagePath('abc')).toBe('/book/b/abc');
  });
});

describe('booking page: the booking body', () => {
  const base = {
    items: [{ serviceId: 3, variant: null }, { serviceId: 5, variant: 'Два' }],
    master: 5 as number | 'any',
    startsAt: '2026-10-21T12:00:00.000Z',
    name: '  Анна ',
    phone: '+79991234567',
    comment: '  ',
    website: '',
    linked: false,
  };

  it('sends what the contract asks for, trimmed, without empty optionals', () => {
    expect(bookingBody(base)).toEqual({
      items: [{ serviceId: 3 }, { serviceId: 5, variant: 'Два' }],
      masterId: 5,
      startsAt: '2026-10-21T12:00:00.000Z',
      name: 'Анна',
      phone: '+79991234567',
    });
  });

  it('omits the master for «any», keeps a comment and the honeypot', () => {
    const body = bookingBody({ ...base, master: 'any', comment: ' Хочу титан ', website: 'http://spam' });
    expect(body).not.toHaveProperty('masterId');
    expect(body.comment).toBe('Хочу титан');
    expect(body.website).toBe('http://spam');
  });

  it('leaves out name and phone for a linked Telegram chat', () => {
    const body = bookingBody({ ...base, linked: true });
    expect(body).not.toHaveProperty('name');
    expect(body).not.toHaveProperty('phone');
  });
});

describe('booking page: page URLs', () => {
  it('reads ?service=&master= preselection', () => {
    expect(parsePreselect('?service=12&master=3')).toEqual({ serviceId: 12, masterId: 3 });
    expect(parsePreselect('?service=abc&master=-1')).toEqual({ serviceId: null, masterId: null });
    expect(parsePreselect('?service=0')).toEqual({ serviceId: null, masterId: null });
    expect(parsePreselect('')).toEqual({ serviceId: null, masterId: null });
  });

  it('finds the booking token in /book/b/<token>', () => {
    expect(bookingTokenFromPath('/book/b/abc123')).toBe('abc123');
    expect(bookingTokenFromPath('/book/b/abc123/')).toBe('abc123');
    expect(bookingTokenFromPath('/book/b/a%20b')).toBe('a b');
    expect(bookingTokenFromPath('/book')).toBeNull();
    expect(bookingTokenFromPath('/book/b/')).toBeNull();
    expect(bookingTokenFromPath('/book/b/x/y')).toBeNull();
    expect(bookingTokenFromPath('/book/b/%E0%A4%A')).toBeNull();
  });

  it('puts only http(s) and same-origin links into href', () => {
    expect(safeHref('https://qr.nspk.ru/AS1?type=02')).toBe('https://qr.nspk.ru/AS1?type=02');
    expect(safeHref('/api/public/booking/b/x/calendar.ics')).toBe('/api/public/booking/b/x/calendar.ics');
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('//evil.example/x')).toBeNull();
    expect(safeHref('/\\evil.example/x')).toBeNull();
    expect(safeHref(null)).toBeNull();
    expect(safeHref('')).toBeNull();
  });
});
