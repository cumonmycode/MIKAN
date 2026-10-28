/**
 * Фотоархив профиля — публичная папка Google Диска («у кого есть ссылка — читатель»). У студии и у автора архив свой.
 *
 * Архив не скачивается. Маркетолог обходит папку по названиям (альбомы и файлы), у каждого фото хранит описание и
 * ссылку, а при работе ищет нужное по описаниям и берёт только найденное: превью для выбора, кадрированное фото — в
 * публикацию. Google сам отдаёт кадр под формат (4:5, 9:16) по ссылке, без сервера картинок у нас.
 *
 * Описания первого архива сделаны заранее; новые фото маркетолог описывает сам по превью дешёвой моделью, понемногу в
 * день. Настоящие работы (тату, проколы, украшения на людях) берутся только отсюда или из своих загрузок — нейросеть
 * их не рисует. У студии к архиву добавляются фото работ из каталога услуг (services.photos_json).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { and, asc, desc, eq, gt, inArray, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { Db } from '../db/client.js';
import { services } from '../db/schema.js';
import { smmLibrary, smmLibraryFolders } from '../db/schema-smm.js';
import { deleteKey, readKey, writeKey } from '../domain/settings.js';
import { errorMessage } from '../lib/errors.js';
import { parsePhotos } from '../lib/serialize.js';
import { chatJson, type ChatPart } from './ai.js';
import { directionsOf } from './prompts.js';
import { getSmmSettings } from './settings.js';
import { PROFILES, SmmError, step, type SmmFormat, type SmmProfile, type SmmProgress } from './types.js';

const stateKey = (profile: SmmProfile) => `smm_library:${profile}`;
const MAX_DEPTH = 8;
const MAX_FOLDERS = 400;
const LIST_TIMEOUT_MS = 20_000;
const LIST_RETRY_MS = 1500;
const THUMB_TIMEOUT_MS = 20_000;
const PHOTO_MIME = /^image\/(jpeg|png|heic|heif|webp)$/;
const VIDEO_MIME = /^video\/(mp4|quicktime)$/;
/** Сколько новых фото маркетолог описывает за один заход и пачкой в одном запросе. */
const DESCRIBE_PER_RUN = 60;
const DESCRIBE_BATCH = 6;
/** Сколько строк архива поиск отбирает по словам до ранжирования. */
const SEARCH_CANDIDATES = 2000;
/** Пачка строк в одной вставке (SQLite ограничивает число параметров запроса). */
const INSERT_CHUNK = 200;
/** Фото работ из каталога услуг студии — сверх найденного в архиве. */
const CATALOG_LIMIT = 4;
const CATALOG_PER_SERVICE = 2;
const CATALOG_PREFIX = 'catalog:';

export type LibraryKind = 'photo' | 'video' | 'template' | 'logo' | 'design';

export interface LibraryState {
  folderId: string;
  url: string;
  title: string;
  connectedAt: string;
  syncedAt: string | null;
  error: string | null;
  progress: SmmProgress | null;
}

export interface LibraryPhoto {
  /** id файла Диска; у фото из каталога услуг студии — `catalog:<файл>`. */
  id: string;
  /** drive — фотоархив профиля; catalog — настоящая работа студии из каталога услуг. */
  source: 'drive' | 'catalog';
  path: string;
  name: string;
  kind: LibraryKind;
  description: string;
  tags: string;
  people: number | null;
  quality: number | null;
  orientation: string | null;
  usedCount: number;
  thumb: string;
  /** Наш файл (`/uploads/…`) — у фото из каталога; у архива — null (ссылки Google). */
  url: string | null;
}

export interface LibraryAlbum {
  id: string;
  path: string;
  title: string;
  kind: string;
  about: string;
  files: number;
  described: number;
  cover: string | null;
}

// ─── Ссылки Google ───────────────────────────────────────────────────────────

/** Превью файла Диска: длинная сторона `size` пикселей (JPEG, в том числе из HEIC). */
export const photoUrl = (id: string, size = 1600): string => `https://lh3.googleusercontent.com/d/${id}=s${size}`;

/** Кадр под формат публикации: Google режет «умно» по центру интереса. */
export function cropUrl(id: string, aspect: '4:5' | '9:16'): string {
  return `https://lh3.googleusercontent.com/d/${id}=${aspect === '9:16' ? 'w1080-h1920' : 'w1080-h1350'}-p`;
}

