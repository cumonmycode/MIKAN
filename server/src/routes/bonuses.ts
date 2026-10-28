import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { adjustBonuses } from '../domain/bonuses.js';
import { listBonusOperations, serializeBonusOperations } from '../domain/loyalty.js';
import { getClientRow } from '../domain/refs.js';
import { idParams, instant, pagination, parse, requiredText } from '../lib/validation.js';

/** The client's bonus ledger (docs/API.md «Loyalty bonuses»); a manual adjustment is for owners and admins. */

const adjustBody = z.object({
  amount: z
    .number()
    .int()
    .min(-1_000_000)
    .max(1_000_000)
    .refine((v) => v !== 0, { message: 'не может быть 0' }),
  note: requiredText(500),
  expiresAt: instant.nullish(),
});

export function bonusRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  app.get('/clients/:id/bonuses', async (request) => {
    const { id } = parse(idParams, request.params);
    const page = parse(pagination, request.query);
    return listBonusOperations(db, id, page);
  });

  app.post('/clients/:id/bonuses', async (request) => {
    const { id } = parse(idParams, request.params);
    const input = parse(adjustBody, request.body);
    getClientRow(db, id);
    const row = adjustBonuses(db, id, { amount: input.amount, note: input.note, expiresAt: input.expiresAt ?? null }, request.employee.id);
    return serializeBonusOperations(db, [row])[0];
  });
}
