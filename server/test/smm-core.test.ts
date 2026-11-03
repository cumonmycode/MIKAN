import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BotGateway } from '../src/bot/gateway.js';
import { loadConfig } from '../src/config.js';
import { silentLogger, type AppContext } from '../src/context.js';
import { openDatabase, type Sqlite } from '../src/db/client.js';
import { employees, smmAccounts, smmMedia, smmPlans, smmPlatformPosts, smmPosts, smmReports } from '../src/db/schema.js';
import { seedDatabase } from '../src/db/seed.js';
import {
  addComment,
  claimPlan,
  claimPost,
  deleteSlot,
  ensurePlan,
  forget,
  insertMedia,
  insertPost,
  listAccounts,
  listComments,
  listMemory,
  listPosts,
  listReports,
  loadMedia,
  loadPlan,
  loadPost,
  nextSort,
  pendingMedia,
  publishChannel,
  remember,
  reorderSlots,
  unselectSlot,
  updatePlan,
  updatePost,
} from '../src/smm/db.js';
import { forecastFor, freezeForecast, loadForecastModel, withForecast } from '../src/smm/forecast.js';
import { SmmError, step, type SmmProfile } from '../src/smm/types.js';

const DAY = 24 * 60 * 60 * 1000;

let ctx: AppContext;
let sqlite: Sqlite;

/**
 * Контекст без app.ts и test/helpers.ts: ядро СММ проверяется отдельно от маршрутов и бота (они тянут модули
 * остальных частей раздела). Хранилище не шлёт сообщений — бот здесь не нужен.
 */
beforeEach(() => {
  const config = loadConfig({
    JWT_SECRET: 'test-secret-test-secret-test-secret-42',
    ADMIN_PASSWORD: 'secret123',
    ADMIN_NAME: 'Админ',
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'mikan-smm-core-')),
  });
  const handle = openDatabase(':memory:');
  seedDatabase(handle.db, config);
  sqlite = handle.sqlite;
  ctx = {
    db: handle.db,
    sqlite,
    config,
    log: silentLogger,
    gateway: {} as BotGateway,
    ai: null,
    qr: null,
    onBotSettingsChanged: () => undefined,
  };
});

afterEach(() => {
  sqlite.close();
  fs.rmSync(ctx.config.dataDir, { recursive: true, force: true });
});

const adminId = () => ctx.db.select({ id: employees.id }).from(employees).get()!.id;

const newPost = (profile: SmmProfile, publishAt: string | null, extra: Partial<Parameters<typeof insertPost>[1]> = {}) =>
  insertPost(ctx, { profile, platform: 'telegram', format: 'post', publishAt, topic: `Тема ${profile}`, ...extra });

function addAccount(profile: SmmProfile, platform: string, extra: Partial<typeof smmAccounts.$inferInsert> = {}): string {
  const id = randomUUID();
  const now = Date.now();
  ctx.db
    .insert(smmAccounts)
    .values({ id, profile, platform, title: `${platform} ${profile}`, createdAt: now, updatedAt: now, ...extra })
    .run();
  return id;
}

