import { randomInt } from 'node:crypto';
import type { AppContext } from '../context.js';
import type { DbOrTx } from '../db/client.js';
import { clearStaffCode, getStaffChatId, getStaffCode, setStaffChatId, setStaffCode } from '../domain/settings.js';
import { errorMessage } from '../lib/errors.js';
import { MINUTE_MS } from '../lib/time.js';
import { sendStaffPush, type StaffPushSource } from '../push/staff-push.js';

export const STAFF_CODE_TTL_MS = 15 * MINUTE_MS;

/**
 * Sends a notification to the bound staff chat; never throws. Returns whether it was delivered. Given the event
 * (`push/staff-events.ts`, best as `() => …Push(…)`), it is also pushed to the staff iPhones in the background.
 */
export async function notifyStaff(ctx: AppContext, text: string, push?: StaffPushSource): Promise<boolean> {
  if (push) sendStaffPush(ctx, push);
  const chatId = getStaffChatId(ctx.db);
  if (chatId === null) {
    ctx.log.info({ notification: text.split('\n')[0] }, 'staff chat not bound; notification skipped');
    return false;
  }
  if (!ctx.gateway.isRunning()) return false;
  try {
    await ctx.gateway.sendText(chatId, text);
    return true;
  } catch (err) {
    ctx.log.warn({ err: errorMessage(err) }, 'failed to notify staff chat');
    return false;
  }
}

/** No 0/O, 1/I/L — easy to read and type. 31^10 ≈ 8·10^14 combinations. */
const STAFF_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const STAFF_CODE_LENGTH = 10;
export const STAFF_CODE_MAX_ATTEMPTS = 5;

export function issueStaffCode(db: DbOrTx, now = Date.now()): { code: string; expiresAt: number } {
  let code = '';
  for (let i = 0; i < STAFF_CODE_LENGTH; i++) code += STAFF_CODE_ALPHABET[randomInt(0, STAFF_CODE_ALPHABET.length)];
  const value = { code, expiresAt: now + STAFF_CODE_TTL_MS, attempts: 0 };
  setStaffCode(db, value);
  return value;
}

export type BindResult = 'bound' | 'invalid' | 'locked';

/**
 * Binds `chatId` as the staff notification chat if the code is valid and fresh.
 * Any Telegram user can send /staff, so wrong guesses are counted and the code is burned after
 * STAFF_CODE_MAX_ATTEMPTS failures (staff then issue a new one in the app).
 */
export function bindStaffChat(db: DbOrTx, chatId: number, code: string, now = Date.now()): BindResult {
  const stored = getStaffCode(db);
  if (!stored) return 'invalid';
  if (stored.expiresAt < now) {
    clearStaffCode(db);
    return 'invalid';
  }
  if (stored.code === code.trim().toUpperCase()) {
    setStaffChatId(db, chatId);
    clearStaffCode(db);
    return 'bound';
  }
  const attempts = (stored.attempts ?? 0) + 1;
  if (attempts >= STAFF_CODE_MAX_ATTEMPTS) {
    clearStaffCode(db);
    return 'locked';
  }
  setStaffCode(db, { ...stored, attempts });
  return 'invalid';
}

export function clientLabel(name: string | null | undefined, username: string | null | undefined): string {
  const parts = [name?.trim() || 'Клиент'];
  if (username) parts.push(`(@${username})`);
  return parts.join(' ');
}
