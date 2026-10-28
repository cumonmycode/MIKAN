import { describe, expect, it } from 'vitest';
import { createApi, INIT_DATA_HEADER } from '../public/book/lib/api.js';
import { createFlow } from '../public/book/lib/flow.js';
import {
  applyWaitPreselect,
  formatRange,
  parseWaitPreselect,
  presetRange,
  rangeError,
  waitlistBody,
} from '../public/book/lib/waitlist.js';
import { itemsParam } from '../src/domain/waitlist-messages.js';

const NBSP = '\u00a0';
const TZ = 'Europe/Moscow';

const service = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  name: `Услуга ${id}`,
  priceText: '1 000 ₽',
  price: 1000,
  durationMin: 30,
  depositAmount: 0,
  variants: [] as unknown[],
  ...extra,
});
const nipples = service(9, {
  name: 'Соски',
  variants: [
    { name: 'Один', priceText: '2 500 ₽', price: 2500, durationMin: null },
    { name: 'Два', priceText: '4 000 ₽', price: 4000, durationMin: 60 },
  ],
});
const catalog = new Map([service(1), service(2), nipples].map((s) => [s.id, s]));
const masters = [{ id: 3 }, { id: 5 }];

describe('booking page: waitlist dates', () => {
  const today = '2026-10-15';
  const lastDate = '2026-12-14';

  it('starts with the busy day, else the next two weeks within the horizon', () => {
    expect(presetRange({ today, lastDate, date: '2026-10-21' })).toEqual({ from: '2026-10-21', to: '2026-10-21' });
    expect(presetRange({ today, lastDate })).toEqual({ from: '2026-10-15', to: '2026-10-28' });
    expect(presetRange({ today, lastDate: '2026-10-20' })).toEqual({ from: '2026-10-15', to: '2026-10-20' });
    // A day outside the bookable range falls back to the two weeks.
    expect(presetRange({ today, lastDate, date: '2026-10-14' })).toEqual({ from: '2026-10-15', to: '2026-10-28' });
  });

  it('checks the range as the server does', () => {
    const check = (from: string, to: string) => rangeError({ from, to, today, lastDate });
    expect(check('2026-10-15', '2026-11-13')).toBeNull(); // 30 days inclusive
    expect(check('2026-10-15', '2026-11-14')).toBe('Период — не больше 30 дней');
    expect(check('2026-10-14', '2026-10-20')).toBe('Начало — не раньше сегодняшнего дня');
    expect(check('2026-10-21', '2026-10-20')).toBe('Конец периода — не раньше начала');
    expect(check('2026-12-10', '2026-12-15')).toBe(`Онлайн-запись открыта до 14${NBSP}декабря — выберите даты пораньше`);
    expect(check('', '2026-10-20')).toBe('Выберите даты');
  });

  it('names the range in Russian', () => {
    expect(formatRange('2026-10-21', '2026-10-21')).toBe(`21${NBSP}октября`);
    expect(formatRange('2026-10-21', '2026-10-25')).toBe(`21–25${NBSP}октября`);
    expect(formatRange('2026-10-30', '2026-11-03')).toBe(`30${NBSP}октября – 3${NBSP}ноября`);
  });
});

