import { and, eq, inArray } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { appointments, clients, scheduledMessages } from '../db/schema.js';
import type { AppointmentRow, ClientRow, ScheduledRow, ServiceRow } from '../lib/serialize.js';
import { pluralWord } from '../lib/text.js';
import { aftercareSendAt } from '../lib/time.js';
import { serviceLinesByAppointment, servicesByIds } from './refs.js';
import { getBotSettings, getStudioSettings } from './settings.js';

/**
 * Post-visit follow-ups of the bot (docs/API.md → «Follow-ups»): a healing check-in and a jewelry change suggestion,
 * scheduled when a visit is completed and sent by bot/sender.ts with their buttons (bot/follow-ups.ts).
 */

export const FOLLOW_UP_KINDS = ['healing_check', 'jewelry_change'] as const;
export type FollowUpKind = (typeof FOLLOW_UP_KINDS)[number];

export const isFollowUpKind = (kind: string): kind is FollowUpKind => (FOLLOW_UP_KINDS as readonly string[]).includes(kind);

/** `Service.healingCheckDays` / `jewelryChangeWeeks` limits, and the check of a new fresh procedure. */
export const HEALING_CHECK_DAYS_MAX = 60;
export const JEWELRY_CHANGE_WEEKS_MAX = 52;
export const DEFAULT_HEALING_CHECK_DAYS = 7;
const DAYS_PER_WEEK = 7;

export const FOLLOW_UP_SKIP = {
  unlinked: 'Клиент отвязал Telegram',
  botOff: 'Клиент отключил сообщения бота',
  reopened: 'Визит больше не завершён',
} as const;

/** «Хеликс» · «Хеликс» и «Трагус» · «Хеликс», «Трагус» и «Мочка». */
export function quotedNames(names: string[]): string {
  const quoted = names.map((n) => `«${n}»`);
  if (quoted.length <= 1) return quoted.join('');
  return `${quoted.slice(0, -1).join(', ')} и ${quoted[quoted.length - 1]}`;
}

/** «Прошла неделя» for 7 days, otherwise «Прошёл день» / «Прошло 3 дня» / «Прошло 10 дней» / «Прошёл 21 день». */
export function daysElapsedText(days: number): string {
  if (days === DAYS_PER_WEEK) return 'Прошла неделя';
  if (days === 1) return 'Прошёл день';
  const word = pluralWord(days, 'день', 'дня', 'дней');
  return `${word === 'день' ? 'Прошёл' : 'Прошло'} ${days} ${word}`;
}

/** «прошла неделя» / «прошло 3 недели» / «прошло 6 недель» / «прошла 21 неделя». */
export function weeksElapsedText(weeks: number): string {
  if (weeks === 1) return 'прошла неделя';
  const word = pluralWord(weeks, 'неделя', 'недели', 'недель');
  return `${word === 'неделя' ? 'прошла' : 'прошло'} ${weeks} ${word}`;
}

/** «процедуры «Хеликс»» / «проколов «Хеликс» и «Трагус»». */
function procedurePhrase(names: string[], piercing: boolean): string {
  const noun = piercing ? (names.length > 1 ? 'проколов' : 'прокола') : names.length > 1 ? 'процедур' : 'процедуры';
  return names.length ? `${noun} ${quotedNames(names)}` : noun;
}

/** «Здравствуйте, Анна! Прошла неделя после процедуры «Хеликс». Как заживает? 🙂» */
export function healingCheckText(clientName: string, days: number, serviceNames: string[]): string {
  const name = clientName.trim();
  return `Здравствуйте${name ? `, ${name}` : ''}! ${daysElapsedText(days)} после ${procedurePhrase(serviceNames, false)}. Как заживает? 🙂`;
}

/** «Анна, прошло 6 недель после прокола «Хеликс» — самое время заменить украшение на подходящее по размеру. Записаться?» */
export function jewelryChangeText(clientName: string, weeks: number, serviceNames: string[], piercing: boolean): string {
  const name = clientName.trim();
  const elapsed = weeksElapsedText(weeks);
  const lead = name ? `${name}, ${elapsed}` : `${elapsed.charAt(0).toUpperCase()}${elapsed.slice(1)}`;
  return `${lead} после ${procedurePhrase(serviceNames, piercing)} — самое время заменить украшение на подходящее по размеру. Записаться?`;
}

/** The visit's catalog services in line order, each once (the legacy single service when it has no lines). */
export function visitServices(db: DbOrTx, appointment: AppointmentRow): ServiceRow[] {
  const lines = serviceLinesByAppointment(db, [appointment.id]).get(appointment.id) ?? [];
  const ids = (lines.length ? lines.map((l) => l.serviceId) : [appointment.serviceId]).filter((id): id is number => id != null);
  const catalog = servicesByIds(db, ids);
  return [...new Set(ids)].map((id) => catalog.get(id)).filter((s): s is ServiceRow => s !== undefined);
}

