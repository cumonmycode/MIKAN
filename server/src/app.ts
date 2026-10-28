import fs from 'node:fs';
import path from 'node:path';
import fastifyJwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { eq } from 'drizzle-orm';
import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance, type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import type { AppContext } from './context.js';
import { employees } from './db/schema.js';
import { AppError, unauthorized } from './lib/errors.js';
import type { EmployeeRow } from './lib/serialize.js';
import { formatZodError } from './lib/validation.js';
import { appointmentRoutes } from './routes/appointments.js';
import { authRoutes, publicAuthRoutes } from './routes/auth.js';
import { botRoutes } from './routes/bot.js';
import { cashRoutes } from './routes/cash.js';
import { catalogRoutes } from './routes/catalog.js';
import { categoryRoutes } from './routes/categories.js';
import { clientRoutes } from './routes/clients.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { depositRoutes } from './routes/deposits.js';
import { employeeRoutes } from './routes/employees.js';
import { historyRoutes } from './routes/history.js';
import { productRoutes } from './routes/products.js';
import { qrPaymentRoutes } from './routes/qr-payments.js';
import { receiptRoutes } from './routes/receipts.js';
import { salesRoutes } from './routes/sales.js';
import { settingsRoutes } from './routes/settings.js';
import { smmRoutes } from './routes/smm.js';
import { smmKnowledgeRoutes } from './routes/smm-knowledge.js';
import { smmSettingsRoutes } from './routes/smm-settings.js';
import { uploadRoutes } from './routes/uploads.js';

export const APP_VERSION = '1.0.0';
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

declare module 'fastify' {
  interface FastifyRequest {
    employee: EmployeeRow;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; tv: number };
    user: { sub: string; tv: number };
  }
}

export function uploadsDir(ctx: AppContext): string {
  return path.join(ctx.config.dataDir, 'uploads');
}

const body = (code: string, message: string) => ({ error: { code, message } });

export function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
}

function handleError(app: FastifyInstance) {
  app.setErrorHandler((err: FastifyError | AppError | ZodError, request, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(err.toBody());
    if (err instanceof ZodError) return reply.status(400).send(body('validation_error', formatZodError(err)));
    if (isUniqueViolation(err)) {
      // Last line of defence for check-then-insert races on unique columns.
      return reply.status(409).send(body('conflict', 'Запись с такими данными уже существует'));
    }
    const status = err.statusCode ?? 500;
    if (status === 429) {
      return reply.status(429).send(body('rate_limited', 'Слишком много попыток. Подождите минуту и попробуйте снова.'));
    }
    if (status === 413 || err.code === 'FST_REQ_FILE_TOO_LARGE' || err.code === 'FST_FILES_LIMIT') {
      return reply.status(400).send(body('validation_error', 'Файл слишком большой (максимум 10 МБ)'));
    }
    if (status === 401) return reply.status(401).send(body('unauthorized', 'Требуется вход в систему'));
    if (status === 404) return reply.status(404).send(body('not_found', 'Ресурс не найден'));
    if (status >= 400 && status < 500) {
      const message = err.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' ? 'Неподдерживаемый формат запроса' : 'Некорректный запрос';
      request.log.info({ code: err.code, status }, 'client error');
      return reply.status(400).send(body('validation_error', message));
    }
    request.log.error({ err }, 'unhandled error');
    return reply.status(500).send(body('internal', 'Внутренняя ошибка сервера. Попробуйте ещё раз.'));
  });
  app.setNotFoundHandler((_request, reply) => reply.status(404).send(body('not_found', 'Ресурс не найден')));
}

/** JSON parser that treats an empty body as `{}` (iOS clients often send Content-Type with no body). */
function tolerantJson(app: FastifyInstance) {
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, raw, done) => {
    const text = typeof raw === 'string' ? raw : raw.toString('utf8');
    if (text.trim() === '') return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch {
      done(new AppError('validation_error', 'Некорректный JSON в теле запроса'), undefined);
    }
  });
}

function authenticate(ctx: AppContext) {
  return async (request: FastifyRequest) => {
    if (!request.headers.authorization) throw unauthorized('Требуется вход в систему');
    let payload: { sub: string; tv?: number };
    try {
      payload = await request.jwtVerify<{ sub: string; tv?: number }>();
    } catch {
      throw unauthorized('Сессия истекла — войдите снова');
    }
    const id = Number(payload.sub);
    const employee = Number.isInteger(id) ? ctx.db.select().from(employees).where(eq(employees.id, id)).get() : undefined;
    if (!employee || !employee.active) throw unauthorized('Учётная запись отключена — обратитесь к администратору');
    // Password change / deactivation bumps tokenVersion, revoking every token issued before it.
    if ((payload.tv ?? 0) !== employee.tokenVersion) throw unauthorized('Сессия истекла — войдите снова');
    request.employee = employee;
  };
}

export interface BuildOptions {
  loggerInstance?: FastifyBaseLogger;
}

export async function buildApp(ctx: AppContext, options: BuildOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    ...(options.loggerInstance ? { loggerInstance: options.loggerInstance } : { logger: false }),
    // Exactly one trusted hop (Caddy): request.ip is the address Caddy saw, not a client-supplied header.
    trustProxy: (_address: string, hop: number) => hop === 0,
    bodyLimit: 1024 * 1024,
  });
  app.decorateRequest('employee', null as unknown as EmployeeRow);
  handleError(app);
  tolerantJson(app);

  const uploads = uploadsDir(ctx);
  fs.mkdirSync(uploads, { recursive: true });

  await app.register(fastifyJwt, { secret: ctx.config.jwtSecret, sign: { expiresIn: '90d' } });
  await app.register(rateLimit, { global: false });
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 10 } });
  await app.register(fastifyStatic, {
    root: uploads,
    prefix: '/uploads/',
    index: false,
    list: false,
    decorateReply: false,
    maxAge: '30d',
    immutable: true,
  });

  await app.register(
    async (api) => {
      api.get('/health', async () => ({ ok: true, version: APP_VERSION }));
      publicAuthRoutes(api, ctx);
      await api.register(async (secured) => {
        secured.addHook('onRequest', authenticate(ctx));
        authRoutes(secured, ctx);
        dashboardRoutes(secured, ctx);
        employeeRoutes(secured, ctx);
        clientRoutes(secured, ctx);
        catalogRoutes(secured, ctx);
        categoryRoutes(secured, ctx);
        productRoutes(secured, ctx);
        historyRoutes(secured, ctx);
        uploadRoutes(secured, ctx);
        appointmentRoutes(secured, ctx);
        depositRoutes(secured, ctx);
        receiptRoutes(secured, ctx);
        salesRoutes(secured, ctx);
        qrPaymentRoutes(secured, ctx);
        cashRoutes(secured, ctx);
        botRoutes(secured, ctx);
        settingsRoutes(secured, ctx);
        smmRoutes(secured, ctx);
        smmSettingsRoutes(secured, ctx);
        smmKnowledgeRoutes(secured, ctx);
      });
    },
    { prefix: '/api' },
  );
  return app;
}
