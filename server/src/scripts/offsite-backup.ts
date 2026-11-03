/**
 * Off-site backups by hand (the server uploads every daily backup and the photo archive by itself once configured):
 *
 *   node dist/scripts/offsite-backup.js keygen                    — a new BACKUP_ENCRYPTION_KEY (keep a copy outside the server!)
 *   node dist/scripts/offsite-backup.js upload [file]             — upload a backup now (default: the newest one) to check the setup
 *   node dist/scripts/offsite-backup.js upload-uploads [--force]  — upload the photo archive now (only if the photos changed, unless --force)
 *   node dist/scripts/offsite-backup.js decrypt <in> <out>        — decrypt a downloaded `.db.enc` copy into a SQLite file,
 *                                                                   or a `.tar.enc` photo archive into a `.tar`
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { openDatabase } from '../db/client.js';
import { decryptFile, uploadBackupOffsite } from '../domain/offsite-backup.js';
import { uploadUploadsOffsite } from '../domain/offsite-uploads.js';
import { studioTimezone } from '../domain/settings.js';
import { errorMessage } from '../lib/errors.js';
import { localDate } from '../lib/time.js';
import { isEntryPoint } from './cli.js';

const USAGE =
  'Usage: node dist/scripts/offsite-backup.js keygen | upload [file] | upload-uploads [--force] | ' +
  'decrypt <in.db.enc> <out.db> | decrypt <in.tar.enc> <out.tar>\n';
const KEY_BYTES = 32;

/** The newest daily backup in `dir` (names sort by date), or null. */
export function newestBackup(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^mikan-\d{4}-\d{2}-\d{2}\.db$/.test(f))
    .sort();
  const last = files.at(-1);
  return last ? path.join(dir, last) : null;
}

/** Any size: the copy is decrypted as a stream (a photo archive may be large). */
async function decrypt(input: string, output: string): Promise<number> {
  const key = Buffer.from(process.env.BACKUP_ENCRYPTION_KEY ?? '', 'base64');
  if (key.length !== KEY_BYTES) {
    process.stderr.write('BACKUP_ENCRYPTION_KEY: нужен ключ из 32 байт в base64\n');
    return 2;
  }
  await decryptFile(input, output, key);
  process.stdout.write(`Расшифровано: ${output}\n`);
  return 0;
}

/** The off-site settings, or null after telling what is missing. */
function offsiteConfig() {
  const config = loadConfig();
  if (!config.offsiteBackup) {
    const problem = config.offsiteBackupProblem ? `: ${config.offsiteBackupProblem}` : '';
    process.stderr.write(`Бэкапы вне сервера не настроены${problem}\n`);
    return null;
  }
  return { config, offsite: config.offsiteBackup };
}

async function upload(file: string | undefined): Promise<number> {
  const setup = offsiteConfig();
  if (!setup) return 2;
  const { config } = setup;
  const source = file ?? newestBackup(path.join(config.dataDir, 'backups'));
  if (!source) {
    process.stderr.write('Нет локальных бэкапов для выгрузки\n');
    return 2;
  }
  const result = await uploadBackupOffsite(setup.offsite, source);
  process.stdout.write(`${JSON.stringify({ uploaded: result.key, bytes: result.bytes, pruned: result.pruned }, null, 2)}\n`);
  return 0;
}

/** The photo archive now; the manifest in the database decides whether anything changed (`--force` sends anyway). */
async function uploadPhotos(force: boolean): Promise<number> {
  const setup = offsiteConfig();
  if (!setup) return 2;
  const { db, sqlite } = openDatabase(path.join(setup.config.dataDir, 'mikan.db'));
  try {
    const result = await uploadUploadsOffsite(db, setup.offsite, {
      uploadsDir: path.join(setup.config.dataDir, 'uploads'),
      workDir: path.join(setup.config.dataDir, 'backups'),
      date: localDate(Date.now(), studioTimezone(db)),
      force,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } finally {
    sqlite.close();
  }
}

async function main(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  if (command === 'keygen') {
    process.stdout.write(`${crypto.randomBytes(KEY_BYTES).toString('base64')}\n`);
    return 0;
  }
  if (command === 'decrypt' && rest.length === 2) return decrypt(rest[0]!, rest[1]!);
  if (command === 'upload' && rest.length <= 1) return upload(rest[0]);
  if (command === 'upload-uploads' && rest.every((a) => a === '--force')) return uploadPhotos(rest.includes('--force'));
  process.stderr.write(USAGE);
  return 2;
}

if (isEntryPoint(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`${errorMessage(err)}\n`);
      process.exit(1);
    },
  );
}
