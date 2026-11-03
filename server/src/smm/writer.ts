/**
 * Маркетолог пишет публикацию: текст под площадку и формат, бриф и промпты картинок, сценарий рилса — и сразу делает
 * визуал. По замечанию сотрудника переписывает (текст, картинку, время) и решает, стоит ли запомнить замечание как
 * правило. Всё — в профиле поста: у автора свой голос, свои направления, своя память и ни слова о делах студии.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { smmMedia } from '../db/schema-smm.js';
import { studioTimezone } from '../domain/settings.js';
import { errorMessage } from '../lib/errors.js';
import { chatJson } from './ai.js';
import { brandFacts, brandTitle, marketingContext, studioDate, studioToIso } from './context.js';
import { addComment, claimPost, listComments, listPosts, loadPost, remember, setPostProgress, updatePost } from './db.js';
import { datesBetween, datesText } from './holidays.js';
import { knowledgeText, listZones, similarPastPosts, usableZones, zoneByCode, type Zone } from './knowledge.js';
import { archiveCandidates, archiveLine, type LibraryPhoto } from './library.js';
import { generateImages, type ImageJob } from './media.js';
import {
  directionsOf,
  FORMAT_LABEL,
  FORMAT_RULES,
  HOOK_FORMULAS,
  PLATFORM_LABEL,
  PLATFORM_RULES,
  systemPrompt,
  todayLine,
  VISUAL_RULES,
  whenLine,
} from './prompts.js';
import type { SmmSettings } from './settings.js';
import { humanize, lintText } from './style.js';
import { MEMORY_KINDS, SmmError, step, type ReelScript, type SmmPost, type SmmProfile } from './types.js';

const DAY_MS = 86_400_000;

const ImageSchema = z.object({
  prompt: z.string().max(6000).optional(),
  zone: z.string().max(8).nullable().optional(),
  logo: z.boolean().optional(),
  photo: z.string().max(8).optional(),
  mode: z.enum(['as_is', 'edit', 'inspire']).optional(),
});
type ImageSpec = z.infer<typeof ImageSchema>;
const ScriptSchema = z.object({
  hook: z.string().max(300),
  formula: z.string().max(120).optional(),
  shots: z
    .array(
      z.object({
        text: z.string().max(400),
        seconds: z.number().optional(),
        overlay: z.string().max(120).optional(),
        sticker: z.string().max(160).optional(),
      }),
    )
    .min(1)
    .max(12),
  audio: z.string().max(300).optional(),
  cast: z.string().max(300).optional(),
  tips: z.string().max(600).optional(),
});
const MemorySchema = z.object({ kind: z.enum(MEMORY_KINDS), text: z.string().min(3).max(300) });

const DraftSchema = z.object({
  body: z.string().min(20).max(4000),
  visual: z.string().max(600),
  images: z.array(ImageSchema).max(8),
  script: ScriptSchema.nullable().optional(),
});

const FixSchema = z.object({ body: z.string().min(20).max(4000) });

/** Сколько картинок нейросети на формат: карусель — по слайду, сторис — кадры без живой съёмки. */
const MAX_IMAGES: Record<SmmPost['format'], number> = { post: 1, carousel: 8, story: 3, reel: 1 };
const hasScript = (format: SmmPost['format']) => format === 'reel' || format === 'story';

const ARCHIVE_RULES = [
  'Фото из архива — поле "photo" с кодом Ф: "mode": "as_is" — настоящее фото как есть (маркетолог сам обрежет под формат, prompt не нужен); "edit" — поправить фото (в prompt — что: свет, кадр, крупная надпись; саму работу не трогать); "inspire" — новая картинка по мотивам фото (в prompt — сцена; только место и настроение, не работа).',
  'Живые фото цепляют сильнее нарисованных: работы, процесс, мастера, атмосфера, отзывы, до и после — сначала архив. Настоящую работу (тату, прокол, украшение на человеке) показывай только фото архива "as_is" или "edit". С нуля рисуй, только если в архиве нет подходящего (памятки, карточки, анонсы, инфографика, мемы). Одно фото — в одну позицию.',
].join('\n');

