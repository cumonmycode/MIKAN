import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Telegram Mini App init data (`Telegram.WebApp.initData`), checked as Telegram documents
 * (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app): the data-check-string is every
 * field except `hash`, sorted by key, as `key=value` lines; the hash is HMAC-SHA256 of it with the key
 * HMAC-SHA256("WebAppData", bot token).
 */

/** Init data older than this is refused. */
export const INIT_DATA_MAX_AGE_MS = 24 * 60 * 60_000;
/** Clock skew tolerated for an `auth_date` slightly in the future. */
const FUTURE_SKEW_MS = 5 * 60_000;

export interface TelegramWebAppUser {
  /** The Telegram user id — the id of the user's private chat with the bot. */
  id: number;
  firstName: string | null;
  lastName: string | null;
  username: string | null;
}

/** The data-check-string of the fields (without `hash`). */
export function dataCheckString(params: URLSearchParams): string {
  return [...params.entries()]
    .filter(([key]) => key !== 'hash')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

/** The hex hash Telegram puts into `hash` for these fields. */
export function initDataHash(params: URLSearchParams, botToken: string): string {
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  return createHmac('sha256', secret).update(dataCheckString(params)).digest('hex');
}

function parseUser(json: string | null): TelegramWebAppUser | null {
  if (!json) return null;
  try {
    const user = JSON.parse(json) as Record<string, unknown>;
    if (typeof user.id !== 'number' || !Number.isSafeInteger(user.id) || user.id <= 0) return null;
    const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    return { id: user.id, firstName: text(user.first_name), lastName: text(user.last_name), username: text(user.username) };
  } catch {
    return null;
  }
}

/** The user of valid, fresh init data; null when it is malformed, forged or older than `maxAgeMs`. */
export function validateInitData(
  initData: string | undefined,
  botToken: string | null,
  now = Date.now(),
  maxAgeMs = INIT_DATA_MAX_AGE_MS,
): TelegramWebAppUser | null {
  if (!initData || !botToken || initData.length > 4096) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return null;
  const expected = Buffer.from(initDataHash(params, botToken), 'hex');
  const given = Buffer.from(hash.toLowerCase(), 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const authDate = Number(params.get('auth_date')) * 1000;
  if (!Number.isFinite(authDate) || authDate <= 0) return null;
  if (now - authDate > maxAgeMs || authDate - now > FUTURE_SKEW_MS) return null;
  return parseUser(params.get('user'));
}
