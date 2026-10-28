/**
 * Прогноз просмотров публикации — по похожим постам площадок того же профиля за 90 дней: медиана (ожидание) и
 * разброс (нижняя и верхняя четверть). Своя площадка (аккаунт поста) — если у неё хватает постов, иначе все площадки
 * профиля той же соцсети. Свой формат берём, если таких постов хотя бы три, иначе все посты с поправкой на формат.
 * Свежие посты (меньше двух суток) в расчёт не идут — их просмотры ещё растут.
 *
 * В момент выхода прогноз замораживается (frozen) — с ним сравнивается факт.
 */
import { and, eq, gt, isNotNull, lt, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { smmAccounts, smmPlatformPosts } from '../db/schema.js';
import { errorMessage } from '../lib/errors.js';
import { DAY_MS } from '../lib/time.js';
import { loadPost, updatePost } from './db.js';
import type { SmmForecast, SmmPost, SmmProfile } from './types.js';

const MIN_SAME_FORMAT = 3;
const HISTORY_DAYS = 90;
const FRESH_MS = 2 * DAY_MS;
/** Во сколько раз формат обычно набирает больше (меньше) среднего поста площадки. */
const FORMAT_FACTOR: Record<SmmPost['format'], number> = { post: 1, carousel: 1.15, reel: 1.6, story: 0.5 };

interface Sample {
  accountId: string;
  platform: string;
  format: string;
  views: number;
  likes: number | null;
}

export interface ForecastModel {
  samples: Sample[];
}

/** История активных площадок профиля; база недоступна — пустая модель (прогноза не будет). */
export async function loadForecastModel(ctx: AppContext, profile: SmmProfile): Promise<ForecastModel> {
  const now = Date.now();
  try {
    const list = ctx.db
      .select({
        accountId: smmPlatformPosts.accountId,
        platform: smmPlatformPosts.platform,
        format: smmPlatformPosts.format,
        views: smmPlatformPosts.views,
        likes: sql<number | null>`coalesce(${smmPlatformPosts.likes}, ${smmPlatformPosts.reactions})`,
      })
      .from(smmPlatformPosts)
      .innerJoin(
        smmAccounts,
        and(eq(smmAccounts.id, smmPlatformPosts.accountId), eq(smmAccounts.isActive, true), eq(smmAccounts.profile, profile)),
      )
      .where(
        and(
          isNotNull(smmPlatformPosts.views),
          gt(smmPlatformPosts.publishedAt, now - HISTORY_DAYS * DAY_MS),
          lt(smmPlatformPosts.publishedAt, now - FRESH_MS),
        ),
      )
      .all();
    return {
      samples: list.map((r) => ({
        accountId: r.accountId,
        platform: r.platform,
        format: r.format,
        views: Number(r.views),
        likes: r.likes == null ? null : Number(r.likes),
      })),
    };
  } catch (error) {
    ctx.log.warn({ err: errorMessage(error), profile }, 'smm: forecast history unavailable');
    return { samples: [] };
  }
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] ?? 0;
  const b = sorted[hi] ?? a;
  return a + (b - a) * (pos - lo);
}

/** Прогноз по готовой модели (без запросов к базе); нет истории площадки — null. */
export function forecastFor(
  model: ForecastModel,
  post: Pick<SmmPost, 'platform' | 'format'> & { accountId?: string | null },
): SmmForecast | null {
  const platform = model.samples.filter((s) => s.platform === post.platform);
  const own = post.accountId ? platform.filter((s) => s.accountId === post.accountId) : [];
  const pool = own.length >= MIN_SAME_FORMAT ? own : platform;
  if (!pool.length) return null;
  const same = pool.filter((s) => s.format === post.format);
  const base = same.length >= MIN_SAME_FORMAT ? same : pool;
  const factor = base === same ? 1 : FORMAT_FACTOR[post.format];
  const views = base.map((s) => s.views).sort((a, b) => a - b);
  const likes = base
    .map((s) => s.likes)
    .filter((v): v is number => v != null)
    .sort((a, b) => a - b);
  const round = (v: number) => Math.max(0, Math.round(v * factor));
  return {
    metric: 'views',
    expected: round(quantile(views, 0.5)),
    low: round(quantile(views, 0.25)),
    high: round(quantile(views, 0.75)),
    basis: base.length,
    likes: likes.length ? round(quantile(likes, 0.5)) : null,
    at: new Date().toISOString(),
  };
}

/** Публикациям — прогноз: замороженный (вышедшим) или посчитанный сейчас по истории их профиля. */
export async function withForecast(ctx: AppContext, posts: SmmPost[]): Promise<SmmPost[]> {
  if (!posts.length) return posts;
  const profiles = [...new Set(posts.map((p) => p.profile))];
  const models = new Map(await Promise.all(profiles.map(async (p) => [p, await loadForecastModel(ctx, p)] as const)));
  return posts.map((p) => {
    if (p.forecast?.frozen) return p;
    const model = models.get(p.profile) ?? { samples: [] };
    return { ...p, forecast: forecastFor(model, p) ?? p.forecast };
  });
}

/** Заморозить прогноз в момент выхода (повторный вызов не перезаписывает). */
export async function freezeForecast(ctx: AppContext, postId: string): Promise<void> {
  const post = await loadPost(ctx, postId);
  if (!post || post.forecast?.frozen) return;
  const forecast = forecastFor(await loadForecastModel(ctx, post.profile), post);
  if (forecast) await updatePost(ctx, postId, { forecast: { ...forecast, frozen: true } });
}
