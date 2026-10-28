import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { employees } from './schema.js';

/**
 * СММ-маркетолог (docs/SMM.md): площадки, план месяца, публикации с медиа, замечания, память, отчёты, расходы на
 * нейросети, цифры площадок, фотоархив и база знаний. Ведутся два независимых профиля (`profile`): `studio` —
 * соцсети студии MIKAN, `author` — личные соцсети автора, отдельный контент без связи с работой студии. У каждого
 * профиля всё своё; общие только ключ нейросетей и Telegram-бот.
 *
 * Идентификаторы — UUID строкой (их делает приложение), время — миллисекунды UTC, JSON — текст `*_json`.
 */

const bool = (name: string) => integer(name, { mode: 'boolean' });
const ms = (name: string) => integer(name);

/** Площадки профиля: канал Telegram (бот публикует сам), Instagram и другие — для ссылок и аналитики. */
export const smmAccounts = sqliteTable(
  'smm_accounts',
  {
    id: text('id').primaryKey(),
    profile: text('profile').notNull(),
    /** telegram | instagram | vk | other */
    platform: text('platform').notNull(),
    title: text('title').notNull(),
    url: text('url'),
    /** @username без «@». */
    handle: text('handle'),
    /** Чат канала для публикации (telegram): `@username` или числовой id. */
    tgChatId: text('tg_chat_id'),
    canPublish: bool('can_publish').notNull().default(false),
    isActive: bool('is_active').notNull().default(true),
    followers: integer('followers'),
    statsJson: text('stats_json').notNull().default('{}'),
    statsAt: ms('stats_at'),
    statsError: text('stats_error'),
    createdAt: ms('created_at').notNull(),
    updatedAt: ms('updated_at').notNull(),
  },
  (t) => [index('smm_accounts_profile_idx').on(t.profile)],
);

/** Снимок площадки за день (`day` — YYYY-MM-DD по времени студии). */
export const smmAccountStats = sqliteTable(
  'smm_account_stats',
  {
    accountId: text('account_id')
      .notNull()
      .references(() => smmAccounts.id, { onDelete: 'cascade' }),
    day: text('day').notNull(),
    followers: integer('followers'),
    views: integer('views'),
    posts: integer('posts'),
    engagement: real('engagement'),
    reach: integer('reach'),
    newFollowers: integer('new_followers'),
    /** auto | screenshot | manual */
    source: text('source').notNull().default('auto'),
    rawJson: text('raw_json').notNull().default('{}'),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.day] })],
);

/** План профиля на месяц: стратегия, цели, рубрики. */
export const smmPlans = sqliteTable(
  'smm_plans',
  {
    id: text('id').primaryKey(),
    profile: text('profile').notNull(),
    /** YYYY-MM */
    month: text('month').notNull(),
    /** draft | active */
    status: text('status').notNull().default('draft'),
    summary: text('summary').notNull().default(''),
    goalsJson: text('goals_json').notNull().default('[]'),
    pillarsJson: text('pillars_json').notNull().default('[]'),
    /** Что маркетолог делает с планом сейчас (SmmBusy). */
    busy: text('busy'),
    busyAt: ms('busy_at'),
    progressJson: text('progress_json'),
    error: text('error'),
    createdAt: ms('created_at').notNull(),
    updatedAt: ms('updated_at').notNull(),
  },
  (t) => [uniqueIndex('smm_plans_profile_month_idx').on(t.profile, t.month)],
);

/**
 * Публикация на одной площадке (пост, карусель, сторис, рилс):
 * идея → черновик → на одобрении → одобрен → опубликован (или пропущен / не вышел).
 */
