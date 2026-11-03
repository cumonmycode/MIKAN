import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { silentLogger, type AppContext } from '../src/context.js';
import { openDatabase } from '../src/db/client.js';
import { appointments, clients, employees, services } from '../src/db/schema.js';
import { smmLibrary, smmMemory, smmPosts } from '../src/db/schema-smm.js';
import { seedDatabase } from '../src/db/seed.js';
import { studioTimezone, writeKey } from '../src/domain/settings.js';
import { chatJson, generateImage, type ChatJsonOpts } from '../src/smm/ai.js';
import { claimPost, insertPost, listComments, listPosts, loadPlan, loadPost, updatePost } from '../src/smm/db.js';
import { generatePlan, isMonth, monthRange, revisePlan } from '../src/smm/planner.js';
import { directionsOf } from '../src/smm/prompts.js';
import { generateReport } from '../src/smm/report.js';
import { getSmmSettings, saveSmmSettings } from '../src/smm/settings.js';
import type { SmmPost, SmmProfile } from '../src/smm/types.js';
import { revisePost, studioClock, suggestIdeas, writePost, type Author } from '../src/smm/writer.js';
import { FakeGateway, noImageGenerator, testConfig } from './helpers.js';

vi.mock('../src/smm/ai.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/smm/ai.js')>();
  return { ...actual, chatJson: vi.fn(), generateImage: vi.fn(), startVideo: vi.fn(), pollVideo: vi.fn() };
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const SERVICE_NAME = 'Прокол хеликса тестовый';

interface Call {
  profile: SmmProfile;
  note: string;
  system: string;
  user: string;
}

type Responder = (opts: ChatJsonOpts<unknown>, profile: SmmProfile, user: string) => unknown;

let ctx: AppContext;
let calls: Call[];
let responders: [string, Responder][];
let author: Author;

const fakeFetch = (async (input: string | URL | Request) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith('https://polza.test/')) return new Response(PNG, { status: 200 });
  if (url.startsWith('https://lh3.googleusercontent.com/')) return new Response(JPEG, { status: 200 });
  return new Response('not found', { status: 404 });
}) as typeof fetch;

/** Ответы модели по пометке запроса (note): «план …», «пост …», «правка …» и т. д. — первая подходящая. */
function respond(prefix: string, responder: Responder): void {
  responders.unshift([prefix, responder]);
}

beforeEach(() => {
  const config = testConfig({ PUBLIC_URL: 'https://mikan.test' });
  const { db, sqlite } = openDatabase(':memory:');
  seedDatabase(db, config);
  ctx = {
    db,
    sqlite,
    config,
    log: silentLogger,
    gateway: new FakeGateway(),
    ai: null,
    generateImage: noImageGenerator,
    qr: null,
    onBotSettingsChanged: () => undefined,
    smmFetch: fakeFetch,
  };
  const admin = db.select().from(employees).get()!;
  author = { id: admin.id, name: admin.name };
  const now = Date.now();
  db.insert(services)
    .values({ name: SERVICE_NAME, category: 'piercing', price: 3500, durationMin: 30, createdAt: now, updatedAt: now })
    .run();
  calls = [];
  responders = [['шлифовка', () => ({ body: 'Текст после шлифовки: коротко, по делу и без штампов.' })]];
  vi.mocked(chatJson).mockReset();
  vi.mocked(chatJson).mockImplementation(async (_ctx, profile, opts) => {
    const user = typeof opts.user === 'string' ? opts.user : JSON.stringify(opts.user);
    const note = opts.note ?? '';
    calls.push({ profile, note, system: opts.system, user });
    const found = responders.find(([prefix]) => note.startsWith(prefix));
    if (!found) throw new Error(`no scripted answer for «${note}»`);
    return opts.schema.parse(found[1](opts as ChatJsonOpts<unknown>, profile, user));
  });
  vi.mocked(generateImage).mockReset();
  vi.mocked(generateImage).mockResolvedValue({ url: 'https://polza.test/out.png', cost: 4, model: 'image-model' });
});

afterEach(() => {
  ctx.sqlite.close();
  fs.rmSync(ctx.config.dataDir, { recursive: true, force: true });
});