/** id папки из ссылки «drive.google.com/drive/folders/<id>?usp=…» (или сам id). */
export function folderIdFrom(input: string): string | null {
  const raw = input.trim();
  const m = /folders\/([\w-]{10,})/.exec(raw) ?? /[?&]id=([\w-]{10,})/.exec(raw) ?? /^([\w-]{20,})$/.exec(raw);
  return m?.[1] ?? null;
}

const fetchOf = (ctx: AppContext): typeof fetch => ctx.smmFetch ?? fetch;

// ─── Состояние ───────────────────────────────────────────────────────────────

export async function libraryState(ctx: AppContext, profile: SmmProfile): Promise<LibraryState | null> {
  const raw = readKey<LibraryState>(ctx.db, stateKey(profile));
  return raw?.folderId ? raw : null;
}

function saveState(ctx: AppContext, profile: SmmProfile, state: LibraryState | null): void {
  if (state) writeKey(ctx.db, stateKey(profile), state);
  else deleteKey(ctx.db, stateKey(profile));
}

async function patchState(ctx: AppContext, profile: SmmProfile, patch: Partial<LibraryState>): Promise<void> {
  const state = await libraryState(ctx, profile);
  if (state) saveState(ctx, profile, { ...state, ...patch });
}

// ─── Обход папки ─────────────────────────────────────────────────────────────

interface DriveEntry {
  id: string;
  folder: boolean;
  title: string;
  mime: string;
}

const decode = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Содержимое публичной папки (страница встраивания Диска отдаёт все файлы без ключа). */
async function listFolder(ctx: AppContext, id: string): Promise<{ title: string; entries: DriveEntry[] } | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetchOf(ctx)(`https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(id)}`, {
        signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
      });
      if (res.status === 404) return null;
      if (res.ok) {
        const html = await res.text();
        const entries = html
          .split('class="flip-entry" id="entry-')
          .slice(1)
          .map((b) => ({
            id: b.slice(0, b.indexOf('"')),
            folder: /drive\/folders\//.test(b),
            title: decode(/flip-entry-title">([^<]*)/.exec(b)?.[1] ?? ''),
            mime: /type\/([^"]+)"/.exec(b)?.[1] ?? '',
          }));
        return { title: decode(/<title>([^<]*)/.exec(html)?.[1] ?? ''), entries };
      }
    } catch {
      // сеть — пробуем ещё
    }
    await sleep(LIST_RETRY_MS);
  }
  throw new SmmError('Google Диск не ответил — попробуйте позже', 502);
}

const kindOf = (mime: string): LibraryKind | null =>
  PHOTO_MIME.test(mime) ? 'photo' : VIDEO_MIME.test(mime) ? 'video' : null;

const syncing = new WeakMap<Db, Set<SmmProfile>>();

function upsertFolder(ctx: AppContext, profile: SmmProfile, f: { id: string; parent: string | null; path: string; title: string; files: number }): void {
  const now = Date.now();
  ctx.db
    .insert(smmLibraryFolders)
    .values({ profile, driveId: f.id, parentId: f.parent, path: f.path, title: f.title, files: f.files, seenAt: now })
    .onConflictDoUpdate({
      target: [smmLibraryFolders.profile, smmLibraryFolders.driveId],
      set: { parentId: f.parent, path: f.path, title: f.title, files: f.files, seenAt: now },
    })
    .run();
}

/** Файлы альбома: новые — добавить; известные — обновить место и имя, описание и «вид» (шаблон, логотип) не трогать. */
function upsertFiles(ctx: AppContext, profile: SmmProfile, folderId: string, folderPath: string, files: DriveEntry[]): void {
  const now = Date.now();
  for (let i = 0; i < files.length; i += INSERT_CHUNK) {
    const values = files.slice(i, i + INSERT_CHUNK).map((e) => ({
      profile,
      driveId: e.id,
      folderId,
      path: folderPath,
      name: e.title,
      mime: e.mime,
      kind: kindOf(e.mime) ?? 'photo',
      seenAt: now,
      createdAt: now,
    }));
    ctx.db
      .insert(smmLibrary)
      .values(values)
      .onConflictDoUpdate({
        target: [smmLibrary.profile, smmLibrary.driveId],
        set: {
          folderId: sql`excluded.folder_id`,
          path: sql`excluded.path`,
          name: sql`excluded.name`,
          mime: sql`excluded.mime`,
          seenAt: sql`excluded.seen_at`,
        },
      })
      .run();
  }
}

