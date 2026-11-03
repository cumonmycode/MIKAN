import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { createDelivery, getDelivery, listDeliveries, listSuppliers } from '../domain/deliveries.js';
import { idempotent } from '../lib/idempotency.js';
import { idParams, money, nullableText, pagination, parse } from '../lib/validation.js';

/** Deliveries (поставки) and their suppliers (docs/API.md «Products & stock» → «Deliveries»). */

const id = z.number().int().positive();
const deliveryBody = z.object({
  supplier: nullableText(100),
  note: nullableText(500),
  lines: z
    .array(
      z.object({
        productId: id,
        variantId: id.nullish(),
        quantity: z.number().int().min(1).max(10_000),
        unitCost: money.nullish(),
      }),
    )
    .min(1)
    .max(200),
});
const listQuery = pagination.extend({ supplier: z.string().trim().max(100).optional() });

export function deliveryRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  app.post('/stock/deliveries', async (request, reply) => {
    const input = parse(deliveryBody, request.body);
    return idempotent(db, request, reply, (tx) => createDelivery(tx, input, request.employee.id));
  });

  app.get('/stock/deliveries', async (request) => {
    const q = parse(listQuery, request.query);
    return listDeliveries(db, q);
  });

  app.get('/stock/deliveries/:id', async (request) => {
    const { id } = parse(idParams, request.params);
    return getDelivery(db, id);
  });

  app.get('/stock/suppliers', async () => ({ items: listSuppliers(db) }));
}
