/**
 * Что маркетолог знает о студии, когда придумывает и пишет: студия и контакты, услуги и цены по направлениям (тату,
 * пирсинг, другое), мастера (только имена), украшения в наличии и новые поступления, свободные окна на ближайшие
 * дни, тихие дни с малой загрузкой, как загружены дни недели, памятки студии по уходу и её база знаний. Плюс
 * маркетинговая часть профиля: голос, память, площадки и как заходили прошлые публикации.
 *
 * Профиль автора — личный блог, отдельный от работы студии: в его фактах нет ничего из MIKAN (услуг, цен, мастеров,
 * записей, окон, склада, адреса, настроек студии). Имена и данные клиентов не попадают никуда — только счётчики.
 */
import { and, asc, desc, eq, gt, gte, inArray, lt, notInArray } from 'drizzle-orm';
import { DateTime } from 'luxon';
import type { AppContext } from '../context.js';
import {
  aftercareTemplates,
  appointments,
  employees,
  knowledgeEntries,
  products,
  productVariants,
  services,
  smmPosts,
  stockMovements,
} from '../db/schema.js';
import { REVIEW_MARKER } from '../db/seed-content.js';
import { bookableMasters, freeSlots, SLOT_STEP_MIN, workingWindow } from '../domain/free-slots.js';
import { hasSizeInStock } from '../domain/products.js';
import { getCachedBotUsername, getStudioSettings, studioTimezone } from '../domain/settings.js';
import { errorMessage } from '../lib/errors.js';
import { parseSteps, parseVariants, type ServiceRow } from '../lib/serialize.js';
import { formatRub, formatServicePrice } from '../lib/text.js';
import { DAY_MS, localDate, MINUTE_MS } from '../lib/time.js';
import { listAccounts, listMemory, listReports } from './db.js';
import { getSmmSettings, type SmmSettings } from './settings.js';
import type { SmmPostStats, SmmProfile } from './types.js';

