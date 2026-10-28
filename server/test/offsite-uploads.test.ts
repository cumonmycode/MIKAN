import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OffsiteBackupConfig } from '../src/config.js';
import { openDatabase, type DbHandle } from '../src/db/client.js';
import { decryptBackup, decryptFile, encryptToFile } from '../src/domain/offsite-backup.js';
import { backupUploadsOffsite, uploadsManifest, uploadUploadsOffsite } from '../src/domain/offsite-uploads.js';
import { getOffsiteUploads, setStaffChatId } from '../src/domain/settings.js';
import { putFile, type Fetch } from '../src/lib/s3.js';
import { readTar } from '../src/lib/tar.js';
import { createTestApp, type TestApp } from './helpers.js';

/** deploy/README.md «Бэкапы вне сервера»: the daily encrypted archive of DATA_DIR/uploads. */

const NOW = Date.parse('2026-10-19T01:00:00Z');
const clock = () => NOW;

interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: Buffer;
}

/** S3 as far as the uploads need it: list, put, delete and multipart uploads; every request recorded. */
function fakeStorage(listed: string[] = [], fail?: (call: Call) => Response | null) {
  const calls: Call[] = [];
  const fetchImpl: Fetch = async (url, init) => {
    const call = { ...init, url: new URL(url) };
    calls.push(call);
    const failure = fail?.(call);
    if (failure) return failure;
    const q = call.url.searchParams;
    if (init.method === 'GET') {
      return new Response(`<ListBucketResult>${listed.map((k) => `<Contents><Key>${k}</Key></Contents>`).join('')}</ListBucketResult>`);
    }
    if (init.method === 'POST' && q.has('uploads')) return new Response('<InitiateMultipartUploadResult><UploadId>UP-1</UploadId></InitiateMultipartUploadResult>');
    if (init.method === 'PUT' && q.has('partNumber')) return new Response(null, { headers: { ETag: `"etag-${q.get('partNumber')}"` } });
    if (init.method === 'POST' && q.has('uploadId')) return new Response('<CompleteMultipartUploadResult><ETag>"x"</ETag></CompleteMultipartUploadResult>');
    return new Response(null, { status: init.method === 'DELETE' ? 204 : 200 });
  };
  return { calls, fetchImpl };
}

function offsiteConfig(): OffsiteBackupConfig {
  return {
    s3: { endpoint: 'https://storage.yandexcloud.net', region: 'ru-central1', bucket: 'mikan-backups', accessKeyId: 'id', secretAccessKey: 'secret' },
    prefix: 'mikan/',
    key: crypto.randomBytes(32),
    keep: 30,
  };
}

const tmpDir = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `mikan-${name}-`));
const describeCall = (c: Call) => `${c.method} ${c.url.pathname}${c.url.search}`;

describe('streaming encryption of large backups', () => {
  it('writes the same format as the database copies and decrypts it back, by stream or at once', async () => {
    const key = crypto.randomBytes(32);
    const dir = tmpDir('crypt');
    const parts = [Buffer.from('первая часть '), Buffer.alloc(100_000, 1), Buffer.from(' конец')];
    async function* chunks() {
      yield* parts;
    }
    const enc = path.join(dir, 'a.tar.enc');
    const bytes = await encryptToFile(chunks(), enc, key);
    expect(bytes).toBe(fs.statSync(enc).size);
    expect(fs.readFileSync(enc).subarray(0, 8).toString()).toBe('MIKANBK1');
    expect(decryptBackup(fs.readFileSync(enc), key).equals(Buffer.concat(parts))).toBe(true);
    const out = path.join(dir, 'a.tar');
    expect(await decryptFile(enc, out, key)).toBe(Buffer.concat(parts).length);
    expect(fs.readFileSync(out).equals(Buffer.concat(parts))).toBe(true);
    expect(fs.statSync(out).mode & 0o777).toBe(0o600); // client data: readable by the owner only
    expect(fs.statSync(enc).mode & 0o777).toBe(0o600);
  });

  it('refuses a wrong key or a damaged file and leaves no half-written output', async () => {
    const key = crypto.randomBytes(32);
    const dir = tmpDir('crypt');
    const enc = path.join(dir, 'a.enc');
    await encryptToFile([Buffer.alloc(70_000, 3)], enc, key);
    const out = path.join(dir, 'out');
    await expect(decryptFile(enc, out, crypto.randomBytes(32))).rejects.toThrow('Не удалось расшифровать: другой ключ или файл повреждён');
    expect(fs.existsSync(out)).toBe(false);
    const damaged = path.join(dir, 'damaged.enc');
    const bytes = fs.readFileSync(enc);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    fs.writeFileSync(damaged, bytes);
    await expect(decryptFile(damaged, out, key)).rejects.toThrow('Не удалось расшифровать');
    expect(fs.existsSync(out)).toBe(false);
    const plain = path.join(dir, 'plain.db');
    fs.writeFileSync(plain, 'SQLite format 3');
    await expect(decryptFile(plain, out, key)).rejects.toThrow('Это не зашифрованный бэкап MIKAN');
    expect(fs.existsSync(out)).toBe(false);
  });
});

