/**
 * База знаний маркетолога по профилю: портрет (студии или автора), места съёмки по зонам, что было в соцсетях,
 * справка по тату и пирсингу и календарь дат. Хранение (smm_knowledge, smm_zones, smm_zone_photos) и сборка блока
 * «что маркетолог знает» для промптов плана, постов, идей и видео.
 *
 * Текст владельца (у автора — её собственный) важнее текста маркетолога: он идёт первым и с пометкой «от владельца»
 * («от автора»). У каждого профиля всё своё: автор не видит ни портрета, ни помещений, ни постов студии.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, like, lt, max, ne, or, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { smmAccounts, smmKnowledge, smmPlatformPosts, smmZonePhotos, smmZones } from '../db/schema.js';
import { errorMessage } from '../lib/errors.js';
import { toIso } from '../lib/time.js';
import { studioDate } from './context.js';
import { craftKnowledge } from './craft.js';
import { removeSmmFile } from './files.js';
import { SmmError, type SmmProfile, type SmmProgress } from './types.js';

export const KNOWLEDGE_KEYS = ['brand', 'socials'] as const;
export type KnowledgeKey = (typeof KNOWLEDGE_KEYS)[number];
export const isKnowledgeKey = (v: unknown): v is KnowledgeKey => v === 'brand' || v === 'socials';

export interface KnowledgeDoc {
  key: KnowledgeKey;
  ownerText: string;
  aiText: string;
  meta: Record<string, unknown>;
  progress: SmmProgress | null;
  error: string | null;
  aiAt: string | null;
}

export interface ZonePhoto {
  id: string;
  url: string;
}

export interface Zone {
  id: string;
  profile: SmmProfile;
  /** Код для промптов: «З1», «З2»… — по порядку зон профиля. */
  code: string;
  title: string;
  sort: number;
  ownerText: string;
  aiText: string;
  /** То же коротко по-английски — опора для видеомодели. */
  anchor: string;
  photos: ZonePhoto[];
  progress: SmmProgress | null;
  error: string | null;
  aiAt: string | null;
}

/** Раздел занят работой дольше — работа считается зависшей, раздел можно занять снова. */
const DOC_STALE_MS = 15 * 60_000;
/** Описание зоны считается зависшим через столько (от последнего шага) — можно запустить заново. */
export const ZONE_STALE_MS = 5 * 60_000;
/** Сколько прошлых постов-кандидатов поднимаем из базы для ранжирования по словам. */
const SIMILAR_CANDIDATES = 300;
const SIMILAR_WORDS = 12;

function parseObject<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}

const progressJson = (p: SmmProgress | null) => (p ? JSON.stringify(p) : null);
const ownerLabel = (profile: SmmProfile) => (profile === 'author' ? 'от автора' : 'от владельца');

/**
 * Шкала работы, пока работа свежая (`since` — когда её последний раз двигали): зависшую (сервер перезапускался
 * посреди работы) наружу не отдаём, иначе приложение ждёт вечно. Сроки — те же, что у повторного захвата.
 */
function liveProgress(progress: SmmProgress | null, since: number | null | undefined, staleMs: number): SmmProgress | null {
  return progress && since != null && Number.isFinite(since) && Date.now() - since <= staleMs ? progress : null;
}

// ─── Разделы ─────────────────────────────────────────────────────────────────

type DocRow = typeof smmKnowledge.$inferSelect;

function mapDoc(key: KnowledgeKey, r: DocRow | undefined): KnowledgeDoc {
  return {
    key,
    ownerText: r?.ownerText ?? '',
    aiText: r?.aiText ?? '',
    meta: parseObject<Record<string, unknown>>(r?.metaJson, {}),
    // Захват раздела (claimDoc) считает работу зависшей по updated_at — так же и здесь.
    progress: liveProgress(parseObject<SmmProgress | null>(r?.progressJson, null), r?.updatedAt, DOC_STALE_MS),
    error: r?.error ?? null,
    aiAt: toIso(r?.aiAt ?? null),
  };
}

const docWhere = (profile: SmmProfile, key: KnowledgeKey) => and(eq(smmKnowledge.profile, profile), eq(smmKnowledge.key, key));

export async function getDoc(ctx: AppContext, profile: SmmProfile, key: KnowledgeKey): Promise<KnowledgeDoc> {
  return mapDoc(key, ctx.db.select().from(smmKnowledge).where(docWhere(profile, key)).get());
}

export async function saveOwnerText(ctx: AppContext, profile: SmmProfile, key: KnowledgeKey, text: string): Promise<KnowledgeDoc> {
  const now = Date.now();
  ctx.db
    .insert(smmKnowledge)
    .values({ profile, key, ownerText: text, updatedAt: now })
    .onConflictDoUpdate({ target: [smmKnowledge.profile, smmKnowledge.key], set: { ownerText: text, updatedAt: now } })
    .run();
  return getDoc(ctx, profile, key);
}

