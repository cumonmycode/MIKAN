import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatRef, HtmlOptions, SentMessage } from '../src/bot/gateway.js';
import { botChats, employees, smmAccounts, smmMedia, smmPosts } from '../src/db/schema.js';
import { setChatEmployee, upsertChat } from '../src/domain/bot-chats.js';
import { fresh } from '../src/routes/smm.js';
import { insertMedia } from '../src/smm/db.js';
import { saveSmmSettings } from '../src/smm/settings.js';
import type { SmmPost, SmmProfile } from '../src/smm/types.js';
import { publishNow, smmIdle, smmTick } from '../src/smm/workflow.js';
import { createTestApp, make, type TestApp } from './helpers.js';

/**
 * The SMM HTTP API (routes/smm*.ts) and the post lifecycle (smm/workflow.ts) over the real modules of the other
 * agents. Nothing leaves the process: Telegram is the fake gateway, every SMM web request goes to `offline`, and the
 * test config has no AI key (AI steps are skipped, `polzaBalance` is null).
 */

const MB = 1024 * 1024;
const offline: typeof fetch = async () => {
  throw new Error('offline in tests');
};

let t: TestApp;

beforeEach(async () => {
  t = await createTestApp();
  t.ctx.smmFetch = offline;
});

afterEach(async () => {
  await t.close();
});

const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

async function newPost(profile: SmmProfile, extra: Record<string, unknown> = {}): Promise<SmmPost> {
  const res = await t.api('POST', `/api/smm/${profile}/posts`, {
    platform: 'telegram',
    format: 'post',
    date: tomorrow(),
    time: '12:00',
    topic: 'Как ухаживать за свежим проколом',
    ...extra,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ post: SmmPost }>().post;
}

async function writtenPost(profile: SmmProfile): Promise<SmmPost> {
  const post = await newPost(profile);
  const res = await t.api('PATCH', `/api/smm/${profile}/posts/${post.id}`, { body: 'Промывайте прокол физраствором дважды в день.' });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ post: SmmPost }>().post;
}

function setStatus(id: string, patch: Partial<typeof smmPosts.$inferInsert>): void {
  t.ctx.db.update(smmPosts).set(patch).where(eq(smmPosts.id, id)).run();
}

