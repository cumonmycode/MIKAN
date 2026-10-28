import { appointments, bookingRequests, clients, employees, saleItems, sales, scheduleDays } from '../src/db/schema.js';
import type { WeeklySchedule } from '../src/domain/work-schedule.js';
import type { TestApp } from './helpers.js';

/**
 * Hand-built rows of the growth report tests, written straight to the database so every timestamp, channel, status
 * and note is exactly what the test says. Times are given with the Moscow offset (`+03:00`), the studio timezone.
 */

export type Json = Record<string, any>;

export const at = (iso: string): number => {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`bad instant ${iso}`);
  return ms;
};

const MINUTE = 60_000;
let serial = 0;
const next = () => ++serial;

export interface EmployeeOptions {
  isMaster?: boolean;
  active?: boolean;
  weekly?: WeeklySchedule | null;
}

export function addEmployee(t: TestApp, name: string, options: EmployeeOptions = {}): number {
  const now = Date.now();
  return t.ctx.db
    .insert(employees)
    .values({
      name,
      login: `growth${next()}`,
      passwordHash: 'x',
      color: '#123456',
      isMaster: options.isMaster ?? true,
      active: options.active ?? true,
      role: 'master',
      weeklySchedule: options.weekly ? JSON.stringify(options.weekly) : null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get().id;
}

/** An exception day of a master: off, or other hours. */
export function addScheduleDay(t: TestApp, employeeId: number, date: string, hours: { start: string; end: string } | null = null): void {
  const now = Date.now();
  t.ctx.db
    .insert(scheduleDays)
    .values({ employeeId, date, off: hours === null, start: hours?.start ?? null, end: hours?.end ?? null, note: 'тест', createdAt: now, updatedAt: now })
    .run();
}

export function addClient(t: TestApp, name: string, source: string | null = null, createdAt = Date.now()): number {
  return t.ctx.db
    .insert(clients)
    .values({ name, nameSort: name.toLowerCase(), source, createdAt, updatedAt: createdAt })
    .returning()
    .get().id;
}

export interface AppointmentOptions {
  masterId?: number;
  /** Start, ISO with an offset. */
  start: string;
  /** End, ISO with an offset; default start + `minutes`. */
  end?: string;
  minutes?: number;
  status?: string;
  channel?: string;
  onlineState?: string | null;
  notes?: string | null;
  /** When it was booked; default its start. */
  createdAt?: string;
}

export function addAppointment(t: TestApp, clientId: number, o: AppointmentOptions): number {
  const startsAt = at(o.start);
  const endsAt = o.end ? at(o.end) : startsAt + (o.minutes ?? 60) * MINUTE;
  const status = o.status ?? 'completed';
  const createdAt = o.createdAt ? at(o.createdAt) : startsAt;
  return t.ctx.db
    .insert(appointments)
    .values({
      clientId,
      masterId: o.masterId ?? 1,
      startsAt,
      endsAt,
      status,
      price: 1000,
      notes: o.notes ?? null,
      completedAt: status === 'completed' ? endsAt : null,
      channel: o.channel ?? 'app',
      onlineState: o.onlineState ?? null,
      createdAt,
      updatedAt: createdAt,
    })
    .returning()
    .get().id;
}

export interface SaleOptions {
  /** Made at, ISO with an offset. */
  at: string;
  total: number;
  status?: 'completed' | 'refunded';
  payBonus?: number;
  /** Total of a gift certificate line inside `total`. */
  certificate?: number;
}

export function addSale(t: TestApp, clientId: number | null, o: SaleOptions): number {
  const createdAt = at(o.at);
  const status = o.status ?? 'completed';
  const payBonus = o.payBonus ?? 0;
  const sale = t.ctx.db
    .insert(sales)
    .values({
      number: next(),
      clientId,
      employeeId: 1,
      subtotal: o.total,
      discount: 0,
      total: o.total,
      payCash: o.total - payBonus,
      payBonus,
      status,
      refundedAt: status === 'refunded' ? createdAt + 60 * MINUTE : null,
      createdAt,
    })
    .returning()
    .get();
  const certificate = o.certificate ?? 0;
  const service = o.total - certificate;
  if (service > 0) {
    t.ctx.db.insert(saleItems).values({ saleId: sale.id, type: 'service', name: 'Услуга', quantity: 1, price: service, total: service }).run();
  }
  if (certificate > 0) {
    t.ctx.db
      .insert(saleItems)
      .values({ saleId: sale.id, type: 'certificate', certificateId: next(), name: 'Подарочный сертификат', quantity: 1, price: certificate, total: certificate })
      .run();
  }
  return sale.id;
}

export function addBookingRequest(t: TestApp, status: string, createdAt: string): void {
  const ms = at(createdAt);
  t.ctx.db.insert(bookingRequests).values({ contactName: 'Гость', status, createdAt: ms, updatedAt: ms }).run();
}

/** Mon–Fri 10:00–19:00 with a 14:00–15:00 break (480 working minutes), weekends off. */
export const WEEKDAYS_10_19: WeeklySchedule = [
  ...Array.from({ length: 5 }, () => ({ start: '10:00', end: '19:00', breaks: [{ start: '14:00', end: '15:00' }] })),
  null,
  null,
];

export const ALL_DAYS_OFF: WeeklySchedule = [null, null, null, null, null, null, null];
