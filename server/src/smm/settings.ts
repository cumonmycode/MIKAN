/**
 * Настройки СММ — у каждого профиля свои (ключ `smm_settings:<profile>` в таблице settings): как называется и о чём
 * пишет, голос, аудитория и цели, частота публикаций, кто одобряет и кто выкладывает вручную, одобрение и бюджет на
 * нейросети. Профиль автора — отдельный контент: его настройки ни в чём не берутся из студии. Неизвестное или битое
 * поле — по умолчанию, остальные сохраняются.
 */
import { z } from 'zod';
import type { DbOrTx } from '../db/client.js';
import { readKey, writeKey } from '../domain/settings.js';
import type { SmmProfile } from './types.js';

const settingsKey = (profile: SmmProfile) => `smm_settings:${profile}`;

const text = (max: number) => z.string().max(max);

export const SettingsSchema = z.object({
  /** Профиль ведётся: маркетолог готовит и публикует. Выключенный профиль крон не трогает. */
  enabled: z.boolean(),
  /** Имя бренда в текстах и подписях: «MIKAN STUDIO», «Амина». */
  brandName: text(80).trim().min(1),
  /** Telegram без одобрения: маркетолог публикует сам, за несколько часов присылает превью. */
  autopilot: z.boolean(),
  voice: text(1500),
  audience: text(1500),
  goals: text(1500),
  /** О чём профиль пишет — направления, каждое должно звучать в плане месяца. По строке на направление. */
  directions: text(2000),
  /** Сколько в неделю: постов в Telegram, постов в Instagram, сторис, рилс. */
  cadence: z.object({
    telegram: z.number().int().min(0).max(21),
    instagram: z.number().int().min(0).max(21),
    stories: z.number().int().min(0).max(35),
    reels: z.number().int().min(0).max(14),
  }),
  /** Время выхода по умолчанию, «ЧЧ:ММ» по времени студии. */
  postTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  /** Кто одобряет: превью в Telegram и кнопки. Пусто — все сотрудники, связанные с ботом (у автора — никто: укажите себя). */
  approverIds: z.array(z.number().int().positive()).max(20),
  /** Кто выкладывает Instagram без API, сторис и рилс. null — первый из одобряющих. */
  publisherId: z.number().int().positive().nullable(),
  /** За сколько часов до выхода маркетолог готовит пост и присылает на одобрение. */
  reviewLeadHours: z.number().int().min(2).max(96),
  /** Бюджет месяца на нейросети, ₽ (0 — без ограничения). */
  monthlyBudget: z.number().int().min(0).max(100_000),
});

export type SmmSettings = z.infer<typeof SettingsSchema>;

const STUDIO_DEFAULTS: SmmSettings = {
  enabled: true,
  brandName: 'MIKAN STUDIO',
  autopilot: false,
  voice:
    'Тепло и уверенно, как мастер, который любит своё дело: на «вы», простыми живыми словами, без канцелярита и пафоса. ' +
    'Честно про процесс, боль и заживление, без запугивания и без обещаний «совсем не больно». Эмодзи — к месту, не больше 2–3 на пост.',
  audience:
    'Люди 18–40 лет из города, которые думают о первой или следующей татуировке или проколе: им важны безопасность, ' +
    'стерильность, опыт мастера и красивый результат; те, кто выбирает украшения из титана и золота.',
  goals:
    'Записи на тату и пирсинг, продажи украшений, доверие к студии (стерильность, опыт, честные цены) и живое сообщество ' +
    'вокруг неё; возвращение клиентов на следующий прокол или сеанс.',
  directions: [
    'Тату: работы, стили, эскизы, процесс сеанса',
    'Пирсинг: проколы, сочетания, «ухо мечты»',
    'Украшения: новинки, материалы, подбор',
    'Безопасность: стерильность, одноразовое, материалы ASTM F136',
    'Уход и заживление: памятки, ответы на страхи',
    'Студия и мастера: команда, атмосфера, отзывы клиентов',
  ].join('\n'),
  cadence: { telegram: 4, instagram: 2, stories: 5, reels: 3 },
  postTime: '12:00',
  approverIds: [],
  publisherId: null,
  reviewLeadHours: 24,
  monthlyBudget: 3000,
};

const AUTHOR_DEFAULTS: SmmSettings = {
  enabled: false,
  brandName: 'Амина',
  autopilot: false,
  voice:
    'От первого лица, лично и искренне, как в разговоре с друзьями: на «ты» с подписчиками, живыми словами, без ' +
    'рекламного тона и канцелярита. Делиться процессом, мыслями и вдохновением; эмодзи — по настроению, не больше 3.',
  audience: 'Подписчики, которым интересна сама Амина: её творчество, взгляд на тату и пирсинг, жизнь и вдохновение.',
  goals: 'Личный бренд и узнаваемость, тёплое сообщество вокруг автора, рост аудитории и интерес к её работам.',
  directions: ['Творчество: работы, эскизы, процесс', 'Личное: жизнь, мысли, будни', 'Вдохновение: идеи, референсы, путешествия'].join(
    '\n',
  ),
  cadence: { telegram: 3, instagram: 2, stories: 5, reels: 2 },
  postTime: '19:00',
  approverIds: [],
  publisherId: null,
  reviewLeadHours: 24,
  monthlyBudget: 1500,
};

export const DEFAULT_SMM_SETTINGS: Record<SmmProfile, SmmSettings> = { studio: STUDIO_DEFAULTS, author: AUTHOR_DEFAULTS };

export function normalizeSmmSettings(profile: SmmProfile, raw: unknown): SmmSettings {
  const defaults = DEFAULT_SMM_SETTINGS[profile];
  const stored = raw && typeof raw === 'object' ? (raw as Partial<SmmSettings>) : {};
  const base = { ...defaults, ...stored };
  const cadence = { ...defaults.cadence, ...(stored.cadence ?? {}) };
  const parsed = SettingsSchema.safeParse({ ...base, cadence });
  if (parsed.success) return parsed.data;
  // Битое поле не должно ломать остальные — собираем по одному.
  const out: Record<string, unknown> = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof SmmSettings)[]) {
    const one = SettingsSchema.shape[key].safeParse(key === 'cadence' ? cadence : base[key]);
    if (one.success) out[key] = one.data;
  }
  return out as SmmSettings;
}

export function getSmmSettings(db: DbOrTx, profile: SmmProfile): SmmSettings {
  return normalizeSmmSettings(profile, readKey<unknown>(db, settingsKey(profile)));
}

/** Сохраняет изменения поверх текущих; неверное значение — ошибка проверки (ZodError → 400). */
export function saveSmmSettings(db: DbOrTx, profile: SmmProfile, patch: Partial<SmmSettings>): SmmSettings {
  const current = getSmmSettings(db, profile);
  const next = SettingsSchema.parse({ ...current, ...patch, cadence: { ...current.cadence, ...(patch.cadence ?? {}) } });
  writeKey(db, settingsKey(profile), next);
  return next;
}
