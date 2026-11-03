import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError, createApi } from '../public/book/lib/api.js';
import { CLIENT_TOKEN_HEADER, createCabinetApi } from '../public/book/lib/cabinet-api.js';
import {
  appointmentStatus,
  appointmentTitle,
  bonusesText,
  bonusOperationLabel,
  botSignInLink,
  cancelNotice,
  dateRange,
  dayMonth,
  describeCabinetError,
  expiringText,
  freeCancellationLine,
  isCabinetPath,
  lastValidDate,
  memoSteps,
  readToken,
  rescheduleDaysUrl,
  rescheduleSlotsUrl,
  saveToken,
  shortDate,
  signedAmount,
  signInCopy,
  stepDayLabel,
  takeToken,
  TOKEN_STORAGE_KEY,
  waitlistSummary,
} from '../public/book/lib/cabinet.js';
import { createTestApp, type TestApp } from './helpers.js';

const TZ = 'Europe/Moscow';
/** Thursday 15 October, before the sample appointment. */
const BEFORE = Date.parse('2026-10-15T09:00:00.000Z');
const NBSP = '\u00a0';
const TOKEN = 'A'.repeat(20) + '_-' + 'b9'.repeat(10) + 'x'; // 43 chars of base64url

/** A `CabinetAppointment` on Saturday 17 October 12:00 Moscow. */
const appointment = (extra: Record<string, unknown> = {}) => ({
  id: 7,
  startsAt: '2026-10-17T09:00:00.000Z',
  endsAt: '2026-10-17T10:00:00.000Z',
  status: 'scheduled',
  onlineState: null,
  items: [{ name: 'Мочка', price: 1600 }, { name: 'Хеликс', price: 3000 }],
  master: { name: 'Фатима' },
  price: 4600,
  deposit: 0,
  depositRequired: 0,
  freeCancellationUntil: null,
  canReschedule: true,
  canCancel: true,
  bookingToken: null,
  ...extra,
});

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    map,
  };
}

describe('cabinet page: the sign-in link', () => {
  it('recognises the cabinet path', () => {
    expect(isCabinetPath('/book/me')).toBe(true);
    expect(isCabinetPath('/book/me/')).toBe(true);
    expect(isCabinetPath('/book/men')).toBe(false);
    expect(isCabinetPath('/book/b/me')).toBe(false);
    expect(isCabinetPath('/book')).toBe(false);
  });

  it('takes the token out of the URL, keeping the rest', () => {
    expect(takeToken(`https://mikan.example/book/me#t=${TOKEN}`)).toEqual({ token: TOKEN, cleanUrl: '/book/me' });
    expect(takeToken(`https://mikan.example/book/me?x=1#a=2&t=${TOKEN}`)).toEqual({ token: TOKEN, cleanUrl: '/book/me?x=1#a=2' });
    expect(takeToken(`https://mikan.example/book/me?t=${TOKEN}`)).toEqual({ token: TOKEN, cleanUrl: '/book/me' });
    expect(takeToken(`https://mikan.example/book/me?x=1&t=${TOKEN}#tgWebAppData=1`)).toEqual({ token: TOKEN, cleanUrl: '/book/me?x=1#tgWebAppData=1' });
    expect(takeToken('https://mikan.example/book/me?t=<script>')).toEqual({ token: null, cleanUrl: '/book/me' });
    expect(takeToken('https://mikan.example/book/me')).toEqual({ token: null, cleanUrl: null });
  });

  it('keeps the token in storage, and survives storage that throws', () => {
    const storage = memoryStorage();
    expect(readToken(storage)).toBeNull();
    saveToken(storage, TOKEN);
    expect(storage.map.get(TOKEN_STORAGE_KEY)).toBe(TOKEN);
    expect(readToken(storage)).toBe(TOKEN);
    saveToken(storage, null);
    expect(readToken(storage)).toBeNull();
    expect(readToken(memoryStorage({ [TOKEN_STORAGE_KEY]: 'garbage' }))).toBeNull();
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => undefined };
    expect(readToken(broken)).toBeNull();
    expect(() => saveToken(broken, TOKEN)).not.toThrow();
    expect(readToken(null)).toBeNull();
  });

  it('says how to sign in: in Telegram share the phone, on the website get a link from the bot', () => {
    expect(signInCopy({ inTelegram: true }).title).toBe('Нужен ваш номер');
    expect(signInCopy({ inTelegram: true, reason: 'expired' }).title).toBe('Откройте кабинет заново');
    expect(signInCopy({ inTelegram: true }).message).toContain('«📱 Поделиться номером»');
    expect(signInCopy({ inTelegram: false })).toEqual({
      title: 'Личный кабинет',
      message: 'Здесь ваши записи, бонусы и памятки по уходу. Чтобы войти, в чате со студией в Telegram нажмите «👤 Мои записи и бонусы» или отправьте /me — бот пришлёт ссылку для входа.',
    });
    expect(signInCopy({ inTelegram: false, reason: 'expired' }).title).toBe('Ссылка для входа устарела');
    expect(signInCopy({ inTelegram: false, reason: 'expired' }).message).toMatch(/^Получите новую: в чате со студией/);
    expect(signInCopy({ inTelegram: false, reason: 'loggedOut' })).toMatchObject({ title: 'Вы вышли из кабинета', message: expect.stringMatching(/^Чтобы войти снова, в чате/) });
    expect(botSignInLink('mikan_bot')).toBe('https://t.me/mikan_bot?start=me');
    expect(botSignInLink(null)).toBeNull();
    expect(botSignInLink('bad name/')).toBeNull();
  });
});

