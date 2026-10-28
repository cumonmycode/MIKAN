import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readTar, tarChunks, ustarFits, ustarHeader, type TarEntry } from '../src/lib/tar.js';

/** The POSIX ustar archive of the off-site photo backups (deploy/README.md «Бэкапы вне сервера»). */

const MTIME = Date.parse('2026-10-19T01:02:03Z');

async function archiveOf(entries: TarEntry[]): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of tarChunks(entries)) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const ENTRIES: TarEntry[] = [
  { name: 'uploads/a.jpg', data: Buffer.from('JPEG data'), mtime: MTIME },
  { name: 'uploads/empty.png', data: Buffer.alloc(0), mtime: MTIME },
  { name: 'uploads/block.webp', data: Buffer.alloc(512, 7), mtime: MTIME },
  { name: 'uploads/odd.heic', data: Buffer.alloc(513, 9), mtime: MTIME + 5_000 },
  { name: 'uploads/портфолио/фото.jpg', data: Buffer.from('кириллица'), mtime: MTIME },
  { name: `uploads/${'d'.repeat(120)}/${'f'.repeat(90)}.jpg`, data: Buffer.from('long'), mtime: MTIME },
];

describe('ustar archive', () => {
  it('round-trips names, contents, times and modes; blocks are 512 bytes and the end is two zero blocks', async () => {
    const archive = await archiveOf(ENTRIES);
    expect(archive.length % 512).toBe(0);
    expect(archive.subarray(-1024).equals(Buffer.alloc(1024))).toBe(true);
    expect(archive.subarray(257, 263).toString('latin1')).toBe('ustar\0');
    const read = readTar(archive);
    expect(read.map((e) => e.name)).toEqual(ENTRIES.map((e) => e.name));
    read.forEach((entry, i) => {
      expect(entry.data.equals(ENTRIES[i]!.data)).toBe(true);
      expect(entry.mtime).toBe(Math.floor(ENTRIES[i]!.mtime / 1000) * 1000);
      expect(entry.mode).toBe(0o644);
    });
  });

  it('splits a long path into prefix and name, and refuses what ustar cannot hold', () => {
    expect(ustarFits('uploads/a.jpg')).toBe(true);
    expect(ustarFits(`uploads/${'d'.repeat(120)}/${'f'.repeat(90)}.jpg`)).toBe(true);
    expect(ustarFits('x'.repeat(101))).toBe(false); // no «/» to split at
    expect(ustarFits(`${'d'.repeat(160)}/a.jpg`)).toBe(false); // the prefix is over 155 bytes
    expect(ustarFits(`uploads/${'ф'.repeat(60)}`)).toBe(false); // 128 bytes in UTF-8
    expect(() => ustarHeader('x'.repeat(101), 1, MTIME)).toThrow();
  });

  it('a damaged header is noticed', async () => {
    const archive = await archiveOf(ENTRIES.slice(0, 1));
    const damaged = Buffer.from(archive);
    damaged[0] = damaged[0]! ^ 1;
    expect(() => readTar(damaged)).toThrow('Повреждённый архив');
  });

  const tar = spawnSync('tar', ['--version'], { encoding: 'utf8' });
  it.skipIf(tar.status !== 0)('is read by the system tar', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mikan-tar-'));
    const file = path.join(dir, 'uploads.tar');
    fs.writeFileSync(file, await archiveOf(ENTRIES));
    const listed = spawnSync('tar', ['-tf', file], { encoding: 'utf8' });
    expect(listed.status).toBe(0);
    // Names are checked by extracting (a listing may escape non-ASCII names, depending on the locale).
    expect(listed.stdout.trim().split('\n')).toHaveLength(ENTRIES.length);
    const out = path.join(dir, 'out');
    fs.mkdirSync(out);
    expect(spawnSync('tar', ['-xf', file, '-C', out]).status).toBe(0);
    for (const entry of ENTRIES) expect(fs.readFileSync(path.join(out, entry.name)).equals(entry.data)).toBe(true);
  });
});
