import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { findClientByChat } from '../domain/clients.js';
import { assertOnlineEnabled } from '../domain/online-booking.js';
import { MAX_BOOKING_ITEMS, parseItemsParam } from '../domain/online-booking-items.js';
import { NOTE_MAX, publicWaitlistEntry } from '../domain/waitlist.js';
import { decoyWaitlistEntry, joinWaitlist, type ClientJoinInput } from '../domain/waitlist-join.js';
import { waitlistTelegramLink } from '../domain/waitlist-messages.js';
import { AppError, badRequest } from '../lib/errors.js';
import { parse, phoneInput } from '../lib/validation.js';
import { telegramUser } from './public-booking.js';

/**
 * `POST /public/booking/waitlist` (docs/API.md «Waitlist»): the booking page and the Mini App put the client on the
 * waitlist. Limited like booking: 20 writes a minute and 5 joins an hour per IP (only joins made and honeypot hits).
 */

const WRITE_LIMIT = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };
export const JOINS_PER_HOUR = 5;

const date = z.string().trim().min(1).max(10);
const item = z.object({ serviceId: z.number().int().positive(), variant: z.string().trim().max(100).nullish() });
const joinBody = z.object({
  // `[{ serviceId, variant? }]`, or the query-string form «5,7:Два».
  items: z.union([z.array(item).min(1).max(MAX_BOOKING_ITEMS), z.string().trim().min(1).max(1000)]),
  masterId: z.number().int().positive().nullish(),
  dateFrom: date,
  dateTo: date,
  name: z.string().trim().max(100).nullish(),
  phone: phoneInput,
  note: z.string().trim().max(NOTE_MAX).nullish(),
  /** The honeypot: people never see it, bots fill it in. */
  website: z.string().max(1000).nullish(),
});

export function publicWaitlistRoutes(app: FastifyInstance, ctx: AppContext): void {
  const joinLimit = app.createRateLimit({ max: JOINS_PER_HOUR, timeWindow: '1 hour' });

  app.post('/waitlist', WRITE_LIMIT, async (request) => {
    assertOnlineEnabled(ctx.db);
    const body = parse(joinBody, request.body);
    const user = telegramUser(ctx, request);
    const linked = user ? findClientByChat(ctx.db, user.id) : null;
    if (!linked && !body.name) throw badRequest('«Имя»: обязательное поле');
    if (!linked && !body.phone) throw badRequest('«Телефон»: обязательное поле');
    const input: ClientJoinInput = {
      channel: user ? 'miniapp' : 'web',
      items: typeof body.items === 'string' ? parseItemsParam(body.items) : body.items,
      masterId: body.masterId ?? null,
      dateFrom: body.dateFrom,
      dateTo: body.dateTo,
      note: body.note ?? null,
      clientId: linked?.id ?? null,
      name: body.name ?? null,
      phone: body.phone ?? null,
      chatId: user?.id ?? null,
    };
    const limit = await joinLimit(request, { increment: false });
    if (!limit.isAllowed && limit.remaining <= 0) {
      throw new AppError('rate_limited', 'Слишком много заявок с этого устройства — попробуйте позже или позвоните в студию');
    }
    const botUsername = ctx.gateway.username();
    if (body.website?.trim()) {
      // A bot: answered as if joined, nothing stored.
      const decoy = decoyWaitlistEntry(ctx, input);
      await joinLimit(request);
      request.log.info({ ip: request.ip }, 'waitlist honeypot triggered');
      return { ...decoy, telegramLink: waitlistTelegramLink(botUsername, decoy.id) };
    }
    const { row } = await joinWaitlist(ctx, input);
    await joinLimit(request);
    return { ...publicWaitlistEntry(ctx.db, row), telegramLink: waitlistTelegramLink(botUsername, row.id) };
  });
}
