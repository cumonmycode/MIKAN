/**
 * План профиля на месяц: стратегия, цели, рубрики и календарь публикаций по всем направлениям профиля (из настроек) с
 * учётом событий, праздников и своих дат. Замечание к плану — маркетолог двигает, добавляет, убирает и переписывает
 * темы, отвечает, что сделал. У студии и у автора планы свои и друг друга не касаются.
 */
import { and, eq } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { smmMedia } from '../db/schema-smm.js';
import { studioTimezone } from '../domain/settings.js';
import { errorMessage } from '../lib/errors.js';
import { chatJson } from './ai.js';
import { insightsText } from './analytics.js';
import { brandFacts, brandTitle, marketingContext, studioDate, studioToIso } from './context.js';
import {
  addComment,
  claimPlan,
  deleteIdlePosts,
  deletePost,
  ensurePlan,
  insertPost,
  listComments,
  listPosts,
  loadPlan,
  remember,
  updatePlan,
  updatePost,
} from './db.js';
import { datesBetween, datesText, mourningDays, mustCover, type BrandDate } from './holidays.js';
import { knowledgeText } from './knowledge.js';
import { CONTENT_TYPES, directionsOf, FORMAT_LABEL, systemPrompt, todayLine } from './prompts.js';
import { factsHeading, studioClock, type Author } from './writer.js';
import { MEMORY_KINDS, SmmError, step, type SmmPlan, type SmmPost, type SmmProfile } from './types.js';

const DEFAULT_TIMEZONE = 'Europe/Moscow';
const DAY_MS = 86_400_000;

const PostSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^\d{1,2}:\d{2}$/),
  platform: z.enum(['telegram', 'instagram']),
  format: z.enum(['post', 'carousel', 'story', 'reel']),
  topic: z.string().min(3).max(160),
  pillar: z.string().max(40).optional(),
  direction: z.string().max(40).optional(),
  brief: z.string().max(800),
  visual: z.string().max(400).optional(),
  /** Праздник или повод, под который пост (для проверки, что важные даты не пропущены). */
  occasion: z.string().max(120).nullable().optional(),
});
type PlannedPost = z.infer<typeof PostSchema>;

/** Как планировать под праздники и поводы. */
const DATES_RULES = [
  'Праздники и поводы — часть плана:',
  '- на каждую дату с важностью 3 — тематическая публикация в этот день (утром или днём), а если повод вечерний или выходной — можно накануне; в день праздника ещё и сторис; в "occasion" — название повода;',
  '- важность 2 — тематический пост, если он вписывается в ритм; важность 1 — по возможности, хотя бы упоминанием;',
  '- «повод продать» (14 февраля, 8 марта, Новый год, выпускные) — серия продающих постов за 2–4 недели до даты (подарочные сертификаты, украшения в подарок, парные тату и проколы), а не только в сам день;',
  '- тематический пост связывает повод с профилем: эскиз или флеш к празднику, украшение к поводу, традиция, юмор к месту;',
  '- «уважительно» — без шуток и продаж; «траур» — в этот день никаких развлекательных публикаций и анонсов, допустимы только слова памяти;',
  '- свои даты профиля (день рождения студии, конвенции, гостевые споты) — так же важны, как государственные праздники.',
].join('\n');
const PillarSchema = z.object({
  key: z.string().min(1).max(40),
  title: z.string().min(1).max(80),
  share: z.number().min(0).max(100),
  about: z.string().max(400),
});

const PlanSchema = z.object({
  summary: z.string().min(50).max(5000),
  goals: z.array(z.string().min(3).max(240)).min(1).max(6),
  pillars: z.array(PillarSchema).min(2).max(7),
  posts: z.array(PostSchema).min(1).max(120),
});

const PlanRevisionSchema = z.object({
  reply: z.string().min(2).max(800),
  summary: z.string().min(50).max(5000).optional(),
  goals: z.array(z.string().min(3).max(240)).max(6).optional(),
  pillars: z.array(PillarSchema).max(7).optional(),
  remove: z.array(z.number().int()).max(80).optional(),
  update: z
    .array(PostSchema.partial().extend({ n: z.number().int() }))
    .max(80)
    .optional(),
  add: z.array(PostSchema).max(40).optional(),
  memory: z
    .array(z.object({ kind: z.enum(MEMORY_KINDS), text: z.string().min(3).max(300) }))
    .max(3)
    .optional(),
});

