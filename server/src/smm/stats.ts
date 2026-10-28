/**
 * Цифры площадок профиля — только по API, без скриншотов.
 *  - Telegram: подписчики — getChatMemberCount (бот — администратор канала); посты канала с просмотрами, реакциями
 *    и временем — публичная страница t.me/s/<канал> (через шлюз: из РФ Telegram закрыт), до пяти страниц назад.
 *  - Instagram (официальный API): профиль, охват, просмотры, вовлечённость, визиты и переходы за 7 и 30 дней, охват и
 *    новые подписчики по дням, аудитория, все публикации с метриками и живые сторис.
 * Публикации площадок — в smm_platform_posts (из них прогноз, лучшее время, сравнение форматов, топ); снимок дня —
 * smm_account_stats (день — по времени студии); сводка — smm_accounts.stats_json. У каждого профиля свои площадки.
 * Раз в день — полный сбор, раз в час — свежие посты (первые двое суток).
 */
import { and, asc, desc, eq, gt, gte, ne, sql, type SQL } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { AppContext } from '../context.js';
import { smmAccounts, smmAccountStats, smmPlatformPosts, smmPosts } from '../db/schema.js';
import { errorMessage } from '../lib/errors.js';
import { DAY_MS, HOUR_MS, MINUTE_MS, parseInstant } from '../lib/time.js';
import { studioDate } from './context.js';
import { listAccounts, listPosts, updatePost, type AccountRow } from './db.js';
import { freezeForecast } from './forecast.js';
import { igAudience, igDaily, igInsights, igPeriod, igProfile, igRecentMedia, igStories, instagramState, type IgMedia } from './instagram.js';
import { webFetch } from './relay.js';
import { channelMembers, plainText } from './telegram.js';
import type { SmmFormat, SmmPost, SmmPostStats, SmmProfile } from './types.js';

const TG_PAGES = 5;
const HISTORY_DAYS = 120;
const IG_MEDIA_LIMIT = 50;
const IG_MEDIA_FRESH_LIMIT = 10;
/** Подпись поста целиком (лимит Instagram — 2200 знаков): по ней маркетолог изучает, как писал профиль. */
const CAPTION_MAX = 2200;
const FRESH_MS = 48 * HOUR_MS;
const OURS_DAYS = 60;
const MATCH_DAYS = 45;
const AVERAGE_DAYS = 30;
const ERROR_MAX = 300;

/** «1.2K» → 1200, «3,4M» → 3 400 000. */
export function parseCount(text: string): number | null {
  const m = /([\d.,]+)\s*([KkMm])?/.exec(text.replace(/\s/g, ''));
  if (!m) return null;
  const n = Number(m[1]!.replace(',', '.'));
  if (!Number.isFinite(n)) return null;
  const mult = m[2]?.toLowerCase() === 'k' ? 1_000 : m[2]?.toLowerCase() === 'm' ? 1_000_000 : 1;
  return Math.round(n * mult);
}

export interface ChannelPost {
  id: number;
  views: number | null;
  reactions: number;
  at: string | null;
  text: string;
  format: SmmFormat;
  thumb: string | null;
}

/** Посты с t.me/s/<канал>: просмотры, реакции, время, начало текста; `before` — следующая страница. */
export function parseChannelPage(html: string, handle: string): { posts: ChannelPost[]; before: number | null } {
  const posts: ChannelPost[] = [];
  for (const block of html.split('tgme_widget_message_wrap').slice(1)) {
    const id = new RegExp(`data-post="${handle}/(\\d+)"`, 'i').exec(block)?.[1];
    if (!id) continue;
    const views = /tgme_widget_message_views">([^<]+)</.exec(block)?.[1];
    let reactions = 0;
    for (const m of block.matchAll(/class="tgme_reaction[^"]*">[\s\S]*?<\/i>\s*([\d.,]+[KkMm]?)\s*<\/span>/g)) reactions += parseCount(m[1]!) ?? 0;
    const text = /tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/.exec(block)?.[1] ?? '';
    posts.push({
      id: Number(id),
      views: views ? parseCount(views) : null,
      reactions,
      at: /<time datetime="([^"]+)"/.exec(block)?.[1] ?? null,
      text: plainText(text.replace(/<br\s*\/?>/gi, '\n')).slice(0, CAPTION_MAX),
      format: /tgme_widget_message_grouped/.test(block) ? 'carousel' : 'post',
      thumb: /tgme_widget_message_photo_wrap[^>]*background-image:url\('([^']+)'\)/.exec(block)?.[1] ?? null,
    });
  }
  const before = /tme_messages_more[^>]*data-before="(\d+)"/.exec(html)?.[1];
  return { posts, before: before ? Number(before) : null };
}

