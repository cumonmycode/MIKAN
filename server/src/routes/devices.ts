import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { parse } from '../lib/validation.js';
import { APNS_ENVIRONMENTS } from '../push/apns.js';
import { deviceToken, registerDevice, unregisterDevice } from '../push/devices.js';

/** Staff iPhones for push notifications (docs/API.md «Push notifications»); every role, not in the audit log. */

const registerBody = z.object({ token: z.unknown(), environment: z.enum(APNS_ENVIRONMENTS) });

export function deviceRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/devices', async (request, reply) => {
    const body = parse(registerBody, request.body);
    registerDevice(ctx.db, request.employee.id, { token: deviceToken(body.token), environment: body.environment });
    return reply.status(204).send();
  });

  app.delete('/devices/:token', async (request, reply) => {
    const token = deviceToken((request.params as { token?: unknown }).token);
    unregisterDevice(ctx.db, request.employee.id, token);
    return reply.status(204).send();
  });
}
