import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { OffsiteBackupConfig } from '../config.js';
import type { AppContext } from '../context.js';
import type { DbOrTx } from '../db/client.js';
import { errorMessage } from '../lib/errors.js';
import { putFile, type Fetch } from '../lib/s3.js';
import { tarChunks, ustarFits, type TarEntry } from '../lib/tar.js';
import { DAY_MS } from '../lib/time.js';
import { raiseAlert, resolveAlerts } from './alerts.js';
import { encryptToFile, pruneCopies } from './offsite-backup.js';
import { getOffsiteUploads, setOffsiteUploads } from './settings.js';

/**
 * Off-site copies of the uploaded photos (deploy/README.md «Бэкапы вне сервера»): once a day, after the database copy,
 * DATA_DIR/uploads goes as an encrypted ustar archive `mikan-uploads-YYYY-MM-DD.tar.enc` (the database copies' key
 * and format) — only when the file set changed since the last upload (a manifest hash kept in the settings). The
 * newest 7 archives are kept. The archive is built and encrypted as a stream into DATA_DIR/backups, uploaded (in parts
 * when large) and removed.
 */

export const UPLOADS_KEEP = 7;
export const UPLOADS_COPY_RE = /mikan-uploads-\d{4}-\d{2}-\d{2}\.tar\.enc$/;
/** Entries are stored under this folder: `tar -xf … -C DATA_DIR` restores `DATA_DIR/uploads`. */
const ARCHIVE_ROOT = 'uploads';
/** A local archive this old was left by a crash (a run takes minutes): removed by the next run. */
const STALE_PART_MS = DAY_MS;
const PART_FILE_RE = /^mikan-uploads-.+\.part$/;

export const uploadsArchiveName = (date: string): string => `mikan-uploads-${date}.tar.enc`;

export interface ManifestFile {
  /** «/»-separated path inside the uploads folder. */
  name: string;
  size: number;
  mtime: number;
}

export interface UploadsManifest {
  files: ManifestFile[];
  hash: string;
}