describe('cabinet page: appointments', () => {
  it('names the status, an unsettled online state first', () => {
    expect(appointmentStatus(appointment(), BEFORE)).toEqual({ label: 'Вы записаны', tone: 'success' });
    // Ended but not closed by staff yet.
    expect(appointmentStatus(appointment(), Date.parse('2026-10-17T10:00:00.000Z'))).toEqual({ label: 'Визит прошёл', tone: 'muted' });
    expect(appointmentStatus(appointment({ status: 'confirmed' }), BEFORE)).toEqual({ label: 'Подтверждена', tone: 'success' });
    expect(appointmentStatus(appointment({ onlineState: 'awaiting_payment' }), BEFORE)).toEqual({ label: 'Ждёт предоплату', tone: 'warning' });
    expect(appointmentStatus(appointment({ onlineState: 'awaiting_confirmation' }), BEFORE)).toEqual({ label: 'Ждёт подтверждения', tone: 'warning' });
    expect(appointmentStatus(appointment({ status: 'cancelled', onlineState: 'awaiting_payment' }), BEFORE).label).toBe('Отменена');
    expect(appointmentStatus(appointment({ status: 'completed' }), BEFORE).label).toBe('Визит состоялся');
    expect(appointmentStatus(appointment({ status: 'no_show' }), BEFORE).label).toBe('Неявка');
    expect(appointmentTitle(appointment())).toBe('Мочка, Хеликс');
    expect(appointmentTitle(appointment({ items: [] }))).toBe('Процедура');
  });

  it('explains what cancelling costs: nothing without a prepayment, free until the rule\'s time, the rule after it', () => {
    const now = Date.parse('2026-10-15T09:00:00.000Z');
    const options = { cancellationText: 'Бесплатно отменить можно не позднее чем за 24 часа.', timeZone: TZ };
    expect(cancelNotice(appointment(), now, options)).toEqual({
      title: 'Отменить запись?',
      text: `суббота, 17${NBSP}октября, 12:00 — Мочка, Хеликс.`,
      late: false,
    });
    expect(cancelNotice(appointment({ depositRequired: 1000 }), now, options).text).toMatch(/Предоплата не внесена — отмена ничего не стоит\.$/);
    const prepaid = appointment({ deposit: 1000, depositRequired: 1000, freeCancellationUntil: '2026-10-16T09:00:00.000Z' });
    expect(cancelNotice(prepaid, now, options)).toMatchObject({ late: false, text: expect.stringMatching(/Сейчас отмена бесплатная: студия вернёт предоплату 1\u00a0000\u00a0₽\.$/) });
    const late = cancelNotice(prepaid, Date.parse('2026-10-16T10:00:00.000Z'), options);
    expect(late.late).toBe(true);
    expect(late.text).toBe(
      `суббота, 17${NBSP}октября, 12:00 — Мочка, Хеликс. Бесплатная отмена уже недоступна (была до пятница, 16${NBSP}октября, 12:00). ` +
        `Предоплата 1${NBSP}000${NBSP}₽ — по правилам студии. Бесплатно отменить можно не позднее чем за 24 часа.`,
    );
    // No free cancellation at all (freeHours 0).
    expect(cancelNotice(appointment({ deposit: 500 }), now, { timeZone: TZ }).late).toBe(true);
  });

  it('shows the free cancellation deadline while it is ahead', () => {
    const a = appointment({ freeCancellationUntil: '2026-10-16T09:00:00.000Z' });
    expect(freeCancellationLine(a, Date.parse('2026-10-15T09:00:00.000Z'), TZ)).toBe(`Бесплатная отмена — до 16${NBSP}октября, 12:00`);
    expect(freeCancellationLine(a, Date.parse('2026-10-16T09:00:01.000Z'), TZ)).toBeNull();
    expect(freeCancellationLine(appointment(), 0, TZ)).toBeNull();
  });

  it('builds the reschedule URLs', () => {
    expect(rescheduleDaysUrl(7, { from: '2026-10-15', to: '2026-10-28' })).toBe('/api/public/cabinet/appointments/7/days?from=2026-10-15&to=2026-10-28');
    expect(rescheduleSlotsUrl(7, { date: '2026-10-16' })).toBe('/api/public/cabinet/appointments/7/slots?date=2026-10-16');
  });
});

