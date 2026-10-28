import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { listCertificates, sendCertificate, serializeCertificate } from '../domain/certificate-views.js';
import { cancelCertificate, findCertificateByCode, getCertificateRow, updateCertificate } from '../domain/certificates.js';
import { assertRole } from '../domain/permissions.js';
import { notFound } from '../lib/errors.js';
import { idParams, instant, nullableText, pagination, parse, requiredText } from '../lib/validation.js';

/** Gift certificates (docs/API.md «Gift certificates»): sold and spent at the till, managed here. */

const listQuery = pagination.extend({
  status: z.enum(['active', 'used', 'expired', 'cancelled']).optional(),
  q: z.string().trim().max(100).optional(),
});
const codeParams = z.object({ code: z.string().trim().min(1).max(40) });
const patchBody = z.object({
  recipientName: nullableText(100),
  note: nullableText(1000),
  expiresAt: instant.nullish(),
});
const cancelBody = z.object({ reason: requiredText(500) });
const sendBody = z.object({ chatId: z.number().int().refine(Number.isSafeInteger).nullish() });

export function certificateRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  app.get('/certificates', async (request) => {
    const q = parse(listQuery, request.query);
    return listCertificates(db, q);
  });

  app.get('/certificates/:id', async (request) => {
    const { id } = parse(idParams, request.params);
    return serializeCertificate(db, getCertificateRow(db, id));
  });

  app.get('/certificates/code/:code', async (request) => {
    const { code } = parse(codeParams, request.params);
    const row = findCertificateByCode(db, code);
    if (!row) throw notFound('Сертификат не найден');
    return serializeCertificate(db, row);
  });

  app.patch('/certificates/:id', async (request) => {
    const { id } = parse(idParams, request.params);
    const input = parse(patchBody, request.body);
    // Recipient and note are anyone's to fix; the expiry is the owner's (resent unchanged, it is untouched).
    const current = getCertificateRow(db, id);
    if (input.expiresAt !== undefined && input.expiresAt !== current.expiresAt) assertRole(request.employee, ['owner']);
    return serializeCertificate(db, updateCertificate(db, id, input));
  });

  app.post('/certificates/:id/cancel', async (request) => {
    const { id } = parse(idParams, request.params);
    const input = parse(cancelBody, request.body);
    return serializeCertificate(db, cancelCertificate(db, id, input.reason, request.employee.id));
  });

  app.post('/certificates/:id/send', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request) => {
    const { id } = parse(idParams, request.params);
    const input = parse(sendBody, request.body);
    getCertificateRow(db, id);
    await sendCertificate(ctx, id, input.chatId ?? null);
    return { sent: true };
  });
}
