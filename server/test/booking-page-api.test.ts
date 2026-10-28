import { describe, expect, it } from 'vitest';
import { ApiError, INIT_DATA_HEADER, createApi, describeError } from '../public/book/lib/api.js';
import {
  AFTER_HOLD_GRACE_MS,
  POLL_AFTER_HOLD_MS,
  POLL_CONFIRMATION_MS,
  POLL_PAYMENT_MS,
  canCancel,
  isUpcoming,
  paymentOpen,
  pollDelay,
  statusChangeMessage,
  statusInfo,
} from '../public/book/lib/booking.js';
import { isTelegramLaunch, themeVariables } from '../public/book/lib/telegram.js';

interface Call {
  url: string;
  init: RequestInit;
}

/** A fake of the public booking API: answers by path, records every request. */
function fakeApi(routes: Record<string, (init: RequestInit) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const key = `${init.method ?? 'GET'} ${url.split('?')[0]}`;
    const route = routes[key];
    if (!route) throw new TypeError(`network down for ${key}`);
    return route(init);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const apiError = (status: number, code: string, message: string) => json({ error: { code, message } }, status);
const header = (call: Call | undefined, name: string) => new Headers(call?.init.headers).get(name);

const booking = {
  token: 'tok_1',
  status: 'awaiting_payment',
  number: 42,
  items: [{ name: 'Мочка', price: 2500 }],
  master: { name: 'Фатима' },
  startsAt: '2026-10-21T12:00:00.000Z',
  endsAt: '2026-10-21T12:30:00.000Z',
  price: 2500,
  depositRequired: 1000,
  holdUntil: '2026-10-19T12:15:00.000Z',
  payment: { payload: 'https://qr.nspk.ru/AS1?type=02', amount: 1000, expiresAt: '2026-10-19T12:15:00.000Z' },
  studio: { name: 'MIKAN STUDIO', address: 'Москва', phone: '+7 999 000-00-00' },
  telegramLink: 'https://t.me/mikan_robot?start=b_tok_1',
  calendarUrl: '/api/public/booking/b/tok_1/calendar.ics',
};

describe('booking page: API client against a fake API', () => {
  it('calls the contract paths and returns the JSON', async () => {
    const { fetchImpl, calls } = fakeApi({
      'GET /api/public/booking/config': () => json({ enabled: true }),
      'GET /api/public/booking/services': () => json({ items: [] }),
      'GET /api/public/booking/days': () => json({ items: [{ date: '2026-10-21', available: true }] }),
      'GET /api/public/booking/b/tok_1': () => json(booking),
      'POST /api/public/booking/b/tok_1/cancel': () => json({ ...booking, status: 'cancelled' }),
    });
    const api = createApi({ fetch: fetchImpl });
    expect(await api.config()).toEqual({ enabled: true });
    expect(await api.services()).toEqual({ items: [] });
    await api.days({ from: '2026-10-21', to: '2026-11-20', items: [{ serviceId: 3, variant: null }], master: 'any' });
    expect(calls[2]?.url).toBe('/api/public/booking/days?from=2026-10-21&to=2026-11-20&items=3');
    expect((await api.booking('tok_1')).number).toBe(42);
    expect((await api.cancel('tok_1')).status).toBe('cancelled');
    expect(calls[4]?.init.method).toBe('POST');
  });

  it('sends the Telegram init data on /me and on booking only', async () => {
    const { fetchImpl, calls } = fakeApi({
      'GET /api/public/booking/me': () => json({ linked: true, name: 'Анна', phone: '+7 *** ***-**-01' }),
      'POST /api/public/booking': () => json(booking),
      'GET /api/public/booking/services': () => json({ items: [] }),
    });
    const api = createApi({ fetch: fetchImpl, initData: 'query_id=1&hash=abc' });
    await api.me();
    await api.book({ items: [{ serviceId: 3 }], startsAt: booking.startsAt });
    await api.services();
    expect(header(calls[0], INIT_DATA_HEADER)).toBe('query_id=1&hash=abc');
    expect(header(calls[1], INIT_DATA_HEADER)).toBe('query_id=1&hash=abc');
    expect(header(calls[1], 'content-type')).toBe('application/json');
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ items: [{ serviceId: 3 }], startsAt: booking.startsAt });
    expect(header(calls[2], INIT_DATA_HEADER)).toBeNull();
    api.dropInitData();
    expect(api.hasInitData()).toBe(false);
    await api.me().catch(() => undefined);
    expect(header(calls[3], INIT_DATA_HEADER)).toBeNull();
  });

  it('sends the idempotency key with the booking only when given', async () => {
    const { fetchImpl, calls } = fakeApi({ 'POST /api/public/booking': () => json(booking) });
    const api = createApi({ fetch: fetchImpl });
    const key = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';
    await api.book({ items: [{ serviceId: 3 }], startsAt: booking.startsAt }, key);
    await api.book({ items: [{ serviceId: 3 }], startsAt: booking.startsAt });
    expect(header(calls[0], 'idempotency-key')).toBe(key);
    expect(header(calls[1], 'idempotency-key')).toBeNull();
  });

  it('turns error bodies into ApiError with the server message', async () => {
    const { fetchImpl } = fakeApi({
      'POST /api/public/booking': () => apiError(409, 'schedule_conflict', 'Это время только что заняли — выберите другое'),
      'GET /api/public/booking/services': () => new Response('<html>Bad gateway</html>', { status: 502 }),
    });
    const api = createApi({ fetch: fetchImpl });
    const conflict = await api.book({}).catch((e: unknown) => e);
    expect(conflict).toBeInstanceOf(ApiError);
    expect(conflict).toMatchObject({ status: 409, code: 'schedule_conflict', message: 'Это время только что заняли — выберите другое' });
    expect(await api.services().catch((e: unknown) => e)).toMatchObject({ status: 502, code: 'http_error', network: false });
  });

  it('reports a dropped connection and a timeout as a network error', async () => {
    const { fetchImpl } = fakeApi({});
    const api = createApi({ fetch: fetchImpl });
    expect(await api.config().catch((e: unknown) => e)).toMatchObject({ network: true, status: 0 });

    const hanging = ((_: unknown, init: RequestInit) =>
      new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as typeof fetch;
    const slow = createApi({ fetch: hanging, timeoutMs: 20 });
    expect(await slow.config().catch((e: unknown) => e)).toMatchObject({ network: true });

    // Headers arrive, the body stalls until the timeout.
    const stalling = (async (_: unknown, init: RequestInit) =>
      new Response(
        new ReadableStream({
          start(controller) {
            init.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;
    const stalled = createApi({ fetch: stalling, timeoutMs: 20 });
    expect(await stalled.config().catch((e: unknown) => e)).toMatchObject({ network: true });
  });

  it('gives the booking itself longer than the other requests', async () => {
    let aborted = 0;
    const answerAfter50ms = ((_: unknown, init: RequestInit) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(json(booking)), 50);
        init.signal?.addEventListener('abort', () => {
          aborted += 1;
          clearTimeout(timer);
          reject(new Error('aborted'));
        });
      })) as typeof fetch;
    const api = createApi({ fetch: answerAfter50ms, timeoutMs: 10, bookTimeoutMs: 1000 });
    expect(await api.config().catch((e: unknown) => e)).toMatchObject({ network: true });
    expect((await api.book({})).token).toBe('tok_1');
    expect(aborted).toBe(1);
  });

  it('learns the server clock from the Date header', async () => {
    const { fetchImpl } = fakeApi({
      'GET /api/public/booking/b/tok_1': () => json(booking, 200, { date: 'Mon, 19 Oct 2026 12:02:00 GMT' }),
    });
    const api = createApi({ fetch: fetchImpl, now: () => Date.parse('2026-10-19T12:00:00.000Z') });
    expect(api.clockOffset()).toBe(0);
    await api.booking('tok_1');
    expect(api.clockOffset()).toBe(120_000);
  });
});

describe('booking page: errors in plain Russian', () => {
  const err = (status: number, code = 'x', message = '') => new ApiError({ status, code, message });

  it('maps each failure to a message and a way out', () => {
    expect(describeError(new ApiError({ status: 0, code: 'network', message: '', network: true }))).toMatchObject({
      title: 'Нет связи',
      action: 'retry',
    });
    expect(describeError(new TypeError('boom')).action).toBe('retry');
    expect(describeError(err(409, 'schedule_conflict', 'Это время только что заняли — выберите другое'))).toEqual({
      title: 'Это время уже заняли',
      message: 'Это время только что заняли — выберите другое',
      action: 'pickTime',
    });
    expect(describeError(err(409, 'conflict', 'У вас уже есть записи, которые ждут подтверждения — дождитесь ответа студии'))).toMatchObject({
      message: 'У вас уже есть записи, которые ждут подтверждения — дождитесь ответа студии',
      action: 'back',
    });
    expect(describeError(err(429, 'rate_limited'))).toMatchObject({ title: 'Слишком много попыток', action: 'retry' });
    expect(describeError(err(403, 'forbidden', 'Онлайн-запись временно недоступна'))).toMatchObject({
      title: 'Онлайн-запись временно недоступна',
      action: 'none',
    });
    expect(describeError(err(404, 'not_found'))).toMatchObject({ title: 'Запись не найдена', action: 'home' });
    expect(describeError(err(400, 'validation_error', 'Проверьте номер телефона'))).toMatchObject({
      message: 'Проверьте номер телефона',
      action: 'back',
    });
    expect(describeError(err(401, 'unauthorized')).title).toMatch(/Telegram/);
    expect(describeError(err(500, 'internal'))).toMatchObject({ title: 'Что-то пошло не так', action: 'retry' });
  });

  it('warns that a booking cut off by the network may already exist', () => {
    const lost = new ApiError({ status: 0, code: 'network', message: '', network: true });
    expect(describeError(lost, { booking: true })).toMatchObject({ title: 'Нет ответа от студии', action: 'retry' });
    expect(describeError(lost, { booking: true }).message).toMatch(/не знаем, успела ли создаться запись/);
    // Answers from the server keep their own meaning.
    expect(describeError(err(409, 'schedule_conflict', 'Занято'), { booking: true }).action).toBe('pickTime');
  });
});

describe('booking page: booking status rules', () => {
  const hold = Date.parse(booking.holdUntil);

  it('names every status', () => {
    expect(statusInfo('awaiting_payment').label).toBe('Ждёт предоплату');
    expect(statusInfo('awaiting_confirmation').label).toBe('Ждёт подтверждения');
    expect(statusInfo('confirmed')).toMatchObject({ label: 'Запись подтверждена', tone: 'success' });
    expect(statusInfo('cancelled').label).toBe('Запись отменена');
    expect(statusInfo('completed').label).toBe('Визит состоялся');
    expect(statusInfo('mystery').label).toBe('Запись');
  });

  it('polls often while a payment is awaited, a bit after the hold, rarely while staff confirm', () => {
    expect(pollDelay(booking, hold - 60_000)).toBe(POLL_PAYMENT_MS);
    expect(pollDelay(booking, hold + 1_000)).toBe(POLL_AFTER_HOLD_MS);
    expect(pollDelay(booking, hold + AFTER_HOLD_GRACE_MS + 1)).toBeNull();
    expect(pollDelay({ ...booking, status: 'awaiting_confirmation' }, hold)).toBe(POLL_CONFIRMATION_MS);
    expect(pollDelay({ ...booking, status: 'confirmed' }, hold)).toBeNull();
    expect(pollDelay({ ...booking, status: 'cancelled' }, hold)).toBeNull();
  });

  it('shows the payment until the hold ends', () => {
    expect(paymentOpen(booking, hold - 1)).toBe(true);
    expect(paymentOpen(booking, hold)).toBe(false);
    expect(paymentOpen({ ...booking, payment: null }, hold - 1)).toBe(false);
    expect(paymentOpen({ ...booking, status: 'confirmed' }, hold - 1)).toBe(false);
  });

  it('lets the client cancel until the start', () => {
    const start = Date.parse(booking.startsAt);
    expect(canCancel(booking, start - 1)).toBe(true);
    expect(canCancel(booking, start)).toBe(false);
    expect(canCancel({ ...booking, status: 'confirmed' }, start - 1)).toBe(true);
    expect(canCancel({ ...booking, status: 'cancelled' }, start - 1)).toBe(false);
    expect(canCancel({ ...booking, status: 'completed' }, start - 1)).toBe(false);
    expect(isUpcoming(booking, Date.parse(booking.endsAt) - 1)).toBe(true);
    expect(isUpcoming(booking, Date.parse(booking.endsAt))).toBe(false);
  });

  it('announces a status that changed while the page was open', () => {
    expect(statusChangeMessage('awaiting_payment', 'confirmed')).toBe('Предоплата получена — запись подтверждена');
    expect(statusChangeMessage('awaiting_payment', 'cancelled')).toBe('Предоплата не поступила вовремя — запись отменена');
    expect(statusChangeMessage('awaiting_confirmation', 'confirmed')).toBe('Студия подтвердила запись');
    expect(statusChangeMessage('confirmed', 'confirmed')).toBeNull();
    expect(statusChangeMessage(null, 'confirmed')).toBeNull();
  });
});

describe('booking page: Telegram detection and theme', () => {
  it('detects a Telegram launch from the URL hash, the webview bridge or saved parameters', () => {
    expect(isTelegramLaunch({ hash: '#tgWebAppData=query_id%3D1&tgWebAppVersion=8.0&tgWebAppPlatform=ios' })).toBe(true);
    expect(isTelegramLaunch({ hash: '#tgWebAppVersion=8.0' })).toBe(true);
    expect(isTelegramLaunch({ hasWebviewProxy: true })).toBe(true);
    expect(isTelegramLaunch({ savedParams: '{"tgWebAppData":"x"}' })).toBe(true);
    expect(isTelegramLaunch({ hash: '#section' })).toBe(false);
    expect(isTelegramLaunch({})).toBe(false);
  });

  it('maps theme parameters to the page variables, ignoring malformed colors', () => {
    expect(
      themeVariables({
        bg_color: '#ffffff',
        text_color: '#000000',
        hint_color: '#999999',
        button_color: '#2481cc',
        button_text_color: '#ffffff',
        secondary_bg_color: '#f0f0f0',
        link_color: 'red; background: url(x)',
      }),
    ).toEqual({
      '--bg': '#ffffff',
      '--surface': '#ffffff',
      '--surface-2': '#f0f0f0',
      '--text': '#000000',
      '--muted': '#999999',
      '--accent': '#2481cc',
      '--on-accent': '#ffffff',
    });
    expect(themeVariables({ section_bg_color: '#1c1c1d', bg_color: '#000000' })['--surface']).toBe('#1c1c1d');
    expect(themeVariables(undefined)).toEqual({});
  });
});
