import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { employees } from '../db/schema.js';
import { forbidden, OWNER_ONLY_MESSAGE, roleOf } from '../domain/permissions.js';
import { deviceOf, endSession, getSessionRow, listSessions, openSession } from '../domain/sessions.js';
import { unauthorized } from '../lib/errors.js';
import { employeeOut } from '../lib/serialize.js';
import { idParams, parse, queryId } from '../lib/validation.js';

const loginBody = z.object({
  login: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(200),
});

const sessionsQuery = z.object({ employeeId: queryId });

// Compared against when the login is unknown, so response time doesn't reveal valid logins.
const DUMMY_HASH = bcrypt.hashSync('timing-equalizer', 10);

export const LOGIN_RATE_LIMIT = { max: 10, timeWindow: 60_000 };

export function publicAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/auth/login', { config: { rateLimit: LOGIN_RATE_LIMIT } }, async (request) => {
    const input = parse(loginBody, request.body);
    const employee = ctx.db
      .select()
      .from(employees)
      .where(eq(employees.login, input.login.toLowerCase()))
      .get();
    const ok = await bcrypt.compare(input.password, employee?.passwordHash ?? DUMMY_HASH);
    if (!employee || !ok) throw unauthorized('Неверный логин или пароль');
    if (!employee.active) throw unauthorized('Учётная запись отключена — обратитесь к администратору');
    // One session per sign-in (docs/API.md «Sessions»): signing out ends this device only.
    const session = openSession(ctx.db, { employeeId: employee.id, device: deviceOf(request), ip: request.ip || null });
    const token = await request.server.jwt.sign({ sub: String(employee.id), tv: employee.tokenVersion, sid: session.id });
    request.log.info({ employeeId: employee.id, sessionId: session.id }, 'login');
    return { token, employee: employeeOut(employee) };
  });
}

export function authRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/auth/me', async (request) => employeeOut(request.employee));

  /** Ends the session of this token; a token issued before sessions has none to end. */
  app.post('/auth/logout', async (request, reply) => {
    if (request.sessionId !== null) endSession(ctx.db, request.sessionId);
    return reply.status(204).send();
  });

  /** Your own active sessions; the owner gets everyone's (`?employeeId=` filters). */
  app.get('/auth/sessions', async (request) => {
    const { employeeId } = parse(sessionsQuery, request.query);
    const me = request.employee;
    const isOwner = roleOf(me) === 'owner';
    if (!isOwner && employeeId !== undefined && employeeId !== me.id) throw forbidden(OWNER_ONLY_MESSAGE);
    const filter = isOwner ? { employeeId } : { employeeId: me.id };
    return { items: listSessions(ctx.db, filter, request.sessionId) };
  });

  /** Your own session, or anyone's for the owner; an ended one stays ended. */
  app.delete('/auth/sessions/:id', async (request, reply) => {
    const { id } = parse(idParams, request.params);
    const session = getSessionRow(ctx.db, id);
    const isOwner = roleOf(request.employee) === 'owner';
    if (session.employeeId !== request.employee.id && !isOwner) throw forbidden(OWNER_ONLY_MESSAGE);
    endSession(ctx.db, id);
    return reply.status(204).send();
  });
}
