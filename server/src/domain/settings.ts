import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { settings } from '../db/schema.js';
import { formatTimeOfDay, parseTimeOfDay } from '../lib/time.js';

export interface StudioSettings {
  name: string;
  address: string;
  phone: string;
  workingHours: string;
  instagram: string;
  website: string;
  about: string;
  timezone: string;
  /** Opening time "HH:MM" in the studio timezone: the app's calendar starts here. */
  workdayStart: string;
  /** Closing time "HH:MM" ("24:00" = midnight), later than `workdayStart`: the calendar ends here. */
  workdayEnd: string;
  /** Prepayment rules on a cancellation / no-show (see domain/cancellation.ts). */
  cancellation: CancellationRules;
  /** Where clients leave a review: `https://…` or "" (none). */
  reviewLinks: ReviewLinks;
  /** Client-facing booking through the bot, the Mini App and the booking page (see domain/online-booking.ts). */
  onlineBooking: OnlineBookingSettings;
  /** The till (see domain/sale-messages.ts). */
  pos: PosSettings;
}

export interface PosSettings {
  /** The bot sends the receipt to the client's Telegram after a paid sale and tells them about a refund. */
  sendReceipt: boolean;
}

export interface OnlineBookingSettings {
  /** `false` — the booking page is closed and the bot falls back to booking requests. */
  enabled: boolean;
  /** The earliest start offered: at least this many minutes from now (0…2880). */
  leadMinutes: number;
  /** How far ahead starts are offered, in days (1…180). */
  horizonDays: number;
  /** How long an unpaid booking holds its time while the client pays the prepayment (5…60 minutes). */
  holdMinutes: number;
  /** The grid of offered starts from the beginning of the master's working day: 15 | 30 | 60 minutes. */
  stepMinutes: number;
  /** Shown to clients on the booking page (≤ 500 characters). */
  note: string;
  /**
   * An unconfirmed booking rejects itself this many hours after it was made (or 2 hours before its start, if that
   * comes first); 1…168, `null` = never (see domain/online-booking-lifecycle.ts).
   */
  confirmationHours: number | null;
}

export interface CancellationRules {
  /** A cancellation at least this many hours before the start is free; 0 = never free. */
  freeHours: number;
  /** Share (0…100) of the held prepayment kept after a later cancellation. */
  lateRetainPercent: number;
  /** Share (0…100) of the held prepayment kept after a no-show. */
  noShowRetainPercent: number;
  /** The server records that retain itself when the appointment is cancelled late or missed. */
  autoRetain: boolean;
}

export interface ReviewLinks {
  yandex: string;
  twogis: string;
  google: string;
}

/** `freeHours` limit: two weeks. */
export const FREE_CANCELLATION_HOURS_MAX = 14 * 24;
export const REVIEW_LINK_MAX = 500;
/** Limits of `StudioSettings.onlineBooking`. */
export const ONLINE_LEAD_MAX = 2 * 24 * 60;
export const ONLINE_HORIZON_MAX = 180;
export const ONLINE_HOLD_MIN = 5;
export const ONLINE_HOLD_MAX = 60;
export const ONLINE_STEPS = [15, 30, 60] as const;
export const ONLINE_NOTE_MAX = 500;
export const ONLINE_CONFIRMATION_MIN = 1;
export const ONLINE_CONFIRMATION_MAX = 7 * 24;

export interface BotSettingsStored {
  enabled: boolean;
  aiEnabled: boolean;
  greeting: string;
  extraInstructions: string;
  aftercareHour: number;
  remindersEnabled: boolean;
  /** Minutes before the appointment start at which reminders are sent, distinct, latest-first (largest first). */
  reminderOffsets: number[];
  /** Staff digests: "HH:MM" studio time, `null` = off (see bot/digest.ts). */
  morningDigestAt: string | null;
  eveningDigestAt: string | null;
}

