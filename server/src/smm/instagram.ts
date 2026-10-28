/**
 * Instagram API (вход через Instagram, graph.instagram.com) — официально, у каждого профиля свой аккаунт.
 *
 * Владелец создаёт приложение Meta, добавляет свой профессиональный аккаунт и жмёт «Generate token» в кабинете:
 * ключ живёт 60 дней. Ключ вставляют в приложении MIKAN (СММ → площадки) — маркетолог хранит его зашифрованным
 * (ключ настроек `smm_instagram:<профиль>` вместе с id и именем аккаунта и сроком) и сам продлевает заранее.
 *
 * Что даёт: подписчики, вышедшие публикации со ссылками и метриками (views, reach, likes, comments, saved, shares) и
 * публикация поста, карусели, рилс и сторис. Картинки — только JPEG; файлы Meta забирает по публичной ссылке через
 * Worker. Каждый запрос к Graph API — через шлюз (relay.webFetch): из РФ Instagram закрыт.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { and, eq, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { smmAccounts } from '../db/schema.js';
import { deleteKey, readKey, writeKey } from '../domain/settings.js';
import { errorMessage } from '../lib/errors.js';
import { decryptSecret, encryptSecret } from '../lib/secrets.js';
import { DAY_MS } from '../lib/time.js';
import { smmFilePath } from './files.js';
import { publicMediaUrl, webFetch } from './relay.js';
import { plainText } from './telegram.js';
import { SmmError, type SmmMedia, type SmmPost, type SmmProfile } from './types.js';

const GRAPH = 'https://graph.instagram.com/v25.0';
const REFRESH_URL = 'https://graph.instagram.com/refresh_access_token';
const TOKEN_TTL_MS = 60 * DAY_MS;
/** Продлеваем, когда до конца меньше 20 дней (продлить можно не раньше чем через сутки после выдачи). */
const REFRESH_BEFORE_MS = 20 * DAY_MS;
const MIN_TOKEN_AGE_MS = DAY_MS;
const CAROUSEL_MAX = 10;
const CAPTION_MAX = 2200;
const POLL_MS = 5_000;
const IMAGE_WAIT_MS = 90_000;
const VIDEO_WAIT_MS = 300_000;
const MIN_TOKEN_LENGTH = 40;

const stateKey = (profile: SmmProfile) => `smm_instagram:${profile}`;

/** Подключённый аккаунт (наружу — без ключа). */
export interface InstagramState {
  userId: string;
  username: string;
  name: string | null;
  accountType: string | null;
  tokenSetAt: string;
  expiresAt: string;
  error: string | null;
}

/** Что лежит в настройках: состояние, зашифрованный ключ и кто его вставил. */
interface StoredInstagram extends InstagramState {
  tokenEnc: string;
  updatedBy: number | null;
}

function readStored(ctx: AppContext, profile: SmmProfile): StoredInstagram | null {
  const raw = readKey<StoredInstagram>(ctx.db, stateKey(profile));
  return raw && typeof raw === 'object' && raw.userId && raw.tokenEnc ? raw : null;
}

const publicState = ({ tokenEnc: _token, updatedBy: _by, ...state }: StoredInstagram): InstagramState => state;

export async function instagramState(ctx: AppContext, profile: SmmProfile): Promise<InstagramState | null> {
  const stored = readStored(ctx, profile);
  return stored ? publicState(stored) : null;
}

type GraphError = { error?: { message?: string; code?: number; error_subcode?: number } };

function graphFailure(ctx: AppContext, status: number, body: GraphError): SmmError {
  const code = body.error?.code;
  const message = body.error?.message ?? `HTTP ${status}`;
  ctx.log.warn({ status, code, err: message.slice(0, 200) }, 'smm: instagram request failed');
  if (code === 190) return new SmmError('Ключ Instagram недействителен или истёк — вставьте новый в настройках СММ', 400);
  if (code === 10 || code === 200) return new SmmError('У ключа Instagram нет нужных прав — выдайте доступ к публикации и статистике', 400);
  if (code === 4 || code === 17 || code === 32 || code === 613) return new SmmError('Instagram просит подождать — слишком много запросов', 502);
  if (code === 9 || /limit/i.test(message)) return new SmmError('Достигнут лимит публикаций Instagram за сутки', 502);
  return new SmmError(`Instagram не принял запрос: ${message.slice(0, 160)}`, 502);
}