/** Дни недели по номеру ISO (luxon: 1 — понедельник). */
const WEEKDAYS = ['', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
const WEEKDAYS_SHORT = ['', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const CATEGORY_TITLE: Record<string, string> = { tattoo: 'Тату', piercing: 'Пирсинг', other: 'Другое' };
/** Записи, которые не занимают время мастера. */
const INACTIVE = ['cancelled', 'no_show'];

/** Окна на неделю: на сколько дней вперёд и какое окно считаем свободным (короче — не предлагаем). */
const WINDOW_DAYS = 7;
const WINDOW_MIN = 60;
/** Тихие дни ищем на две недели вперёд: загрузка мастеров ниже этой доли — повод для поста. */
const QUIET_DAYS = 14;
const QUIET_LOAD = 0.3;
/** Как загружены дни недели — по прошлым 8 неделям. */
const TRAFFIC_WEEKS = 8;
/** Новые поступления украшений — за три недели. */
const ARRIVALS_DAYS = 21;
const ARRIVALS_MAX = 10;
const SERVICE_NOTE_MAX = 140;
const MEMO_MAX = 900;
const KNOWLEDGE_MAX = 12;
const KNOWLEDGE_ENTRY_MAX = 500;
/** Прошлые публикации для маркетинговой части: за 45 дней, не больше 25. */
const RECENT_DAYS = 45;
const RECENT_MAX = 25;

const short = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? '';

/** YYYY-MM-DD по времени студии (замена `mskDate` Titan). */
export const studioDate = (ctx: AppContext, ms = Date.now()): string => localDate(ms, studioTimezone(ctx.db));

/** «2026-10-20» + «19:00» по времени студии → ISO. null — дата или время не распознаны. */
export function studioToIso(ctx: AppContext, date: string, time: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{1,2}:\d{2}$/.test(time)) return null;
  const dt = DateTime.fromISO(`${date}T${time.padStart(5, '0')}`, { zone: studioTimezone(ctx.db) });
  return dt.isValid ? new Date(dt.toMillis()).toISOString() : null;
}

/** Название бренда профиля для промптов и подписей (`settings.brandName`). */
export async function brandTitle(ctx: AppContext, profile: SmmProfile): Promise<string> {
  return getSmmSettings(ctx.db, profile).brandName;
}

// ─── Студия ──────────────────────────────────────────────────────────────────

function venue(ctx: AppContext): string[] {
  const s = getStudioSettings(ctx.db);
  const bot = ctx.gateway.username() ?? getCachedBotUsername(ctx.db);
  const hours = s.workingHours.trim() || `${s.workdayStart}–${s.workdayEnd}`;
  return [
    `Студия: ${s.name}${s.address.trim() ? `, адрес: ${s.address.trim()}` : ''}, часы работы: ${hours}.`,
    s.phone.trim() ? `Телефон: ${s.phone.trim()}` : '',
    s.website.trim() ? `Сайт студии: ${s.website.trim()}` : '',
    bot ? `Telegram-бот студии: @${bot} — запись, цены, подбор украшений и ответы на вопросы.` : '',
    s.about.trim() ? `О студии (от владельца): ${s.about.trim()}` : '',
  ];
}

const duration = (min: number): string => {
  if (min < 60) return `${min} мин`;
  const rest = min % 60;
  return rest ? `${Math.floor(min / 60)} ч ${rest} мин` : `${min / 60} ч`;
};

function serviceText(s: ServiceRow): string {
  const variants = parseVariants(s.variantsJson);
  const extra = [
    `~${duration(s.durationMin)}`,
    variants.length ? `варианты: ${variants.map((v) => `${v.name} ${formatRub(v.price)}`).join(', ')}` : '',
    s.depositAmount > 0 ? `предоплата ${formatRub(s.depositAmount)}` : '',
    s.description?.trim() ? short(s.description.trim().replace(/\s+/g, ' '), SERVICE_NOTE_MAX) : '',
  ].filter(Boolean);
  return `${s.name} — ${formatServicePrice(s.price, s.priceMax, s.priceFrom)} (${extra.join('; ')})`;
}

/** Прайс по направлениям и группам: «Пирсинг · Ухо: Мочка — 1 600 ₽ (~30 мин); …». */
function catalog(ctx: AppContext): string[] {
  const rows = ctx.db
    .select()
    .from(services)
    .where(eq(services.active, true))
    .orderBy(asc(services.sort), asc(services.name), asc(services.id))
    .all();
  if (!rows.length) return ['Прайс студии пока не заполнен — цены в постах не называй.'];
  const categories = [...new Set([...Object.keys(CATEGORY_TITLE), ...rows.map((r) => r.category)])];
  const lines = ['Услуги и цены («от N ₽» — итог зависит от размера и сложности, точную цену называет мастер):'];
  for (const category of categories) {
    const inCategory = rows.filter((r) => r.category === category);
    const groups = [...new Set(inCategory.map((r) => r.groupName?.trim() || ''))];
    for (const group of groups) {
      const items = inCategory.filter((r) => (r.groupName?.trim() || '') === group);
      const title = [CATEGORY_TITLE[category] ?? category, group].filter(Boolean).join(' · ');
      lines.push(`- ${title}: ${items.map(serviceText).join('; ')}.`);
    }
  }
  return lines;
}

function masters(ctx: AppContext): string[] {
  const rows = ctx.db
    .select({ name: employees.name })
    .from(employees)
    .where(and(eq(employees.active, true), eq(employees.isMaster, true)))
    .orderBy(asc(employees.name))
    .all();
  const names = [...new Set(rows.map((r) => firstName(r.name)).filter(Boolean))];
  return names.length ? [`Мастера студии (только имена; стиль и опыт — из портрета студии): ${names.join(', ')}.`] : [];
}

/** Украшения в наличии: виды, материалы, цены «от»; новые поступления. Сколько штук на складе — не говорим. */
function jewelry(ctx: AppContext): string[] {
  const rows = ctx.db
    .select({ id: products.id, name: products.name, category: products.category, material: products.material, price: products.price })
    .from(products)
    .where(and(eq(products.kind, 'jewelry'), eq(products.active, true), eq(products.archived, false), hasSizeInStock))
    .orderBy(asc(products.categorySort), asc(products.nameSort))
    .all();
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const sizes = ctx.db
    .select({ productId: productVariants.productId, price: productVariants.price })
    .from(productVariants)
    .where(and(inArray(productVariants.productId, ids), eq(productVariants.archived, false), gt(productVariants.quantity, 0)))
    .all();
  const prices = sizes.map((v) => v.price ?? byId.get(v.productId)?.price ?? 0).filter((p) => p > 0);
  const kinds = [...new Set(rows.map((r) => r.category?.trim()).filter((c): c is string => Boolean(c)))];
  const materials = [...new Set(rows.map((r) => r.material?.trim()).filter((m): m is string => Boolean(m)))];
  const since = Date.now() - ARRIVALS_DAYS * DAY_MS;
  const arrived = ctx.db
    .select({ productId: stockMovements.productId })
    .from(stockMovements)
    .where(and(eq(stockMovements.type, 'receipt'), gte(stockMovements.createdAt, since), inArray(stockMovements.productId, ids)))
    .orderBy(desc(stockMovements.createdAt))
    .all();
  const fresh = [...new Set(arrived.map((m) => m.productId))]
    .slice(0, ARRIVALS_MAX)
    .map((id) => byId.get(id))
    .filter((p): p is NonNullable<typeof p> => Boolean(p))
    .map((p) => [p.name, p.material].filter(Boolean).join(', '));
  return [
    [
      'Украшения в наличии (сколько штук — не называй):',
      kinds.length ? `виды — ${kinds.join(', ')};` : '',
      materials.length ? `материалы — ${materials.join(', ')};` : '',
      prices.length ? `цены — от ${formatRub(Math.min(...prices))}.` : '',
    ]
      .filter(Boolean)
      .join(' '),
    fresh.length ? `Новые поступления украшений (за ${ARRIVALS_DAYS} дней, есть в наличии): ${fresh.join('; ')}.` : '',
  ];
}

const hhmm = (ms: number, tz: string) => DateTime.fromMillis(ms, { zone: tz }).toFormat('HH:mm');
const dayLabel = (date: string, tz: string) => {
  const d = DateTime.fromISO(date, { zone: tz });
  return `${WEEKDAYS_SHORT[d.weekday]} ${d.toFormat('dd.MM')}`;
};

/** Даты студии на `count` дней, начиная со сдвига `from` (0 — сегодня). */
function nextDates(tz: string, from: number, count: number): string[] {
  const start = DateTime.now().setZone(tz).startOf('day');
  return Array.from({ length: count }, (_, i) => start.plus({ days: from + i }).toISODate() ?? '').filter(Boolean);
}

/** Начала свободных слотов подряд → окна [начало, конец). */
function windowsOf(starts: number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const start of starts) {
    const last = out[out.length - 1];
    if (last && start <= last[1] - WINDOW_MIN * MINUTE_MS + SLOT_STEP_MIN * MINUTE_MS) last[1] = start + WINDOW_MIN * MINUTE_MS;
    else out.push([start, start + WINDOW_MIN * MINUTE_MS]);
  }
  return out;
}

