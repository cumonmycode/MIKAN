import { and, eq, gte, lte } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { DbOrTx } from '../db/client.js';
import { employees, scheduleDays } from '../db/schema.js';
import { visibleTo } from '../domain/employee-visibility.js';
import { bookableMasters } from '../domain/free-slots.js';
import { studioTimezone } from '../domain/settings.js';
import {
  datesBetween,
  datesLabel,
  MAX_RANGE_DAYS,
  parseWeekly,
  parseWorkHours,
  scheduleDaysFor,
  workScheduleOut,
} from '../domain/work-schedule.js';
import { badRequest, notFound } from '../lib/errors.js';
import type { EmployeeRow } from '../lib/serialize.js';
import { isValidCalendarDate, localDate } from '../lib/time.js';
import { idParams, nullableText, parse } from '../lib/validation.js';
import { assertRole } from '../domain/permissions.js';
import { trackWorkingTime } from '../domain/waitlist-hooks.js';

/** Work schedules of masters (docs/API.md «Work schedules»): everyone reads, owners and admins change them. */

const date = z.string().trim().refine(isValidCalendarDate, { message: 'дата должна быть в формате ГГГГ-ММ-ДД' });
const optionalDate = z.preprocess((v) => (v === '' || v === null ? undefined : v), date.optional());
const rangeQuery = z.object({ from: date, to: date });
const fromQuery = z.object({ from: optionalDate });
const daysQuery = z.object({ from: date, to: optionalDate });
const daysBody = z.object({
  from: date,
  to: optionalDate,
  off: z.boolean().nullish(),
  start: z.unknown().optional(),
  end: z.unknown().optional(),
  breaks: z.unknown().optional(),
  note: nullableText(200),
});

/** The dates of a range: `to` not before `from`, at most MAX_RANGE_DAYS of them. */
function checkedRange(from: string, to: string): string[] {
  if (to < from) throw badRequest('Конец периода раньше начала');
  const dates = datesBetween(from, to);
  if (dates.length > MAX_RANGE_DAYS) throw badRequest(`Период — не больше ${MAX_RANGE_DAYS} дней`);
  return dates;
}

function assertCanChange(request: FastifyRequest): void {
  assertRole(request.employee, ['owner', 'admin']);
}

function employeeOr404(db: DbOrTx, id: number): EmployeeRow {
  const row = db.select().from(employees).where(eq(employees.id, id)).get();
  if (!row) throw notFound('Сотрудник не найден');
  return row;
}

export function scheduleRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;
  const today = () => localDate(Date.now(), studioTimezone(db));

  app.get('/schedules', async (request) => {
    const q = parse(rangeQuery, request.query);
    // The built-in administrator account is not shown to other employees (domain/employee-visibility.ts).
    const people = bookableMasters(db).filter(visibleTo(ctx.config, request.employee));
    return { items: scheduleDaysFor(db, people, checkedRange(q.from, q.to)) };
  });

  app.get('/employees/:id/schedule', async (request) => {
    const { id } = parse(idParams, request.params);
    const q = parse(fromQuery, request.query);
    return workScheduleOut(db, employeeOr404(db, id), q.from ?? today());
  });

  app.put('/employees/:id/schedule', async (request) => {
    assertCanChange(request);
    const { id } = parse(idParams, request.params);
    const weekly = parseWeekly((request.body as { weekly?: unknown } | null)?.weekly);
    employeeOr404(db, id);
    // Working time the change adds may be offered to the waitlist.
    const offerAdded = trackWorkingTime(db, id);
    const row = db
      .update(employees)
      .set({ weeklySchedule: weekly ? JSON.stringify(weekly) : null, updatedAt: Date.now() })
      .where(eq(employees.id, id))
      .returning()
      .get();
    offerAdded();
    return workScheduleOut(db, row, today());
  });

  app.put('/employees/:id/schedule/days', async (request) => {
    assertCanChange(request);
    const { id } = parse(idParams, request.params);
    const input = parse(daysBody, request.body);
    const to = input.to ?? input.from;
    const dates = checkedRange(input.from, to);
    const hours = input.off ? null : parseWorkHours(input, datesLabel(input.from, to));
    const employee = employeeOr404(db, id);
    const now = Date.now();
    const values = {
      off: hours === null,
      start: hours?.start ?? null,
      end: hours?.end ?? null,
      breaks: JSON.stringify(hours?.breaks ?? []),
      note: input.note ?? null,
      updatedAt: now,
    };
    const offerAdded = trackWorkingTime(db, id);
    db.transaction((tx) => {
      for (const day of dates) {
        tx.insert(scheduleDays)
          .values({ employeeId: id, date: day, ...values, createdAt: now })
          .onConflictDoUpdate({ target: [scheduleDays.employeeId, scheduleDays.date], set: values })
          .run();
      }
    });
    offerAdded();
    return workScheduleOut(db, employee, today());
  });

  app.delete('/employees/:id/schedule/days', async (request) => {
    assertCanChange(request);
    const { id } = parse(idParams, request.params);
    const q = parse(daysQuery, request.query);
    const to = q.to ?? q.from;
    if (to < q.from) throw badRequest('Конец периода раньше начала');
    const employee = employeeOr404(db, id);
    const offerAdded = trackWorkingTime(db, id);
    db.delete(scheduleDays)
      .where(and(eq(scheduleDays.employeeId, id), gte(scheduleDays.date, q.from), lte(scheduleDays.date, to)))
      .run();
    offerAdded();
    return workScheduleOut(db, employee, today());
  });
}