type GraphParams = Record<string, string | number | boolean | undefined>;

async function graph<T>(ctx: AppContext, token: string, path: string, params: GraphParams = {}, method: 'GET' | 'POST' = 'GET'): Promise<T> {
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) query.set(k, String(v));
  query.set('access_token', token);
  const url = path.startsWith('http') ? path : `${GRAPH}${path}`;
  let res: Response;
  try {
    res =
      method === 'GET'
        ? await webFetch(ctx, `${url}?${query.toString()}`, { timeoutMs: 30_000 })
        : await webFetch(ctx, url, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: query.toString(),
            timeoutMs: 60_000,
          });
  } catch {
    throw new SmmError('Нет связи с Instagram — попробуйте позже', 502);
  }
  const data = (await res.json().catch(() => ({}))) as T & GraphError;
  if (!res.ok || data.error) throw graphFailure(ctx, res.status, data);
  return data;
}

function token(ctx: AppContext, profile: SmmProfile): string {
  const stored = readStored(ctx, profile);
  if (!stored) throw new SmmError('Instagram не подключён — вставьте ключ в настройках СММ', 400);
  try {
    return decryptSecret(ctx, stored.tokenEnc);
  } catch {
    throw new SmmError('Ключ Instagram не читается — вставьте его заново в настройках СММ', 400);
  }
}

function saveStored(ctx: AppContext, profile: SmmProfile, state: InstagramState, tokenEnc: string, updatedBy: number | null): void {
  writeKey(ctx.db, stateKey(profile), { ...state, tokenEnc, updatedBy } satisfies StoredInstagram);
}

type Me = {
  user_id?: string;
  id?: string;
  username: string;
  name?: string;
  account_type?: string;
  followers_count?: number;
  media_count?: number;
};

/** Площадка Instagram профиля: та же строка, если уже была, иначе новая; маркетолог публикует сам. */
function upsertAccount(ctx: AppContext, profile: SmmProfile, handle: string, followers: number | null): void {
  const now = Date.now();
  const values = { handle, url: `https://www.instagram.com/${handle}/`, title: `@${handle}`, canPublish: true, isActive: true };
  const updated = ctx.db
    .update(smmAccounts)
    .set({ ...values, followers: sql`coalesce(${followers}, ${smmAccounts.followers})`, statsError: null, updatedAt: now })
    .where(and(eq(smmAccounts.profile, profile), eq(smmAccounts.platform, 'instagram')))
    .run();
  if (updated.changes > 0) return;
  ctx.db
    .insert(smmAccounts)
    .values({ id: randomUUID(), profile, platform: 'instagram', ...values, followers, createdAt: now, updatedAt: now })
    .run();
}

/** Проверить ключ и подключить аккаунт: площадка Instagram профиля становится «публикует маркетолог». */
export async function connectInstagram(ctx: AppContext, profile: SmmProfile, rawToken: string, userId: number | null): Promise<InstagramState> {
  const value = rawToken.trim().replace(/^Bearer\s+/i, '');
  if (value.length < MIN_TOKEN_LENGTH || /\s/.test(value)) {
    throw new SmmError('Это не похоже на ключ доступа — скопируйте его целиком из кабинета Meta', 400);
  }
  const me = await graph<Me>(ctx, value, '/me', { fields: 'user_id,username,name,account_type,followers_count,media_count' });
  const igId = me.user_id ?? me.id;
  if (!igId || !me.username) throw new SmmError('Instagram не вернул аккаунт — проверьте ключ', 400);
  const now = Date.now();
  const state: InstagramState = {
    userId: String(igId),
    username: me.username,
    name: me.name ?? null,
    accountType: me.account_type ?? null,
    tokenSetAt: new Date(now).toISOString(),
    expiresAt: new Date(now + TOKEN_TTL_MS).toISOString(),
    error: null,
  };
  saveStored(ctx, profile, state, encryptSecret(ctx, value), userId);
  upsertAccount(ctx, profile, me.username, me.followers_count ?? null);
  return state;
}

