/**
 * Контракт раздела «СММ» (docs/SMM.md): профили, площадки, план месяца, публикации, медиа, замечания, память
 * маркетолога и отчёты. Те же формы отдаёт API и рисует iOS-приложение. Перенесено из Titan HUB
 * (apps/api/src/modules/smm/types.ts) с профилями и целыми id сотрудников MIKAN.
 */
import { AppError, type ErrorCode } from '../lib/errors.js';

/**
 * Два независимых профиля: `studio` — соцсети студии MIKAN; `author` — личные соцсети автора (Амины), отдельный
 * контент с отдельными настройками, без данных и процессов студии (услуг, цен, записей, склада).
 */
export const PROFILES = ['studio', 'author'] as const;
export type SmmProfile = (typeof PROFILES)[number];
export const isProfile = (v: unknown): v is SmmProfile => v === 'studio' || v === 'author';

export const PLATFORMS = ['telegram', 'instagram'] as const;
export type SmmPlatform = (typeof PLATFORMS)[number];

export const ACCOUNT_PLATFORMS = ['telegram', 'instagram', 'vk', 'other'] as const;
export type SmmAccountPlatform = (typeof ACCOUNT_PLATFORMS)[number];

export const FORMATS = ['post', 'carousel', 'story', 'reel'] as const;
export type SmmFormat = (typeof FORMATS)[number];

/**
 * idea — тема в плане; draft — маркетолог пишет/написал, ещё не показал; review — ждёт одобрения; approved — выйдет
 * в срок (Telegram — сам, остальное — передаст человеку); published — вышел (есть ссылка); skipped — решили не
 * выпускать; failed — не вышел.
 */
export const STATUSES = ['idea', 'draft', 'review', 'approved', 'published', 'skipped', 'failed'] as const;
export type SmmStatus = (typeof STATUSES)[number];

export const MEMORY_KINDS = ['voice', 'rule', 'avoid', 'insight', 'fact'] as const;
export type SmmMemoryKind = (typeof MEMORY_KINDS)[number];

/** Что маркетолог сейчас делает с постом или планом — приложение показывает и ждёт. */
export type SmmBusy = 'text' | 'image' | 'video' | 'revise' | 'plan' | 'report';

/**
 * Шкала готовности: этап и куда он ведёт. Приложение плавно ведёт полосу от `pct` к `next` за `eta` секунд с
 * момента `at` — между опросами сервера шкала не стоит.
 */
export interface SmmProgress {
  label: string;
  pct: number;
  next: number;
  eta: number;
  at: string;
}

/**
 * Прогноз просмотров публикации по похожим постам площадки (медиана и разброс). В момент выхода замораживается
 * (`frozen`) — с ним сравнивается факт.
 */
export interface SmmForecast {
  metric: 'views';
  expected: number;
  low: number;
  high: number;
  /** На скольких постах площадки посчитан. */
  basis: number;
  likes: number | null;
  at: string;
  frozen?: boolean;
}

export interface SmmMedia {
  id: string;
  kind: 'image' | 'video';
  /** archive — фото из фотоархива профиля (Google Диск), как есть. */
  source: 'ai' | 'upload' | 'archive';
  status: 'pending' | 'done' | 'failed';
  /** Полная ссылка (`/uploads/smm-…` нашего сервера или ссылка архива). */
  url: string | null;
  aspect: string | null;
  prompt: string | null;
  model: string | null;
  costRub: number;
  error: string | null;
  selected: boolean;
  sort: number;
  createdAt: string;
}

/** Сценарий рилса или серии сторис: снимают сами, маркетолог придумывает и расписывает. */
export interface ReelScript {
  hook: string;
  /** Формула зацепки (рилс) — из списка prompts.HOOK_FORMULAS. */
  formula?: string;
  shots: { text: string; seconds?: number; overlay?: string; sticker?: string }[];
  audio?: string;
  cast?: string;
  tips?: string;
}

export interface SmmPostStats {
  views?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  saves?: number;
  reach?: number;
  reactions?: number;
  interactions?: number;
  source?: 'auto';
}