/** Свободные окна по мастерам на ближайшие дни — для постов «окна на неделю». */
function freeWindows(ctx: AppContext, days: number): string[] {
  const tz = studioTimezone(ctx.db);
  const now = Date.now();
  const dates = nextDates(tz, 0, days);
  const byMaster = new Map<string, string[]>();
  for (const date of dates) {
    for (const { master, starts } of freeSlots(ctx.db, { date, durationMin: WINDOW_MIN, now })) {
      const windows = windowsOf(starts);
      if (!windows.length) continue;
      const name = firstName(master.name) || 'мастер';
      const text = `${dayLabel(date, tz)} ${windows.map(([a, b]) => `${hhmm(a, tz)}–${hhmm(b, tz)}`).join(', ')}`;
      byMaster.set(name, [...(byMaster.get(name) ?? []), text]);
    }
  }
  if (!byMaster.size) {
    return [`Свободных окон на ближайшие ${days} дн. нет — не зови на эти дни, зови на консультацию и следующую неделю.`];
  }
  return [
    `Свободные окна для записи на ${days} дн. вперёд (время подтверждает администратор; пост выйдет позже — пиши «есть окна», без обещаний точного часа):`,
    ...[...byMaster].map(([name, list]) => `- ${name}: ${list.join('; ')}`),
  ];
}

/** Загрузка мастеров по дням: занятые минуты рабочего времени / (мастера × рабочие минуты). */
function dayLoad(ctx: AppContext, date: string, masterIds: number[]): number | null {
  const window = workingWindow(ctx.db, date);
  if (!window || !masterIds.length || window.close <= window.open) return null;
  const busy = ctx.db
    .select({ startsAt: appointments.startsAt, endsAt: appointments.endsAt })
    .from(appointments)
    .where(
      and(
        inArray(appointments.masterId, masterIds),
        lt(appointments.startsAt, window.close),
        gt(appointments.endsAt, window.open),
        notInArray(appointments.status, INACTIVE),
      ),
    )
    .all();
  const taken = busy.reduce((sum, b) => sum + Math.min(b.endsAt, window.close) - Math.max(b.startsAt, window.open), 0);
  return taken / ((window.close - window.open) * masterIds.length);
}