export async function setDocProgress(
  ctx: AppContext,
  profile: SmmProfile,
  key: KnowledgeKey,
  progress: SmmProgress | null,
  error: string | null = null,
): Promise<void> {
  const now = Date.now();
  const set = { progressJson: progressJson(progress), error, updatedAt: now };
  ctx.db
    .insert(smmKnowledge)
    .values({ profile, key, ...set })
    .onConflictDoUpdate({ target: [smmKnowledge.profile, smmKnowledge.key], set })
    .run();
}

/** Занять раздел под работу: false — маркетолог уже над ним работает (и работа свежая). */
export async function claimDoc(ctx: AppContext, profile: SmmProfile, key: KnowledgeKey, progress: SmmProgress): Promise<boolean> {
  const now = Date.now();
  ctx.db.insert(smmKnowledge).values({ profile, key, updatedAt: now }).onConflictDoNothing().run();
  const claimed = ctx.db
    .update(smmKnowledge)
    .set({ progressJson: JSON.stringify(progress), error: null, updatedAt: now })
    .where(and(docWhere(profile, key), or(isNull(smmKnowledge.progressJson), lt(smmKnowledge.updatedAt, now - DOC_STALE_MS))))
    .run();
  return claimed.changes > 0;
}

export async function saveAiText(
  ctx: AppContext,
  profile: SmmProfile,
  key: KnowledgeKey,
  text: string,
  meta: Record<string, unknown>,
): Promise<void> {
  const now = Date.now();
  ctx.db
    .update(smmKnowledge)
    .set({ aiText: text, metaJson: JSON.stringify(meta), aiAt: now, progressJson: null, error: null, updatedAt: now })
    .where(docWhere(profile, key))
    .run();
}

// ─── Места съёмки ────────────────────────────────────────────────────────────

export async function listZones(ctx: AppContext, profile: SmmProfile): Promise<Zone[]> {
  const zoneRows = ctx.db
    .select()
    .from(smmZones)
    .where(eq(smmZones.profile, profile))
    .orderBy(asc(smmZones.sort), asc(smmZones.createdAt))
    .all();
  const ids = zoneRows.map((z) => z.id);
  const photoRows = ids.length
    ? ctx.db
        .select({ id: smmZonePhotos.id, zoneId: smmZonePhotos.zoneId, url: smmZonePhotos.url })
        .from(smmZonePhotos)
        .where(inArray(smmZonePhotos.zoneId, ids))
        .orderBy(asc(smmZonePhotos.sort), asc(smmZonePhotos.createdAt))
        .all()
    : [];
  return zoneRows.map((z, i) => {
    const progress = parseObject<SmmProgress | null>(z.progressJson, null);
    // Описание зоны (interior.ts) считает работу зависшей по времени шага шкалы.
    const at = progress ? Date.parse(progress.at) : NaN;
    return {
      id: z.id,
      profile,
      code: `З${i + 1}`,
      title: z.title,
      sort: z.sort,
      ownerText: z.ownerText,
      aiText: z.aiText,
      anchor: z.anchor,
      photos: photoRows.filter((p) => p.zoneId === z.id).map((p) => ({ id: p.id, url: p.url })),
      progress: liveProgress(progress, Number.isFinite(at) ? at : z.updatedAt, ZONE_STALE_MS),
      error: z.error,
      aiAt: toIso(z.aiAt),
    };
  });
}

/** Зона по id (с кодом по порядку зон её профиля); нет такой — SmmError 404. */
export async function zoneOr404(ctx: AppContext, id: string): Promise<Zone> {
  const row = ctx.db.select({ profile: smmZones.profile }).from(smmZones).where(eq(smmZones.id, id)).get();
  const profile = row?.profile === 'author' || row?.profile === 'studio' ? row.profile : null;
  const zone = profile ? (await listZones(ctx, profile)).find((z) => z.id === id) : undefined;
  if (!zone) throw new SmmError('Зона не найдена', 404);
  return zone;
}

/** Новая зона в конце списка профиля; возвращает её id. */
export async function addZone(ctx: AppContext, profile: SmmProfile, title: string): Promise<string> {
  const now = Date.now();
  const id = randomUUID();
  const last = ctx.db.select({ sort: max(smmZones.sort) }).from(smmZones).where(eq(smmZones.profile, profile)).get();
  ctx.db
    .insert(smmZones)
    .values({ id, profile, title: title.trim(), sort: (last?.sort ?? 0) + 1, createdAt: now, updatedAt: now })
    .run();
  return id;
}