const DONE_STATUSES = new Set(['published']);
/** Что можно пересоставить без потерь: маркетолог ещё не показывал текст людям. */
const REPLACEABLE = new Set(['idea', 'draft']);

/** Границы месяца (ISO) по часовому поясу студии. */
export const monthRange = (month: string, timezone = DEFAULT_TIMEZONE): { from: string; to: string } => {
  const start = DateTime.fromISO(`${month}-01`, { zone: timezone }).startOf('day');
  return { from: new Date(start.toMillis()).toISOString(), to: new Date(start.plus({ months: 1 }).toMillis()).toISOString() };
};

export const isMonth = (v: string): boolean => /^\d{4}-(0[1-9]|1[0-2])$/.test(v);

const studioZone = (ctx: AppContext): string => studioTimezone(ctx.db) || DEFAULT_TIMEZONE;

/** Дни месяца, на которые ещё можно планировать (с завтрашнего дня). */
function planDays(ctx: AppContext, month: string): string[] {
  const today = studioDate(ctx);
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const out: string[] = [];
  for (let d = 1; d <= last; d += 1) {
    const date = `${month}-${String(d).padStart(2, '0')}`;
    if (date > today) out.push(date);
  }
  return out;
}

const dayOf = (ctx: AppContext, iso: string | null) => (iso ? studioClock(ctx, iso).day : '');
const timeOf = (ctx: AppContext, iso: string | null) => (iso ? studioClock(ctx, iso).time : '');

function postLine(ctx: AppContext, p: SmmPost, n?: number): string {
  const brief = p.brief ? ` — ${p.brief.slice(0, 160)}` : '';
  return `${n != null ? `#${n} ` : ''}${dayOf(ctx, p.publishAt)} ${timeOf(ctx, p.publishAt)} ${p.platform}/${p.format} [${p.status}]: ${p.topic}${brief}`;
}

const directionOf = (keys: string[], v: string | undefined) => (v && keys.includes(v) ? v : null);

const shiftDay = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** Тема уже готового поста про этот повод? — по общему корню значимого слова. */
const mentions = (topic: string, title: string): boolean =>
  title
    .toLowerCase()
    .split(/[^а-яёa-z]+/i)
    .filter((w) => w.length >= 5)
    .some((w) => topic.toLowerCase().includes(w.slice(0, 5)));

/** Важные даты из дней плана, на которые нет тематической публикации (в день или накануне). */
function uncovered(ctx: AppContext, dates: BrandDate[], days: string[], planned: PlannedPost[], kept: SmmPost[]): BrandDate[] {
  return mustCover(dates).filter((d) => {
    if (!days.includes(d.date)) return false;
    const near = [d.date, shiftDay(d.date, -1)];
    const inPlan = planned.some((p) => near.includes(p.date) && (p.occasion || mentions(p.topic, d.title)));
    const inKept = kept.some((p) => near.includes(dayOf(ctx, p.publishAt)) && mentions(p.topic, d.title));
    return !inPlan && !inKept;
  });
}

/** Траурный день: публикация не про память переезжает на следующий день. */
function respectMourning(posts: PlannedPost[], dates: BrandDate[]): PlannedPost[] {
  const mourning = new Set(mourningDays(dates));
  return posts.map((p) => (mourning.has(p.date) && !p.occasion ? { ...p, date: shiftDay(p.date, 1) } : p));
}

/** С чем повод связывает пост — со студией или с автором. */
const occasionAngle = (profile: SmmProfile): string =>
  profile === 'studio' ? 'как повод связан с тату, пирсингом, украшениями и студией' : 'как повод связан с автором и её творчеством';

const OccasionPostsSchema = z.object({ posts: z.array(PostSchema).min(1).max(12) });

