import { and, asc, eq, inArray, isNotNull, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { DateTime } from 'luxon';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { botChats, employees, smmPosts } from '../db/schema.js';
import { visibleTo } from '../domain/employee-visibility.js';
import { studioTimezone } from '../domain/settings.js';
import { errorMessage } from '../lib/errors.js';
import type { EmployeeRow } from '../lib/serialize.js';
import { DAY_MS } from '../lib/time.js';
import { parse } from '../lib/validation.js';
import { monthSpend, polzaBalance, smmModels } from '../smm/ai.js';
import { analyticsPayload } from '../smm/analytics.js';
import { studioDate, studioToIso } from '../smm/context.js';
import {
  claimPost,
  deletePost,
  deleteSlot,
  forget,
  insertPost,
  listAccounts,
  listComments,
  listMemory,
  listPosts,
  listReports,
  loadMedia,
  loadPlan,
  loadPost,
  remember,
  reorderSlots,
  unselectSlot,
  updateMedia,
  updatePlan,
  updatePost,
} from '../smm/db.js';
import { withForecast } from '../smm/forecast.js';
import { datesBetween } from '../smm/holidays.js';
import { addArchivePhoto, addUpload, regenerateImage } from '../smm/media.js';
import { generatePlanInBackground, revisePlanInBackground } from '../smm/planner.js';
import { directionsOf, FORMAT_LABEL, PLATFORM_LABEL } from '../smm/prompts.js';
import { generateReport } from '../smm/report.js';
import { getSmmSettings } from '../smm/settings.js';
import { collectStats } from '../smm/stats.js';
import { approvers } from '../smm/telegram.js';
import { FORMATS, isProfile, MEMORY_KINDS, PLATFORMS, PROFILES, SmmError, type SmmPost, type SmmProfile } from '../smm/types.js';
import { makePostVideoInBackground } from '../smm/video.js';
import { approvePost, markPublished, publishNow, restorePost, skipPost, withAuto, type Actor } from '../smm/workflow.js';
import { reviseInBackground, suggestIdeas, writePostInBackground } from '../smm/writer.js';

/**
 * SMM marketer API (docs/SMM.md), ported from Titan HUB `smm.router.ts`: the profiles, the feed of posts, the post card
 * with the marketer's edits, the month plan, ideas, memory, analytics and reports (settings, platforms and the photo
 * archive — routes/smm-settings.ts, the knowledge base — routes/smm-knowledge.ts). Every route lives under
 * `/smm/:profile` (`studio` | `author`, anything else is 404) and only sees rows of that profile. Any signed-in
 * employee may do everything (MIKAN has no roles).
 *
 * Long marketer jobs (plan, post, revision, picture, video) run in the background: the response comes at once and
 * the app watches `busy` (and the `progress` bar) and re-reads the post or plan.
 */

export const SMM_BASE = '/smm/:profile';
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const VIDEO_MAX_BYTES = 100 * 1024 * 1024;
const RECENT_DAYS = 3;
const UPCOMING_DAYS = 14;
const WEEK_MS = 7 * DAY_MS;

type Params = Record<string, string | undefined>;

export const param = (request: FastifyRequest, name: string): string => (request.params as Params)[name] ?? '';

/** `:profile` of the route; an unknown profile is a 404 like any other missing resource. */
export function profileOf(request: FastifyRequest): SmmProfile {
  const profile = param(request, 'profile');
  if (!isProfile(profile)) throw new SmmError('Раздел не найден', 404);
  return profile;
}

export const actorOf = (request: FastifyRequest): Actor => ({ id: request.employee.id, name: request.employee.name });

/** The single `file` field of a multipart request, read up to `maxBytes`. */
export async function readUpload(
  request: FastifyRequest,
  maxBytes: number,
  tooBig: string,
): Promise<{ data: Buffer; mime: string }> {
  if (!request.isMultipart()) throw new SmmError('Отправьте файл формой multipart/form-data (поле file)');
  const file = await request.file({ limits: { fileSize: maxBytes } });
  if (!file || file.fieldname !== 'file') {
    file?.file.resume();
    throw new SmmError('Нет файла: используйте поле «file»');
  }
  try {
    return { data: await file.toBuffer(), mime: file.mimetype.toLowerCase() };
  } catch (err) {
    if ((err as { code?: unknown }).code === 'FST_REQ_FILE_TOO_LARGE') throw new SmmError(tooBig);
    throw err;
  }
}

async function postOr404(ctx: AppContext, profile: SmmProfile, id: string, allMedia = false): Promise<SmmPost> {
  const post = await loadPost(ctx, id, allMedia);
  if (!post || post.profile !== profile) throw new SmmError('Публикация не найдена', 404);
  return post;
}

/** Posts for the app: "publishes itself" and the views forecast — one shape for every response. */
const decorate = async (ctx: AppContext, posts: SmmPost[]): Promise<SmmPost[]> =>
  withForecast(ctx, await withAuto(ctx, posts));

/** The post after an action; it vanished meanwhile (deleted, a plan rebuilt) — 404, never `{ post: null }`. */
export async function fresh(ctx: AppContext, id: string): Promise<{ post: SmmPost }> {
  const post = await loadPost(ctx, id, true);
  if (!post) throw new SmmError('Публикация не найдена', 404);
  return { post: (await decorate(ctx, [post]))[0] ?? post };
}

/** Review / awaiting-link / failed counters of a profile (the overview, the profile switcher, the badge). */
export function postCounts(ctx: AppContext, profile: SmmProfile) {
  const weekAgo = Date.now() - WEEK_MS;
  const p = smmPosts;
  const sumOf = (condition: SQL) => sql<number>`coalesce(sum(case when ${condition} then 1 else 0 end), 0)`;
  const row = ctx.db
    .select({
      review: sumOf(sql`${p.status} = 'review'`),
      awaitingLink: sumOf(sql`${p.status} = 'approved' and ${p.handoffAt} is not null and ${p.publishedUrl} is null`),
      failed: sumOf(sql`${p.status} = 'failed' and ${p.publishAt} > ${weekAgo}`),
      publishedWeek: sumOf(sql`${p.status} = 'published' and ${p.publishedAt} > ${weekAgo}`),
    })
    .from(p)
    .where(eq(p.profile, profile))
    .get();
  return {
    review: Number(row?.review ?? 0),
    awaitingLink: Number(row?.awaitingLink ?? 0),
    failed: Number(row?.failed ?? 0),
    publishedWeek: Number(row?.publishedWeek ?? 0),
  };
}

/**
 * Active employees for picking approvers and the publisher (the administrator account only for itself);
 * `telegram` — has a private chat with the bot.
 */
export function people(ctx: AppContext, viewer: Pick<EmployeeRow, 'id'>): { id: number; name: string; telegram: boolean }[] {
  const linked = new Set(
    ctx.db
      .select({ id: botChats.employeeId })
      .from(botChats)
      .where(isNotNull(botChats.employeeId))
      .all()
      .map((r) => r.id),
  );
  return ctx.db
    .select({ id: employees.id, name: employees.name, login: employees.login })
    .from(employees)
    .where(eq(employees.active, true))
    .orderBy(asc(employees.name))
    .all()
    .filter(visibleTo(ctx.config, viewer))
    .map((e) => ({ id: e.id, name: e.name, telegram: linked.has(e.id) }));
}

export function assertEmployees(ctx: AppContext, ids: number[]): void {
  const unique = [...new Set(ids)];
  if (!unique.length) return;
  const found = ctx.db.select({ id: employees.id }).from(employees).where(inArray(employees.id, unique)).all();
  if (found.length !== unique.length) throw new SmmError('Сотрудник не найден');
}

const isMonth = (v: string): boolean => /^\d{4}-(0[1-9]|1[0-2])$/.test(v);

function monthParam(request: FastifyRequest): string {
  const month = param(request, 'month');
  if (!isMonth(month)) throw new SmmError('Неверный месяц');
  return month;
}

/** `[from, to)` of a month in the studio timezone and its first and last calendar days. */
function monthBounds(ctx: AppContext, month: string) {
  const start = DateTime.fromISO(`${month}-01`, { zone: studioTimezone(ctx.db) }).startOf('month');
  const end = start.plus({ months: 1 });
  return {
    from: start.toJSDate().toISOString(),
    to: end.toJSDate().toISOString(),
    firstDay: `${month}-01`,
    lastDay: start.endOf('month').toISODate()!,
  };
}

const nextMonthOf = (month: string): string =>
  DateTime.fromISO(`${month}-01`, { zone: 'utc' }).plus({ months: 1 }).toFormat('yyyy-MM');

// ─── Schemas ─────────────────────────────────────────────────────────────────

const dateText = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timeText = z.string().regex(/^\d{1,2}:\d{2}$/);
const SwapSchema = z.object({ a: z.uuid(), b: z.uuid() });
const NewPostSchema = z.object({
  platform: z.enum(PLATFORMS),
  format: z.enum(FORMATS),
  date: dateText,
  time: timeText,
  topic: z.string().trim().min(2).max(160),
  brief: z.string().trim().max(800).optional(),
  direction: z.string().max(40).optional(),
  write: z.boolean().optional(),
});
const ShotSchema = z.object({
  text: z.string().max(400),
  seconds: z.number().optional(),
  overlay: z.string().max(120).optional(),
  sticker: z.string().max(160).optional(),
});
const ScriptSchema = z.object({
  hook: z.string().max(300),
  formula: z.string().max(120).optional(),
  shots: z.array(ShotSchema).max(12),
  audio: z.string().max(300).optional(),
  cast: z.string().max(300).optional(),
  tips: z.string().max(600).optional(),
});
const PatchSchema = z.object({
  topic: z.string().trim().min(2).max(160).optional(),
  brief: z.string().max(800).optional(),
  body: z.string().max(4000).optional(),
  date: dateText.optional(),
  time: timeText.optional(),
  platform: z.enum(PLATFORMS).optional(),
  format: z.enum(FORMATS).optional(),
  direction: z.string().max(40).nullable().optional(),
  assigneeId: z.number().int().positive().nullable().optional(),
  script: ScriptSchema.nullable().optional(),
});
const TextSchema = z.object({ text: z.string().trim().min(2).max(1500) });
const ImageSchema = z.object({ prompt: z.string().trim().max(4000).optional(), mediaId: z.uuid().optional() });
const VideoSchema = z.object({ prompt: z.string().trim().min(10).max(1900).optional() });
const SelectSchema = z.object({ selected: z.boolean() });
const OrderSchema = z.object({ sorts: z.array(z.number().int().min(0).max(999)).min(1).max(50) });
const ArchiveSchema = z.object({ photoId: z.string().min(10).max(80) });
const LinkSchema = z.object({
  url: z
    .string()
    .trim()
    .max(500)
    .refine((u) => /^https:\/\/\S+$/.test(u) && URL.canParse(u), { message: 'Нужна ссылка https://' }),
});
const WishesSchema = z.object({ wishes: z.string().trim().max(1500).optional() });
const IdeasSchema = z.object({
  direction: z.string().max(40).optional(),
  platform: z.enum(PLATFORMS).optional(),
  format: z.enum(FORMATS).optional(),
  wish: z.string().trim().max(500).optional(),
});
const MemorySchema = z.object({ kind: z.enum(MEMORY_KINDS), text: z.string().trim().min(3).max(400) });
const PeriodSchema = z.object({ from: dateText.optional(), to: dateText.optional() });

const BUSY = 'Маркетолог уже работает над публикацией';
const PUBLISHED = 'Публикация уже вышла — меняется только в самой соцсети';

export function smmRoutes(app: FastifyInstance, ctx: AppContext): void {
  const B = SMM_BASE;
  const logFailure = (err: unknown, what: string) => ctx.log.warn({ err: errorMessage(err) }, `smm: ${what} failed`);

  // ─── Profiles and people ───────────────────────────────────────────────────

  app.get('/smm/profiles', async () => ({
    items: PROFILES.map((profile) => {
      const settings = getSmmSettings(ctx.db, profile);
      const { review, awaitingLink, failed } = postCounts(ctx, profile);
      return { profile, brandName: settings.brandName, enabled: settings.enabled, review, awaitingLink, failed };
    }),
  }));

  app.get(`${B}/people`, async (request) => {
    profileOf(request);
    return { items: people(ctx, request.employee) };
  });

  // ─── Reference ─────────────────────────────────────────────────────────────

  app.get(`${B}/meta`, async (request) => {
    const settings = getSmmSettings(ctx.db, profileOf(request));
    return {
      directions: directionsOf(settings).map((d) => ({ key: d.key, label: d.title })),
      platforms: PLATFORMS.map((key) => ({ key, label: PLATFORM_LABEL[key] })),
      formats: FORMATS.map((key) => ({ key, label: FORMAT_LABEL[key] })),
      models: smmModels(ctx),
    };
  });

  // ─── Overview ──────────────────────────────────────────────────────────────

  app.get(`${B}/overview`, async (request) => {
    const profile = profileOf(request);
    const settings = getSmmSettings(ctx.db, profile);
    const month = studioDate(ctx).slice(0, 7);
    const nextMonth = nextMonthOf(month);
    const now = Date.now();
    const [posts, plan, nextPlan, accounts, reports, spent, balance, team] = await Promise.all([
      listPosts(ctx, {
        profile,
        from: new Date(now - RECENT_DAYS * DAY_MS).toISOString(),
        to: new Date(now + UPCOMING_DAYS * DAY_MS).toISOString(),
      }),
      loadPlan(ctx, profile, month),
      loadPlan(ctx, profile, nextMonth),
      listAccounts(ctx, profile),
      listReports(ctx, profile, 1),
      monthSpend(ctx, profile),
      polzaBalance(ctx),
      approvers(ctx, profile),
    ]);
    // "Not publishing" posts stay in the feed (greyed out) so they can be restored.
    const open = posts.filter((p) => p.status !== 'published' || Date.parse(p.publishedAt ?? '') > now - DAY_MS);
    return {
      month,
      nextMonth,
      upcoming: await decorate(ctx, open),
      counts: postCounts(ctx, profile),
      plan,
      nextPlan,
      accounts,
      lastReport: reports[0] ?? null,
      spend: { month: Math.round(spent), budget: settings.monthlyBudget },
      balance,
      ready: {
        channel: accounts.some((a) => a.platform === 'telegram' && a.canPublish && a.isActive),
        instagram: accounts.some((a) => a.platform === 'instagram' && a.isActive),
        publisher: !!settings.publisherId,
        approvers: team.filter((p) => p.chatId).length,
      },
      autopilot: settings.autopilot,
    };
  });

  // ─── Posts ─────────────────────────────────────────────────────────────────

  app.get(`${B}/posts`, async (request) => {
    const profile = profileOf(request);
    const { from, to } = request.query as { from?: string; to?: string };
    const valid = (v?: string) => !v || !Number.isNaN(Date.parse(v));
    if (!valid(from) || !valid(to)) throw new SmmError('Неверный период');
    return { posts: await decorate(ctx, await listPosts(ctx, { profile, from, to })) };
  });

  /** Swap the publish times of two posts (the order in the plan). */
  app.post(`${B}/posts/swap`, async (request) => {
    const profile = profileOf(request);
    const { a, b } = parse(SwapSchema, request.body);
    const [first, second] = await Promise.all([loadPost(ctx, a), loadPost(ctx, b)]);
    if (!first || !second || first.profile !== profile || second.profile !== profile) {
      throw new SmmError('Публикация не найдена', 404);
    }
    if (first.status === 'published' || second.status === 'published') throw new SmmError('Вышедшую публикацию не двигаем', 409);
    if (!first.publishAt || !second.publishAt) throw new SmmError('У публикации нет даты');
    // The time changed: a manual hand-off is redone at the new time.
    const reset = (p: SmmPost) => (p.handoffAt && !p.publishedUrl ? { handoffAt: null, remindCount: 0 } : {});
    await updatePost(ctx, first.id, { publishAt: second.publishAt, ...reset(first) });
    await updatePost(ctx, second.id, { publishAt: first.publishAt, ...reset(second) });
    return { ok: true };
  });

  app.post(`${B}/posts`, async (request) => {
    const profile = profileOf(request);
    const body = parse(NewPostSchema, request.body);
    const publishAt = studioToIso(ctx, body.date, body.time);
    if (!publishAt) throw new SmmError('Неверная дата или время');
    const plan = await loadPlan(ctx, profile, body.date.slice(0, 7));
    const id = await insertPost(ctx, {
      profile,
      planId: plan?.id ?? null,
      platform: body.platform,
      format: body.format,
      publishAt,
      topic: body.topic,
      brief: body.brief ?? '',
      direction: body.direction ?? null,
      createdBy: request.employee.id,
    });
    if (body.write) await writePostInBackground(ctx, id);
    return fresh(ctx, id);
  });

  app.get(`${B}/posts/:id`, async (request) => {
    const post = await postOr404(ctx, profileOf(request), param(request, 'id'), true);
    // Anyone signed in may approve in MIKAN; the field stays for the app.
    return { post: (await decorate(ctx, [post]))[0] ?? post, comments: await listComments(ctx, { postId: post.id }), canApprove: true };
  });

  /** Manual edit: text, time, who publishes. A published post only takes its link and numbers. */
  app.patch(`${B}/posts/:id`, async (request) => {
    const post = await postOr404(ctx, profileOf(request), param(request, 'id'));
    const body = parse(PatchSchema, request.body);
    if (post.status === 'published' && (body.body !== undefined || body.date || body.time || body.platform || body.format)) {
      throw new SmmError(PUBLISHED, 409);
    }
    if (body.assigneeId) assertEmployees(ctx, [body.assigneeId]);
    const local = post.publishAt ? DateTime.fromISO(post.publishAt).setZone(studioTimezone(ctx.db)) : null;
    const publishAt =
      body.date || body.time
        ? studioToIso(
            ctx,
            body.date ?? local?.toFormat('yyyy-MM-dd') ?? studioDate(ctx),
            body.time ?? local?.toFormat('HH:mm') ?? '12:00',
          )
        : undefined;
    if (publishAt === null) throw new SmmError('Неверная дата или время');
    const wrote = body.body !== undefined && post.status === 'idea' && body.body.trim();
    await updatePost(ctx, post.id, {
      topic: body.topic,
      brief: body.brief,
      body: body.body,
      publishAt,
      platform: body.platform,
      format: body.format,
      direction: body.direction,
      assigneeId: body.assigneeId,
      script: body.script,
      ...(wrote ? { status: 'review', reviewSentAt: new Date().toISOString() } : {}),
      // A manual publication moved: hand the files over again at the new time.
      ...(publishAt && post.handoffAt && !post.publishedUrl ? { handoffAt: null, remindCount: 0 } : {}),
    });
    return fresh(ctx, post.id);
  });

  app.delete(`${B}/posts/:id`, async (request) => {
    const post = await postOr404(ctx, profileOf(request), param(request, 'id'));
    if (post.status === 'published') throw new SmmError('Вышедшую публикацию не удаляем — она нужна аналитике', 409);
    await deletePost(ctx, post.id);
    return { ok: true };
  });

  /** The marketer writes (or rewrites from scratch) the text and the visual. */
  app.post(`${B}/posts/:id/write`, async (request) => {
    const post = await postOr404(ctx, profileOf(request), param(request, 'id'));
    if (post.status === 'published') throw new SmmError('Публикация уже вышла', 409);
    if (!(await writePostInBackground(ctx, post.id))) throw new SmmError(BUSY, 409);
    return fresh(ctx, post.id);
  });

  /** A remark on the post: the marketer redoes it and answers in the discussion. */
  app.post(`${B}/posts/:id/remark`, async (request) => {
    const post = await postOr404(ctx, profileOf(request), param(request, 'id'));
    const { text } = parse(TextSchema, request.body);
    if (!(await reviseInBackground(ctx, post.id, text, actorOf(request)))) throw new SmmError(BUSY, 409);
    return fresh(ctx, post.id);
  });

  /** A new picture variant (from its own description or the previous one). */
  app.post(`${B}/posts/:id/image`, async (request) => {
    const post = await postOr404(ctx, profileOf(request), param(request, 'id'));
    const body = parse(ImageSchema, request.body);
    if (!(await claimPost(ctx, post.id, 'image'))) throw new SmmError(BUSY, 409);
    void regenerateImage(ctx, post.id, body)
      .then(() => updatePost(ctx, post.id, { busy: null }))
      .catch((err) =>
        updatePost(ctx, post.id, {
          busy: null,
          error: `Картинка не получилась: ${errorMessage(err)}`.slice(0, 300),
        }),
      )
      .catch((err) => logFailure(err, 'picture'));
    return fresh(ctx, post.id);
  });

  /** A neural-network video: the marketer plans the scene, makes the first frame and starts it; ready in minutes. */
  app.post(`${B}/posts/:id/video`, async (request) => {
    const post = await postOr404(ctx, profileOf(request), param(request, 'id'));
    const { prompt } = parse(VideoSchema, request.body);
    if (post.media.some((m) => m.kind === 'video' && m.status === 'pending')) throw new SmmError('Видео уже делается', 409);
    if (!(await claimPost(ctx, post.id, 'video'))) throw new SmmError(BUSY, 409);
    makePostVideoInBackground(ctx, post.id, prompt);
    return fresh(ctx, post.id);
  });

  /** Own photo (≤ 10 MB) or video (≤ 100 MB) from the phone, e.g. a filmed reel. */
  app.post(`${B}/posts/:id/media`, async (request) => {
    const post = await postOr404(ctx, profileOf(request), param(request, 'id'));
    const { data, mime } = await readUpload(request, VIDEO_MAX_BYTES, 'Видео больше 100 МБ');
    if (mime.startsWith('image/') && data.length > IMAGE_MAX_BYTES) throw new SmmError('Фото больше 10 МБ');
    await addUpload(ctx, post.id, data, mime);
    return fresh(ctx, post.id);
  });

  async function mediaOf(request: FastifyRequest) {
    const post = await postOr404(ctx, profileOf(request), param(request, 'id'));
    const media = await loadMedia(ctx, param(request, 'mediaId'));
    if (!media || media.postId !== post.id) throw new SmmError('Файл не найден', 404);
    return { post, media };
  }

  /** Pick the picture variant of a slot (or take it out of the post). */
  app.patch(`${B}/posts/:id/media/:mediaId`, async (request) => {
    const { post, media } = await mediaOf(request);
    const { selected } = parse(SelectSchema, request.body);
    if (selected && media.kind === 'image') await unselectSlot(ctx, post.id, 'image', media.sort, media.id);
    await updateMedia(ctx, media.id, { selected });
    return fresh(ctx, post.id);
  });

  /** Remove a slot from the post: the file and all its variants. */
  app.delete(`${B}/posts/:id/media/:mediaId`, async (request) => {
    const { post, media } = await mediaOf(request);
    if (post.status === 'published') throw new SmmError(PUBLISHED, 409);
    if (media.status === 'pending') throw new SmmError('Файл ещё делается — уберите, когда будет готов', 409);
    await deleteSlot(ctx, post.id, media.kind, media.sort);
    return fresh(ctx, post.id);
  });

  /** Order of carousel slides and story frames: the previous slot numbers in the new order. */
  app.post(`${B}/posts/:id/media/order`, async (request) => {
    const post = await postOr404(ctx, profileOf(request), param(request, 'id'));
    const { sorts } = parse(OrderSchema, request.body);
    if (post.status === 'published') throw new SmmError(PUBLISHED, 409);
    await reorderSlots(ctx, post.id, sorts);
    return fresh(ctx, post.id);
  });

  /** A photo from the profile's archive, as is (cropped to the format). */
  app.post(`${B}/posts/:id/media/archive`, async (request) => {
    const post = await postOr404(ctx, profileOf(request), param(request, 'id'));
    const { photoId } = parse(ArchiveSchema, request.body);
    if (post.status === 'published') throw new SmmError(PUBLISHED, 409);
    await addArchivePhoto(ctx, post.id, photoId);
    return fresh(ctx, post.id);
  });

  app.post(`${B}/posts/:id/approve`, async (request) => {
    const post = await postOr404(ctx, profileOf(request), param(request, 'id'));
    await approvePost(ctx, post.id, actorOf(request));
    return fresh(ctx, post.id);
  });

  app.post(`${B}/posts/:id/skip`, async (request) => {
    const post = await postOr404(ctx, profileOf(request), param(request, 'id'));
    await skipPost(ctx, post.id);
    return fresh(ctx, post.id);
  });

  app.post(`${B}/posts/:id/restore`, async (request) => {
    const post = await postOr404(ctx, profileOf(request), param(request, 'id'));
    await restorePost(ctx, post.id);
    return fresh(ctx, post.id);
  });

  /** Now: Telegram (and Instagram via API) — to the platform; stories, reels, manual Instagram — to the publisher. */
  app.post(`${B}/posts/:id/publish`, async (request) => {
    const post = await postOr404(ctx, profileOf(request), param(request, 'id'));
    if (post.status !== 'approved') await approvePost(ctx, post.id, actorOf(request));
    await publishNow(ctx, post.id);
    return fresh(ctx, post.id);
  });

  app.post(`${B}/posts/:id/link`, async (request) => {
    const post = await postOr404(ctx, profileOf(request), param(request, 'id'));
    await markPublished(ctx, post.id, parse(LinkSchema, request.body).url);
    return fresh(ctx, post.id);
  });

  // ─── Month plan ────────────────────────────────────────────────────────────

  async function planPayload(profile: SmmProfile, month: string) {
    const plan = await loadPlan(ctx, profile, month);
    const range = monthBounds(ctx, month);
    return {
      plan,
      posts: await decorate(ctx, await listPosts(ctx, { profile, from: range.from, to: range.to })),
      comments: plan ? await listComments(ctx, { planId: plan.id }) : [],
      // Holidays and occasions of the month — labels for the plan's days.
      dates: await datesBetween(ctx, profile, range.firstDay, range.lastDay).catch(() => []),
    };
  }

  app.get(`${B}/plans/:month`, async (request) => planPayload(profileOf(request), monthParam(request)));

  app.post(`${B}/plans/:month/generate`, async (request) => {
    const profile = profileOf(request);
    const month = monthParam(request);
    const { wishes } = parse(WishesSchema, request.body);
    if (!(await generatePlanInBackground(ctx, profile, month, { wishes, author: actorOf(request) }))) {
      throw new SmmError('Маркетолог уже составляет этот план', 409);
    }
    return planPayload(profile, month);
  });

  app.post(`${B}/plans/:month/approve`, async (request) => {
    const profile = profileOf(request);
    const month = monthParam(request);
    const plan = await loadPlan(ctx, profile, month);
    if (!plan?.summary) throw new SmmError('Плана ещё нет', 404);
    await updatePlan(ctx, plan.id, { status: 'active' });
    return planPayload(profile, month);
  });

  app.post(`${B}/plans/:month/remark`, async (request) => {
    const profile = profileOf(request);
    const month = monthParam(request);
    const { text } = parse(TextSchema, request.body);
    if (!(await revisePlanInBackground(ctx, profile, month, text, actorOf(request)))) {
      throw new SmmError('Маркетолог уже работает с планом', 409);
    }
    return planPayload(profile, month);
  });

  // ─── Ideas and memory ──────────────────────────────────────────────────────

  app.post(`${B}/ideas`, async (request) => {
    const profile = profileOf(request);
    return { ideas: await suggestIdeas(ctx, profile, parse(IdeasSchema, request.body)) };
  });

  app.get(`${B}/memory`, async (request) => ({ memory: await listMemory(ctx, profileOf(request)) }));

  app.post(`${B}/memory`, async (request) => {
    const profile = profileOf(request);
    const body = parse(MemorySchema, request.body);
    await remember(ctx, profile, { kind: body.kind, text: body.text, source: 'staff', authorId: request.employee.id });
    return { memory: await listMemory(ctx, profile) };
  });

  app.delete(`${B}/memory/:memoryId`, async (request) => {
    const profile = profileOf(request);
    if (!(await forget(ctx, param(request, 'memoryId'), profile))) throw new SmmError('Не найдено', 404);
    return { memory: await listMemory(ctx, profile) };
  });

  // ─── Analytics and reports ─────────────────────────────────────────────────

  async function analyticsResponse(profile: SmmProfile) {
    const settings = getSmmSettings(ctx.db, profile);
    const [payload, spent] = await Promise.all([analyticsPayload(ctx, profile), monthSpend(ctx, profile)]);
    return { ...payload, spend: { month: Math.round(spent), budget: settings.monthlyBudget } };
  }

  app.get(`${B}/analytics`, async (request) => analyticsResponse(profileOf(request)));

  app.post(`${B}/analytics/collect`, async (request) => {
    const profile = profileOf(request);
    await collectStats(ctx, profile);
    return analyticsResponse(profile);
  });

  app.post(`${B}/reports/generate`, async (request) => {
    const profile = profileOf(request);
    const body = parse(PeriodSchema, request.body);
    const period = body.from && body.to ? { from: body.from, to: body.to } : undefined;
    return { report: await generateReport(ctx, profile, period) };
  });

  app.get(`${B}/reports/:reportId`, async (request) => {
    const profile = profileOf(request);
    const id = param(request, 'reportId');
    const report = (await listReports(ctx, profile, 50)).find((r) => r.id === id);
    if (!report) throw new SmmError('Отчёт не найден', 404);
    return { report };
  });
}
