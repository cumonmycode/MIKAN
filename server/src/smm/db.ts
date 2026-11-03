/**
 * Хранилище раздела «СММ» (drizzle по таблицам schema-smm.ts): публикации с медиа, планы, замечания, память,
 * площадки, отчёты. У каждого профиля всё своё: списки фильтруются по `profile`, строки по id несут свой профиль.
 *
 * Время в базе — миллисекунды, наружу — ISO-строки. Даты в патчах и `New*` — ISO-строки, как в Titan; перевод в
 * мс — здесь (неверная дата — SmmError 400). JSON лежит текстом в `*_json`: битый — значение по умолчанию.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { employees, smmAccounts, smmComments, smmMedia, smmMemory, smmPlans, smmPosts, smmReports } from '../db/schema.js';
import { parseInstant, toIso } from '../lib/time.js';
import {
  ACCOUNT_PLATFORMS,
  FORMATS,
  isProfile,
  MEMORY_KINDS,
  SmmError,
  STATUSES,
  type ReelScript,
  type SmmAccount,
  type SmmBusy,
  type SmmComment,
  type SmmForecast,
  type SmmMedia,
  type SmmMemory,
  type SmmMemoryKind,
  type SmmPlan,
  type SmmPost,
  type SmmPostStats,
  type SmmProfile,
  type SmmProgress,
  type SmmReport,
} from './types.js';

type PostDbRow = typeof smmPosts.$inferSelect;
type PostInsert = typeof smmPosts.$inferInsert;
type MediaDbRow = typeof smmMedia.$inferSelect;
type PlanDbRow = typeof smmPlans.$inferSelect;
type CommentDbRow = typeof smmComments.$inferSelect;
type MemoryDbRow = typeof smmMemory.$inferSelect;
export type AccountDbRow = typeof smmAccounts.$inferSelect;
export type ReportDbRow = typeof smmReports.$inferSelect;

/** Пост занят дольше — работа считается зависшей, пост можно занять снова. */
export const POST_STALE_MS = 10 * 60_000;
export const PLAN_STALE_MS = 15 * 60_000;
/** Видео нейросеть делает не дольше этого: дальше — в ошибку, пост не держит. */
export const VIDEO_GIVE_UP_MS = 40 * 60_000;
const POSTS_LIMIT = 400;
const MEMORY_LIMIT = 200;
const UUID_RE = /^[0-9a-f-]{36}$/i;

/** Строки сырого запроса: `ctx.db.all(sql…)` отдаёт массив сразу; оставлено для кода, перенесённого из Titan. */
export function rows<T = Record<string, unknown>>(res: unknown): T[] {
  return (Array.isArray(res) ? res : ((res as { rows?: T[] } | null)?.rows ?? [])) as T[];
}

/** ISO-строка из мс, Date или строки даты; пусто или неверно — null. */
export const iso = (v: unknown): string | null => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? toIso(v) : null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** JSON из текста: битый, пустой или не той формы (объект / массив) — значение по умолчанию. */
function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== 'object') return fallback;
    if (Array.isArray(value) !== Array.isArray(fallback)) return fallback;
    return value as T;
  } catch {
    return fallback;
  }
}

const oneOf = <T extends string>(list: readonly T[], value: string | null, fallback: T): T =>
  value != null && (list as readonly string[]).includes(value) ? (value as T) : fallback;

/** Мс из ISO-строки даты; неверная — ошибка проверки. */
function msOf(value: string): number {
  const ms = parseInstant(value);
  if (ms == null) throw new SmmError(`Неверная дата: ${value.slice(0, 40)}`, 400);
  return ms;
}

/** undefined — поле не меняется, null — очистить. */
function msPatch(value: string | null | undefined): number | null | undefined {
  return value == null ? value : msOf(value);
}

function jsonPatch(value: object | undefined): string | undefined;
function jsonPatch(value: object | null | undefined): string | null | undefined;
function jsonPatch(value: object | null | undefined): string | null | undefined {
  return value == null ? value : JSON.stringify(value);
}

