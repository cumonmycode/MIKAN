/**
 * Праздники и поводы для контент-плана: российские государственные праздники и памятные дни, большие инфоповоды
 * (14 февраля — парные тату, 23 февраля и 8 марта — сертификаты, Чёрная пятница, Новый год, выпускные), сезоны
 * (лето — солнце и заживление, осень — время больших работ), даты тату-культуры (каждая пятница, 13-е — флеш-день)
 * и свои даты профиля (smm_dates). На каждую значимую дату маркетолог ставит тематический пост; в траурные дни —
 * никаких развлекательных постов.
 *
 * Плавающие даты (Пасха и Масленица) считаются по году; Чёрная пятница — пятница после четвёртого четверга ноября.
 * У личного блога автора продающих поводов студии нет, у остальных — своя важность.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { smmDates } from '../db/schema.js';
import { SmmError, type SmmProfile } from './types.js';

/** celebrate — поздравить и позвать; sell — повод продать (сертификат, украшение, запись); fun — повод для юмора и
 * культуры тату; respect — уважительно, без развлекательного тона; mourning — траур: развлекательных постов нет. */
export type DateTone = 'celebrate' | 'sell' | 'fun' | 'respect' | 'mourning';

type Weight = 1 | 2 | 3;

export interface BrandDate {
  /** YYYY-MM-DD; у сезона — первый день. */
  date: string;
  /** Последний день сезона (у обычной даты нет). */
  until?: string;
  title: string;
  tone: DateTone;
  /** 3 — обязателен тематический пост, 2 — желателен, 1 — по возможности. */
  weight: Weight;
  note: string;
  /** Своя дата профиля (из базы знаний), а не встроенная. */
  own?: boolean;
  id?: string;
}

/** У автора (личный блог): своя важность и подсказка; false — повод не для личного блога. */
type AuthorView = { weight: Weight; note: string } | false;

interface Fixed {
  md: string;
  title: string;
  tone: DateTone;
  weight: Weight;
  note: string;
  author?: AuthorView;
}

const FIXED: Fixed[] = [
  { md: '01-01', title: 'Новый год', tone: 'celebrate', weight: 3, note: 'поздравление; первые окна и планы года' },
  { md: '01-07', title: 'Рождество', tone: 'celebrate', weight: 1, note: 'тёплое поздравление' },
  { md: '01-25', title: 'Татьянин день — День студентов', tone: 'fun', weight: 1, note: 'студенты 18+, первая тату или прокол после сессии', author: { weight: 1, note: 'лёгкий пост про студенчество' } },
  {
    md: '02-14', title: 'День всех влюблённых', tone: 'sell', weight: 3,
    note: 'парные тату и парные проколы, сертификат в подарок; анонс — за 1–2 недели',
    author: { weight: 2, note: 'про любовь и парные тату — история или мнение, без продаж' },
  },
  {
    md: '02-23', title: 'День защитника Отечества', tone: 'sell', weight: 3,
    note: 'поздравить; заранее (за 2–3 недели) — подарочные сертификаты',
    author: { weight: 1, note: 'короткое поздравление' },
  },
  {
    md: '03-08', title: 'Международный женский день', tone: 'sell', weight: 3,
    note: 'поздравить; заранее (за 2–3 недели) — сертификаты, украшения в подарок, прокол «подарок себе»',
    author: { weight: 2, note: 'тёплое поздравление подписчицам' },
  },
  { md: '04-01', title: 'День смеха', tone: 'fun', weight: 1, note: 'юмор тату-мира, мифы с иронией (без насмешек над клиентами)' },
  { md: '05-01', title: 'Праздник Весны и Труда', tone: 'celebrate', weight: 1, note: 'длинные выходные — время на сеанс', author: { weight: 1, note: 'весна, выходные' } },
  { md: '05-09', title: 'День Победы', tone: 'respect', weight: 3, note: 'только уважительное поздравление: без продаж, акций и юмора' },
  { md: '06-12', title: 'День России', tone: 'celebrate', weight: 2, note: 'поздравление; выходной', author: { weight: 1, note: 'короткое поздравление' } },
  { md: '06-22', title: 'День памяти и скорби', tone: 'mourning', weight: 2, note: 'день памяти: развлекательных постов, анонсов и продаж нет, допустимы только слова памяти' },
  { md: '06-27', title: 'День молодёжи', tone: 'fun', weight: 1, note: 'молодые клиенты 18+, первая тату', author: { weight: 1, note: 'лёгкий пост' } },
  { md: '07-08', title: 'День семьи, любви и верности', tone: 'celebrate', weight: 1, note: 'парные и семейные тату (только взрослые)' },
  { md: '09-01', title: 'День знаний', tone: 'celebrate', weight: 1, note: 'конец лета: солнца меньше — удобнее заживлять, время для новых работ', author: { weight: 1, note: 'новый сезон, планы' } },
  { md: '10-31', title: 'Хэллоуин', tone: 'fun', weight: 2, note: 'жуткие эскизы и флеш, тематический образ; анонс заранее', author: { weight: 1, note: 'тематический образ или эскиз' } },
  { md: '11-04', title: 'День народного единства', tone: 'celebrate', weight: 1, note: 'выходной — позвать на сеанс', author: false },
  { md: '12-31', title: 'Канун Нового года', tone: 'celebrate', weight: 3, note: 'итоги года, лучшие работы (настоящие фото), поздравление', author: { weight: 3, note: 'итоги года автора, поздравление' } },
];

