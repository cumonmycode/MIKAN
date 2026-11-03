/**
 * Нейросети раздела «СММ» через Polza (тот же ключ AI_API_KEY, что у бота MIKAN):
 *  - тексты, планы, отчёты и разбор фото — Gemini 3.8 Flash (ответ строго JSON по схеме; план месяца ~1 мин и
 *    ~3 ₽). Claude Sonnet 5.5 в Polza всегда «думает» и на плане месяца тратил весь лимит ответа на рассуждения —
 *    ответ приходил пустым;
 *  - картинки — Nano Banana 2.1 в 1K: 3 ₽ вместо 4,5 ₽ за 2K, русский текст на картинке так же чистый, до 10
 *    референсов (фото мест съёмки, архив); запасная — GPT Image 2.5;
 *  - видео — Veo 3.1 Fast: 8 с со звуком, 9:16, ~45 ₽. Реалистичное видео в студии — с первого кадра: фото-кадр
 *    в нашем месте съёмки → Veo оживляет его (FIRST_AND_LAST_FRAMES).
 * Модели меняются переменными SMM_TEXT_MODEL / SMM_IMAGE_MODEL / SMM_VIDEO_MODEL, разрешение картинок —
 * SMM_IMAGE_RESOLUTION (1K | 2K | 4K).
 *
 * Каждый вызов пишет стоимость в smm_spend своего профиля; перед вызовом — проверка бюджета месяца профиля.
 */