// ─── Запись ──────────────────────────────────────────────────────────────────

export interface PlatformPost {
  extId: string;
  format: SmmFormat;
  publishedAt: string | null;
  caption: string;
  permalink: string | null;
  thumb: string | null;
  views?: number | null;
  reach?: number | null;
  likes?: number | null;
  comments?: number | null;
  shares?: number | null;
  saves?: number | null;
  reactions?: number | null;
  interactions?: number | null;
}

const round = (v: number | null | undefined): number | null => (v == null ? null : Math.round(v));

/** Новое значение, а если его нет — прежнее (цифры не пропадают из-за пустого ответа площадки). */
const keep = (column: SQLiteColumn): SQL => sql`coalesce(excluded.${sql.identifier(column.name)}, ${column})`;

export async function upsertPlatformPost(ctx: AppContext, account: AccountRow, p: PlatformPost): Promise<void> {
  const t = smmPlatformPosts;
  ctx.db
    .insert(t)
    .values({
      accountId: account.id,
      extId: p.extId,
      platform: account.platform,
      format: p.format,
      publishedAt: p.publishedAt ? parseInstant(p.publishedAt) : null,
      caption: p.caption.slice(0, CAPTION_MAX),
      permalink: p.permalink,
      thumbUrl: p.thumb,
      views: round(p.views),
      reach: round(p.reach),
      likes: round(p.likes),
      comments: round(p.comments),
      shares: round(p.shares),
      saves: round(p.saves),
      reactions: round(p.reactions),
      interactions: round(p.interactions),
      statsAt: Date.now(),
    })
    .onConflictDoUpdate({
      target: [t.accountId, t.extId],
      set: {
        format: sql`excluded.format`,
        caption: sql`excluded.caption`,
        statsAt: sql`excluded.stats_at`,
        publishedAt: keep(t.publishedAt),
        permalink: keep(t.permalink),
        thumbUrl: keep(t.thumbUrl),
        views: keep(t.views),
        reach: keep(t.reach),
        likes: keep(t.likes),
        comments: keep(t.comments),
        shares: keep(t.shares),
        saves: keep(t.saves),
        reactions: keep(t.reactions),
        interactions: keep(t.interactions),
      },
    })
    .run();
}

interface Snapshot {
  followers?: number | null;
  views?: number | null;
  posts?: number | null;
  engagement?: number | null;
  summary: Record<string, unknown>;
}

async function saveSnapshot(ctx: AppContext, accountId: string, s: Snapshot): Promise<void> {
  const t = smmAccountStats;
  ctx.db
    .insert(t)
    .values({
      accountId,
      day: studioDate(ctx),
      followers: s.followers ?? null,
      views: s.views ?? null,
      posts: s.posts ?? null,
      engagement: s.engagement ?? null,
      source: 'auto',
    })
    .onConflictDoUpdate({
      target: [t.accountId, t.day],
      set: { followers: keep(t.followers), views: keep(t.views), posts: keep(t.posts), engagement: keep(t.engagement), source: 'auto' },
    })
    .run();
  const now = Date.now();
  ctx.db
    .update(smmAccounts)
    .set({
      followers: sql`coalesce(${s.followers ?? null}, ${smmAccounts.followers})`,
      statsJson: JSON.stringify({ ...s.summary, views: s.views ?? null, posts: s.posts ?? null, engagement: s.engagement ?? null, source: 'auto' }),
      statsAt: now,
      statsError: null,
      updatedAt: now,
    })
    .where(eq(smmAccounts.id, accountId))
    .run();
}

/** Метрика по дням в историю площадки (охват, новые подписчики Instagram). */
async function saveDaily(ctx: AppContext, accountId: string, column: 'reach' | 'newFollowers', series: { day: string; value: number }[]): Promise<void> {
  const t = smmAccountStats;
  for (const point of series) {
    ctx.db
      .insert(t)
      .values({ accountId, day: point.day, [column]: point.value, source: 'auto' })
      .onConflictDoUpdate({ target: [t.accountId, t.day], set: { [column]: point.value } })
      .run();
  }
}

async function markError(ctx: AppContext, accountId: string, error: string): Promise<void> {
  ctx.db
    .update(smmAccounts)
    .set({ statsError: error.slice(0, ERROR_MAX), statsAt: Date.now() })
    .where(eq(smmAccounts.id, accountId))
    .run();
}

