import { and, asc, eq, gt, inArray, lt, ne, notInArray } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import {
  aftercareTemplates,
  appointments,
  appointmentServices,
  clients,
  employees,
  services,
} from '../db/schema.js';
import { badRequest, conflict, scheduleConflict } from '../lib/errors.js';
import { clientFullName, parseSteps, type AppointmentRow, type AppointmentServiceRow, type ServiceRow } from '../lib/serialize.js';
import { formatShortDate, formatTime, MINUTE_MS } from '../lib/time.js';
import { autoRetainDeposit, cancelPendingDepositCodes } from './deposits.js';
import { deleteReceiptOfAppointment } from './receipts.js';
import { getAppointmentRow, getClientRow, serviceLinesByAppointment, servicesByIds } from './refs.js';
import { pricingMaster, servicePriceFor } from './service-prices.js';
import { studioTimezone } from './settings.js';
import { cancelPendingForAppointment, hasAftercare, scheduleAftercare, syncReminder } from './scheduling.js';
import { applyConsumptionNorms, noConsumption, recordListedUsage, usageRecorded } from './consumption.js';
import { scheduleFollowUps } from './follow-ups.js';
import { syncRescheduleNotice } from './reschedule-notice.js';
import { assertWorkingTime } from './working-time.js';
import { markWaitlistBooked, noteFreedTime } from './waitlist-hooks.js';

export const APPOINTMENT_STATUSES = ['scheduled', 'confirmed', 'completed', 'cancelled', 'no_show'] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];
const INACTIVE_FOR_OVERLAP = ['cancelled', 'no_show'];
/** Statuses in which nobody waits for a prepayment link to be paid any more. */
const CLOSED_FOR_DEPOSIT = ['cancelled', 'no_show', 'completed'];

/** One booked service as sent by the app; omitted fields default from the catalog service. */
export interface ServiceLineInput {
  serviceId?: number | null;
  name?: string | null;
  price?: number | null;
  durationMin?: number | null;
}

/** A resolved service line, ready to be stored in `appointment_services`. */
interface ServiceLine {
  serviceId: number | null;
  name: string;
  price: number;
  durationMin: number | null;
}

export interface AppointmentInput {
  clientId?: number;
  masterId?: number;
  /** Replaces all service lines when present (`[]` clears them). */
  services?: ServiceLineInput[];
  /** Legacy single service (older app builds); used only when `services` is absent. */
  serviceId?: number | null;
  title?: string | null;
  startsAt?: number;
  endsAt?: number;
  price?: number;
  /** Prepayment the studio asks for; defaults to the lines' catalog `depositAmount`. */
  depositRequired?: number;
  notes?: string | null;
  status?: AppointmentStatus;
  force?: boolean;
  /** PATCH that changes `startsAt`: tell the client in Telegram (see domain/reschedule-notice.ts). */
  notifyClient?: boolean;
}

export interface AppointmentFilter {
  from?: number;
  to?: number;
  masterId?: number;
  clientId?: number;
  statuses?: string[];
  /** Unsettled online bookings in these states (`awaiting_payment`, `awaiting_confirmation`), still open. */
  onlineStates?: string[];
}

export function listAppointments(db: DbOrTx, f: AppointmentFilter): AppointmentRow[] {
  const conditions = [];
  if (f.to !== undefined) conditions.push(lt(appointments.startsAt, f.to));
  if (f.from !== undefined) conditions.push(gt(appointments.endsAt, f.from));
  if (f.masterId !== undefined) conditions.push(eq(appointments.masterId, f.masterId));
  if (f.clientId !== undefined) conditions.push(eq(appointments.clientId, f.clientId));
  if (f.statuses && f.statuses.length > 0) conditions.push(inArray(appointments.status, f.statuses));
  if (f.onlineStates && f.onlineStates.length > 0) {
    conditions.push(inArray(appointments.onlineState, f.onlineStates), inArray(appointments.status, ['scheduled', 'confirmed']));
  }
  return db
    .select()
    .from(appointments)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(appointments.startsAt), asc(appointments.id))
    .all();
}