export const smmPosts = sqliteTable(
  'smm_posts',
  {
    id: text('id').primaryKey(),
    profile: text('profile').notNull(),
    planId: text('plan_id').references(() => smmPlans.id, { onDelete: 'set null' }),
    accountId: text('account_id').references(() => smmAccounts.id, { onDelete: 'set null' }),
    /** telegram | instagram */
    platform: text('platform').notNull(),
    /** post | carousel | story | reel */
    format: text('format').notNull().default('post'),
    /** idea | draft | review | approved | published | skipped | failed */
    status: text('status').notNull().default('idea'),
    publishAt: ms('publish_at'),
    topic: text('topic').notNull(),
    pillar: text('pillar'),
    direction: text('direction'),
    brief: text('brief').notNull().default(''),
    body: text('body').notNull().default(''),
    /** Что изобразить: бриф картинки или видео. */
    visual: text('visual').notNull().default(''),
    /** Сценарий рилса или серии сторис (ReelScript). */
    scriptJson: text('script_json'),
    assigneeId: integer('assignee_id').references(() => employees.id, { onDelete: 'set null' }),
    approvedBy: integer('approved_by').references(() => employees.id, { onDelete: 'set null' }),
    approvedAt: ms('approved_at'),
    reviewSentAt: ms('review_sent_at'),
    handoffAt: ms('handoff_at'),
    remindedAt: ms('reminded_at'),
    remindCount: integer('remind_count').notNull().default(0),
    publishedAt: ms('published_at'),
    publishedUrl: text('published_url'),
    tgMessageId: integer('tg_message_id'),
    /** id публикации в соцсети (Instagram media id) — по нему цифры. */
    extId: text('ext_id'),
    statsJson: text('stats_json').notNull().default('{}'),
    statsAt: ms('stats_at'),
    /** text | image | video | revise */
    busy: text('busy'),
    busyAt: ms('busy_at'),
    /** Шкала готовности (SmmProgress). */
    progressJson: text('progress_json'),
    /** Прогноз охвата (SmmForecast), замораживается в момент выхода. */
    forecastJson: text('forecast_json'),
    error: text('error'),
    createdBy: integer('created_by').references(() => employees.id, { onDelete: 'set null' }),
    createdAt: ms('created_at').notNull(),
    updatedAt: ms('updated_at').notNull(),
  },
  (t) => [
    index('smm_posts_profile_publish_idx').on(t.profile, t.publishAt),
    index('smm_posts_status_idx').on(t.status, t.publishAt),
    index('smm_posts_plan_idx').on(t.planId),
  ],
);

/** Картинки и видео публикации (сгенерированные, загруженные, из архива). Видео делается минуты — есть статус. */
export const smmMedia = sqliteTable(
  'smm_media',
  {
    id: text('id').primaryKey(),
    postId: text('post_id')
      .notNull()
      .references(() => smmPosts.id, { onDelete: 'cascade' }),
    /** image | video */
    kind: text('kind').notNull().default('image'),
    /** ai | upload | archive */
    source: text('source').notNull().default('ai'),
    /** pending | done | failed */
    status: text('status').notNull().default('done'),
    url: text('url'),
    aspect: text('aspect'),
    prompt: text('prompt'),
    model: text('model'),
    polzaId: text('polza_id'),
    costRub: real('cost_rub').notNull().default(0),
    error: text('error'),
    selected: bool('selected').notNull().default(true),
    sort: integer('sort').notNull().default(0),
    createdAt: ms('created_at').notNull(),
    updatedAt: ms('updated_at').notNull(),
  },
  (t) => [index('smm_media_post_idx').on(t.postId, t.sort), index('smm_media_status_idx').on(t.status)],
);

/** Замечания сотрудников и ответы маркетолога по посту или плану. */
export const smmComments = sqliteTable(
  'smm_comments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    postId: text('post_id').references(() => smmPosts.id, { onDelete: 'cascade' }),
    planId: text('plan_id').references(() => smmPlans.id, { onDelete: 'cascade' }),
    authorId: integer('author_id').references(() => employees.id, { onDelete: 'set null' }),
    authorName: text('author_name'),
    /** staff | ai */
    role: text('role').notNull().default('staff'),
    text: text('text').notNull(),
    createdAt: ms('created_at').notNull(),
  },
  (t) => [index('smm_comments_post_idx').on(t.postId, t.id), index('smm_comments_plan_idx').on(t.planId, t.id)],
);

