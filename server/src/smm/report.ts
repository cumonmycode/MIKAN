/**
 * Отчёт аналитики профиля: что вышло за период, как зашло (просмотры, лайки, рост подписчиков), у студии — как это
 * совпало с её жизнью (визиты по дням, только числа, без имён), — и что делать дальше. Выводы маркетолог запоминает и
 * учитывает в следующих планах и постах. У автора отчёт только о её соцсетях — без данных студии.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, between, eq, gte, lt } from 'drizzle-orm';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { appointments } from '../db/schema.js';
import { smmAccounts, smmAccountStats, smmReports } from '../db/schema-smm.js';
import { studioTimezone } from '../domain/settings.js';
import { localDate } from '../lib/time.js';
import { chatJson } from './ai.js';
import { brandTitle, marketingContext, studioDate, studioToIso } from './context.js';
import { listAccounts, listPosts, mapReport, remember } from './db.js';
import { systemPrompt, todayLine } from './prompts.js';
import { SmmError, type SmmProfile, type SmmReport } from './types.js';

const DAY_MS = 86_400_000;
/** Сколько дней до периода показываем для сравнения (площадки и визиты). */
const BEFORE_DAYS = 7;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const ReportSchema = z.object({
  title: z.string().min(3).max(120),
  summary: z.string().min(20).max(3000),
  metrics: z
    .array(z.object({ label: z.string().max(60), value: z.string().max(40), delta: z.number().nullable().optional() }))
    .max(8),
  recommendations: z
    .array(z.object({ title: z.string().max(120), detail: z.string().max(500) }))
    .min(1)
    .max(6),
  insights: z.array(z.string().min(5).max(300)).max(3).optional(),
});

const day = (ctx: AppContext, offset: number) => studioDate(ctx, Date.now() + offset * DAY_MS);
const shiftDay = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** Сводка площадки по API одной строкой: Instagram — неделя, Telegram — посты за месяц. */
function accountLine(a: { platform: string; title: string; followers: number | null; stats: Record<string, unknown> }): string {
  const parts = [`${a.platform} ${a.title}: подписчиков ${a.followers ?? '?'}`];
  const week = a.stats['period7'] as Record<string, number | null> | undefined;
  if (week) {
    parts.push(
      `за 7 дней охват ${week['reach'] ?? '?'}, просмотры ${week['views'] ?? '?'}, вовлечённые ${week['engaged'] ?? '?'}, визиты профиля ${week['profileViews'] ?? '?'}, переходы ${week['linkTaps'] ?? '?'}, новых подписчиков ${week['follows'] ?? '?'}`,
    );
  }
  const tg = a.stats['tg'] as Record<string, number | null> | undefined;
  if (tg) {
    parts.push(
      `просмотров на пост ~${tg['avgViews'] ?? '?'}, ERR ${tg['err'] ?? '?'}%, постов за 30 дней ${tg['posts30'] ?? '?'}, реакций на пост ${tg['avgReactions'] ?? '?'}`,
    );
  }
  return parts.join('; ');
}

/** Цифры площадок профиля по дням, включая неделю до периода. */
function accountHistory(ctx: AppContext, profile: SmmProfile, from: string, to: string) {
  return ctx.db
    .select({
      title: smmAccounts.title,
      platform: smmAccounts.platform,
      day: smmAccountStats.day,
      followers: smmAccountStats.followers,
      reach: smmAccountStats.reach,
      newFollowers: smmAccountStats.newFollowers,
    })
    .from(smmAccountStats)
    .innerJoin(smmAccounts, eq(smmAccounts.id, smmAccountStats.accountId))
    .where(and(eq(smmAccounts.profile, profile), between(smmAccountStats.day, shiftDay(from, -BEFORE_DAYS), to)))
    .orderBy(asc(smmAccountStats.day))
    .all();
}

/**
 * Визиты студии по дням (завершённые записи, только число — без клиентов и мастеров), включая неделю до периода.
 * У автора визитов нет: её соцсети не связаны с работой студии.
 */
function studioVisits(ctx: AppContext, profile: SmmProfile, fromMs: number, toMs: number): { day: string; n: number }[] {
  if (profile !== 'studio') return [];
  const tz = studioTimezone(ctx.db);
  const rows = ctx.db
    .select({ startsAt: appointments.startsAt })
    .from(appointments)
    .where(and(eq(appointments.status, 'completed'), gte(appointments.startsAt, fromMs - BEFORE_DAYS * DAY_MS), lt(appointments.startsAt, toMs)))
    .all();
  const byDay = new Map<string, number>();
  for (const r of rows) {
    const d = localDate(r.startsAt, tz);
    byDay.set(d, (byDay.get(d) ?? 0) + 1);
  }
  return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([d, n]) => ({ day: d, n }));
}

