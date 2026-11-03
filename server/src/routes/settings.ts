import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { resyncUpcomingReminders } from '../domain/scheduling.js';
import {
  FREE_CANCELLATION_HOURS_MAX,
  getBotSettings,
  getStaffChatId,
  getStudioSettings,
  LEGACY_REMINDER_HOURS_MAX,
  legacyReminderHours,
  MAX_REMINDER_OFFSETS,
  normalizeReminderOffsets,
  ONLINE_CONFIRMATION_MAX,
  ONLINE_CONFIRMATION_MIN,
  ONLINE_HOLD_MAX,
  ONLINE_HOLD_MIN,
  ONLINE_HORIZON_MAX,
  ONLINE_LEAD_MAX,
  ONLINE_NOTE_MAX,
  ONLINE_STEPS,
  REMINDER_OFFSET_MAX,
  REMINDER_OFFSET_MIN,
  REVIEW_LINK_MAX,
  saveBotSettings,
  saveStudioSettings,
  type BotSettingsStored,
  type StudioSettings,
} from '../domain/settings.js';
import { badRequest } from '../lib/errors.js';
import { formatTimeOfDay, isValidTimezone, parseTimeOfDay } from '../lib/time.js';
import { nonNull, parse } from '../lib/validation.js';

const text = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((v) => (v == null ? v : v.trim()));

/** "HH:MM" in the studio timezone, normalized to two-digit hours ("9:00" → "09:00"). */
export const timeOfDay = z.string().transform((value, ctx) => {
  const minutes = parseTimeOfDay(value);
  if (minutes === null) {
    ctx.addIssue({ code: 'custom', message: 'время должно быть в формате ЧЧ:ММ (например, 10:00)' });
    return z.NEVER;
  }
  return formatTimeOfDay(minutes);
});

const percent = nonNull(z.number().int().min(0).max(100));

/** Each rule omitted = unchanged. */
const cancellationRules = z.object({
  freeHours: nonNull(z.number().int().min(0).max(FREE_CANCELLATION_HOURS_MAX)),
  lateRetainPercent: percent,
  noShowRetainPercent: percent,
  autoRetain: nonNull(z.boolean()),
});

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.length > 0;
  } catch {
    return false;
  }
}

/** `https://…` or "" (none); `null` clears it, omitted = unchanged. */
const reviewLink = z
  .string()
  .trim()
  .max(REVIEW_LINK_MAX)
  .refine((v) => v === '' || isHttpsUrl(v), { message: 'нужна ссылка, начинающаяся с https://' })
  .nullish();

const reviewLinks = z.object({ yandex: reviewLink, twogis: reviewLink, google: reviewLink });

/** Each field omitted = unchanged; `note: null` clears it, `confirmationHours: null` = never reject by itself. */
const onlineBooking = z.object({
  enabled: nonNull(z.boolean()),
  leadMinutes: nonNull(z.number().int().min(0).max(ONLINE_LEAD_MAX)),
  horizonDays: nonNull(z.number().int().min(1).max(ONLINE_HORIZON_MAX)),
  holdMinutes: nonNull(z.number().int().min(ONLINE_HOLD_MIN).max(ONLINE_HOLD_MAX)),
  stepMinutes: nonNull(
    z.number().int().refine((v) => (ONLINE_STEPS as readonly number[]).includes(v), { message: 'допустимо 15, 30 или 60 минут' }),
  ),
  note: text(ONLINE_NOTE_MAX),
  confirmationHours: z.number().int().min(ONLINE_CONFIRMATION_MIN).max(ONLINE_CONFIRMATION_MAX).nullish(),
});

/** Omitted = unchanged. */
const pos = z.object({ sendReceipt: nonNull(z.boolean()) });

const studioBody = z.object({
  name: nonNull(z.string().trim().min(1).max(200)),
  address: text(500),
  phone: text(100),
  workingHours: text(500),
  instagram: text(200),
  website: text(300),
  about: text(5000),
  timezone: nonNull(z.string().trim().refine(isValidTimezone, { message: 'неизвестный часовой пояс (пример: Europe/Moscow)' })),
  workdayStart: nonNull(timeOfDay),
  workdayEnd: nonNull(timeOfDay),
  /** Omitted = unchanged (older builds never send them). */
  cancellation: nonNull(cancellationRules),
  reviewLinks: nonNull(reviewLinks),
  onlineBooking: nonNull(onlineBooking),
  pos: nonNull(pos),
});