/** Память маркетолога по профилю: голос, правила, чего избегать, выводы аналитики, факты. */
export const smmMemory = sqliteTable(
  'smm_memory',
  {
    id: text('id').primaryKey(),
    profile: text('profile').notNull(),
    /** voice | rule | avoid | insight | fact */
    kind: text('kind').notNull().default('rule'),
    text: text('text').notNull(),
    /** staff | remark | analytics */
    source: text('source').notNull().default('staff'),
    authorId: integer('author_id').references(() => employees.id, { onDelete: 'set null' }),
    createdAt: ms('created_at').notNull(),
  },
  (t) => [index('smm_memory_profile_idx').on(t.profile)],
);

/** Отчёты аналитики с выводами и рекомендациями. */
export const smmReports = sqliteTable(
  'smm_reports',
  {
    id: text('id').primaryKey(),
    profile: text('profile').notNull(),
    /** YYYY-MM-DD */
    periodFrom: text('period_from').notNull(),
    periodTo: text('period_to').notNull(),
    title: text('title').notNull(),
    summary: text('summary').notNull().default(''),
    metricsJson: text('metrics_json').notNull().default('[]'),
    recommendationsJson: text('recommendations_json').notNull().default('[]'),
    createdAt: ms('created_at').notNull(),
  },
  (t) => [index('smm_reports_profile_idx').on(t.profile, t.createdAt)],
);

/** Расходы на нейросети (бюджет месяца у каждого профиля свой). */
export const smmSpend = sqliteTable(
  'smm_spend',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    profile: text('profile').notNull(),
    at: ms('at').notNull(),
    /** text | image | video | vision */
    kind: text('kind').notNull(),
    model: text('model').notNull(),
    costRub: real('cost_rub').notNull().default(0),
    note: text('note'),
  },
  (t) => [index('smm_spend_profile_at_idx').on(t.profile, t.at)],
);