function assertOverlapFree(db: DbOrTx, a: { id?: number; masterId: number; startsAt: number; endsAt: number }): void {
  const conditions = [
    eq(appointments.masterId, a.masterId),
    lt(appointments.startsAt, a.endsAt),
    gt(appointments.endsAt, a.startsAt),
    notInArray(appointments.status, INACTIVE_FOR_OVERLAP),
  ];
  if (a.id !== undefined) conditions.push(ne(appointments.id, a.id));
  const clash = db.select().from(appointments).where(and(...conditions)).orderBy(asc(appointments.startsAt)).get();
  if (!clash) return;
  const tz = studioTimezone(db);
  const client = db.select().from(clients).where(eq(clients.id, clash.clientId)).get();
  throw scheduleConflict(
    `У мастера уже есть запись в это время: ${client ? clientFullName(client) : 'клиент'}, ` +
      `${formatShortDate(clash.startsAt, tz)} ${formatTime(clash.startsAt, tz)}–${formatTime(clash.endsAt, tz)}`,
  );
}

function assertMaster(db: DbOrTx, masterId: number): void {
  const master = db.select().from(employees).where(eq(employees.id, masterId)).get();
  if (!master) throw badRequest('Мастер не найден');
  if (!master.active) throw badRequest(`Сотрудник «${master.name}» отключён`);
}

function loadService(db: DbOrTx, serviceId: number) {
  const service = db.select().from(services).where(eq(services.id, serviceId)).get();
  if (!service) throw badRequest('Услуга не найдена');
  return service;
}

function clientMustExist(db: DbOrTx, clientId: number): void {
  if (!db.select({ id: clients.id }).from(clients).where(eq(clients.id, clientId)).get()) {
    throw badRequest('Клиент не найден');
  }
}

/** `masterId` — the appointment's master: a catalog line without a price gets theirs (see «Service» `masterPrices`). */
function resolveLines(db: DbOrTx, inputs: ServiceLineInput[], masterId: number | null): ServiceLine[] {
  const catalog = servicesByIds(db, inputs.map((l) => l.serviceId));
  return inputs.map((line, index) => {
    const name = line.name?.trim() || null;
    if (line.serviceId != null) {
      const service = catalog.get(line.serviceId);
      if (!service) throw badRequest('Услуга не найдена');
      return {
        serviceId: service.id,
        name: name ?? service.name,
        price: line.price ?? servicePriceFor(service, null, masterId),
        durationMin: line.durationMin ?? service.durationMin,
      };
    }
    if (!name) throw badRequest(`Позиция №${index + 1}: укажите название услуги`);
    return { serviceId: null, name, price: line.price ?? 0, durationMin: line.durationMin ?? null };
  });
}

const singleServiceLine = (service: ServiceRow, price: number | undefined, masterId: number | null): ServiceLine => ({
  serviceId: service.id,
  name: service.name,
  price: price ?? servicePriceFor(service, null, masterId),
  durationMin: service.durationMin,
});

/**
 * The service lines the appointment should have after this write, or `undefined` when they stay as they are.
 * `services` wins; the legacy `serviceId` keeps the lines when it names the current first catalog service
 * (`null` included: older builds always send `serviceId: null` for appointments with custom lines only), replaces
 * them with that single service otherwise, and clears them when `null` drops the current catalog service.
 */
function proposedLines(db: DbOrTx, input: AppointmentInput, current: ServiceLine[], masterId: number): ServiceLine[] | undefined {
  // Lines without a price cost what the appointment's master charges.
  const priceMaster = () => pricingMaster(db, masterId);
  if (input.services !== undefined) return resolveLines(db, input.services, priceMaster());
  if (input.serviceId === undefined) return undefined;
  if (input.serviceId === firstServiceId(current)) return undefined;
  if (input.serviceId === null) return [];
  return [singleServiceLine(loadService(db, input.serviceId), input.price, priceMaster())];
}