interface Season {
  from: string;
  to: string;
  title: string;
  tone: DateTone;
  weight: Weight;
  note: string;
  author?: AuthorView;
}

/** Сезоны продаж и поведения аудитории (каждый год). */
const SEASONS: Season[] = [
  { from: '01-01', to: '01-08', title: 'Новогодние каникулы', tone: 'fun', weight: 1, note: 'длинные выходные — время на сеанс или прокол', author: { weight: 1, note: 'каникулы, отдых, вдохновение' } },
  { from: '06-01', to: '08-31', title: 'Лето: солнце, море и заживление', tone: 'sell', weight: 2, note: 'сезон проколов и небольших тату; честно про солнце, море, бассейн и SPF при заживлении — памятки по уходу летом', author: { weight: 1, note: 'лето, отпуск, как беречь тату на солнце' } },
  { from: '06-15', to: '07-10', title: 'Выпускные (школы и вузы)', tone: 'sell', weight: 1, note: 'только 18+: тату — с 18 лет; прокол «подарок себе к выпускному»', author: false },
  { from: '09-01', to: '11-30', title: 'Осень — сезон больших работ', tone: 'sell', weight: 1, note: 'солнца меньше, заживлять проще — время для рукавов и больших проектов, звать на консультацию', author: { weight: 1, note: 'осень и новые идеи' } },
  { from: '12-01', to: '12-30', title: 'Новогодние подарки', tone: 'sell', weight: 2, note: 'подарочные сертификаты и украшения в подарок — напоминать каждую неделю', author: false },
];

const TONE_LABEL: Record<DateTone, string> = {
  celebrate: 'праздник',
  sell: 'повод продать',
  fun: 'повод для юмора и культуры',
  respect: 'уважительно',
  mourning: 'траур',
};

/** Пятница, 13-е — у студии повод для флеш-дня, у автора — для поста о традиции. */
const FRIDAY_13: Fixed = {
  md: '',
  title: 'Пятница, 13-е',
  tone: 'fun',
  weight: 3,
  note: 'традиционный флеш-день тату-культуры: небольшие эскизы по особой цене — только если студия его проводит (есть в фактах или памяти), иначе пост о традиции',
  author: { weight: 2, note: 'пост о традиции флеш-дня или своём эскизе к дате' },
};

const BLACK_FRIDAY: Fixed = {
  md: '',
  title: 'Чёрная пятница',
  tone: 'sell',
  weight: 2,
  note: 'скидки на украшения или сертификаты — только если владелец их подтвердил; иначе не участвуем',
  author: false,
};

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const addDays = (d: Date, days: number) => new Date(d.getTime() + days * 86_400_000);

/** Православная Пасха (алгоритм Меёса для юлианского календаря + 13 дней, верно для 1900–2099). */
export function orthodoxEaster(year: number): string {
  const a = year % 4;
  const b = year % 7;
  const c = year % 19;
  const d = (19 * c + 15) % 30;
  const e = (2 * a + 4 * b - d + 34) % 7;
  const month = Math.floor((d + e + 114) / 31);
  const day = ((d + e + 114) % 31) + 1;
  return ymd(addDays(new Date(Date.UTC(year, month - 1, day)), 13));
}

/** Чёрная пятница: пятница после четвёртого четверга ноября. */
export function blackFriday(year: number): string {
  const firstDow = new Date(Date.UTC(year, 10, 1)).getUTCDay();
  const firstThursday = 1 + ((4 - firstDow + 7) % 7);
  return `${year}-11-${pad(firstThursday + 22)}`;
}

/** Все пятницы, 13-е года. */
export function fridays13(year: number): string[] {
  return Array.from({ length: 12 }, (_, m) => new Date(Date.UTC(year, m, 13)))
    .filter((d) => d.getUTCDay() === 5)
    .map(ymd);
}

export interface OwnDate {
  id: string;
  day: string;
  title: string;
  note: string;
}

/** Свои даты профиля: MM-DD — каждый год, YYYY-MM-DD — один раз. */
export async function listOwnDates(ctx: AppContext, profile: SmmProfile): Promise<OwnDate[]> {
  return ctx.db
    .select({ id: smmDates.id, day: smmDates.day, title: smmDates.title, note: smmDates.note })
    .from(smmDates)
    .where(eq(smmDates.profile, profile))
    .orderBy(asc(smmDates.day), asc(smmDates.title))
    .all();
}

const OWN_DAY = /^(?:(\d{4})-)?(\d{2})-(\d{2})$/;

