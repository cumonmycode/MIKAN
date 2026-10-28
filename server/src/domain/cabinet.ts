import { and, asc, desc, eq, gt, gte, inArray, isNull, lte, notInArray, or } from 'drizzle-orm';
import { appointmentWhat } from '../bot/client-appointments.js';
import type { DbOrTx } from '../db/client.js';
import { aftercareTemplates, appointments, bonusOperations, giftCertificates } from '../db/schema.js';
import { parseSteps, type AppointmentRow, type ClientRow } from '../lib/serialize.js';
import { DAY_MS, localDate, toIso } from '../lib/time.js';
import { bonusBalance, nearestExpiring } from './bonuses.js';
import { freeUntil } from './cancellation.js';
import { heldDeposit } from './deposits.js';
import { onlineMasters } from './online-booking-slots.js';
import { employeesByIds, serviceLinesByAppointment, servicesByIds } from './refs.js';
import { getRetentionSettings } from './retention-settings.js';
import { getStudioSettings, type CancellationRules } from './settings.js';
import { clientOpenEntries, publicWaitlistEntries } from './waitlist.js';

/**
 * What the client sees in their cabinet (docs/API.md «Client cabinet»): their appointments with what they may do with
 * them, bonuses, certificates, aftercare memos and waitlist entries — never internal fields (notes, costs, staff data).
 */

/** Past appointments shown. */
export const PAST_LIMIT = 20;
/** Bonus operations in `GET /public/cabinet/bonuses`. */
export const BONUS_HISTORY_LIMIT = 50;
/** Aftercare memos of the visits of this many last days. */
export const AFTERCARE_DAYS = 60;

const ACTIVE = ['scheduled', 'confirmed'];

export interface CabinetAppointment {
  id: number;
  startsAt: string;
  endsAt: string;
  status: string;
  onlineState: string | null;
  items: Array<{ name: string; price: number }>;
  master: { name: string };
  price: number;
  /** The prepayment the studio holds now. */
  deposit: number;
  depositRequired: number;
  /** Until when cancelling keeps the prepayment whole; null when there is no prepayment or it never is free. */
  freeCancellationUntil: string | null;
  canReschedule: boolean;
  canCancel: boolean;
  /** The booking page `/book/b/<token>` of an online booking. */
  bookingToken: string | null;
}

/**
 * The rules' free-change time of a prepaid appointment is over: «Бесплатно отменить или перенести запись можно не
 * позднее чем за N часов». The cabinet then offers no move — a move to a later day followed by a cancellation would
 * otherwise turn a late cancellation into a free one. Without a prepayment, or with no free time at all
 * (`freeHours` 0: every cancellation is late anyway), nothing is locked.
 */
export function freeChangesOver(a: Pick<AppointmentRow, 'startsAt' | 'depositRequired'>, held: number, rules: CancellationRules, now: number): boolean {
  if (held <= 0 && a.depositRequired <= 0) return false;
  const until = freeUntil(a.startsAt, rules);
  return until !== null && now > until;
}

/** A future appointment the client may still change (until it starts). */
export const isChangeable = (a: Pick<AppointmentRow, 'status' | 'startsAt'>, now: number): boolean =>
  ACTIVE.includes(a.status) && a.startsAt > now;

/** Appointment rows as the cabinet shows them. */
export function cabinetAppointments(db: DbOrTx, rows: AppointmentRow[], now = Date.now()): CabinetAppointment[] {
  const studio = getStudioSettings(db);
  const online = studio.onlineBooking.enabled;
  const onlineMasterIds = new Set(onlineMasters(db).map((m) => m.id));
  const masters = employeesByIds(db, rows.map((a) => a.masterId));
  const lines = serviceLinesByAppointment(db, rows.map((a) => a.id));
  const what = appointmentWhat(db, rows.filter((a) => !lines.get(a.id)?.length));
  return rows.map((a) => {
    const open = isChangeable(a, now);
    const held = heldDeposit(db, a.id);
    const until = open && (held > 0 || a.depositRequired > 0) ? freeUntil(a.startsAt, studio.cancellation) : null;
    const own = lines.get(a.id) ?? [];
    return {
      id: a.id,
      startsAt: toIso(a.startsAt),
      endsAt: toIso(a.endsAt),
      status: a.status,
      onlineState: a.onlineState,
      items: own.length ? own.map((l) => ({ name: l.name, price: l.price })) : [{ name: what.get(a.id) ?? 'процедура', price: a.price }],
      master: { name: masters.get(a.masterId)?.name ?? '' },
      price: a.price,
      deposit: held,
      depositRequired: a.depositRequired,
      freeCancellationUntil: toIso(until),
      canReschedule: online && open && onlineMasterIds.has(a.masterId) && !freeChangesOver(a, held, studio.cancellation, now),
      canCancel: online && open,
      bookingToken: a.publicToken,
    };
  });
}

export const cabinetAppointment = (db: DbOrTx, row: AppointmentRow, now = Date.now()): CabinetAppointment =>
  cabinetAppointments(db, [row], now)[0]!;

/** Scheduled / confirmed appointments that have not ended (soonest first) — the rest is the past. */
function upcomingRows(db: DbOrTx, clientId: number, now: number): AppointmentRow[] {
  return db
    .select()
    .from(appointments)
    .where(and(eq(appointments.clientId, clientId), inArray(appointments.status, ACTIVE), gt(appointments.endsAt, now)))
    .orderBy(asc(appointments.startsAt), asc(appointments.id))
    .all();
}