/** Regular files under `dir` (relative paths, sorted) and a hash of their names, sizes and times. */
export function uploadsManifest(dir: string): UploadsManifest {
  const files: ManifestFile[] = [];
  const walk = (relative: string): void => {
    for (const entry of fs.readdirSync(path.join(dir, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(name);
      } else if (entry.isFile()) {
        const stat = fs.statSync(path.join(dir, name));
        files.push({ name, size: stat.size, mtime: Math.floor(stat.mtimeMs) });
      }
    }
  };
  if (fs.existsSync(dir)) walk('');
  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const lines = files.map((f) => `${f.name}\t${f.size}\t${f.mtime}`).join('\n');
  return { files, hash: crypto.createHash('sha256').update(lines).digest('hex') };
}

/** The files as archive entries, read one at a time; a file deleted meanwhile is left out. */
async function* entriesOf(dir: string, files: ManifestFile[], archived: { count: number }): AsyncGenerator<TarEntry> {
  for (const file of files) {
    let data: Buffer;
    try {
      data = await fs.promises.readFile(path.join(dir, file.name));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    archived.count += 1;
    yield { name: `${ARCHIVE_ROOT}/${file.name}`, data, mtime: file.mtime };
  }
}

/**
 * Where and with what key the archive goes: another bucket, prefix or key means the photos are not there yet. Only a
 * hash is stored (never the key).
 */
function targetOf(config: OffsiteBackupConfig): string {
  return crypto
    .createHash('sha256')
    .update([config.s3.endpoint, config.s3.bucket, config.prefix, ''].join('\n'))
    .update(config.key)
    .digest('hex');
}

/** Local archives a crashed run left behind (an archive being written now is fresh and stays). */
function removeStaleParts(workDir: string, now: number): void {
  for (const name of fs.readdirSync(workDir)) {
    const file = path.join(workDir, name);
    if (PART_FILE_RE.test(name) && fs.statSync(file).mtimeMs < now - STALE_PART_MS) fs.rmSync(file, { force: true });
  }
}

export interface UploadsArchiveOptions {
  uploadsDir: string;
  /** Where the encrypted archive is written before the upload (removed afterwards). */
  workDir: string;
  /** Studio-local `YYYY-MM-DD` of the archive's name. */
  date: string;
  /** Upload even when nothing changed since the last upload. */
  force?: boolean;
  fetchImpl?: Fetch;
  clock?: () => number;
  partBytes?: number;
}

export type UploadsResult =
  | { status: 'unchanged' | 'empty'; files: number }
  | { status: 'uploaded'; key: string; bytes: number; files: number; skipped: string[]; pruned: string[] };

/** Archives, encrypts and uploads the photos when their set changed (or `force`); the newest 7 archives are kept. */
export async function uploadUploadsOffsite(db: DbOrTx, config: OffsiteBackupConfig, opts: UploadsArchiveOptions): Promise<UploadsResult> {
  const clock = opts.clock ?? Date.now;
  const manifest = uploadsManifest(opts.uploadsDir);
  if (manifest.files.length === 0) return { status: 'empty', files: 0 };
  const target = targetOf(config);
  const last = getOffsiteUploads(db);
  if (!opts.force && last?.hash === manifest.hash && last.target === target) return { status: 'unchanged', files: manifest.files.length };

  // A path ustar cannot hold (never one the server names itself) must not stop the rest from being saved.
  const skipped = manifest.files.filter((f) => !ustarFits(`${ARCHIVE_ROOT}/${f.name}`)).map((f) => f.name);
  const files = manifest.files.filter((f) => !skipped.includes(f.name));
  const name = uploadsArchiveName(opts.date);
  const key = `${config.prefix}${name}`;
  fs.mkdirSync(opts.workDir, { recursive: true });
  removeStaleParts(opts.workDir, Date.now());
  // Its own name: a manual `upload-uploads` may run while the daily one does.
  const local = path.join(opts.workDir, `${name}.${crypto.randomBytes(4).toString('hex')}.part`);
  const archived = { count: 0 };
  try {
    const bytes = await encryptToFile(tarChunks(entriesOf(opts.uploadsDir, files, archived)), local, config.key);
    await putFile(config.s3, key, local, { fetchImpl: opts.fetchImpl, clock, partBytes: opts.partBytes });
    // Remembered once the archive is stored: a failed clean-up below must not send the same photos again.
    setOffsiteUploads(db, { hash: manifest.hash, target, key, files: archived.count, uploadedAt: clock() });
    const pruned = await pruneCopies(config, UPLOADS_COPY_RE, UPLOADS_KEEP, opts.fetchImpl, clock());
    return { status: 'uploaded', key, bytes, files: archived.count, skipped, pruned };
  } finally {
    fs.rmSync(local, { force: true });
  }
}

/** The daily run (index.ts, after the database copy): logged, and staff hear about failures (domain/alerts.ts). */
export async function backupUploadsOffsite(ctx: AppContext, config: OffsiteBackupConfig, date: string, fetchImpl?: Fetch): Promise<void> {
  const dataDir = ctx.config.dataDir;
  try {
    const result = await uploadUploadsOffsite(ctx.db, config, {
      uploadsDir: path.join(dataDir, 'uploads'),
      workDir: path.join(dataDir, 'backups'),
      date,
      fetchImpl,
    });
    if (result.status === 'uploaded') {
      ctx.log.info({ key: result.key, bytes: result.bytes, files: result.files, pruned: result.pruned.length }, 'off-site photo archive uploaded');
      if (result.skipped.length > 0) ctx.log.warn({ skipped: result.skipped }, 'photos tar cannot name were left out of the archive');
    }
    await resolveAlerts(ctx, ['offsite_uploads'], '✅ Архив фото снова уходит во внешнее хранилище');
  } catch (err) {
    ctx.log.error({ err: errorMessage(err) }, 'off-site photo archive failed');
    await raiseAlert(ctx, 'offsite_uploads', `⚠️ Не удалось отправить архив фото во внешнее хранилище: ${errorMessage(err)}`);
  }
}