const nextMonth = () => DateTime.now().setZone(studioTimezone(ctx.db)).plus({ months: 1 }).toFormat('yyyy-MM');
const monthAfter = (month: string) => DateTime.fromISO(`${month}-01`).plus({ months: 1 }).toFormat('yyyy-MM');
const keysOf = (profile: SmmProfile) => directionsOf(getSmmSettings(ctx.db, profile)).map((d) => d.key);
const callsOf = (prefix: string, profile?: SmmProfile) =>
  calls.filter((c) => c.note.startsWith(prefix) && (!profile || c.profile === profile));

/** План месяца от модели: три темы в месяце и одна в следующем (не должна попасть в план). */
function planAnswer(month: string, profile: SmmProfile) {
  const keys = keysOf(profile);
  return {
    summary: 'Фокус месяца — первый опыт: подготовка к сеансу, процесс и уход. Охват растим рилсами, заявки — постами пользы.',
    goals: ['+150 подписчиков в Instagram', '10 заявок из Telegram'],
    pillars: [
      { key: 'use', title: 'Польза', share: 50, about: 'Подготовка и уход' },
      { key: 'proc', title: 'Процесс', share: 50, about: 'Как проходит сеанс' },
    ],
    posts: [
      { date: `${month}-05`, time: '12:00', platform: 'telegram', format: 'post', topic: 'Как подготовиться к первому сеансу', pillar: 'use', direction: keys[0], brief: 'Пять шагов накануне сеанса', visual: 'Памятка-карточка', occasion: null },
      { date: `${month}-07`, time: '19:00', platform: 'instagram', format: 'reel', topic: 'Процесс: трансфер эскиза', pillar: 'proc', direction: 'unknown-direction', brief: 'Снять, как эскиз переходит на кожу' },
      { date: `${month}-09`, time: '13:00', platform: 'instagram', format: 'story', topic: 'Опрос: какая первая тату', direction: keys[1], brief: 'Серия сторис с опросом' },
      { date: `${monthAfter(month)}-03`, time: '12:00', platform: 'telegram', format: 'post', topic: 'Тема следующего месяца', brief: 'Не должна попасть в план' },
    ],
  };
}