/**
 * Слова, на которые срабатывает фильтр нейросети картинок, — их нельзя писать в промпте даже с «без» (остальные правила
 * про настоящие работы — в VISUAL_RULES и системном промпте).
 */
const IMAGE_FILTER_RULE =
  'В промптах картинок не упоминай кровь, соски и обнажённое тело — даже со словом «без»: такие запросы нейросеть отклоняет.';

/** День и время выхода по часовому поясу студии («2026-11-03», «19:00»). */
export function studioClock(ctx: AppContext, iso: string): { day: string; time: string } {
  const at = DateTime.fromISO(iso, { zone: studioTimezone(ctx.db) });
  return at.isValid ? { day: at.toISODate() ?? '', time: at.toFormat('HH:mm') } : { day: '', time: '' };
}

/** Раздел фактов в промпте: у студии — дела студии, у автора — только о ней самой. */
export const factsHeading = (profile: SmmProfile): string => (profile === 'studio' ? 'Факты о студии' : 'Факты об авторе');

/** Картинки из ответа модели — в задания: «Ф3» — третье найденное фото архива, «З2» — второе место профиля. */
function toJobs(
  images: ImageSpec[],
  candidates: LibraryPhoto[],
  zones: Zone[],
  sortOf: (image: ImageSpec & { slot?: number }, i: number) => number,
): ImageJob[] {
  return images
    .map((image, i) => {
      const photo = image.photo ? candidates[Number(image.photo.replace(/\D/g, '')) - 1] : undefined;
      const zone = zoneByCode(zones, image.zone ?? undefined);
      const job: ImageJob = {
        prompt: image.prompt ?? '',
        sort: sortOf(image, i),
        zone: zone && usableZones([zone]).length ? zone : undefined,
        logo: image.logo,
      };
      return photo ? { ...job, photo, mode: image.mode ?? 'as_is' } : job;
    })
    .filter((job) => job.photo || job.prompt.trim().length >= 10);
}

/** Поводы в день выхода (±1 день): маркетолог свяжет пост с праздником, если тема позволяет. */
async function dayOccasions(ctx: AppContext, profile: SmmProfile, publishAt: string | null): Promise<string> {
  const at = publishAt ? Date.parse(publishAt) : Date.now();
  const list = await datesBetween(ctx, profile, studioDate(ctx, at - DAY_MS), studioDate(ctx, at + DAY_MS)).catch(() => []);
  if (!list.length) return '';
  return [
    `Поводы рядом с днём выхода:\n${datesText(list)}`,
    'Если тема публикации — про этот повод или позволяет его естественно связать, свяжи. В траурный день — никаких развлечений и продаж. Уважительные даты — без шуток.',
  ].join('\n');
}

const RevisionSchema = z.object({
  reply: z.string().min(2).max(600),
  topic: z.string().min(2).max(160).optional(),
  body: z.string().min(20).max(4000).optional(),
  visual: z.string().max(600).optional(),
  images: z
    .array(ImageSchema.extend({ slot: z.number().int().min(0).max(9).optional() }))
    .max(5)
    .optional(),
  script: ScriptSchema.nullable().optional(),
  date: z.string().optional(),
  time: z.string().optional(),
  memory: z.array(MemorySchema).max(3).optional(),
});

const IdeasSchema = z.object({
  ideas: z
    .array(
      z.object({
        topic: z.string().min(3).max(160),
        brief: z.string().max(600),
        platform: z.enum(['telegram', 'instagram']),
        format: z.enum(['post', 'carousel', 'story', 'reel']),
        direction: z.string().max(40),
      }),
    )
    .min(1)
    .max(15),
});
export type SmmIdea = z.infer<typeof IdeasSchema>['ideas'][number];

const directionLabel = (settings: SmmSettings, key: string | null) =>
  directionsOf(settings).find((d) => d.key === key)?.title ?? key ?? '—';

