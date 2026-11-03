import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { getSaleRow, serializeSale } from '../domain/refs.js';
import { previewRefund, refundSale } from '../domain/refunds.js';
import { sendReceiptByStaff, sendRefundNotice, sendSaleReceipt } from '../domain/sale-messages.js';
import { assertShiftOpen, createSale, listSales, type SaleInput } from '../domain/sales.js';
import { badRequest } from '../lib/errors.js';
import { idempotent, REPLAYED_HEADER } from '../lib/idempotency.js';
import { idParams, money, nonNull, nullableText, pagination, parse, queryId, queryInstant, requiredText } from '../lib/validation.js';

const id = z.number().int().positive();
/** A product or a service line. */
const saleItem = z.object({
  type: z.enum(['product', 'service']),
  productId: id.nullish(),
  variantId: id.nullish(),
  serviceId: id.nullish(),
  name: nullableText(200),
  quantity: nonNull(z.number().int().min(1).max(10_000)),
  price: money.nullish(),
});
/** A line of a sale or an open receipt; both also sell gift certificates (`type: certificate`, «Gift certificates»). */
export const saleLine = saleItem.extend({
  type: z.enum(['product', 'service', 'certificate']),
  recipientName: nullableText(100),
  note: nullableText(500),
});
const certificatePayment = z.object({ code: requiredText(40), amount: z.number().int().min(1).max(100_000_000) });
export const saleBody = z.object({
  clientId: id.nullish(),
  appointmentId: id.nullish(),
  items: z.array(saleLine).min(1).max(100),
  discount: nonNull(money),
  payments: z.object({
    cash: nonNull(money),
    card: nonNull(money),
    transfer: nonNull(money),
    qr: nonNull(money),
    deposit: nonNull(money),
    bonus: nonNull(money),
    certificates: z.array(certificatePayment).max(10).nullish(),
  }),
  note: nullableText(1000),
  receiptId: id.nullish(),
});
export type SaleBody = z.infer<typeof saleBody>;

/** Fills the optional parts of a validated body. */
export function saleInputOf(input: SaleBody): SaleInput {
  return {
    clientId: input.clientId,
    appointmentId: input.appointmentId,
    items: input.items.map((i) => ({ ...i, quantity: i.quantity ?? 1 })),
    discount: input.discount ?? 0,
    payments: {
      cash: input.payments.cash ?? 0,
      card: input.payments.card ?? 0,
      transfer: input.payments.transfer ?? 0,
      qr: input.payments.qr ?? 0,
      // Absent (not 0) for clients that predate prepayments: see `SalePayments.deposit`.
      deposit: input.payments.deposit,
      bonus: input.payments.bonus ?? 0,
      certificates: input.payments.certificates ?? [],
    },
    note: input.note,
    receiptId: input.receiptId,
  };
}

/** Lines (and units) to return; omitted — everything not returned yet (older builds). */
const refundItems = z
  .array(z.object({ saleItemId: id, quantity: z.number().int().min(1).max(10_000) }))
  .min(1)
  .max(100)
  .nullish();
const refundBody = z.object({ reason: requiredText(500), restock: nonNull(z.boolean()), items: refundItems });
const refundPreviewBody = z.object({ items: refundItems });
const listQuery = pagination.extend({ from: queryInstant, to: queryInstant, clientId: queryId, search: z.string().trim().max(100).optional() });
const sendBody = z.object({ chatId: z.number().int().refine(Number.isSafeInteger).nullish() });

export function salesRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  app.get('/sales', async (request) => {
    const q = parse(listQuery, request.query);
    return listSales(db, q);
  });

  app.get('/sales/:id', async (request) => {
    const params = parse(idParams, request.params);
    return serializeSale(db, getSaleRow(db, params.id));
  });

  app.post('/sales', async (request, reply) => {
    const input = saleInputOf(parse(saleBody, request.body));
    // QR money is only counted once the bank confirms it: such a sale is created by POST /qr-payments.
    if (input.payments.qr > 0) throw badRequest('Оплату по QR-коду проводите через «Показать QR-код»');
    const sale = idempotent(db, request, reply, (tx) => {
      assertShiftOpen(tx);
      return serializeSale(tx, createSale(tx, input, request.employee.id));
    });
    // The client gets the receipt once (not on a replay); the reply does not wait for Telegram.
    if (reply.getHeader(REPLAYED_HEADER) === undefined) void sendSaleReceipt(ctx, sale.id);
    return sale;
  });

  app.post('/sales/:id/send', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request) => {
    const { id } = parse(idParams, request.params);
    const input = parse(sendBody, request.body);
    return serializeSale(db, await sendReceiptByStaff(ctx, id, input.chatId ?? null));
  });

  app.post('/sales/:id/refund', async (request, reply) => {
    const params = parse(idParams, request.params);
    const input = parse(refundBody, request.body);
    const sale = idempotent(db, request, reply, (tx) => {
      const refundInput = { reason: input.reason, restock: input.restock ?? true, items: input.items };
      return serializeSale(tx, refundSale(tx, params.id, refundInput, request.employee.id));
    });
    // The client hears about the refund once (not on a replay); the reply does not wait for Telegram.
    if (reply.getHeader(REPLAYED_HEADER) === undefined) {
      const refund = sale.refunds.at(-1);
      if (refund) void sendRefundNotice(ctx, refund.id);
    }
    return sale;
  });

  app.post('/sales/:id/refund/preview', async (request) => {
    const params = parse(idParams, request.params);
    const input = parse(refundPreviewBody, request.body);
    return previewRefund(db, params.id, input.items);
  });
}