describe('S3 upload of a file', () => {
  const config = offsiteConfig().s3;

  it('sends a small file with one PUT', async () => {
    const file = path.join(tmpDir('put'), 'small.bin');
    fs.writeFileSync(file, 'small');
    const { calls, fetchImpl } = fakeStorage();
    expect(await putFile(config, 'mikan/small.bin', file, { fetchImpl, clock, partBytes: 1024 })).toEqual({ parts: 1 });
    expect(calls.map(describeCall)).toEqual(['PUT /mikan-backups/mikan/small.bin']);
    expect(calls[0]!.body!.toString()).toBe('small');
  });

  it('sends a large file in parts (multipart upload), each part signed', async () => {
    const file = path.join(tmpDir('put'), 'large.bin');
    const content = crypto.randomBytes(2500);
    fs.writeFileSync(file, content);
    const { calls, fetchImpl } = fakeStorage();
    expect(await putFile(config, 'mikan/large.bin', file, { fetchImpl, clock, partBytes: 1024 })).toEqual({ parts: 3 });
    expect(calls.map(describeCall)).toEqual([
      'POST /mikan-backups/mikan/large.bin?uploads',
      'PUT /mikan-backups/mikan/large.bin?partNumber=1&uploadId=UP-1',
      'PUT /mikan-backups/mikan/large.bin?partNumber=2&uploadId=UP-1',
      'PUT /mikan-backups/mikan/large.bin?partNumber=3&uploadId=UP-1',
      'POST /mikan-backups/mikan/large.bin?uploadId=UP-1',
    ]);
    expect(Buffer.concat(calls.slice(1, 4).map((c) => c.body!)).equals(content)).toBe(true);
    expect(calls.slice(1, 4).map((c) => c.body!.length)).toEqual([1024, 1024, 452]);
    for (const c of calls) expect(c.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=id\/20261019\/ru-central1\/s3\/aws4_request/);
    expect(calls[4]!.body!.toString()).toBe(
      '<CompleteMultipartUpload>' +
        '<Part><PartNumber>1</PartNumber><ETag>"etag-1"</ETag></Part>' +
        '<Part><PartNumber>2</PartNumber><ETag>"etag-2"</ETag></Part>' +
        '<Part><PartNumber>3</PartNumber><ETag>"etag-3"</ETag></Part>' +
        '</CompleteMultipartUpload>',
    );
  });

  it('aborts the multipart upload when a part fails, and notices an error inside a 200 answer', async () => {
    const file = path.join(tmpDir('put'), 'large.bin');
    fs.writeFileSync(file, crypto.randomBytes(2500));
    const failing = fakeStorage([], (c) => (c.url.searchParams.get('partNumber') === '2' ? new Response('<Error><Code>InternalError</Code></Error>', { status: 500 }) : null));
    await expect(putFile(config, 'mikan/large.bin', file, { fetchImpl: failing.fetchImpl, clock, partBytes: 1024 })).rejects.toThrow('HTTP 500 InternalError');
    expect(failing.calls.map(describeCall).at(-1)).toBe('DELETE /mikan-backups/mikan/large.bin?uploadId=UP-1');

    // The abort failing too is told, not lost (the parts stay in the bucket until its lifecycle rule removes them).
    const stuck = fakeStorage([], (c) => (c.method === 'PUT' || c.method === 'DELETE' ? new Response('<Error><Code>ServiceUnavailable</Code></Error>', { status: 503 }) : null));
    await expect(putFile(config, 'mikan/large.bin', file, { fetchImpl: stuck.fetchImpl, clock, partBytes: 1024 })).rejects.toThrow(
      /HTTP 503 ServiceUnavailable; отменить загрузку частей не удалось: S3 DELETE .*HTTP 503/,
    );

    const quirky = fakeStorage([], (c) =>
      c.method === 'POST' && c.url.searchParams.has('uploadId') ? new Response('<Error><Code>SlowDown</Code></Error>', { status: 200 }) : null,
    );
    await expect(putFile(config, 'mikan/large.bin', file, { fetchImpl: quirky.fetchImpl, clock, partBytes: 1024 })).rejects.toThrow('SlowDown');
    expect(quirky.calls.map(describeCall).at(-1)).toBe('DELETE /mikan-backups/mikan/large.bin?uploadId=UP-1');
  });
});