export async function disconnectInstagram(ctx: AppContext, profile: SmmProfile): Promise<void> {
  deleteKey(ctx.db, stateKey(profile));
  ctx.db
    .update(smmAccounts)
    .set({ canPublish: false, updatedAt: Date.now() })
    .where(and(eq(smmAccounts.profile, profile), eq(smmAccounts.platform, 'instagram')))
    .run();
}

/** Пора ли продлить ключ: до конца меньше 20 дней и выдан не меньше суток назад. */
export function tokenNeedsRefresh(state: Pick<InstagramState, 'tokenSetAt' | 'expiresAt'>, now = Date.now()): boolean {
  const left = Date.parse(state.expiresAt) - now;
  const age = now - Date.parse(state.tokenSetAt);
  return left <= REFRESH_BEFORE_MS && age >= MIN_TOKEN_AGE_MS;
}

/** Продлить ключ заранее (раз в день из крона). Ошибку записываем — владелец увидит в настройках. */
export async function refreshInstagramToken(ctx: AppContext, profile: SmmProfile): Promise<void> {
  const stored = readStored(ctx, profile);
  if (!stored || !tokenNeedsRefresh(stored)) return;
  const state = publicState(stored);
  try {
    const r = await graph<{ access_token: string; expires_in?: number }>(ctx, token(ctx, profile), REFRESH_URL, {
      grant_type: 'ig_refresh_token',
    });
    if (!r.access_token) throw new SmmError('Instagram не вернул новый ключ', 502);
    const now = Date.now();
    saveStored(
      ctx,
      profile,
      {
        ...state,
        tokenSetAt: new Date(now).toISOString(),
        expiresAt: new Date(now + (r.expires_in ? r.expires_in * 1000 : TOKEN_TTL_MS)).toISOString(),
        error: null,
      },
      encryptSecret(ctx, r.access_token),
      stored.updatedBy,
    );
  } catch (error) {
    saveStored(ctx, profile, { ...state, error: error instanceof SmmError ? error.message : 'Ключ не продлился' }, stored.tokenEnc, stored.updatedBy);
    if (!(error instanceof SmmError)) ctx.log.warn({ err: errorMessage(error), profile }, 'smm: instagram token refresh failed');
  }
}

// ─── Данные ──────────────────────────────────────────────────────────────────

export interface IgMedia {
  id: string;
  caption?: string;
  permalink?: string;
  timestamp?: string;
  media_type?: string;
  media_product_type?: string;
  like_count?: number;
  comments_count?: number;
  media_url?: string;
  thumbnail_url?: string;
}

type InsightRow = {
  name: string;
  values?: { value: unknown; end_time?: string }[];
  total_value?: { value?: number; breakdowns?: { results?: { dimension_values?: string[]; value?: number }[] }[] };
};

/** Подключённый аккаунт профиля или ошибка «не подключён». */
function connected(ctx: AppContext, profile: SmmProfile): InstagramState {
  const stored = readStored(ctx, profile);
  if (!stored) throw new SmmError('Instagram не подключён', 400);
  return publicState(stored);
}

export async function igProfile(ctx: AppContext, profile: SmmProfile): Promise<Me & { id: string }> {
  const state = connected(ctx, profile);
  const me = await graph<Me>(ctx, token(ctx, profile), '/me', { fields: 'user_id,username,followers_count,media_count' });
  return { ...me, id: me.user_id ?? state.userId };
}

const MEDIA_FIELDS = 'id,caption,permalink,timestamp,media_type,media_product_type,like_count,comments_count,media_url,thumbnail_url';

export async function igRecentMedia(ctx: AppContext, profile: SmmProfile, limit = 25): Promise<IgMedia[]> {
  const state = await instagramState(ctx, profile);
  if (!state) return [];
  const r = await graph<{ data?: IgMedia[] }>(ctx, token(ctx, profile), `/${state.userId}/media`, { fields: MEDIA_FIELDS, limit });
  return r.data ?? [];
}