export interface SmmPost {
  id: string;
  profile: SmmProfile;
  planId: string | null;
  accountId: string | null;
  platform: SmmPlatform;
  format: SmmFormat;
  status: SmmStatus;
  publishAt: string | null;
  topic: string;
  pillar: string | null;
  direction: string | null;
  brief: string;
  body: string;
  visual: string;
  script: ReelScript | null;
  /** Сотрудник MIKAN, который выкладывает вручную (Instagram без API, сторис, рилс). */
  assigneeId: number | null;
  assigneeName: string | null;
  approvedBy: number | null;
  approvedAt: string | null;
  handoffAt: string | null;
  publishedAt: string | null;
  publishedUrl: string | null;
  stats: SmmPostStats;
  statsAt: string | null;
  busy: SmmBusy | null;
  progress: SmmProgress | null;
  error: string | null;
  media: SmmMedia[];
  /** Прогноз: замороженный при выходе или посчитанный сейчас (сервер добавляет при выдаче). */
  forecast: SmmForecast | null;
  /** id в соцсети (Instagram media id). */
  extId: string | null;
  createdAt: string;
  updatedAt: string;
  /** Выложит ли маркетолог сам (Telegram, Instagram по API) — считает сервер при выдаче. */
  autoPublish?: boolean;
}

export interface SmmComment {
  id: number;
  postId: string | null;
  planId: string | null;
  authorName: string | null;
  /** staff — сотрудник, ai — маркетолог. */
  role: 'staff' | 'ai';
  text: string;
  createdAt: string;
}

export interface SmmPillar {
  key: string;
  title: string;
  share: number;
  about: string;
}

export interface SmmPlan {
  id: string;
  profile: SmmProfile;
  month: string;
  status: 'draft' | 'active';
  summary: string;
  goals: string[];
  pillars: SmmPillar[];
  busy: SmmBusy | null;
  progress: SmmProgress | null;
  error: string | null;
  updatedAt: string;
}

export interface SmmAccount {
  id: string;
  profile: SmmProfile;
  platform: SmmAccountPlatform;
  title: string;
  url: string | null;
  handle: string | null;
  canPublish: boolean;
  isActive: boolean;
  followers: number | null;
  stats: Record<string, unknown>;
  statsAt: string | null;
  statsError: string | null;
}

export interface SmmMemory {
  id: string;
  kind: SmmMemoryKind;
  text: string;
  source: 'staff' | 'remark' | 'analytics';
  createdAt: string;
}

export interface SmmReport {
  id: string;
  periodFrom: string;
  periodTo: string;
  title: string;
  summary: string;
  metrics: { label: string; value: string; delta?: number | null }[];
  recommendations: { title: string; detail: string }[];
  createdAt: string;
}

export type SmmErrorStatus = 400 | 402 | 404 | 409 | 502;

const CODE_BY_STATUS: Record<SmmErrorStatus, ErrorCode> = {
  400: 'validation_error',
  402: 'payment_required',
  404: 'not_found',
  409: 'conflict',
  502: 'upstream_error',
};

/** Ошибка, текст которой можно показать человеку как есть (общий обработчик ошибок отдаёт её как AppError). */
export class SmmError extends AppError {
  readonly status: SmmErrorStatus;

  constructor(message: string, status: SmmErrorStatus = 400) {
    super(CODE_BY_STATUS[status], message);
    this.name = 'SmmError';
    this.status = status;
  }
}

/** Площадка и формат, которые маркетолог выкладывает сам через бота (остальное передаёт человеку). */
export const autoPublishes = (p: Pick<SmmPost, 'platform' | 'format'>): boolean =>
  p.platform === 'telegram' && (p.format === 'post' || p.format === 'carousel');

/** Этап шкалы готовности с отметкой времени. */
export const step = (label: string, pct: number, next: number, eta: number): SmmProgress => ({
  label,
  pct,
  next,
  eta,
  at: new Date().toISOString(),
});

/** Соотношение сторон картинки: лента — 4:5 (Instagram и Telegram), сторис и рилс — 9:16. */
export const aspectFor = (format: SmmFormat): '4:5' | '9:16' => (format === 'story' || format === 'reel' ? '9:16' : '4:5');
