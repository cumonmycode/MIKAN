import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { assertChangeable, cancelFromCabinet, ownAppointment, rescheduleFromCabinet } from '../domain/cabinet-actions.js';
import { CABINET_SIGN_IN, clientByCabinetToken, revokeCabinetToken } from '../domain/cabinet-access.js';
import { durationOf, rescheduleDays, rescheduleStarts } from '../domain/cabinet-slots.js';
import { buildCabinet, cabinetAppointment, cabinetBonuses } from '../domain/cabinet.js';
import { auditBirthdayGiven, fillBirthday } from '../domain/client-birthday.js';
import { findClientByChat } from '../domain/clients.js';
import { assertOnlineEnabled } from '../domain/online-booking.js';
import { cancelWaitlistEntry } from '../domain/waitlist.js';
import { badRequest, conflict, unauthorized } from '../lib/errors.js';
import type { AppointmentRow, ClientRow } from '../lib/serialize.js';
import { validateInitData } from '../lib/telegram-webapp.js';
import { toIso } from '../lib/time.js';
import { birthdayDate, calendarDate, instant, parse } from '../lib/validation.js';
import { assertClientBirthday, INIT_DATA_HEADER, maskPhone } from './public-booking.js';

/**
 * The client cabinet API (docs/API.md «Client cabinet»): no staff auth. The client is the card linked to the Mini App
 * chat (`X-Telegram-Init-Data`) or of a website sign-in link (`X-Client-Token`); without either — `401`. Limited per
 * IP like the public booking routes.
 */

export const CLIENT_TOKEN_HEADER = 'x-client-token';
const READ_LIMIT = { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } };
const WRITE_LIMIT = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };

const idParams = z.object({ id: z.coerce.number().int().positive() });
const rescheduleBody = z.object({ startsAt: instant });
const daysQuery = z.object({ from: calendarDate, to: calendarDate });
const slotsQuery = z.object({ date: calendarDate });
const birthdayBody = z.object({ birthday: birthdayDate });
const BIRTHDAY_SET = 'Дата рождения уже указана — изменить её можно через студию';

interface CabinetIdentity {
  client: ClientRow;
  /** The website sign-in token; null in the Mini App. */
  token: string | null;
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** The Mini App's init data wins over a token; anything invalid is `401` (never a fallback to the other). */
export function identify(ctx: AppContext, request: FastifyRequest): CabinetIdentity {
  const initData = headerValue(request, INIT_DATA_HEADER);
  if (initData !== undefined) {
    const user = validateInitData(initData, ctx.config.telegram.token);
    const client = user ? findClientByChat(ctx.db, user.id) : null;
    if (!client) throw unauthorized(CABINET_SIGN_IN);
    return { client, token: null };
  }
  const token = headerValue(request, CLIENT_TOKEN_HEADER)?.trim();
  const client = token ? clientByCabinetToken(ctx.db, token) : null;
  if (!client || !token) throw unauthorized(CABINET_SIGN_IN);
  return { client, token };
}

export function publicCabinetRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  /** The client's own appointment that can still be moved (while online booking is on). */
  const movable = (clientId: number, id: number): AppointmentRow => {
    assertOnlineEnabled(db);
    const row = ownAppointment(db, clientId, id);
    assertChangeable(row, Date.now(), 'перенести');
    return row;
  };

  app.get('/', READ_LIMIT, async (request) => {
    const { client } = identify(ctx, request);
    const cabinet = buildCabinet(db, client);
    return { ...cabinet, client: { ...cabinet.client, phone: maskPhone(cabinet.client.phone) } };
  });

  // «Добавьте дату рождения — пришлём подарок»: only while the card has none (staff change it otherwise).
  app.post('/birthday', WRITE_LIMIT, async (request) => {
    const { client } = identify(ctx, request);
    const { birthday } = parse(birthdayBody, request.body);
    if (!birthday) throw badRequest('«Дата рождения»: обязательное поле');
    assertClientBirthday(ctx, birthday);
    if (client.birthday) throw conflict(BIRTHDAY_SET);
    const saved = fillBirthday(db, client.id, birthday);
    if (!saved) throw conflict(BIRTHDAY_SET);
    auditBirthdayGiven(ctx, saved, 'cabinet');
    return { birthday: saved.birthday };
  });

  app.get('/bonuses', READ_LIMIT, async (request) => cabinetBonuses(db, identify(ctx, request).client.id));

  app.get('/appointments/:id/days', READ_LIMIT, async (request) => {
    const { client } = identify(ctx, request);
    const row = movable(client.id, parse(idParams, request.params).id);
    const q = parse(daysQuery, request.query);
    return { items: rescheduleDays(db, row, { from: q.from, to: q.to }, Date.now()) };
  });

  app.get('/appointments/:id/slots', READ_LIMIT, async (request) => {
    const { client } = identify(ctx, request);
    const row = movable(client.id, parse(idParams, request.params).id);
    const { date } = parse(slotsQuery, request.query);
    if (!date) throw badRequest('«Дата»: обязательное поле');
    const starts = rescheduleStarts(db, row, date, Date.now());
    return { date, durationMin: durationOf(row), items: starts.map((s) => ({ startsAt: toIso(s), masterIds: [row.masterId] })) };
  });

  app.post('/appointments/:id/reschedule', WRITE_LIMIT, async (request) => {
    const { client } = identify(ctx, request);
    const { id } = parse(idParams, request.params);
    const { startsAt } = parse(rescheduleBody, request.body);
    return cabinetAppointment(db, await rescheduleFromCabinet(ctx, client.id, id, startsAt));
  });

  app.post('/appointments/:id/cancel', WRITE_LIMIT, async (request) => {
    const { client } = identify(ctx, request);
    const { id } = parse(idParams, request.params);
    return cabinetAppointment(db, await cancelFromCabinet(ctx, client.id, id));
  });

  app.delete('/waitlist/:id', WRITE_LIMIT, async (request, reply) => {
    const { client } = identify(ctx, request);
    cancelWaitlistEntry(db, parse(idParams, request.params).id, Date.now(), { clientId: client.id });
    return reply.code(204).send();
  });

  app.post('/logout', WRITE_LIMIT, async (request, reply) => {
    const { token } = identify(ctx, request);
    if (token) revokeCabinetToken(db, token);
    return reply.code(204).send();
  });
}