export async function updateZone(ctx: AppContext, id: string, patch: { title?: string; ownerText?: string }): Promise<void> {
  const set = {
    ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
    ...(patch.ownerText !== undefined ? { ownerText: patch.ownerText } : {}),
    updatedAt: Date.now(),
  };
  ctx.db.update(smmZones).set(set).where(eq(smmZones.id, id)).run();
}

/** Удалить зону с её фото (и файлы фото с диска). */
export async function removeZone(ctx: AppContext, id: string): Promise<void> {
  const photos = ctx.db.select({ url: smmZonePhotos.url }).from(smmZonePhotos).where(eq(smmZonePhotos.zoneId, id)).all();
  ctx.db.delete(smmZonePhotos).where(eq(smmZonePhotos.zoneId, id)).run();
  ctx.db.delete(smmZones).where(eq(smmZones.id, id)).run();
  await Promise.all(photos.map((p) => removeSmmFile(ctx, p.url)));
}

export async function addZonePhoto(ctx: AppContext, zoneId: string, url: string): Promise<void> {
  const last = ctx.db.select({ sort: max(smmZonePhotos.sort) }).from(smmZonePhotos).where(eq(smmZonePhotos.zoneId, zoneId)).get();
  ctx.db
    .insert(smmZonePhotos)
    .values({ id: randomUUID(), zoneId, url, sort: (last?.sort ?? 0) + 1, createdAt: Date.now() })
    .run();
  ctx.db.update(smmZones).set({ updatedAt: Date.now() }).where(eq(smmZones.id, zoneId)).run();
}

export async function removeZonePhoto(ctx: AppContext, zoneId: string, photoId: string): Promise<void> {
  const where = and(eq(smmZonePhotos.id, photoId), eq(smmZonePhotos.zoneId, zoneId));
  const photo = ctx.db.select({ url: smmZonePhotos.url }).from(smmZonePhotos).where(where).get();
  if (!photo) return;
  ctx.db.delete(smmZonePhotos).where(where).run();
  await removeSmmFile(ctx, photo.url);
}

export async function setZoneProgress(ctx: AppContext, id: string, progress: SmmProgress | null, error: string | null = null): Promise<void> {
  ctx.db.update(smmZones).set({ progressJson: progressJson(progress), error, updatedAt: Date.now() }).where(eq(smmZones.id, id)).run();
}

export async function saveZoneAiText(ctx: AppContext, id: string, text: string, anchor: string): Promise<void> {
  const now = Date.now();
  ctx.db
    .update(smmZones)
    .set({ aiText: text, anchor, aiAt: now, progressJson: null, error: null, updatedAt: now })
    .where(eq(smmZones.id, id))
    .run();
}

/** Описание зоны для промпта: слова владельца (автора), потом — что маркетолог увидел на фото. */
export const zoneDescription = (z: Zone): string =>
  [z.ownerText.trim() && `${ownerLabel(z.profile)}: ${z.ownerText.trim()}`, z.aiText.trim()].filter(Boolean).join(' ');

/** Зоны с фото или описанием — только их можно предлагать как место для картинки. */
export const usableZones = (zones: Zone[]): Zone[] => zones.filter((z) => z.photos.length || z.ownerText.trim() || z.aiText.trim());

export function zonesText(zones: Zone[]): string {
  const usable = usableZones(zones);
  if (!usable.length) return '';
  const head =
    usable[0]?.profile === 'author'
      ? 'Места съёмки автора — как они выглядят (код места ставь в "zone", только когда сцена по сюжету в одном из этих мест — тогда картинка будет в настоящем месте):'
      : 'Помещения студии — как они выглядят (код зоны ставь в "zone", только когда сцена по сюжету у нас в студии — тогда картинка будет в нашем настоящем помещении):';
  return [
    head,
    ...usable.map((z) => `${z.code} ${z.title}${z.photos.length ? ` (${z.photos.length} фото)` : ''}: ${zoneDescription(z) || 'описания пока нет — опирайся на фото'}`),
  ].join('\n');
}

/** Зона по коду из ответа модели: «З2», «з2», «2». */
export function zoneByCode(zones: Zone[], code: string | undefined): Zone | undefined {
  if (!code) return undefined;
  const n = Number(code.replace(/\D/g, ''));
  return Number.isFinite(n) && n > 0 ? zones[n - 1] : undefined;
}

// ─── Прошлые посты площадок ──────────────────────────────────────────────────

const normalize = (text: string) => text.toLowerCase().replace(/ё/g, 'е');

/** Основа слова без окончания — чтобы «татуировки» нашли «татуировку»: «татуиро», «пирси», «хелик». */
export const stemOf = (word: string): string => (word.length <= 5 ? word : word.slice(0, Math.max(5, word.length - 3)));

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function occurrences(haystack: string, needle: string): number {
  let n = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) n += 1;
  return n;
}