/**
 * Обойти архив профиля по названиям и обновить список альбомов и файлов. Описания и отметки «использовано» у
 * известных фото сохраняются; пропавшие с Диска — убираются, только если обход прошёл целиком.
 */
export async function syncLibrary(ctx: AppContext, profile: SmmProfile): Promise<void> {
  const state = await libraryState(ctx, profile);
  const running = syncing.get(ctx.db) ?? new Set<SmmProfile>();
  if (!state || running.has(profile)) return;
  running.add(profile);
  syncing.set(ctx.db, running);
  const started = Date.now();
  let folders = 0;
  let complete = true;
  try {
    await patchState(ctx, profile, { progress: step('Смотрю альбомы архива', 2, 95, 90), error: null });
    const queue: { id: string; parent: string | null; path: string; depth: number }[] = [
      { id: state.folderId, parent: null, path: '', depth: 0 },
    ];
    while (queue.length && folders < MAX_FOLDERS) {
      const item = queue.shift()!;
      const listed = await listFolder(ctx, item.id).catch(() => null);
      if (!listed) {
        complete = false;
        continue;
      }
      folders += 1;
      const own = listed.entries.filter((e) => !e.folder && kindOf(e.mime));
      const title = item.depth === 0 ? listed.title : (item.path.split(' / ').pop() ?? '');
      upsertFolder(ctx, profile, { id: item.id, parent: item.parent, path: item.path, title, files: own.length });
      if (own.length) upsertFiles(ctx, profile, item.id, item.path, own);
      if (item.depth < MAX_DEPTH) {
        for (const sub of listed.entries.filter((e) => e.folder)) {
          const subPath = item.path ? `${item.path} / ${sub.title}` : sub.title;
          queue.push({ id: sub.id, parent: item.id, path: subPath, depth: item.depth + 1 });
        }
      }
      if (folders % 5 === 0) {
        await patchState(ctx, profile, { progress: step(`Смотрю альбомы архива: ${folders}`, Math.min(90, 2 + folders), 95, 60) });
      }
    }
    if (complete && folders < MAX_FOLDERS) {
      ctx.db.delete(smmLibrary).where(and(eq(smmLibrary.profile, profile), lt(smmLibrary.seenAt, started))).run();
      ctx.db
        .delete(smmLibraryFolders)
        .where(and(eq(smmLibraryFolders.profile, profile), lt(smmLibraryFolders.seenAt, started)))
        .run();
    }
    await patchState(ctx, profile, {
      syncedAt: new Date().toISOString(),
      progress: null,
      error: complete ? null : 'Часть альбомов не открылась — проверю завтра ещё раз',
    });
  } catch (error) {
    await patchState(ctx, profile, { progress: null, error: error instanceof Error ? error.message.slice(0, 200) : 'Архив не обновился' });
  } finally {
    running.delete(profile);
  }
}

/** Подключить архив по ссылке: папка должна открываться всем, у кого есть ссылка. */
export async function connectLibrary(ctx: AppContext, profile: SmmProfile, link: string): Promise<LibraryState> {
  const folderId = folderIdFrom(link);
  if (!folderId) {
    throw new SmmError('Это не ссылка на папку Google Диска — скопируйте её через «Поделиться» → «Копировать ссылку»', 400);
  }
  const listed = await listFolder(ctx, folderId);
  if (!listed || (!listed.entries.length && !listed.title)) {
    throw new SmmError(
      'Папка не открылась. В Google Диске: «Поделиться» → «Все, у кого есть ссылка» → «Читатель», затем вставьте ссылку ещё раз',
      400,
    );
  }
  const state: LibraryState = {
    folderId,
    url: `https://drive.google.com/drive/folders/${folderId}`,
    title: listed.title || 'Фотоархив',
    connectedAt: new Date().toISOString(),
    syncedAt: null,
    error: null,
    progress: step('Смотрю альбомы архива', 2, 95, 90),
  };
  saveState(ctx, profile, state);
  void syncLibrary(ctx, profile).catch((error) => ctx.log.error({ err: errorMessage(error), profile }, 'smm library: sync failed'));
  return state;
}

