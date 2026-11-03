/**
 * Жизненный цикл публикации и фоновая работа маркетолога по СММ (перенесено из Titan HUB, workflow.ts).
 *
 *  идея → (за reviewLeadHours до выхода, рилс — за 3 дня) маркетолог пишет текст и визуал →
 *  на одобрение: превью с кнопками в Telegram одобряющим профиля → одобрено →
 *  Telegram-пост (и Instagram по API) выходит сам в срок; остальное — маркетолог присылает
 *  файлы и текст выкладывающему и ждёт ссылку (напоминает, пока не пришлют).
 *
 * Крон раз в минуту по каждому включённому профилю: доводит видео, публикует, передаёт, напоминает,
 * готовит ближайшие посты. Раз в час — цифры свежих постов, раз в день — все цифры площадок и фотоархив,
 * по понедельникам — отчёт, по средам ночью — изучение соцсетей, 25-го — черновик плана на следующий месяц.
 * Отметку «сделано» эти работы ставят после успеха: сбой (нейросеть, бюджет) повторяется ещё пару раз за день, а
 * одобряющим профиля пишем один раз. Часы и даты — по часовому поясу студии. Push-уведомлений нет: всё, что нужно
 * людям, — в Telegram.
 *
 * Публикация сначала захватывается (статус «опубликовано»), потом уходит на площадку. Сервер остановили между
 * захватом и ответом площадки — в начале тика такая публикация без следа на площадке становится «не вышла».
 */