/** Вся лента профиля постранично (до `max` публикаций) — для изучения истории. */
export async function igAllMedia(ctx: AppContext, profile: SmmProfile, max = 600): Promise<IgMedia[]> {
  const state = await instagramState(ctx, profile);
  if (!state) return [];
  const key = token(ctx, profile);
  const out: IgMedia[] = [];
  let after: string | undefined;
  while (out.length < max) {
    const r = await graph<{ data?: IgMedia[]; paging?: { cursors?: { after?: string }; next?: string } }>(
      ctx,
      key,
      `/${state.userId}/media`,
      { fields: MEDIA_FIELDS, limit: 100, after },
    );
    out.push(...(r.data ?? []));
    after = r.paging?.next ? r.paging.cursors?.after : undefined;
    if (!after || !r.data?.length) break;
  }
  return out.slice(0, max);
}

/** Живые сторис (Instagram отдаёт их только сутки — цифры снимаем, пока висят). */
export async function igStories(ctx: AppContext, profile: SmmProfile): Promise<IgMedia[]> {
  const state = await instagramState(ctx, profile);
  if (!state) return [];
  const r = await graph<{ data?: IgMedia[] }>(ctx, token(ctx, profile), `/${state.userId}/stories`, { fields: MEDIA_FIELDS }).catch(
    () => ({ data: [] as IgMedia[] }),
  );
  return (r.data ?? []).map((m) => ({ ...m, media_product_type: 'STORY' }));
}