/** Отключить: маркетолог перестаёт брать фото из архива. Описания остаются — вернётся без повторной работы. */
export async function disconnectLibrary(ctx: AppContext, profile: SmmProfile): Promise<void> {
  saveState(ctx, profile, null);
}

// ─── Поиск и выдача ──────────────────────────────────────────────────────────

type LibraryRow = typeof smmLibrary.$inferSelect;

const mapPhoto = (r: LibraryRow): LibraryPhoto => ({
  id: r.driveId,
  source: 'drive',
  path: r.path,
  name: r.name,
  kind: (r.kind as LibraryKind) ?? 'photo',
  description: r.description,
  tags: r.tags,
  people: r.people,
  quality: r.quality,
  orientation: r.orientation,
  usedCount: r.usedCount,
  thumb: photoUrl(r.driveId, 400),
  url: null,
});

const normalize = (text: string) => text.toLowerCase().replace(/ё/g, 'е');

/** Окончания для грубого стемминга по-русски: «татуировки» и «татуировка» ищутся одинаково. */
const ENDINGS = [
  'иями', 'ями', 'ами', 'ость', 'ости', 'ией', 'иях', 'ого', 'его', 'ому', 'ему', 'ыми', 'ими', 'ая', 'яя', 'ое',
  'ее', 'ые', 'ие', 'ый', 'ий', 'ой', 'ом', 'ем', 'ам', 'ям', 'ах', 'ях', 'ов', 'ев', 'ей', 'ую', 'юю', 'ия', 'ья',
  'а', 'я', 'о', 'е', 'ы', 'и', 'у', 'ю', 'ь', 'й',
].sort((a, b) => b.length - a.length);
const MIN_STEM = 3;

function stem(word: string): string {
  if (!/[а-я]/.test(word)) return word;
  const end = ENDINGS.find((e) => word.endsWith(e) && word.length - e.length >= MIN_STEM);
  return end ? word.slice(0, -end.length) : word;
}

/** Основы слов запроса (3+ буквы, без повторов) — замена полнотекстового поиска Postgres. */
function queryStems(text: string): string[] {
  const words = normalize(text).match(/[a-zа-я0-9]{3,}/g) ?? [];
  return [...new Set(words.map(stem))].slice(0, 40);
}

/**
 * LIKE в SQLite не различает регистр только у латиницы: ищем основу и с маленькой, и с большой буквы (начало фразы,
 * название альбома), а точное совпадение и ранжирование — в JS.
 */
function likeAny(stems: string[]): SQL | undefined {
  const haystack = sql`(${smmLibrary.path} || ' ' || ${smmLibrary.description} || ' ' || ${smmLibrary.tags})`;
  const variants = stems.flatMap((s) => (/[а-я]/.test(s) ? [s, s[0]!.toUpperCase() + s.slice(1)] : [s]));
  return or(...variants.map((v) => sql`${haystack} LIKE ${`%${v}%`}`));
}

/** Совпадение строки архива с запросом: сколько основ нашлось (повторы — слабее), как ts_rank. */
function matchRank(r: LibraryRow, stems: string[]): number {
  const hay = normalize(`${r.path} ${r.description} ${r.tags}`);
  let rank = 0;
  for (const s of stems) {
    const hits = hay.split(s).length - 1;
    if (hits > 0) rank += 1 + 0.2 * (Math.min(hits, 3) - 1);
  }
  return rank;
}

export interface SearchOpts {
  limit?: number;
  kinds?: LibraryKind[];
  perAlbum?: number;
  minQuality?: number;
}

/**
 * Найти фото профиля по смыслу: по описанию, тегам и названию альбома. Сначала лучшие по совпадению и качеству, реже
 * использованные; не больше `perAlbum` из одного альбома.
 */