const median = (list: number[]): number | null => {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
};

/** Средние по зрелым постам (старше суток): просмотры и реакции на пост. */
async function matureAverages(
  ctx: AppContext,
  accountId: string,
): Promise<{ views: number | null; posts30: number; views30: number; reactions30: number }> {
  const t = smmPlatformPosts;
  const now = Date.now();
  const list = ctx.db
    .select({ views: t.views, likes: sql<number>`coalesce(${t.likes}, ${t.reactions}, 0)`, publishedAt: t.publishedAt })
    .from(t)
    .where(and(eq(t.accountId, accountId), ne(t.format, 'story'), gt(t.publishedAt, now - AVERAGE_DAYS * DAY_MS)))
    .orderBy(desc(t.publishedAt))
    .all();
  const mature = list.filter((r) => r.publishedAt != null && r.publishedAt < now - DAY_MS && r.views != null);
  return {
    views: median(mature.slice(0, 10).map((r) => r.views!)),
    posts30: list.length,
    views30: list.reduce((s, r) => s + (r.views ?? 0), 0),
    reactions30: list.reduce((s, r) => s + Number(r.likes ?? 0), 0),
  };
}

const parseStats = (json: string): SmmPostStats => {
  try {
    const v = JSON.parse(json) as unknown;
    return v && typeof v === 'object' ? (v as SmmPostStats) : {};
  } catch {
    return {};
  }
};

// ─── Telegram ────────────────────────────────────────────────────────────────

async function collectTelegram(ctx: AppContext, account: AccountRow, fresh: boolean): Promise<void> {
  const followers = account.tgChatId ? await channelMembers(ctx, account.tgChatId) : null;
  let pages = 0;
  let before: number | null = null;
  let seen = 0;
  if (account.handle) {
    const handle = account.handle;
    while (pages < (fresh ? 1 : TG_PAGES)) {
      const res = await webFetch(ctx, `https://t.me/s/${handle}${before ? `?before=${before}` : ''}`).catch(() => null);
      if (!res?.ok) break;
      const page = parseChannelPage(await res.text(), handle);
      pages += 1;
      for (const p of page.posts) {
        seen += 1;
        await upsertPlatformPost(ctx, account, {
          extId: String(p.id),
          format: p.format,
          publishedAt: p.at,
          caption: p.text,
          permalink: `https://t.me/${handle}/${p.id}`,
          thumb: p.thumb,
          views: p.views,
          reactions: p.reactions,
        });
      }
      const oldest = page.posts[0]?.at;
      if (!page.before || !page.posts.length || (oldest && Date.parse(oldest) < Date.now() - HISTORY_DAYS * DAY_MS)) break;
      before = page.before;
    }
  }
  if (followers == null && !seen) {
    await markError(ctx, account.id, 'Не удалось получить цифры: проверьте, что бот студии — администратор канала');
    return;
  }
  linkTelegramPosts(ctx, account);
  const since = Date.now() - OURS_DAYS * DAY_MS;
  const ours = ctx.db
    .select({ id: smmPosts.id, statsJson: smmPosts.statsJson, views: smmPlatformPosts.views, reactions: smmPlatformPosts.reactions })
    .from(smmPosts)
    .innerJoin(smmPlatformPosts, and(eq(smmPlatformPosts.postId, smmPosts.id), eq(smmPlatformPosts.accountId, account.id)))
    .where(and(eq(smmPosts.profile, account.profile), gt(smmPosts.publishedAt, since)))
    .all();
  for (const r of ours) {
    const prev = parseStats(r.statsJson);
    await updatePost(ctx, r.id, {
      stats: { ...prev, views: r.views == null ? prev.views : r.views, reactions: r.reactions ?? 0, source: 'auto' },
      statsAt: new Date().toISOString(),
    });
  }
  const avg = await matureAverages(ctx, account.id);
  const err = followers && avg.views != null ? Math.round((avg.views / followers) * 1000) / 10 : null;
  await saveSnapshot(ctx, account.id, {
    followers,
    views: avg.views,
    posts: avg.posts30,
    engagement: err,
    summary: {
      tg: {
        avgViews: avg.views,
        err,
        posts30: avg.posts30,
        views30: avg.views30,
        reactions30: avg.reactions30,
        avgReactions: avg.posts30 ? Math.round((avg.reactions30 / avg.posts30) * 10) / 10 : null,
      },
    },
  });
}

