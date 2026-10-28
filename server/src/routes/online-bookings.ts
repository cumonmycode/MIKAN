import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { confirmOnlineBooking, rejectOnlineBooking } from '../domain/online-booking-lifecycle.js';
import { serializeAppointment } from '../domain/refs.js';
import { idParams, nullableText, parse } from '../lib/validation.js';

/** Staff settle online bookings from the app (docs/API.md «Appointments»); a master only their own (permissions.ts). */
export function onlineBookingRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/appointments/:id/online/confirm', async (request) => {
    const { id } = parse(idParams, request.params);
    return serializeAppointment(ctx.db, await confirmOnlineBooking(ctx, id));
  });

  app.post('/appointments/:id/online/reject', async (request) => {
    const { id } = parse(idParams, request.params);
    const { reason } = parse(z.object({ reason: nullableText(500) }), request.body);
    return serializeAppointment(ctx.db, await rejectOnlineBooking(ctx, id, reason ?? null, request.employee.id));
  });
}
