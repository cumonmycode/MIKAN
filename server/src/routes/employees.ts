import bcrypt from 'bcryptjs';
import { and, asc, count, eq, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { DbOrTx } from '../db/client.js';
import { employees } from '../db/schema.js';
import { BCRYPT_ROUNDS, EMPLOYEE_PALETTE } from '../db/seed.js';
import { visibleTo } from '../domain/employee-visibility.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { employeeOut } from '../lib/serialize.js';
import { hexColor, idParams, nonNull, parse, phoneInput, queryBool, requiredText } from '../lib/validation.js';

const login = z
  .string()
  .trim()
  .min(2)
  .max(50)
  .regex(/^[\p{L}\p{N}._@-]+$/u, { message: 'логин может содержать буквы, цифры и символы . _ - @' })
  .transform((v) => v.toLowerCase());
const password = z.string().min(6).max(200);

const createBody = z.object({
  name: requiredText(100),
  login,
  password,
  phone: phoneInput,
  color: hexColor.nullish(),
  isMaster: z.boolean().nullish(),
});

const patchBody = z.object({
  name: nonNull(requiredText(100)),
  login: nonNull(login),
  password: nonNull(password),
  phone: phoneInput,
  color: nonNull(hexColor),
  isMaster: nonNull(z.boolean()),
  active: nonNull(z.boolean()),
});

function assertLoginFree(db: DbOrTx, value: string, exceptId?: number) {
  const conditions = [eq(employees.login, value)];
  if (exceptId !== undefined) conditions.push(ne(employees.id, exceptId));
  if (db.select({ id: employees.id }).from(employees).where(and(...conditions)).get()) {
    throw conflict(`Логин «${value}» уже занят`);
  }
}

export function employeeRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  app.get('/employees', async (request) => {
    const q = parse(z.object({ includeInactive: queryBool }), request.query);
    const rows = db
      .select()
      .from(employees)
      .where(q.includeInactive ? undefined : eq(employees.active, true))
      .orderBy(asc(employees.name), asc(employees.id))
      .all();
    return { items: rows.filter(visibleTo(ctx.config, request.employee)).map(employeeOut) };
  });

  app.post('/employees', async (request) => {
    const input = parse(createBody, request.body);
    // Hash before the check+insert so no await separates them (avoids a duplicate-login race).
    const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
    const row = db.transaction((tx) => {
      assertLoginFree(tx, input.login);
      const now = Date.now();
      const existing = tx.select({ n: count() }).from(employees).get()?.n ?? 0;
      return tx
        .insert(employees)
        .values({
          name: input.name,
          login: input.login,
          passwordHash,
          phone: input.phone ?? null,
          color: input.color ?? EMPLOYEE_PALETTE[existing % EMPLOYEE_PALETTE.length]!,
          isMaster: input.isMaster ?? false,
          active: true,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
    });
    return employeeOut(row);
  });

  app.patch('/employees/:id', async (request) => {
    const { id } = parse(idParams, request.params);
    const input = parse(patchBody, request.body);
    if (input.active === false && id === request.employee.id) {
      throw badRequest('Нельзя отключить собственную учётную запись');
    }
    const passwordHash = input.password ? await bcrypt.hash(input.password, BCRYPT_ROUNDS) : undefined;
    const row = db.transaction((tx) => {
      const current = tx.select().from(employees).where(eq(employees.id, id)).get();
      if (!current) throw notFound('Сотрудник не найден');
      if (input.login !== undefined) assertLoginFree(tx, input.login, id);
      const deactivated = input.active === false && current.active;
      return tx
        .update(employees)
        .set({
          name: input.name ?? current.name,
          login: input.login ?? current.login,
          passwordHash: passwordHash ?? current.passwordHash,
          phone: input.phone === undefined ? current.phone : input.phone,
          color: input.color ?? current.color,
          isMaster: input.isMaster ?? current.isMaster,
          active: input.active ?? current.active,
          // A new password or deactivation revokes all previously issued tokens.
          tokenVersion: passwordHash || deactivated ? current.tokenVersion + 1 : current.tokenVersion,
          updatedAt: Date.now(),
        })
        .where(eq(employees.id, id))
        .returning()
        .get();
    });
    return employeeOut(row);
  });
}