describe('cabinet page: dates, bonuses, memos and the waitlist', () => {
  it('writes days and ranges', () => {
    expect(dayMonth('2026-10-21')).toBe(`21${NBSP}октября`);
    expect(shortDate('2026-10-21', '2026-10-15')).toBe(`21${NBSP}октября`);
    expect(shortDate('2027-10-21', '2026-10-15')).toBe(`21${NBSP}октября 2027`);
    expect(dateRange('2026-10-20', '2026-10-25')).toBe(`20–25${NBSP}октября`);
    expect(dateRange('2026-10-30', '2026-11-02')).toBe(`30 октября – 2${NBSP}ноября`);
    expect(dateRange('2026-10-20', '2026-10-20')).toBe(`20${NBSP}октября`);
  });

  it('counts bonuses and says until when they are valid (they burn at the start of the next day)', () => {
    expect(bonusesText(1)).toBe('1 бонус');
    expect(bonusesText(3)).toBe('3 бонуса');
    expect(bonusesText(1200)).toBe(`1${NBSP}200 бонусов`);
    expect(lastValidDate('2026-11-02T21:00:00.000Z', TZ)).toBe('2026-11-02'); // 3 November 00:00 Moscow
    expect(expiringText({ amount: 500, at: '2026-11-02T21:00:00.000Z' }, TZ)).toBe(`500 бонусов действуют до 2${NBSP}ноября`);
    expect(expiringText(null, TZ)).toBeNull();
    expect(signedAmount(500)).toBe('+500');
    expect(signedAmount(-1200)).toBe(`−1${NBSP}200`);
    expect(['earn', 'spend', 'gift', 'expire'].map((type) => bonusOperationLabel({ type, amount: type === 'spend' || type === 'expire' ? -1 : 1 }))).toEqual([
      'Начислено за покупку', 'Оплата бонусами', 'Подарок', 'Сгорели',
    ]);
    expect(bonusOperationLabel({ type: 'adjust', amount: 100 })).toBe('Начислено студией');
    expect(bonusOperationLabel({ type: 'adjust', amount: -100 })).toBe('Списано студией');
    expect(bonusOperationLabel({ type: 'reverse', amount: -100 })).toBe('Списаны при возврате покупки');
  });

  it('dates the aftercare steps and marks today\'s', () => {
    expect(stepDayLabel(0)).toBe('В день процедуры');
    expect(stepDayLabel(1)).toBe('Через 1 день');
    expect(stepDayLabel(3)).toBe('Через 3 дня');
    expect(stepDayLabel(7)).toBe('Через 7 дней');
    const memo = { date: '2026-10-12', steps: [{ day: 0, text: 'А' }, { day: 3, text: 'Б' }] };
    expect(memoSteps(memo, '2026-10-15')).toEqual([
      { day: 0, text: 'А', date: '2026-10-12', today: false },
      { day: 3, text: 'Б', date: '2026-10-15', today: true },
    ]);
  });

  it('sums up a waitlist entry', () => {
    const entry = {
      items: [{ name: 'Соски', variant: 'Два' }, { name: 'Мочка', variant: null }], master: { name: 'Фатима' }, dateFrom: '2026-10-20', dateTo: '2026-10-25', status: 'waiting',
    };
    expect(waitlistSummary(entry)).toEqual({ title: 'Соски — Два, Мочка', details: `20–25${NBSP}октября · мастер Фатима`, notice: null });
    expect(waitlistSummary({ ...entry, master: null, status: 'notified' })).toEqual({
      title: 'Соски — Два, Мочка',
      details: `20–25${NBSP}октября · любой мастер`,
      notice: 'Освободилось время — мы написали вам в Telegram',
    });
  });

  it('turns failures into what to do next', () => {
    const err = (status: number, code = 'x', message = '') => new ApiError({ status, code, message });
    expect(describeCabinetError(new ApiError({ status: 0, code: 'network', message: '', network: true })).action).toBe('retry');
    expect(describeCabinetError(new TypeError('x')).action).toBe('retry');
    expect(describeCabinetError(err(401, 'unauthorized', 'Войдите через Telegram-бота студии'))).toEqual({
      title: 'Нужно войти снова', message: 'Войдите через Telegram-бота студии', action: 'signIn',
    });
    expect(describeCabinetError(err(409, 'schedule_conflict', 'Это время уже занято')).action).toBe('pickTime');
    expect(describeCabinetError(err(400, 'validation_error', 'Это время уже недоступно'))).toMatchObject({ message: 'Это время уже недоступно', action: 'pickTime' });
    expect(describeCabinetError(err(403)).action).toBe('none');
    expect(describeCabinetError(err(404)).action).toBe('reload');
    expect(describeCabinetError(err(409, 'conflict', 'Запись уже отменена'))).toMatchObject({ message: 'Запись уже отменена', action: 'reload' });
    expect(describeCabinetError(err(429)).action).toBe('retry');
    expect(describeCabinetError(err(500)).action).toBe('retry');
  });
});