import { and, eq, gte, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import type { z } from 'zod';
import { SMM_MODEL_DEFAULTS } from '../config.js';
import type { AppContext } from '../context.js';
import { smmSpend } from '../db/schema.js';
import { studioTimezone } from '../domain/settings.js';
import { errorMessage } from '../lib/errors.js';
import { getSmmSettings } from './settings.js';
import { SmmError, type SmmProfile } from './types.js';

const POLZA_BASE = 'https://polza.ai/api';
const IMAGE_FALLBACK_MODEL = 'openai/gpt-image-2.5-flare';

/** Модели по умолчанию, как в Titan. Модели этого сервера (с переменными SMM_*) — `smmModels(ctx)`. */
export const SMM_MODELS = { ...SMM_MODEL_DEFAULTS, imageFallback: IMAGE_FALLBACK_MODEL } as const;

export interface SmmModels {
  text: string;
  image: string;
  imageFallback: string;
  video: string;
}

/** Модели, с которыми работает сервер (SMM_TEXT_MODEL / SMM_IMAGE_MODEL / SMM_VIDEO_MODEL) — их отдаёт `/meta`. */
export function smmModels(ctx: AppContext): SmmModels {
  const { textModel, imageModel, videoModel } = ctx.config.smm;
  return { text: textModel, image: imageModel, imageFallback: IMAGE_FALLBACK_MODEL, video: videoModel };
}

export type SpendKind = 'text' | 'image' | 'video' | 'vision';
/** Сколько примерно стоит вызов — чтобы не начинать то, на что бюджета уже нет. */
const ESTIMATE_RUB: Record<SpendKind, number> = { text: 3, vision: 2, image: 3, video: 45 };
const CHAT_TIMEOUT_MS = 180_000;
const IMAGE_TIMEOUT_MS = 170_000;
const POLL_TIMEOUT_MS = 20_000;
const START_VIDEO_TIMEOUT_MS = 30_000;
const BALANCE_TIMEOUT_MS = 10_000;
const POLL_EVERY_MS = 4_000;

export async function smmApiKey(ctx: AppContext): Promise<string> {
  const key = ctx.config.ai.apiKey;
  if (!key) throw new SmmError('Ключ нейросетей не настроен на сервере (AI_API_KEY)', 400);
  return key;
}

// ─── Бюджет ──────────────────────────────────────────────────────────────────

export async function recordSpend(
  ctx: AppContext,
  profile: SmmProfile,
  kind: SpendKind,
  model: string,
  costRub: number,
  note?: string,
): Promise<void> {
  if (!(costRub > 0)) return;
  try {
    ctx.db
      .insert(smmSpend)
      .values({ profile, at: Date.now(), kind, model, costRub, note: note?.slice(0, 200) ?? null })
      .run();
  } catch (error) {
    ctx.log.error({ err: errorMessage(error), profile, kind }, 'smm: spend not recorded');
  }
}

/** Потрачено профилем на нейросети с начала месяца (по времени студии), ₽. */
export async function monthSpend(ctx: AppContext, profile: SmmProfile): Promise<number> {
  const monthStart = DateTime.now().setZone(studioTimezone(ctx.db)).startOf('month').toMillis();
  const row = ctx.db
    .select({ total: sql<number>`coalesce(sum(${smmSpend.costRub}), 0)` })
    .from(smmSpend)
    .where(and(eq(smmSpend.profile, profile), gte(smmSpend.at, monthStart)))
    .get();
  return Number(row?.total ?? 0) || 0;
}

async function assertBudget(ctx: AppContext, profile: SmmProfile, kind: SpendKind): Promise<void> {
  const { monthlyBudget } = getSmmSettings(ctx.db, profile);
  if (!monthlyBudget) return;
  const spent = await monthSpend(ctx, profile);
  if (spent + ESTIMATE_RUB[kind] > monthlyBudget) {
    throw new SmmError(
      `Бюджет на нейросети в этом месяце закончился (${Math.round(spent)} из ${monthlyBudget} ₽) — увеличьте его в настройках СММ`,
      402,
    );
  }
}

// ─── Запросы к Polza ─────────────────────────────────────────────────────────

type PolzaError = { error?: { code?: string; message?: string } };

function polzaFailure(ctx: AppContext, status: number, body: PolzaError): SmmError {
  const message = body.error?.message ?? '';
  const code = body.error?.code ?? '';
  ctx.log.error({ status, code, message: message.slice(0, 300) }, 'smm: polza error');
  const noMoney = status === 402 || code === 'INSUFFICIENT_BALANCE';
  // У ключа Polza бывает свой лимит трат — денег на аккаунте хватает, а ключу нельзя.
  if (noMoney && /лимит/i.test(message)) {
    return new SmmError(
      'У ключа Polza закончился лимит трат — увеличьте или снимите лимит этого ключа на polza.ai (раздел «API-ключи»)',
      402,
    );
  }
  if (noMoney) return new SmmError('На балансе Polza не хватает денег — пополните баланс на polza.ai', 402);
  if (status === 401 || status === 403) return new SmmError('Ключ Polza не принят — проверьте AI_API_KEY на сервере', 400);
  if (status === 400 && message) return new SmmError(`Нейросеть отклонила запрос: ${message.slice(0, 160)}`, 502);
  if (status === 429) return new SmmError('Нейросеть перегружена — попробуйте через минуту', 502);
  return new SmmError('Нейросеть не ответила — попробуйте ещё раз', 502);
}

function polzaUrl(ctx: AppContext, path: string): string {
  const base = (ctx.config.ai.baseUrl ?? POLZA_BASE).replace(/\/+$/, '').replace(/\/v1$/, '');
  return `${base}/v1${path}`;
}

async function polza<T>(ctx: AppContext, apiKey: string, path: string, body: unknown, timeoutMs: number): Promise<T> {
  let res: Response;
  try {
    res = await (ctx.smmFetch ?? fetch)(polzaUrl(ctx, path), {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new SmmError('Нейросеть думает слишком долго — попробуйте ещё раз', 502);
    }
    ctx.log.warn({ err: errorMessage(error), path }, 'smm: polza unreachable');
    throw new SmmError('Нет связи с нейросетью — попробуйте ещё раз', 502);
  }
  const data = (await res.json().catch(() => ({}))) as T & PolzaError;
  if (!res.ok) throw polzaFailure(ctx, res.status, data);
  return data;
}

export async function polzaBalance(ctx: AppContext): Promise<number | null> {
  try {
    const data = await polza<{ amount?: string | number }>(ctx, await smmApiKey(ctx), '/balance', undefined, BALANCE_TIMEOUT_MS);
    const n = Number(data.amount);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// ─── Текст (JSON) ────────────────────────────────────────────────────────────

export type ChatPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string | ChatPart[] };
type ChatResponse = {
  choices?: { finish_reason?: string; message?: { content?: string | null } }[];
  usage?: { cost_rub?: number };
};

/** Достаёт объект JSON из ответа модели: без обёртки ```json и пояснений вокруг. */
export function extractJson(text: string): unknown {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('в ответе нет JSON');
  return JSON.parse(trimmed.slice(start, end + 1));
}

export interface ChatJsonOpts<T> {
  system: string;
  user: string | ChatPart[];
  schema: z.ZodType<T>;
  maxTokens?: number;
  temperature?: number;
  kind?: 'text' | 'vision';
  note?: string;
}

/** Ответ прошёл схему — данные; нет — текст ошибки для второго захода. */
function checkAnswer<T>(content: string, schema: z.ZodType<T>): { ok: true; data: T } | { ok: false; error: string } {
  try {
    const parsed = schema.safeParse(extractJson(content));
    if (parsed.success) return { ok: true, data: parsed.data };
    const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`);
    return { ok: false, error: issues.join('; ') };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'неверный JSON' };
  }
}

/**
 * Запрос к текстовой модели с ответом строго по схеме. Не прошёл проверку — второй заход с текстом ошибки (модель
 * сама исправляет JSON).
 */
export async function chatJson<T>(ctx: AppContext, profile: SmmProfile, opts: ChatJsonOpts<T>): Promise<T> {
  const kind = opts.kind ?? 'text';
  await assertBudget(ctx, profile, kind);
  const apiKey = await smmApiKey(ctx);
  const model = ctx.config.smm.textModel;
  const messages: ChatMessage[] = [
    { role: 'system', content: opts.system },
    { role: 'user', content: opts.user },
  ];
  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const data = await polza<ChatResponse>(
      ctx,
      apiKey,
      '/chat/completions',
      {
        model,
        max_tokens: opts.maxTokens ?? 4000,
        temperature: opts.temperature ?? 0.7,
        response_format: { type: 'json_object' },
        messages,
      },
      CHAT_TIMEOUT_MS,
    );
    await recordSpend(ctx, profile, kind, model, Number(data.usage?.cost_rub ?? 0), opts.note);
    const content = data.choices?.[0]?.message?.content ?? '';
    const cut = data.choices?.[0]?.finish_reason === 'length';
    // Пустой ответ из-за лимита: повтор с тем же лимитом не поможет.
    if (!content.trim() && cut) throw new SmmError('Ответ не уместился в лимит модели — попробуйте ещё раз', 502);
    const answer = checkAnswer(content, opts.schema);
    if (answer.ok) return answer.data;
    lastError = answer.error;
    // Оборвался по лимиту — просить «исправить» бесполезно, нужно короче (оборванный текст не возвращаем).
    if (cut) {
      messages.push({
        role: 'user',
        content: 'Ответ оборвался: слишком длинно для лимита. Верни тот же JSON заметно короче — меньше пунктов, короче формулировки.',
      });
    } else {
      messages.push(
        { role: 'assistant', content },
        { role: 'user', content: `Ответ не прошёл проверку (${lastError}). Верни исправленный JSON целиком, без пояснений.` },
      );
    }
  }
  ctx.log.error({ err: lastError.slice(0, 500), profile, note: opts.note }, 'smm: model returned invalid JSON');
  throw new SmmError('Маркетолог ответил не по форме — попробуйте ещё раз', 502);
}

// ─── Картинки и видео ────────────────────────────────────────────────────────

type MediaResponse = {
  id?: string;
  status?: string;
  data?: unknown;
  output?: unknown;
  usage?: { cost_rub?: number };
  error?: { message?: string } | string;
};

/** Ссылка на результат: Polza отдаёт {url}, [{url}] или output.url — смотря по модели. */
export function resultUrl(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') return /^https?:\/\//.test(value) ? value : null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = resultUrl(item);
      if (url) return url;
    }
    return null;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return resultUrl(obj['url']) ?? resultUrl(obj['video_url']) ?? resultUrl(obj['image_url']) ?? resultUrl(obj['output']);
  }
  return null;
}

const mediaError = (r: MediaResponse): string =>
  (typeof r.error === 'string' ? r.error : r.error?.message) || 'генерация не удалась';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Картинке не хватает соотношения 4:5 у запасной модели — ближайшее 3:4. */
const fallbackAspect = (aspect: string): string => (aspect === '4:5' ? '3:4' : aspect);

async function imageOnce(
  ctx: AppContext,
  apiKey: string,
  model: string,
  opts: { prompt: string; aspect: string; references: string[] },
): Promise<{ url: string; cost: number }> {
  const input: Record<string, unknown> = {
    prompt: opts.prompt.slice(0, 19_000),
    aspect_ratio: opts.aspect,
    image_resolution: ctx.config.smm.imageResolution,
    ...(model.includes('banana') ? { output_format: 'jpeg' } : {}),
    ...(opts.references.length ? { images: opts.references.slice(0, 8).map((url) => ({ type: 'url', data: url })) } : {}),
  };
  let r = await polza<MediaResponse>(ctx, apiKey, '/media', { model, input }, IMAGE_TIMEOUT_MS);
  const deadline = Date.now() + IMAGE_TIMEOUT_MS;
  while ((r.status === 'pending' || r.status === 'processing') && r.id && Date.now() < deadline) {
    await sleep(POLL_EVERY_MS);
    r = await polza<MediaResponse>(ctx, apiKey, `/media/${encodeURIComponent(r.id)}`, undefined, POLL_TIMEOUT_MS);
  }
  if (r.status === 'failed' || r.status === 'cancelled') {
    throw new SmmError(`Картинка не получилась: ${mediaError(r).slice(0, 160)}`, 502);
  }
  const url = resultUrl(r.data) ?? resultUrl(r.output);
  if (!url) throw new SmmError('Картинка не успела сгенерироваться — попробуйте ещё раз', 502);
  return { url, cost: Number(r.usage?.cost_rub ?? 0) || 0 };
}

/**
 * Картинка: основная модель, при сбое провайдера — запасная. Возвращает временную ссылку Polza (7 дней) — её сразу
 * сохраняют к себе (files.storeRemote).
 */
export async function generateImage(
  ctx: AppContext,
  profile: SmmProfile,
  opts: { prompt: string; aspect: string; references?: string[]; note?: string },
): Promise<{ url: string; cost: number; model: string }> {
  await assertBudget(ctx, profile, 'image');
  const apiKey = await smmApiKey(ctx);
  const request = { prompt: opts.prompt, aspect: opts.aspect, references: opts.references ?? [] };
  const main = ctx.config.smm.imageModel;
  try {
    const r = await imageOnce(ctx, apiKey, main, request);
    await recordSpend(ctx, profile, 'image', main, r.cost, opts.note);
    return { ...r, model: main };
  } catch (error) {
    if (error instanceof SmmError && error.status === 402) throw error;
    ctx.log.warn({ err: errorMessage(error), model: main }, 'smm: main image model failed, trying the fallback');
    const r = await imageOnce(ctx, apiKey, IMAGE_FALLBACK_MODEL, { ...request, aspect: fallbackAspect(opts.aspect) });
    await recordSpend(ctx, profile, 'image', IMAGE_FALLBACK_MODEL, r.cost, opts.note);
    return { ...r, model: IMAGE_FALLBACK_MODEL };
  }
}

export interface VideoRequest {
  prompt: string;
  aspect: '9:16' | '16:9';
  /** Первый кадр: видео начинается ровно с этой картинки — так сцена точно в нашем месте съёмки. */
  firstFrame?: string;
  /** Референсы (до 3), если первого кадра нет: люди, предметы, помещение. */
  references?: string[];
  /** Промпт уже на английском — переводчик Polza не нужен (он портит термины и реплики). */
  english?: boolean;
}

const VIDEO_PROMPT_MAX = 4_000;
const REJECTED = 'Нейросеть отклонила запрос';

function videoInput(opts: VideoRequest): Record<string, unknown> {
  const references = (opts.references ?? []).slice(0, 3);
  const base = {
    prompt: opts.prompt.slice(0, VIDEO_PROMPT_MAX),
    aspect_ratio: opts.aspect,
    enableTranslation: opts.english ? 'false' : 'true',
  };
  if (opts.firstFrame) {
    return { ...base, generationType: 'FIRST_AND_LAST_FRAMES_2_VIDEO', images: [{ type: 'url', data: opts.firstFrame }] };
  }
  if (references.length) {
    return { ...base, generationType: 'REFERENCE_2_VIDEO', images: references.map((url) => ({ type: 'url', data: url })) };
  }
  return { ...base, generationType: 'TEXT_2_VIDEO' };
}

/** Видео делается минуты — запускаем задачу и опрашиваем её кроном (pollVideo). */
export async function startVideo(
  ctx: AppContext,
  profile: SmmProfile,
  opts: VideoRequest,
): Promise<{ polzaId: string; model: string }> {
  await assertBudget(ctx, profile, 'video');
  const apiKey = await smmApiKey(ctx);
  const model = ctx.config.smm.videoModel;
  const input = videoInput(opts);
  let r: MediaResponse;
  try {
    r = await polza<MediaResponse>(ctx, apiKey, '/media', { model, input, async: true }, START_VIDEO_TIMEOUT_MS);
  } catch (error) {
    // Режим не принят (модель сменили переменной) — пусть Polza выберет его сама по картинкам.
    if (!(error instanceof SmmError) || !error.message.startsWith(REJECTED)) throw error;
    ctx.log.warn({ err: error.message, model }, 'smm: video mode rejected, retrying without it');
    const auto = Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'generationType'));
    r = await polza<MediaResponse>(ctx, apiKey, '/media', { model, input: auto, async: true }, START_VIDEO_TIMEOUT_MS);
  }
  if (!r.id) throw new SmmError('Видео не запустилось — попробуйте ещё раз', 502);
  return { polzaId: r.id, model };
}

export type VideoState =
  | { status: 'pending' }
  | { status: 'done'; url: string; cost: number }
  | { status: 'failed'; error: string };

export async function pollVideo(ctx: AppContext, profile: SmmProfile, polzaId: string): Promise<VideoState> {
  const r = await polza<MediaResponse>(ctx, await smmApiKey(ctx), `/media/${encodeURIComponent(polzaId)}`, undefined, POLL_TIMEOUT_MS);
  if (r.status === 'failed' || r.status === 'cancelled') return { status: 'failed', error: mediaError(r).slice(0, 200) };
  if (r.status !== 'completed') return { status: 'pending' };
  const url = resultUrl(r.data) ?? resultUrl(r.output);
  if (!url) return { status: 'failed', error: 'нет ссылки на видео' };
  const cost = Number(r.usage?.cost_rub ?? 0) || 0;
  await recordSpend(ctx, profile, 'video', ctx.config.smm.videoModel, cost);
  return { status: 'done', url, cost };
}