import { and, count, eq, isNotNull, isNull, lt, ne, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import type { AppContext } from '../context.js';
import { smmAccounts, smmMedia, smmPlans, smmPosts } from '../db/schema-smm.js';
import { readKey, studioTimezone, writeKey } from '../domain/settings.js';
import { errorMessage } from '../lib/errors.js';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '../lib/time.js';
import { smmApiKey } from './ai.js';
import {
  addComment,
  claimPlan,
  claimPost,
  ensurePlan,
  listPosts,
  loadPlan,
  loadPlanById,
  loadPost,
  updatePlan,
  updatePost,
} from './db.js';
import { freezeForecast } from './forecast.js';
import { instagramCanPublish, instagramState, publishToInstagram, refreshInstagramToken } from './instagram.js';
import { describePending, syncLibrary } from './library.js';
import { pollVideos } from './media.js';
import { generatePlan } from './planner.js';
import { generateReport } from './report.js';
import { getSmmSettings } from './settings.js';
import { collectStats } from './stats.js';
import { studyInBackground } from './study.js';
import { approvers, publisherFor, publishToChannel, sendHandoff, sendReviewTo, tell, whenText } from './telegram.js';
import { autoPublishes, PROFILES, SmmError, type SmmPost, type SmmProfile } from './types.js';
import { writePost } from './writer.js';

/** Как часто сервер зовёт smmTick. */
export const SMM_TICK_INTERVAL_MS = MINUTE_MS;

const MAX_REMINDERS = 4;
const REMIND_EVERY_MS = 3 * HOUR_MS;
const REEL_LEAD_HOURS = 72;
/** Опоздали с публикацией больше чем на столько — не публикуем молча, а сообщаем. */
const LATE_LIMIT_MS = 6 * HOUR_MS;
/** Ручную выкладку передаём человеку за столько до выхода. */
const HANDOFF_AHEAD_MS = 15 * MINUTE_MS;
/** Зависшая работа маркетолога и плана — снимаем «занято» (видео — когда его уже не делает нейросеть). */
const STALE_POST_MS = 12 * MINUTE_MS;
const STALE_PLAN_MS = 20 * MINUTE_MS;
const STALE_ERROR = 'Маркетолог не закончил — попробуйте ещё раз';
const STALE_VIDEO_ERROR = 'Видео не получилось — попробуйте ещё раз';
const MARKETER = 'маркетолог';
/** Идею, которую не удалось подготовить, крон не трогает столько — не жжём бюджет каждую минуту. */
const PREPARE_RETRY_MS = 45 * MINUTE_MS;
/** Сколько идей крон пробует подготовить за тик (удачная — одна, неудачные — до этого числа). */
const PREPARE_TRIES_PER_TICK = 3;
/** Захваченная, но так и не ушедшая на площадку публикация старше этого — прервалась (сервер останавливали). */
const INTERRUPTED_MS = 10 * MINUTE_MS;
const INTERRUPTED_ERROR = 'Публикация прервалась (сервер перезапускался) — проверьте площадку и опубликуйте заново, если поста там нет';
/** Плановая работа (отчёт, изучение, план): попыток за день и пауза между ними. */
const CRON_TRIES_PER_DAY = 3;
const CRON_RETRY_GAP_MS = 30 * MINUTE_MS;
/** К сообщению одобряющим — чей профиль (один человек может одобрять оба). */
const PROFILE_NOTE: Record<SmmProfile, string> = { studio: '', author: ' (личный профиль автора)' };

const iso = (ms: number) => new Date(ms).toISOString();
const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const platformTitle = (post: { platform: string }) => (post.platform === 'instagram' ? 'Instagram' : 'Telegram');

/** Сообщение всем одобряющим профиля (вместо push «владельцу» в Titan). */
async function tellApprovers(ctx: AppContext, profile: SmmProfile, html: string): Promise<void> {
  for (const person of await approvers(ctx, profile)) {
    if (person.chatId) await tell(ctx, person.chatId, html).catch(() => false);
  }
}

// ─── Кто выкладывает ─────────────────────────────────────────────────────────

/**
 * Выложит ли маркетолог сам: Telegram-пост и карусель — всегда; Instagram — если подключён
 * API и визуал на месте (рилс — с видео). Иначе — передача человеку.
 */
export async function canAutoPublish(ctx: AppContext, post: SmmPost): Promise<boolean> {
  return autoPublishes(post) || (await instagramCanPublish(ctx, post));
}

/** Отметить у публикаций, кто выкладывает, — приложению для статуса и кнопок. */
export async function withAuto(ctx: AppContext, posts: SmmPost[]): Promise<SmmPost[]> {
  const profiles = [...new Set(posts.map((p) => p.profile))];
  const states = await Promise.all(profiles.map(async (p) => [p, !!(await instagramState(ctx, p))] as const));
  const connected = new Map(states);
  return Promise.all(
    posts.map(async (p) => ({
      ...p,
      autoPublish: autoPublishes(p) || (!!connected.get(p.profile) && (await instagramCanPublish(ctx, p))),
    })),
  );
}

// ─── Действия ────────────────────────────────────────────────────────────────

export interface Actor {
  id: number | null;
  name: string;
}

async function postOrFail(ctx: AppContext, postId: string): Promise<SmmPost> {
  const post = await loadPost(ctx, postId);
  if (!post) throw new SmmError('Публикация не найдена', 404);
  return post;
}

/** Одобрить: Telegram-пост выйдет сам в срок (время прошло — сейчас), остальное передадим человеку. */
export async function approvePost(ctx: AppContext, postId: string, by: Actor): Promise<SmmPost> {
  const post = await postOrFail(ctx, postId);
  if (post.status === 'published') throw new SmmError('Уже опубликовано', 409);
  if (post.busy && post.busy !== 'video') throw new SmmError('Маркетолог ещё работает над публикацией — подождите минуту', 409);
  if (!post.body.trim()) throw new SmmError('Сначала маркетолог должен написать текст', 409);
  await updatePost(ctx, postId, { status: 'approved', approvedBy: by.id, approvedAt: new Date().toISOString(), error: null });
  const approved = (await loadPost(ctx, postId))!;
  // Рилс без видео — сразу задача на съёмку; снятое уже загружено — снимать нечего.
  const hasVideo = approved.media.some((m) => m.kind === 'video' && m.status === 'done');
  if (approved.format === 'reel' && !hasVideo) {
    await sendFilmingTask(ctx, approved).catch((err) =>
      ctx.log.warn({ err: errorMessage(err), postId }, 'smm: filming task not sent'),
    );
  }
  return approved;
}

export async function skipPost(ctx: AppContext, postId: string): Promise<void> {
  const post = await postOrFail(ctx, postId);
  if (post.status === 'published') throw new SmmError('Уже опубликовано', 409);
  await updatePost(ctx, postId, { status: 'skipped' });
}

/** Вернуть в работу пропущенную или неудавшуюся публикацию. */
export async function restorePost(ctx: AppContext, postId: string): Promise<void> {
  const post = await postOrFail(ctx, postId);
  await updatePost(ctx, postId, {
    status: post.body ? 'review' : 'idea',
    reviewSentAt: post.body ? new Date().toISOString() : null,
    error: null,
  });
}

/** Выложено: ссылка от человека (или найдена). */
export async function markPublished(ctx: AppContext, postId: string, url: string | null): Promise<SmmPost> {
  const post = await postOrFail(ctx, postId);
  await updatePost(ctx, postId, {
    status: 'published',
    publishedUrl: url ?? post.publishedUrl,
    publishedAt: post.publishedAt ?? new Date().toISOString(),
    error: null,
  });
  await freezeForecast(ctx, postId).catch(() => undefined);
  return (await loadPost(ctx, postId))!;
}

/**
 * Захват от двойной публикации (кнопка + крон в одну минуту): первый вызов переводит пост в «опубликовано»,
 * второй ничего не находит. SQLite выполняет UPDATE целиком, без гонки между проверкой и записью.
 */
function claimPublish(ctx: AppContext, postId: string): boolean {
  const now = Date.now();
  const claimed = ctx.db
    .update(smmPosts)
    .set({ status: 'published', publishedAt: now, updatedAt: now })
    .where(and(eq(smmPosts.id, postId), ne(smmPosts.status, 'published')))
    .returning({ id: smmPosts.id })
    .all();
  return claimed.length > 0;
}

/** Публикации, которые этот процесс сейчас отправляет на площадку: их не считаем прервавшимися. */
const publishing = new Set<string>();

/**
 * Опубликовать сейчас: Telegram — в канал (Instagram по API — в Instagram), остальное — сразу передать человеку.
 * Публикация одна: повторный вызов по уже вышедшему посту — ошибка.
 */
export async function publishNow(ctx: AppContext, postId: string): Promise<SmmPost> {
  const post = await postOrFail(ctx, postId);
  if (post.status === 'published') throw new SmmError('Уже опубликовано', 409);
  if (!post.body.trim()) throw new SmmError('Нет текста публикации', 409);
  if (!(await canAutoPublish(ctx, post))) {
    await handoff(ctx, post);
    return (await loadPost(ctx, postId))!;
  }
  if (!claimPublish(ctx, postId)) throw new SmmError('Уже опубликовано', 409);
  publishing.add(postId);
  try {
    if (post.platform === 'instagram') {
      const { mediaId, url } = await publishToInstagram(ctx, post);
      await updatePost(ctx, postId, { publishedUrl: url, extId: mediaId, error: null });
    } else {
      const { messageId, url } = await publishToChannel(ctx, post);
      await updatePost(ctx, postId, { tgMessageId: messageId, publishedUrl: url, error: null });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 300) : 'Не опубликовалось';
    await updatePost(ctx, postId, { status: 'failed', publishedAt: null, error: message });
    throw err;
  } finally {
    publishing.delete(postId);
  }
  await freezeForecast(ctx, postId).catch(() => undefined);
  return (await loadPost(ctx, postId))!;
}

/** Передать выкладывающему файлы и текст (Instagram без API, сторис, рилс). */
async function handoff(ctx: AppContext, post: SmmPost): Promise<void> {
  const settings = getSmmSettings(ctx.db, post.profile);
  const person = await publisherFor(ctx, post.profile, settings, post);
  if (!person) {
    throw new SmmError('Некому передать публикацию — назначьте, кто выкладывает Instagram, в настройках СММ', 400);
  }
  const sent = await sendHandoff(ctx, post, person);
  const now = new Date().toISOString();
  await updatePost(ctx, post.id, {
    handoffAt: now,
    remindedAt: now,
    remindCount: 0,
    assigneeId: post.assigneeId ?? person.id,
    error: sent ? null : `${person.name} не получил сообщение в Telegram — откройте публикацию в приложении`,
  });
}

function filmingSteps(post: SmmPost): string {
  const script = post.script;
  if (!script) return '';
  const shots = script.shots.map((s, i) => `${i + 1}. ${s.text}${s.overlay ? ` — текст «${s.overlay}»` : ''}`).join('\n');
  return [
    `\n\nЗацепка: ${script.hook}\n${shots}`,
    script.audio ? `\nЗвук: ${script.audio}` : '',
    script.cast ? `\nКто: ${script.cast}` : '',
    script.tips ? `\n💡 ${script.tips}` : '',
  ].join('');
}

/** Рилс одобрен — сразу задача на съёмку: снять нужно заранее. */
async function sendFilmingTask(ctx: AppContext, post: SmmPost): Promise<void> {
  const settings = getSmmSettings(ctx.db, post.profile);
  const person = await publisherFor(ctx, post.profile, settings, post);
  if (!person) return;
  await tell(
    ctx,
    person.chatId,
    `🎬 Нужно снять рилс к ${whenText(ctx, post.publishAt)}: <b>${escape(post.topic)}</b>${escape(filmingSteps(post))}\n\n` +
      'Снятое видео можно загрузить прямо в публикацию в приложении — я приложу его к подписи.',
  );
}

/** Отправить готовый пост на одобрение: превью с кнопками в Telegram одобряющим профиля. */
export async function requestReview(ctx: AppContext, raw: SmmPost): Promise<void> {
  const [post] = await withAuto(ctx, [raw]);
  if (!post) return;
  const people = await approvers(ctx, post.profile);
  const intro = post.status === 'approved' ? '🤖 Автопилот: выйдет сам, если не остановишь' : '📝 На одобрение';
  for (const person of people) {
    if (person.chatId) await sendReviewTo(ctx, post, person.chatId, intro).catch(() => false);
  }
  await updatePost(ctx, post.id, { reviewSentAt: new Date().toISOString() });
}

// ─── Крон ────────────────────────────────────────────────────────────────────

/** Идущий тик по базе: следующий не накладывается, остановка сервера его дожидается (smmIdle). */
const ticks = new WeakMap<object, Promise<void>>();

type CronJob = 'report' | 'study' | 'plan';

/** Неудача плановой работы: для какой отметки (день отчёта, месяц плана), в какой день, сколько раз и когда. */
interface CronFailure {
  key: string;
  day: string;
  count: number;
  at: number;
}

type CronMarks = {
  stats?: string;
  fresh?: string;
  report?: string;
  plan?: string;
  study?: string;
  failed?: Partial<Record<CronJob, CronFailure>>;
};

const CRON_WHAT: Record<CronJob, string> = {
  report: 'Не получился отчёт за неделю',
  study: 'Не получилось заново изучить соцсети',
  plan: 'Не получился план на следующий месяц',
};

const marksKey = (profile: SmmProfile) => `smm_cron:${profile}`;

function readMarks(ctx: AppContext, profile: SmmProfile): CronMarks {
  const raw = readKey<unknown>(ctx.db, marksKey(profile));
  return raw && typeof raw === 'object' ? (raw as CronMarks) : {};
}

function writeMarks(ctx: AppContext, profile: SmmProfile, marks: CronMarks): void {
  writeKey(ctx.db, marksKey(profile), marks);
}

/** Можно ли запускать работу: для этой отметки не исчерпаны попытки на сегодня и прошла пауза после неудачи. */
function mayTry(marks: CronMarks, job: CronJob, key: string, today: string): boolean {
  const failure = marks.failed?.[job];
  if (!failure || failure.key !== key) return true;
  if (failure.day === today && failure.count >= CRON_TRIES_PER_DAY) return false;
  return Date.now() - failure.at >= CRON_RETRY_GAP_MS;
}

/** Работа сделана — отметка ставится сейчас (а не до работы), прошлые неудачи забываются. */
function markDone(ctx: AppContext, profile: SmmProfile, job: CronJob, key: string): void {
  const marks = readMarks(ctx, profile);
  const failed = Object.fromEntries(Object.entries(marks.failed ?? {}).filter(([name]) => name !== job));
  writeMarks(ctx, profile, { ...marks, [job]: key, failed });
}

/** Работа не удалась: считаем попытку; одобряющим пишем один раз на отметку (не на каждый повтор). */
async function markFailed(ctx: AppContext, profile: SmmProfile, job: CronJob, key: string, today: string, err: unknown): Promise<void> {
  ctx.log.warn({ err: errorMessage(err), profile, job }, `smm: ${job} failed`);
  const marks = readMarks(ctx, profile);
  const prev = marks.failed?.[job];
  const sameKey = prev?.key === key;
  const count = sameKey && prev.day === today ? prev.count + 1 : 1;
  writeMarks(ctx, profile, { ...marks, failed: { ...marks.failed, [job]: { key, day: today, count, at: Date.now() } } });
  if (sameKey) return;
  await tellApprovers(
    ctx,
    profile,
    `❗ ${CRON_WHAT[job]}${PROFILE_NOTE[profile]}: ${escape(errorMessage(err).slice(0, 200))}\nПопробую ещё раз позже.`,
  );
}

/** Есть ли у профиля что-то от СММ — пустые профили крон не трогает. */
function smmInUse(ctx: AppContext, profile: SmmProfile): boolean {
  const plans = ctx.db.select({ n: count() }).from(smmPlans).where(eq(smmPlans.profile, profile)).get()?.n ?? 0;
  if (plans > 0) return true;
  return (ctx.db.select({ n: count() }).from(smmAccounts).where(eq(smmAccounts.profile, profile)).get()?.n ?? 0) > 0;
}

/** Ключ нейросетей на месте — без него шаги с нейросетью пропускаем, публикация и передача идут. */
async function aiReady(ctx: AppContext): Promise<boolean> {
  try {
    await smmApiKey(ctx);
    return true;
  } catch {
    return false;
  }
}

function resetStale(ctx: AppContext, profile: SmmProfile): void {
  const now = Date.now();
  const cleared = { busy: null, busyAt: null, progressJson: null, error: sql`coalesce(error, ${STALE_ERROR})`, updatedAt: now };
  ctx.db
    .update(smmPosts)
    .set(cleared)
    .where(
      and(
        eq(smmPosts.profile, profile),
        isNotNull(smmPosts.busy),
        ne(smmPosts.busy, 'video'),
        lt(smmPosts.busyAt, now - STALE_POST_MS),
      ),
    )
    .run();
  ctx.db
    .update(smmPlans)
    .set(cleared)
    .where(and(eq(smmPlans.profile, profile), isNotNull(smmPlans.busy), lt(smmPlans.busyAt, now - STALE_PLAN_MS)))
    .run();
  // «Занят видео», а видео в работе у нейросети нет (сцена или первый кадр оборвались) — тоже зависло.
  const videos = ctx.db
    .select({ id: smmPosts.id })
    .from(smmPosts)
    .where(and(eq(smmPosts.profile, profile), eq(smmPosts.busy, 'video'), lt(smmPosts.busyAt, now - STALE_POST_MS)))
    .all();
  for (const { id } of videos) {
    const pending = ctx.db
      .select({ id: smmMedia.id })
      .from(smmMedia)
      .where(and(eq(smmMedia.postId, id), eq(smmMedia.status, 'pending')))
      .get();
    if (pending) continue;
    ctx.db
      .update(smmPosts)
      .set({ ...cleared, error: sql`coalesce(error, ${STALE_VIDEO_ERROR})` })
      .where(and(eq(smmPosts.id, id), eq(smmPosts.busy, 'video')))
      .run();
  }
}

/**
 * Публикации, захваченные под выход, но без следа на площадке (нет номера сообщения, id в Instagram, ссылки и
 * передачи человеку), старше 10 минут и не отправляемые сейчас этим процессом: сервер остановили посреди публикации.
 * Их — в «не вышла», одобряющим — сообщение: пост мог и выйти, пусть проверят.
 */
async function recoverInterrupted(ctx: AppContext, profile: SmmProfile): Promise<void> {
  const ghost = and(
    eq(smmPosts.status, 'published'),
    isNull(smmPosts.tgMessageId),
    isNull(smmPosts.extId),
    isNull(smmPosts.publishedUrl),
    isNull(smmPosts.handoffAt),
  );
  const rows = ctx.db
    .select({ id: smmPosts.id, topic: smmPosts.topic, platform: smmPosts.platform })
    .from(smmPosts)
    .where(and(eq(smmPosts.profile, profile), ghost, lt(smmPosts.publishedAt, Date.now() - INTERRUPTED_MS)))
    .all();
  for (const row of rows) {
    if (publishing.has(row.id)) continue;
    const now = Date.now();
    const changed = ctx.db
      .update(smmPosts)
      .set({ status: 'failed', publishedAt: null, error: INTERRUPTED_ERROR, updatedAt: now })
      .where(and(eq(smmPosts.id, row.id), ghost))
      .run().changes;
    if (!changed) continue;
    ctx.log.warn({ postId: row.id, profile }, 'smm: interrupted publication marked failed');
    await tellApprovers(
      ctx,
      profile,
      `❗ Публикация прервалась: <b>${escape(row.topic)}</b>${PROFILE_NOTE[profile]}\nСервер перезапускался, пока пост уходил в ${platformTitle(row)}. ` +
        'Проверьте площадку: если поста там нет — опубликуйте заново в приложении.',
    );
  }
}

/** Опоздание больше 6 часов (сервер не работал) — не публикуем молча; если одобрили недавно — опоздание осознанное. */
function missedSlot(post: SmmPost, now = Date.now()): boolean {
  if (now - Date.parse(post.publishAt!) <= LATE_LIMIT_MS) return false;
  const approvedAt = post.approvedAt ? Date.parse(post.approvedAt) : Number.NaN;
  return !(now - approvedAt < LATE_LIMIT_MS);
}

async function publishDue(ctx: AppContext, due: SmmPost[]): Promise<void> {
  for (const post of due) {
    // Уже у человека (Instagram подключили после передачи) — второй раз не публикуем.
    if (post.handoffAt) continue;
    if (!(await canAutoPublish(ctx, post))) continue;
    if (missedSlot(post)) {
      await updatePost(ctx, post.id, {
        status: 'failed',
        error: 'Время выхода прошло, пока сервер не работал — опубликуйте вручную или перенесите',
      });
      continue;
    }
    try {
      await publishNow(ctx, post.id);
    } catch (err) {
      // Кнопка «Опубликовать» успела раньше крона — пост вышел, тревога не нужна.
      if (err instanceof SmmError && err.status === 409 && (await loadPost(ctx, post.id))?.status === 'published') continue;
      ctx.log.warn({ err: errorMessage(err), postId: post.id }, 'smm: scheduled post was not published');
      await tellApprovers(ctx, post.profile, `❗ Не вышел пост: <b>${escape(post.topic)}</b>\n${escape(errorMessage(err))}`);
    }
  }
}

async function handoffDue(ctx: AppContext, posts: SmmPost[]): Promise<void> {
  const soon = Date.now() + HANDOFF_AHEAD_MS;
  for (const post of posts.filter((p) => !p.handoffAt && p.publishAt && Date.parse(p.publishAt) <= soon)) {
    if (await canAutoPublish(ctx, post)) continue;
    await handoff(ctx, post).catch((err) =>
      updatePost(ctx, post.id, { error: err instanceof Error ? err.message : 'не передано' }),
    );
  }
}

async function remindLinks(ctx: AppContext, profile: SmmProfile, posts: SmmPost[]): Promise<void> {
  const due = ctx.db
    .select({ id: smmPosts.id, remindCount: smmPosts.remindCount })
    .from(smmPosts)
    .where(
      and(
        eq(smmPosts.profile, profile),
        eq(smmPosts.status, 'approved'),
        isNotNull(smmPosts.handoffAt),
        isNull(smmPosts.publishedUrl),
        lt(smmPosts.remindCount, MAX_REMINDERS),
        sql`coalesce(${smmPosts.remindedAt}, ${smmPosts.handoffAt}) < ${Date.now() - REMIND_EVERY_MS}`,
      ),
    )
    .all();
  const settings = getSmmSettings(ctx.db, profile);
  for (const row of due) {
    const post = posts.find((p) => p.id === row.id) ?? (await loadPost(ctx, row.id));
    if (!post) continue;
    const person = await publisherFor(ctx, profile, settings, post);
    const remindCount = row.remindCount + 1;
    if (person) await sendHandoff(ctx, post, person, 'remind');
    await updatePost(ctx, post.id, { remindedAt: new Date().toISOString(), remindCount });
    if (remindCount >= MAX_REMINDERS) {
      const who = person?.name ?? 'Выкладывающий';
      await tellApprovers(
        ctx,
        profile,
        `🔗 Нет ссылки: <b>${escape(post.topic)}</b>\n${escape(who)} так и не прислал ссылку — проверьте, вышла ли публикация`,
      );
    }
  }
}

async function reviewDue(ctx: AppContext, profile: SmmProfile): Promise<void> {
  const list = await listPosts(ctx, { profile, from: iso(Date.now()), status: ['review', 'approved'] });
  for (const post of list.filter((p) => !p.busy && p.body && !p.handoffAt && p.status !== 'published')) {
    const unsent = ctx.db
      .select({ id: smmPosts.id })
      .from(smmPosts)
      .where(and(eq(smmPosts.id, post.id), isNull(smmPosts.reviewSentAt), isNull(smmPosts.approvedAt)))
      .get();
    if (unsent) await requestReview(ctx, post);
  }
}

/** Идею недавно не удалось подготовить (ошибка записана в последние 45 минут) — пока не трогаем. */
const recentlyFailed = (post: SmmPost, now: number): boolean => !!post.error && now - Date.parse(post.updatedAt) < PREPARE_RETRY_MS;

/**
 * Подготовить одну ближайшую идею (по одной за тик — нейросеть не перегружаем). Не вышло — следующую (не больше
 * трёх попыток за тик), а неудавшуюся откладываем на 45 минут: одна сломанная идея не держит остальные и не
 * тратит бюджет каждую минуту. Кончились деньги (402) — до следующего тика не пробуем.
 */
async function prepareNext(ctx: AppContext, profile: SmmProfile): Promise<void> {
  const settings = getSmmSettings(ctx.db, profile);
  const now = Date.now();
  const horizon = iso(now + Math.max(settings.reviewLeadHours, REEL_LEAD_HOURS) * HOUR_MS);
  const ideas = await listPosts(ctx, { profile, from: iso(now + 30 * MINUTE_MS), to: horizon, status: ['idea'] });
  let tries = 0;
  for (const post of ideas) {
    if (tries >= PREPARE_TRIES_PER_TICK) return;
    if (post.busy || recentlyFailed(post, now)) continue;
    const lead = (post.format === 'reel' ? REEL_LEAD_HOURS : settings.reviewLeadHours) * HOUR_MS;
    if (Date.parse(post.publishAt!) - Date.now() > lead) continue;
    if (post.planId) {
      const plan = await loadPlanById(ctx, post.planId);
      if (plan?.status !== 'active') continue;
    }
    if (!(await claimPost(ctx, post.id, 'text'))) continue;
    tries += 1;
    try {
      await writePost(ctx, post.id);
      return;
    } catch (err) {
      ctx.log.warn({ err: errorMessage(err), postId: post.id }, 'smm: post preparation failed');
      if (err instanceof SmmError && err.status === 402) return;
    }
  }
}

const warn = (ctx: AppContext, profile: SmmProfile, what: string) => (err: unknown) =>
  ctx.log.warn({ err: errorMessage(err), profile }, `smm: ${what} failed`);

/** Описание новых фото идёт сразу по всем профилям: пока идёт одно, второе не запускаем (те же фото — двойная трата). */
const describing = new WeakSet<AppContext>();

async function describeOnce(ctx: AppContext): Promise<number> {
  if (describing.has(ctx)) return 0;
  describing.add(ctx);
  try {
    return await describePending(ctx);
  } finally {
    describing.delete(ctx);
  }
}

/** Раз в день (с 10:00) — все цифры площадок, ключ Instagram и фотоархив; иначе раз в час — свежие посты. */
async function dailyStats(ctx: AppContext, profile: SmmProfile, local: DateTime, ai: boolean): Promise<void> {
  const today = local.toISODate()!;
  const hourMark = local.toFormat("yyyy-MM-dd'T'HH");
  const marks = readMarks(ctx, profile);
  if (local.hour >= 10 && marks.stats !== today) {
    writeMarks(ctx, profile, { ...marks, stats: today, fresh: hourMark });
    await refreshInstagramToken(ctx, profile).catch(warn(ctx, profile, 'Instagram token refresh'));
    await collectStats(ctx, profile).catch(warn(ctx, profile, 'stats collection'));
    // Архив: новые альбомы и фото, затем описание новых (понемногу — дёшево).
    void syncLibrary(ctx, profile)
      .then(() => (ai ? describeOnce(ctx) : 0))
      .catch(warn(ctx, profile, 'library sync'));
  } else if (marks.fresh !== hourMark) {
    writeMarks(ctx, profile, { ...marks, fresh: hourMark });
    await collectStats(ctx, profile, { fresh: true }).catch(warn(ctx, profile, 'fresh stats'));
  }
}

/** По понедельникам (с 11:00) — отчёт за неделю, если что-то выходило. */
async function weeklyReport(ctx: AppContext, profile: SmmProfile, local: DateTime): Promise<void> {
  const today = local.toISODate()!;
  if (local.weekday !== 1 || local.hour < 11) return;
  const marks = readMarks(ctx, profile);
  if (marks.report === today || !mayTry(marks, 'report', today, today)) return;
  const published = await listPosts(ctx, { profile, from: iso(Date.now() - 8 * DAY_MS), status: ['published'] });
  if (!published.length) return;
  try {
    const report = await generateReport(ctx, profile);
    markDone(ctx, profile, 'report', today);
    await tellApprovers(ctx, profile, `📊 <b>${escape(report.title)}</b>\n${escape(report.summary.slice(0, 160))}`);
  } catch (err) {
    await markFailed(ctx, profile, 'report', today, today, err);
  }
}

/** Профили, которые маркетолог изучает по расписанию прямо сейчас (изучение идёт в фоне, минутами). */
const studying = new WeakMap<object, Set<SmmProfile>>();

function studyingNow(ctx: AppContext): Set<SmmProfile> {
  const set = studying.get(ctx.db) ?? new Set<SmmProfile>();
  studying.set(ctx.db, set);
  return set;
}

/**
 * По средам ночью (с 04:00) маркетолог заново изучает соцсети профиля и обновляет портрет. Изучение идёт в фоне:
 * отметку ставит его окончание, а пока идёт — следующий тик второе не запускает.
 */
async function weeklyStudy(ctx: AppContext, profile: SmmProfile, local: DateTime): Promise<void> {
  const today = local.toISODate()!;
  if (local.weekday !== 3 || local.hour < 4) return;
  const marks = readMarks(ctx, profile);
  const running = studyingNow(ctx);
  if (marks.study === today || running.has(profile) || !mayTry(marks, 'study', today, today)) return;
  running.add(profile);
  const finish = async (error: unknown): Promise<void> => {
    running.delete(profile);
    if (error === null) markDone(ctx, profile, 'study', today);
    else await markFailed(ctx, profile, 'study', today, today, error);
  };
  try {
    // Уже изучает (запустили из приложения) — свежий портрет будет и так.
    if (!(await studyInBackground(ctx, profile, 'socials', finish))) await finish(null);
  } catch (err) {
    await finish(err);
  }
}

/**
 * 25-го (с 12:00) — черновик плана на следующий месяц, если его ещё нет. План занимается так же, как кнопкой в
 * приложении: если его уже составляют, крон ждёт, а не составляет второй рядом (публикации задвоились бы).
 */
async function nextMonthPlan(ctx: AppContext, profile: SmmProfile, local: DateTime): Promise<void> {
  const today = local.toISODate()!;
  const nextMonth = local.startOf('month').plus({ months: 1 }).toFormat('yyyy-MM');
  if (local.day < 25 || local.hour < 12) return;
  const marks = readMarks(ctx, profile);
  if (marks.plan === nextMonth || !mayTry(marks, 'plan', nextMonth, today)) return;
  const existing = await loadPlan(ctx, profile, nextMonth);
  if (existing?.summary) {
    markDone(ctx, profile, 'plan', nextMonth);
    return;
  }
  const draft = existing ?? (await ensurePlan(ctx, profile, nextMonth));
  if (!(await claimPlan(ctx, draft.id, 'plan'))) return;
  try {
    const plan = await generatePlan(ctx, profile, nextMonth, { author: { id: null, name: MARKETER } });
    markDone(ctx, profile, 'plan', nextMonth);
    await tellApprovers(ctx, profile, `🗓 План на ${nextMonth} готов — посмотрите стратегию и темы и утвердите план в приложении`);
    await addComment(ctx, { planId: plan.id, role: 'ai', text: 'Составил план заранее — поправь, если что-то не так.' });
  } catch (err) {
    // generatePlan сам освобождает план при ошибке; здесь — на случай отказа до начала работы.
    await updatePlan(ctx, draft.id, { busy: null }).catch(() => undefined);
    await markFailed(ctx, profile, 'plan', nextMonth, today, err);
  }
}

/**
 * Раз в час — цифры свежих постов; раз в день (с 10:00) — все цифры площадок, ключ Instagram и фотоархив;
 * отчёт по понедельникам (с 11:00), план 25-го (с 12:00); по средам ночью (с 04:00) маркетолог заново
 * изучает соцсети профиля и обновляет его портрет. Шаги с нейросетью — только когда есть ключ.
 */
async function periodic(ctx: AppContext, profile: SmmProfile, ai: boolean): Promise<void> {
  const local = DateTime.now().setZone(studioTimezone(ctx.db));
  await dailyStats(ctx, profile, local, ai);
  if (!ai) return;
  await weeklyReport(ctx, profile, local);
  await weeklyStudy(ctx, profile, local);
  await nextMonthPlan(ctx, profile, local);
}

async function profileTick(ctx: AppContext, profile: SmmProfile, ai: boolean): Promise<void> {
  const now = Date.now();
  const approved = await listPosts(ctx, {
    profile,
    from: iso(now - 3 * DAY_MS),
    to: iso(now + 20 * MINUTE_MS),
    status: ['approved'],
  });
  // `busy` уже без зависшей работы (db.ts): видео, которое нейросеть не делает, выход не держит.
  const due = approved.filter((p) => !p.busy && p.publishAt && Date.parse(p.publishAt) <= Date.now());
  await publishDue(ctx, due);
  await handoffDue(ctx, approved.filter((p) => !p.busy));
  await remindLinks(ctx, profile, approved);
  // Сначала подготовить ближайшую идею — тогда она уходит на одобрение в этот же тик.
  if (ai) await prepareNext(ctx, profile);
  await reviewDue(ctx, profile);
  await periodic(ctx, profile, ai);
}

async function runTick(ctx: AppContext): Promise<void> {
  try {
    const active = PROFILES.filter((p) => getSmmSettings(ctx.db, p).enabled && smmInUse(ctx, p));
    if (!active.length) return;
    for (const profile of active) {
      resetStale(ctx, profile);
      await recoverInterrupted(ctx, profile).catch((err) =>
        ctx.log.error({ err: errorMessage(err), profile }, 'smm: interrupted publications check failed'),
      );
    }
    const ai = await aiReady(ctx);
    if (ai) await pollVideos(ctx).catch((err) => ctx.log.warn({ err: errorMessage(err) }, 'smm: video polling failed'));
    for (const profile of active) {
      await profileTick(ctx, profile, ai).catch((err) => ctx.log.error({ err: errorMessage(err), profile }, 'smm: tick failed'));
    }
  } catch (err) {
    ctx.log.error({ err: errorMessage(err) }, 'smm: tick failed');
  }
}

/**
 * Тик крона (раз в минуту из server/src/index.ts): включённые профили, у которых есть план или площадки.
 * Долгий тик не накладывается сам на себя (второй вызов сразу возвращается); сбой одного профиля не мешает
 * другому. Никогда не бросает.
 */
export function smmTick(ctx: AppContext): Promise<void> {
  if (ticks.has(ctx.db)) return Promise.resolve();
  const run = runTick(ctx).finally(() => ticks.delete(ctx.db));
  ticks.set(ctx.db, run);
  return run;
}

/** Дождаться идущего тика (остановка сервера: публикация на полпути не должна оборваться закрытием базы). */
export function smmIdle(ctx: AppContext): Promise<void> {
  return ticks.get(ctx.db) ?? Promise.resolve();
}