describe('cabinet page: the API client', () => {
  interface Call {
    url: string;
    init: RequestInit;
  }
  function fakeFetch(answer: (call: Call) => Response) {
    const calls: Call[] = [];
    const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const call = { url: String(input), init };
      calls.push(call);
      return answer(call);
    }) as typeof fetch;
    return { fetchImpl, calls };
  }
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const header = (call: Call | undefined, name: string) => new Headers(call?.init.headers).get(name);

  it('sends the website token, calls every endpoint and accepts 204', async () => {
    const { fetchImpl, calls } = fakeFetch((call) => (call.init.method === 'DELETE' || call.url.endsWith('/logout') ? new Response(null, { status: 204 }) : json({ ok: true })));
    const cabinet = createCabinetApi({ api: createApi({ fetch: fetchImpl }), token: TOKEN });
    expect(cabinet.canSignIn()).toBe(true);
    await cabinet.cabinet();
    await cabinet.bonuses();
    await cabinet.days(7, { from: '2026-10-15', to: '2026-10-28' });
    await cabinet.slots(7, { date: '2026-10-16' });
    await cabinet.reschedule(7, '2026-10-16T09:30:00.000Z');
    await cabinet.cancel(7);
    expect(await cabinet.leaveWaitlist(3)).toBeNull();
    expect(await cabinet.logout()).toBeNull();
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      'GET /api/public/cabinet',
      'GET /api/public/cabinet/bonuses',
      'GET /api/public/cabinet/appointments/7/days?from=2026-10-15&to=2026-10-28',
      'GET /api/public/cabinet/appointments/7/slots?date=2026-10-16',
      'POST /api/public/cabinet/appointments/7/reschedule',
      'POST /api/public/cabinet/appointments/7/cancel',
      'DELETE /api/public/cabinet/waitlist/3',
      'POST /api/public/cabinet/logout',
    ]);
    expect(calls.every((c) => header(c, CLIENT_TOKEN_HEADER) === TOKEN)).toBe(true);
    expect(calls.every((c) => header(c, 'X-Telegram-Init-Data') === null)).toBe(true);
    expect(JSON.parse(String(calls[4]!.init.body))).toEqual({ startsAt: '2026-10-16T09:30:00.000Z' });
    cabinet.forgetToken();
    expect(cabinet.canSignIn()).toBe(false);
    await cabinet.cabinet();
    expect(header(calls.at(-1), CLIENT_TOKEN_HEADER)).toBeNull();
  });

  it('inside Telegram sends the init data instead of a token, and passes errors on as ApiError', async () => {
    const { fetchImpl, calls } = fakeFetch(() => json({ error: { code: 'unauthorized', message: 'Войдите через Telegram-бота студии' } }, 401));
    const cabinet = createCabinetApi({ api: createApi({ fetch: fetchImpl, initData: 'query_id=1&hash=abc' }), token: TOKEN });
    const error = await cabinet.cabinet().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 401, code: 'unauthorized', message: 'Войдите через Telegram-бота студии' });
    expect(header(calls[0], 'X-Telegram-Init-Data')).toBe('query_id=1&hash=abc');
    expect(header(calls[0], CLIENT_TOKEN_HEADER)).toBeNull();
  });
});

describe('cabinet page: served by the server', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ env: { PUBLIC_URL: 'https://mikan.example' } });
  });
  afterAll(() => t.close());

  it('serves /book/me (with the website link) as the page, not indexed, with the cabinet styles', async () => {
    for (const url of ['/book/me', `/book/me?t=${TOKEN}`, '/book/me/']) {
      const res = await t.app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['x-robots-tag']).toBe('noindex');
      expect(res.body).toMatch(/<link rel="stylesheet" href="\/book\/v\/[0-9a-f]+\/cabinet\.css">/);
      expect(res.body).toMatch(/<link rel="modulepreload" href="\/book\/v\/[0-9a-f]+\/cabinet-app\.js">/);
    }
    expect((await t.app.inject({ method: 'GET', url: '/book/menu' })).headers['x-robots-tag']).toBeUndefined();
    const css = await t.app.inject({ method: 'GET', url: '/book/cabinet.css' });
    expect(css.statusCode).toBe(200);
    expect(css.headers['content-type']).toContain('text/css');
  });
});
