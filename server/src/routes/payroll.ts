import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { DbOrTx } from '../db/client.js';
import { employees } from '../db/schema.js';
import { ADJUSTMENT_KINDS, adjustmentsOut, createAdjustment, deleteAdjustment } from '../domain/payroll-adjustments.js';
import { payRulesInput, payRulesOut, savePayRules } from '../domain/payroll-rules.js';
import { payrollList, payrollPeriod, payrollStatement } from '../domain/payroll.js';
import { studioTimezone } from '../domain/settings.js';
import { notFound } from '../lib/errors.js';
import { idempotent } from '../lib/idempotency.js';
import type { EmployeeRow } from '../lib/serialize.js';
import { isValidCalendarDate, localDate } from '../lib/time.js';
import { idParams, money, nullableText, parse } from '../lib/validation.js';
import { assertRole } from '../domain/permissions.js';

/** Payroll (docs/API.md «Payroll»): the owner sees and manages everyone's pay, everyone else reads their own. */


const studioDate = z.string().trim().refine(isValidCalendarDate, { message: 'дата должна быть в формате ГГГГ-ММ-ДД' });
const periodQuery = z.object({ from: studioDate, to: studioDate });
const employeeParams = z.object({ employeeId: z.coerce.number().int().positive() });
const rulesBody = payRulesInput.extend({ effectiveFrom: studioDate.nullish() });
const adjustmentBody = z.object({
  employeeId: z.number().int().positive(),
  date: studioDate.nullish(),
  kind: z.enum(ADJUSTMENT_KINDS),
  amount: money.refine((v) => v > 0, { message: 'сумма должна быть больше 0' }),
  note: nullableText(300),
  fromCash: z.boolean().nullish(),
});

const isOwner = (employee: EmployeeRow) => employee.role === 'owner';

function assertOwner(request: FastifyRequest): void {
  assertRole(request.employee, ['owner']);
}

/** The owner may look at anyone; everyone else only at themselves. */
function assertOwnerOrSelf(request: FastifyRequest, employeeId: number): void {
  if (request.employee.id !== employeeId) assertOwner(request);
}

function getEmployee(db: DbOrTx, id: number): EmployeeRow {
  const row = db.select().from(employees).where(eq(employees.id, id)).get();
  if (!row) throw notFound('Сотрудник не найден');
  return row;
}

const today = (db: DbOrTx) => localDate(Date.now(), studioTimezone(db));

export function payrollRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  app.get('/payroll', async (request) => {
    const q = parse(periodQuery, request.query);
    const period = payrollPeriod(db, q.from, q.to);
    return payrollList(db, period, isOwner(request.employee) ? null : [request.employee]);
  });

  app.get('/payroll/:employeeId', async (request) => {
    const { employeeId } = parse(employeeParams, request.params);
    assertOwnerOrSelf(request, employeeId);
    const q = parse(periodQuery, request.query);
    return payrollStatement(db, payrollPeriod(db, q.from, q.to), getEmployee(db, employeeId));
  });

  app.get('/employees/:id/pay-rules', async (request) => {
    const { id } = parse(idParams, request.params);
    assertOwnerOrSelf(request, id);
    getEmployee(db, id);
    return payRulesOut(db, id, today(db));
  });

  app.put('/employees/:id/pay-rules', async (request) => {
    const { id } = parse(idParams, request.params);
    assertOwner(request);
    const { effectiveFrom, ...rules } = parse(rulesBody, request.body);
    getEmployee(db, id);
    savePayRules(db, id, effectiveFrom ?? today(db), rules, request.employee.id);
    return payRulesOut(db, id, today(db));
  });

  app.post('/payroll/adjustments', async (request, reply) => {
    assertOwner(request);
    const input = parse(adjustmentBody, request.body);
    return idempotent(db, request, reply, (tx) => {
      const row = createAdjustment(
        tx,
        { ...input, date: input.date ?? today(tx), note: input.note ?? null, fromCash: input.fromCash ?? false },
        request.employee.id,
      );
      return adjustmentsOut(tx, [row])[0]!;
    });
  });

  app.delete('/payroll/adjustments/:id', async (request, reply) => {
    assertOwner(request);
    const { id } = parse(idParams, request.params);
    deleteAdjustment(db, id);
    return reply.code(204).send();
  });
}