/** Добавить свою дату профиля; несуществующая дата — SmmError 400. */
export async function addOwnDate(ctx: AppContext, profile: SmmProfile, d: { day: string; title: string; note?: string }): Promise<string> {
  const m = OWN_DAY.exec(d.day.trim());
  const month = Number(m?.[2]);
  const date = Number(m?.[3]);
  // 29 февраля без года — каждый год не бывает, но в високосные выпадает: проверяем по високосному 2000.
  const year = m?.[1] ? Number(m[1]) : 2000;
  const probe = new Date(Date.UTC(year, month - 1, date));
  if (!m || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== date) throw new SmmError('Такой даты нет', 400);
  const title = d.title.trim();
  if (title.length < 2) throw new SmmError('Название даты — хотя бы 2 знака', 400);
  const id = randomUUID();
  ctx.db
    .insert(smmDates)
    .values({ id, profile, day: d.day.trim(), title: title.slice(0, 120), note: (d.note ?? '').trim().slice(0, 300), createdAt: Date.now() })
    .run();
  return id;
}

/** Удалить свою дату профиля: false — у профиля такой нет. */
export async function removeOwnDate(ctx: AppContext, profile: SmmProfile, id: string): Promise<boolean> {
  return ctx.db.delete(smmDates).where(and(eq(smmDates.id, id), eq(smmDates.profile, profile))).run().changes > 0;
}

/** Такой день есть в календаре (29 февраля — только в високосный год). */
const isRealDate = (date: string): boolean => ymd(new Date(`${date}T00:00:00Z`)) === date;

const yearsOf = (from: string, to: string): number[] => {
  const out: number[] = [];
  for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y += 1) out.push(y);
  return out;
};

/** Повод глазами профиля: у автора своя важность и подсказка, а то и вовсе нет повода. */
function viewOf(f: { weight: Weight; note: string; author?: AuthorView }, profile: SmmProfile): { weight: Weight; note: string } | null {
  if (profile === 'studio' || f.author === undefined) return { weight: f.weight, note: f.note };
  return f.author || null;
}

/** Все даты (и сезоны) профиля, которые пересекаются с промежутком [from; to] (YYYY-MM-DD). */
export async function datesBetween(ctx: AppContext, profile: SmmProfile, from: string, to: string): Promise<BrandDate[]> {
  const own = await listOwnDates(ctx, profile).catch(() => [] as OwnDate[]);
  const out: BrandDate[] = [];
  const inRange = (date: string) => date >= from && date <= to;
  const push = (date: string, f: Fixed) => {
    const view = viewOf(f, profile);
    if (view && inRange(date)) out.push({ date, title: f.title, tone: f.tone, weight: view.weight, note: view.note });
  };
  for (const year of yearsOf(from, to)) {
    for (const f of FIXED) push(`${year}-${f.md}`, f);
    for (const date of fridays13(year)) push(date, FRIDAY_13);
    push(blackFriday(year), BLACK_FRIDAY);
    const easter = orthodoxEaster(year);
    push(easter, { md: '', title: 'Пасха', tone: 'respect', weight: 1, note: 'короткое поздравление, без продаж' });
    const seasons: Season[] = [
      ...SEASONS.map((s) => ({ ...s, from: `${year}-${s.from}`, to: `${year}-${s.to}` })),
      // Масленица — неделя, которая заканчивается за 7 недель до Пасхи.
      {
        from: ymd(addDays(new Date(`${easter}T00:00:00Z`), -55)),
        to: ymd(addDays(new Date(`${easter}T00:00:00Z`), -49)),
        title: 'Масленица',
        tone: 'fun',
        weight: 1,
        note: 'весёлый повод, без продаж',
      },
    ];
    for (const s of seasons) {
      const view = viewOf(s, profile);
      if (view && s.from <= to && s.to >= from) out.push({ date: s.from, until: s.to, title: s.title, tone: s.tone, weight: view.weight, note: view.note });
    }
    for (const d of own) {
      // MM-DD — каждый год; YYYY-MM-DD — один раз, в свой год.
      const date = d.day.length === 5 ? `${year}-${d.day}` : d.day;
      if (inRange(date) && date.startsWith(String(year)) && isRealDate(date)) {
        out.push({ date, title: d.title, tone: 'celebrate', weight: 3, note: d.note || (profile === 'author' ? 'своя дата автора' : 'своя дата студии'), own: true, id: d.id });
      }
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || b.weight - a.weight);
}

/** Строки для промпта: дата, что за повод, как использовать. */
export function datesText(list: BrandDate[]): string {
  return list
    .map((d) => `- ${d.date}${d.until ? `…${d.until}` : ''}: ${d.title} [${TONE_LABEL[d.tone]}, важность ${d.weight}] — ${d.note}`)
    .join('\n');
}

/** Даты, на которые в плане обязателен тематический пост (важность 3, не сезоны и не траур). */
export const mustCover = (list: BrandDate[]): BrandDate[] => list.filter((d) => d.weight === 3 && !d.until && d.tone !== 'mourning');

/** Траурные дни из промежутка — в них нельзя ставить развлекательные публикации. */
export const mourningDays = (list: BrandDate[]): string[] => list.filter((d) => d.tone === 'mourning').map((d) => d.date);