/** Догнать пропущенные важные даты: тематические публикации к ним (второй короткий заход). */
async function occasionPosts(
  ctx: AppContext,
  profile: SmmProfile,
  name: string,
  missing: BrandDate[],
  planned: PlannedPost[],
  postTime: string,
): Promise<PlannedPost[]> {
  const r = await chatJson(ctx, profile, {
    system: systemPrompt(profile, name),
    note: 'праздники в план',
    maxTokens: 3000,
    temperature: 0.7,
    schema: OccasionPostsSchema,
    user: [
      todayLine(ctx),
      `В плане нет тематических публикаций к этим датам:\n${datesText(missing)}`,
      `Уже в плане (не повторяй темы):\n${planned.map((p) => `${p.date} ${p.platform}/${p.format}: ${p.topic}`).join('\n')}`,
      DATES_RULES,
      `К каждой дате — пост в Telegram или Instagram в этот день (около ${postTime}, если повод не вечерний) и сторис в сам день; "occasion" — название повода. Угол — ${occasionAngle(profile)}.`,
      'Ответ — JSON: {"posts": [{"date": "YYYY-MM-DD", "time": "HH:MM", "platform": "telegram|instagram", "format": "post|carousel|story|reel", "topic": "...", "pillar": "...", "direction": "...", "brief": "...", "visual": "...", "occasion": "..."}]}',
    ].join('\n'),
  });
  return r.posts;
}

/** Тема плана — в публикации профиля. Не в этом месяце или уже в прошлом — не ставим. */
async function insertFromPlan(ctx: AppContext, plan: SmmPlan, p: PlannedPost, keys: string[], authorId: number | null): Promise<boolean> {
  if (!p.date.startsWith(`${plan.month}-`)) return false;
  const publishAt = studioToIso(ctx, p.date, p.time);
  if (!publishAt || Date.parse(publishAt) < Date.now()) return false;
  await insertPost(ctx, {
    profile: plan.profile,
    planId: plan.id,
    platform: p.platform,
    format: p.format,
    publishAt,
    topic: p.topic,
    pillar: p.pillar ?? null,
    direction: directionOf(keys, p.direction),
    brief: p.brief,
    visual: p.visual ?? '',
    createdBy: authorId,
  });
  return true;
}

export interface PlanOpts {
  wishes?: string;
  author: Author;
}

/** Инфоповоды месяца: у студии — её дела из фактов, у автора — её жизнь и творчество. */
const OCCASIONS_HINT: Record<SmmProfile, string> = {
  studio:
    'Используй инфоповоды: свободные окна мастеров и новинки украшений из фактов, традиции и события студии из портрета, сезон (лето — тату и солнце, осень — сезон новых тату); подогревай пустые дни недели. Опирайся на цифры: больше того, что заходит, лучшие дни и часы.',
  author:
    'Используй инфоповоды из портрета и фактов автора: её работы и эскизы, поездки, гостевые споты, события и сезон. Опирайся на цифры: больше того, что заходит, лучшие дни и часы.',
};

const PLAN_SHAPE =
  '{"summary": "стратегия месяца: 3–6 коротких абзацев — главный фокус, инфоповоды, как растим охват и заявки", "goals": ["измеримые цели месяца"], "pillars": [{"key": "латиница", "title": "рубрика", "share": доля %, "about": "о чём"}], "posts": [{"date": "YYYY-MM-DD", "time": "HH:MM", "platform": "telegram|instagram", "format": "post|carousel|story|reel", "topic": "тема-заголовок", "pillar": "key рубрики", "direction": "key направления", "brief": "идея и цель публикации, конкретно (1–3 фразы)", "visual": "что на картинке или в кадре", "occasion": "праздник или повод, если пост под него, иначе null"}]}';

/**
 * Составить (или пересоставить) план месяца профиля. Одобренные и вышедшие публикации сохраняются. Вызывающий
 * сначала занимает план (claimPlan) — иначе ручной и плановый запуск могут пойти вместе и задвоить публикации.
 */