const botBody = z.object({
  enabled: nonNull(z.boolean()),
  aiEnabled: nonNull(z.boolean()),
  greeting: nonNull(z.string().trim().min(1).max(2000)),
  extraInstructions: text(5000),
  aftercareHour: nonNull(z.number().int().min(0).max(23)),
  remindersEnabled: nonNull(z.boolean()),
  reminderOffsets: nonNull(
    z
      .array(z.number().int().min(REMINDER_OFFSET_MIN).max(REMINDER_OFFSET_MAX))
      .min(1)
      .max(MAX_REMINDER_OFFSETS)
      .refine((list) => new Set(list).size === list.length, { message: 'напоминания не должны повторяться' }),
  ),
  /** Older builds: a single reminder N hours before. */
  reminderHoursBefore: nonNull(z.number().int().min(1).max(LEGACY_REMINDER_HOURS_MAX)),
  /** Omitted = unchanged, `null` = that digest is off. */
  morningDigestAt: timeOfDay.nullish(),
  eveningDigestAt: timeOfDay.nullish(),
});

export function botSettingsOut(ctx: AppContext) {
  const bot = getBotSettings(ctx.db);
  return {
    ...bot,
    reminderHoursBefore: legacyReminderHours(bot.reminderOffsets),
    botUsername: ctx.gateway.username(),
    staffChatBound: getStaffChatId(ctx.db) !== null,
    aiConfigured: ctx.ai !== null,
  };
}

/** Merges a body into current values; `undefined` keeps the current value, `null` clears text. */
function merge<T extends object>(current: T, patch: Partial<Record<keyof T, unknown>>): T {
  const next = { ...current } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    next[key] = value === null ? '' : value;
  }
  return next as T;
}

/**
 * `reminderHoursBefore` from older builds: a single reminder N hours before. Those builds resend the value they
 * read, so an unchanged value keeps the current (possibly several) reminders.
 */
function legacyOffsets(current: BotSettingsStored, hours: number | undefined): number[] | undefined {
  if (hours === undefined || hours === legacyReminderHours(current.reminderOffsets)) return undefined;
  return [hours * 60];
}

export function settingsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  app.get('/settings/studio', async () => getStudioSettings(db));

  app.put('/settings/studio', async (request) => {
    const { cancellation, reviewLinks: links, onlineBooking: online, pos: till, ...input } = parse(studioBody, request.body);
    const { confirmationHours, ...onlineRest } = online ?? {};
    const current = getStudioSettings(db);
    const next: StudioSettings = {
      ...merge(current, input),
      // Nested: each rule / link / booking setting omitted = unchanged.
      cancellation: merge(current.cancellation, cancellation ?? {}),
      reviewLinks: merge(current.reviewLinks, links ?? {}),
      onlineBooking: {
        ...merge(current.onlineBooking, onlineRest),
        // `merge` turns null into '' (text fields); here null means «never».
        confirmationHours: confirmationHours === undefined ? current.onlineBooking.confirmationHours : confirmationHours,
      },
      pos: merge(current.pos, till ?? {}),
    };
    // Only the calendar's default range: appointments outside it are still allowed.
    if (parseTimeOfDay(next.workdayEnd)! <= parseTimeOfDay(next.workdayStart)!) {
      throw badRequest(`Конец рабочего дня (${next.workdayEnd}) должен быть позже начала (${next.workdayStart})`);
    }
    const saved = saveStudioSettings(db, next);
    // The bot's menu button follows the online booking switch (a failure is only logged inside).
    if (next.onlineBooking.enabled !== current.onlineBooking.enabled) void ctx.gateway.refreshBookingMenu?.();
    return saved;
  });

  app.get('/settings/bot', async () => botSettingsOut(ctx));

  app.put('/settings/bot', async (request) => {
    const { reminderHoursBefore, reminderOffsets, morningDigestAt, eveningDigestAt, ...input } = parse(botBody, request.body);
    const before = getBotSettings(db);
    const offsets = reminderOffsets ?? legacyOffsets(before, reminderHoursBefore);
    const after = saveBotSettings(db, {
      ...merge(before, input),
      reminderOffsets: offsets ? normalizeReminderOffsets(offsets) : before.reminderOffsets,
      // `merge` turns null into '' (text fields); here null means «off».
      morningDigestAt: morningDigestAt === undefined ? before.morningDigestAt : morningDigestAt,
      eveningDigestAt: eveningDigestAt === undefined ? before.eveningDigestAt : eveningDigestAt,
    });
    if (before.enabled !== after.enabled) ctx.onBotSettingsChanged();
    const remindersChanged =
      before.remindersEnabled !== after.remindersEnabled || before.reminderOffsets.join() !== after.reminderOffsets.join();
    if (remindersChanged) resyncUpcomingReminders(db);
    return botSettingsOut(ctx);
  });
}
