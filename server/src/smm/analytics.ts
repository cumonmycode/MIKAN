/**
 * Аналитика СММ для приложения (перенесено из Titan HUB, analytics.ts), по профилю. По каждой площадке:
 * история (подписчики, охват), сравнение форматов, лучшие дни недели и часы, топ публикаций за 60 дней
 * (и не только от маркетолога). По нашим вышедшим постам — прогноз против факта и точность.
 * Цифры за 7 и 30 дней и аудитория Instagram лежат в сводке площадки (accounts.stats).
 * Дни недели и часы — по часовому поясу студии.
 */
import { and, desc, gt, inArray } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { smmPlatformPosts } from '../db/schema-smm.js';
import { studioTimezone } from '../domain/settings.js';
import { DAY_MS, localWeekdayHour, toIso } from '../lib/time.js';
import { listAccounts, listPosts, listReports, type AccountRow } from './db.js';
import { withForecast } from './forecast.js';
import { accountHistory } from './stats.js';
import type { SmmFormat, SmmPost, SmmProfile } from './types.js';
import { withAuto } from './workflow.js';

const WINDOW_DAYS = 60;
const MIN_POSTS = 2;
const TOP_POSTS = 6;
const CAPTION_MAX = 300;
const HOUR_BUCKETS = [
  [6, 12],
  [12, 15],
  [15, 18],
  [18, 21],
  [21, 24],
  [0, 6],
] as const;
/** Неделя для приложения — с понедельника; 0 — воскресенье (как в Titan). */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

export interface TopPost {
  extId: string;
  format: SmmFormat;
  publishedAt: string | null;
  caption: string;
  permalink: string | null;
  thumb: string | null;
  views: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  postId: string | null;
}

export interface PlatformInsight {
  accountId: string;
  platform: string;
  posts: number;
  formats: { format: SmmFormat; posts: number; avgViews: number; avgLikes: number | null }[];
  /** 0 — воскресенье … 6 — суббота. */
  weekdays: { weekday: number; posts: number; avgViews: number }[];
  hours: { from: number; to: number; posts: number; avgViews: number }[];
  top: TopPost[];
}

export interface ForecastAccuracy {
  posts: number;
  /** Сколько вышло в коридоре прогноза, выше и ниже. */
  inside: number;
  above: number;
  below: number;
  /** Факт к прогнозу в среднем: 1.2 — на 20% больше ожидания. */
  ratio: number | null;
}

type Row = typeof smmPlatformPosts.$inferSelect;
const avg = (list: number[]) => (list.length ? Math.round(list.reduce((s, v) => s + v, 0) / list.length) : 0);

/** Час и день недели (0 — воскресенье) по времени студии. */
function localTime(ms: number, tz: string): { weekday: number; hour: number } {
  const { weekday, hour } = localWeekdayHour(ms, tz);
  return { weekday: weekday % 7, hour };
}

const topPost = (r: Row): TopPost => ({
  extId: r.extId,
  format: r.format as SmmFormat,
  publishedAt: toIso(r.publishedAt),
  caption: r.caption.slice(0, CAPTION_MAX),
  permalink: r.permalink,
  thumb: r.thumbUrl,
  views: r.views,
  reach: r.reach,
  likes: r.likes ?? r.reactions,
  comments: r.comments,
  shares: r.shares,
  saves: r.saves,
  postId: r.postId,
});

function insightOf(accountId: string, platform: string, list: Row[], tz: string): PlatformInsight {
  const mature = list.filter((r) => r.views != null && r.publishedAt && r.publishedAt < Date.now() - DAY_MS);
  const views = (r: Row) => r.views ?? 0;
  const formats = (['post', 'carousel', 'reel', 'story'] as SmmFormat[])
    .map((format) => {
      const of = mature.filter((r) => r.format === format);
      const likes = of.map((r) => r.likes ?? r.reactions).filter((v): v is number => v != null);
      return { format, posts: of.length, avgViews: avg(of.map(views)), avgLikes: likes.length ? avg(likes) : null };
    })
    .filter((f) => f.posts > 0);
  const feed = mature.filter((r) => r.format !== 'story');
  const weekdays = WEEK_ORDER.map((weekday) => {
    const of = feed.filter((r) => localTime(r.publishedAt!, tz).weekday === weekday);
    return { weekday, posts: of.length, avgViews: avg(of.map(views)) };
  }).filter((w) => w.posts >= MIN_POSTS);
  const hours = HOUR_BUCKETS.map(([from, to]) => {
    const of = feed.filter((r) => {
      const h = localTime(r.publishedAt!, tz).hour;
      return h >= from && h < to;
    });
    return { from, to, posts: of.length, avgViews: avg(of.map(views)) };
  }).filter((h) => h.posts >= MIN_POSTS);
  const top = list
    .filter((r) => r.views != null && r.format !== 'story')
    .sort((a, b) => views(b) - views(a))
    .slice(0, TOP_POSTS)
    .map(topPost);
  return { accountId, platform, posts: list.length, formats, weekdays, hours, top };
}

