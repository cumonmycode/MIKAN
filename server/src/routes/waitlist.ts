import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { MAX_BOOKING_ITEMS } from '../domain/online-booking-items.js';
import {
  cancelWaitlistEntry,
  checkWish,
  insertWish,
  listWaitlist,
  NOTE_MAX,
  parseStatuses,
  serializeWaitlist,
  serializeWaitlistEntry,
} from '../domain/waitlist.js';
import { idParams, parse } from '../lib/validation.js';

/** The waitlist in the app (docs/API.md «Waitlist»): every staff role reads it, adds clients and cancels entries. */

const id = z.number().int().positive();
const date = z.string().trim().min(1).max(10);
const item = z.object({ serviceId: id, variant: z.string().trim().max(100).nullish() });
const createBody = z.object({
  clientId: id,
  items: z.array(item).min(1).max(MAX_BOOKING_ITEMS),
  masterId: id.nullish(),
  dateFrom: date,
  dateTo: date,
  note: z.string().trim().max(NOTE_MAX).nullish(),
});
const patchBody = z.object({ status: z.literal('cancelled') });
const listQuery = z.object({ status: z.string().trim().max(200).optional() });

export function waitlistRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  app.get('/waitlist', async (request) => {
    const q = parse(listQuery, request.query);
    return { items: serializeWaitlist(db, listWaitlist(db, parseStatuses(q.status))) };
  });

  app.post('/waitlist', async (request) => {
    const input = parse(createBody, request.body);
    const now = Date.now();
    const wish = checkWish(db, { ...input, channel: 'app' }, now);
    return serializeWaitlistEntry(db, insertWish(db, input.clientId, wish, 'app', now).row);
  });

  app.patch('/waitlist/:id', async (request) => {
    const params = parse(idParams, request.params);
    parse(patchBody, request.body);
    return serializeWaitlistEntry(db, cancelWaitlistEntry(db, params.id));
  });
}
