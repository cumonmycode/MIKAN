import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import { DateTime } from 'luxon';
import type { AppContext } from '../context.js';
import type { DbOrTx } from '../db/client.js';
import { appointments, clients } from '../db/schema.js';
import { updateAppointment } from '../domain/appointments.js';
import { auditClientConfirm, auditClientReschedule } from '../domain/audit-events.js';
import { SLOT_HORIZON_DAYS, SLOT_LEAD_MIN, withinWorkingHours } from '../domain/free-slots.js';
import { employeesByIds, serviceLinesByAppointment, servicesByIds } from '../domain/refs.js';
import { ACTIVE_APPOINTMENT_STATUSES } from '../domain/scheduling.js';
import { studioTimezone } from '../domain/settings.js';
import { AppError } from '../lib/errors.js';
import { clientFullName, type AppointmentRow } from '../lib/serialize.js';
import { DAY_MS, formatHumanDateTime, formatTime, MINUTE_MS } from '../lib/time.js';
import { notifyStaff } from './staff.js';

/** What a client may do with their own appointments through the bot: see, confirm and move them. */

const STATUS_LABELS: Record<string, string> = {
  scheduled: 'ожидает подтверждения',
  confirmed: 'подтверждена',
  completed: 'завершена',
  cancelled: 'отменена',
  no_show: 'неявка',
};

export const statusLabel = (status: string): string => STATUS_LABELS[status] ?? status;

export function upcomingForClient(db: DbOrTx, clientId: number, now = Date.now()): AppointmentRow[] {
  return db
    .select()
    .from(appointments)
    .where(and(eq(appointments.clientId, clientId), gt(appointments.startsAt, now), inArray(appointments.status, [...ACTIVE_APPOINTMENT_STATUSES])))
    .orderBy(asc(appointments.startsAt), asc(appointments.id))
    .limit(10)
    .all();
}

/** Service line names, else the legacy single service, else the free-form title. */
export function appointmentWhat(db: DbOrTx, rows: AppointmentRow[]): Map<number, string> {
  const lines = serviceLinesByAppointment(db, rows.map((a) => a.id));
  const legacy = servicesByIds(db, rows.map((a) => a.serviceId));
  return new Map(
    rows.map((a) => [
      a.id,
      (lines.get(a.id) ?? []).map((l) => l.name).join(', ') ||
        (a.serviceId != null ? legacy.get(a.serviceId)?.name : undefined) ||
        a.title?.trim() ||
        'процедура',
    ]),
  );
}

/** «№5 · суббота, 17 октября в 14:00–16:00 · Хеликс · мастер Анна · подтверждена» */
export function describeForClient(db: DbOrTx, rows: AppointmentRow[]): string[] {
  const tz = studioTimezone(db);
  const what = appointmentWhat(db, rows);
  const masters = employeesByIds(db, rows.map((a) => a.masterId));
  return rows.map(
    (a) =>
      `№${a.id} · ${formatHumanDateTime(a.startsAt, tz)}–${formatTime(a.endsAt, tz)} · ${what.get(a.id)} · ` +
      `мастер ${masters.get(a.masterId)?.name ?? '—'} · ${statusLabel(a.status)}`,
  );
}

/**
 * A moment the model names: studio-local «YYYY-MM-DD HH:MM» (also with «T»), or an ISO instant with an explicit
 * offset. Null when malformed.
 */
export function parseStudioDateTime(value: string, tz: string): number | null {
  const text = value.trim();
  const local = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})$/.exec(text);
  if (local) {
    const dt = DateTime.fromISO(`${local[1]}T${local[2]!.padStart(2, '0')}:${local[3]}`, { zone: tz });
    return dt.isValid ? dt.toMillis() : null;
  }
  if (!/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(text)) return null;
  const dt = DateTime.fromISO(text, { setZone: true });
  return dt.isValid ? dt.toMillis() : null;
}

/** «2026-10-17 14:00» in the studio timezone — the form the model passes back to reschedule_appointment. */
export const studioDateTimeText = (ms: number, tz: string): string => DateTime.fromMillis(ms, { zone: tz }).toFormat('yyyy-MM-dd HH:mm');

export type ClientAppointmentResult = { ok: true; appointment: AppointmentRow; text: string } | { ok: false; text: string };

/** The client's own future scheduled / confirmed appointment, or why it cannot be changed through the bot. */
export function ownActiveAppointment(db: DbOrTx, clientId: number, appointmentId: number, now = Date.now()): ClientAppointmentResult {
  const row = db.select().from(appointments).where(eq(appointments.id, appointmentId)).get();
  if (!row || row.clientId !== clientId) return { ok: false, text: `Запись №${appointmentId} не найдена среди записей этого клиента.` };
  if (!(ACTIVE_APPOINTMENT_STATUSES as readonly string[]).includes(row.status) || row.startsAt <= now) {
    return { ok: false, text: `Запись №${appointmentId} уже неактуальна (${statusLabel(row.status)}).` };
  }
  return { ok: true, appointment: row, text: '' };
}