/** Тихие дни (загрузка ниже 30%) с завтрашнего дня на две недели — повод позвать на них. */
function quietDays(ctx: AppContext, days: number): string[] {
  const tz = studioTimezone(ctx.db);
  const masterIds = bookableMasters(ctx.db).map((m) => m.id);
  const quiet = nextDates(tz, 1, days)
    .map((date) => ({ date, load: dayLoad(ctx, date, masterIds) }))
    .filter((d): d is { date: string; load: number } => d.load !== null && d.load < QUIET_LOAD);
  if (!quiet.length) return [];
  return [
    `Тихие дни (мало записей) в ближайшие ${days} дн.: ${quiet.map((d) => `${dayLabel(d.date, tz)} (загрузка ~${Math.round(d.load * 100)}%)`).join(', ')} — ` +
      'повод для поста-приглашения на эти дни; скидки и акции — только если они есть в фактах или памяти.',
  ];
}

/** Сколько записей в среднем по дням недели за 8 недель — где проседает. */
function traffic(ctx: AppContext): string[] {
  const tz = studioTimezone(ctx.db);
  const to = DateTime.now().setZone(tz).startOf('day');
  const from = to.minus({ weeks: TRAFFIC_WEEKS });
  const rows = ctx.db
    .select({ startsAt: appointments.startsAt })
    .from(appointments)
    .where(and(gte(appointments.startsAt, from.toMillis()), lt(appointments.startsAt, to.toMillis()), notInArray(appointments.status, INACTIVE)))
    .all();
  if (!rows.length) return [];
  const byDow = new Array<number>(8).fill(0);
  for (const r of rows) {
    const dow = DateTime.fromMillis(r.startsAt, { zone: tz }).weekday;
    byDow[dow] = (byDow[dow] ?? 0) + 1;
  }
  const avg = byDow.slice(1).map((n, i) => `${WEEKDAYS_SHORT[i + 1]} ~${Math.round((n / TRAFFIC_WEEKS) * 10) / 10}`);
  return [`Записей в среднем за день по дням недели (${TRAFFIC_WEEKS} недель): ${avg.join(', ')}.`];
}

/** Памятки студии по уходу: в постах про уход опираемся на них, а не только на общую справку. */
function aftercare(ctx: AppContext): string[] {
  const rows = ctx.db.select().from(aftercareTemplates).orderBy(asc(aftercareTemplates.id)).all();
  if (!rows.length) return [];
  return [
    'Памятки студии по уходу (как студия советует ухаживать — посты про уход не должны им противоречить):',
    ...rows.map((t) => {
      const steps = parseSteps(t.stepsJson).map((s) => `день ${s.dayOffset}: ${s.text.replace(/\s+/g, ' ').trim()}`);
      return `- ${t.name}: ${short(steps.join(' | '), MEMO_MAX)}`;
    }),
  ];
}

/** База знаний бота студии (условия, подготовка, противопоказания) — коротко. */
function studioKnowledge(ctx: AppContext): string[] {
  const rows = ctx.db
    .select()
    .from(knowledgeEntries)
    .where(eq(knowledgeEntries.active, true))
    .orderBy(asc(knowledgeEntries.sort), asc(knowledgeEntries.id))
    .limit(KNOWLEDGE_MAX)
    .all();
  if (!rows.length) return [];
  return [
    'База знаний студии (что студия говорит клиентам):',
    ...rows.map((k) => `- ${k.title.replace(REVIEW_MARKER, '').trim()}: ${short(k.content.replace(/\s+/g, ' ').trim(), KNOWLEDGE_ENTRY_MAX)}`),
  ];
}

/** Факты автора: только то, что это личный блог, — данных студии здесь нет. */
function authorFacts(ctx: AppContext): string {
  const { brandName } = getSmmSettings(ctx.db, 'author');
  return [
    `Автор блога: ${brandName}. Это личный блог, отдельный от работы: в нём нет услуг, цен, записи, мастеров, расписания и адреса — не упоминай и не выдумывай их.`,
    'О жизни, работе и планах автора можно говорить только то, что есть в портрете автора, памяти и её прошлых постах.',
  ].join('\n');
}