describe('the photo archive', () => {
  let handle: DbHandle;
  let uploads: string;
  let work: string;
  let config: OffsiteBackupConfig;

  beforeEach(() => {
    handle = openDatabase(':memory:');
    const data = tmpDir('data');
    uploads = path.join(data, 'uploads');
    work = path.join(data, 'backups');
    fs.mkdirSync(uploads);
    fs.mkdirSync(work);
    fs.writeFileSync(path.join(uploads, 'b.jpg'), 'photo b');
    fs.writeFileSync(path.join(uploads, 'a.png'), 'photo a');
    config = offsiteConfig();
  });
  afterEach(() => handle.sqlite.close());

  const run = (fetchImpl: Fetch, extra: { force?: boolean; date?: string } = {}) =>
    uploadUploadsOffsite(handle.db, config, { uploadsDir: uploads, workDir: work, date: extra.date ?? '2026-10-19', force: extra.force, fetchImpl, clock });

  it('lists the files of the uploads folder with a hash that changes with the set', () => {
    const first = uploadsManifest(uploads);
    expect(first.files.map((f) => f.name)).toEqual(['a.png', 'b.jpg']);
    expect(uploadsManifest(uploads).hash).toBe(first.hash);
    fs.writeFileSync(path.join(uploads, 'c.webp'), 'photo c');
    expect(uploadsManifest(uploads).hash).not.toBe(first.hash);
    fs.rmSync(path.join(uploads, 'c.webp'));
    expect(uploadsManifest(uploads).hash).toBe(first.hash);
    fs.writeFileSync(path.join(uploads, 'a.png'), 'photo a, edited');
    expect(uploadsManifest(uploads).hash).not.toBe(first.hash);
    expect(uploadsManifest(path.join(uploads, 'missing')).files).toEqual([]);
  });

  it('uploads the encrypted archive, keeps the newest 7 archives and never touches the database copies', async () => {
    const listed = [
      ...['10', '11', '12', '13', '14', '15', '16', '17', '19'].map((d) => `mikan/mikan-uploads-2026-10-${d}.tar.enc`),
      'mikan/mikan-2026-10-01.db.enc',
    ];
    const { calls, fetchImpl } = fakeStorage(listed);
    const result = await run(fetchImpl);

    expect(result).toEqual({
      status: 'uploaded',
      key: 'mikan/mikan-uploads-2026-10-19.tar.enc',
      files: 2,
      bytes: calls[0]!.body!.length,
      skipped: [],
      pruned: ['mikan/mikan-uploads-2026-10-10.tar.enc', 'mikan/mikan-uploads-2026-10-11.tar.enc'],
    });
    expect(calls.map(describeCall)).toEqual([
      'PUT /mikan-backups/mikan/mikan-uploads-2026-10-19.tar.enc',
      'GET /mikan-backups?list-type=2&prefix=mikan%2F',
      'DELETE /mikan-backups/mikan/mikan-uploads-2026-10-10.tar.enc',
      'DELETE /mikan-backups/mikan/mikan-uploads-2026-10-11.tar.enc',
    ]);
    const entries = readTar(decryptBackup(calls[0]!.body!, config.key));
    expect(entries.map((e) => [e.name, e.data.toString()])).toEqual([
      ['uploads/a.png', 'photo a'],
      ['uploads/b.jpg', 'photo b'],
    ]);
    expect(getOffsiteUploads(handle.db)).toEqual({
      hash: uploadsManifest(uploads).hash,
      target: expect.stringMatching(/^[0-9a-f]{64}$/),
      key: 'mikan/mikan-uploads-2026-10-19.tar.enc',
      files: 2,
      uploadedAt: NOW,
    });
    expect(fs.readdirSync(work)).toEqual([]); // the local archive is removed
  });

  it('uploads again only when the file set changed (or when forced)', async () => {
    await run(fakeStorage().fetchImpl);
    const quiet = fakeStorage();
    expect(await run(quiet.fetchImpl, { date: '2026-10-20' })).toEqual({ status: 'unchanged', files: 2 });
    expect(quiet.calls).toEqual([]);

    fs.writeFileSync(path.join(uploads, 'c.webp'), 'photo c');
    const changed = fakeStorage();
    expect(await run(changed.fetchImpl, { date: '2026-10-20' })).toMatchObject({ status: 'uploaded', files: 3 });
    expect(readTar(decryptBackup(changed.calls[0]!.body!, config.key)).map((e) => e.name)).toEqual([
      'uploads/a.png',
      'uploads/b.jpg',
      'uploads/c.webp',
    ]);

    const forced = fakeStorage();
    expect(await run(forced.fetchImpl, { date: '2026-10-21', force: true })).toMatchObject({ status: 'uploaded', files: 3 });
  });

  it('uploads again when the storage or the encryption key changed, even with the same photos', async () => {
    await run(fakeStorage().fetchImpl);
    expect(await run(fakeStorage().fetchImpl)).toMatchObject({ status: 'unchanged' });
    config = { ...config, s3: { ...config.s3, bucket: 'new-bucket' } };
    expect(await run(fakeStorage().fetchImpl)).toMatchObject({ status: 'uploaded' });
    config = { ...config, prefix: 'studio/' };
    expect(await run(fakeStorage().fetchImpl)).toMatchObject({ status: 'uploaded', key: 'studio/mikan-uploads-2026-10-19.tar.enc' });
    config = { ...config, key: crypto.randomBytes(32) };
    expect(await run(fakeStorage().fetchImpl)).toMatchObject({ status: 'uploaded' });
    expect(await run(fakeStorage().fetchImpl)).toMatchObject({ status: 'unchanged' });
    expect(JSON.stringify(getOffsiteUploads(handle.db))).not.toContain(config.key.toString('base64')); // only a fingerprint
  });

  it('removes archives left half-written by a crash a day ago, and leaves one another run is writing', async () => {
    const stale = path.join(work, 'mikan-uploads-2026-10-17.tar.enc.1a2b3c4d.part');
    const fresh = path.join(work, 'mikan-uploads-2026-10-19.tar.enc.5e6f7a8b.part');
    const unrelated = path.join(work, 'mikan-2026-10-18.db');
    for (const file of [stale, fresh, unrelated]) fs.writeFileSync(file, 'x');
    const dayAgo = new Date(Date.now() - 25 * 60 * 60_000);
    fs.utimesSync(stale, dayAgo, dayAgo);
    await run(fakeStorage().fetchImpl);
    expect(fs.readdirSync(work).sort()).toEqual([path.basename(unrelated), path.basename(fresh)].sort());
  });

  it('a failed upload is retried next time: nothing is remembered and the local archive is removed', async () => {
    const failing = fakeStorage([], () => new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 }));
    await expect(run(failing.fetchImpl)).rejects.toThrow('HTTP 403 AccessDenied');
    expect(getOffsiteUploads(handle.db)).toBeNull();
    expect(fs.readdirSync(work)).toEqual([]);
    expect(await run(fakeStorage().fetchImpl)).toMatchObject({ status: 'uploaded' });
  });

  it('leaves out a file whose name tar cannot hold and saves the rest', async () => {
    const odd = `${'x'.repeat(101)}.jpg`;
    fs.writeFileSync(path.join(uploads, odd), 'odd');
    const { calls, fetchImpl } = fakeStorage();
    expect(await run(fetchImpl)).toMatchObject({ status: 'uploaded', files: 2, skipped: [odd] });
    expect(readTar(decryptBackup(calls[0]!.body!, config.key)).map((e) => e.name)).toEqual(['uploads/a.png', 'uploads/b.jpg']);
  });

  it('sends nothing while there are no photos', async () => {
    fs.rmSync(uploads, { recursive: true });
    const { calls, fetchImpl } = fakeStorage();
    expect(await run(fetchImpl)).toEqual({ status: 'empty', files: 0 });
    expect(calls).toEqual([]);
  });
});