/** Что разобрать: у студии — ещё и связь публикаций с визитами. */
const REVIEW_TASK: Record<SmmProfile, string> = {
  studio:
    'Разбери честно и коротко: что сработало, что нет и почему, есть ли связь публикаций с визитами в студию. Рекомендации — конкретные действия на следующую неделю.',
  author: 'Разбери честно и коротко: что сработало, что нет и почему. Рекомендации — конкретные действия на следующую неделю.',
};

/** Отчёт профиля за период (по умолчанию — прошлые 7 дней). */
export async function generateReport(ctx: AppContext, profile: SmmProfile, period?: { from: string; to: string }): Promise<SmmReport> {
  const from = period?.from ?? day(ctx, -7);
  const to = period?.to ?? day(ctx, -1);
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to) throw new SmmError('Неверный период отчёта', 400);
  const fromIso = studioToIso(ctx, from, '00:00');
  const toIso = studioToIso(ctx, shiftDay(to, 1), '00:00');
  if (!fromIso || !toIso) throw new SmmError('Неверный период отчёта', 400);
  const [name, marketing, accounts, posts] = await Promise.all([
    brandTitle(ctx, profile),
    marketingContext(ctx, profile),
    listAccounts(ctx, profile),
    listPosts(ctx, { profile, from: fromIso, to: toIso }),
  ]);
  const history = accountHistory(ctx, profile, from, to);
  const visits = studioVisits(ctx, profile, Date.parse(fromIso), Date.parse(toIso));
  const postLines = posts.map((p) => {
    const s = p.stats;
    const keys = ['views', 'likes', 'comments', 'shares', 'saves', 'reach'] as const;
    const nums = keys
      .filter((k) => s[k] != null)
      .map((k) => `${k} ${s[k]}`)
      .join(', ');
    const at = p.publishAt ? studioDate(ctx, Date.parse(p.publishAt)) : '—';
    return `- ${at} ${p.platform}/${p.format} [${p.status}] ${p.topic}${nums ? ` → ${nums}` : ' → цифр нет'}`;
  });
  const historyLines = history.map(
    (h) => `${h.day} ${h.title}: подписчики ${h.followers ?? '?'}, охват ${h.reach ?? '?'}, новых ${h.newFollowers ?? '?'}`,
  );
  const r = await chatJson(ctx, profile, {
    system: systemPrompt(profile, name),
    note: `отчёт ${from}..${to}`,
    maxTokens: 3500,
    temperature: 0.4,
    schema: ReportSchema,
    user: [
      todayLine(ctx),
      `Маркетинг:\n${marketing.text}`,
      '',
      `Отчёт за ${from}..${to}.`,
      `Площадки сейчас:\n${accounts.filter((a) => a.isActive).map(accountLine).join('\n') || 'не подключены'}`,
      historyLines.length ? `Динамика площадок по дням:\n${historyLines.join('\n')}` : 'Истории цифр площадок пока нет.',
      postLines.length ? `Публикации периода:\n${postLines.join('\n')}` : 'Публикаций за период нет.',
      visits.length
        ? `Визитов в студию (завершённых записей) по дням, включая неделю до периода:\n${visits.map((v) => `${v.day}: ${v.n}`).join(', ')}`
        : '',
      '',
      REVIEW_TASK[profile],
      'Ответ — JSON: {"title": "заголовок отчёта", "summary": "3–6 предложений выводов", "metrics": [{"label": "...", "value": "...", "delta": % или null}], "recommendations": [{"title": "что сделать", "detail": "как и зачем"}], "insights": ["устойчивый вывод на будущее, если есть"]}',
    ]
      .filter((line) => line !== '')
      .join('\n'),
  });
  const row = ctx.db
    .insert(smmReports)
    .values({
      id: randomUUID(),
      profile,
      periodFrom: from,
      periodTo: to,
      title: r.title,
      summary: r.summary,
      metricsJson: JSON.stringify(r.metrics),
      recommendationsJson: JSON.stringify(r.recommendations),
      createdAt: Date.now(),
    })
    .returning()
    .get();
  for (const text of r.insights ?? []) await remember(ctx, profile, { kind: 'insight', text, source: 'analytics' });
  return mapReport(row);
}
