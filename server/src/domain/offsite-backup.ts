import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { OffsiteBackupConfig } from '../config.js';
import { deleteObject, listKeys, putObject, type Fetch } from '../lib/s3.js';

/**
 * Off-site copies of the daily backup: the SQLite file encrypted with AES-256-GCM on the server (the storage never
 * sees client data), uploaded to S3-compatible storage, the newest `keep` copies kept. The photo archive
 * (domain/offsite-uploads.ts) uses the same format, written and read as a stream.
 * File format: `MIKANBK1` (8 bytes) + IV (12) + GCM tag (16) + ciphertext.
 */

const MAGIC = Buffer.from('MIKANBK1');
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + IV_BYTES + TAG_BYTES;
const NOT_A_BACKUP = 'Это не зашифрованный бэкап MIKAN';
const WRONG_KEY_OR_DAMAGED = 'Не удалось расшифровать: другой ключ или файл повреждён';
const COPY_RE = /mikan-\d{4}-\d{2}-\d{2}\.db\.enc$/;

export function encryptBackup(data: Buffer, key: Buffer): Buffer {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

/** Throws on a wrong key or a damaged file (GCM checks the whole content). */
export function decryptBackup(blob: Buffer, key: Buffer): Buffer {
  if (blob.length < MAGIC.length + IV_BYTES + TAG_BYTES || !blob.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error(NOT_A_BACKUP);
  }
  const iv = blob.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
  const tag = blob.subarray(MAGIC.length + IV_BYTES, MAGIC.length + IV_BYTES + TAG_BYTES);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(blob.subarray(MAGIC.length + IV_BYTES + TAG_BYTES)), decipher.final()]);
}

/**
 * Encrypts a stream into `file` (memory stays at one chunk): the tag is known only at the end, so its place in the
 * header is written last. Returns the file size.
 */
export async function encryptToFile(chunks: Iterable<Buffer> | AsyncIterable<Buffer>, file: string, key: Buffer): Promise<number> {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const out = await fs.promises.open(file, 'w', 0o600);
  try {
    await writeAll(out, Buffer.concat([MAGIC, iv, Buffer.alloc(TAG_BYTES)]));
    let bytes = HEADER_BYTES;
    for await (const chunk of chunks) {
      const encrypted = cipher.update(chunk);
      await writeAll(out, encrypted);
      bytes += encrypted.length;
    }
    const last = cipher.final();
    await writeAll(out, last);
    await writeAll(out, cipher.getAuthTag(), MAGIC.length + IV_BYTES);
    return bytes + last.length;
  } finally {
    await out.close();
  }
}

/** A short write (a full disk) must fail the copy, not leave a cut ciphertext behind a valid header. */
async function writeAll(out: fs.promises.FileHandle, data: Buffer, position: number | null = null): Promise<void> {
  if (data.length === 0) return;
  const { bytesWritten } = await out.write(data, 0, data.length, position);
  if (bytesWritten !== data.length) throw new Error(`Копия записана не целиком (${bytesWritten} из ${data.length} байт) — мало места на диске?`);
}

/**
 * Decrypts a copy of any size into `output` as a stream. GCM checks the content only at the end: on a wrong key or a
 * damaged file the output is deleted and it throws. Returns the plain size.
 */
export async function decryptFile(input: string, output: string, key: Buffer): Promise<number> {
  const header = Buffer.alloc(HEADER_BYTES);
  const source = await fs.promises.open(input, 'r');
  try {
    const { bytesRead } = await source.read(header, 0, HEADER_BYTES, 0);
    if (bytesRead < HEADER_BYTES || !header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error(NOT_A_BACKUP);
  } finally {
    await source.close();
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, header.subarray(MAGIC.length, MAGIC.length + IV_BYTES));
  decipher.setAuthTag(header.subarray(MAGIC.length + IV_BYTES));
  try {
    // Client data: readable by the owner only.
    await pipeline(fs.createReadStream(input, { start: HEADER_BYTES }), decipher, fs.createWriteStream(output, { mode: 0o600 }));
  } catch (err) {
    fs.rmSync(output, { force: true });
    // GCM's own words («Unsupported state or unable to authenticate data») say nothing to a person.
    if (err instanceof Error && /authenticate/.test(err.message)) throw new Error(WRONG_KEY_OR_DAMAGED, { cause: err });
    throw err;
  }
  return fs.statSync(output).size;
}

/** Deletes all but the newest `keep` copies under the prefix whose keys match `pattern` (names sort by date). */
export async function pruneCopies(
  config: OffsiteBackupConfig,
  pattern: RegExp,
  keep: number,
  fetchImpl?: Fetch,
  now = Date.now(),
): Promise<string[]> {
  const copies = (await listKeys(config.s3, config.prefix, fetchImpl, now)).filter((k) => pattern.test(k)).sort();
  const stale = copies.slice(0, Math.max(0, copies.length - keep));
  for (const old of stale) await deleteObject(config.s3, old, fetchImpl, now);
  return stale;
}

export interface OffsiteResult {
  key: string;
  bytes: number;
  pruned: string[];
}

/** Encrypts and uploads one local backup, then deletes all but the newest `keep` copies under the prefix. */
export async function uploadBackupOffsite(
  config: OffsiteBackupConfig,
  file: string,
  fetchImpl?: Fetch,
  now = Date.now(),
): Promise<OffsiteResult> {
  const body = encryptBackup(fs.readFileSync(file), config.key);
  const key = `${config.prefix}${path.basename(file)}.enc`;
  await putObject(config.s3, key, body, fetchImpl, now);
  return { key, bytes: body.length, pruned: await pruneCopies(config, COPY_RE, config.keep, fetchImpl, now) };
}