/** Наши посты канала — к постам площадки по номеру сообщения (только этого профиля и этого канала). */
function linkTelegramPosts(ctx: AppContext, account: AccountRow): void {
  const ours = sql`(SELECT ${smmPosts.id} FROM ${smmPosts}
    WHERE ${smmPosts.profile} = ${account.profile} AND ${smmPosts.platform} = 'telegram'
      AND (${smmPosts.accountId} = ${account.id} OR ${smmPosts.accountId} IS NULL)
      AND ${smmPosts.tgMessageId} IS NOT NULL AND CAST(${smmPosts.tgMessageId} AS TEXT) = ${smmPlatformPosts.extId}
    ORDER BY ${smmPosts.publishedAt} DESC LIMIT 1)`;
  ctx.db
    .update(smmPlatformPosts)
    .set({ postId: sql`${ours}` })
    .where(and(eq(smmPlatformPosts.accountId, account.id), sql`EXISTS ${ours}`))
    .run();
}

// ─── Instagram ───────────────────────────────────────────────────────────────

const shortcode = (url: string | null | undefined) => (url ? (/instagram\.com\/(?:p|reel|reels|tv)\/([\w-]+)/.exec(url)?.[1] ?? null) : null);
const norm = (s: string) =>
  plainText(s)
    .toLowerCase()
    .replace(/[^a-zа-яё0-9]+/gi, ' ')
    .trim()
    .slice(0, 60);

export function igFormat(m: IgMedia): SmmFormat {
  if (m.media_product_type === 'STORY') return 'story';
  if (m.media_product_type === 'REELS') return 'reel';
  return m.media_type === 'CAROUSEL_ALBUM' ? 'carousel' : 'post';
}

/** Наш пост к публикации Instagram: по id, по ссылке или (передан человеку) по началу подписи. */
function matchOurs(posts: SmmPost[], m: IgMedia): SmmPost | undefined {
  const code = shortcode(m.permalink);
  return (
    posts.find((p) => p.extId === m.id) ??
    (code ? posts.find((p) => shortcode(p.publishedUrl) === code) : undefined) ??
    posts.find((p) => {
      if (p.extId || p.publishedUrl || !p.handoffAt) return false;
      const head = norm(p.body);
      const since = Date.parse(p.handoffAt) - HOUR_MS;
      return head.length >= 12 && Date.parse(m.timestamp ?? '') >= since && norm(m.caption ?? '').startsWith(head.slice(0, 30));
    })
  );
}