export async function generatePlan(ctx: AppContext, profile: SmmProfile, month: string, opts: PlanOpts): Promise<SmmPlan> {
  const plan = await ensurePlan(ctx, profile, month);
  const days = planDays(ctx, month);
  if (!days.length) throw new SmmError('Этот месяц уже закончился', 400);
  try {
    await updatePlan(ctx, plan.id, { progress: step('Изучаю профиль, праздники и прошлые цифры', 2, 8, 5) });
    const { from, to } = monthRange(month, studioZone(ctx));
    // Праздники месяца и первых двух недель следующего — под них продают заранее.
    const datesTo = shiftDay(days[days.length - 1]!, 14);
    const [name, facts, marketing, existing, knowledge, dates, insights] = await Promise.all([
      brandTitle(ctx, profile),
      brandFacts(ctx, profile, 75),
      marketingContext(ctx, profile),
      listPosts(ctx, { profile, from, to }),
      knowledgeText(ctx, profile, { craft: 'brief' }),
      datesBetween(ctx, profile, days[0]!, datesTo),
      insightsText(ctx, profile).catch(() => ''),
    ]);
    await updatePlan(ctx, plan.id, { progress: step('Составляю стратегию и календарь', 8, 88, 70) });
    const kept = existing.filter((p) => !REPLACEABLE.has(p.status) && p.status !== 'skipped');
    const { cadence, postTime } = marketing.settings;
    const directions = directionsOf(marketing.settings);
    const weeks = Math.max(1, Math.round((days.length / 7) * 10) / 10);
    const r = await chatJson(ctx, profile, {
      system: systemPrompt(profile, name),
      note: `план ${month}`,
      maxTokens: 14_000,
      temperature: 0.8,
      schema: PlanSchema,
      user: [
        todayLine(ctx),
        `${factsHeading(profile)}:\n${facts}`,
        `Что ты знаешь:\n${knowledge}`,
        `Маркетинг:\n${marketing.text}`,
        insights ? `Что заходит у нас по цифрам:\n${insights}` : '',
        dates.length ? `Праздники и поводы (этот месяц и начало следующего — для анонсов заранее):\n${datesText(dates)}` : '',
        '',
        `Задача: составь контент-план на ${month} (дни ${days[0]}…${days[days.length - 1]}, это ~${weeks} нед.).`,
        `Частота в неделю: Telegram-постов ${cadence.telegram}, Instagram-постов ${cadence.instagram}, сторис ${cadence.stories} (Instagram, иногда Telegram), рилс ${cadence.reels} (Instagram).`,
        `Время по умолчанию ${postTime}; ставь время под аудиторию: анонс — утром в тот же день или накануне вечером, рилс — вечером.`,
        `Направления профиля (каждое должно прозвучать за месяц, по весу): ${directions.map((d) => `${d.key} — ${d.title}`).join('; ')}.`,
        OCCASIONS_HINT[profile],
        DATES_RULES,
        `Типы контента (скилл ig-plan) — каждую неделю есть все, два одинаковых подряд не ставь:\n${CONTENT_TYPES}`,
        'Плюс процесс и закулисье, мастера и клиенты (без имён), до и после из архива, юмор к месту, интерактив (опросы, вопросы), отзывы.',
        'Каждой публикации — угол, а не тема: не «пирсинг уха», а «почему хеликс заживает дольше мочки и что с этим делать». В brief — конкретная история или цифра, которую можно рассказать.',
        'Рилс — главный способ дотянуться до тех, кто не подписан: снимают сами — в brief опиши идею съёмки и формулу зацепки. Сторис — серия касаний на день: процесс, закулисье, опрос.',
        'Время: аудитории удобно вечером после работы (18:00–21:00) и в обед. Но первые 2 секунды важнее часа выхода.',
        kept.length ? `Уже есть (не трогай, учитывай в ритме и не повторяй темы):\n${kept.map((p) => postLine(ctx, p)).join('\n')}` : '',
        opts.wishes ? `Пожелания: ${opts.wishes}` : '',
        '',
        'Ответ — JSON:',
        PLAN_SHAPE,
      ]
        .filter((line) => line !== '')
        .join('\n'),
    });

    let planned = r.posts;
    const missing = uncovered(ctx, dates, days, planned, kept);
    if (missing.length) {
      await updatePlan(ctx, plan.id, { progress: step(`Добавляю тематические посты к праздникам: ${missing.length}`, 88, 95, 20) });
      const extra = await occasionPosts(ctx, profile, name, missing, planned, postTime).catch((error) => {
        ctx.log.warn({ err: errorMessage(error), profile, month }, 'smm planner: occasion posts failed');
        return [] as PlannedPost[];
      });
      planned = [...planned, ...extra];
    }
    planned = respectMourning(planned, dates);

    await updatePlan(ctx, plan.id, { progress: step('Раскладываю публикации по дням', 95, 99, 4) });
    // Статусы — на момент удаления, а не до разговора с моделью: за эти минуты тему могли одобрить или начать писать.
    const replaceable = existing.filter((p) => REPLACEABLE.has(p.status) && !p.busy).map((p) => p.id);
    await deleteIdlePosts(ctx, replaceable, [...REPLACEABLE]);
    const keys = directions.map((d) => d.key);
    let added = 0;
    for (const p of planned) if (await insertFromPlan(ctx, plan, p, keys, opts.author.id)) added += 1;
    await updatePlan(ctx, plan.id, { summary: r.summary, goals: r.goals, pillars: r.pillars, status: 'draft', busy: null, error: null });
    await addComment(ctx, {
      planId: plan.id,
      role: 'ai',
      text: `Составил план: ${added} публикаций. Посмотри стратегию и темы — утверди план, и я начну готовить посты за ${marketing.settings.reviewLeadHours} ч до выхода.`,
    });
    return (await loadPlan(ctx, profile, month))!;
  } catch (error) {
    await updatePlan(ctx, plan.id, { busy: null, error: error instanceof Error ? error.message.slice(0, 300) : 'Не получилось' });
    throw error;
  }
}

