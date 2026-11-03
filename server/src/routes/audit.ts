import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { AUDIT_SOURCES, listAudit } from '../domain/audit.js';
import { pagination, parse, queryId, queryInstant } from '../lib/validation.js';
import { assertRole } from '../domain/permissions.js';

/** One entity or a comma-separated list («appointment,deposit»: an appointment's own history). */
const entities = z
  .string()
  .trim()
  .max(200)
  .optional()
  .transform((value) => value?.split(',').map((e) => e.trim()).filter(Boolean));

const listQuery = pagination.extend({
  from: queryInstant,
  to: queryInstant,
  employeeId: queryId,
  entity: entities,
  // Telegram chat ids (entity `bot`) may be negative.
  entityId: z.coerce.number().int().optional(),
  source: z.enum(AUDIT_SOURCES).optional(),
});

/** The action log (docs/API.md «Audit log»), for the studio owner. */
export function auditRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/audit', async (request) => {
    assertRole(request.employee, ['owner']);
    const q = parse(listQuery, request.query);
    return listAudit(ctx.db, {
      from: q.from,
      to: q.to,
      employeeId: q.employeeId,
      entities: q.entity,
      entityId: q.entityId,
      source: q.source,
      limit: q.limit,
      offset: q.offset,
    });
  });
}