/** Reminder offsets: 1–6 distinct values, 15 minutes … 14 days. */
export const REMINDER_OFFSET_MIN = 15;
export const REMINDER_OFFSET_MAX = 14 * 24 * 60;
export const MAX_REMINDER_OFFSETS = 6;

/** Distinct offsets, earliest reminder first (largest offset first). */
export function normalizeReminderOffsets(offsets: number[]): number[] {
  return [...new Set(offsets.map((m) => Math.round(m)))].sort((a, b) => b - a);
}

/** Older builds accept and resend «hours before» only within 1…168. */
export const LEGACY_REMINDER_HOURS_MAX = 168;

/**
 * `reminderHoursBefore` kept in the API for older builds: the first (largest) offset in whole hours, within
 * 1…168 (a longer offset reads as 168, so builds that resend the value still save).
 */
export function legacyReminderHours(offsets: number[]): number {
  return Math.min(LEGACY_REMINDER_HOURS_MAX, Math.max(1, Math.round((offsets[0] ?? 24 * 60) / 60)));
}

export interface StaffCode {
  code: string;
  expiresAt: number;
  /** Wrong guesses so far; the code is burned after STAFF_CODE_MAX_ATTEMPTS. */
  attempts?: number;
}

export const DEFAULT_STUDIO: StudioSettings = {
  name: 'MIKAN STUDIO',
  address: '',
  phone: '',
  workingHours: 'Ежедневно 11:00–21:00',
  instagram: '',
  website: '',
  about: '',
  timezone: 'Europe/Moscow',
  workdayStart: '11:00',
  workdayEnd: '21:00',
  cancellation: { freeHours: 24, lateRetainPercent: 100, noShowRetainPercent: 100, autoRetain: false },
  reviewLinks: { yandex: '', twogis: '', google: '' },
  onlineBooking: { enabled: true, leadMinutes: 120, horizonDays: 60, holdMinutes: 15, stepMinutes: 30, note: '', confirmationHours: 24 },
  pos: { sendReceipt: true },
};

export const DEFAULT_BOT: BotSettingsStored = {
  enabled: true,
  aiEnabled: true,
  greeting:
    'Здравствуйте! 👋 Я помощник MIKAN STUDIO. Расскажу об услугах тату и пирсинга, помогу подобрать украшение, ' +
    'записаться на сеанс и подскажу, как ухаживать за татуировкой или проколом. Напишите ваш вопрос или выберите кнопку ниже.',
  extraInstructions: '',
  aftercareHour: 12,
  remindersEnabled: true,
  reminderOffsets: [24 * 60],
  morningDigestAt: '09:30',
  eveningDigestAt: '21:30',
};

const KEY_STUDIO = 'studio';
const KEY_BOT = 'bot';
const KEY_STAFF_CHAT = 'staffChatId';
const KEY_STAFF_CODE = 'staffCode';
const KEY_BOT_USERNAME = 'botUsername';
const KEY_DIGESTS_SENT = 'digestsSent';
const KEY_ALERTS = 'alerts';
const KEY_RETENTION = 'retention';
const KEY_DISMISSED_DUPLICATES = 'clientDuplicatesDismissed';
const KEY_WAITLIST_FREED = 'waitlistFreed';
const KEY_OFFSITE_UPLOADS = 'offsiteUploads';

/** JSON value of a settings key, null when missing or unreadable (also used by the SMM module for its own keys). */
export function readKey<T>(db: DbOrTx, key: string): T | null {
  const row = db.select().from(settings).where(eq(settings.key, key)).get();
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

export function writeKey(db: DbOrTx, key: string, value: unknown): void {
  const json = JSON.stringify(value);
  const now = Date.now();
  db.insert(settings)
    .values({ key, value: json, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value: json, updatedAt: now } })
    .run();
}

export function deleteKey(db: DbOrTx, key: string): void {
  db.delete(settings).where(eq(settings.key, key)).run();
}

