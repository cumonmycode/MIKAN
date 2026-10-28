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
}

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

export function getStudioSettings(db: DbOrTx): StudioSettings {
  const stored = readKey<Partial<StudioSettings>>(db, KEY_STUDIO) ?? {};
  const merged = { ...DEFAULT_STUDIO, ...stored };
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