const asksFor = (kind: FollowUpKind) => (s: ServiceRow) => (kind === 'healing_check' ? s.healingCheckDays : s.jewelryChangeWeeks) != null;

/** What a follow-up is about: the visit's services that asked for it, else all its services, else its title. */
export function followUpSubject(db: DbOrTx, appointment: AppointmentRow, kind: FollowUpKind): string[] {
  const services = visitServices(db, appointment);
  const asked = services.filter(asksFor(kind));
  const names = (asked.length ? asked : services).map((s) => s.name);
  if (names.length) return names;
  return [appointment.title?.trim() || 'процедура'];
}

export interface FollowUpDraft {
  kind: FollowUpKind;
  /** Days after the visit; sent at `aftercareHour` studio time that day. */
  days: number;
  text: string;
}

/**
 * The follow-ups a visit with these services asks for: the healing check after the largest `healingCheckDays`, the
 * jewelry change after the smallest `jewelryChangeWeeks` (services without the setting ask for nothing).
 */
export function followUpDrafts(services: ServiceRow[], clientName: string): FollowUpDraft[] {
  const drafts: FollowUpDraft[] = [];
  const healing = services.filter(asksFor('healing_check'));
  if (healing.length > 0) {
    const days = Math.max(...healing.map((s) => s.healingCheckDays!));
    drafts.push({ kind: 'healing_check', days, text: healingCheckText(clientName, days, healing.map((s) => s.name)) });
  }
  const change = services.filter(asksFor('jewelry_change'));
  if (change.length > 0) {
    const weeks = Math.min(...change.map((s) => s.jewelryChangeWeeks!));
    const piercing = change.every((s) => s.category === 'piercing');
    drafts.push({ kind: 'jewelry_change', days: weeks * DAYS_PER_WEEK, text: jewelryChangeText(clientName, weeks, change.map((s) => s.name), piercing) });
  }
  return drafts;
}

/** Follow-up kinds the appointment already has, whatever their status: each is scheduled once per visit. */
function scheduledKinds(db: DbOrTx, appointmentId: number): Set<string> {
  const rows = db
    .select({ kind: scheduledMessages.kind })
    .from(scheduledMessages)
    .where(and(eq(scheduledMessages.appointmentId, appointmentId), inArray(scheduledMessages.kind, [...FOLLOW_UP_KINDS])))
    .all();
  return new Set(rows.map((r) => r.kind));
}

/**
 * Schedules the follow-ups of a completed visit when its client has Telegram linked, allows the bot and the bot is on.
 * A kind the appointment already has (a repeated completion) or a moment already past is skipped. Returns how many
 * messages were created.
 */
export function scheduleFollowUps(db: DbOrTx, appointment: AppointmentRow, completedAt: number, now = Date.now()): number {
  const client = db.select().from(clients).where(eq(clients.id, appointment.clientId)).get();
  if (!client?.telegramChatId || !client.botEnabled) return 0;
  const bot = getBotSettings(db);
  if (!bot.enabled) return 0;
  const taken = scheduledKinds(db, appointment.id);
  const { timezone } = getStudioSettings(db);
  const rows = followUpDrafts(visitServices(db, appointment), client.name)
    .filter((draft) => !taken.has(draft.kind))
    .map((draft) => ({ ...draft, sendAt: aftercareSendAt(completedAt, draft.days, bot.aftercareHour, timezone) }))
    .filter((draft) => draft.sendAt > now)
    .map((draft) => ({
      chatId: client.telegramChatId!,
      clientId: client.id,
      appointmentId: appointment.id,
      kind: draft.kind,
      sendAt: draft.sendAt,
      text: draft.text,
      status: 'pending',
      createdAt: now,
    }));
  if (rows.length > 0) db.insert(scheduledMessages).values(rows).run();
  return rows.length;
}

/** Cancels the pending follow-ups of these clients (Telegram unlinked, bot messages turned off). */
export function cancelPendingFollowUps(db: DbOrTx, clientIds: number[], reason: string): number {
  if (clientIds.length === 0) return 0;
  return db
    .update(scheduledMessages)
    .set({ status: 'cancelled', error: reason })
    .where(
      and(
        inArray(scheduledMessages.clientId, clientIds),
        inArray(scheduledMessages.kind, [...FOLLOW_UP_KINDS]),
        eq(scheduledMessages.status, 'pending'),
      ),
    )
    .run().changes;
}

/** Why a due follow-up must not go out (on top of the sender's common rules), or null. */
export function followUpSkipReason(db: DbOrTx, msg: ScheduledRow, client: ClientRow): string | null {
  if (!isFollowUpKind(msg.kind)) return null;
  if (!client.telegramChatId) return FOLLOW_UP_SKIP.unlinked;
  const appointment = msg.appointmentId != null ? db.select().from(appointments).where(eq(appointments.id, msg.appointmentId)).get() : undefined;
  if (appointment?.status !== 'completed') return FOLLOW_UP_SKIP.reopened;
  return null;
}