/**
 * Moves the client's appointment to `startsAt` keeping its duration and master. Only inside the master's working time,
 * not in the past, through the regular schedule-conflict check; reminders are re-synced by the domain update.
 * `dryRun` (the app's bot test) checks everything and writes nothing.
 */
export async function rescheduleForClient(
  ctx: AppContext,
  input: { clientId: number; appointmentId: number; startsAt: number; dryRun?: boolean },
  now = Date.now(),
): Promise<ClientAppointmentResult> {
  const { db } = ctx;
  const own = ownActiveAppointment(db, input.clientId, input.appointmentId, now);
  if (!own.ok) return own;
  const current = own.appointment;
  const tz = studioTimezone(db);
  const endsAt = input.startsAt + (current.endsAt - current.startsAt);
  if (input.startsAt < now + SLOT_LEAD_MIN * MINUTE_MS) {
    return { ok: false, text: 'Это время уже прошло или слишком близко — предложи более позднее время из free_slots.' };
  }
  if (input.startsAt > now + SLOT_HORIZON_DAYS * DAY_MS) {
    return { ok: false, text: `Перенос возможен не дальше чем на ${SLOT_HORIZON_DAYS} дней вперёд — для более поздней даты передай вопрос администратору.` };
  }
  if (!withinWorkingHours(db, input.startsAt, endsAt, current.masterId)) {
    return { ok: false, text: 'Это время вне часов работы мастера. Возьми время из free_slots.' };
  }
  if (input.startsAt === current.startsAt) return { ok: false, text: 'Запись уже назначена на это время.' };
  const before = formatHumanDateTime(current.startsAt, tz);
  const after = formatHumanDateTime(input.startsAt, tz);
  if (input.dryRun) {
    return { ok: true, appointment: { ...current, startsAt: input.startsAt, endsAt }, text: `Тестовый режим: запись №${current.id} перенеслась бы на ${after}.` };
  }
  let moved: AppointmentRow;
  try {
    moved = updateAppointment(db, current.id, { startsAt: input.startsAt });
  } catch (err) {
    if (err instanceof AppError && err.code === 'schedule_conflict') {
      return { ok: false, text: 'Это время уже занято у мастера. Проверь free_slots и предложи другое время.' };
    }
    throw err;
  }
  auditClientReschedule(ctx, current, moved);
  const client = db.select().from(clients).where(eq(clients.id, current.clientId)).get();
  const master = employeesByIds(db, [moved.masterId]).get(moved.masterId);
  const what = appointmentWhat(db, [moved]).get(moved.id);
  await notifyStaff(
    ctx,
    `🔁 Клиент ${client ? clientFullName(client) : '—'} перенёс запись №${moved.id} через бота\n` +
      `Было: ${before}\nСтало: ${after}–${formatTime(moved.endsAt, tz)}\n${what} · мастер ${master?.name ?? '—'}`,
  );
  return { ok: true, appointment: moved, text: `Запись №${moved.id} перенесена на ${after}. Напоминания обновлены.` };
}

/** «✅ Приду»: a scheduled appointment becomes confirmed (a confirmed one stays as is). */
export async function confirmForClient(ctx: AppContext, clientId: number, appointmentId: number, now = Date.now()): Promise<ClientAppointmentResult> {
  const own = ownActiveAppointment(ctx.db, clientId, appointmentId, now);
  if (!own.ok) return own;
  const tz = studioTimezone(ctx.db);
  const when = formatHumanDateTime(own.appointment.startsAt, tz);
  if (own.appointment.status === 'confirmed') return { ok: true, appointment: own.appointment, text: `Запись уже подтверждена — ждём вас ${when} ✨` };
  const row = updateAppointment(ctx.db, appointmentId, { status: 'confirmed' });
  auditClientConfirm(ctx, own.appointment, row);
  const client = ctx.db.select().from(clients).where(eq(clients.id, clientId)).get();
  const master = employeesByIds(ctx.db, [row.masterId]).get(row.masterId);
  await notifyStaff(
    ctx,
    `✅ ${client ? clientFullName(client) : 'Клиент'} подтвердил(а) запись №${row.id}: ${when}, ${appointmentWhat(ctx.db, [row]).get(row.id)}, мастер ${master?.name ?? '—'}`,
  );
  return { ok: true, appointment: row, text: `Спасибо, что подтвердили! Ждём вас ${when} ✨` };
}