function addChannel(profile: SmmProfile): void {
  const now = Date.now();
  t.ctx.db
    .insert(smmAccounts)
    .values({
      id: randomUUID(),
      profile,
      platform: 'telegram',
      title: 'MIKAN',
      handle: 'mikan_test',
      url: 'https://t.me/mikan_test',
      tgChatId: '@mikan_test',
      canPublish: true,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

const APPROVER_CHAT = 7001;

/** The admin gets a private chat with the bot: as the only staff member with one, they approve the studio. */
function approverChat(): number {
  const admin = t.ctx.db.select({ id: employees.id }).from(employees).get()!;
  upsertChat(t.ctx.db, APPROVER_CHAT, { telegramName: 'Админ' });
  setChatEmployee(t.ctx.db, APPROVER_CHAT, admin.id);
  return APPROVER_CHAT;
}

const toApprover = () => t.gateway.htmlSent.filter((m) => m.chat === APPROVER_CHAT).map((m) => m.text);
const row = (id: string) => t.ctx.db.select().from(smmPosts).where(eq(smmPosts.id, id)).get()!;

const channelPosts = () => [
  ...t.gateway.htmlSent.filter((m) => String(m.chat) === '@mikan_test'),
  ...t.gateway.mediaSent.filter((m) => String(m.chat) === '@mikan_test'),
];

function multipart(mime: string, data: Buffer, field = 'file') {
  const boundary = `----mikan${randomUUID()}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="upload"\r\nContent-Type: ${mime}\r\n\r\n`,
  );
  return {
    payload: Buffer.concat([head, data, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    headers: { authorization: `Bearer ${t.token}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

const upload = (url: string, mime: string, data: Buffer) => t.app.inject({ method: 'POST', url, ...multipart(mime, data) });

/** A JPEG signature padded to `size` bytes. */
const jpeg = (size: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size - 4)]);
/** An MP4 (`ftyp isom`) padded to `size` bytes. */
const mp4 = (size: number) => Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), Buffer.alloc(size - 12)]);

describe('profiles', () => {
  it('lists both profiles with their names, switches and counters', async () => {
    const post = await writtenPost('studio');
    expect(post.status).toBe('review');
    const res = await t.api('GET', '/api/smm/profiles');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      items: [
        { profile: 'studio', brandName: 'MIKAN STUDIO', enabled: true, review: 1, awaitingLink: 0, failed: 0 },
        { profile: 'author', brandName: 'Амина', enabled: false, review: 0, awaitingLink: 0, failed: 0 },
      ],
    });
  });

  it('answers 404 for an unknown profile', async () => {
    const res = await t.api('GET', '/api/smm/club/overview');
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });

  it('needs a signed-in employee', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/smm/profiles' });
    expect(res.statusCode).toBe(401);
  });
});

describe('profile isolation', () => {
  it('a studio post does not exist under /author', async () => {
    const post = await writtenPost('studio');
    expect(post.profile).toBe('studio');
    for (const [method, path] of [
      ['GET', ''],
      ['PATCH', ''],
      ['DELETE', ''],
      ['POST', '/approve'],
      ['POST', '/skip'],
      ['POST', '/publish'],
      ['POST', '/link'],
    ] as const) {
      const body = path === '/link' ? { url: 'https://t.me/mikan_test/1' } : method === 'PATCH' ? { topic: 'Чужое' } : {};
      const res = await t.api(method, `/api/smm/author/posts/${post.id}${path}`, body);
      expect(res.statusCode, `${method} ${path}`).toBe(404);
    }
    expect((await t.api('GET', `/api/smm/studio/posts/${post.id}`)).statusCode).toBe(200);
    const authorFeed = (await t.api('GET', '/api/smm/author/posts')).json<{ posts: SmmPost[] }>().posts;
    expect(authorFeed).toEqual([]);
    const swap = await t.api('POST', '/api/smm/author/posts/swap', { a: post.id, b: (await newPost('author')).id });
    expect(swap.statusCode).toBe(404);
    expect((await t.api('GET', `/api/smm/studio/posts/${post.id}`)).json().post.topic).toBe(post.topic);
  });

  it('keeps memory, dates and reports apart', async () => {
    await make(t, '/api/smm/studio/memory', { kind: 'rule', text: 'Без слова «больно» в заголовках' });
    const studio = (await t.api('GET', '/api/smm/studio/memory')).json().memory;
    expect(studio).toHaveLength(1);
    expect((await t.api('GET', '/api/smm/author/memory')).json().memory).toEqual([]);
    expect((await t.api('DELETE', `/api/smm/author/memory/${studio[0].id}`)).statusCode).toBe(404);
    expect((await t.api('GET', `/api/smm/author/reports/${randomUUID()}`)).statusCode).toBe(404);
  });
});

describe('settings', () => {
  it('reads and saves each profile on its own', async () => {
    const before = (await t.api('GET', '/api/smm/author/settings')).json();
    expect(before.settings).toMatchObject({ enabled: false, brandName: 'Амина' });
    expect(before).toMatchObject({ accounts: [], photos: [], balance: null });
    expect(before.staff).toEqual([{ id: expect.any(Number), name: 'Админ', telegram: false }]);

    const res = await t.api('PUT', '/api/smm/author/settings', { enabled: true, brandName: 'Амина Тату', cadence: { reels: 4 } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().settings).toMatchObject({ enabled: true, brandName: 'Амина Тату', cadence: { reels: 4, telegram: 3 } });
    expect((await t.api('GET', '/api/smm/author/settings')).json().settings.cadence.reels).toBe(4);

    const studio = (await t.api('GET', '/api/smm/studio/settings')).json().settings;
    expect(studio).toMatchObject({ enabled: true, brandName: 'MIKAN STUDIO', cadence: { reels: 3 } });
  });

  it('rejects invalid values with 400 and changes nothing', async () => {
    for (const patch of [
      { cadence: { telegram: 99 } },
      { postTime: '25:00' },
      { brandName: '' },
      { reviewLeadHours: 1 },
      { approverIds: [9999] },
      { publisherId: 9999 },
    ]) {
      const res = await t.api('PUT', '/api/smm/studio/settings', patch);
      expect(res.statusCode, JSON.stringify(patch)).toBe(400);
      expect(res.json().error.code).toBe('validation_error');
    }
    expect((await t.api('GET', '/api/smm/studio/settings')).json().settings).toMatchObject({
      postTime: '12:00',
      brandName: 'MIKAN STUDIO',
      cadence: { telegram: 4 },
      approverIds: [],
    });
  });

  it('gives /meta the directions of the profile', async () => {
    await t.api('PUT', '/api/smm/author/settings', { directions: 'Эскизы\nПутешествия' });
    const meta = (await t.api('GET', '/api/smm/author/meta')).json();
    expect(meta.directions.map((d: { label: string }) => d.label)).toEqual(['Эскизы', 'Путешествия']);
    expect(meta.directions[0]).toEqual({ key: expect.any(String), label: 'Эскизы' });
    expect(meta.formats.map((f: { key: string }) => f.key)).toEqual(['post', 'carousel', 'story', 'reel']);
  });
});

describe('people', () => {
  it('lists active employees and who has a chat with the bot', async () => {
    const master = await make(t, '/api/employees', { name: 'Борис', login: 'boris', password: 'secret123', color: '#FF0000' });
    t.ctx.db
      .insert(botChats)
      .values({ chatId: 777, employeeId: master.id, createdAt: Date.now(), updatedAt: Date.now() })
      .run();
    const res = await t.api('GET', '/api/smm/author/people');
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([
      { id: expect.any(Number), name: 'Админ', telegram: false },
      { id: master.id, name: 'Борис', telegram: true },
    ]);
    expect((await t.api('GET', '/api/smm/club/people')).statusCode).toBe(404);
  });
});

describe('lifecycle', () => {
  it('approve: a written post becomes approved by the employee', async () => {
    const post = await writtenPost('studio');
    const res = await t.api('POST', `/api/smm/studio/posts/${post.id}/approve`);
    expect(res.statusCode, res.body).toBe(200);
    const approved = res.json<{ post: SmmPost }>().post;
    expect(approved).toMatchObject({ status: 'approved', autoPublish: true, approvedAt: expect.any(String) });
    expect(approved.approvedBy).toBe(t.ctx.db.select().from(smmPosts).where(eq(smmPosts.id, post.id)).get()?.approvedBy);
    expect(approved.approvedBy).toEqual(expect.any(Number));
  });

  it('approve without a text is a conflict', async () => {
    const post = await newPost('studio');
    const res = await t.api('POST', `/api/smm/studio/posts/${post.id}/approve`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toEqual({ code: 'conflict', message: 'Сначала маркетолог должен написать текст' });
  });

  it('skip and restore', async () => {
    const post = await writtenPost('studio');
    const skipped = (await t.api('POST', `/api/smm/studio/posts/${post.id}/skip`)).json().post;
    expect(skipped.status).toBe('skipped');
    const restored = (await t.api('POST', `/api/smm/studio/posts/${post.id}/restore`)).json().post;
    expect(restored.status).toBe('review');
  });

  it('a link marks a manual post published; only https links are taken', async () => {
    const post = await writtenPost('studio');
    const bad = await t.api('POST', `/api/smm/studio/posts/${post.id}/link`, { url: 'http://t.me/x/1' });
    expect(bad.statusCode).toBe(400);
    const res = await t.api('POST', `/api/smm/studio/posts/${post.id}/link`, { url: 'https://t.me/mikan_test/5' });
    expect(res.json().post).toMatchObject({ status: 'published', publishedUrl: 'https://t.me/mikan_test/5' });
    expect((await t.api('DELETE', `/api/smm/studio/posts/${post.id}`)).statusCode).toBe(409);
  });

  it('publishNow claims the post: a double click publishes once', async () => {
    addChannel('studio');
    const post = await writtenPost('studio');
    const [a, b] = await Promise.all([
      t.api('POST', `/api/smm/studio/posts/${post.id}/publish`),
      t.api('POST', `/api/smm/studio/posts/${post.id}/publish`),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    const ok = a.statusCode === 200 ? a : b;
    expect(ok.json().post).toMatchObject({ status: 'published', publishedUrl: expect.stringMatching(/^https:\/\/t\.me\/mikan_test\/\d+$/) });
    expect(channelPosts()).toHaveLength(1);
    await expect(publishNow(t.ctx, post.id)).rejects.toThrow('Уже опубликовано');
    expect(channelPosts()).toHaveLength(1);
  });

  it('publishNow claims the post against the cron in the same minute', async () => {
    addChannel('studio');
    const post = await writtenPost('studio');
    await t.api('POST', `/api/smm/studio/posts/${post.id}/approve`);
    setStatus(post.id, { publishAt: Date.now() - 60_000 });
    const [first, , second] = await Promise.allSettled([publishNow(t.ctx, post.id), smmTick(t.ctx), publishNow(t.ctx, post.id)]);
    // Whoever claims first publishes (a button or the cron); the others find the post taken.
    expect([first, second].filter((r) => r.status === 'fulfilled').length).toBeLessThanOrEqual(1);
    expect(channelPosts()).toHaveLength(1);
    expect(t.ctx.db.select().from(smmPosts).where(eq(smmPosts.id, post.id)).get()?.status).toBe('published');
  });

  it('a failed publication is marked failed and can be retried', async () => {
    const post = await writtenPost('studio');
    const res = await t.api('POST', `/api/smm/studio/posts/${post.id}/publish`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('Канал Telegram не подключён');
    const stored = t.ctx.db.select().from(smmPosts).where(eq(smmPosts.id, post.id)).get();
    expect(stored).toMatchObject({ status: 'failed', publishedAt: null });
  });
});

describe('cron', () => {
  it('publishes due Telegram posts of an enabled profile and leaves a disabled one alone', async () => {
    addChannel('studio');
    addChannel('author');
    const studio = await writtenPost('studio');
    const author = await writtenPost('author');
    for (const p of [studio, author]) setStatus(p.id, { status: 'approved', approvedAt: Date.now(), publishAt: Date.now() - 60_000 });
    await smmTick(t.ctx);
    const status = (id: string) => t.ctx.db.select().from(smmPosts).where(eq(smmPosts.id, id)).get()?.status;
    expect(status(studio.id)).toBe('published');
    expect(status(author.id)).toBe('approved');
    expect(channelPosts()).toHaveLength(1);

    saveSmmSettings(t.ctx.db, 'author', { enabled: true });
    await smmTick(t.ctx);
    expect(status(author.id)).toBe('published');
  });

  it('does not publish silently when the time passed long ago', async () => {
    addChannel('studio');
    const post = await writtenPost('studio');
    setStatus(post.id, { status: 'approved', approvedAt: Date.now() - 8 * 3_600_000, publishAt: Date.now() - 7 * 3_600_000 });
    await smmTick(t.ctx);
    const stored = t.ctx.db.select().from(smmPosts).where(eq(smmPosts.id, post.id)).get();
    expect(stored).toMatchObject({ status: 'failed', error: expect.stringContaining('Время выхода прошло') });
    expect(channelPosts()).toHaveLength(0);
  });

  it('publishes a late post that was approved within the last 6 hours: the delay was on purpose', async () => {
    addChannel('studio');
    const post = await writtenPost('studio');
    setStatus(post.id, { status: 'approved', approvedAt: Date.now() - 3_600_000, publishAt: Date.now() - 7 * 3_600_000 });

    await smmTick(t.ctx);

    expect(row(post.id)).toMatchObject({ status: 'published', error: null });
    expect(channelPosts()).toHaveLength(1);
  });

  it('does not publish a post already handed to a person (e.g. Instagram connected after the hand-off)', async () => {
    addChannel('studio');
    const post = await writtenPost('studio');
    setStatus(post.id, { status: 'approved', approvedAt: Date.now(), publishAt: Date.now() - 60_000, handoffAt: Date.now() - 600_000 });

    await smmTick(t.ctx);

    expect(row(post.id).status).toBe('approved');
    expect(channelPosts()).toHaveLength(0);
  });

  it('a button that published a due post first is not reported as «Не вышел пост»', async () => {
    approverChat();
    addChannel('studio');
    const first = await writtenPost('studio');
    const second = await writtenPost('studio');
    setStatus(first.id, { status: 'approved', approvedAt: Date.now(), publishAt: Date.now() - 120_000 });
    setStatus(second.id, { status: 'approved', approvedAt: Date.now(), publishAt: Date.now() - 60_000 });
    // While the cron sends the first post, «Опубликовать» in the app claims the second one.
    const send = t.gateway.sendHtml.bind(t.gateway);
    t.gateway.sendHtml = async (chat: ChatRef, text: string, options?: HtmlOptions): Promise<SentMessage> => {
      if (String(chat) === '@mikan_test') setStatus(second.id, { status: 'published', publishedAt: Date.now() });
      return send(chat, text, options);
    };

    await smmTick(t.ctx);

    expect(row(first.id).status).toBe('published');
    expect(toApprover().filter((m) => m.startsWith('❗ Не вышел пост'))).toEqual([]);
  });

  it('a real failure still alerts the approvers', async () => {
    approverChat();
    addChannel('studio');
    const post = await writtenPost('studio');
    setStatus(post.id, { status: 'approved', approvedAt: Date.now(), publishAt: Date.now() - 60_000 });
    t.gateway.smmFailures.push(new Error('Telegram: Bad Request: chat not found'));

    await smmTick(t.ctx);

    expect(row(post.id).status).toBe('failed');
    expect(toApprover().some((m) => m.startsWith('❗ Не вышел пост: <b>Как ухаживать за свежим проколом</b>'))).toBe(true);
  });
});

describe('interrupted publications', () => {
  it('a post claimed for publishing with no trace on the platform for 10+ minutes becomes failed; approvers are told once', async () => {
    approverChat();
    addChannel('studio');
    const ghost = await writtenPost('studio');
    const fresh = await writtenPost('studio');
    const real = await writtenPost('studio');
    setStatus(ghost.id, { status: 'published', publishedAt: Date.now() - 11 * 60_000 });
    setStatus(fresh.id, { status: 'published', publishedAt: Date.now() - 2 * 60_000 });
    setStatus(real.id, { status: 'published', publishedAt: Date.now() - 60 * 60_000, tgMessageId: 41, publishedUrl: 'https://t.me/mikan_test/41' });

    await smmTick(t.ctx);
    await smmTick(t.ctx);

    expect(row(ghost.id)).toMatchObject({ status: 'failed', publishedAt: null, error: expect.stringContaining('Публикация прервалась') });
    expect(row(fresh.id).status).toBe('published');
    expect(row(real.id).status).toBe('published');
    const told = toApprover().filter((m) => m.startsWith('❗ Публикация прервалась'));
    expect(told).toHaveLength(1);
    expect(told[0]).toContain('Telegram');
  });

  it('smmIdle waits for the tick that is publishing right now', async () => {
    addChannel('studio');
    const post = await writtenPost('studio');
    setStatus(post.id, { status: 'approved', approvedAt: Date.now(), publishAt: Date.now() - 60_000 });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sending = false;
    const send = t.gateway.sendHtml.bind(t.gateway);
    t.gateway.sendHtml = async (chat: ChatRef, text: string, options?: HtmlOptions): Promise<SentMessage> => {
      if (String(chat) === '@mikan_test') {
        sending = true;
        await gate;
      }
      return send(chat, text, options);
    };

    const tick = smmTick(t.ctx);
    for (let i = 0; i < 200 && !sending; i += 1) await new Promise((r) => setTimeout(r, 5));
    expect(sending).toBe(true);
    let idle = false;
    const waiting = smmIdle(t.ctx).then(() => {
      idle = true;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(idle).toBe(false);
    expect(row(post.id)).toMatchObject({ status: 'published', tgMessageId: null });

    release();
    await waiting;
    await tick;
    expect(row(post.id).tgMessageId).toEqual(expect.any(Number));
    await expect(smmIdle(t.ctx)).resolves.toBeUndefined();
  });
});

describe('stale work', () => {
  it('a post left «busy» by a restart is free again: the app sees no spinner and approval works', async () => {
    const post = await writtenPost('studio');
    setStatus(post.id, { busy: 'text', busyAt: Date.now() - 11 * 60_000, progressJson: JSON.stringify({ label: 'Пишу текст', pct: 10, next: 40, eta: 20, at: new Date().toISOString() }) });

    const read = await t.api('GET', `/api/smm/studio/posts/${post.id}`);
    expect(read.json().post).toMatchObject({ busy: null, progress: null });
    const approved = await t.api('POST', `/api/smm/studio/posts/${post.id}/approve`);
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json().post.status).toBe('approved');
  });

  it('fresh work still blocks approval', async () => {
    const post = await writtenPost('studio');
    setStatus(post.id, { busy: 'revise', busyAt: Date.now() - 60_000 });

    expect((await t.api('GET', `/api/smm/studio/posts/${post.id}`)).json().post.busy).toBe('revise');
    const res = await t.api('POST', `/api/smm/studio/posts/${post.id}/approve`);
    expect(res.statusCode).toBe(409);
  });

  it('«busy with video» lasts while the network makes the video (40 minutes), then it is gone', async () => {
    const post = await writtenPost('studio');
    setStatus(post.id, { busy: 'video', busyAt: Date.now() - 30 * 60_000 });
    const media = await insertMedia(t.ctx, { postId: post.id, kind: 'video', source: 'ai', status: 'pending', polzaId: 'job-1' });
    t.ctx.db.update(smmMedia).set({ createdAt: Date.now() - 30 * 60_000 }).where(eq(smmMedia.id, media)).run();
    expect((await t.api('GET', `/api/smm/studio/posts/${post.id}`)).json().post.busy).toBe('video');

    t.ctx.db.update(smmMedia).set({ createdAt: Date.now() - 41 * 60_000 }).where(eq(smmMedia.id, media)).run();
    expect((await t.api('GET', `/api/smm/studio/posts/${post.id}`)).json().post.busy).toBeNull();
  });

  it('the cron frees a post «busy with video» when no video is in the works, and publishes past a dead video job', async () => {
    addChannel('studio');
    const stuck = await writtenPost('studio');
    setStatus(stuck.id, { busy: 'video', busyAt: Date.now() - 13 * 60_000 });
    const working = await writtenPost('studio');
    setStatus(working.id, { busy: 'video', busyAt: Date.now() - 13 * 60_000 });
    await insertMedia(t.ctx, { postId: working.id, kind: 'video', source: 'ai', status: 'pending', polzaId: 'job-2' });
    const due = await writtenPost('studio');
    setStatus(due.id, { status: 'approved', approvedAt: Date.now(), publishAt: Date.now() - 60_000, busy: 'video', busyAt: Date.now() - 50 * 60_000 });
    const dead = await insertMedia(t.ctx, { postId: due.id, kind: 'video', source: 'ai', status: 'pending', polzaId: 'job-3' });
    t.ctx.db.update(smmMedia).set({ createdAt: Date.now() - 50 * 60_000 }).where(eq(smmMedia.id, dead)).run();

    await smmTick(t.ctx);

    expect(row(stuck.id)).toMatchObject({ busy: null, busyAt: null, error: 'Видео не получилось — попробуйте ещё раз' });
    expect(row(working.id).busy).toBe('video');
    expect(row(due.id).status).toBe('published');
  });

  it('a post that vanished meanwhile is a 404, never { post: null }', async () => {
    await expect(fresh(t.ctx, randomUUID())).rejects.toMatchObject({ status: 404, message: 'Публикация не найдена' });
  });
});

describe('overview', () => {
  it('counts review, awaiting link, failed and published of the profile', async () => {
    const [review, awaiting, failed, published, old, author] = [
      await writtenPost('studio'),
      await writtenPost('studio'),
      await writtenPost('studio'),
      await writtenPost('studio'),
      await writtenPost('studio'),
      await writtenPost('author'),
    ];
    const now = Date.now();
    setStatus(awaiting.id, { status: 'approved', handoffAt: now - 60_000 });
    setStatus(failed.id, { status: 'failed', publishAt: now - 86_400_000 });
    setStatus(published.id, { status: 'published', publishedAt: now - 3_600_000 });
    setStatus(old.id, { status: 'published', publishedAt: now - 10 * 86_400_000 });
    expect(review.status).toBe('review');
    expect(author.profile).toBe('author');

    const res = await t.api('GET', '/api/smm/studio/overview');
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.counts).toEqual({ review: 1, awaitingLink: 1, failed: 1, publishedWeek: 1 });
    expect(body).toMatchObject({
      month: expect.stringMatching(/^\d{4}-\d{2}$/),
      plan: null,
      accounts: [],
      lastReport: null,
      spend: { month: 0, budget: 3000 },
      balance: null,
      ready: { channel: false, instagram: false, publisher: false, approvers: 0 },
      autopilot: false,
    });
    expect(body.upcoming.map((p: SmmPost) => p.id).sort()).toEqual([review.id, awaiting.id, failed.id, published.id].sort());
    expect((await t.api('GET', '/api/smm/author/overview')).json().counts).toEqual({
      review: 1,
      awaitingLink: 0,
      failed: 0,
      publishedWeek: 0,
    });
  });
});

describe('badges', () => {
  it('counts posts waiting for approval in the enabled profiles', async () => {
    await writtenPost('studio');
    await writtenPost('author');
    expect((await t.api('GET', '/api/badges')).json().smmReview).toBe(1);
    saveSmmSettings(t.ctx.db, 'author', { enabled: true });
    expect((await t.api('GET', '/api/badges')).json().smmReview).toBe(2);
    saveSmmSettings(t.ctx.db, 'studio', { enabled: false });
    expect((await t.api('GET', '/api/badges')).json().smmReview).toBe(1);
  });
});

describe('uploads', () => {
  it('takes photos up to 10 MB and videos up to 100 MB into a post', async () => {
    const post = await newPost('studio');
    const url = `/api/smm/studio/posts/${post.id}/media`;

    const photo = await upload(url, 'image/jpeg', jpeg(2 * MB));
    expect(photo.statusCode, photo.body).toBe(200);
    expect(photo.json().post.media).toMatchObject([{ kind: 'image', source: 'upload', url: expect.stringMatching(/^\/uploads\/smm-/) }]);

    const bigPhoto = await upload(url, 'image/jpeg', jpeg(11 * MB));
    expect(bigPhoto.statusCode).toBe(400);
    expect(bigPhoto.json().error.message).toBe('Фото больше 10 МБ');

    const video = await upload(url, 'video/mp4', mp4(12 * MB));
    expect(video.statusCode, video.body).toBe(200);
    expect(video.json().post.media.map((m: { kind: string }) => m.kind)).toEqual(['image', 'video']);

    const hugeVideo = await upload(url, 'video/mp4', mp4(101 * MB));
    expect(hugeVideo.statusCode).toBe(400);
    expect(hugeVideo.json().error.message).toBe('Видео больше 100 МБ');
  });

  it('a Telegram post takes videos up to 50 MB only (the Bot API limit); Instagram up to 100 MB', async () => {
    const telegram = await newPost('studio');
    const tooBig = await upload(`/api/smm/studio/posts/${telegram.id}/media`, 'video/mp4', mp4(51 * MB));
    expect(tooBig.statusCode).toBe(400);
    expect(tooBig.json().error.message).toBe('Telegram принимает видео до 50 МБ — сожмите ролик или снимите покороче');
    expect((await upload(`/api/smm/studio/posts/${telegram.id}/media`, 'video/mp4', mp4(49 * MB))).statusCode).toBe(200);

    const instagram = await newPost('studio', { platform: 'instagram', format: 'reel' });
    const reel = await upload(`/api/smm/studio/posts/${instagram.id}/media`, 'video/mp4', mp4(51 * MB));
    expect(reel.statusCode, reel.body).toBe(200);
  });

  it('refuses uploads into a post of another profile and requests without a file', async () => {
    const post = await newPost('studio');
    expect((await upload(`/api/smm/author/posts/${post.id}/media`, 'image/jpeg', jpeg(1000))).statusCode).toBe(404);
    const noFile = await t.api('POST', `/api/smm/studio/posts/${post.id}/media`, {});
    expect(noFile.statusCode).toBe(400);
  });

  it('takes only photos up to 10 MB for a shooting place', async () => {
    const created = await t.api('POST', '/api/smm/author/zones', { title: 'Кабинет' });
    expect(created.statusCode, created.body).toBe(200);
    const zone = created.json().zones.find((z: { title: string }) => z.title === 'Кабинет');
    const url = `/api/smm/author/zones/${zone.id}/photos`;

    const photo = await upload(url, 'image/jpeg', jpeg(MB));
    expect(photo.statusCode, photo.body).toBe(200);
    expect(photo.json().zones.find((z: { id: string }) => z.id === zone.id).photos).toHaveLength(1);

    expect((await upload(url, 'video/mp4', mp4(MB))).json().error.message).toContain('Нужна фотография');
    const big = await upload(url, 'image/jpeg', jpeg(11 * MB));
    expect(big.statusCode).toBe(400);
    expect(big.json().error.message).toBe('Фото больше 10 МБ');
    expect((await upload(`/api/smm/studio/zones/${zone.id}/photos`, 'image/jpeg', jpeg(MB))).statusCode).toBe(404);
  });
});
