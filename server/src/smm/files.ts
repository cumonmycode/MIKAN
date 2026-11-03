/**
 * Файлы СММ (замена imageStore Titan): картинки и видео публикаций и мест съёмки лежат в `data/uploads` под именем
 * `smm-<uuid>.<ext>` и раздаются сервером по `/uploads/smm-…`. В базе и API — относительный путь: приложение
 * делает полный адрес само, Telegram получает файл с диска, Polza и Meta — по публичной ссылке.
 *
 * Нейросеть отдаёт ссылку на 7 дней — результат сразу скачиваем к себе (storeRemote).
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AppContext } from '../context.js';
import { errorMessage } from '../lib/errors.js';
import { SmmError } from './types.js';

/** Больше не скачиваем: видео рилса со звуком — десятки мегабайт. */
export const MAX_REMOTE_BYTES = 100 * 1024 * 1024;
/** Telegram Bot API принимает от бота файлы не больше 50 МБ. */
export const TELEGRAM_FILE_MAX_BYTES = 50 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const FILE_NAME = /^smm-[0-9a-f-]{36}\.[a-z0-9]{1,5}$/;
const EXT = /^[a-z0-9]{1,5}$/;
const MB = 1024 * 1024;

/** Совпадает с `uploadsDir` из app.ts (импорт app.ts отсюда дал бы цикл). */
function uploadsDir(ctx: AppContext): string {
  return path.join(ctx.config.dataDir, 'uploads');
}

function cleanExt(ext: string): string {
  const e = ext.trim().toLowerCase().replace(/^\./, '');
  if (!EXT.test(e)) throw new SmmError('Неподдерживаемый тип файла', 400);
  return e === 'jpeg' ? 'jpg' : e;
}

/** Сохранить файл; вернуть путь `/uploads/smm-<uuid>.<ext>`. */
export async function saveSmmFile(ctx: AppContext, data: Buffer, ext: string): Promise<string> {
  const name = `smm-${randomUUID()}.${cleanExt(ext)}`;
  const dir = uploadsDir(ctx);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), data, { mode: 0o644 });
  return `/uploads/${name}`;
}

/** Тело ответа, не больше `maxBytes` (обрывается сразу, как только больше). */
async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
  const tooBig = () => new SmmError(`Файл больше ${Math.round(maxBytes / MB)} МБ — такой не сохраняем`, 502);
  if (Number(res.headers.get('content-length')) > maxBytes) throw tooBig();
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooBig();
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

/** Скачать файл по ссылке (результат нейросети, фото архива) и сохранить у себя; вернуть путь `/uploads/smm-…`. */
export async function storeRemote(ctx: AppContext, url: string, ext: string, maxBytes = MAX_REMOTE_BYTES): Promise<string> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new SmmError('Неверная ссылка на файл', 502);
  }
  if (target.protocol !== 'https:') throw new SmmError('Файл можно скачать только по https', 502);
  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  let data: Buffer;
  try {
    const res = await (ctx.smmFetch ?? fetch)(target.href, { signal });
    if (!res.ok) throw new SmmError(`Файл не скачался (${res.status})`, 502);
    data = await readCapped(res, maxBytes);
  } catch (error) {
    if (error instanceof SmmError) throw error;
    ctx.log.warn({ err: errorMessage(error), host: target.host }, 'smm: file download failed');
    throw new SmmError(signal.aborted ? 'Файл скачивается слишком долго — попробуйте ещё раз' : 'Файл не скачался', 502);
  }
  if (!data.length) throw new SmmError('Файл не скачался: пустой ответ', 502);
  return saveSmmFile(ctx, data, ext);
}

/** Имя файла СММ из пути `/uploads/smm-…` (или полной ссылки на наш сервер); иначе null. */
export function smmFileName(ctx: AppContext, value: string): string | null {
  const base = ctx.config.publicUrl?.replace(/\/+$/, '');
  const rel = base && value.startsWith(`${base}/`) ? value.slice(base.length) : value;
  const match = /^\/uploads\/([^/?#]+)$/.exec(rel);
  const name = match?.[1];
  return name && FILE_NAME.test(name) ? name : null;
}

/** Файл на диске для пути `/uploads/smm-…` (Telegram шлёт его оттуда); чужая ссылка или не наш файл — null. */
export function smmFilePath(ctx: AppContext, value: string): string | null {
  const name = smmFileName(ctx, value);
  if (!name) return null;
  const dir = path.resolve(uploadsDir(ctx));
  const file = path.resolve(dir, name);
  return path.dirname(file) === dir ? file : null;
}

/**
 * Полная ссылка: `PUBLIC_URL` + путь (референсы для Polza). Полные ссылки — как есть. Без `PUBLIC_URL` путь
 * остаётся относительным — снаружи его не открыть.
 */
export function absoluteUrl(ctx: AppContext, value: string): string {
  if (/^https?:\/\//i.test(value)) return value;
  const base = ctx.config.publicUrl?.replace(/\/+$/, '');
  if (!base) return value;
  return `${base}${value.startsWith('/') ? '' : '/'}${value}`;
}

/** Удалить наш файл (чужие ссылки и пропавшие файлы — без ошибки). */
export async function removeSmmFile(ctx: AppContext, value: string | null | undefined): Promise<void> {
  const file = value ? smmFilePath(ctx, value) : null;
  if (!file) return;
  await fs.rm(file, { force: true }).catch((error: unknown) => {
    ctx.log.warn({ err: errorMessage(error), file: path.basename(file) }, 'smm: file removal failed');
  });
}