/** Насколько прогнозы сбылись: по вышедшим постам с замороженным прогнозом и фактом. */
export function accuracyOf(posts: SmmPost[]): ForecastAccuracy {
  const judged = posts.filter((p) => p.forecast?.frozen && p.forecast.expected > 0 && typeof p.stats.views === 'number');
  const ratios = judged.map((p) => p.stats.views! / p.forecast!.expected);
  return {
    posts: judged.length,
    inside: judged.filter((p) => p.stats.views! >= p.forecast!.low && p.stats.views! <= p.forecast!.high).length,
    above: judged.filter((p) => p.stats.views! > p.forecast!.high).length,
    below: judged.filter((p) => p.stats.views! < p.forecast!.low).length,
    ratio: ratios.length ? Math.round((ratios.reduce((s, v) => s + v, 0) / ratios.length) * 100) / 100 : null,
  };
}

const WEEKDAY_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const FORMAT_RU: Record<SmmFormat, string> = { post: 'пост', carousel: 'карусель', reel: 'рилс', story: 'сторис' };
/** Окно для выводов к плану: дольше, чем для экрана, — у профиля постов немного. */
const PLAN_WINDOW_DAYS = 180;

const socialAccounts = (accounts: AccountRow[]) =>
  accounts.filter((a) => a.isActive && (a.platform === 'telegram' || a.platform === 'instagram'));

/** Публикации площадок профиля за последние `days` дней, свежие первыми. */
function platformRows(ctx: AppContext, accounts: AccountRow[], days: number): Row[] {
  const ids = accounts.map((a) => a.id);
  if (!ids.length) return [];
  return ctx.db
    .select()
    .from(smmPlatformPosts)
    .where(and(inArray(smmPlatformPosts.accountId, ids), gt(smmPlatformPosts.publishedAt, Date.now() - days * DAY_MS)))
    .orderBy(desc(smmPlatformPosts.publishedAt))
    .all();
}

function insightLine(platform: string, i: PlatformInsight): string {
  const best = <T extends { avgViews: number }>(list: T[]) => [...list].sort((x, y) => y.avgViews - x.avgViews).slice(0, 3);
  const top = i.top
    .slice(0, 3)
    .map((t) => `«${t.caption.replace(/\s+/g, ' ').slice(0, 70)}» ${t.views} 👁`)
    .join('; ');
  return [
    `${platform === 'telegram' ? 'Telegram' : 'Instagram'} (${i.posts} постов за полгода):`,
    i.formats.length ? `форматы — ${i.formats.map((f) => `${FORMAT_RU[f.format]} ~${f.avgViews} 👁 (${f.posts})`).join(', ')};` : '',
    i.weekdays.length ? `лучшие дни — ${best(i.weekdays).map((w) => `${WEEKDAY_SHORT[w.weekday]} ~${w.avgViews}`).join(', ')};` : '',
    i.hours.length ? `лучшее время — ${best(i.hours).map((h) => `${h.from}–${h.to} ч ~${h.avgViews}`).join(', ')};` : '',
    top ? `топ — ${top}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/** Что заходит у профиля по цифрам (форматы, дни, часы, топ) — коротко, для плана и идей. */
export async function insightsText(ctx: AppContext, profile: SmmProfile): Promise<string> {
  const accounts = socialAccounts(await listAccounts(ctx, profile));
  const rows = platformRows(ctx, accounts, PLAN_WINDOW_DAYS);
  const tz = studioTimezone(ctx.db);
  const lines: string[] = [];
  for (const a of accounts) {
    const i = insightOf(a.id, a.platform, rows.filter((r) => r.accountId === a.id), tz);
    if (i.posts) lines.push(insightLine(a.platform, i));
  }
  return lines.join('\n');
}

export async function analyticsPayload(ctx: AppContext, profile: SmmProfile) {
  const [accounts, history, published, reports] = await Promise.all([
    listAccounts(ctx, profile),
    accountHistory(ctx, profile, WINDOW_DAYS),
    listPosts(ctx, { profile, from: new Date(Date.now() - WINDOW_DAYS * DAY_MS).toISOString(), status: ['published'] }),
    listReports(ctx, profile, 12),
  ]);
  const social = socialAccounts(accounts);
  const rows = platformRows(ctx, social, WINDOW_DAYS);
  const tz = studioTimezone(ctx.db);
  const posts = await withForecast(ctx, await withAuto(ctx, [...published].reverse()));
  const platforms = social.map((a) => insightOf(a.id, a.platform, rows.filter((r) => r.accountId === a.id), tz));
  return { accounts, history, platforms, posts, accuracy: accuracyOf(posts), reports };
}