export async function generatePlanInBackground(
  ctx: AppContext,
  profile: SmmProfile,
  month: string,
  opts: PlanOpts,
  after?: (plan: SmmPlan) => Promise<void>,
): Promise<boolean> {
  const plan = await ensurePlan(ctx, profile, month);
  if (!(await claimPlan(ctx, plan.id, 'plan'))) return false;
  void generatePlan(ctx, profile, month, opts)
    .then((p) => after?.(p))
    .catch((error) => ctx.log.error({ err: errorMessage(error), profile, month }, 'smm planner: plan failed'));
  return true;
}

type PlanRevision = z.infer<typeof PlanRevisionSchema>;

/** Применить правку плана к публикациям: убрать, поменять, добавить. Вышедшие не трогаются. */
async function applyRevision(ctx: AppContext, plan: SmmPlan, active: SmmPost[], r: PlanRevision, keys: string[], author: Author): Promise<void> {
  const byNumber = (n: number) => active[n - 1];
  for (const n of r.remove ?? []) {
    const post = byNumber(n);
    if (!post || DONE_STATUSES.has(post.status)) continue;
    if (REPLACEABLE.has(post.status)) await deletePost(ctx, post.id);
    else await updatePost(ctx, post.id, { status: 'skipped' });
  }
  for (const u of r.update ?? []) {
    const post = byNumber(u.n);
    if (!post || DONE_STATUSES.has(post.status)) continue;
    const day = u.date ?? dayOf(ctx, post.publishAt);
    const time = u.time ?? timeOf(ctx, post.publishAt);
    const publishAt = u.date || u.time ? studioToIso(ctx, day, time) : null;
    // Сменилась суть — текст и картинки устарели: тема возвращается в «идеи», маркетолог напишет заново.
    const changed = !!(u.topic || u.brief || u.format || u.platform);
    await updatePost(ctx, post.id, {
      publishAt: publishAt ?? undefined,
      topic: u.topic,
      brief: u.brief,
      platform: u.platform,
      format: u.format,
      pillar: u.pillar,
      direction: u.direction ? directionOf(keys, u.direction) : undefined,
      visual: u.visual,
      ...(changed ? { status: 'idea', body: '', script: null, reviewSentAt: null, approvedAt: null, approvedBy: null } : {}),
    });
    if (changed) {
      ctx.db
        .update(smmMedia)
        .set({ selected: false, updatedAt: Date.now() })
        .where(and(eq(smmMedia.postId, post.id), eq(smmMedia.source, 'ai')))
        .run();
    }
  }
  for (const p of r.add ?? []) await insertFromPlan(ctx, plan, p, keys, author.id);
}

