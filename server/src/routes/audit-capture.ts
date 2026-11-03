import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import {
  aftercareTemplates,
  employees,
  knowledgeEntries,
  payRules,
  payrollAdjustments,
  services,
} from '../db/schema.js';
import { setAuditLogger, writeAudit } from '../domain/audit.js';
import { serializeCertificate } from '../domain/certificate-views.js';
import { getCertificateRow } from '../domain/certificates.js';
import { buildDraft, type SummaryContext } from '../domain/audit-summaries.js';
import { getChat, serializeChat } from '../domain/bot-chats.js';
import { getCampaignRow, serializeCampaign } from '../domain/campaigns.js';
import { getCategoryRow, listCategories, type CatalogSection } from '../domain/categories.js';
import { getPortfolioRow, serializePortfolioPhoto } from '../domain/portfolio.js';
import { serializeProduct } from '../domain/products.js';
import { getReceiptRow, serializeReceipt } from '../domain/receipts.js';
import { getAppointmentRow, getClientRow, serializeAppointment } from '../domain/refs.js';
import { serializeService } from '../domain/services.js';
import { sessionSnapshot } from '../domain/sessions.js';
import { getStudioSettings, studioTimezone } from '../domain/settings.js';
import { getWaitlistRow, serializeWaitlistEntry } from '../domain/waitlist.js';
import { getProductRow } from '../domain/stock.js';
import { errorMessage } from '../lib/errors.js';
import { REPLAYED_HEADER } from '../lib/idempotency.js';
import { clientOut, employeeOut, knowledgeOut, templateOut } from '../lib/serialize.js';
import { botSettingsOut } from './settings.js';

/**
 * The action log's capture of app writes (docs/API.md «Audit log»): one hook set on the secured scope records every
 * successful `POST`/`PUT`/`PATCH`/`DELETE` with a summary (domain/audit-summaries.ts). For edits and deletions the
 * entity is read before the handler runs, so the entry can say what changed.
 */

interface AuditCapture {
  /** `METHOD /route` without the `/api` prefix. */
  key: string;
  route: string;
  before: unknown;
  result: unknown;
}

