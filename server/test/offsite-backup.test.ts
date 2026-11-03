import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { OffsiteBackupConfig } from '../src/config.js';
import { decryptBackup, encryptBackup, uploadBackupOffsite } from '../src/domain/offsite-backup.js';
import { amzDateOf, listKeys, S3Error, sha256Hex, signRequest, type Fetch } from '../src/lib/s3.js';
import { newestBackup } from '../src/scripts/offsite-backup.js';
import { testConfig } from './helpers.js';

/** The credentials of the AWS Signature Version 4 examples for S3 (docs: «Examples: Signature Calculations»). */
const AWS_EXAMPLE = {
  region: 'us-east-1',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};
const EMPTY_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const AMZ_DATE = '20130524T000000Z';
const signatureOf = (authorization: string) => /Signature=([0-9a-f]+)/.exec(authorization)?.[1];

describe('S3 request signing (SigV4)', () => {
  it('matches the AWS example for GET Object with a Range header', () => {
    const { authorization } = signRequest(AWS_EXAMPLE, {
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      headers: { Range: 'bytes=0-9' },
      payloadHash: EMPTY_HASH,
      amzDate: AMZ_DATE,
    });
    expect(authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });

  it('matches the AWS example for PUT Object (a key with `$`, extra headers)', () => {
    const body = Buffer.from('Welcome to Amazon S3.');
    const { authorization } = signRequest(AWS_EXAMPLE, {
      method: 'PUT',
      url: new URL('https://examplebucket.s3.amazonaws.com/test$file.text'),
      headers: { Date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
      payloadHash: sha256Hex(body),
      amzDate: AMZ_DATE,
    });
    expect(signatureOf(authorization)).toBe('98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
  });

  it('matches the AWS example for GET Bucket (sorted query string)', () => {
    const { authorization } = signRequest(AWS_EXAMPLE, {
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J'),
      payloadHash: EMPTY_HASH,
      amzDate: AMZ_DATE,
    });
    expect(signatureOf(authorization)).toBe('34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
  });

  it('formats the request time as YYYYMMDDTHHMMSSZ', () => {
    expect(amzDateOf(Date.parse('2026-10-19T04:05:06.789Z'))).toBe('20261019T040506Z');
  });
});

describe('backup encryption', () => {
  const key = crypto.randomBytes(32);

  it('decrypts what it encrypted, and the copy does not contain the plain data', () => {
    const data = Buffer.from('SQLite format 3\u0000 клиент Анна +79990000001');
    const blob = encryptBackup(data, key);
    expect(blob.subarray(0, 8).toString()).toBe('MIKANBK1');
    expect(blob.includes(Buffer.from('+79990000001'))).toBe(false);
    expect(decryptBackup(blob, key).equals(data)).toBe(true);
  });

  it('refuses a wrong key, a damaged copy and a file that is not a MIKAN backup', () => {
    const blob = encryptBackup(Buffer.from('data'), key);
    expect(() => decryptBackup(blob, crypto.randomBytes(32))).toThrow();
    const damaged = Buffer.from(blob);
    const last = damaged.length - 1;
    damaged.writeUInt8(damaged.readUInt8(last) ^ 1, last);
    expect(() => decryptBackup(damaged, key)).toThrow();
    expect(() => decryptBackup(Buffer.from('SQLite format 3'), key)).toThrow('Это не зашифрованный бэкап MIKAN');
  });
});

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: Buffer;
}

/** A storage that lists the given keys and records every request. */
function fakeStorage(listed: string[], failWith?: { status: number; body: string }) {
  const calls: Call[] = [];
  const fetchImpl: Fetch = async (url, init) => {
    calls.push({ url, ...init });
    if (failWith) return new Response(failWith.body, { status: failWith.status });
    if (init.method === 'GET') {
      const xml = `<ListBucketResult>${listed.map((k) => `<Contents><Key>${k}</Key></Contents>`).join('')}</ListBucketResult>`;
      return new Response(xml, { status: 200 });
    }
    return new Response(null, { status: 200 });
  };
  return { calls, fetchImpl };
}

function offsiteConfig(keep: number): OffsiteBackupConfig {
  return {
    s3: {
      endpoint: 'https://storage.yandexcloud.net/',
      region: 'ru-central1',
      bucket: 'mikan-backups',
      accessKeyId: 'test-key-id',
      secretAccessKey: 'test-secret',
    },
    prefix: 'mikan/',
    key: crypto.randomBytes(32),
    keep,
  };
}

function backupFile(name = 'mikan-2026-10-19.db', content = 'SQLite format 3 test'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mikan-offsite-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

describe('off-site upload', () => {
  it('uploads the encrypted copy, signed, path-style, and keeps only the newest copies', async () => {
    const config = offsiteConfig(2);
    const { calls, fetchImpl } = fakeStorage([
      'mikan/mikan-2026-10-16.db.enc',
      'mikan/mikan-2026-10-17.db.enc',
      'mikan/mikan-2026-10-18.db.enc',
      'mikan/mikan-2026-10-19.db.enc',
      'mikan/readme.txt',
    ]);

    const result = await uploadBackupOffsite(config, backupFile(), fetchImpl, Date.parse('2026-10-19T01:00:00Z'));

    expect(result.key).toBe('mikan/mikan-2026-10-19.db.enc');
    expect(result.pruned).toEqual(['mikan/mikan-2026-10-16.db.enc', 'mikan/mikan-2026-10-17.db.enc']);
    const put = calls[0]!;
    expect(put.method).toBe('PUT');
    expect(put.url).toBe('https://storage.yandexcloud.net/mikan-backups/mikan/mikan-2026-10-19.db.enc');
    expect(put.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=test-key-id\/20261019\/ru-central1\/s3\/aws4_request, /);
    expect(put.headers['x-amz-content-sha256']).toBe(sha256Hex(put.body!));
    expect(put.headers['x-amz-date']).toBe('20261019T010000Z');
    expect(decryptBackup(put.body!, config.key).toString()).toBe('SQLite format 3 test');
    expect(result.bytes).toBe(put.body!.length);
    const list = new URL(calls[1]!.url);
    expect(calls[1]!.method).toBe('GET');
    expect(list.pathname).toBe('/mikan-backups');
    expect(list.searchParams.get('list-type')).toBe('2');
    expect(list.searchParams.get('prefix')).toBe('mikan/');
    expect(calls.slice(2).map((c) => [c.method, new URL(c.url).pathname])).toEqual([
      ['DELETE', '/mikan-backups/mikan/mikan-2026-10-16.db.enc'],
      ['DELETE', '/mikan-backups/mikan/mikan-2026-10-17.db.enc'],
    ]);
  });

  it('deletes nothing while there are no more copies than kept', async () => {
    const { calls, fetchImpl } = fakeStorage(['mikan/mikan-2026-10-19.db.enc']);
    const result = await uploadBackupOffsite(offsiteConfig(30), backupFile(), fetchImpl);
    expect(result.pruned).toEqual([]);
    expect(calls.map((c) => c.method)).toEqual(['PUT', 'GET']);
  });

  it('reports the storage error code', async () => {
    const { fetchImpl } = fakeStorage([], { status: 403, body: '<Error><Code>AccessDenied</Code></Error>' });
    const upload = uploadBackupOffsite(offsiteConfig(30), backupFile(), fetchImpl);
    await expect(upload).rejects.toBeInstanceOf(S3Error);
    await expect(upload).rejects.toThrow('HTTP 403 AccessDenied');
  });

  it('reads keys with escaped characters from the listing', async () => {
    const { fetchImpl } = fakeStorage(['mikan/a&amp;b.db.enc']);
    expect(await listKeys(offsiteConfig(1).s3, 'mikan/', fetchImpl)).toEqual(['mikan/a&b.db.enc']);
  });
});

describe('off-site backup settings', () => {
  const full = {
    BACKUP_S3_ENDPOINT: 'https://storage.yandexcloud.net',
    BACKUP_S3_BUCKET: 'mikan-backups',
    BACKUP_S3_ACCESS_KEY_ID: 'id',
    BACKUP_S3_SECRET_ACCESS_KEY: 'secret',
    BACKUP_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
  };

  it('is off when nothing is set', () => {
    const config = testConfig();
    expect(config.offsiteBackup).toBeNull();
    expect(config.offsiteBackupProblem).toBeNull();
  });

  it('is on with all five settings, with defaults for the rest', () => {
    const config = testConfig(full);
    expect(config.offsiteBackupProblem).toBeNull();
    expect(config.offsiteBackup).toMatchObject({
      s3: { endpoint: 'https://storage.yandexcloud.net', region: 'ru-central1', bucket: 'mikan-backups' },
      prefix: 'mikan/',
      keep: 30,
    });
    expect(config.offsiteBackup!.key.length).toBe(32);
  });

  it('names what is missing in a partial setup and never uploads half-configured', () => {
    const { BACKUP_ENCRYPTION_KEY: _key, BACKUP_S3_BUCKET: _bucket, ...partial } = full;
    const config = testConfig(partial);
    expect(config.offsiteBackup).toBeNull();
    expect(config.offsiteBackupProblem).toBe('не заданы BACKUP_S3_BUCKET, BACKUP_ENCRYPTION_KEY');
  });

  it('refuses an encryption key that is not 32 bytes', () => {
    const config = testConfig({ ...full, BACKUP_ENCRYPTION_KEY: Buffer.from('short').toString('base64') });
    expect(config.offsiteBackup).toBeNull();
    expect(config.offsiteBackupProblem).toMatch(/32 байтами/);
  });
});

describe('the off-site backup script', () => {
  it('picks the newest daily backup and ignores other files', () => {
    const dir = path.dirname(backupFile('mikan-2026-10-18.db'));
    fs.writeFileSync(path.join(dir, 'mikan-2026-10-19.db'), 'x');
    fs.writeFileSync(path.join(dir, 'mikan-2026-10-20.db.part'), 'x');
    fs.writeFileSync(path.join(dir, 'pre-delete-1845.db'), 'x');
    expect(newestBackup(dir)).toBe(path.join(dir, 'mikan-2026-10-19.db'));
    expect(newestBackup(path.join(dir, 'missing'))).toBeNull();
  });
});