/** Замечание к плану: перенести, добавить, убрать, переписать темы или стратегию. */
export async function revisePlan(ctx: AppContext, profile: SmmProfile, month: string, remark: string, author: Author): Promise<string> {
  const plan = await loadPlan(ctx, profile, month);
  if (!plan) throw new SmmError('Плана на этот месяц ещё нет', 404);
  try {
    await addComment(ctx, { planId: plan.id, authorId: author.id, authorName: author.name, role: 'staff', text: remark });
    await updatePlan(ctx, plan.id, { progress: step('Вношу правки в план', 3, 92, 30) });
    const { from, to } = monthRange(month, studioZone(ctx));
    const lastDay = studioDate(ctx, Date.parse(to) - 1);
    const [name, facts, marketing, posts, comments, knowledge, dates] = await Promise.all([
      brandTitle(ctx, profile),
      brandFacts(ctx, profile, 75),
      marketingContext(ctx, profile),
      listPosts(ctx, { profile, from, to }),
      listComments(ctx, { planId: plan.id }, 10),
      knowledgeText(ctx, profile, { craft: 'brief' }),
      datesBetween(ctx, profile, `${month}-01`, shiftDay(lastDay, 14)),
    ]);
    const active = posts.filter((p) => p.status !== 'skipped');
    const history = comments.map((c) => `${c.role === 'ai' ? 'Маркетолог' : (c.authorName ?? 'сотрудник')}: ${c.text}`).join('\n');
    const r = await chatJson(ctx, profile, {
      system: systemPrompt(profile, name),
      note: `правка плана ${month}`,
      maxTokens: 8000,
      temperature: 0.5,
      schema: PlanRevisionSchema,
      user: [
        todayLine(ctx),
        `${factsHeading(profile)}:\n${facts}`,
        `Что ты знаешь:\n${knowledge}`,
        `Маркетинг:\n${marketing.text}`,
        dates.length ? `Праздники и поводы:\n${datesText(dates)}\n${DATES_RULES}` : '',
        '',
        `План на ${month}. Стратегия:\n${plan.summary}`,
        `Цели: ${plan.goals.join('; ')}`,
        `Рубрики: ${plan.pillars.map((p) => `${p.key} — ${p.title} ${p.share}%`).join('; ')}`,
        `Публикации (#номер):\n${active.map((p, i) => postLine(ctx, p, i + 1)).join('\n')}`,
        history ? `Переписка по плану:\n${history}` : '',
        '',
        `Замечание от ${author.name}: «${remark}»`,
        '',
        'Опубликованные (published) не трогай. Делай только то, что просят. Ответ — JSON с полями только для изменений:',
        '{"reply": "коротко, на «ты», что поменял", "summary"?: "...", "goals"?: [...], "pillars"?: [...], "remove"?: [номера], "update"?: [{"n": номер, "date"?: "YYYY-MM-DD", "time"?: "HH:MM", "topic"?: "...", "brief"?: "...", "platform"?: "...", "format"?: "...", "pillar"?: "...", "direction"?: "...", "visual"?: "..."}], "add"?: [{"date", "time", "platform", "format", "topic", "pillar", "direction", "brief", "visual"}], "memory"?: [{"kind": "voice|rule|avoid|insight|fact", "text": "..."}] — только если замечание — общее правило на будущее}',
      ]
        .filter((line) => line !== '')
        .join('\n'),
    });

    await applyRevision(ctx, plan, active, r, directionsOf(marketing.settings).map((d) => d.key), author);
    await updatePlan(ctx, plan.id, {
      summary: r.summary,
      goals: r.goals,
      pillars: r.pillars?.length ? r.pillars : undefined,
      busy: null,
      error: null,
    });
    for (const m of r.memory ?? []) await remember(ctx, profile, { kind: m.kind, text: m.text, source: 'remark', authorId: author.id });
    const reply = r.reply + (r.memory?.length ? ' Запомнил на будущее.' : '');
    await addComment(ctx, { planId: plan.id, role: 'ai', text: reply });
    return reply;
  } catch (error) {
    await updatePlan(ctx, plan.id, { busy: null, error: error instanceof Error ? error.message.slice(0, 300) : 'Не получилось' });
    throw error;
  }
}

export async function revisePlanInBackground(ctx: AppContext, profile: SmmProfile, month: string, remark: string, author: Author): Promise<boolean> {
  const plan = await loadPlan(ctx, profile, month);
  if (!plan) throw new SmmError('Плана на этот месяц ещё нет', 404);
  if (!(await claimPlan(ctx, plan.id, 'revise'))) return false;
  void revisePlan(ctx, profile, month, remark, author).catch((error) =>
    ctx.log.error({ err: errorMessage(error), profile, month }, 'smm planner: plan revision failed'),
  );
  return true;
}

export const formatLabel = FORMAT_LABEL;