/**
 * Факты профиля для промпта — всё, что можно обещать и упоминать в постах (замена `clubFacts` Titan). У студии —
 * данные MIKAN на `days` дней вперёд (окна — не дальше недели, тихие дни — двух); у автора — без данных студии.
 */
export async function brandFacts(ctx: AppContext, profile: SmmProfile, days = 45): Promise<string> {
  if (profile === 'author') return authorFacts(ctx);
  const parts: ((c: AppContext) => string[])[] = [
    venue,
    catalog,
    masters,
    jewelry,
    (c) => freeWindows(c, Math.min(days, WINDOW_DAYS)),
    (c) => quietDays(c, Math.min(days, QUIET_DAYS)),
    traffic,
    aftercare,
    studioKnowledge,
  ];
  return parts
    .flatMap((part) => {
      try {
        return part(ctx);
      } catch (error) {
        ctx.log.warn({ err: errorMessage(error) }, 'smm: part of the studio facts failed to load');
        return [];
      }
    })
    .filter(Boolean)
    .join('\n');
}

// ─── Маркетинг ───────────────────────────────────────────────────────────────

export interface MarketingContext {
  settings: SmmSettings;
  text: string;
}

const STAT_KEYS = ['views', 'likes', 'comments', 'shares', 'saves', 'reach'] as const;

function statsOf(json: string): SmmPostStats {
  try {
    const value: unknown = JSON.parse(json);
    return value && typeof value === 'object' ? (value as SmmPostStats) : {};
  } catch {
    return {};
  }
}

/** Маркетинговая часть профиля: голос, цели, память маркетолога, площадки, как заходили прошлые посты. */
export async function marketingContext(ctx: AppContext, profile: SmmProfile): Promise<MarketingContext> {
  const settings = getSmmSettings(ctx.db, profile);
  const [memory, accounts, reports] = await Promise.all([
    listMemory(ctx, profile),
    listAccounts(ctx, profile),
    listReports(ctx, profile, 1),
  ]);
  const recent = ctx.db
    .select({ platform: smmPosts.platform, format: smmPosts.format, topic: smmPosts.topic, publishedAt: smmPosts.publishedAt, statsJson: smmPosts.statsJson })
    .from(smmPosts)
    .where(and(eq(smmPosts.profile, profile), eq(smmPosts.status, 'published'), gt(smmPosts.publishedAt, Date.now() - RECENT_DAYS * DAY_MS)))
    .orderBy(desc(smmPosts.publishedAt))
    .limit(RECENT_MAX)
    .all();
  const author = profile === 'author';
  const memoryLines = memory.slice(0, 60).map((m) => `- [${m.kind}] ${m.text}`);
  const accountLines = accounts
    .filter((a) => a.isActive)
    .map((a) => `${a.platform}: ${a.title}${a.handle ? ` (@${a.handle})` : ''}${a.followers != null ? `, подписчиков ${a.followers}` : ''}`);
  const recentLines = recent.map((p) => {
    const s = statsOf(p.statsJson);
    const nums = STAT_KEYS.filter((k) => s[k] != null).map((k) => `${k} ${s[k]}`).join(', ');
    return `- ${p.publishedAt ? studioDate(ctx, p.publishedAt) : '—'} ${p.platform}/${p.format}: ${p.topic}${nums ? ` → ${nums}` : ''}`;
  });
  const report = reports[0];
  const text = [
    `Голос ${author ? 'автора' : 'бренда'}: ${settings.voice}`,
    `Аудитория: ${settings.audience}`,
    `Цели ${author ? 'блога' : 'маркетинга'}: ${settings.goals}`,
    accountLines.length ? `Площадки: ${accountLines.join('; ')}.` : '',
    memoryLines.length ? `Память (правила ${author ? 'автора' : 'владельца'} и выводы — соблюдай всегда):\n${memoryLines.join('\n')}` : '',
    recentLines.length ? `Последние публикации и их результат:\n${recentLines.join('\n')}` : '',
    report ? `Выводы последнего отчёта (${report.periodFrom}..${report.periodTo}): ${report.recommendations.map((r) => r.title).join('; ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return { settings, text };
}

/** День недели по-русски для даты студии (подписи в промптах). */
export const weekdayOf = (ctx: AppContext, date: string): string =>
  WEEKDAYS[DateTime.fromISO(date, { zone: studioTimezone(ctx.db) }).weekday] ?? '';