const isoOf = (timestamp: string | undefined): string | null => {
  const ms = timestamp ? Date.parse(timestamp) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

async function collectInstagram(ctx: AppContext, account: AccountRow, fresh: boolean): Promise<void> {
  const profile = account.profile;
  if (!(await instagramState(ctx, profile))) {
    await markError(ctx, account.id, 'Подключите Instagram по API в настройках СММ — цифры придут сами');
    return;
  }
  const known = new Map(
    ctx.db
      .select({ extId: smmPlatformPosts.extId, statsAt: smmPlatformPosts.statsAt })
      .from(smmPlatformPosts)
      .where(eq(smmPlatformPosts.accountId, account.id))
      .all()
      .map((r) => [r.extId, r.statsAt]),
  );
  const media = [...(await igRecentMedia(ctx, profile, fresh ? IG_MEDIA_FRESH_LIMIT : IG_MEDIA_LIMIT)), ...(await igStories(ctx, profile))];
  const ours = (
    await listPosts(ctx, { profile, from: new Date(Date.now() - MATCH_DAYS * DAY_MS).toISOString(), status: ['approved', 'published'] })
  ).filter((p) => p.platform === 'instagram');
  for (const m of media) {
    const now = Date.now();
    const at = Date.parse(m.timestamp ?? '');
    if (Number.isFinite(at) && at < now - HISTORY_DAYS * DAY_MS) continue;
    const age = now - at;
    const last = known.get(m.id);
    // Метрики: новые — всегда; свежие (до 2 суток) — раз в час; до двух недель — раз в сутки.
    const due =
      last == null || (age < FRESH_MS && now - last > 50 * MINUTE_MS) || (!fresh && age < 14 * DAY_MS && now - last > 20 * HOUR_MS);
    const insights = due ? await igInsights(ctx, profile, m) : {};
    await upsertPlatformPost(ctx, account, {
      extId: m.id,
      format: igFormat(m),
      publishedAt: isoOf(m.timestamp),
      caption: plainText(m.caption ?? '').slice(0, CAPTION_MAX),
      permalink: m.permalink ?? null,
      thumb: m.thumbnail_url ?? m.media_url ?? null,
      views: insights['views'],
      reach: insights['reach'],
      likes: insights['likes'] ?? m.like_count ?? null,
      comments: insights['comments'] ?? m.comments_count ?? null,
      shares: insights['shares'],
      saves: insights['saves'],
      interactions: insights['interactions'],
    });
    const post = matchOurs(ours, m);
    if (!post) continue;
    ctx.db
      .update(smmPlatformPosts)
      .set({ postId: post.id })
      .where(and(eq(smmPlatformPosts.accountId, account.id), eq(smmPlatformPosts.extId, m.id)))
      .run();
    const stats: SmmPostStats = {
      ...post.stats,
      likes: insights['likes'] ?? m.like_count ?? post.stats.likes,
      comments: insights['comments'] ?? m.comments_count ?? post.stats.comments,
      source: 'auto',
    };
    for (const key of ['views', 'reach', 'shares', 'saves', 'interactions'] as const) if (insights[key] != null) stats[key] = insights[key];
    await updatePost(ctx, post.id, {
      stats,
      statsAt: new Date().toISOString(),
      extId: m.id,
      // Вышло руками — маркетолог сам нашёл публикацию: ссылка и статус.
      ...(post.status === 'approved'
        ? { status: 'published', publishedUrl: m.permalink ?? null, publishedAt: isoOf(m.timestamp) ?? new Date().toISOString() }
        : {}),
    });
    if (post.status === 'approved') await freezeForecast(ctx, post.id);
  }

  const me = await igProfile(ctx, profile);
  if (fresh) {
    ctx.db
      .update(smmAccounts)
      .set({ followers: sql`coalesce(${me.followers_count ?? null}, ${smmAccounts.followers})`, statsAt: Date.now() })
      .where(eq(smmAccounts.id, account.id))
      .run();
    return;
  }
  const [period7, period30, audience, reach, follows] = await Promise.all([
    igPeriod(ctx, profile, 7).catch(() => null),
    igPeriod(ctx, profile, 30).catch(() => null),
    igAudience(ctx, profile).catch(() => null),
    igDaily(ctx, profile, 'reach', 30),
    igDaily(ctx, profile, 'follower_count', 30),
  ]);
  await saveDaily(ctx, account.id, 'reach', reach);
  await saveDaily(ctx, account.id, 'newFollowers', follows);
  const avg = await matureAverages(ctx, account.id);
  const engagement = period30?.reach && period30.engaged != null ? Math.round((period30.engaged / period30.reach) * 1000) / 10 : null;
  await saveSnapshot(ctx, account.id, {
    followers: me.followers_count ?? null,
    views: avg.views,
    posts: me.media_count ?? null,
    engagement,
    summary: { period7, period30, audience },
  });
}

/**
 * Обойти площадки профиля и обновить цифры. `fresh` — лёгкий заход раз в час: только свежие посты и подписчики.
 * Ошибка одной площадки не мешает остальным.
 */
export async function collectStats(ctx: AppContext, profile: SmmProfile, opts: { fresh?: boolean } = {}): Promise<void> {
  for (const account of (await listAccounts(ctx, profile)).filter((a) => a.isActive)) {
    try {
      if (account.platform === 'telegram') await collectTelegram(ctx, account, !!opts.fresh);
      else if (account.platform === 'instagram') await collectInstagram(ctx, account, !!opts.fresh);
    } catch (error) {
      ctx.log.warn({ err: errorMessage(error), account: account.title, profile }, 'smm: account stats failed');
      if (!opts.fresh) await markError(ctx, account.id, 'Не удалось обновить цифры').catch(() => undefined);
    }
  }
}

export interface HistoryPoint {
  accountId: string;
  day: string;
  followers: number | null;
  views: number | null;
  reach: number | null;
  newFollowers: number | null;
}

/** История площадок профиля за N дней — для графиков. */
export async function accountHistory(ctx: AppContext, profile: SmmProfile, days = 60): Promise<HistoryPoint[]> {
  const t = smmAccountStats;
  const from = studioDate(ctx, Date.now() - days * DAY_MS);
  return ctx.db
    .select({ accountId: t.accountId, day: t.day, followers: t.followers, views: t.views, reach: t.reach, newFollowers: t.newFollowers })
    .from(t)
    .innerJoin(smmAccounts, eq(smmAccounts.id, t.accountId))
    .where(and(eq(smmAccounts.profile, profile), gte(t.day, from)))
    .orderBy(asc(t.day))
    .all();
}