/** Matches "11:00–21:00", "с 10:00 до 20:30", "9:00 - 22:00" inside free text. */
const HOURS_IN_TEXT = /(\d{1,2}:\d{2})\s*(?:[-–—]|до)\s*(\d{1,2}:\d{2})/;

/**
 * Working hours for settings saved before `workdayStart` / `workdayEnd` existed: taken from the free-text
 * `workingHours` («Ежедневно 10:00–20:00») when it holds a valid range, otherwise the defaults.
 */
export function workdayFromText(text: string): Pick<StudioSettings, 'workdayStart' | 'workdayEnd'> {
  const match = HOURS_IN_TEXT.exec(text);
  const start = match ? parseTimeOfDay(match[1]!) : null;
  const end = match ? parseTimeOfDay(match[2]!) : null;
  if (start === null || end === null || end <= start) {
    return { workdayStart: DEFAULT_STUDIO.workdayStart, workdayEnd: DEFAULT_STUDIO.workdayEnd };
  }
  return { workdayStart: formatTimeOfDay(start), workdayEnd: formatTimeOfDay(end) };
}

type StoredStudioValue = Partial<Omit<StudioSettings, 'cancellation' | 'reviewLinks' | 'onlineBooking' | 'pos'>> & {
  cancellation?: Partial<CancellationRules>;
  reviewLinks?: Partial<ReviewLinks>;
  onlineBooking?: Partial<OnlineBookingSettings>;
  pos?: Partial<PosSettings>;
};

export function getStudioSettings(db: DbOrTx): StudioSettings {
  const stored = readKey<StoredStudioValue>(db, KEY_STUDIO) ?? {};
  // Settings saved before the cancellation rules / review links / online booking / the till existed take the defaults.
  const merged = {
    ...DEFAULT_STUDIO,
    ...stored,
    cancellation: { ...DEFAULT_STUDIO.cancellation, ...stored.cancellation },
    reviewLinks: { ...DEFAULT_STUDIO.reviewLinks, ...stored.reviewLinks },
    onlineBooking: { ...DEFAULT_STUDIO.onlineBooking, ...stored.onlineBooking },
    pos: { ...DEFAULT_STUDIO.pos, ...stored.pos },
  };
  if (stored.workdayStart !== undefined && stored.workdayEnd !== undefined) return merged;
  return { ...merged, ...workdayFromText(merged.workingHours) };
}

export function saveStudioSettings(db: DbOrTx, value: StudioSettings): StudioSettings {
  writeKey(db, KEY_STUDIO, value);
  return value;
}

type StoredBotValue = Partial<BotSettingsStored> & { reminderHoursBefore?: number };

export function getBotSettings(db: DbOrTx): BotSettingsStored {
  const { reminderHoursBefore, ...stored } = readKey<StoredBotValue>(db, KEY_BOT) ?? {};
  // Settings saved before several reminders existed keep their single «hours before».
  const offsets =
    Array.isArray(stored.reminderOffsets) && stored.reminderOffsets.length > 0
      ? stored.reminderOffsets
      : typeof reminderHoursBefore === 'number'
        ? [reminderHoursBefore * 60]
        : DEFAULT_BOT.reminderOffsets;
  return { ...DEFAULT_BOT, ...stored, reminderOffsets: normalizeReminderOffsets(offsets) };
}

export function saveBotSettings(db: DbOrTx, value: BotSettingsStored): BotSettingsStored {
  writeKey(db, KEY_BOT, value);
  return value;
}

/** The studio day (`YYYY-MM-DD`) each staff digest was last sent for. */
export interface DigestsSent {
  morning?: string;
  evening?: string;
}

export function getDigestsSent(db: DbOrTx): DigestsSent {
  return readKey<DigestsSent>(db, KEY_DIGESTS_SENT) ?? {};
}

export function setDigestsSent(db: DbOrTx, value: DigestsSent): void {
  writeKey(db, KEY_DIGESTS_SENT, value);
}

/** An alert kind's state: whether it is raised, since when, and when the staff were last told. */
export interface AlertState {
  active: boolean;
  since: number;
  lastSentAt: number;
}