function scriptText(script: ReelScript | null): string {
  if (!script) return '';
  const shots = script.shots.map((s, i) => `${i + 1}) ${s.text}${s.overlay ? ` [текст: ${s.overlay}]` : ''}`).join(' ');
  return `Сценарий: зацепка «${script.hook}»; кадры: ${shots}${script.audio ? `; звук: ${script.audio}` : ''}${script.cast ? `; кто: ${script.cast}` : ''}`;
}

function postBriefing(ctx: AppContext, post: SmmPost, settings: SmmSettings): string {
  return [
    `Площадка: ${PLATFORM_LABEL[post.platform]}. Формат: ${FORMAT_LABEL[post.format]}. ${whenLine(ctx, post.publishAt)}`,
    `Тема: ${post.topic}`,
    post.pillar ? `Рубрика: ${post.pillar}` : '',
    `Направление: ${directionLabel(settings, post.direction)}`,
    post.brief ? `Идея и цель: ${post.brief}` : '',
    post.visual ? `Бриф визуала: ${post.visual}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

const IMAGE_COUNT: Record<SmmPost['format'], string> = {
  post: '1',
  carousel: '6–8, по одной на слайд, по порядку; текст слайда — крупно на картинке, в кавычках',
  story: '1–3 — только для кадров, которые не снимут вживую (вертикаль 9:16, место под текст)',
  reel: '1 — обложка 9:16 с текстом зацепки',
};

const SCRIPT_SHAPE: Record<SmmPost['format'], string> = {
  post: 'null',
  carousel: 'null',
  story:
    '{"hook": "тема дня одной фразой", "shots": [{"text": "что показать или снять на кадре", "overlay": "текст на экране, до 12 слов", "sticker": "опрос: вариант / вариант — только на одном кадре"}]}',
  reel: '{"hook": "сказанная фраза зацепки", "formula": "номер и название формулы", "shots": [{"text": "что снимать и что говорить", "seconds": 3, "overlay": "текст на экране, до 6 слов"}], "audio": "звук", "cast": "кто снимает и кто в кадре", "tips": "как снять лучше"}',
};

/**
 * Довести текст до «человеческого»: убрать машинные следы, проверить стоп-лист и правила площадки; нашлось — один
 * заход на переписывание найденного.
 */
async function polish(ctx: AppContext, name: string, post: Pick<SmmPost, 'id' | 'profile' | 'platform' | 'format'>, body: string): Promise<string> {
  const clean = humanize(body);
  const issues = lintText(clean, post.platform, post.format);
  if (!issues.length) return clean;
  try {
    const fixed = await chatJson(ctx, post.profile, {
      system: systemPrompt(post.profile, name),
      note: `шлифовка ${post.id}`,
      maxTokens: 3000,
      temperature: 0.4,
      schema: FixSchema,
      user: [
        `Текст публикации (${PLATFORM_LABEL[post.platform]}, ${FORMAT_LABEL[post.format]}):`,
        clean,
        '',
        `Исправь только это, смысл и факты не меняй:\n${issues.map((i) => `- ${i}`).join('\n')}`,
        `Правила площадки:\n${PLATFORM_RULES[post.platform]}`,
        'Ответ — JSON: {"body": "исправленный текст целиком"}',
      ].join('\n'),
    });
    return humanize(fixed.body);
  } catch (error) {
    ctx.log.warn({ err: errorMessage(error), postId: post.id }, 'smm writer: polish failed');
    return clean;
  }
}

/** Темы соседних публикаций профиля — чтобы не повторяться. */
async function neighbours(ctx: AppContext, post: SmmPost): Promise<string> {
  const at = post.publishAt ? Date.parse(post.publishAt) : Date.now();
  const list = await listPosts(ctx, {
    profile: post.profile,
    from: new Date(at - 10 * DAY_MS).toISOString(),
    to: new Date(at + 10 * DAY_MS).toISOString(),
  });
  const lines = list
    .filter((p) => p.id !== post.id && p.status !== 'skipped')
    .slice(0, 30)
    .map((p) => `${p.publishAt ? studioDate(ctx, Date.parse(p.publishAt)) : '—'} ${p.platform}/${p.format}: ${p.topic}`);
  return lines.length ? `Соседние публикации (не повторяй их темы и заходы):\n${lines.join('\n')}` : '';
}

/** Убрать прежние картинки маркетолога (нейросеть и архив): новый черновик — новый визуал; свои фото остаются. */
function dropAiImages(ctx: AppContext, postId: string): void {
  ctx.db
    .update(smmMedia)
    .set({ selected: false, updatedAt: Date.now() })
    .where(and(eq(smmMedia.postId, postId), inArray(smmMedia.source, ['ai', 'archive']), eq(smmMedia.kind, 'image')))
    .run();
}

interface WriteContext {
  profile: SmmProfile;
  name: string;
  facts: string;
  marketing: Awaited<ReturnType<typeof marketingContext>>;
  zones: Zone[];
  archive: LibraryPhoto[];
  knowledge: string;
  similar: string;
  occasions: string;
}

/** Всё, что маркетолог знает под конкретную публикацию: профиль, ремесло, места, архив, прошлые посты, поводы дня. */
async function writeContext(ctx: AppContext, post: SmmPost, remark = ''): Promise<WriteContext> {
  const profile = post.profile;
  const zones = await listZones(ctx, profile);
  const topic = [post.topic, post.brief, remark].join(' ');
  const [name, facts, marketing, archive, knowledge, similar, occasions] = await Promise.all([
    brandTitle(ctx, profile),
    brandFacts(ctx, profile),
    marketingContext(ctx, profile),
    archiveCandidates(ctx, { ...post, brief: `${post.brief} ${remark}` }),
    knowledgeText(ctx, profile, { craft: 'full', zones }),
    similarPastPosts(ctx, profile, topic),
    dayOccasions(ctx, profile, post.publishAt),
  ]);
  return { profile, name, facts, marketing, zones, archive, knowledge, similar, occasions };
}

const contextLines = (w: WriteContext): string[] => [
  `${factsHeading(w.profile)}:\n${w.facts}`,
  `Что ты знаешь:\n${w.knowledge}`,
  `Маркетинг:\n${w.marketing.text}`,
  w.similar,
  w.occasions,
  archiveLine(w.archive),
];

/** Форма одной картинки в ответе: место и логотип — если есть места; Ф-код — если есть архив. */
function imageShape(w: WriteContext): string {
  const zone = usableZones(w.zones).length
    ? ', "zone": "З-код, только если сцена в нашем месте, иначе null", "logo": false'
    : ', "logo": false';
  const archive = w.archive.length ? ', "photo": "Ф-код, если берёшь фото архива", "mode": "as_is|edit|inspire"' : '';
  return `{"prompt": "подробный промпт картинки"${zone}${archive}}`;
}

function draftTask(ctx: AppContext, post: SmmPost, w: WriteContext, near: string): string {
  return [
    todayLine(ctx),
    ...contextLines(w),
    near,
    '',
    'Задача: подготовь публикацию.',
    postBriefing(ctx, post, w.marketing.settings),
    '',
    `Правила площадки:\n${PLATFORM_RULES[post.platform]}`,
    `Правила формата:\n${FORMAT_RULES[post.format]}`,
    post.format === 'reel'
      ? `Формулы зацепки — выбери ту, что подходит идее, и заполни конкретикой профиля:\n${HOOK_FORMULAS}`
      : '',
    `Правила визуала:\n${VISUAL_RULES}`,
    IMAGE_FILTER_RULE,
    w.archive.length ? ARCHIVE_RULES : '',
    '',
    'Ответ — JSON:',
    `{"body": "готовый текст публикации", "visual": "одной фразой — что на картинке, для людей", "images": [${imageShape(w)}], "script": ${SCRIPT_SHAPE[post.format]}}`,
    `Картинок: ${IMAGE_COUNT[post.format]}.`,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * Подготовить публикацию целиком: текст, визуал, сценарий. Итог — на одобрение (или сразу «одобрено», если включён
 * автопилот). Пост должен быть занят claimPost.
 */
export async function writePost(ctx: AppContext, postId: string): Promise<SmmPost> {
  const post = await loadPost(ctx, postId);
  if (!post) throw new SmmError('Публикация не найдена', 404);
  try {
    await setPostProgress(ctx, post.id, step('Изучаю тему и прошлые посты', 2, 8, 4));
    const w = await writeContext(ctx, post);
    await setPostProgress(ctx, post.id, step('Пишу текст', 8, 40, 25));
    const draft = await chatJson(ctx, post.profile, {
      system: systemPrompt(post.profile, w.name),
      note: `пост ${post.id}`,
      maxTokens: 5000,
      schema: DraftSchema,
      user: draftTask(ctx, post, w, await neighbours(ctx, post)),
    });
    await setPostProgress(ctx, post.id, step('Шлифую текст', 40, 50, 10));
    const body = await polish(ctx, w.name, post, draft.body);
    await updatePost(ctx, post.id, {
      body,
      visual: draft.visual,
      script: hasScript(post.format) ? (draft.script ?? null) : null,
      status: 'draft',
      busy: 'image',
    });
    dropAiImages(ctx, post.id);
    let imageError: string | null = null;
    try {
      const jobs = toJobs(draft.images.slice(0, MAX_IMAGES[post.format]), w.archive, w.zones, (_, i) => i);
      await generateImages(ctx, post, jobs, { from: 50, to: 97 });
    } catch (error) {
      imageError = error instanceof Error ? `Картинка не получилась: ${error.message}` : 'Картинка не получилась';
    }
    const { autopilot } = w.marketing.settings;
    await updatePost(ctx, post.id, { status: autopilot ? 'approved' : 'review', busy: null, error: imageError, reviewSentAt: null });
    return (await loadPost(ctx, post.id))!;
  } catch (error) {
    await updatePost(ctx, post.id, { busy: null, error: error instanceof Error ? error.message.slice(0, 300) : 'Не получилось' });
    throw error;
  }
}

/** Запустить подготовку в фоне (приложение ждёт по полю busy). false — уже идёт. */
export async function writePostInBackground(ctx: AppContext, postId: string, after?: (post: SmmPost) => Promise<void>): Promise<boolean> {
  if (!(await claimPost(ctx, postId, 'text'))) return false;
  void writePost(ctx, postId)
    .then((post) => after?.(post))
    .catch((error) => ctx.log.error({ err: errorMessage(error), postId }, 'smm writer: post preparation failed'));
  return true;
}

export interface Author {
  id: number | null;
  name: string;
}

type Revision = z.infer<typeof RevisionSchema>;

/** Новое время выхода из правки (дата и/или время по часовому поясу студии); null — не переносили. */
function revisedPublishAt(ctx: AppContext, post: SmmPost, revision: Revision, postTime: string): string | null {
  if (!revision.date && !revision.time) return null;
  const at = post.publishAt ? Date.parse(post.publishAt) : null;
  const date = revision.date ?? (at != null ? studioDate(ctx, at) : '');
  const time = revision.time ?? (post.publishAt ? studioClock(ctx, post.publishAt).time : postTime);
  return studioToIso(ctx, date, time);
}

function revisionTask(ctx: AppContext, post: SmmPost, w: WriteContext, history: string, remark: string, author: Author): string {
  const images = post.media.filter((m) => m.kind === 'image' && m.status === 'done');
  const slots = images.map((m) => `слот ${m.sort}: ${m.prompt?.slice(0, 300) ?? 'своё фото'}`).join('; ');
  return [
    todayLine(ctx),
    ...contextLines(w),
    '',
    'Публикация сейчас:',
    postBriefing(ctx, post, w.marketing.settings),
    `Текст:\n${post.body || '(ещё не написан)'}`,
    scriptText(post.script),
    images.length ? `Картинки (слоты): ${slots}` : 'Картинок нет.',
    history ? `Переписка по публикации:\n${history}` : '',
    '',
    `Замечание от ${author.name}: «${remark}»`,
    '',
    `Правила площадки:\n${PLATFORM_RULES[post.platform]}`,
    `Правила формата:\n${FORMAT_RULES[post.format]}`,
    `Правила визуала:\n${VISUAL_RULES}`,
    IMAGE_FILTER_RULE,
    w.archive.length ? ARCHIVE_RULES : '',
    '',
    'Сделай, что просят, ничего лишнего не меняй. Ответ — JSON с полями только для того, что меняешь:',
    `{"reply": "коротко, на «ты», что сделал (1–2 фразы)", "topic"?: "...", "body"?: "новый текст целиком", "visual"?: "...", "images"?: [${imageShape(w).replace(/}$/, ', "slot": номер слота}')}] — только картинки, которые надо переделать или заменить (остальные не трогай: каждая стоит денег), "script"?: {...}, "date"?: "YYYY-MM-DD", "time"?: "HH:MM" — если просят перенести, "memory"?: [{"kind": "voice|rule|avoid|insight|fact", "text": "правило на будущее"}] — только если замечание общее (про стиль, слова, подход), а не про этот пост}`,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * Замечание к публикации: маркетолог переписывает нужное (текст, визуал, время), отвечает, что сделал, и запоминает
 * общее правило, если замечание про стиль, а не про пост.
 */
export async function revisePost(ctx: AppContext, postId: string, remark: string, author: Author): Promise<{ post: SmmPost; reply: string }> {
  const post = await loadPost(ctx, postId);
  if (!post) throw new SmmError('Публикация не найдена', 404);
  try {
    await addComment(ctx, { postId, authorId: author.id, authorName: author.name, role: 'staff', text: remark });
    await setPostProgress(ctx, postId, step('Вношу правки', 3, 55, 20));
    const [w, comments] = await Promise.all([writeContext(ctx, post, remark), listComments(ctx, { postId }, 12)]);
    const history = comments.map((c) => `${c.role === 'ai' ? 'Маркетолог' : (c.authorName ?? 'сотрудник')}: ${c.text}`).join('\n');
    const images = post.media.filter((m) => m.kind === 'image' && m.status === 'done');
    const revision = await chatJson(ctx, post.profile, {
      system: systemPrompt(post.profile, w.name),
      note: `правка ${post.id}`,
      maxTokens: 5000,
      temperature: 0.5,
      schema: RevisionSchema,
      user: revisionTask(ctx, post, w, history, remark, author),
    });

    const publishAt = revisedPublishAt(ctx, post, revision, w.marketing.settings.postTime);
    // Изменилось содержание — снова на одобрение; только перенос времени статус не трогает.
    const contentChanged = !!(revision.body || revision.visual || revision.images?.length || revision.script !== undefined || revision.topic);
    const keepStatus = post.status === 'published' || !contentChanged || (post.status === 'idea' && !revision.body);
    await updatePost(ctx, post.id, {
      topic: revision.topic,
      body: revision.body ? await polish(ctx, w.name, post, revision.body) : undefined,
      visual: revision.visual,
      script: revision.script === undefined ? undefined : revision.script,
      publishAt: publishAt ?? undefined,
      status: keepStatus ? undefined : 'review',
      // Автор замечания видит новую версию сам (в приложении или превью в Telegram) — крон не рассылает повторно.
      reviewSentAt: keepStatus ? undefined : new Date().toISOString(),
      approvedAt: keepStatus ? undefined : null,
      approvedBy: keepStatus ? undefined : null,
      busy: revision.images?.length ? 'image' : undefined,
    });
    for (const m of revision.memory ?? []) {
      await remember(ctx, post.profile, { kind: m.kind, text: m.text, source: 'remark', authorId: author.id });
    }
    let reply = revision.reply;
    if (revision.images?.length) {
      try {
        const jobs = toJobs(revision.images, w.archive, w.zones, (image, i) => image.slot ?? images[i]?.sort ?? i);
        await generateImages(ctx, post, jobs, { from: 55, to: 97 });
      } catch (error) {
        reply += ` Но картинка не получилась: ${error instanceof Error ? error.message : 'ошибка'}`;
      }
    }
    if (revision.memory?.length) reply += ' Запомнил на будущее.';
    await addComment(ctx, { postId, role: 'ai', text: reply });
    await updatePost(ctx, post.id, { busy: null, error: null });
    return { post: (await loadPost(ctx, post.id))!, reply };
  } catch (error) {
    await updatePost(ctx, post.id, { busy: null, error: error instanceof Error ? error.message.slice(0, 300) : 'Не получилось' });
    throw error;
  }
}

export async function reviseInBackground(
  ctx: AppContext,
  postId: string,
  remark: string,
  author: Author,
  after?: (r: { post: SmmPost; reply: string }) => Promise<void>,
  onError?: (message: string) => Promise<void>,
): Promise<boolean> {
  if (!(await claimPost(ctx, postId, 'revise'))) return false;
  void revisePost(ctx, postId, remark, author)
    .then((r) => after?.(r))
    .catch(async (error) => {
      ctx.log.error({ err: errorMessage(error), postId }, 'smm writer: revision failed');
      await onError?.(error instanceof SmmError ? error.message : 'Не получилось — попробуй ещё раз').catch(() => undefined);
    });
  return true;
}

export interface IdeaOpts {
  direction?: string;
  platform?: string;
  format?: string;
  wish?: string;
  count?: number;
}

/** Идеи публикаций профиля по его направлениям — без сохранения: понравившиеся добавляют в план. */
export async function suggestIdeas(ctx: AppContext, profile: SmmProfile, opts: IdeaOpts): Promise<SmmIdea[]> {
  const [name, facts, marketing, knowledge, dates] = await Promise.all([
    brandTitle(ctx, profile),
    brandFacts(ctx, profile, 30),
    marketingContext(ctx, profile),
    knowledgeText(ctx, profile, { craft: 'brief' }),
    datesBetween(ctx, profile, studioDate(ctx), studioDate(ctx, Date.now() + 45 * DAY_MS)).catch(() => []),
  ]);
  const directions = directionsOf(marketing.settings);
  const count = Math.min(Math.max(opts.count ?? 8, 3), 12);
  const scope = opts.direction ? ` по направлению «${directionLabel(marketing.settings, opts.direction)}»` : ' по всем направлениям';
  const r = await chatJson(ctx, profile, {
    system: systemPrompt(profile, name),
    note: 'идеи',
    maxTokens: 3000,
    temperature: 0.95,
    schema: IdeasSchema,
    user: [
      todayLine(ctx),
      `${factsHeading(profile)}:\n${facts}`,
      `Что ты знаешь:\n${knowledge}`,
      `Маркетинг:\n${marketing.text}`,
      dates.length ? `Праздники и поводы ближайших полутора месяцев:\n${datesText(dates)}` : '',
      '',
      `Придумай ${count} свежих идей публикаций${scope}${opts.platform ? ` для ${opts.platform}` : ''}${opts.format ? ` в формате ${opts.format}` : ''}.`,
      opts.wish ? `Пожелание: ${opts.wish}` : '',
      `Направления: ${directions.map((d) => `${d.key} — ${d.title}`).join('; ')}.`,
      'Нужны разные заходы: польза (подготовка к сеансу, уход и заживление, выбор украшения), закулисье, мастера и клиенты (без имён), до и после из архива, юмор, интерактив, анонсы, тренды рилс, поводы и праздники. Идея — конкретная, чтобы сразу было понятно, что снимать или писать; опирайся на историю и стиль профиля, но не повторяй то, что уже было.',
      'Ответ — JSON: {"ideas": [{"topic": "короткий заголовок", "brief": "в чём идея и зачем (1–2 фразы)", "platform": "telegram|instagram", "format": "post|carousel|story|reel", "direction": "ключ направления"}]}',
    ]
      .filter(Boolean)
      .join('\n'),
  });
  return r.ideas;
}
