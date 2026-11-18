import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import {
  createExpense,
  deleteExpense,
  EXPENSE_CATEGORIES,
  EXPENSE_REPEATS,
  expensesOut,
  listExpenses,
  updateExpense,
} from '../domain/expenses.js';
import { idempotent } from '../lib/idempotency.js';
import { isValidCalendarDate } from '../lib/time.js';
import { idParams, money, nullableText, parse } from '../lib/validation.js';

/** Studio expenses (docs/API.md «Expenses»): rent and bills every month, one-time purchases. Owner and admin only. */

const studioDate = z.string().trim().refine(isValidCalendarDate, { message: 'дата должна быть в формате ГГГГ-ММ-ДД' });

const fields = {
  name: z.string().trim().min(1, { message: 'укажите название' }).max(120),
  category: z.enum(EXPENSE_CATEGORIES),
  amount: money.refine((v) => v > 0, { message: 'сумма должна быть больше 0' }),
  repeat: z.enum(EXPENSE_REPEATS),
  date: studioDate,
  endDate: studioDate.nullish(),
  note: nullableText(300),
};

const createBody = z.object(fields);
const patchBody = z.object(fields).partial();

export function expenseRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  app.get('/expenses', async () => ({ items: expensesOut(db, listExpenses(db)) }));

  app.post('/expenses', async (request, reply) => {
    const input = parse(createBody, request.body);
    return idempotent(db, request, reply, (tx) => {
      const row = createExpense(tx, { ...input, endDate: input.endDate ?? null, note: input.note ?? null }, request.employee.id);
      return expensesOut(tx, [row])[0]!;
    });
  });

  app.patch('/expenses/:id', async (request) => {
    const { id } = parse(idParams, request.params);
    const patch = parse(patchBody, request.body);
    return expensesOut(db, [updateExpense(db, id, patch)])[0]!;
  });

  app.delete('/expenses/:id', async (request, reply) => {
    const { id } = parse(idParams, request.params);
    deleteExpense(db, id);
    return reply.code(204).send();
  });
}