describe('booking page: joining the waitlist', () => {
  const base = {
    items: [{ serviceId: 1, variant: null }, { serviceId: 9, variant: 'Два' }],
    master: 3 as number | 'any' | null,
    from: '2026-10-21',
    to: '2026-10-25',
    note: '  после 18:00 ',
    name: ' Анна ',
    phone: '+79991234567' as string | null,
    website: '',
    linked: false,
  };

  it('builds the body: name and phone unless the chat is linked, «any» master and empty note left out', () => {
    expect(waitlistBody(base)).toEqual({
      items: [{ serviceId: 1 }, { serviceId: 9, variant: 'Два' }],
      dateFrom: '2026-10-21',
      dateTo: '2026-10-25',
      masterId: 3,
      name: 'Анна',
      phone: '+79991234567',
      note: 'после 18:00',
    });
    expect(waitlistBody({ ...base, master: 'any', note: ' ', linked: true, phone: null, website: 'spam' })).toEqual({
      items: [{ serviceId: 1 }, { serviceId: 9, variant: 'Два' }],
      dateFrom: '2026-10-21',
      dateTo: '2026-10-25',
      website: 'spam',
    });
  });

  it('posts to the waitlist path with the Mini App init data', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ id: 7, telegramLink: null }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const api = createApi({ fetch: fetchImpl, initData: 'signed' });
    expect(await api.joinWaitlist({ dateFrom: '2026-10-21' })).toEqual({ id: 7, telegramLink: null });
    expect(calls[0]!.url).toBe('/api/public/booking/waitlist');
    expect(calls[0]!.init.method).toBe('POST');
    expect(new Headers(calls[0]!.init.headers).get(INIT_DATA_HEADER)).toBe('signed');
  });
});

describe('booking page: the freed-time link', () => {
  const start = '2026-10-16T12:00:00.000Z';
  /** The link exactly as the server builds it. */
  const link = (items: Array<{ serviceId: number; variant: string | null }>, master?: number) => {
    const query = new URLSearchParams({ wait: '12', start, items: itemsParam(items) });
    if (master !== undefined) query.set('master', String(master));
    return `?${query.toString()}`;
  };

  it('reads the server’s link', () => {
    expect(parseWaitPreselect(link([{ serviceId: 1, variant: null }, { serviceId: 9, variant: 'Два, с цепочкой' }], 3))).toEqual({
      waitId: 12,
      start,
      items: [{ serviceId: 1, variant: null }, { serviceId: 9, variant: 'Два, с цепочкой' }],
      masterId: 3,
    });
    expect(parseWaitPreselect(link([{ serviceId: 1, variant: null }]))).toMatchObject({ masterId: null });
    expect(parseWaitPreselect('?service=1')).toBeNull();
    expect(parseWaitPreselect('?wait=12&start=nonsense&items=1')).toBeNull();
    expect(parseWaitPreselect('?wait=12&start=2026-10-16T12:00:00.000Z&items=')).toBeNull();
    expect(parseWaitPreselect('?wait=12&start=2026-10-16T12:00:00.000Z&items=x')).toBeNull();
  });

  it('opens the flow on the time step with the services, the master, the day and the time', () => {
    const wait = parseWaitPreselect(link([{ serviceId: 1, variant: null }, { serviceId: 9, variant: 'Два' }], 5))!;
    const state = applyWaitPreselect(createFlow(), wait, catalog, masters, TZ);
    expect(state).toMatchObject({
      step: 'time',
      items: [{ serviceId: 1, variant: null }, { serviceId: 9, variant: 'Два' }],
      master: 5,
      date: '2026-10-16',
      slot: { startsAt: start, masterIds: [] },
    });
    // «Any master» when none (or one that is gone) was wished.
    expect(applyWaitPreselect(createFlow(), { ...wait, masterId: null }, catalog, masters, TZ).master).toBe('any');
    expect(applyWaitPreselect(createFlow(), { ...wait, masterId: 99 }, catalog, masters, TZ).master).toBe('any');
    // The day is the studio's: 23:30 UTC is already the next day in Moscow.
    expect(applyWaitPreselect(createFlow(), { ...wait, start: '2026-10-16T21:30:00.000Z' }, catalog, masters, TZ).date).toBe('2026-10-17');
  });

  it('leaves the flow alone when the catalog no longer has the wish', () => {
    const fresh = createFlow();
    const gone = { waitId: 12, start, items: [{ serviceId: 42, variant: null }], masterId: null };
    expect(applyWaitPreselect(fresh, gone, catalog, masters, TZ)).toBe(fresh);
    const noVariant = { ...gone, items: [{ serviceId: 9, variant: 'Три' }] };
    expect(applyWaitPreselect(fresh, noVariant, catalog, masters, TZ)).toBe(fresh);
  });
});
