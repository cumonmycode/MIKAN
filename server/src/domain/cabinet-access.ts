import { createHash, randomBytes } from 'node:crypto';
import { desc, eq, inArray, lte } from 'drizzle-orm';
import type { Config } from '../config.js';
import type { DbOrTx } from '../db/client.js';
import { clientAccessTokens, clients } from '../db/schema.js';
import type { ClientRow } from '../lib/serialize.js';
import { DAY_MS } from '../lib/time.js';

/**
 * Who opens the client cabinet (docs/API.md «Client cabinet»). In the Mini App the client is the card linked to the
 * Telegram chat; on the website, the card of a sign-in link the bot sent: `PUBLIC_URL/book/me?t=<token>`. Only the
 * SHA-256 of the token is stored; a link works for 30 days or until the client signs out.
 */

export const CABINET_TOKEN_DAYS = 30;
export const CABINET_PATH = '/book/me';
/** Without a valid identity every cabinet endpoint answers `401` with this. */
export const CABINET_SIGN_IN = 'Войдите через Telegram-бота студии';

/** Live links one client keeps; issuing another drops the oldest. */
export const MAX_LIVE_TOKENS = 5;

/** 32 random bytes as base64url — 43 characters. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,64}$/;

export const hashCabinetToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/** A new sign-in link for the client; expired links of every client are cleared on the way. */
export function issueCabinetToken(db: DbOrTx, clientId: number, now = Date.now()): { token: string; expiresAt: number } {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = now + CABINET_TOKEN_DAYS * DAY_MS;
  db.delete(clientAccessTokens).where(lte(clientAccessTokens.expiresAt, now)).run();
  db.insert(clientAccessTokens).values({ clientId, tokenHash: hashCabinetToken(token), createdAt: now, expiresAt }).run();
  const stale = db
    .select({ id: clientAccessTokens.id })
    .from(clientAccessTokens)
    .where(eq(clientAccessTokens.clientId, clientId))
    .orderBy(desc(clientAccessTokens.createdAt), desc(clientAccessTokens.id))
    .all()
    .slice(MAX_LIVE_TOKENS)
    .map((r) => r.id);
  if (stale.length) db.delete(clientAccessTokens).where(inArray(clientAccessTokens.id, stale)).run();
  return { token, expiresAt };
}

/**
 * The client of a live sign-in link (its use is recorded), else null. The bot gives links only to a chat linked to the
 * card, so a card that has lost its Telegram chat (re-linked to another card) loses its links too.
 */
export function clientByCabinetToken(db: DbOrTx, token: string, now = Date.now()): ClientRow | null {
  if (!TOKEN_PATTERN.test(token)) return null;
  const row = db.select().from(clientAccessTokens).where(eq(clientAccessTokens.tokenHash, hashCabinetToken(token))).get();
  if (!row || row.expiresAt <= now) return null;
  const client = db.select().from(clients).where(eq(clients.id, row.clientId)).get();
  if (!client || client.telegramChatId == null) return null;
  db.update(clientAccessTokens).set({ lastUsedAt: now }).where(eq(clientAccessTokens.id, row.id)).run();
  return client;
}

/** Signing out on the website: the link stops working. */
export function revokeCabinetToken(db: DbOrTx, token: string): void {
  if (!TOKEN_PATTERN.test(token)) return;
  db.delete(clientAccessTokens).where(eq(clientAccessTokens.tokenHash, hashCabinetToken(token))).run();
}

const base = (config: Pick<Config, 'publicUrl'>): string | null => config.publicUrl?.trim().replace(/\/+$/, '') || null;

/** `PUBLIC_URL/book/me` (the Mini App — Telegram opens only `https://`), null without `PUBLIC_URL`. */
export function cabinetUrl(config: Pick<Config, 'publicUrl'>): string | null {
  const root = base(config);
  return root ? `${root}${CABINET_PATH}` : null;
}

/**
 * The website sign-in link `PUBLIC_URL/book/me#t=<token>`: in the fragment, so the token never reaches the server's or
 * the proxy's request logs (the page reads it and removes it from the address bar).
 */
export function cabinetSignInUrl(config: Pick<Config, 'publicUrl'>, token: string): string | null {
  const url = cabinetUrl(config);
  return url ? `${url}#t=${encodeURIComponent(token)}` : null;
}