/** Только заданные поля: undefined не попадает в UPDATE. */
function defined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

const profileOf = (value: string): SmmProfile => (isProfile(value) ? value : 'studio');

// ─── Публикации ──────────────────────────────────────────────────────────────

function mapMedia(r: MediaDbRow): SmmMedia {
  return {
    id: r.id,
    kind: r.kind === 'video' ? 'video' : 'image',
    source: r.source === 'upload' || r.source === 'archive' ? r.source : 'ai',
    status: oneOf(['pending', 'done', 'failed'] as const, r.status, 'done'),
    url: r.url,
    aspect: r.aspect,
    prompt: r.prompt,
    model: r.model,
    costRub: Number(r.costRub) || 0,
    error: r.error,
    selected: r.selected,
    sort: r.sort,
    createdAt: toIso(r.createdAt),
  };
}

/**
 * «Занят» — только пока работа свежая: зависшую (сервер перезапускался посреди работы) наружу не отдаём, иначе
 * приложение ждёт вечно, а одобрение упирается в «ещё работает». Сроки те же, что у повторного захвата; видео —
 * пока нейросеть его делает (до 40 минут), а до заказа видео (сцена, первый кадр) — как любая работа.
 */
function liveBusy(r: Pick<PostDbRow, 'busy' | 'busyAt'>, media: SmmMedia[], now = Date.now()): SmmBusy | null {
  const busy = (r.busy as SmmBusy | null) ?? null;
  if (!busy) return null;
  if (busy === 'video') {
    const pending = media.filter((m) => m.kind === 'video' && m.status === 'pending');
    if (pending.length) return pending.some((m) => now - Date.parse(m.createdAt) <= VIDEO_GIVE_UP_MS) ? busy : null;
  }
  return r.busyAt != null && now - r.busyAt <= POST_STALE_MS ? busy : null;
}

function mapPost(r: PostDbRow, assigneeName: string | null, media: SmmMedia[]): SmmPost {
  const busy = liveBusy(r, media);
  return {
    id: r.id,
    profile: profileOf(r.profile),
    planId: r.planId,
    accountId: r.accountId,
    platform: r.platform === 'instagram' ? 'instagram' : 'telegram',
    format: oneOf(FORMATS, r.format, 'post'),
    status: oneOf(STATUSES, r.status, 'idea'),
    publishAt: toIso(r.publishAt),
    topic: r.topic,
    pillar: r.pillar,
    direction: r.direction,
    brief: r.brief,
    body: r.body,
    visual: r.visual,
    script: parseJson<ReelScript | null>(r.scriptJson, null),
    assigneeId: r.assigneeId,
    assigneeName,
    approvedBy: r.approvedBy,
    approvedAt: toIso(r.approvedAt),
    handoffAt: toIso(r.handoffAt),
    publishedAt: toIso(r.publishedAt),
    publishedUrl: r.publishedUrl,
    stats: parseJson<SmmPostStats>(r.statsJson, {}),
    statsAt: toIso(r.statsAt),
    busy,
    progress: busy ? parseJson<SmmProgress | null>(r.progressJson, null) : null,
    error: r.error,
    media,
    forecast: parseJson<SmmForecast | null>(r.forecastJson, null),
    extId: r.extId,
    createdAt: toIso(r.createdAt),
    updatedAt: toIso(r.updatedAt),
  };
}

/** Пост с именем выкладывающего (сотрудник MIKAN). */
function selectPosts(ctx: AppContext) {
  return ctx.db
    .select({ post: smmPosts, assigneeName: employees.name })
    .from(smmPosts)
    .leftJoin(employees, eq(employees.id, smmPosts.assigneeId));
}

type PostWithName = { post: PostDbRow; assigneeName: string | null };