const firstServiceId = (lines: ServiceLine[]): number | null => lines.find((l) => l.serviceId != null)?.serviceId ?? null;
const linesTotal = (lines: ServiceLine[]): number => lines.reduce((sum, l) => sum + l.price, 0);
const linesMinutes = (lines: ServiceLine[]): number => lines.reduce((sum, l) => sum + (l.durationMin ?? 0), 0);

/** Sum of the catalog prepayments of the lines (a service booked twice counts twice). */
function linesDeposit(db: DbOrTx, lines: ServiceLine[]): number {
  const catalog = servicesByIds(db, lines.map((l) => l.serviceId));
  return lines.reduce((sum, l) => sum + (l.serviceId != null ? (catalog.get(l.serviceId)?.depositAmount ?? 0) : 0), 0);
}

function sameLines(a: ServiceLine[], b: ServiceLine[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (l, i) =>
        l.serviceId === b[i]!.serviceId &&
        l.name === b[i]!.name &&
        l.price === b[i]!.price &&
        l.durationMin === b[i]!.durationMin,
    )
  );
}

function currentLines(db: DbOrTx, appointmentId: number): AppointmentServiceRow[] {
  return serviceLinesByAppointment(db, [appointmentId]).get(appointmentId) ?? [];
}

function writeLines(db: DbOrTx, appointmentId: number, lines: ServiceLine[]): void {
  db.delete(appointmentServices).where(eq(appointmentServices.appointmentId, appointmentId)).run();
  if (lines.length === 0) return;
  db.insert(appointmentServices)
    .values(lines.map((line, position) => ({ ...line, appointmentId, position })))
    .run();
}

/** Default end: start + the lines' total duration, else the legacy service's duration. */
function defaultEndsAt(db: DbOrTx, input: AppointmentInput, startsAt: number, lines: ServiceLine[]): number | undefined {
  const minutes = linesMinutes(lines);
  if (minutes > 0) return startsAt + minutes * MINUTE_MS;
  if (input.serviceId != null) return startsAt + loadService(db, input.serviceId).durationMin * MINUTE_MS;
  return undefined;
}

