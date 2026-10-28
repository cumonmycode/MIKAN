import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import {
  createReceipt,
  deleteReceipt,
  getReceiptRow,
  listReceipts,
  serializeReceipt,
  serializeReceipts,
  updateReceipt,
  type ReceiptInput,
} from '../domain/receipts.js';
import { idempotent } from '../lib/idempotency.js';
import { idParams, money, nonNull, nullableText, parse } from '../lib/validation.js';
import { saleLine } from './sales.js';

const id = z.number().int().positive();
const items = z.array(saleLine).max(100);
const createBody = z.object({
  appointmentId: id.nullish(),
  clientId: id.nullish(),
  items: items.nullish(),
  discount: nonNull(money),
  note: nullableText(1000),
});
const updateBody = createBody.extend({ items });

/** Fills the optional parts of a validated body (an item without `quantity` is one unit, like in a sale). */
function receiptInputOf(input: z.infer<typeof createBody>): ReceiptInput {
  return {
    appointmentId: input.appointmentId,
    clientId: input.clientId,
    items: input.items?.map((i) => ({ ...i, quantity: i.quantity ?? 1 })),
    discount: input.discount,
    note: input.note,
  };
}

export function receiptRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  app.get('/receipts', async () => ({ items: serializeReceipts(db, listReceipts(db)) }));

  app.get('/receipts/:id', async (request) => {
    const params = parse(idParams, request.params);
    return serializeReceipt(db, getReceiptRow(db, params.id));
  });

  app.post('/receipts', async (request, reply) => {
    const input = receiptInputOf(parse(createBody, request.body));
    return idempotent(db, request, reply, (tx) => serializeReceipt(tx, createReceipt(tx, input, request.employee.id)));
  });

  app.put('/receipts/:id', async (request) => {
    const params = parse(idParams, request.params);
    const input = receiptInputOf(parse(updateBody, request.body));
    return serializeReceipt(db, updateReceipt(db, params.id, input));
  });

  app.delete('/receipts/:id', async (request) => {
    const params = parse(idParams, request.params);
    deleteReceipt(db, params.id);
    return { ok: true };
  });
}