/** Догоняющие посты к праздникам: по одному на каждую дату из задания. */
function occasionAnswer(_opts: unknown, _profile: SmmProfile, user: string) {
  const dates = [...user.matchAll(/^- (\d{4}-\d{2}-\d{2}): ([^[]+)\[/gm)].map((m) => ({ date: m[1]!, title: m[2]!.trim() }));
  return {
    posts: dates.map((d) => ({ date: d.date, time: '11:00', platform: 'telegram', format: 'post', topic: `Праздник: ${d.title}`, brief: 'Тематический пост', occasion: d.title })),
  };
}

/** Номер публикации в списке плана по началу темы. */
function numberOf(user: string, topic: string): number {
  const line = user.split('\n').find((l) => /^#\d+ /.test(l) && l.includes(topic));
  if (!line) throw new Error(`no plan line for «${topic}»`);
  return Number(/^#(\d+)/.exec(line)![1]);
}

describe('monthRange', () => {
  it('cuts the month by the studio timezone and validates the month', () => {
    expect(monthRange('2026-11')).toEqual({ from: '2026-10-31T21:00:00.000Z', to: '2026-11-30T21:00:00.000Z' });
    expect(monthRange('2026-12', 'Asia/Tomsk').to).toBe('2026-12-31T17:00:00.000Z');
    expect(isMonth('2026-11')).toBe(true);
    expect(isMonth('2026-13')).toBe(false);
  });
});

describe('generatePlan', () => {
  beforeEach(() => {
    respond('план ', (_opts, profile) => planAnswer(nextMonth(), profile));
    respond('праздники в план', occasionAnswer);
  });

  it('lays the month out for the studio: in-month posts only, known directions, cadence in the task', async () => {
    const month = nextMonth();
    const plan = await generatePlan(ctx, 'studio', month, { author });

    expect(plan).toMatchObject({ profile: 'studio', month, status: 'draft', busy: null, error: null });
    expect(plan.goals).toHaveLength(2);
    expect(plan.pillars.map((p) => p.key)).toEqual(['use', 'proc']);
    const posts = await listPosts(ctx, { profile: 'studio' });
    const { from, to } = monthRange(month, studioTimezone(ctx.db));
    expect(posts.every((p) => p.publishAt! >= from && p.publishAt! < to && p.planId === plan.id)).toBe(true);
    expect(posts.map((p) => p.topic)).not.toContain('Тема следующего месяца');
    const first = posts.find((p) => p.topic === 'Как подготовиться к первому сеансу')!;
    expect(first).toMatchObject({ status: 'idea', platform: 'telegram', format: 'post', direction: keysOf('studio')[0] });
    expect(studioClock(ctx, first.publishAt!)).toEqual({ day: `${month}-05`, time: '12:00' });
    expect(posts.find((p) => p.format === 'reel')?.direction).toBeNull();
    expect((await listPosts(ctx, { profile: 'author' })).length).toBe(0);

    const [call] = callsOf('план ', 'studio');
    expect(call!.user).toContain('Telegram-постов 4, Instagram-постов 2, сторис 5');
    expect(call!.user).toContain('рилс 3');
    expect(call!.user).toContain('Тату: работы, стили, эскизы, процесс сеанса');
    expect(call!.user).toContain(SERVICE_NAME);
    const comments = await listComments(ctx, { planId: plan.id });
    expect(comments.at(-1)).toMatchObject({ role: 'ai' });
    expect(comments.at(-1)?.text).toContain('Составил план');
  });

  it('plans the author profile with its own settings and without studio data', async () => {
    const month = nextMonth();
    await generatePlan(ctx, 'studio', month, { author });
    const studioPosts = (await listPosts(ctx, { profile: 'studio' })).map((p) => p.id).sort();

    const plan = await generatePlan(ctx, 'author', month, { author });

    expect(plan.profile).toBe('author');
    const authorPosts = await listPosts(ctx, { profile: 'author' });
    expect(authorPosts.length).toBeGreaterThanOrEqual(3);
    expect(authorPosts.every((p) => p.profile === 'author' && p.planId === plan.id)).toBe(true);
    expect((await listPosts(ctx, { profile: 'studio' })).map((p) => p.id).sort()).toEqual(studioPosts);
    const [call] = callsOf('план ', 'author');
    const prompt = `${call!.system}\n${call!.user}`;
    expect(call!.user).toContain('Telegram-постов 3, Instagram-постов 2, сторис 5');
    expect(call!.user).toContain('рилс 2');
    expect(call!.user).toContain('Творчество: работы, эскизы, процесс');
    expect(prompt).not.toContain(SERVICE_NAME);
    expect(prompt).not.toContain('Факты о студии');
    expect(prompt).not.toContain('MIKAN STUDIO');
  });

  it('keeps approved posts and replaces ideas when the plan is made again', async () => {
    const month = nextMonth();
    await generatePlan(ctx, 'studio', month, { author });
    const before = await listPosts(ctx, { profile: 'studio' });
    const approved = before.find((p) => p.format === 'reel')!;
    await updatePost(ctx, approved.id, { status: 'approved', body: 'Готовый сценарий рилса' });

    await generatePlan(ctx, 'studio', month, { author });

    const after = await listPosts(ctx, { profile: 'studio' });
    expect(after.find((p) => p.id === approved.id)?.status).toBe('approved');
    const oldIdeas = before.filter((p) => p.id !== approved.id).map((p) => p.id);
    expect(after.some((p) => oldIdeas.includes(p.id))).toBe(false);
    // Модель вернула тот же набор тем — идей снова столько же, одобренный пост сверху.
    expect(after.filter((p) => p.status === 'idea').length).toBe(before.length);
    expect(after).toHaveLength(before.length + 1);
    expect(callsOf('план ').at(-1)!.user).toContain('Уже есть (не трогай');
  });

  it('re-reads the statuses right before replacing: an idea approved or taken during the model call survives', async () => {
    const month = nextMonth();
    await generatePlan(ctx, 'studio', month, { author });
    const before = await listPosts(ctx, { profile: 'studio' });
    const [approvedMeanwhile, takenMeanwhile] = before.filter((p) => p.status === 'idea');
    respond('план ', (_opts, profile) => {
      // A minute into the model call: someone approves one idea, the cron starts writing another
      // (both write to SQLite synchronously, before their first await).
      void updatePost(ctx, approvedMeanwhile!.id, { status: 'approved', body: 'Одобрили, пока шёл план' });
      void claimPost(ctx, takenMeanwhile!.id, 'text');
      return planAnswer(month, profile);
    });

    await generatePlan(ctx, 'studio', month, { author });

    const after = await listPosts(ctx, { profile: 'studio' });
    expect(after.find((p) => p.id === approvedMeanwhile!.id)).toMatchObject({ status: 'approved', body: 'Одобрили, пока шёл план' });
    expect(after.find((p) => p.id === takenMeanwhile!.id)).toMatchObject({ status: 'idea', busy: 'text' });
    const untouched = before.filter((p) => p.id !== approvedMeanwhile!.id && p.id !== takenMeanwhile!.id).map((p) => p.id);
    expect(after.some((p) => untouched.includes(p.id))).toBe(false);
  });

  it('refuses a month that is over', async () => {
    await expect(generatePlan(ctx, 'studio', '2020-01', { author })).rejects.toMatchObject({ status: 400 });
  });
});

describe('revisePlan', () => {
  it('removes, moves, rewrites and adds themes, replies and remembers a rule of the profile', async () => {
    const month = nextMonth();
    respond('план ', (_opts, profile) => planAnswer(month, profile));
    respond('праздники в план', occasionAnswer);
    const plan = await generatePlan(ctx, 'studio', month, { author });
    const reel = (await listPosts(ctx, { profile: 'studio' })).find((p) => p.format === 'reel')!;
    await updatePost(ctx, reel.id, { status: 'approved', body: 'Текст рилса', approvedBy: author.id, approvedAt: new Date().toISOString() });
    respond('правка плана', (_opts, _profile, user) => ({
      reply: 'Убрал опрос, перенёс пост и переписал рилс.',
      remove: [numberOf(user, 'Опрос: какая первая тату')],
      update: [
        { n: numberOf(user, 'Как подготовиться к первому сеансу'), time: '18:00' },
        { n: numberOf(user, 'Процесс: трансфер эскиза'), topic: 'Процесс: как мастер готовит рабочее место' },
      ],
      add: [{ date: `${month}-15`, time: '12:00', platform: 'telegram', format: 'post', topic: 'Почему титан, а не хирургическая сталь', brief: 'Польза' }],
      memory: [{ kind: 'rule', text: 'Не ставить публикации на понедельник' }],
    }));

    const reply = await revisePlan(ctx, 'studio', month, 'Убери опрос, перенеси пост на вечер, рилс про подготовку места', author);

    expect(reply).toBe('Убрал опрос, перенёс пост и переписал рилс. Запомнил на будущее.');
    const posts = await listPosts(ctx, { profile: 'studio' });
    expect(posts.map((p) => p.topic)).not.toContain('Опрос: какая первая тату');
    const moved = posts.find((p) => p.topic === 'Как подготовиться к первому сеансу')!;
    expect(studioClock(ctx, moved.publishAt!)).toEqual({ day: `${month}-05`, time: '18:00' });
    expect(moved.status).toBe('idea');
    const rewritten = posts.find((p) => p.id === reel.id)!;
    expect(rewritten).toMatchObject({ topic: 'Процесс: как мастер готовит рабочее место', status: 'idea', body: '', approvedBy: null });
    expect(posts.map((p) => p.topic)).toContain('Почему титан, а не хирургическая сталь');
    const memory = ctx.db.select().from(smmMemory).all();
    expect(memory).toEqual([expect.objectContaining({ profile: 'studio', kind: 'rule', source: 'remark', authorId: author.id })]);
    const comments = await listComments(ctx, { planId: plan.id });
    expect(comments.slice(-2).map((c) => c.role)).toEqual(['staff', 'ai']);
    expect((await loadPlan(ctx, 'studio', month))?.busy).toBeNull();
  });

  it('says there is no plan yet', async () => {
    await expect(revisePlan(ctx, 'author', nextMonth(), 'Добавь пост', author)).rejects.toMatchObject({ status: 404 });
  });
});

async function newPost(profile: SmmProfile, format: SmmPost['format'] = 'post', platform: SmmPost['platform'] = 'telegram'): Promise<string> {
  const id = await insertPost(ctx, {
    profile,
    platform,
    format,
    publishAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    topic: 'Уход за свежим проколом',
    brief: 'Памятка: чем промывать и чего избегать первые недели',
  });
  return id;
}

/** Этап шкалы готовности поста сейчас. */
function progressOf(id: string): string {
  const row = ctx.db.select({ progress: smmPosts.progressJson }).from(smmPosts).where(eq(smmPosts.id, id)).get();
  return row?.progress ? (JSON.parse(row.progress) as { label: string }).label : '';
}

/** Черновик модели. */
function draftAnswer(extra: Record<string, unknown> = {}) {
  return () => ({
    body: 'Свежий прокол любит покой. Промывайте его физраствором дважды в день и не крутите украшение.',
    visual: 'Памятка по уходу на светлом фоне',
    images: [{ prompt: 'Памятка по уходу за проколом: чистый дизайн, крупная надпись «Уход», без крови', logo: false }],
    script: null,
    ...extra,
  });
}

describe('writePost', () => {
  it('writes the text, makes the picture, shows progress and sends the post to review', async () => {
    const id = await newPost('studio');
    await claimPost(ctx, id, 'text');
    const progress: string[] = [];
    respond('пост ', () => {
      progress.push(progressOf(id));
      return draftAnswer()();
    });
    vi.mocked(generateImage).mockImplementation(async () => {
      progress.push(progressOf(id));
      return { url: 'https://polza.test/out.png', cost: 4, model: 'image-model' };
    });

    const post = await writePost(ctx, id);

    expect(post).toMatchObject({ status: 'review', busy: null, progress: null, error: null, visual: 'Памятка по уходу на светлом фоне' });
    expect(post.body.length).toBeGreaterThan(20);
    expect(post.media).toHaveLength(1);
    expect(post.media[0]).toMatchObject({ kind: 'image', source: 'ai', status: 'done', aspect: '4:5', model: 'image-model', selected: true });
    expect(post.media[0]?.url).toMatch(/^\/uploads\/smm-.+\.png$/);
    expect(progress).toEqual(['Пишу текст', 'Рисую картинку']);
    expect(vi.mocked(generateImage).mock.calls[0]?.[2].prompt).not.toMatch(/кров/i);
    const [call] = callsOf('пост ');
    expect(call!.profile).toBe('studio');
    expect(call!.user).toContain('Факты о студии');
    expect(call!.user).toContain('Уход за свежим проколом');
  });

  it('approves at once with autopilot and keeps the reel script', async () => {
    saveSmmSettings(ctx.db, 'studio', { autopilot: true });
    const id = await newPost('studio', 'reel', 'instagram');
    await claimPost(ctx, id, 'text');
    const script = { hook: 'Три вещи, которые нельзя делать после прокола', formula: '3. Запрет', shots: [{ text: 'Мастер показывает украшение', seconds: 3 }] };
    respond('пост ', draftAnswer({ script }));

    const post = await writePost(ctx, id);

    expect(post.status).toBe('approved');
    expect(post.script).toMatchObject({ hook: script.hook, shots: [{ text: 'Мастер показывает украшение' }] });
    expect(post.media[0]?.aspect).toBe('9:16');
    expect(callsOf('пост ')[0]!.user).toContain('Формулы зацепки');
  });

  it('puts a real archive photo as is instead of drawing a work', async () => {
    writeKey(ctx.db, 'smm_library:studio', {
      folderId: 'root0123456789abcdef',
      url: 'https://drive.google.com/drive/folders/root0123456789abcdef',
      title: 'Архив',
      connectedAt: new Date().toISOString(),
      syncedAt: null,
      error: null,
      progress: null,
    });
    const now = Date.now();
    ctx.db
      .insert(smmLibrary)
      .values({ profile: 'studio', driveId: 'work-1', folderId: 'al', path: 'Работы / Пирсинг', name: 'w.jpg', mime: 'image/jpeg', description: 'Свежий прокол хеликса с титановым кольцом', quality: 5, seenAt: now, createdAt: now })
      .run();
    const id = await newPost('studio');
    await claimPost(ctx, id, 'text');
    respond('пост ', draftAnswer({ images: [{ photo: 'Ф1', mode: 'as_is' }] }));

    const post = await writePost(ctx, id);

    expect(post.media).toEqual([expect.objectContaining({ source: 'archive', status: 'done', model: 'google-drive' })]);
    expect(vi.mocked(generateImage)).not.toHaveBeenCalled();
    expect(callsOf('пост ')[0]!.user).toContain('Ф1: Работы / Пирсинг — Свежий прокол хеликса');
    expect(ctx.db.select().from(smmLibrary).where(eq(smmLibrary.driveId, 'work-1')).get()?.usedCount).toBe(1);
  });

  it('writes for the author without studio facts', async () => {
    const id = await newPost('author');
    await claimPost(ctx, id, 'text');
    respond('пост ', draftAnswer());

    const post = await writePost(ctx, id);

    expect(post.status).toBe('review');
    const [call] = callsOf('пост ');
    expect(call!.profile).toBe('author');
    expect(call!.user).toContain('Факты об авторе');
    expect(`${call!.system}\n${call!.user}`).not.toContain(SERVICE_NAME);
  });

  it('keeps the text and reports the picture error when drawing fails', async () => {
    const id = await newPost('studio');
    await claimPost(ctx, id, 'text');
    respond('пост ', draftAnswer());
    vi.mocked(generateImage).mockRejectedValue(new Error('сеть'));

    const post = await writePost(ctx, id);

    expect(post.status).toBe('review');
    expect(post.body.length).toBeGreaterThan(20);
    expect(post.error).toContain('Картинка не получилась');
    expect(post.busy).toBeNull();
  });
});

describe('revisePost', () => {
  async function reviewPost(profile: SmmProfile): Promise<string> {
    const id = await newPost(profile);
    await updatePost(ctx, id, { status: 'review', body: 'Старый текст публикации про уход за проколом и украшения.' });
    await claimPost(ctx, id, 'revise');
    return id;
  }

  it('rewrites the text, moves the time, replies and remembers a general rule', async () => {
    const id = await reviewPost('studio');
    const before = (await loadPost(ctx, id))!;
    respond('правка ', () => ({
      reply: 'Сократил текст и перенёс на вечер.',
      body: 'Новый короткий текст: промывайте прокол дважды в день и не трогайте украшение.',
      time: '18:30',
      memory: [{ kind: 'avoid', text: 'Не писать слово «эксклюзивный»' }],
    }));

    const { post, reply } = await revisePost(ctx, id, 'Короче и на вечер, и вообще без «эксклюзивный»', author);

    expect(reply).toBe('Сократил текст и перенёс на вечер. Запомнил на будущее.');
    expect(post).toMatchObject({ status: 'review', busy: null, error: null, approvedBy: null });
    expect(post.body).not.toBe(before.body);
    expect(studioClock(ctx, post.publishAt!)).toEqual({ day: studioClock(ctx, before.publishAt!).day, time: '18:30' });
    const comments = await listComments(ctx, { postId: id });
    expect(comments.map((c) => c.role)).toEqual(['staff', 'ai']);
    expect(comments[1]?.text).toBe(reply);
    expect(ctx.db.select().from(smmMemory).all()).toEqual([
      expect.objectContaining({ profile: 'studio', kind: 'avoid', source: 'remark', authorId: author.id }),
    ]);
  });

  it('keeps the status when only the time moves and redraws a picture slot on request', async () => {
    const id = await reviewPost('author');
    await updatePost(ctx, id, { status: 'approved' });
    respond('правка ', () => ({ reply: 'Перенесла на 20:00.', time: '20:00' }));
    const moved = await revisePost(ctx, id, 'Перенеси на 20:00', author);
    expect(moved.post.status).toBe('approved');
    expect(studioClock(ctx, moved.post.publishAt!).time).toBe('20:00');

    await claimPost(ctx, id, 'revise');
    respond('правка ', () => ({ reply: 'Сделала новую обложку.', images: [{ prompt: 'Обложка: крупная надпись «Мой первый флеш», эскизы на столе', slot: 0 }] }));
    const redrawn = await revisePost(ctx, id, 'Новую обложку', author);
    expect(redrawn.post.status).toBe('review');
    expect(redrawn.post.media[0]).toMatchObject({ source: 'ai', sort: 0, status: 'done' });
    expect(vi.mocked(generateImage).mock.calls.at(-1)?.[1]).toBe('author');
  });
});

describe('suggestIdeas', () => {
  it('suggests ideas over the directions of the profile', async () => {
    const keys = keysOf('author');
    respond('идеи', () => ({
      ideas: [{ topic: 'Мой первый флеш', brief: 'Показать эскизы', platform: 'instagram', format: 'carousel', direction: keys[0] }],
    }));
    const ideas = await suggestIdeas(ctx, 'author', { count: 3 });
    expect(ideas).toEqual([expect.objectContaining({ topic: 'Мой первый флеш', direction: keys[0] })]);
    const [call] = callsOf('идеи', 'author');
    expect(call!.user).toContain('Придумай 3 свежих идей');
    expect(call!.user).toContain('Вдохновение: идеи, референсы, путешествия');
    expect(call!.user).not.toContain(SERVICE_NAME);
  });
});

describe('generateReport', () => {
  function completedVisit(startsAt: number): void {
    const now = Date.now();
    const client = ctx.db.insert(clients).values({ name: 'Клиент', nameSort: 'клиент', createdAt: now, updatedAt: now }).returning().get();
    ctx.db
      .insert(appointments)
      .values({ clientId: client.id, masterId: author.id!, startsAt, endsAt: startsAt + 3_600_000, status: 'completed', createdAt: now, updatedAt: now })
      .run();
  }

  const reportAnswer = () => ({
    title: 'Неделя рилсов',
    summary: 'Рилсы дали основной охват, посты пользы — сохранения. Визиты выросли к выходным.',
    metrics: [{ label: 'Охват', value: '12 400', delta: 18 }],
    recommendations: [{ title: 'Больше рилсов процесса', detail: 'Два рилса в неделю про подготовку места' }],
    insights: ['Рилсы процесса набирают вдвое больше просмотров, чем посты'],
  });

  it('stores the report, correlates with studio visits and remembers insights', async () => {
    completedVisit(Date.now() - 3 * 86_400_000);
    respond('отчёт', reportAnswer);

    const report = await generateReport(ctx, 'studio');

    expect(report).toMatchObject({ title: 'Неделя рилсов', metrics: [{ label: 'Охват', value: '12 400', delta: 18 }] });
    expect(report.recommendations).toHaveLength(1);
    const [call] = callsOf('отчёт', 'studio');
    expect(call!.user).toMatch(/Визитов в студию \(завершённых записей\) по дням.*\n\d{4}-\d{2}-\d{2}: 1/);
    expect(call!.user).not.toContain('Клиент');
    expect(ctx.db.select().from(smmMemory).all()).toEqual([
      expect.objectContaining({ profile: 'studio', kind: 'insight', source: 'analytics' }),
    ]);
  });

  it('leaves studio visits out of the author report', async () => {
    completedVisit(Date.now() - 3 * 86_400_000);
    respond('отчёт', reportAnswer);
    await generateReport(ctx, 'author');
    const [call] = callsOf('отчёт', 'author');
    expect(call!.user).not.toContain('Визитов');
    expect(ctx.db.select().from(smmMemory).all()[0]?.profile).toBe('author');
  });

  it('rejects a broken period', async () => {
    await expect(generateReport(ctx, 'studio', { from: '2026-10-10', to: '2026-10-01' })).rejects.toMatchObject({ status: 400 });
  });
});