describe('smm db: публикации', () => {
  it('сохраняет пост и отдаёт его с ISO-датами, именем выкладывающего и медиа', async () => {
    const id = await newPost('author', '2026-11-05T09:00:00.000Z', {
      format: 'reel',
      platform: 'instagram',
      brief: 'бриф',
      assigneeId: adminId(),
      createdBy: adminId(),
    });
    await updatePost(ctx, id, {
      script: { hook: 'Зацепка', shots: [{ text: 'Кадр 1', seconds: 3 }] },
      stats: { views: 120 },
      statsAt: '2026-11-06T10:00:00Z',
    });
    await insertMedia(ctx, { postId: id, kind: 'image', source: 'ai', status: 'done', url: '/uploads/smm-a.jpg', costRub: 3 });

    const post = await loadPost(ctx, id);

    expect(post).toMatchObject({
      id,
      profile: 'author',
      platform: 'instagram',
      format: 'reel',
      status: 'idea',
      publishAt: '2026-11-05T09:00:00.000Z',
      topic: 'Тема author',
      brief: 'бриф',
      assigneeId: adminId(),
      assigneeName: 'Админ',
      script: { hook: 'Зацепка', shots: [{ text: 'Кадр 1', seconds: 3 }] },
      stats: { views: 120 },
      statsAt: '2026-11-06T10:00:00.000Z',
      busy: null,
      progress: null,
      forecast: null,
    });
    expect(post?.media).toHaveLength(1);
    expect(post?.media[0]).toMatchObject({ kind: 'image', source: 'ai', url: '/uploads/smm-a.jpg', costRub: 3, selected: true });
    expect(post?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('битый JSON в строке — значения по умолчанию, а не падение', async () => {
    const id = await newPost('studio', null);
    ctx.db.update(smmPosts).set({ scriptJson: '{oops', statsJson: 'null', forecastJson: '[1]' }).where(eq(smmPosts.id, id)).run();

    const post = await loadPost(ctx, id);

    expect(post).toMatchObject({ script: null, stats: {}, forecast: null });
  });

  it('чужой или неверный id — null', async () => {
    expect(await loadPost(ctx, randomUUID())).toBeNull();
    expect(await loadPost(ctx, "1' OR 1=1")).toBeNull();
  });

  it('listPosts разделяет профили, держит окно дат и ставит посты без даты в конец', async () => {
    const early = await newPost('studio', '2026-11-02T10:00:00Z');
    const late = await newPost('studio', '2026-11-20T10:00:00Z', { status: 'review' });
    const undated = await newPost('studio', null);
    const author = await newPost('author', '2026-11-03T10:00:00Z');

    const studio = await listPosts(ctx, { profile: 'studio' });
    const authorOnly = await listPosts(ctx, { profile: 'author' });
    const all = await listPosts(ctx, {});
    const window = await listPosts(ctx, { profile: 'studio', from: '2026-11-01T00:00:00Z', to: '2026-11-10T00:00:00Z' });
    const review = await listPosts(ctx, { profile: 'studio', status: ['review'] });

    expect(studio.map((p) => p.id)).toEqual([early, late, undated]);
    expect(authorOnly.map((p) => p.id)).toEqual([author]);
    expect(all).toHaveLength(4);
    expect(window.map((p) => p.id)).toEqual([early]);
    expect(review.map((p) => p.id)).toEqual([late]);
  });

  it('updatePost: занятость ставит время, конец работы снимает шкалу; неверная дата — 400', async () => {
    const id = await newPost('studio', null);
    await updatePost(ctx, id, { busy: 'text', progress: step('Пишу текст', 10, 60, 20) });
    const busyRow = ctx.db.select().from(smmPosts).where(eq(smmPosts.id, id)).get()!;
    expect(busyRow.busyAt).toBeGreaterThan(0);
    expect((await loadPost(ctx, id))?.progress?.label).toBe('Пишу текст');

    await updatePost(ctx, id, { busy: null, body: 'Готово', approvedBy: adminId(), approvedAt: '2026-11-01T12:00:00+03:00' });
    const post = await loadPost(ctx, id);
    expect(post).toMatchObject({ busy: null, progress: null, body: 'Готово', approvedAt: '2026-11-01T09:00:00.000Z' });
    expect(ctx.db.select().from(smmPosts).where(eq(smmPosts.id, id)).get()).toMatchObject({ busyAt: null, progressJson: null });

    await expect(updatePost(ctx, id, { publishAt: 'завтра' })).rejects.toMatchObject({ status: 400, code: 'validation_error' });
    await expect(updatePost(ctx, id, { publishAt: 'завтра' })).rejects.toBeInstanceOf(SmmError);
  });

  it('claimPost занимает свободный пост один раз и перехватывает зависший', async () => {
    const id = await newPost('studio', null);

    expect(await claimPost(ctx, id, 'text')).toBe(true);
    expect(await claimPost(ctx, id, 'image')).toBe(false);

    ctx.db.update(smmPosts).set({ busyAt: Date.now() - 11 * 60_000, error: 'старое' }).where(eq(smmPosts.id, id)).run();
    // Зависшая работа наружу не видна — приложение не ждёт вечно.
    expect(await loadPost(ctx, id)).toMatchObject({ busy: null, progress: null });
    expect(await claimPost(ctx, id, 'revise')).toBe(true);
    expect(await loadPost(ctx, id)).toMatchObject({ busy: 'revise', error: null });
    expect(await claimPost(ctx, randomUUID(), 'text')).toBe(false);
  });
});

describe('smm db: медиа', () => {
  it('варианты позиции, порядок, удаление позиции и медиа в работе', async () => {
    const id = await newPost('author', null);
    const first = await insertMedia(ctx, { postId: id, kind: 'image', source: 'ai', status: 'done', url: '/a', sort: 0 });
    const second = await insertMedia(ctx, { postId: id, kind: 'image', source: 'upload', status: 'done', url: '/b', sort: 1 });
    const variant = await insertMedia(ctx, { postId: id, kind: 'image', source: 'ai', status: 'done', url: '/a2', sort: 0 });
    await unselectSlot(ctx, id, 'image', 0, variant);
    const video = await insertMedia(ctx, {
      postId: id,
      kind: 'video',
      source: 'ai',
      status: 'pending',
      polzaId: 'job-1',
      sort: await nextSort(ctx, id),
    });

    expect((await loadPost(ctx, id))?.media.map((m) => m.id)).toEqual([variant, second, video]);
    expect((await loadPost(ctx, id, true))?.media.map((m) => m.id)).toEqual([first, variant, second, video]);
    expect(await nextSort(ctx, id)).toBe(3);
    expect(await loadMedia(ctx, video)).toMatchObject({ postId: id, profile: 'author', status: 'pending', kind: 'video' });
    expect(await pendingMedia(ctx)).toEqual([expect.objectContaining({ id: video, postId: id, polzaId: 'job-1', profile: 'author' })]);

    await reorderSlots(ctx, id, [2, 0]);
    const sorts = ctx.db.select({ id: smmMedia.id, sort: smmMedia.sort }).from(smmMedia).all();
    expect(Object.fromEntries(sorts.map((m) => [m.id, m.sort]))).toEqual({ [video]: 0, [first]: 1, [variant]: 1, [second]: 2 });

    await deleteSlot(ctx, id, 'image', 1);
    expect((await loadPost(ctx, id, true))?.media.map((m) => m.id)).toEqual([video, second]);
  });
});

describe('smm db: планы, замечания, память', () => {
  it('план уникален в пределах профиля и месяца', async () => {
    const studio = await ensurePlan(ctx, 'studio', '2026-11');
    const again = await ensurePlan(ctx, 'studio', '2026-11');
    const author = await ensurePlan(ctx, 'author', '2026-11');

    expect(again.id).toBe(studio.id);
    expect(author.id).not.toBe(studio.id);
    expect(author).toMatchObject({ profile: 'author', month: '2026-11', status: 'draft', goals: [], pillars: [] });
    expect(await loadPlan(ctx, 'author', '2026-12')).toBeNull();

    await updatePlan(ctx, author.id, {
      status: 'active',
      summary: 'Личный бренд',
      goals: ['Рост'],
      pillars: [{ key: 'art', title: 'Творчество', share: 60, about: 'Работы' }],
    });
    expect(await loadPlan(ctx, 'author', '2026-11')).toMatchObject({ status: 'active', summary: 'Личный бренд', goals: ['Рост'] });
    expect((await loadPlan(ctx, 'studio', '2026-11'))?.summary).toBe('');
  });

  it('claimPlan: занятый план не отдаётся, зависший дольше 15 минут — отдаётся', async () => {
    const plan = await ensurePlan(ctx, 'studio', '2026-11');
    expect(await claimPlan(ctx, plan.id, 'plan')).toBe(true);
    expect(await claimPlan(ctx, plan.id, 'plan')).toBe(false);
    ctx.db.update(smmPlans).set({ busyAt: Date.now() - 16 * 60_000 }).where(eq(smmPlans.id, plan.id)).run();
    expect(await claimPlan(ctx, plan.id, 'plan')).toBe(true);
    await updatePlan(ctx, plan.id, { busy: null });
    expect(await loadPlan(ctx, 'studio', '2026-11')).toMatchObject({ busy: null, progress: null });
  });

  it('план, брошенный посреди работы (перезапуск), наружу не «занят»: приложение не крутит вечно', async () => {
    const plan = await ensurePlan(ctx, 'studio', '2026-11');
    expect(await claimPlan(ctx, plan.id, 'plan')).toBe(true);
    await updatePlan(ctx, plan.id, { progress: step('Составляю стратегию', 8, 88, 70) });
    expect(await loadPlan(ctx, 'studio', '2026-11')).toMatchObject({ busy: 'plan', progress: { label: 'Составляю стратегию' } });
    ctx.db.update(smmPlans).set({ busyAt: Date.now() - 16 * 60_000 }).where(eq(smmPlans.id, plan.id)).run();
    expect(await loadPlan(ctx, 'studio', '2026-11')).toMatchObject({ busy: null, progress: null });
  });

  it('замечания идут по порядку, ограничены и различают маркетолога', async () => {
    const postId = await newPost('studio', null);
    await addComment(ctx, { postId, authorId: adminId(), authorName: 'Админ', role: 'staff', text: 'Короче' });
    await addComment(ctx, { postId, role: 'ai', text: 'Сократил' });
    await addComment(ctx, { postId, role: 'staff', text: 'x'.repeat(3000) });

    const all = await listComments(ctx, { postId });
    const last = await listComments(ctx, { postId }, 2);

    expect(all.map((c) => c.role)).toEqual(['staff', 'ai', 'staff']);
    expect(all[2]?.text).toHaveLength(2000);
    expect(last.map((c) => c.text.slice(0, 8))).toEqual(['Сократил', 'xxxxxxxx']);
    expect(await listComments(ctx, {})).toEqual([]);
  });

  it('память своя у каждого профиля и не копит одно правило дважды (без учёта регистра)', async () => {
    expect(await remember(ctx, 'studio', { kind: 'rule', text: 'Не писать «Дорогие клиенты»', source: 'remark' })).toBe(true);
    expect(await remember(ctx, 'studio', { kind: 'rule', text: '  не писать «дорогие КЛИЕНТЫ»  ', source: 'staff' })).toBe(false);
    expect(await remember(ctx, 'author', { kind: 'voice', text: 'Не писать «Дорогие клиенты»', source: 'staff' })).toBe(true);
    expect(await remember(ctx, 'author', { kind: 'fact', text: '   ', source: 'staff' })).toBe(false);

    const studio = await listMemory(ctx, 'studio');
    const author = await listMemory(ctx, 'author');
    expect(studio).toHaveLength(1);
    expect(author).toEqual([expect.objectContaining({ kind: 'voice', source: 'staff' })]);

    expect(await forget(ctx, studio[0]!.id, 'author')).toBe(false);
    expect(await forget(ctx, studio[0]!.id, 'studio')).toBe(true);
    expect(await listMemory(ctx, 'studio')).toEqual([]);
    expect(await listMemory(ctx, 'author')).toHaveLength(1);
  });
});

describe('smm db: площадки и отчёты', () => {
  it('площадки и канал публикации — свои у профиля', async () => {
    addAccount('studio', 'telegram', { tgChatId: '@mikan', canPublish: false });
    const studioChannel = addAccount('studio', 'telegram', { tgChatId: '@mikan_studio', canPublish: true, statsJson: '{"subs":5}' });
    addAccount('studio', 'instagram', { statsJson: 'битое' });
    const authorChannel = addAccount('author', 'telegram', { tgChatId: '-100123', canPublish: true });

    const studio = await listAccounts(ctx, 'studio');

    expect(studio.map((a) => a.platform)).toEqual(['instagram', 'telegram', 'telegram']);
    expect(studio[0]).toMatchObject({ profile: 'studio', stats: {}, isActive: true, tgChatId: null });
    expect((await publishChannel(ctx, 'studio'))?.id).toBe(studioChannel);
    expect((await publishChannel(ctx, 'studio'))?.stats).toEqual({ subs: 5 });
    expect((await publishChannel(ctx, 'author'))?.id).toBe(authorChannel);
    expect(await listAccounts(ctx, 'author')).toHaveLength(1);
  });

  it('отчёты — свои у профиля, новые сверху', async () => {
    const base = { periodFrom: '2026-10-01', periodTo: '2026-10-31', summary: 'Итоги' };
    ctx.db
      .insert(smmReports)
      .values([
        { id: randomUUID(), profile: 'studio', title: 'Октябрь', createdAt: 1, metricsJson: '[{"label":"Охват","value":"1 000"}]', ...base },
        { id: randomUUID(), profile: 'studio', title: 'Ноябрь', createdAt: 2, ...base },
        { id: randomUUID(), profile: 'author', title: 'Автор', createdAt: 3, recommendationsJson: '{}', ...base },
      ])
      .run();

    const studio = await listReports(ctx, 'studio');
    const author = await listReports(ctx, 'author', 1);

    expect(studio.map((r) => r.title)).toEqual(['Ноябрь', 'Октябрь']);
    expect(studio[1]).toMatchObject({ periodFrom: '2026-10-01', metrics: [{ label: 'Охват', value: '1 000' }], recommendations: [] });
    expect(author).toEqual([expect.objectContaining({ title: 'Автор', recommendations: [] })]);
  });
});

describe('smm forecast', () => {
  function addPlatformPosts(accountId: string, platform: string, format: string, views: number[]): void {
    const now = Date.now();
    ctx.db
      .insert(smmPlatformPosts)
      .values(
        views.map((v, i) => ({
          accountId,
          extId: `${format}-${i}-${v}`,
          platform,
          format,
          publishedAt: now - (5 + i) * DAY,
          views: v,
          likes: Math.round(v / 10),
          statsAt: now,
        })),
      )
      .run();
  }

  it('считает медиану и четверти по площадкам своего профиля', async () => {
    const studioTg = addAccount('studio', 'telegram');
    const authorTg = addAccount('author', 'telegram');
    addPlatformPosts(studioTg, 'telegram', 'post', [100, 200, 300, 400, 500]);
    addPlatformPosts(authorTg, 'telegram', 'post', [5000, 6000, 7000]);
    // Свежий пост и пост старше 90 дней в расчёт не идут.
    ctx.db
      .insert(smmPlatformPosts)
      .values([
        { accountId: studioTg, extId: 'fresh', platform: 'telegram', publishedAt: Date.now() - DAY, views: 1, statsAt: 0 },
        { accountId: studioTg, extId: 'old', platform: 'telegram', publishedAt: Date.now() - 100 * DAY, views: 1, statsAt: 0 },
      ])
      .run();

    const studio = forecastFor(await loadForecastModel(ctx, 'studio'), { platform: 'telegram', format: 'post' });
    const author = forecastFor(await loadForecastModel(ctx, 'author'), { platform: 'telegram', format: 'post' });
    const reel = forecastFor(await loadForecastModel(ctx, 'studio'), { platform: 'telegram', format: 'reel' });

    expect(studio).toMatchObject({ metric: 'views', expected: 300, low: 200, high: 400, basis: 5, likes: 30 });
    expect(author).toMatchObject({ expected: 6000, basis: 3 });
    // Своих рилсов нет — все посты площадки с поправкой на формат.
    expect(reel).toMatchObject({ expected: 480, basis: 5 });
    expect(forecastFor(await loadForecastModel(ctx, 'studio'), { platform: 'instagram', format: 'post' })).toBeNull();
  });

  it('withForecast берёт историю профиля поста, freezeForecast замораживает один раз', async () => {
    addPlatformPosts(addAccount('studio', 'telegram'), 'telegram', 'post', [100, 200, 300]);
    addPlatformPosts(addAccount('author', 'telegram'), 'telegram', 'post', [1000, 2000, 3000]);
    const studioPost = await newPost('studio', null);
    const authorPost = await newPost('author', null);

    const posts = await withForecast(ctx, await listPosts(ctx, {}));
    expect(Object.fromEntries(posts.map((p) => [p.id, p.forecast?.expected]))).toEqual({ [studioPost]: 200, [authorPost]: 2000 });

    await freezeForecast(ctx, authorPost);
    const frozen = (await loadPost(ctx, authorPost))?.forecast;
    expect(frozen).toMatchObject({ expected: 2000, frozen: true });

    addPlatformPosts(addAccount('author', 'telegram'), 'telegram', 'post', [9000, 9000, 9000, 9000]);
    await freezeForecast(ctx, authorPost);
    const [after] = await withForecast(ctx, [(await loadPost(ctx, authorPost))!]);
    expect(after?.forecast).toEqual(frozen);
  });
});