describe('the daily photo archive in the server', () => {
  let t: TestApp;
  const STAFF_CHAT = -100_777;

  beforeEach(async () => {
    t = await createTestApp();
    fs.mkdirSync(path.join(t.ctx.config.dataDir, 'uploads'), { recursive: true });
    fs.writeFileSync(path.join(t.ctx.config.dataDir, 'uploads', 'a.jpg'), 'photo');
    setStaffChatId(t.ctx.db, STAFF_CHAT);
  });
  afterEach(async () => {
    await t.close();
  });

  it('tells the staff when the archive cannot be sent, and when it goes again', async () => {
    const config = offsiteConfig();
    const failing = fakeStorage([], () => new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 }));
    await backupUploadsOffsite(t.ctx, config, '2026-10-19', failing.fetchImpl);
    expect(t.gateway.textsTo(STAFF_CHAT).at(-1)).toBe(
      '⚠️ Не удалось отправить архив фото во внешнее хранилище: S3 PUT /mikan-backups/mikan/mikan-uploads-2026-10-19.tar.enc: HTTP 403 AccessDenied',
    );
    await backupUploadsOffsite(t.ctx, config, '2026-10-20', fakeStorage().fetchImpl);
    expect(t.gateway.textsTo(STAFF_CHAT).at(-1)).toBe('✅ Архив фото снова уходит во внешнее хранилище');
  });
});