function withMedia(ctx: AppContext, list: PostWithName[], allMedia = false): SmmPost[] {
  if (!list.length) return [];
  const ids = list.map((r) => r.post.id);
  const visible = allMedia ? undefined : or(eq(smmMedia.selected, true), eq(smmMedia.status, 'pending'));
  const media = ctx.db
    .select()
    .from(smmMedia)
    .where(and(inArray(smmMedia.postId, ids), visible))
    // Варианты одной позиции, созданные в одну миллисекунду, — в порядке добавления.
    .orderBy(asc(smmMedia.sort), asc(smmMedia.createdAt), sql`rowid`)
    .all();
  const byPost = new Map<string, SmmMedia[]>();
  for (const m of media) byPost.set(m.postId, [...(byPost.get(m.postId) ?? []), mapMedia(m)]);
  return list.map((r) => mapPost(r.post, r.assigneeName, byPost.get(r.post.id) ?? []));
}

export async function loadPost(ctx: AppContext, id: string, allMedia = false): Promise<SmmPost | null> {
  if (!UUID_RE.test(id)) return null;
  const row = selectPosts(ctx).where(eq(smmPosts.id, id)).get();
  if (!row) return null;
  return withMedia(ctx, [row], allMedia)[0] ?? null;
}

/** Публикации в окне дат (по времени выхода); без даты — в конце. Без `profile` — все профили. */
export async function listPosts(
  ctx: AppContext,
  opts: { profile?: SmmProfile; from?: string; to?: string; planId?: string; status?: string[] },
): Promise<SmmPost[]> {
  const where: SQL[] = [];
  if (opts.profile) where.push(eq(smmPosts.profile, opts.profile));
  if (opts.from) where.push(gte(smmPosts.publishAt, msOf(opts.from)));
  if (opts.to) where.push(lt(smmPosts.publishAt, msOf(opts.to)));
  if (opts.planId) where.push(eq(smmPosts.planId, opts.planId));
  if (opts.status?.length) where.push(inArray(smmPosts.status, opts.status));
  const list = selectPosts(ctx)
    .where(where.length ? and(...where) : undefined)
    .orderBy(sql`${smmPosts.publishAt} IS NULL`, asc(smmPosts.publishAt), asc(smmPosts.createdAt))
    .limit(POSTS_LIMIT)
    .all();
  return withMedia(ctx, list);
}

export interface PostPatch {
  planId?: string | null;
  accountId?: string | null;
  platform?: string;
  format?: string;
  status?: string;
  publishAt?: string | null;
  topic?: string;
  pillar?: string | null;
  direction?: string | null;
  brief?: string;
  body?: string;
  visual?: string;
  script?: ReelScript | null;
  assigneeId?: number | null;
  approvedBy?: number | null;
  approvedAt?: string | null;
  reviewSentAt?: string | null;
  handoffAt?: string | null;
  remindedAt?: string | null;
  remindCount?: number;
  publishedAt?: string | null;
  publishedUrl?: string | null;
  tgMessageId?: number | null;
  stats?: SmmPostStats;
  statsAt?: string | null;
  busy?: SmmBusy | null;
  progress?: SmmProgress | null;
  forecast?: SmmForecast | null;
  extId?: string | null;
  error?: string | null;
}

function postColumns(p: PostPatch): Partial<PostInsert> {
  return defined({
    planId: p.planId,
    accountId: p.accountId,
    platform: p.platform,
    format: p.format,
    status: p.status,
    publishAt: msPatch(p.publishAt),
    topic: p.topic,
    pillar: p.pillar,
    direction: p.direction,
    brief: p.brief,
    body: p.body,
    visual: p.visual,
    scriptJson: jsonPatch(p.script),
    assigneeId: p.assigneeId,
    approvedBy: p.approvedBy,
    approvedAt: msPatch(p.approvedAt),
    reviewSentAt: msPatch(p.reviewSentAt),
    handoffAt: msPatch(p.handoffAt),
    remindedAt: msPatch(p.remindedAt),
    remindCount: p.remindCount,
    publishedAt: msPatch(p.publishedAt),
    publishedUrl: p.publishedUrl,
    tgMessageId: p.tgMessageId,
    statsJson: p.stats === undefined ? undefined : JSON.stringify(p.stats),
    statsAt: msPatch(p.statsAt),
    busy: p.busy,
    progressJson: jsonPatch(p.progress),
    forecastJson: jsonPatch(p.forecast),
    extId: p.extId,
    error: p.error,
  });
}