/**
 * Похожие прошлые посты профиля (по словам темы) — чтобы держать голос и не повторяться. Полнотекстового поиска в
 * SQLite нет: кандидаты — `LIKE` по основам слов (строчные и с заглавной: `lower()` SQLite не знает кириллицы), а
 * порядок — в JS: больше разных совпавших основ, потом больше совпадений, потом свежее.
 */
export async function similarPastPosts(ctx: AppContext, profile: SmmProfile, text: string, limit = 4): Promise<string> {
  const words = [...new Set(normalize(text).replace(/[^a-zа-я0-9\s]/gi, ' ').split(/\s+/).filter((w) => w.length >= 4))].slice(0, SIMILAR_WORDS);
  if (!words.length) return '';
  const stems = [...new Set(words.map(stemOf))];
  try {
    const accounts = ctx.db.select({ id: smmAccounts.id }).from(smmAccounts).where(eq(smmAccounts.profile, profile)).all();
    if (!accounts.length) return '';
    const found = ctx.db
      .select({
        platform: smmPlatformPosts.platform,
        publishedAt: smmPlatformPosts.publishedAt,
        caption: smmPlatformPosts.caption,
        views: smmPlatformPosts.views,
        likes: sql<number | null>`coalesce(${smmPlatformPosts.likes}, ${smmPlatformPosts.reactions})`,
      })
      .from(smmPlatformPosts)
      .where(
        and(
          inArray(
            smmPlatformPosts.accountId,
            accounts.map((a) => a.id),
          ),
          ne(smmPlatformPosts.format, 'story'),
          sql`length(${smmPlatformPosts.caption}) > 60`,
          or(...stems.flatMap((s) => [like(smmPlatformPosts.caption, `%${s}%`), like(smmPlatformPosts.caption, `%${capitalize(s)}%`)])),
        ),
      )
      .orderBy(desc(smmPlatformPosts.publishedAt))
      .limit(SIMILAR_CANDIDATES)
      .all();
    const ranked = found
      .map((p) => {
        const caption = normalize(p.caption);
        const matched = stems.filter((s) => caption.includes(s));
        return { p, matched: matched.length, hits: matched.reduce((sum, s) => sum + occurrences(caption, s), 0) };
      })
      .filter((r) => r.matched > 0)
      .sort((a, b) => b.matched - a.matched || b.hits - a.hits || (b.p.publishedAt ?? 0) - (a.p.publishedAt ?? 0))
      .slice(0, limit);
    if (!ranked.length) return '';
    return [
      `${profile === 'author' ? 'Как уже писали в этом блоге' : 'Как студия уже писала'} на похожие темы (держи голос, но не повторяй заходы и фразы):`,
      ...ranked.map(({ p }) => {
        const day = p.publishedAt ? studioDate(ctx, p.publishedAt) : '—';
        const nums = `${p.views != null ? `, 👁 ${p.views}` : ''}${p.likes != null ? `, ❤ ${p.likes}` : ''}`;
        return `- ${day} ${p.platform}${nums}: ${p.caption.replace(/\s+/g, ' ').slice(0, 500)}`;
      }),
    ].join('\n');
  } catch (error) {
    ctx.log.warn({ err: errorMessage(error) }, 'smm: similar past posts failed');
    return '';
  }
}

// ─── Блок для промптов ───────────────────────────────────────────────────────

export interface KnowledgeOpts {
  /** full — справка по тату и пирсингу целиком (тексты постов), brief — коротко (план, идеи). */
  craft: 'brief' | 'full';
  /** Места съёмки — там, где маркетолог ставит задачи на картинки и видео. */
  zones?: Zone[];
}

/** «Что маркетолог знает»: портрет, что было в соцсетях профиля, места съёмки, справка по тату и пирсингу. */
export async function knowledgeText(ctx: AppContext, profile: SmmProfile, opts: KnowledgeOpts): Promise<string> {
  const [brand, socials] = await Promise.all([getDoc(ctx, profile, 'brand'), getDoc(ctx, profile, 'socials')]);
  const author = profile === 'author';
  const owner = brand.ownerText.trim() && `${author ? 'От автора' : 'От владельца'} (главное, соблюдай):\n${brand.ownerText.trim()}`;
  const portrait = [owner, brand.aiText.trim()].filter(Boolean).join('\n\n');
  return [
    portrait && `${author ? 'Портрет автора' : 'Портрет студии'}:\n${portrait}`,
    socials.aiText.trim() && `Что уже было в ${author ? 'соцсетях автора' : 'наших соцсетях'}:\n${socials.aiText.trim()}`,
    opts.zones ? zonesText(opts.zones) : '',
    `Справка по тату и пирсингу${author ? ' (фон: о себе автор пишет сама — в портрете)' : ''}:\n${craftKnowledge(opts.craft)}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}