declare module 'fastify' {
  interface FastifyRequest {
    auditCapture: AuditCapture | null;
  }
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** Not logged: sign-in, file uploads, marking a chat read, the one-time staff code and push device registration. */
export const AUDIT_EXCLUDED = new Set([
  'POST /auth/login',
  'POST /uploads',
  'POST /bot/chats/:chatId/read',
  'POST /bot/staff-code',
  'POST /devices',
  'DELETE /devices/:token',
  // Counts the recipients of a segment / works out a refund: they change nothing.
  'POST /campaigns/preview',
  'POST /sales/:id/refund/preview',
]);

type Params = Record<string, string | undefined>;
/** Reads the entity a route is about to change, in the shape the route answers with. */
type SnapshotLoader = (ctx: AppContext, params: Params, request: FastifyRequest) => unknown;

const idOf = (params: Params) => Number(params.id);
const chatIdOf = (params: Params) => Number(params.chatId);

const appointment: SnapshotLoader = (ctx, p) => serializeAppointment(ctx.db, getAppointmentRow(ctx.db, idOf(p)));
const client: SnapshotLoader = (ctx, p) => clientOut(getClientRow(ctx.db, idOf(p)));
const product: SnapshotLoader = (ctx, p) => serializeProduct(ctx.db, getProductRow(ctx.db, idOf(p)));
const receipt: SnapshotLoader = (ctx, p) => serializeReceipt(ctx.db, getReceiptRow(ctx.db, idOf(p)));
const chat: SnapshotLoader = (ctx, p) => serializeChat(ctx.db, getChat(ctx.db, chatIdOf(p)));
const certificate: SnapshotLoader = (ctx, p) => serializeCertificate(ctx.db, getCertificateRow(ctx.db, idOf(p)));
const campaign: SnapshotLoader = (ctx, p) => serializeCampaign(ctx.db, getCampaignRow(ctx.db, idOf(p)));
const portfolioPhoto: SnapshotLoader = (ctx, p) => serializePortfolioPhoto(ctx.db, getPortfolioRow(ctx.db, idOf(p)));

const service: SnapshotLoader = (ctx, p) => {
  const row = ctx.db.select().from(services).where(eq(services.id, idOf(p))).get();
  return row ? serializeService(ctx.db, row) : undefined;
};

const memo: SnapshotLoader = (ctx, p) => {
  const row = ctx.db.select().from(aftercareTemplates).where(eq(aftercareTemplates.id, idOf(p))).get();
  return row ? templateOut(row) : undefined;
};

const knowledge: SnapshotLoader = (ctx, p) => {
  const row = ctx.db.select().from(knowledgeEntries).where(eq(knowledgeEntries.id, idOf(p))).get();
  return row ? knowledgeOut(row) : undefined;
};

const category: SnapshotLoader = (ctx, p) => {
  const row = getCategoryRow(ctx.db, idOf(p));
  return listCategories(ctx.db, row.section as CatalogSection).find((c) => c.id === row.id);
};

const employeeRow = (ctx: AppContext, id: number) => ctx.db.select().from(employees).where(eq(employees.id, id)).get();

const employee: SnapshotLoader = (ctx, p) => {
  const row = employeeRow(ctx, idOf(p));
  return row ? employeeOut(row) : undefined;
};

function parseJson(text: string | null): unknown {
  if (text == null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Whose schedule, and the weekly one before the change. */
const schedule: SnapshotLoader = (ctx, p) => {
  const row = employeeRow(ctx, idOf(p));
  return row ? { employeeId: row.id, name: row.name, weekly: parseJson(row.weeklySchedule) } : undefined;
};

/** Whose pay rules, and the latest version before the change. */
const payRulesOwner: SnapshotLoader = (ctx, p) => {
  const row = employeeRow(ctx, idOf(p));
  if (!row) return undefined;
  const latest = ctx.db
    .select()
    .from(payRules)
    .where(eq(payRules.employeeId, row.id))
    .orderBy(desc(payRules.effectiveFrom))
    .get();
  return { name: row.name, rules: latest ? parseJson(latest.rules) : null };
};

const adjustment: SnapshotLoader = (ctx, p) => {
  const row = ctx.db.select().from(payrollAdjustments).where(eq(payrollAdjustments.id, idOf(p))).get();
  if (!row) return undefined;
  const owner = employeeRow(ctx, row.employeeId);
  return { ...row, employee: { id: row.employeeId, name: owner?.name ?? `№${row.employeeId}` } };
};

/** Routes whose entry compares the entity before and after, or names something the write removes. */
const SNAPSHOTS: Record<string, SnapshotLoader> = {
  'PATCH /appointments/:id': appointment,
  'POST /appointments/:id/complete': appointment,
  'POST /appointments/:id/online/confirm': appointment,
  'POST /appointments/:id/online/reject': appointment,
  'PATCH /clients/:id': client,
  'POST /clients/:id/telegram-link': client,
  'POST /clients/:id/bonuses': client,
  'POST /clients/:id/merge': client,
  'PATCH /certificates/:id': certificate,
  'POST /certificates/:id/cancel': certificate,
  'POST /certificates/:id/send': certificate,
  'PATCH /services/:id': service,
  'PATCH /aftercare-templates/:id': memo,
  'DELETE /aftercare-templates/:id': memo,
  'PATCH /products/:id': product,
  'DELETE /products/:id': product,
  'PATCH /catalog/categories/:id': category,
  'POST /catalog/categories/:id/merge': category,
  'DELETE /catalog/categories/:id': category,
  'PUT /receipts/:id': receipt,
  'DELETE /receipts/:id': receipt,
  'PATCH /employees/:id': employee,
  'PUT /employees/:id/schedule': schedule,
  'PUT /employees/:id/schedule/days': schedule,
  'DELETE /employees/:id/schedule/days': schedule,
  'PUT /employees/:id/pay-rules': payRulesOwner,
  'DELETE /payroll/adjustments/:id': adjustment,
  'PUT /settings/studio': (ctx) => getStudioSettings(ctx.db),
  'PUT /settings/bot': (ctx) => botSettingsOut(ctx),
  'POST /bot/chats/:chatId/messages': chat,
  'PATCH /bot/chats/:chatId': chat,
  'PUT /bot/chats/:chatId/employee': chat,
  'DELETE /bot/chats/:chatId/employee': chat,
  'PATCH /knowledge/:id': knowledge,
  'DELETE /knowledge/:id': knowledge,
  'PATCH /campaigns/:id': campaign,
  'POST /campaigns/:id/test': campaign,
  'POST /campaigns/:id/cancel': campaign,
  'DELETE /campaigns/:id': campaign,
  'PATCH /waitlist/:id': (ctx, p) => serializeWaitlistEntry(ctx.db, getWaitlistRow(ctx.db, idOf(p))),
  'PATCH /portfolio/:id': portfolioPhoto,
  'DELETE /portfolio/:id': portfolioPhoto,
  // Whose session ends and on which device.
  'POST /auth/logout': (ctx, _p, request) => sessionSnapshot(ctx.db, request.sessionId),
  'DELETE /auth/sessions/:id': (ctx, p) => sessionSnapshot(ctx.db, idOf(p)),
};

/** `/api/appointments/:id` → `/appointments/:id` */
const withoutPrefix = (url: string): string => url.replace(/^\/api(?=\/)/, '');

function startCapture(ctx: AppContext, request: FastifyRequest): void {
  if (!WRITE_METHODS.has(request.method) || !request.routeOptions.url) return;
  const route = withoutPrefix(request.routeOptions.url);
  const key = `${request.method} ${route}`;
  if (AUDIT_EXCLUDED.has(key)) return;
  let before: unknown;
  try {
    before = SNAPSHOTS[key]?.(ctx, request.params as Params, request);
  } catch {
    // The entity is missing: the handler answers 404 and nothing is logged.
    before = undefined;
  }
  request.auditCapture = { key, route, before, result: undefined };
}

function contextOf(ctx: AppContext, request: FastifyRequest, capture: AuditCapture): SummaryContext {
  const body = request.body;
  return {
    method: request.method,
    route: capture.route,
    path: withoutPrefix(request.url.split('?')[0] ?? request.url),
    params: (request.params ?? {}) as Params,
    query: (request.query ?? {}) as Record<string, unknown>,
    body: body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {},
    before: capture.before,
    result: capture.result,
    tz: studioTimezone(ctx.db),
    now: Date.now(),
  };
}

/** Writes the entry of a finished write; never throws. Errors, replays and excluded routes are skipped. */
function finishCapture(ctx: AppContext, request: FastifyRequest, reply: FastifyReply): void {
  const capture = request.auditCapture;
  if (!capture || reply.statusCode < 200 || reply.statusCode >= 300) return;
  if (reply.getHeader(REPLAYED_HEADER) !== undefined) return;
  try {
    const draft = buildDraft(contextOf(ctx, request, capture), ctx.log);
    writeAudit(ctx.db, { ...draft, source: 'app', employeeId: request.employee.id }, ctx.log);
  } catch (err) {
    ctx.log.error({ err: errorMessage(err), route: capture.key }, 'audit capture failed');
  }
}

/** Registers the capture on the secured scope (before its routes). */
export function registerAuditCapture(app: FastifyInstance, ctx: AppContext): void {
  setAuditLogger(ctx.log);
  app.decorateRequest('auditCapture', null);
  app.addHook('preHandler', async (request) => {
    startCapture(ctx, request);
  });
  app.addHook('preSerialization', async (request, _reply, payload) => {
    if (request.auditCapture) request.auditCapture = { ...request.auditCapture, result: payload };
    return payload;
  });
  app.addHook('onSend', async (request, reply, payload) => {
    finishCapture(ctx, request, reply);
    return payload;
  });
}