export async function updatePost(ctx: AppContext, id: string, patch: PostPatch): Promise<void> {
  const now = Date.now();
  const set: Partial<PostInsert> = {
    ...postColumns(patch),
    ...(patch.busy === undefined ? {} : { busyAt: patch.busy ? now : null }),
    // Работа закончилась — шкала уходит вместе с ней.
    ...(patch.busy === null && patch.progress === undefined ? { progressJson: null } : {}),
  };
  if (!Object.keys(set).length) return;
  ctx.db
    .update(smmPosts)
    .set({ ...set, updatedAt: now })
    .where(eq(smmPosts.id, id))
    .run();
}

export interface NewPost {
  profile: SmmProfile;
  planId?: string | null;
  accountId?: string | null;
  platform: string;
  format: string;
  status?: string;
  publishAt: string | null;
  topic: string;
  pillar?: string | null;
  direction?: string | null;
  brief?: string;
  visual?: string;
  assigneeId?: number | null;
  createdBy?: number | null;
}

export async function insertPost(ctx: AppContext, p: NewPost): Promise<string> {
  const id = randomUUID();
  const now = Date.now();
  ctx.db
    .insert(smmPosts)
    .values({
      id,
      profile: p.profile,
      planId: p.planId ?? null,
      accountId: p.accountId ?? null,
      platform: p.platform,
      format: p.format,
      status: p.status ?? 'idea',
      publishAt: p.publishAt == null ? null : msOf(p.publishAt),
      topic: p.topic,
      pillar: p.pillar ?? null,
      direction: p.direction ?? null,
      brief: p.brief ?? '',
      visual: p.visual ?? '',
      assigneeId: p.assigneeId ?? null,
      createdBy: p.createdBy ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return id;
}

export async function deletePost(ctx: AppContext, id: string): Promise<void> {
  ctx.db.delete(smmPosts).where(eq(smmPosts.id, id)).run();
}

/** Шкала готовности поста (без смены остального). */
export async function setPostProgress(ctx: AppContext, id: string, progress: SmmProgress): Promise<void> {
  ctx.db
    .update(smmPosts)
    .set({ progressJson: JSON.stringify(progress) })
    .where(and(eq(smmPosts.id, id), isNotNull(smmPosts.busy)))
    .run();
}

/**
 * Работа закончилась: ошибка (если есть) — в пост, а «занято» снимаем, только если пост занят именно этой работой
 * (зависший пост могла перехватить другая).
 */
export async function releasePost(ctx: AppContext, id: string, busy: SmmBusy, error?: string | null): Promise<void> {
  const now = Date.now();
  if (error !== undefined) ctx.db.update(smmPosts).set({ error, updatedAt: now }).where(eq(smmPosts.id, id)).run();
  ctx.db
    .update(smmPosts)
    .set({ busy: null, busyAt: null, progressJson: null, updatedAt: now })
    .where(and(eq(smmPosts.id, id), eq(smmPosts.busy, busy)))
    .run();
}

/**
 * Удалить публикации, если они всё ещё в одном из статусов и свободны: статус мог смениться, пока шла долгая работа
 * (план пишется минуты). Проверка и удаление — один запрос. Вернуть, сколько удалено.
 */
export async function deleteIdlePosts(ctx: AppContext, ids: string[], statuses: string[]): Promise<number> {
  if (!ids.length || !statuses.length) return 0;
  return ctx.db
    .delete(smmPosts)
    .where(and(inArray(smmPosts.id, ids), inArray(smmPosts.status, statuses), isNull(smmPosts.busy)))
    .run().changes;
}

/** Занять пост под работу маркетолога. false — уже занят (свежая работа идёт). */
export async function claimPost(ctx: AppContext, id: string, busy: SmmBusy): Promise<boolean> {
  const now = Date.now();
  const res = ctx.db
    .update(smmPosts)
    .set({ busy, busyAt: now, progressJson: null, error: null, updatedAt: now })
    .where(and(eq(smmPosts.id, id), or(isNull(smmPosts.busy), lt(smmPosts.busyAt, now - POST_STALE_MS))))
    .run();
  return res.changes > 0;
}

// ─── Медиа ───────────────────────────────────────────────────────────────────

export interface NewMedia {
  postId: string;
  kind: 'image' | 'video';
  source: 'ai' | 'upload' | 'archive';
  status: 'pending' | 'done' | 'failed';
  url?: string | null;
  aspect?: string | null;
  prompt?: string | null;
  model?: string | null;
  polzaId?: string | null;
  costRub?: number;
  sort?: number;
}

export async function insertMedia(ctx: AppContext, m: NewMedia): Promise<string> {
  const id = randomUUID();
  const now = Date.now();
  ctx.db
    .insert(smmMedia)
    .values({
      id,
      postId: m.postId,
      kind: m.kind,
      source: m.source,
      status: m.status,
      url: m.url ?? null,
      aspect: m.aspect ?? null,
      prompt: m.prompt ?? null,
      model: m.model ?? null,
      polzaId: m.polzaId ?? null,
      costRub: m.costRub ?? 0,
      sort: m.sort ?? 0,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return id;
}

export async function updateMedia(
  ctx: AppContext,
  id: string,
  patch: { status?: string; url?: string | null; costRub?: number; error?: string | null; polzaId?: string | null; selected?: boolean },
): Promise<void> {
  const set = defined({ ...patch });
  if (!Object.keys(set).length) return;
  ctx.db
    .update(smmMedia)
    .set({ ...set, updatedAt: Date.now() })
    .where(eq(smmMedia.id, id))
    .run();
}

/** Новый вариант в том же месте карусели: прежние варианты этой позиции снимаются. */
export async function unselectSlot(
  ctx: AppContext,
  postId: string,
  kind: 'image' | 'video',
  sort: number,
  keepId: string,
): Promise<void> {
  ctx.db
    .update(smmMedia)
    .set({ selected: false, updatedAt: Date.now() })
    .where(and(eq(smmMedia.postId, postId), eq(smmMedia.kind, kind), eq(smmMedia.sort, sort), ne(smmMedia.id, keepId)))
    .run();
}

/** Отметить, что медиа только что проверяли (очередь опроса видео идёт по кругу, от давно не проверенных). */
export async function touchMedia(ctx: AppContext, id: string): Promise<void> {
  ctx.db.update(smmMedia).set({ updatedAt: Date.now() }).where(eq(smmMedia.id, id)).run();
}

/**
 * Видео в работе у Polza (все профили; `profile` — для учёта расходов). Сначала давно не проверенные: каждый опрос
 * двигает `updatedAt`, так что десяток старых не загораживает новые.
 */
export async function pendingMedia(
  ctx: AppContext,
): Promise<{ id: string; postId: string; polzaId: string; kind: string; createdAt: string; profile: SmmProfile }[]> {
  return ctx.db
    .select({
      id: smmMedia.id,
      postId: smmMedia.postId,
      polzaId: smmMedia.polzaId,
      kind: smmMedia.kind,
      createdAt: smmMedia.createdAt,
      profile: smmPosts.profile,
    })
    .from(smmMedia)
    .innerJoin(smmPosts, eq(smmPosts.id, smmMedia.postId))
    .where(and(eq(smmMedia.status, 'pending'), isNotNull(smmMedia.polzaId)))
    .orderBy(asc(smmMedia.updatedAt), asc(smmMedia.createdAt))
    .limit(10)
    .all()
    .map((r) => ({ ...r, polzaId: r.polzaId ?? '', createdAt: toIso(r.createdAt), profile: profileOf(r.profile) }));
}

/** Медиа с постом и его профилем (медиа чужого профиля маршруты отдают как 404). */
export async function loadMedia(
  ctx: AppContext,
  id: string,
): Promise<(SmmMedia & { postId: string; profile: SmmProfile }) | null> {
  if (!UUID_RE.test(id)) return null;
  const row = ctx.db
    .select({ media: smmMedia, profile: smmPosts.profile })
    .from(smmMedia)
    .innerJoin(smmPosts, eq(smmPosts.id, smmMedia.postId))
    .where(eq(smmMedia.id, id))
    .get();
  return row ? { ...mapMedia(row.media), postId: row.media.postId, profile: profileOf(row.profile) } : null;
}

export async function deleteMedia(ctx: AppContext, id: string): Promise<void> {
  ctx.db.delete(smmMedia).where(eq(smmMedia.id, id)).run();
}

/** Следующая свободная позиция в публикации (новый файл встаёт последним). */
export async function nextSort(ctx: AppContext, postId: string): Promise<number> {
  const row = ctx.db
    .select({ next: sql<number>`coalesce(max(${smmMedia.sort}), -1) + 1` })
    .from(smmMedia)
    .where(eq(smmMedia.postId, postId))
    .get();
  return Number(row?.next ?? 0);
}

/** Убрать позицию целиком: выбранный файл и все его варианты. */
export async function deleteSlot(ctx: AppContext, postId: string, kind: 'image' | 'video', sort: number): Promise<void> {
  ctx.db
    .delete(smmMedia)
    .where(and(eq(smmMedia.postId, postId), eq(smmMedia.kind, kind), eq(smmMedia.sort, sort)))
    .run();
}

/**
 * Новый порядок позиций: `sorts` — прежние номера позиций в нужном порядке. Варианты картинки переезжают вместе
 * со своей позицией; не названные позиции встают в конец.
 */
export async function reorderSlots(ctx: AppContext, postId: string, sorts: number[]): Promise<void> {
  const all = ctx.db
    .selectDistinct({ sort: smmMedia.sort })
    .from(smmMedia)
    .where(eq(smmMedia.postId, postId))
    .orderBy(asc(smmMedia.sort))
    .all()
    .map((r) => r.sort);
  const order = [...new Set(sorts.filter((n) => all.includes(n))), ...all.filter((n) => !sorts.includes(n))];
  if (order.every((n, i) => n === all[i])) return;
  const cases = sql.join(
    order.map((n, i) => sql`WHEN ${n} THEN ${i}`),
    sql` `,
  );
  ctx.db
    .update(smmMedia)
    .set({ sort: sql`CASE ${smmMedia.sort} ${cases} END`, updatedAt: Date.now() })
    .where(eq(smmMedia.postId, postId))
    .run();
}

// ─── Планы ───────────────────────────────────────────────────────────────────

function mapPlan(r: PlanDbRow): SmmPlan {
  // Зависшую работу над планом (дольше срока повторного захвата) наружу не отдаём — как у постов.
  const busy = r.busy && r.busyAt != null && Date.now() - r.busyAt <= PLAN_STALE_MS ? (r.busy as SmmBusy) : null;
  return {
    id: r.id,
    profile: profileOf(r.profile),
    month: r.month,
    status: r.status === 'active' ? 'active' : 'draft',
    summary: r.summary,
    goals: parseJson<string[]>(r.goalsJson, []),
    pillars: parseJson<SmmPlan['pillars']>(r.pillarsJson, []),
    busy,
    progress: busy ? parseJson<SmmProgress | null>(r.progressJson, null) : null,
    error: r.error,
    updatedAt: toIso(r.updatedAt),
  };
}

export async function loadPlan(ctx: AppContext, profile: SmmProfile, month: string): Promise<SmmPlan | null> {
  const row = ctx.db
    .select()
    .from(smmPlans)
    .where(and(eq(smmPlans.profile, profile), eq(smmPlans.month, month)))
    .get();
  return row ? mapPlan(row) : null;
}

export async function loadPlanById(ctx: AppContext, id: string): Promise<SmmPlan | null> {
  const row = ctx.db.select().from(smmPlans).where(eq(smmPlans.id, id)).get();
  return row ? mapPlan(row) : null;
}

/** План месяца: есть — вернуть, нет — создать пустой черновик. */
export async function ensurePlan(ctx: AppContext, profile: SmmProfile, month: string): Promise<SmmPlan> {
  const now = Date.now();
  ctx.db
    .insert(smmPlans)
    .values({ id: randomUUID(), profile, month, createdAt: now, updatedAt: now })
    .onConflictDoNothing({ target: [smmPlans.profile, smmPlans.month] })
    .run();
  const plan = await loadPlan(ctx, profile, month);
  if (!plan) throw new Error(`smm: plan ${profile}/${month} was not created`);
  return plan;
}

export interface PlanPatch {
  status?: string;
  summary?: string;
  goals?: string[];
  pillars?: SmmPlan['pillars'];
  busy?: SmmBusy | null;
  progress?: SmmProgress;
  error?: string | null;
}

export async function updatePlan(ctx: AppContext, id: string, patch: PlanPatch): Promise<void> {
  const now = Date.now();
  const set: Partial<typeof smmPlans.$inferInsert> = {
    ...defined({
      status: patch.status,
      summary: patch.summary,
      goalsJson: jsonPatch(patch.goals),
      pillarsJson: jsonPatch(patch.pillars),
      progressJson: jsonPatch(patch.progress),
      error: patch.error,
    }),
    ...(patch.busy === undefined
      ? {}
      : patch.busy
        ? { busy: patch.busy, busyAt: now }
        : { busy: null, busyAt: null, progressJson: null }),
  };
  if (!Object.keys(set).length) return;
  ctx.db
    .update(smmPlans)
    .set({ ...set, updatedAt: now })
    .where(eq(smmPlans.id, id))
    .run();
}

export async function claimPlan(ctx: AppContext, id: string, busy: SmmBusy): Promise<boolean> {
  const now = Date.now();
  const res = ctx.db
    .update(smmPlans)
    .set({ busy, busyAt: now, progressJson: null, error: null, updatedAt: now })
    .where(and(eq(smmPlans.id, id), or(isNull(smmPlans.busy), lt(smmPlans.busyAt, now - PLAN_STALE_MS))))
    .run();
  return res.changes > 0;
}

// ─── Замечания ───────────────────────────────────────────────────────────────

function mapComment(r: CommentDbRow): SmmComment {
  return {
    id: r.id,
    postId: r.postId,
    planId: r.planId,
    authorName: r.authorName,
    role: r.role === 'ai' ? 'ai' : 'staff',
    text: r.text,
    createdAt: toIso(r.createdAt),
  };
}

export async function addComment(
  ctx: AppContext,
  c: {
    postId?: string | null;
    planId?: string | null;
    authorId?: number | null;
    authorName?: string | null;
    role: 'staff' | 'ai';
    text: string;
  },
): Promise<void> {
  ctx.db
    .insert(smmComments)
    .values({
      postId: c.postId ?? null,
      planId: c.planId ?? null,
      authorId: c.authorId ?? null,
      authorName: c.authorName ?? null,
      role: c.role,
      text: c.text.slice(0, 2000),
      createdAt: Date.now(),
    })
    .run();
}

/** Последние замечания по посту или плану, по порядку (старые сверху). */
export async function listComments(
  ctx: AppContext,
  by: { postId?: string; planId?: string },
  limit = 50,
): Promise<SmmComment[]> {
  const where = by.postId ? eq(smmComments.postId, by.postId) : by.planId ? eq(smmComments.planId, by.planId) : null;
  if (!where) return [];
  const list = ctx.db.select().from(smmComments).where(where).orderBy(desc(smmComments.id)).limit(limit).all();
  return list.reverse().map(mapComment);
}

// ─── Память маркетолога ──────────────────────────────────────────────────────

function mapMemory(r: MemoryDbRow): SmmMemory {
  return {
    id: r.id,
    kind: oneOf(MEMORY_KINDS, r.kind, 'rule'),
    text: r.text,
    source: oneOf(['staff', 'remark', 'analytics'] as const, r.source, 'staff'),
    createdAt: toIso(r.createdAt),
  };
}

export async function listMemory(ctx: AppContext, profile: SmmProfile): Promise<SmmMemory[]> {
  return ctx.db
    .select()
    .from(smmMemory)
    .where(eq(smmMemory.profile, profile))
    .orderBy(desc(smmMemory.createdAt))
    .limit(MEMORY_LIMIT)
    .all()
    .map(mapMemory);
}

/**
 * Запомнить, если такого в профиле ещё нет (одно и то же правило не копится). Регистр сравниваем в JS: `lower()`
 * SQLite не знает кириллицы. Проверка и вставка синхронны — между ними никто не вклинится.
 */
export async function remember(
  ctx: AppContext,
  profile: SmmProfile,
  m: { kind: SmmMemoryKind; text: string; source: SmmMemory['source']; authorId?: number | null },
): Promise<boolean> {
  const text = m.text.trim().slice(0, 400);
  if (!text) return false;
  const key = text.toLowerCase();
  const known = ctx.db.select({ text: smmMemory.text }).from(smmMemory).where(eq(smmMemory.profile, profile)).all();
  if (known.some((r) => r.text.toLowerCase() === key)) return false;
  ctx.db
    .insert(smmMemory)
    .values({
      id: randomUUID(),
      profile,
      kind: m.kind,
      text,
      source: m.source,
      authorId: m.authorId ?? null,
      createdAt: Date.now(),
    })
    .run();
  return true;
}

/** Забыть запись; с `profile` — только запись этого профиля (false — такой нет). */
export async function forget(ctx: AppContext, id: string, profile?: SmmProfile): Promise<boolean> {
  const where = profile ? and(eq(smmMemory.id, id), eq(smmMemory.profile, profile)) : eq(smmMemory.id, id);
  return ctx.db.delete(smmMemory).where(where).run().changes > 0;
}

// ─── Площадки ────────────────────────────────────────────────────────────────

export function mapAccount(r: AccountDbRow): SmmAccount {
  return {
    id: r.id,
    profile: profileOf(r.profile),
    platform: oneOf(ACCOUNT_PLATFORMS, r.platform, 'other'),
    title: r.title,
    url: r.url,
    handle: r.handle,
    canPublish: r.canPublish,
    isActive: r.isActive,
    followers: r.followers,
    stats: parseJson<Record<string, unknown>>(r.statsJson, {}),
    statsAt: toIso(r.statsAt),
    statsError: r.statsError,
  };
}

export interface AccountRow extends SmmAccount {
  tgChatId: string | null;
}

export async function listAccounts(ctx: AppContext, profile: SmmProfile): Promise<AccountRow[]> {
  return ctx.db
    .select()
    .from(smmAccounts)
    .where(eq(smmAccounts.profile, profile))
    .orderBy(asc(smmAccounts.platform), asc(smmAccounts.createdAt))
    .all()
    .map((r) => ({ ...mapAccount(r), tgChatId: r.tgChatId }));
}

/** Канал, куда маркетолог публикует сам: первый активный Telegram профиля с правом публикации. */
export async function publishChannel(ctx: AppContext, profile: SmmProfile): Promise<AccountRow | null> {
  const accounts = await listAccounts(ctx, profile);
  return accounts.find((a) => a.platform === 'telegram' && a.isActive && a.canPublish && a.tgChatId) ?? null;
}

// ─── Отчёты ──────────────────────────────────────────────────────────────────

export function mapReport(r: ReportDbRow): SmmReport {
  return {
    id: r.id,
    periodFrom: r.periodFrom.slice(0, 10),
    periodTo: r.periodTo.slice(0, 10),
    title: r.title,
    summary: r.summary,
    metrics: parseJson<SmmReport['metrics']>(r.metricsJson, []),
    recommendations: parseJson<SmmReport['recommendations']>(r.recommendationsJson, []),
    createdAt: toIso(r.createdAt),
  };
}

export async function listReports(ctx: AppContext, profile: SmmProfile, limit = 12): Promise<SmmReport[]> {
  return ctx.db
    .select()
    .from(smmReports)
    .where(eq(smmReports.profile, profile))
    .orderBy(desc(smmReports.createdAt))
    .limit(limit)
    .all()
    .map(mapReport);
}
