import type { FastifyInstance, FastifyRequest } from 'fastify';
import { DateTime } from 'luxon';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { findClientByChat } from '../domain/clients.js';
import { pendingDepositCodes } from '../domain/deposits.js';
import {
  assertOnlineEnabled,
  checkOnlineBooking,
  createOnlineBooking,
  findBookingByToken,
  type OnlineBookingInput,
} from '../domain/online-booking.js';
import { MAX_BOOKING_ITEMS, parseItemsParam, resolveItems } from '../domain/online-booking-items.js';
import { cancelOnlineBookingByClient } from '../domain/online-booking-lifecycle.js';
import {
  bookingIcs,
  decoyBooking,
  publicBookingOut,
  publicConfig,
  publicMasters,
  publicServices,
  publicStatus,
  type PublicBooking,
} from '../domain/online-booking-public.js';
import { assertOnlineMaster, availableDays, availableStarts, bookingDates } from '../domain/online-booking-slots.js';
import { refreshQrPayment } from '../domain/qr-payments.js';
import { getAppointmentRow } from '../domain/refs.js';
import { getStudioSettings, studioTimezone } from '../domain/settings.js';
import { isPlausibleBirthday } from '../lib/birthday.js';
import { AppError, badRequest, errorMessage, notFound } from '../lib/errors.js';
import { idempotentAsync, PUBLIC_IDEMPOTENCY_SCOPE } from '../lib/idempotency.js';
import { validateInitData, type TelegramWebAppUser } from '../lib/telegram-webapp.js';
import { localDate, toIso } from '../lib/time.js';
import { birthdayDate, calendarDate, instant, parse, phoneInput } from '../lib/validation.js';

/**
 * The public booking API (docs/API.md «Online booking»): no auth, for the booking page and the Telegram Mini App.
 * Every route is rate-limited per IP; booking itself 5 times an hour per IP.
 */

export const INIT_DATA_HEADER = 'x-telegram-init-data';
/** Reads of the page (it polls a pending payment every few seconds). */
const READ_LIMIT = { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } };
const WRITE_LIMIT = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };
export const BOOKINGS_PER_HOUR = 5;
/** Days `GET /days` answers without `to`. */
const DEFAULT_DAYS = 14;

const id = z.coerce.number().int().positive();
const itemsQuery = z.string().trim().max(1000).optional();
const daysQuery = z.object({ from: calendarDate, to: calendarDate, items: itemsQuery, masterId: id.optional() });
const slotsQuery = z.object({ date: calendarDate, items: itemsQuery, masterId: id.optional() });
const tokenParams = z.object({ token: z.string().trim().max(100) });
const bookingItem = z.object({ serviceId: z.number().int().positive(), variant: z.string().trim().max(100).nullish() });
const bookBody = z.object({
  // `[{ serviceId, variant? }]`, or the query-string form «5,7:Два».
  items: z.union([z.array(bookingItem).min(1).max(MAX_BOOKING_ITEMS), z.string().trim().min(1).max(1000)]),
  masterId: z.number().int().positive().nullish(),
  startsAt: instant,
  name: z.string().trim().max(100).nullish(),
  phone: phoneInput,
  comment: z.string().trim().max(1000).nullish(),
  /** Optional: fills a card that has none (`YYYY-MM-DD`, 1900 = year unknown). */
  birthday: birthdayDate,
  /** The honeypot: people never see it, bots fill it in. */
  website: z.string().max(1000).nullish(),
});

/** `400` «Дата рождения» unless it is a real birthday a client could have (not in the future, not 120+ years ago). */
export function assertClientBirthday(ctx: AppContext, birthday: string | null | undefined): void {
  if (birthday && !isPlausibleBirthday(birthday, localDate(Date.now(), studioTimezone(ctx.db)))) {
    throw badRequest('«Дата рождения»: проверьте дату — например, 12.04.1995 или только день и месяц');
  }
}

/** «+7 *** ***-**-01» — enough for the person to recognise their number. */
export function maskPhone(phone: string | null): string | null {
  const digits = phone?.replace(/\D/g, '') ?? '';
  if (digits.length < 4) return null;
  const tail = digits.slice(-2);
  return digits.length === 11 && digits.startsWith('7') ? `+7 *** ***-**-${tail}` : `+${digits[0]}*** ***-**-${tail}`;
}

export function telegramUser(ctx: AppContext, request: FastifyRequest): TelegramWebAppUser | null {
  const header = request.headers[INIT_DATA_HEADER];
  if (header === undefined) return null;
  const user = validateInitData(Array.isArray(header) ? header[0] : header, ctx.config.telegram.token);
  if (!user) throw new AppError('unauthorized', 'Не удалось проверить данные Telegram — откройте запись из бота заново');
  return user;
}

function requireBooking(ctx: AppContext, token: string) {
  const row = findBookingByToken(ctx.db, token);
  if (!row) throw notFound('Запись не найдена — проверьте ссылку');
  return row;
}