export function getAlertStates(db: DbOrTx): Record<string, AlertState> {
  return readKey<Record<string, AlertState>>(db, KEY_ALERTS) ?? {};
}

export function setAlertStates(db: DbOrTx, value: Record<string, AlertState>): void {
  writeKey(db, KEY_ALERTS, value);
}

export function studioTimezone(db: DbOrTx): string {
  return getStudioSettings(db).timezone;
}

export function getStaffChatId(db: DbOrTx): number | null {
  const value = readKey<number>(db, KEY_STAFF_CHAT);
  return typeof value === 'number' ? value : null;
}

export function setStaffChatId(db: DbOrTx, chatId: number): void {
  writeKey(db, KEY_STAFF_CHAT, chatId);
}

export function getStaffCode(db: DbOrTx): StaffCode | null {
  return readKey<StaffCode>(db, KEY_STAFF_CODE);
}

export function setStaffCode(db: DbOrTx, value: StaffCode): void {
  writeKey(db, KEY_STAFF_CODE, value);
}

export function clearStaffCode(db: DbOrTx): void {
  deleteKey(db, KEY_STAFF_CODE);
}

export function getCachedBotUsername(db: DbOrTx): string | null {
  return readKey<string>(db, KEY_BOT_USERNAME);
}

export function setCachedBotUsername(db: DbOrTx, username: string): void {
  writeKey(db, KEY_BOT_USERNAME, username);
}

/** Inserts defaults for keys that are missing; never overwrites existing values. */
export function ensureDefaultSettings(db: DbOrTx): void {
  if (readKey(db, KEY_STUDIO) === null) writeKey(db, KEY_STUDIO, DEFAULT_STUDIO);
  if (readKey(db, KEY_BOT) === null) writeKey(db, KEY_BOT, DEFAULT_BOT);
}

/** The stored retention settings as saved (domain/retention-settings.ts fills in the defaults). */
export function readRetentionStored(db: DbOrTx): unknown {
  return readKey<unknown>(db, KEY_RETENTION);
}

export function writeRetentionStored(db: DbOrTx, value: unknown): void {
  writeKey(db, KEY_RETENTION, value);
}

/** Client pairs the staff marked as different people (domain/client-duplicates.ts): `"12:34"`, smaller id first. */
export function getDismissedDuplicatePairs(db: DbOrTx): string[] {
  const value = readKey<unknown>(db, KEY_DISMISSED_DUPLICATES);
  return Array.isArray(value) ? value.filter((pair): pair is string => typeof pair === 'string') : [];
}

export function setDismissedDuplicatePairs(db: DbOrTx, pairs: readonly string[]): void {
  writeKey(db, KEY_DISMISSED_DUPLICATES, pairs);
}

/** Freed time waiting for the waitlist check (domain/waitlist-store.ts validates the items). */
export function readWaitlistFreed(db: DbOrTx): unknown {
  return readKey<unknown>(db, KEY_WAITLIST_FREED);
}

export function writeWaitlistFreed(db: DbOrTx, value: unknown): void {
  writeKey(db, KEY_WAITLIST_FREED, value);
}

/** The last photo archive sent off-site (domain/offsite-uploads.ts): the manifest hash of its file set. */
export interface OffsiteUploadsState {
  hash: string;
  /** A fingerprint of the storage (endpoint, bucket, prefix) and the encryption key it was sent to and with. */
  target: string;
  key: string;
  files: number;
  uploadedAt: number;
}

export function getOffsiteUploads(db: DbOrTx): OffsiteUploadsState | null {
  const value = readKey<OffsiteUploadsState>(db, KEY_OFFSITE_UPLOADS);
  return value && typeof value.hash === 'string' ? value : null;
}

export function setOffsiteUploads(db: DbOrTx, value: OffsiteUploadsState): void {
  writeKey(db, KEY_OFFSITE_UPLOADS, value);
}