/** Все публикации площадок (и не от маркетолога) с цифрами: прогноз, лучшее время, сравнение форматов, топ. */
export const smmPlatformPosts = sqliteTable(
  'smm_platform_posts',
  {
    accountId: text('account_id')
      .notNull()
      .references(() => smmAccounts.id, { onDelete: 'cascade' }),
    /** id сообщения канала или медиа Instagram. */
    extId: text('ext_id').notNull(),
    platform: text('platform').notNull(),
    format: text('format').notNull().default('post'),
    publishedAt: ms('published_at'),
    caption: text('caption').notNull().default(''),
    permalink: text('permalink'),
    thumbUrl: text('thumb_url'),
    views: integer('views'),
    reach: integer('reach'),
    likes: integer('likes'),
    comments: integer('comments'),
    shares: integer('shares'),
    saves: integer('saves'),
    reactions: integer('reactions'),
    interactions: integer('interactions'),
    postId: text('post_id').references(() => smmPosts.id, { onDelete: 'set null' }),
    statsAt: ms('stats_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.extId] }), index('smm_platform_posts_at_idx').on(t.accountId, t.publishedAt)],
);

/** Альбомы фотоархива профиля (публичная папка Google Диска). */
export const smmLibraryFolders = sqliteTable(
  'smm_library_folders',
  {
    profile: text('profile').notNull(),
    driveId: text('drive_id').notNull(),
    parentId: text('parent_id'),
    path: text('path').notNull().default(''),
    title: text('title').notNull().default(''),
    /** photos | template | logo | brand */
    kind: text('kind').notNull().default('photos'),
    /** Что в альбоме, одной-двумя фразами. */
    about: text('about').notNull().default(''),
    files: integer('files').notNull().default(0),
    seenAt: ms('seen_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.profile, t.driveId] })],
);

/** Фото и видео архива с описанием: маркетолог ищет нужное по описанию и берёт только найденное. */
export const smmLibrary = sqliteTable(
  'smm_library',
  {
    profile: text('profile').notNull(),
    driveId: text('drive_id').notNull(),
    folderId: text('folder_id'),
    /** Альбом целиком: «Работы / Тату / Графика 2026». */
    path: text('path').notNull().default(''),
    name: text('name').notNull().default(''),
    mime: text('mime').notNull().default(''),
    /** photo | video | template | logo | design */
    kind: text('kind').notNull().default('photo'),
    description: text('description').notNull().default(''),
    /** Ключи направлений и сцен через пробел. */
    tags: text('tags').notNull().default(''),
    people: integer('people'),
    /** 1–5: годится ли для соцсетей. */
    quality: integer('quality'),
    /** portrait | landscape | square */
    orientation: text('orientation'),
    usedCount: integer('used_count').notNull().default(0),
    lastUsedAt: ms('last_used_at'),
    describedAt: ms('described_at'),
    seenAt: ms('seen_at').notNull(),
    createdAt: ms('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.profile, t.driveId] }), index('smm_library_folder_idx').on(t.profile, t.folderId)],
);

/**
 * База знаний профиля: `brand` — портрет студии или автора (текст владельца + собранное маркетологом),
 * `socials` — что уже было в соцсетях профиля (рубрики, голос, что заходило).
 */
export const smmKnowledge = sqliteTable(
  'smm_knowledge',
  {
    profile: text('profile').notNull(),
    /** brand | socials */
    key: text('key').notNull(),
    ownerText: text('owner_text').notNull().default(''),
    aiText: text('ai_text').notNull().default(''),
    metaJson: text('meta_json').notNull().default('{}'),
    progressJson: text('progress_json'),
    error: text('error'),
    aiAt: ms('ai_at'),
    updatedAt: ms('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.profile, t.key] })],
);

/**
 * Места съёмки профиля (у студии — её помещения, у автора — свои): фото с разных ракурсов и описания — опора для
 * картинок и видео, чтобы сцена была в настоящем месте, а не в выдуманном.
 */
export const smmZones = sqliteTable(
  'smm_zones',
  {
    id: text('id').primaryKey(),
    profile: text('profile').notNull(),
    title: text('title').notNull(),
    sort: integer('sort').notNull().default(0),
    ownerText: text('owner_text').notNull().default(''),
    aiText: text('ai_text').notNull().default(''),
    /** То же по-английски, коротко: опора для промптов видео. */
    anchor: text('anchor').notNull().default(''),
    progressJson: text('progress_json'),
    error: text('error'),
    aiAt: ms('ai_at'),
    createdAt: ms('created_at').notNull(),
    updatedAt: ms('updated_at').notNull(),
  },
  (t) => [index('smm_zones_profile_idx').on(t.profile, t.sort)],
);

export const smmZonePhotos = sqliteTable(
  'smm_zone_photos',
  {
    id: text('id').primaryKey(),
    zoneId: text('zone_id')
      .notNull()
      .references(() => smmZones.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    sort: integer('sort').notNull().default(0),
    createdAt: ms('created_at').notNull(),
  },
  (t) => [index('smm_zone_photos_zone_idx').on(t.zoneId, t.sort)],
);

/** Свои даты профиля (день рождения студии, конвенции, гостевые споты): тематические посты, как на праздники. */
export const smmDates = sqliteTable(
  'smm_dates',
  {
    id: text('id').primaryKey(),
    profile: text('profile').notNull(),
    /** MM-DD (каждый год) или YYYY-MM-DD (один раз). */
    day: text('day').notNull(),
    title: text('title').notNull(),
    note: text('note').notNull().default(''),
    createdAt: ms('created_at').notNull(),
  },
  (t) => [index('smm_dates_profile_idx').on(t.profile)],
);