export async function searchLibrary(ctx: AppContext, profile: SmmProfile, text: string, opts: SearchOpts = {}): Promise<LibraryPhoto[]> {
  const limit = opts.limit ?? 18;
  const kinds = opts.kinds ?? ['photo'];
  const stems = queryStems(text);
  if (!stems.length) return [];
  let found: LibraryRow[] = [];
  try {
    found = ctx.db
      .select()
      .from(smmLibrary)
      .where(
        and(
          eq(smmLibrary.profile, profile),
          inArray(smmLibrary.kind, kinds),
          ne(smmLibrary.description, ''),
          sql`coalesce(${smmLibrary.quality}, 3) >= ${opts.minQuality ?? 3}`,
          likeAny(stems),
        ),
      )
      .limit(SEARCH_CANDIDATES)
      .all();
  } catch (error) {
    ctx.log.warn({ err: errorMessage(error), profile }, 'smm library: search failed');
    return [];
  }
  const ranked = found
    .map((r) => ({ r, rank: matchRank(r, stems) }))
    .filter((x) => x.rank > 0)
    .map((x) => ({ r: x.r, score: (x.rank * (1 + (x.r.quality ?? 3) * 0.15)) / (1 + x.r.usedCount * 0.5) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit * 6);
  const perAlbum = opts.perAlbum ?? 3;
  const byAlbum = new Map<string, number>();
  // Серии почти одинаковых кадров описаны одинаково — маркетологу показываем по одному из серии.
  const seen = new Set<string>();
  const out: LibraryPhoto[] = [];
  for (const { r } of ranked) {
    const album = r.folderId ?? '';
    const key = `${album}|${r.description}`;
    if ((byAlbum.get(album) ?? 0) >= perAlbum || seen.has(key)) continue;
    seen.add(key);
    byAlbum.set(album, (byAlbum.get(album) ?? 0) + 1);
    out.push(mapPhoto(r));
    if (out.length >= limit) break;
  }
  return out;
}

// ─── Каталог услуг студии ────────────────────────────────────────────────────

interface CatalogService {
  id: number;
  name: string;
  category: string;
  groupName: string | null;
  description: string | null;
  photos: string[];
}

/** Фото работ из каталога услуг (только студия): HEIC Telegram не покажет — их не берём. */
function catalogServices(ctx: AppContext): CatalogService[] {
  return ctx.db
    .select({
      id: services.id,
      name: services.name,
      category: services.category,
      groupName: services.groupName,
      description: services.description,
      photosJson: services.photosJson,
    })
    .from(services)
    .where(eq(services.active, true))
    .all()
    .map((s) => ({ ...s, photos: parsePhotos(s.photosJson).filter((p) => p.startsWith('/uploads/') && !/\.hei[cf]$/i.test(p)) }))
    .filter((s) => s.photos.length > 0);
}

function catalogPhoto(s: CatalogService, url: string): LibraryPhoto {
  const about = s.description?.replace(/\s+/g, ' ').trim().slice(0, 160);
  return {
    id: `${CATALOG_PREFIX}${path.basename(url)}`,
    source: 'catalog',
    path: ['Каталог услуг', s.groupName, s.name].filter(Boolean).join(' / '),
    name: path.basename(url),
    kind: 'photo',
    description: `Настоящая работа студии: ${s.name}${about ? ` (${about})` : ''}`,
    tags: s.category,
    people: null,
    quality: null,
    orientation: null,
    usedCount: 0,
    thumb: url,
    url,
  };
}

/** Работы из каталога по словам публикации: услуги с наибольшим совпадением, не больше двух фото с услуги. */
function catalogCandidates(ctx: AppContext, text: string, limit: number): LibraryPhoto[] {
  const stems = queryStems(text);
  if (!stems.length) return [];
  const scored = catalogServices(ctx)
    .map((s) => {
      const hay = normalize([s.name, s.category, s.groupName ?? '', s.description ?? ''].join(' '));
      return { s, score: stems.filter((st) => hay.includes(st)).length };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  const out: LibraryPhoto[] = [];
  for (const { s } of scored) {
    for (const url of s.photos.slice(0, CATALOG_PER_SERVICE)) {
      if (out.length >= limit) return out;
      out.push(catalogPhoto(s, url));
    }
  }
  return out;
}

const isCatalogId = (id: string) => id.startsWith(CATALOG_PREFIX);

/** Фото архива по id (для выбора маркетолога и добавления вручную); у студии — и работы из каталога. */
export async function libraryPhotos(ctx: AppContext, profile: SmmProfile, ids: string[]): Promise<LibraryPhoto[]> {
  if (!ids.length) return [];
  const driveIds = ids.filter((id) => !isCatalogId(id));
  const drive = driveIds.length
    ? ctx.db
        .select()
        .from(smmLibrary)
        .where(and(eq(smmLibrary.profile, profile), inArray(smmLibrary.driveId, driveIds)))
        .all()
        .map(mapPhoto)
    : [];
  const wanted = new Set(ids.filter(isCatalogId).map((id) => id.slice(CATALOG_PREFIX.length)));
  if (profile !== 'studio' || !wanted.size) return drive;
  const catalog = catalogServices(ctx).flatMap((s) =>
    s.photos.filter((url) => wanted.has(path.basename(url))).map((url) => catalogPhoto(s, url)),
  );
  return [...drive, ...catalog];
}

/** Файл фото из каталога на диске — чтобы положить копию в публикацию. */
export async function readCatalogPhoto(ctx: AppContext, photo: LibraryPhoto): Promise<{ data: Buffer; ext: string }> {
  if (photo.source !== 'catalog' || !photo.url) throw new SmmError('Это не фото из каталога', 400);
  const name = path.basename(photo.url);
  try {
    const data = await fs.readFile(path.join(ctx.config.dataDir, 'uploads', name));
    return { data, ext: path.extname(name).slice(1).toLowerCase() || 'jpg' };
  } catch {
    throw new SmmError('Фото из каталога не нашлось на сервере', 404);
  }
}

/** Несколько файлов вида (шаблоны сторис, логотипы) — опора для фирменного стиля. */
export async function libraryOfKind(ctx: AppContext, profile: SmmProfile, kind: LibraryKind, limit: number): Promise<LibraryPhoto[]> {
  if (!(await libraryState(ctx, profile))) return [];
  return ctx.db
    .select()
    .from(smmLibrary)
    .where(and(eq(smmLibrary.profile, profile), eq(smmLibrary.kind, kind)))
    .orderBy(desc(sql`coalesce(${smmLibrary.quality}, 3)`), sql`random()`)
    .limit(limit)
    .all()
    .map(mapPhoto);
}

export async function markUsed(ctx: AppContext, profile: SmmProfile, ids: string[]): Promise<void> {
  const driveIds = ids.filter((id) => !isCatalogId(id));
  if (!driveIds.length) return;
  ctx.db
    .update(smmLibrary)
    .set({ usedCount: sql`${smmLibrary.usedCount} + 1`, lastUsedAt: Date.now() })
    .where(and(eq(smmLibrary.profile, profile), inArray(smmLibrary.driveId, driveIds)))
    .run();
}

export async function libraryAlbums(ctx: AppContext, profile: SmmProfile): Promise<LibraryAlbum[]> {
  const f = smmLibraryFolders;
  return ctx.db
    .select({
      driveId: f.driveId,
      path: f.path,
      title: f.title,
      kind: f.kind,
      about: f.about,
      files: f.files,
      // Имена внешней таблицы — явно: drizzle пишет колонки без таблицы, и подзапрос взял бы свои.
      described: sql<number>`(SELECT count(*) FROM smm_library l
        WHERE l.profile = smm_library_folders.profile AND l.folder_id = smm_library_folders.drive_id
          AND l.description <> '')`,
      cover: sql<string | null>`(SELECT l.drive_id FROM smm_library l
        WHERE l.profile = smm_library_folders.profile AND l.folder_id = smm_library_folders.drive_id
          AND l.kind <> 'video'
        ORDER BY coalesce(l.quality, 0) DESC, l.name LIMIT 1)`,
    })
    .from(f)
    .where(and(eq(f.profile, profile), gt(f.files, 0)))
    .orderBy(asc(f.path))
    .all()
    .map((r) => ({
      id: r.driveId,
      path: r.path,
      title: r.title,
      kind: r.kind,
      about: r.about,
      files: r.files,
      described: Number(r.described ?? 0),
      cover: r.cover ? photoUrl(r.cover, 400) : null,
    }));
}

export async function albumPhotos(ctx: AppContext, profile: SmmProfile, folderId: string): Promise<LibraryPhoto[]> {
  return ctx.db
    .select()
    .from(smmLibrary)
    .where(and(eq(smmLibrary.profile, profile), eq(smmLibrary.folderId, folderId)))
    .orderBy(asc(smmLibrary.name))
    .limit(2000)
    .all()
    .map(mapPhoto);
}

export async function libraryCounts(ctx: AppContext, profile: SmmProfile): Promise<{ albums: number; files: number; described: number }> {
  const albums = ctx.db
    .select({ n: sql<number>`count(*)` })
    .from(smmLibraryFolders)
    .where(and(eq(smmLibraryFolders.profile, profile), gt(smmLibraryFolders.files, 0)))
    .get();
  const files = ctx.db
    .select({
      n: sql<number>`count(*)`,
      described: sql<number>`coalesce(sum(CASE WHEN ${smmLibrary.description} <> '' THEN 1 ELSE 0 END), 0)`,
    })
    .from(smmLibrary)
    .where(eq(smmLibrary.profile, profile))
    .get();
  return { albums: Number(albums?.n ?? 0), files: Number(files?.n ?? 0), described: Number(files?.described ?? 0) };
}

/** Строка для промпта: найденные настоящие фото под кодами Ф1, Ф2… */
export function archiveLine(photos: LibraryPhoto[]): string {
  if (!photos.length) return '';
  return [
    'Фотоархив — настоящие фото (код: альбом — что на фото). Настоящие работы (тату, проколы, украшения на людях) ' +
      'показывай только отсюда: нарисованное нейросетью за работу не выдавай.',
    ...photos.map((p, i) => {
      const where = p.source === 'catalog' ? `${p.path} [каталог услуг студии]` : p.path.split(' / ').slice(-2).join(' / ');
      return `Ф${i + 1}: ${where} — ${p.description}${p.people ? ` (людей: ${p.people})` : ''}`;
    }),
  ].join('\n');
}

export interface CandidatePost {
  profile: SmmProfile;
  topic: string;
  brief: string;
  visual: string;
  direction: string | null;
  format: SmmFormat;
}

/**
 * Кандидаты из архива под публикацию: тема, идея, визуал, направление и формат. У студии сверх архива — фото
 * настоящих работ из каталога услуг (помечены в archiveLine); у автора — только её архив.
 */
export async function archiveCandidates(ctx: AppContext, post: CandidatePost, limit = 16): Promise<LibraryPhoto[]> {
  const direction = directionsOf(getSmmSettings(ctx.db, post.profile)).find((d) => d.key === post.direction);
  const text = [post.topic, post.brief, post.visual, direction?.key ?? '', direction?.title ?? ''].join(' ');
  const archive = (await libraryState(ctx, post.profile)) ? await searchLibrary(ctx, post.profile, text, { limit }) : [];
  if (post.profile !== 'studio') return archive;
  try {
    return [...archive, ...catalogCandidates(ctx, text, CATALOG_LIMIT)];
  } catch (error) {
    ctx.log.warn({ err: errorMessage(error) }, 'smm library: catalog photos failed');
    return archive;
  }
}

// ─── Описание новых фото ─────────────────────────────────────────────────────

const DescribeSchema = z.object({
  items: z.array(
    z.object({
      n: z.number().int(),
      description: z.string().min(3).max(300),
      tags: z.string().max(200).optional(),
      people: z.number().int().min(0).max(200).nullable().optional(),
      quality: z.number().int().min(1).max(5).nullable().optional(),
      orientation: z.enum(['portrait', 'landscape', 'square']).nullable().optional(),
    }),
  ),
});

async function thumbPart(ctx: AppContext, id: string): Promise<ChatPart | null> {
  try {
    const res = await fetchOf(ctx)(photoUrl(id, 512), { signal: AbortSignal.timeout(THUMB_TIMEOUT_MS) });
    if (!res.ok) return null;
    const data = Buffer.from(await res.arrayBuffer()).toString('base64');
    return { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${data}` } };
  } catch {
    return null;
  }
}

/** О чём архив профиля — первая строка задания на описание. */
function archiveAbout(profile: SmmProfile, name: string): string {
  return profile === 'studio'
    ? `Это фото из архива тату- и пирсинг-студии «${name}»: работы мастеров (татуировки, проколы, украшения), процесс сеанса, эскизы, интерьер, команда, события.`
    : `Это фото из личного архива «${name}» — мастера тату и пирсинга: её работы, эскизы, процесс, будни, путешествия, вдохновение.`;
}

const SCENE_TAGS =
  'тату, пирсинг, прокол, эскиз, флеш, процесс, мастер, клиент, рука, ухо, лицо, украшение, серьга, кольцо, титан, ' +
  'золото, стерильность, инструменты, кабинет, интерьер, ресепшен, команда, портрет, заживление, до и после, ' +
  'конвенция, улица, путешествие, праздник';

async function describeBatch(ctx: AppContext, profile: SmmProfile, batch: { driveId: string; path: string }[]): Promise<number> {
  const settings = getSmmSettings(ctx.db, profile);
  const parts = await Promise.all(batch.map((p) => thumbPart(ctx, p.driveId)));
  const content: ChatPart[] = [
    {
      type: 'text',
      text: [
        `${archiveAbout(profile, settings.brandName)} Опиши каждое для поиска — по-русски, конкретно: что в кадре (работа, ` +
          'стиль, место на теле, украшение), кто и что делает, обстановка, настроение.',
        `Альбомы: ${[...new Set(batch.map((p) => p.path))].join('; ')}.`,
        `Теги — ключи направлений (${directionsOf(settings).map((d) => d.key).join(', ')}) и сцены словами: ${SCENE_TAGS}.`,
        'Качество 1–5: годится ли кадр в соцсети (резкость, свет, композиция; работа видна чётко). Ответ — JSON: ' +
          '{"items": [{"n": номер фото, "description": "1–2 фразы", "tags": "через пробел", "people": число, "quality": 1–5, "orientation": "portrait|landscape|square"}]}',
      ].join('\n'),
    },
  ];
  batch.forEach((_, k) => {
    const part = parts[k];
    if (part) content.push({ type: 'text', text: `Фото ${k + 1}:` }, part);
  });
  if (content.length === 1) return 0;
  const r = await chatJson(ctx, profile, {
    kind: 'vision',
    note: 'описание архива',
    maxTokens: 1500,
    temperature: 0.2,
    schema: DescribeSchema,
    system: 'Ты описываешь фото для поиска по архиву. Только то, что видно. Ответ — один JSON.',
    user: content,
  });
  let described = 0;
  for (const item of r.items) {
    const photo = batch[item.n - 1];
    if (!photo) continue;
    ctx.db
      .update(smmLibrary)
      .set({
        description: item.description,
        tags: item.tags ?? '',
        people: item.people ?? null,
        quality: item.quality ?? null,
        orientation: item.orientation ?? null,
        describedAt: Date.now(),
      })
      .where(and(eq(smmLibrary.profile, profile), eq(smmLibrary.driveId, photo.driveId)))
      .run();
    described += 1;
  }
  return described;
}

/**
 * Описать новые фото архивов включённых профилей (по превью, пачками). Выключенный профиль (автор — по умолчанию)
 * нейросеть не тратит. Возвращает, сколько описано.
 */
export async function describePending(ctx: AppContext, limit = DESCRIBE_PER_RUN): Promise<number> {
  let described = 0;
  let budget = limit;
  for (const profile of PROFILES) {
    if (budget <= 0) break;
    if (!getSmmSettings(ctx.db, profile).enabled) continue;
    if (!(await libraryState(ctx, profile))) continue;
    const pending = ctx.db
      .select({ driveId: smmLibrary.driveId, path: smmLibrary.path })
      .from(smmLibrary)
      .where(
        and(
          eq(smmLibrary.profile, profile),
          eq(smmLibrary.description, ''),
          inArray(smmLibrary.kind, ['photo', 'template', 'logo', 'design']),
        ),
      )
      .orderBy(desc(smmLibrary.seenAt))
      .limit(budget)
      .all();
    budget -= pending.length;
    for (let i = 0; i < pending.length; i += DESCRIBE_BATCH) {
      try {
        described += await describeBatch(ctx, profile, pending.slice(i, i + DESCRIBE_BATCH));
      } catch (error) {
        ctx.log.warn({ err: errorMessage(error), profile }, 'smm library: describe failed');
        break;
      }
    }
  }
  return described;
}
