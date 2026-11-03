/**
 * A minimal POSIX ustar archive (the off-site photo backups, deploy/README.md «Бэкапы вне сервера»): regular files
 * only, written as a stream of 512-byte blocks that any `tar -xf` reads, and a reader to check it. No dependencies.
 *
 * Header (512 bytes): name 100 · mode 8 · uid 8 · gid 8 · size 12 · mtime 12 · checksum 8 · type 1 · linkname 100 ·
 * magic "ustar\0" · version "00" · uname 32 · gname 32 · devmajor 8 · devminor 8 · prefix 155 · padding 12.
 * Numbers are octal text; a path longer than 100 bytes is split at a «/» into prefix (≤ 155) and name (≤ 100).
 */

export const TAR_BLOCK = 512;
const NAME_MAX = 100;
const PREFIX_MAX = 155;
/** 11 octal digits: the largest size an ustar header holds (8 GiB − 1). */
const SIZE_MAX = 8 ** 11 - 1;
const DEFAULT_MODE = 0o644;

export interface TarEntry {
  /** Path inside the archive, «/»-separated, without a leading «/». */
  name: string;
  data: Buffer;
  /** Milliseconds; stored in whole seconds. */
  mtime: number;
  mode?: number;
}

/** `{ prefix, name }` of a path as ustar stores it, or null when it does not fit. */
function splitPath(path: string): { prefix: string; name: string } | null {
  const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
  if (bytes(path) <= NAME_MAX) return { prefix: '', name: path };
  for (let i = path.indexOf('/'); i !== -1; i = path.indexOf('/', i + 1)) {
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (bytes(prefix) <= PREFIX_MAX && bytes(name) <= NAME_MAX && name.length > 0) return { prefix, name };
  }
  return null;
}

/** Whether the path can be stored in an ustar header. */
export const ustarFits = (path: string): boolean => path.length > 0 && splitPath(path) !== null;

/** `digits` octal digits and a NUL. */
const octal = (value: number, digits: number): string => `${value.toString(8).padStart(digits, '0')}\0`;

/** The 512-byte header of a regular file. Throws when the path or the size does not fit. */
export function ustarHeader(path: string, size: number, mtimeMs: number, mode = DEFAULT_MODE): Buffer {
  const parts = path.length > 0 ? splitPath(path) : null;
  if (!parts) throw new Error(`Имя не помещается в архив tar: ${path}`);
  if (size > SIZE_MAX) throw new Error(`Файл слишком большой для архива tar: ${path}`);
  const header = Buffer.alloc(TAR_BLOCK);
  const put = (offset: number, length: number, text: string) => header.write(text, offset, length, 'utf8');
  put(0, NAME_MAX, parts.name);
  put(100, 8, octal(mode & 0o7777, 7));
  put(108, 8, octal(0, 7));
  put(116, 8, octal(0, 7));
  put(124, 12, octal(size, 11));
  put(136, 12, octal(Math.max(0, Math.floor(mtimeMs / 1000)), 11));
  put(156, 1, '0');
  put(257, 6, 'ustar\0');
  put(263, 2, '00');
  put(345, PREFIX_MAX, parts.prefix);
  // The checksum counts its own field as eight spaces: six octal digits, NUL, space.
  put(148, 8, ' '.repeat(8));
  put(148, 8, `${checksumOf(header).toString(8).padStart(6, '0')}\0 `);
  return header;
}

const checksumOf = (header: Buffer): number => header.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0);

/** Zero bytes up to the next block boundary after `size` bytes of data. */
export const tarPadding = (size: number): Buffer => Buffer.alloc((TAR_BLOCK - (size % TAR_BLOCK)) % TAR_BLOCK);

/** The archive as a stream of chunks: per entry its header, data and padding, then two zero blocks. */
export async function* tarChunks(entries: Iterable<TarEntry> | AsyncIterable<TarEntry>): AsyncGenerator<Buffer> {
  for await (const entry of entries) {
    yield ustarHeader(entry.name, entry.data.length, entry.mtime, entry.mode);
    if (entry.data.length > 0) yield entry.data;
    const padding = tarPadding(entry.data.length);
    if (padding.length > 0) yield padding;
  }
  yield Buffer.alloc(TAR_BLOCK * 2);
}

const text = (block: Buffer, offset: number, length: number): string => {
  const field = block.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? length : end).toString('utf8');
};
const number = (block: Buffer, offset: number, length: number): number => parseInt(text(block, offset, length).trim() || '0', 8);

/** Reads an archive written by `tarChunks` (regular files). Throws on a damaged header. */
export function readTar(archive: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  while (offset + TAR_BLOCK <= archive.length) {
    const header = archive.subarray(offset, offset + TAR_BLOCK);
    if (header.every((byte) => byte === 0)) break;
    if (number(header, 148, 8) !== checksumOf(header)) throw new Error(`Повреждённый архив tar: заголовок на ${offset}`);
    const size = number(header, 124, 12);
    const prefix = text(header, 345, PREFIX_MAX);
    const name = text(header, 0, NAME_MAX);
    const start = offset + TAR_BLOCK;
    if (start + size > archive.length) throw new Error(`Повреждённый архив tar: файл ${name} обрезан`);
    entries.push({
      name: prefix ? `${prefix}/${name}` : name,
      data: Buffer.from(archive.subarray(start, start + size)),
      mtime: number(header, 136, 12) * 1000,
      mode: number(header, 100, 8),
    });
    offset = start + size + tarPadding(size).length;
  }
  return entries;
}