function pastRows(db: DbOrTx, clientId: number, now: number): AppointmentRow[] {
  return db
    .select()
    .from(appointments)
    .where(and(eq(appointments.clientId, clientId), or(notInArray(appointments.status, ACTIVE), lte(appointments.endsAt, now))))
    .orderBy(desc(appointments.startsAt), desc(appointments.id))
    .limit(PAST_LIMIT)
    .all();
}

/** Certificates the client bought that can still be spent. */
function activeCertificates(db: DbOrTx, clientId: number, now: number) {
  return db
    .select()
    .from(giftCertificates)
    .where(
      and(
        eq(giftCertificates.buyerClientId, clientId),
        eq(giftCertificates.status, 'active'),
        gt(giftCertificates.balance, 0),
        or(isNull(giftCertificates.expiresAt), gt(giftCertificates.expiresAt, now)),
      ),
    )
    .orderBy(desc(giftCertificates.createdAt), desc(giftCertificates.id))
    .all()
    .map((c) => ({ code: c.code, balance: c.balance, expiresAt: toIso(c.expiresAt) }));
}

export interface CabinetMemo {
  appointmentId: number;
  /** Studio-local date of the visit. */
  date: string;
  title: string;
  steps: Array<{ day: number; text: string }>;
}

/**
 * Aftercare memos of the client's completed visits of the last 60 days, newest first: the template of the visit's
 * first fresh procedure that has one (as completing it picks by default).
 */
export function aftercareMemos(db: DbOrTx, clientId: number, now: number): CabinetMemo[] {
  const visits = db
    .select()
    .from(appointments)
    .where(and(eq(appointments.clientId, clientId), eq(appointments.status, 'completed'), gte(appointments.startsAt, now - AFTERCARE_DAYS * DAY_MS)))
    .orderBy(desc(appointments.startsAt), desc(appointments.id))
    .all();
  if (visits.length === 0) return [];
  const lines = serviceLinesByAppointment(db, visits.map((a) => a.id));
  const serviceIdsOf = (a: AppointmentRow) => {
    const own = lines.get(a.id) ?? [];
    return own.length ? own.map((l) => l.serviceId) : [a.serviceId];
  };
  const catalog = servicesByIds(db, visits.flatMap(serviceIdsOf));
  const templateIdOf = (a: AppointmentRow): number | null =>
    serviceIdsOf(a)
      .map((id) => (id != null ? catalog.get(id) : undefined))
      .find((s) => s?.freshProcedure && s.aftercareTemplateId != null)?.aftercareTemplateId ?? null;
  const templateIds = [...new Set(visits.map(templateIdOf).filter((id): id is number => id !== null))];
  if (templateIds.length === 0) return [];
  const templates = new Map(db.select().from(aftercareTemplates).where(inArray(aftercareTemplates.id, templateIds)).all().map((t) => [t.id, t]));
  const tz = getStudioSettings(db).timezone;
  return visits.flatMap((a): CabinetMemo[] => {
    const id = templateIdOf(a);
    const template = id !== null ? templates.get(id) : undefined;
    if (!template) return [];
    const steps = [...parseSteps(template.stepsJson)].sort((x, y) => x.dayOffset - y.dayOffset).map((s) => ({ day: s.dayOffset, text: s.text }));
    return [{ appointmentId: a.id, date: localDate(a.startsAt, tz), title: template.name, steps }];
  });
}

/** `Cabinet.loyalty`: null while the loyalty program is off (bonuses cannot be spent then). */
function loyaltyOf(db: DbOrTx, clientId: number, now: number) {
  if (!getRetentionSettings(db).loyalty.enabled) return null;
  const expiring = nearestExpiring(db, clientId, now);
  return { bonusBalance: bonusBalance(db, clientId, now), expiring: expiring ? { amount: expiring.amount, at: toIso(expiring.at) } : null };
}

/** `GET /public/cabinet`; `phone` is masked by the route; `birthday` null — the cabinet offers to add it. */
export function buildCabinet(db: DbOrTx, client: ClientRow, now = Date.now()) {
  return {
    client: { name: client.name, phone: client.phone, birthday: client.birthday },
    loyalty: loyaltyOf(db, client.id, now),
    upcoming: cabinetAppointments(db, upcomingRows(db, client.id, now), now),
    past: cabinetAppointments(db, pastRows(db, client.id, now), now),
    waitlist: publicWaitlistEntries(db, clientOpenEntries(db, client.id)),
    certificates: activeCertificates(db, client.id, now),
    aftercare: aftercareMemos(db, client.id, now),
  };
}

/** `GET /public/cabinet/bonuses`: the balance and the last operations, newest first. */
export function cabinetBonuses(db: DbOrTx, clientId: number, now = Date.now()) {
  const rows = db
    .select()
    .from(bonusOperations)
    .where(eq(bonusOperations.clientId, clientId))
    .orderBy(desc(bonusOperations.createdAt), desc(bonusOperations.id))
    .limit(BONUS_HISTORY_LIMIT)
    .all();
  return {
    balance: bonusBalance(db, clientId, now),
    items: rows.map((r) => ({ type: r.type, amount: r.amount, expiresAt: toIso(r.expiresAt), createdAt: toIso(r.createdAt), note: r.note })),
  };
}
