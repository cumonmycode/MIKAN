import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import {
  APPOINTMENT_STATUSES,
  completeAppointment,
  createAppointment,
  listAppointments,
  updateAppointment,
} from '../domain/appointments.js';
import { getAppointmentRow, serializeAppointment, serializeAppointments } from '../domain/refs.js';
import { badRequest } from '../lib/errors.js';
import {
  idParams,
  instant,
  money,
  nonNull,
  nullableText,
  parse,
  queryId,
  queryInstant,
} from '../lib/validation.js';

const status = z.enum(APPOINTMENT_STATUSES);
const id = z.number().int().positive();
const MAX_SERVICE_LINES = 20;
const serviceLine = z.object({
  serviceId: id.nullish(),
  name: nullableText(200),
  price: money.nullish(),
  durationMin: z.number().int().min(1).max(24 * 60).nullish(),
});
const body = z.object({
  clientId: nonNull(id),
  masterId: nonNull(id),
  services: nonNull(z.array(serviceLine).max(MAX_SERVICE_LINES)),
  serviceId: id.nullish(),
  title: nullableText(300),
  startsAt: nonNull(instant),
  endsAt: nonNull(instant),
  price: nonNull(money),
  depositRequired: nonNull(money),
  notes: nullableText(5000),
  status: nonNull(status),
  force: nonNull(z.boolean()),
  notifyClient: nonNull(z.boolean()),
});
const listQuery = z.object({
  from: queryInstant,
  to: queryInstant,
  masterId: queryId,
  clientId: queryId,
  status: z.string().trim().max(200).optional(),
  onlineState: z.string().trim().max(100).optional(),
});
const completeBody = z.object({
  sendAftercare: nonNull(z.boolean()),
  aftercareTemplateId: id.nullish(),
  consumables: z
    .array(z.object({ productId: id, variantId: id.nullish(), quantity: z.number().int().min(1).max(100_000) }))
    .max(100)
    .nullish(),
});

const ONLINE_STATES = ['awaiting_payment', 'awaiting_confirmation'];

function parseOnlineStates(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const list = value.split(',').map((s) => s.trim()).filter(Boolean);
  const invalid = list.find((s) => !ONLINE_STATES.includes(s));
  if (invalid) throw badRequest(`«Онлайн-запись»: недопустимое значение «${invalid}»`);
  return list;
}

function parseStatuses(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const list = value.split(',').map((s) => s.trim()).filter(Boolean);
  const invalid = list.find((s) => !(APPOINTMENT_STATUSES as readonly string[]).includes(s));
  if (invalid) throw badRequest(`«Статус»: недопустимое значение «${invalid}»`);
  return list;
}

export function appointmentRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  app.get('/appointments', async (request) => {
    const q = parse(listQuery, request.query);
    const rows = listAppointments(db, {
      from: q.from,
      to: q.to,
      masterId: q.masterId,
      clientId: q.clientId,
      statuses: parseStatuses(q.status),
      onlineStates: parseOnlineStates(q.onlineState),
    });
    return { items: serializeAppointments(db, rows) };
  });

  app.get('/appointments/:id', async (request) => {
    const params = parse(idParams, request.params);
    return serializeAppointment(db, getAppointmentRow(db, params.id));
  });

  app.post('/appointments', async (request) => {
    const input = parse(body, request.body);
    return serializeAppointment(db, createAppointment(db, input));
  });

  app.patch('/appointments/:id', async (request) => {
    const params = parse(idParams, request.params);
    const input = parse(body, request.body);
    return serializeAppointment(db, updateAppointment(db, params.id, input, request.employee.id));
  });

  app.post('/appointments/:id/complete', async (request) => {
    const params = parse(idParams, request.params);
    const input = parse(completeBody, request.body);
    const result = completeAppointment(
      db,
      params.id,
      {
        sendAftercare: input.sendAftercare ?? true,
        aftercareTemplateId: input.aftercareTemplateId,
        // Absent (or null): the server deducts the norms of the appointment's services.
        consumables: input.consumables ?? undefined,
      },
      request.employee.id,
    );
    return { appointment: serializeAppointment(db, result.row), scheduledMessages: result.scheduled, consumption: result.consumption };
  });
}