/** Метрики публикации: просмотры, охват, лайки, комментарии, сохранения, репосты, взаимодействия. */
export async function igInsights(ctx: AppContext, profile: SmmProfile, media: IgMedia): Promise<Record<string, number>> {
  const metric =
    media.media_product_type === 'STORY' ? 'views,reach,replies,shares,total_interactions' : 'views,reach,likes,comments,saved,shares,total_interactions';
  try {
    const r = await graph<{ data?: InsightRow[] }>(ctx, token(ctx, profile), `/${media.id}/insights`, { metric });
    const out: Record<string, number> = {};
    for (const m of r.data ?? []) {
      const v = m.total_value?.value ?? m.values?.[0]?.value;
      if (typeof v === 'number') out[m.name === 'saved' ? 'saves' : m.name === 'total_interactions' ? 'interactions' : m.name] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Профиль за период: охват, просмотры, вовлечённые, взаимодействия, визиты, переходы, подписки. */
export interface IgPeriod {
  reach: number | null;
  views: number | null;
  engaged: number | null;
  interactions: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  replies: number | null;
  profileViews: number | null;
  linkTaps: number | null;
  follows: number | null;
  unfollows: number | null;
}

const PERIOD_METRICS: Record<string, keyof IgPeriod> = {
  reach: 'reach',
  views: 'views',
  accounts_engaged: 'engaged',
  total_interactions: 'interactions',
  likes: 'likes',
  comments: 'comments',
  shares: 'shares',
  saves: 'saves',
  replies: 'replies',
  profile_views: 'profileViews',
  website_clicks: 'linkTaps',
};

const NO_INSIGHTS = { data: [] as InsightRow[] };

export async function igPeriod(ctx: AppContext, profile: SmmProfile, days: number): Promise<IgPeriod> {
  const state = connected(ctx, profile);
  const tok = token(ctx, profile);
  const until = Math.floor(Date.now() / 1000);
  const since = until - days * 86_400;
  const out: IgPeriod = {
    reach: null,
    views: null,
    engaged: null,
    interactions: null,
    likes: null,
    comments: null,
    shares: null,
    saves: null,
    replies: null,
    profileViews: null,
    linkTaps: null,
    follows: null,
    unfollows: null,
  };
  const read = (list: InsightRow[] | undefined) => {
    for (const m of list ?? []) {
      const key = PERIOD_METRICS[m.name];
      if (key && typeof m.total_value?.value === 'number') out[key] = m.total_value.value;
    }
  };
  const path = `/${state.userId}/insights`;
  const base = { period: 'day', metric_type: 'total_value', since, until };
  try {
    read((await graph<{ data?: InsightRow[] }>(ctx, tok, path, { ...base, metric: Object.keys(PERIOD_METRICS).join(',') })).data);
  } catch {
    // Одна метрика не прошла — берём по одной.
    for (const name of Object.keys(PERIOD_METRICS)) {
      read((await graph<{ data?: InsightRow[] }>(ctx, tok, path, { ...base, metric: name }).catch(() => NO_INSIGHTS)).data);
    }
  }
  const follows = await graph<{ data?: InsightRow[] }>(ctx, tok, path, {
    ...base,
    metric: 'follows_and_unfollows',
    breakdown: 'follow_type',
  }).catch(() => NO_INSIGHTS);
  for (const r of follows.data?.[0]?.total_value?.breakdowns?.[0]?.results ?? []) {
    if (r.dimension_values?.[0] === 'FOLLOWER') out.follows = r.value ?? null;
    if (r.dimension_values?.[0] === 'NON_FOLLOWER') out.unfollows = r.value ?? null;
  }
  return out;
}

/** Метрика по дням (охват, новые подписчики) за последние `days` дней (до 30). */
export async function igDaily(
  ctx: AppContext,
  profile: SmmProfile,
  metric: 'reach' | 'follower_count',
  days: number,
): Promise<{ day: string; value: number }[]> {
  const state = await instagramState(ctx, profile);
  if (!state) return [];
  const until = Math.floor(Date.now() / 1000);
  const r = await graph<{ data?: InsightRow[] }>(ctx, token(ctx, profile), `/${state.userId}/insights`, {
    metric,
    period: 'day',
    since: until - Math.min(days, 30) * 86_400,
    until,
  }).catch(() => NO_INSIGHTS);
  return (
    (r.data?.[0]?.values ?? [])
      .filter((v) => typeof v.value === 'number' && v.end_time)
      // end_time — конец суток по тихоокеанскому времени: относим к предыдущему дню.
      .map((v) => ({ day: new Date(Date.parse(v.end_time!) - DAY_MS).toISOString().slice(0, 10), value: v.value as number }))
  );
}

export interface IgAudience {
  ages: { label: string; value: number }[];
  genders: { label: string; value: number }[];
  cities: { label: string; value: number }[];
}

const GENDER_LABEL: Record<string, string> = { F: 'Женщины', M: 'Мужчины', U: 'Не указан' };

/** Аудитория подписчиков: возраст, пол, города. */
export async function igAudience(ctx: AppContext, profile: SmmProfile): Promise<IgAudience | null> {
  const state = await instagramState(ctx, profile);
  if (!state) return null;
  const tok = token(ctx, profile);
  const part = async (breakdown: 'age' | 'gender' | 'city') => {
    const r = await graph<{ data?: InsightRow[] }>(ctx, tok, `/${state.userId}/insights`, {
      metric: 'follower_demographics',
      period: 'lifetime',
      metric_type: 'total_value',
      breakdown,
    }).catch(() => NO_INSIGHTS);
    return (r.data?.[0]?.total_value?.breakdowns?.[0]?.results ?? [])
      .map((x) => ({ label: x.dimension_values?.[0] ?? '?', value: x.value ?? 0 }))
      .sort((a, b) => b.value - a.value);
  };
  const [ages, genders, cities] = await Promise.all([part('age'), part('gender'), part('city')]);
  if (!ages.length && !genders.length && !cities.length) return null;
  return {
    ages: [...ages].sort((a, b) => a.label.localeCompare(b.label)),
    genders: genders.map((g) => ({ ...g, label: GENDER_LABEL[g.label] ?? g.label })),
    cities: cities.slice(0, 8).map((c) => ({ ...c, label: c.label.split(',')[0]!.trim() })),
  };
}

// ─── Публикация ──────────────────────────────────────────────────────────────

const doneMedia = (post: Pick<SmmPost, 'media'>): SmmMedia[] =>
  post.media.filter((m) => m.status === 'done' && m.selected && m.url).sort((a, b) => a.sort - b.sort);

/**
 * Площадка Instagram профиля включена: строка подключённого аккаунта есть и не выключена. Выключили площадку или
 * удалили её — маркетолог сам не публикует (ключ при удалении снимается в routes/smm-settings.ts).
 */
function accountActive(ctx: AppContext, profile: SmmProfile, username: string): boolean {
  const rows = ctx.db
    .select({ handle: smmAccounts.handle, isActive: smmAccounts.isActive })
    .from(smmAccounts)
    .where(and(eq(smmAccounts.profile, profile), eq(smmAccounts.platform, 'instagram')))
    .all();
  const name = username.toLowerCase();
  return rows.some((r) => r.isActive && r.handle?.replace(/^@/, '').toLowerCase() === name);
}

/** Какие файлы публикации уйдут в Instagram: пост — первый, карусель и сторис — до 10, рилс — первое видео. */
function publishedMedia(post: Pick<SmmPost, 'format' | 'media'>): SmmMedia[] {
  const media = doneMedia(post);
  if (post.format === 'reel') return media.filter((m) => m.kind === 'video').slice(0, 1);
  if (post.format === 'post') return media.slice(0, 1);
  return media.slice(0, CAROUSEL_MAX);
}

/**
 * Может ли маркетолог выложить эту публикацию сам (иначе — человеку файлы и текст): ключ есть, площадка включена,
 * визуал на месте (рилс — с видео) и все картинки — JPEG: PNG и WebP Instagram отвергнет уже в момент выхода.
 */
export async function instagramCanPublish(ctx: AppContext, post: Pick<SmmPost, 'profile' | 'platform' | 'format' | 'media'>): Promise<boolean> {
  if (post.platform !== 'instagram') return false;
  const state = await instagramState(ctx, post.profile);
  if (!state || !accountActive(ctx, post.profile, state.username)) return false;
  const media = publishedMedia(post);
  if (!media.length) return false;
  const checks = await Promise.all(media.map((m) => isJpegOrNotOurs(ctx, m)));
  return checks.every(Boolean);
}

const JPEG_MAGIC = [0xff, 0xd8, 0xff];
/** Наши файлы не меняются (новое содержимое — новое имя), поэтому ответ «JPEG ли» можно помнить. */
const jpegCache = new Map<string, boolean>();
const JPEG_CACHE_MAX = 2000;

async function readHead(file: string): Promise<Buffer | null> {
  return fs
    .open(file, 'r')
    .then(async (handle) => {
      try {
        const buffer = Buffer.alloc(JPEG_MAGIC.length);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        return buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    })
    .catch(() => null);
}

/**
 * Картинка — JPEG (по подписи файла). Видео, чужие ссылки и непрочитанные файлы не браковываем: о них скажет сам
 * Instagram, как и раньше.
 */
async function isJpegOrNotOurs(ctx: AppContext, media: SmmMedia): Promise<boolean> {
  if (media.kind !== 'image') return true;
  const file = smmFilePath(ctx, media.url!);
  if (!file) return true;
  const known = jpegCache.get(file);
  if (known !== undefined) return known;
  const head = await readHead(file);
  if (!head) return true;
  const jpeg = head.length === JPEG_MAGIC.length && JPEG_MAGIC.every((b, i) => head[i] === b);
  if (jpegCache.size >= JPEG_CACHE_MAX) jpegCache.clear();
  jpegCache.set(file, jpeg);
  return jpeg;
}

/** Картинки Instagram берёт только в JPEG — проверяем заранее, чтобы ошибка была понятной. */
async function assertJpeg(ctx: AppContext, media: SmmMedia): Promise<void> {
  if (!(await isJpegOrNotOurs(ctx, media))) {
    throw new SmmError('Instagram принимает картинки только в JPEG — замените картинку (новый вариант или своё фото)', 400);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitReady(ctx: AppContext, tok: string, containerId: string, video: boolean): Promise<void> {
  const deadline = Date.now() + (video ? VIDEO_WAIT_MS : IMAGE_WAIT_MS);
  while (Date.now() < deadline) {
    const r = await graph<{ status_code?: string }>(ctx, tok, `/${containerId}`, { fields: 'status_code' });
    if (r.status_code === 'FINISHED' || r.status_code === 'PUBLISHED') return;
    if (r.status_code === 'ERROR' || r.status_code === 'EXPIRED') {
      throw new SmmError('Instagram не смог обработать файл — проверьте формат видео или картинки', 502);
    }
    await sleep(POLL_MS);
  }
  throw new SmmError('Instagram слишком долго обрабатывает видео — попробуйте опубликовать ещё раз через пару минут', 502);
}

async function container(ctx: AppContext, tok: string, igId: string, media: SmmMedia, extra: GraphParams): Promise<string> {
  const url = publicMediaUrl(ctx, media.url!);
  const r = await graph<{ id: string }>(
    ctx,
    tok,
    `/${igId}/media`,
    media.kind === 'video' ? { video_url: url, ...extra } : { image_url: url, ...extra },
    'POST',
  );
  return r.id;
}

async function publishContainer(ctx: AppContext, tok: string, igId: string, creationId: string): Promise<string> {
  const r = await graph<{ id: string }>(ctx, tok, `/${igId}/media_publish`, { creation_id: creationId }, 'POST');
  return r.id;
}

async function permalink(ctx: AppContext, tok: string, mediaId: string, fallback: string): Promise<string> {
  const r = await graph<{ permalink?: string }>(ctx, tok, `/${mediaId}`, { fields: 'permalink' }).catch(() => ({ permalink: undefined }));
  return r.permalink ?? fallback;
}

/** Выложить в Instagram профиля: пост, карусель (до 10), рилс (нужно видео) или сторис (каждый кадр отдельно). */
export async function publishToInstagram(ctx: AppContext, post: SmmPost): Promise<{ mediaId: string; url: string }> {
  const state = await instagramState(ctx, post.profile);
  if (!state) throw new SmmError('Instagram не подключён — вставьте ключ в настройках СММ', 400);
  const tok = token(ctx, post.profile);
  const igId = state.userId;
  const caption = plainText(post.body).slice(0, CAPTION_MAX);
  const media = doneMedia(post);
  const profileUrl = `https://www.instagram.com/${state.username}/`;

  if (post.format === 'reel') {
    const video = media.find((m) => m.kind === 'video');
    if (!video) throw new SmmError('Для рилс нужно видео — загрузите снятое в публикацию', 400);
    const id = await container(ctx, tok, igId, video, { media_type: 'REELS', caption });
    await waitReady(ctx, tok, id, true);
    const mediaId = await publishContainer(ctx, tok, igId, id);
    return { mediaId, url: await permalink(ctx, tok, mediaId, profileUrl) };
  }

  if (post.format === 'story') {
    if (!media.length) throw new SmmError('В сторис нет кадров', 400);
    let first: string | null = null;
    for (const m of media.slice(0, CAROUSEL_MAX)) {
      await assertJpeg(ctx, m);
      const id = await container(ctx, tok, igId, m, { media_type: 'STORIES' });
      await waitReady(ctx, tok, id, m.kind === 'video');
      const mediaId = await publishContainer(ctx, tok, igId, id);
      first ??= mediaId;
    }
    return { mediaId: first!, url: `https://www.instagram.com/stories/${state.username}/` };
  }

  if (!media.length) throw new SmmError('Нет картинки — Instagram не публикует пост без фото', 400);
  if (media.length === 1 || post.format === 'post') {
    const m = media[0]!;
    await assertJpeg(ctx, m);
    const id = await container(ctx, tok, igId, m, m.kind === 'video' ? { media_type: 'REELS', caption } : { caption });
    await waitReady(ctx, tok, id, m.kind === 'video');
    const mediaId = await publishContainer(ctx, tok, igId, id);
    return { mediaId, url: await permalink(ctx, tok, mediaId, profileUrl) };
  }

  const items = media.slice(0, CAROUSEL_MAX);
  const children: string[] = [];
  for (const m of items) {
    await assertJpeg(ctx, m);
    const id = await container(ctx, tok, igId, m, { is_carousel_item: true, ...(m.kind === 'video' ? { media_type: 'VIDEO' } : {}) });
    await waitReady(ctx, tok, id, m.kind === 'video');
    children.push(id);
  }
  const carousel = await graph<{ id: string }>(ctx, tok, `/${igId}/media`, { media_type: 'CAROUSEL', children: children.join(','), caption }, 'POST');
  await waitReady(ctx, tok, carousel.id, false);
  const mediaId = await publishContainer(ctx, tok, igId, carousel.id);
  return { mediaId, url: await permalink(ctx, tok, mediaId, profileUrl) };
}
