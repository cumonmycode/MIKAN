import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { Config } from '../config.js';

/**
 * Encryption of secrets kept in the database (the Instagram token of an SMM profile): AES-256-GCM, so a damaged or
 * tampered value fails to decrypt instead of yielding garbage. The key is derived from `JWT_SECRET` — a stolen
 * database file alone does not reveal the secrets. Changing `JWT_SECRET` makes stored values unreadable (they are
 * entered again).
 *
 * Format: `v1:<base64 of iv(12) | tag(16) | ciphertext>`. The plaintext never goes to API responses or logs.
 */

const ALGO = 'aes-256-gcm';
const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface SecretsContext {
  config: Pick<Config, 'jwtSecret'>;
}

function keyOf(ctx: SecretsContext): Buffer {
  return createHash('sha256').update(`${ctx.config.jwtSecret}:secrets`).digest();
}

export function encryptSecret(ctx: SecretsContext, plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, keyOf(ctx), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `${VERSION}:${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64')}`;
}

/** Throws when the value is malformed, of another version, tampered with or encrypted under another key. */
export function decryptSecret(ctx: SecretsContext, enc: string): string {
  const prefix = `${VERSION}:`;
  if (!enc.startsWith(prefix)) throw new Error('decryptSecret: unsupported or malformed value');
  const raw = Buffer.from(enc.slice(prefix.length), 'base64');
  if (raw.length < IV_BYTES + TAG_BYTES) throw new Error('decryptSecret: unsupported or malformed value');
  const decipher = createDecipheriv(ALGO, keyOf(ctx), raw.subarray(0, IV_BYTES));
  decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
}

/** For showing a stored secret in the app: `••••` and the last 4 characters (short values — only `••••`). */
export function maskSecret(plaintext: string): string {
  return plaintext.length <= 4 ? '••••' : `••••${plaintext.slice(-4)}`;
}