export function publicBookingRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;
  const bookingLimit = app.createRateLimit({ max: BOOKINGS_PER_HOUR, timeWindow: '1 hour' });

  app.get('/config', READ_LIMIT, async () => publicConfig(ctx));

  app.get('/services', READ_LIMIT, async () => ({ items: publicServices(db) }));

  app.get('/masters', READ_LIMIT, async () => ({ items: publicMasters(db) }));

  app.get('/days', READ_LIMIT, async (request) => {
    assertOnlineEnabled(db);
    const q = parse(daysQuery, request.query);
    const now = Date.now();
    const items = resolveItems(db, parseItemsParam(q.items));
    if (q.masterId !== undefined) assertOnlineMaster(db, q.masterId);
    const from = q.from ?? bookingDates(db, now).first;
    const to = q.to ?? DateTime.fromISO(from, { zone: 'utc' }).plus({ days: DEFAULT_DAYS - 1 }).toISODate()!;
    return { items: availableDays(db, { from, to, durationMin: items.durationMin, masterId: q.masterId, now }) };
  });

  app.get('/slots', READ_LIMIT, async (request) => {
    assertOnlineEnabled(db);
    const q = parse(slotsQuery, request.query);
    if (!q.date) throw badRequest('«Дата»: обязательное поле');
    const items = resolveItems(db, parseItemsParam(q.items));
    if (q.masterId !== undefined) assertOnlineMaster(db, q.masterId);
    const starts = availableStarts(db, { date: q.date, durationMin: items.durationMin, masterId: q.masterId, now: Date.now() });
    return {
      date: q.date,
      durationMin: items.durationMin,
      items: starts.map((s) => ({ startsAt: toIso(s.startsAt), masterIds: s.masterIds })),
    };
  });

  app.get('/me', READ_LIMIT, async (request) => {
    const user = telegramUser(ctx, request);
    if (!user) throw new AppError('unauthorized', 'Откройте запись из Telegram-бота студии');
    const client = findClientByChat(db, user.id);
    return client
      ? { linked: true, name: client.name, phone: maskPhone(client.phone), hasBirthday: client.birthday != null }
      : { linked: false, name: null, phone: null, hasBirthday: false };
  });

  app.post('/', WRITE_LIMIT, async (request, reply) => {
    const body = parse(bookBody, request.body);
    const user = telegramUser(ctx, request);
    const linked = user ? findClientByChat(db, user.id) : null;
    if (!linked && !body.name) throw badRequest('«Имя»: обязательное поле');
    if (!linked && !body.phone) throw badRequest('«Телефон»: обязательное поле');
    assertClientBirthday(ctx, body.birthday);
    const input: OnlineBookingInput = {
      channel: user ? 'miniapp' : 'web',
      items: typeof body.items === 'string' ? parseItemsParam(body.items) : body.items,
      masterId: body.masterId ?? null,
      startsAt: body.startsAt,
      comment: body.comment ?? null,
      clientId: linked?.id ?? null,
      name: body.name ?? null,
      phone: body.phone ?? null,
      chatId: user?.id ?? null,
      birthday: body.birthday ?? null,
    };
    // A retry with the same Idempotency-Key gets the booking already made, not a second one.
    return idempotentAsync(db, request, reply, PUBLIC_IDEMPOTENCY_SCOPE, async (): Promise<PublicBooking> => {
      // Only bookings made (and honeypot hits) count, so a few taken times do not lock a person out.
      const limit = await bookingLimit(request, { increment: false });
      if (!limit.isAllowed && limit.remaining <= 0) {
        throw new AppError('rate_limited', 'Слишком много записей с этого устройства — попробуйте позже или позвоните в студию');
      }
      if (body.website?.trim()) {
        // A bot: answered as if booked, nothing stored.
        const check = checkOnlineBooking(ctx, input);
        await bookingLimit(request);
        request.log.info({ ip: request.ip }, 'online booking honeypot triggered');
        return decoyBooking(ctx, check);
      }
      const result = await createOnlineBooking(ctx, input);
      await bookingLimit(request);
      return publicBookingOut(ctx, result.appointment);
    });
  });

  app.get('/b/:token', READ_LIMIT, async (request) => {
    const { token } = parse(tokenParams, request.params);
    let row = requireBooking(ctx, token);
    const [code] = publicStatus(row) === 'awaiting_payment' ? pendingDepositCodes(db, row.id) : [];
    if (code) {
      // The page polls while the client pays: the bank is asked at most every 2 s.
      try {
        await refreshQrPayment(ctx, code.id);
      } catch (err) {
        request.log.warn({ err: errorMessage(err) }, 'online booking payment check failed');
      }
      row = getAppointmentRow(db, row.id);
    }
    return publicBookingOut(ctx, row);
  });

  app.post('/b/:token/cancel', WRITE_LIMIT, async (request) => {
    const { token } = parse(tokenParams, request.params);
    return publicBookingOut(ctx, await cancelOnlineBookingByClient(ctx, token));
  });

  app.get('/b/:token/calendar.ics', READ_LIMIT, async (request, reply) => {
    const { token } = parse(tokenParams, request.params);
    const row = requireBooking(ctx, token);
    const studio = getStudioSettings(db);
    reply
      .type('text/calendar; charset=utf-8')
      .header('content-disposition', `attachment; filename="${studio.name.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase() || 'booking'}-${row.id}.ics"`);
    return bookingIcs(ctx, row);
  });
}