export function createAppointment(db: DbOrTx, input: AppointmentInput): AppointmentRow {
  return db.transaction((tx) => {
    if (input.clientId === undefined) throw badRequest('«Клиент»: обязательное поле');
    if (input.masterId === undefined) throw badRequest('«Мастер»: обязательное поле');
    if (input.startsAt === undefined) throw badRequest('«Начало»: обязательное поле');
    clientMustExist(tx, input.clientId);
    assertMaster(tx, input.masterId);
    const lines = proposedLines(tx, input, [], input.masterId) ?? [];
    const endsAt = input.endsAt ?? defaultEndsAt(tx, input, input.startsAt, lines);
    if (endsAt === undefined) throw badRequest('«Окончание»: обязательное поле');
    if (endsAt <= input.startsAt) throw badRequest('Окончание записи должно быть позже начала');
    const status = input.status ?? 'scheduled';
    if (!input.force && !INACTIVE_FOR_OVERLAP.includes(status)) {
      assertWorkingTime(tx, input.masterId, input.startsAt, endsAt);
      assertOverlapFree(tx, { masterId: input.masterId, startsAt: input.startsAt, endsAt });
    }
    const now = Date.now();
    const row = tx
      .insert(appointments)
      .values({
        clientId: input.clientId,
        masterId: input.masterId,
        serviceId: firstServiceId(lines),
        title: input.title ?? null,
        startsAt: input.startsAt,
        endsAt,
        status,
        price: input.price ?? linesTotal(lines),
        depositRequired: input.depositRequired ?? linesDeposit(tx, lines),
        notes: input.notes ?? null,
        completedAt: status === 'completed' ? now : null,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    writeLines(tx, row.id, lines);
    syncReminder(tx, row, now);
    markWaitlistBooked(tx, row, lines.map((l) => l.serviceId), now);
    return row;
  });
}

/**
 * Older builds edit only the appointment price. When the lines are kept and the appointment has exactly one line
 * that carried the old total, that line follows the new price (so the history shows what was charged).
 */
function repricedSingleLine(
  input: AppointmentInput,
  current: AppointmentRow,
  keptLines: AppointmentServiceRow[],
): { id: number; price: number } | undefined {
  if (input.services !== undefined || input.price === undefined || input.price === current.price) return undefined;
  const [only, ...rest] = keptLines;
  if (!only || rest.length > 0 || only.price !== current.price) return undefined;
  return { id: only.id, price: input.price };
}

/** `actorId` — the employee making the change (recorded on a prepayment the rules retain by themselves). */
export function updateAppointment(db: DbOrTx, id: number, input: AppointmentInput, actorId: number | null = null): AppointmentRow {
  return db.transaction((tx) => {
    const current = getAppointmentRow(tx, id);
    if (input.clientId !== undefined) clientMustExist(tx, input.clientId);
    if (input.masterId !== undefined && input.masterId !== current.masterId) assertMaster(tx, input.masterId);
    const before = currentLines(tx, id);
    const proposed = proposedLines(tx, input, before, input.masterId ?? current.masterId);
    // Re-sending identical lines keeps the stored rows (and their ids, used by the history).
    const replaced = proposed !== undefined && !sameLines(proposed, before) ? proposed : undefined;
    const lines = replaced ?? before;
    const repriced = repricedSingleLine(input, current, replaced === undefined ? before : []);
    const next = {
      clientId: input.clientId ?? current.clientId,
      masterId: input.masterId ?? current.masterId,
      serviceId: firstServiceId(lines),
      title: input.title === undefined ? current.title : input.title,
      startsAt: input.startsAt ?? current.startsAt,
      endsAt: input.endsAt ?? current.endsAt,
      status: input.status ?? current.status,
      price: input.price ?? (input.services !== undefined ? linesTotal(lines) : current.price),
      depositRequired:
        input.depositRequired ?? (input.services !== undefined ? linesDeposit(tx, lines) : current.depositRequired),
      notes: input.notes === undefined ? current.notes : input.notes,
    };
    if (input.startsAt !== undefined && input.endsAt === undefined) {
      next.endsAt = next.startsAt + (current.endsAt - current.startsAt);
    }
    if (next.endsAt <= next.startsAt) throw badRequest('Окончание записи должно быть позже начала');
    const timingChanged =
      next.startsAt !== current.startsAt || next.endsAt !== current.endsAt || next.masterId !== current.masterId;
    const reactivated = INACTIVE_FOR_OVERLAP.includes(current.status) && !INACTIVE_FOR_OVERLAP.includes(next.status);
    // A master's own schedule is checked on moves only (status changes and edits that keep the time are not).
    if (!input.force && !INACTIVE_FOR_OVERLAP.includes(next.status) && timingChanged) {
      assertWorkingTime(tx, next.masterId, next.startsAt, next.endsAt);
    }
    if (!input.force && !INACTIVE_FOR_OVERLAP.includes(next.status) && (timingChanged || reactivated)) {
      assertOverlapFree(tx, { id, masterId: next.masterId, startsAt: next.startsAt, endsAt: next.endsAt });
    }
    const now = Date.now();
    const completedAt = next.status === 'completed' ? (current.completedAt ?? now) : current.completedAt;
    const row = tx
      .update(appointments)
      .set({ ...next, completedAt, updatedAt: now })
      .where(eq(appointments.id, id))
      .returning()
      .get();
    if (replaced) writeLines(tx, id, replaced);
    if (next.status !== current.status && CLOSED_FOR_DEPOSIT.includes(next.status)) cancelPendingDepositCodes(tx, id, now);
    if (next.status !== current.status && INACTIVE_FOR_OVERLAP.includes(next.status)) deleteReceiptOfAppointment(tx, id);
    if (repriced) {
      tx.update(appointmentServices).set({ price: repriced.price }).where(eq(appointmentServices.id, repriced.id)).run();
    }
    const reminderRelevant =
      timingChanged || next.status !== current.status || next.clientId !== current.clientId || replaced !== undefined;
    if (reminderRelevant) syncReminder(tx, row, now);
    syncRescheduleNotice(tx, current, row, input.notifyClient === true, now);
    noteFreedTime(tx, current, row, now);
    const closedWithoutVisit =
      INACTIVE_FOR_OVERLAP.includes(next.status) && !INACTIVE_FOR_OVERLAP.includes(current.status);
    return (closedWithoutVisit ? autoRetainDeposit(tx, row, now, actorId) : null) ?? row;
  });
}

/**
 * The appointment's catalog services marked «Свежий прокол» / «Свежее тату», in line order (the legacy single
 * service when it has no lines). Aftercare memos are sent only when there is at least one.
 */
function freshServices(db: DbOrTx, appointment: AppointmentRow): ServiceRow[] {
  const lines = currentLines(db, appointment.id);
  const ids = lines.length ? lines.map((l) => l.serviceId) : [appointment.serviceId];
  const catalog = servicesByIds(db, ids);
  return ids
    .map((id) => (id != null ? catalog.get(id) : undefined))
    .filter((s): s is ServiceRow => s !== undefined && s.freshProcedure);
}

export interface CompleteInput {
  sendAftercare: boolean;
  aftercareTemplateId?: number | null;
  /** `undefined` — deduct the norms of the appointment's services; a list — exactly these (strict). */
  consumables?: Array<{ productId: number; variantId?: number | null; quantity: number }>;
}

export function completeAppointment(db: DbOrTx, id: number, input: CompleteInput, employeeId: number) {
  return db.transaction((tx) => {
    const current = getAppointmentRow(tx, id);
    if (current.status === 'cancelled') throw conflict('Нельзя завершить отменённую запись');
    const now = Date.now();
    // Idempotent: a retried/double-tapped complete must not deduct consumables twice.
    let consumption = noConsumption();
    if (!usageRecorded(tx, id)) {
      consumption = input.consumables === undefined
        ? applyConsumptionNorms(tx, current, employeeId)
        : recordListedUsage(tx, id, input.consumables, employeeId);
    }
    const completedAt = current.completedAt ?? now;
    const row = tx
      .update(appointments)
      .set({ status: 'completed', completedAt, updatedAt: now })
      .where(eq(appointments.id, id))
      .returning()
      .get();
    cancelPendingForAppointment(tx, id, 'reminder');
    cancelPendingDepositCodes(tx, id, now);

    let scheduled = 0;
    const fresh = input.sendAftercare ? freshServices(tx, row) : [];
    if (fresh.length > 0 && !hasAftercare(tx, id)) {
      const templateId = input.aftercareTemplateId ?? fresh.find((s) => s.aftercareTemplateId != null)?.aftercareTemplateId ?? null;
      if (templateId != null) {
        const template = tx.select().from(aftercareTemplates).where(eq(aftercareTemplates.id, templateId)).get();
        if (!template) throw badRequest('Памятка по уходу не найдена');
        const client = getClientRow(tx, row.clientId);
        scheduled = scheduleAftercare(tx, row, client, parseSteps(template.stepsJson), completedAt);
      }
    }
    // The healing check-in and the jewelry change reminder do not depend on the memo switch.
    scheduleFollowUps(tx, row, completedAt, now);
    return { row, scheduled, consumption };
  });
}
