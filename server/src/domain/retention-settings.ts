import type { DbOrTx } from '../db/client.js';
import { readRetentionStored, writeRetentionStored } from './settings.js';

/**
 * Client retention settings (docs/API.md «Retention settings»): loyalty bonuses, the birthday greeting, win-back
 * messages and gift certificate validity. Stored under the settings key `retention`; whatever is missing (settings
 * saved by an older server, a new field) takes the default.
 */

export interface LoyaltySettings {
  enabled: boolean;
  /** Share of the paid amount credited as bonuses, 0…50. */
  cashbackPercent: number;
  /** At most this share of a check may be paid with bonuses, 0…100. */
  maxPaymentPercent: number;
  /** Earned bonuses burn after this many days; null — never. */
  expiryDays: number | null;
  /** The bot tells the client what was credited after a paid sale. */
  notifyClient: boolean;
}

export interface BirthdaySettings {
  enabled: boolean;
  /** "HH:MM" studio time. */
  sendAt: string;
  /** `{name}` — the client's first name. */
  text: string;
  /** Gift bonuses, 0 = none; they burn after `bonusDays`. */
  bonusAmount: number;
  bonusDays: number;
  /** The checkout discount offered around the birthday, 0 = none. */
  discountPercent: number;
  discountDaysBefore: number;
  discountDaysAfter: number;
}

export interface WinbackSettings {
  enabled: boolean;
  /** One message once the last completed visit is at least this many months ago. */
  afterMonths: number;
  sendAt: string;
  text: string;
  bonusAmount: number;
  bonusDays: number;
  /** At most this many win-back messages a day. */
  dailyLimit: number;
}

export interface CertificateSettings {
  /** A new certificate is valid this many months; null — never expires. */
  validityMonths: number | null;
}

export interface RetentionSettings {
  loyalty: LoyaltySettings;
  birthday: BirthdaySettings;
  winback: WinbackSettings;
  certificates: CertificateSettings;
}

export const DEFAULT_RETENTION: RetentionSettings = {
  loyalty: { enabled: true, cashbackPercent: 5, maxPaymentPercent: 30, expiryDays: null, notifyClient: true },
  birthday: {
    enabled: true,
    sendAt: '10:00',
    text: '{name}, с днём рождения! 🎂 Желаем вдохновения, красоты и смелых идей — команда MIKAN STUDIO',
    bonusAmount: 500,
    bonusDays: 14,
    discountPercent: 10,
    discountDaysBefore: 7,
    discountDaysAfter: 7,
  },
  winback: {
    enabled: true,
    afterMonths: 6,
    sendAt: '12:00',
    text: '{name}, давно не виделись! 💛 Будем рады видеть вас снова в MIKAN STUDIO — выберите удобное время',
    bonusAmount: 0,
    bonusDays: 30,
    dailyLimit: 50,
  },
  certificates: { validityMonths: 12 },
};

type Stored = { [K in keyof RetentionSettings]?: Partial<RetentionSettings[K]> };

const asObject = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

export function getRetentionSettings(db: DbOrTx): RetentionSettings {
  const stored = asObject(readRetentionStored(db)) as Stored;
  return {
    loyalty: { ...DEFAULT_RETENTION.loyalty, ...asObject(stored.loyalty) },
    birthday: { ...DEFAULT_RETENTION.birthday, ...asObject(stored.birthday) },
    winback: { ...DEFAULT_RETENTION.winback, ...asObject(stored.winback) },
    certificates: { ...DEFAULT_RETENTION.certificates, ...asObject(stored.certificates) },
  };
}

/** Each group and field omitted = unchanged (the caller validated the patch). */
export function updateRetentionSettings(db: DbOrTx, patch: Stored): RetentionSettings {
  const current = getRetentionSettings(db);
  const next: RetentionSettings = {
    loyalty: { ...current.loyalty, ...stripUndefined(patch.loyalty) },
    birthday: { ...current.birthday, ...stripUndefined(patch.birthday) },
    winback: { ...current.winback, ...stripUndefined(patch.winback) },
    certificates: { ...current.certificates, ...stripUndefined(patch.certificates) },
  };
  writeRetentionStored(db, next);
  return next;
}

function stripUndefined<T extends object>(value: T | undefined): Partial<T> {
  if (!value) return {};
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
