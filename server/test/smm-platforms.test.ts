import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleCallback } from '../src/bot/callbacks.js';
import { BotSendError } from '../src/bot/gateway.js';
import { registerHandlers } from '../src/bot/handlers.js';
import { BotPipeline } from '../src/bot/pipeline.js';
import { botMessages, employees, smmAccounts } from '../src/db/schema.js';
import { setChatEmployee, upsertChat } from '../src/domain/bot-chats.js';
import { writeKey } from '../src/domain/settings.js';
import { linkTelegram } from '../src/domain/clients.js';
import { insertMedia, insertPost, loadPost, updatePost } from '../src/smm/db.js';
import { saveSmmFile } from '../src/smm/files.js';
import { getSmmSettings, saveSmmSettings } from '../src/smm/settings.js';
import {
  approvers,
  awaitedLinkPost,
  awaitedRemarkPost,
  checkChannel,
  publisherFor,
  publishToChannel,
  reviewButtons,
  reviewTag,
  sendHandoff,
  sendReviewTo,
} from '../src/smm/telegram.js';
import { linkTarget } from '../src/smm/tg-handlers.js';
import type { SmmPost, SmmProfile } from '../src/smm/types.js';
import { reviseInBackground } from '../src/smm/writer.js';
import { createTestApp, make, type TestApp } from './helpers.js';

// The marketer's AI rewrite is not under test here: only that a remark reaches it and its answer comes back.
vi.mock('../src/smm/writer.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/smm/writer.js')>()),
  reviseInBackground: vi.fn(),
}));

const CHANNEL_ID = -1001234567890;
const CHANNEL = { id: CHANNEL_ID, type: 'channel', title: 'MIKAN STUDIO', username: 'mikan_studio' };
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const ANNA_CHAT = 501;
const BORIS_CHAT = 502;
const CLIENT_CHAT = 900;
const botInfo = {
  id: 1,
  is_bot: true,
  first_name: 'MIKAN',
  username: 'mikan_test_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
} as unknown as UserFromGetMe;

let t: TestApp;
let pipeline: BotPipeline;
let logins = 0;

function addStaff(name: string, chatId: number | null, active = true): number {
  const now = Date.now();
  const row = t.ctx.db
    .insert(employees)
    .values({ name, login: `smm-staff-${++logins}`, passwordHash: 'x', color: '#336699', active, createdAt: now, updatedAt: now })
    .returning({ id: employees.id })
    .get();
  if (chatId !== null) {
    upsertChat(t.ctx.db, chatId, { telegramName: name });
    setChatEmployee(t.ctx.db, chatId, row.id);
  }
  return row.id;
}

function addChannel(profile: SmmProfile, opts: { tgChatId?: string | null; handle?: string | null; canPublish?: boolean } = {}): string {
  const id = randomUUID();
  const now = Date.now();
  t.ctx.db
    .insert(smmAccounts)
    .values({
      id,
      profile,
      platform: 'telegram',
      title: 'Канал',
      handle: opts.handle === undefined ? 'mikan_studio' : opts.handle,
      tgChatId: opts.tgChatId === undefined ? String(CHANNEL_ID) : opts.tgChatId,
      canPublish: opts.canPublish ?? true,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return id;
}

async function makePost(
  profile: SmmProfile,
  opts: { platform?: string; format?: string; body?: string; status?: string; topic?: string } = {},
): Promise<string> {
  const id = await insertPost(t.ctx, {
    profile,
    platform: opts.platform ?? 'telegram',
    format: opts.format ?? 'post',
    status: opts.status ?? 'review',
    publishAt: '2026-11-03T09:00:00.000Z',
    topic: opts.topic ?? 'Стерильность в студии',
  });
  await updatePost(t.ctx, id, { body: opts.body ?? 'Как мы готовим кабинет к сеансу.' });
  return id;
}

async function addPicture(postId: string, sort = 0, data = JPEG): Promise<string> {
  const url = await saveSmmFile(t.ctx, data, 'jpg');
  await insertMedia(t.ctx, { postId, kind: 'image', source: 'ai', status: 'done', url, sort });
  return url;
}

const fileOf = (url: string) => path.join(t.ctx.config.dataDir, 'uploads', path.basename(url));
const post = async (id: string): Promise<SmmPost> => (await loadPost(t.ctx, id))!;
/** «Одобрить» под превью текущей версии публикации. */
const approveData = async (id: string) => `smm:approve:${id}:${reviewTag(await post(id))}`;
const MB = 1024 * 1024;

/** Файл публикации больше 50 МБ (разреженный — на диске почти ничего не занимает). */
async function addBigVideo(postId: string, sort = 1): Promise<string> {
  const url = await saveSmmFile(t.ctx, Buffer.from([0, 0, 0, 0x18]), 'mp4');
  fs.truncateSync(fileOf(url), 51 * MB);
  await insertMedia(t.ctx, { postId, kind: 'video', source: 'upload', status: 'done', url, sort });
  return url;
}

function addInstagram(profile: SmmProfile, handle: string): void {
  const now = Date.now();
  t.ctx.db
    .insert(smmAccounts)
    .values({ id: randomUUID(), profile, platform: 'instagram', title: `@${handle}`, handle, canPublish: false, createdAt: now, updatedAt: now })
    .run();
}
const press = (chatId: number, data: string, messageId: number | null = 77) =>
  handleCallback(
    { ctx: t.ctx, pipeline },
    { from: { chatId, telegramName: 'Сотрудник', username: null }, data, message: messageId === null ? null : { messageId, isPhoto: false } },
  );

beforeEach(async () => {
  t = await createTestApp();
  pipeline = new BotPipeline(t.ctx, 0);
  t.gateway.channels.push({ info: CHANNEL, membership: { status: 'administrator', canPostMessages: true }, members: 1500 });
  vi.mocked(reviseInBackground).mockReset();
});

afterEach(async () => {
  await pipeline.idle();
  await t.close();
});

describe('publishToChannel', () => {
  it('publishes a text post as Telegram HTML and links to the channel message', async () => {
    addChannel('studio');
    const id = await makePost('studio', { body: 'Стерильность — **не слово**, а процесс <script>alert(1)</script> & уход' });

    const result = await publishToChannel(t.ctx, await post(id));

    expect(t.gateway.mediaSent).toHaveLength(0);
    expect(t.gateway.htmlSent).toEqual([
      expect.objectContaining({ chat: String(CHANNEL_ID), html: true, text: 'Стерильность — <b>не слово</b>, а процесс alert(1) &amp; уход' }),
    ]);
    expect(result).toEqual({ messageId: t.gateway.htmlSent[0]!.messageId, url: `https://t.me/mikan_studio/${t.gateway.htmlSent[0]!.messageId}` });
  });

  it('sends one picture with the post as its caption, from the file on disk', async () => {
    addChannel('studio');
    const id = await makePost('studio', { body: 'Новый эскиз недели' });
    const url = await addPicture(id);

    const result = await publishToChannel(t.ctx, await post(id));

    expect(t.gateway.htmlSent).toHaveLength(0);
    expect(t.gateway.mediaSent).toEqual([
      expect.objectContaining({ chat: String(CHANNEL_ID), caption: 'Новый эскиз недели', html: true, files: [{ kind: 'photo', source: { kind: 'file', path: fileOf(url) } }] }),
    ]);
    expect(result.messageId).toBe(t.gateway.mediaSent[0]!.messageId);
  });

  it('sends a carousel with a text longer than a caption as an album, then the text; without @name — a t.me/c link', async () => {
    addChannel('studio', { handle: null });
    const body = `Ухо мечты. ${'Хеликс, флэт и коньч. '.repeat(60)}`.trim();
    const id = await makePost('studio', { format: 'carousel', body });
    const second = await addPicture(id, 1);
    const first = await addPicture(id, 0);
    await insertMedia(t.ctx, { postId: id, kind: 'image', source: 'ai', status: 'pending', sort: 2 });

    const result = await publishToChannel(t.ctx, await post(id));

    const album = t.gateway.mediaSent[0]!;
    expect(album).toMatchObject({ chat: String(CHANNEL_ID), caption: '', html: false });
    expect(album.files.map((f) => f.source)).toEqual([
      { kind: 'file', path: fileOf(first) },
      { kind: 'file', path: fileOf(second) },
    ]);
    expect(t.gateway.htmlSent.map((s) => s.text)).toEqual([body]);
    expect(result.url).toBe(`https://t.me/c/1234567890/${album.messageId}`);
  });

  it('uses only the channel of the post profile and refuses when a file is gone or Telegram says no', async () => {
    addChannel('studio');
    const authors = await makePost('author');
    await expect(publishToChannel(t.ctx, await post(authors))).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/Канал Telegram не подключён/) });

    const id = await makePost('studio');
    const url = await addPicture(id);
    fs.rmSync(fileOf(url));
    await expect(publishToChannel(t.ctx, await post(id))).rejects.toMatchObject({ status: 502, message: expect.stringMatching(/файл не прочитался/) });

    const text = await makePost('studio');
    t.gateway.smmFailures.push(new BotSendError('Telegram: Bad Request: need administrator rights in the channel chat', false));
    await expect(publishToChannel(t.ctx, await post(text))).rejects.toMatchObject({ status: 502, message: expect.stringMatching(/need administrator rights/) });
    expect(t.gateway.htmlSent).toHaveLength(0);
  });
});

describe('checkChannel', () => {
  it('accepts a channel where the bot is an administrator with the right to post', async () => {
    expect(await checkChannel(t.ctx, 'https://t.me/mikan_studio')).toEqual({
      chatId: String(CHANNEL_ID),
      title: 'MIKAN STUDIO',
      handle: 'mikan_studio',
      canPublish: true,
      problem: null,
    });
  });

  it('explains what is wrong: not an administrator, no such channel, not a link', async () => {
    t.gateway.channels[0]!.membership = { status: 'member', canPostMessages: null };
    const check = await checkChannel(t.ctx, '@mikan_studio');
    expect(check.canPublish).toBe(false);
    expect(check.problem).toBe('Бот @mikan_test_bot не администратор канала — добавьте его в администраторы с правом публикации');
    await expect(checkChannel(t.ctx, '@unknown_channel')).rejects.toThrow(/Канал не найден/);
    await expect(checkChannel(t.ctx, 'просто текст')).rejects.toThrow(/Укажите ссылку на канал/);
    t.gateway.running = false;
    await expect(checkChannel(t.ctx, '@mikan_studio')).rejects.toThrow(/Telegram-бот не запущен/);
  });
});

describe('approvers and the publisher', () => {
  it('studio: active staff with a bot chat; author: nobody until set — profiles do not mix', async () => {
    const anna = addStaff('Анна', ANNA_CHAT);
    const boris = addStaff('Борис', BORIS_CHAT);
    const vera = addStaff('Вера', 503, false);
    const dima = addStaff('Дима', null);

    expect(await approvers(t.ctx, 'studio')).toEqual([
      { id: anna, name: 'Анна', chatId: ANNA_CHAT },
      { id: boris, name: 'Борис', chatId: BORIS_CHAT },
    ]);
    expect(await approvers(t.ctx, 'author')).toEqual([]);

    saveSmmSettings(t.ctx.db, 'author', { approverIds: [vera, boris, dima] });
    expect(await approvers(t.ctx, 'author')).toEqual([
      { id: boris, name: 'Борис', chatId: BORIS_CHAT },
      { id: dima, name: 'Дима', chatId: null },
    ]);
    expect((await approvers(t.ctx, 'studio')).map((p) => p.id)).toEqual([anna, boris]);

    const settings = getSmmSettings(t.ctx.db, 'author');
    expect(await publisherFor(t.ctx, 'author', settings, { assigneeId: null })).toMatchObject({ id: boris });
    expect(await publisherFor(t.ctx, 'author', { ...settings, publisherId: dima }, { assigneeId: null })).toMatchObject({ id: dima, chatId: null });
    expect(await publisherFor(t.ctx, 'author', settings, { assigneeId: anna })).toMatchObject({ id: anna, chatId: ANNA_CHAT });
    expect(await publisherFor(t.ctx, 'author', settings, { assigneeId: vera })).toMatchObject({ id: boris });
  });
});

describe('previews for approval and the SMM buttons', () => {
  it('sends the preview to an approver: pictures, then the text with buttons of at most 64 bytes', async () => {
    const id = await makePost('studio', { topic: 'Уход <за> проколом' });
    await addPicture(id);

    expect(await sendReviewTo(t.ctx, await post(id), ANNA_CHAT)).toBe(true);

    expect(t.gateway.mediaSent).toEqual([expect.objectContaining({ chat: ANNA_CHAT, caption: '', html: false })]);
    const preview = t.gateway.htmlSent[0]!;
    expect(preview.chat).toBe(ANNA_CHAT);
    expect(preview.text).toMatch(/^📝 На одобрение\n<b>Уход &lt;за&gt; проколом<\/b>\nTelegram · пост · вт, 3 ноя, 12:00 · маркетолог опубликует сам/);
    expect(preview.keyboard).toEqual(reviewButtons(await post(id)));
    const data = preview.keyboard!.flat().map((b) => b.data);
    expect(data).toEqual([`smm:approve:${id}:${reviewTag(await post(id))}`, `smm:remark:${id}`, `smm:skip:${id}`]);
    expect(data[0]).toMatch(/^smm:approve:[0-9a-f-]{36}:[0-9a-f]{8}$/);
    for (const d of data) expect(Buffer.byteLength(d)).toBeLessThanOrEqual(64);
  });

  it('only staff chats may press the buttons; «Одобрить» approves and closes the buttons', async () => {
    const anna = addStaff('Анна', ANNA_CHAT);
    upsertChat(t.ctx.db, CLIENT_CHAT, { telegramName: 'Клиент' });
    const id = await makePost('studio');

    expect(await press(CLIENT_CHAT, await approveData(id))).toEqual({ text: 'Только для сотрудников студии' });
    expect((await post(id)).status).toBe('review');

    expect(await press(ANNA_CHAT, await approveData(id))).toEqual({ text: 'Одобрено' });
    expect(await post(id)).toMatchObject({ status: 'approved', approvedBy: anna });
    expect(t.gateway.edits).toContainEqual({ kind: 'keyboard', chatId: ANNA_CHAT, messageId: 77, keyboard: null });
    expect(t.gateway.smmTo(ANNA_CHAT).at(-1)).toBe('✅ «Стерильность в студии» одобрено — опубликую сам вт, 3 ноя, 12:00.');
  });

  it('«Не выкладывать» skips; forged and stale buttons are refused', async () => {
    addStaff('Анна', ANNA_CHAT);
    const id = await makePost('studio');

    expect(await press(ANNA_CHAT, `smm:skip:${id}`, null)).toEqual({ text: 'Не выкладываем' });
    expect((await post(id)).status).toBe('skipped');
    expect(t.gateway.edits).toHaveLength(0);
    expect(await press(ANNA_CHAT, 'smm:approve:not-a-uuid')).toEqual({ text: 'Эта кнопка устарела' });
    expect(await press(ANNA_CHAT, `smm:delete:${id}`)).toEqual({ text: 'Эта кнопка устарела' });
    expect(await press(ANNA_CHAT, `smm:approve:${randomUUID()}`)).toEqual({ text: 'Публикация не найдена' });
  });

  it('author posts are approved only by the approvers of the author profile', async () => {
    addStaff('Анна', ANNA_CHAT);
    const boris = addStaff('Борис', BORIS_CHAT);
    saveSmmSettings(t.ctx.db, 'author', { approverIds: [boris] });
    const id = await makePost('author', { platform: 'instagram' });

    expect(await press(ANNA_CHAT, await approveData(id))).toEqual({ text: 'Одобряет сотрудник, указанный в настройках СММ' });
    expect((await post(id)).status).toBe('review');
    expect(await press(BORIS_CHAT, await approveData(id))).toEqual({ text: 'Одобрено' });
    expect(await post(id)).toMatchObject({ status: 'approved', approvedBy: boris });
    expect(t.gateway.smmTo(BORIS_CHAT).at(-1)).toMatch(/одобрено — вт, 3 ноя, 12:00 пришлю файлы и текст тому, кто выкладывает\.$/);
  });

  it('«Одобрить» under an older version does not approve the revision: the fresh preview comes instead', async () => {
    addStaff('Анна', ANNA_CHAT);
    const id = await makePost('studio');
    await sendReviewTo(t.ctx, await post(id), ANNA_CHAT);
    const stale = t.gateway.htmlSent.at(-1)!.keyboard![0]![0]!.data;
    // Another approver's remark rewrote the text after Anna got her preview.
    await updatePost(t.ctx, id, { body: 'Новая версия: короче и про уход.' });

    expect(await press(ANNA_CHAT, stale)).toEqual({ text: 'Публикация изменилась — прислал свежую версию' });

    expect((await post(id)).status).toBe('review');
    expect(t.gateway.edits).toContainEqual({ kind: 'keyboard', chatId: ANNA_CHAT, messageId: 77, keyboard: null });
    const fresh = t.gateway.htmlSent.at(-1)!;
    expect(fresh.text).toMatch(/^🔁 Публикация изменилась — вот свежая версия\n/);
    expect(fresh.text).toContain('Новая версия: короче и про уход.');
    expect(await press(ANNA_CHAT, fresh.keyboard![0]![0]!.data)).toEqual({ text: 'Одобрено' });
    expect((await post(id)).status).toBe('approved');
  });

  it('an old-format «Одобрить» (no version) is treated as stale; a version on another action is refused', async () => {
    addStaff('Анна', ANNA_CHAT);
    const id = await makePost('studio');

    expect(await press(ANNA_CHAT, `smm:approve:${id}`)).toEqual({ text: 'Публикация изменилась — прислал свежую версию' });
    expect((await post(id)).status).toBe('review');
    expect(t.gateway.htmlSent.at(-1)!.keyboard).toEqual(reviewButtons(await post(id)));

    expect(await press(ANNA_CHAT, `smm:skip:${id}:${reviewTag(await post(id))}`)).toEqual({ text: 'Эта кнопка устарела' });
    expect(await press(ANNA_CHAT, `smm:approve:${id}:XYZ`)).toEqual({ text: 'Эта кнопка устарела' });
    expect((await post(id)).status).toBe('review');
  });

  it('the version changes with what the approver sees and not with service updates', async () => {
    const id = await makePost('studio');
    const before = reviewTag(await post(id));
    await updatePost(t.ctx, id, { reviewSentAt: new Date().toISOString(), remindCount: 2 });
    expect(reviewTag(await post(id))).toBe(before);
    await addPicture(id);
    const withPicture = reviewTag(await post(id));
    expect(withPicture).not.toBe(before);
    await updatePost(t.ctx, id, { publishAt: '2026-11-04T09:00:00.000Z' });
    expect(reviewTag(await post(id))).not.toBe(withPicture);
  });
});

describe('files over 50 MB (Telegram Bot API limit)', () => {
  it('hand-off: smaller files go as documents, the big one is announced as being in the app', async () => {
    const anna = addStaff('Анна', ANNA_CHAT);
    const id = await makePost('studio', { platform: 'instagram', format: 'reel', status: 'approved' });
    const picture = await addPicture(id);
    await addBigVideo(id);

    expect(await sendHandoff(t.ctx, await post(id), { id: anna, name: 'Анна', chatId: ANNA_CHAT })).toBe(true);

    expect(t.gateway.mediaSent).toHaveLength(1);
    expect(t.gateway.mediaSent[0]!.files).toEqual([{ kind: 'document', source: { kind: 'file', path: fileOf(picture) } }]);
    const texts = t.gateway.smmTo(ANNA_CHAT);
    expect(texts.some((m) => /Файл больше 50 МБ — Telegram такие не пропускает, он есть в приложении MIKAN/.test(m))).toBe(true);
    expect(texts.at(-1)).toMatch(/^📲 Пора выложить рилс в Instagram/);
  });

  it('only a big file: nothing is uploaded, the preview says where to watch it', async () => {
    addStaff('Анна', ANNA_CHAT);
    const id = await makePost('studio', { platform: 'instagram', format: 'reel' });
    await addBigVideo(id, 0);

    expect(await sendReviewTo(t.ctx, await post(id), ANNA_CHAT)).toBe(true);

    expect(t.gateway.mediaSent).toHaveLength(0);
    expect(t.gateway.htmlSent[0]!.text).toContain('📦 Файл больше 50 МБ');
  });

  it('a channel post with a video over 50 MB is refused with a clear reason', async () => {
    addChannel('studio');
    const id = await makePost('studio');
    await addBigVideo(id, 0);

    await expect(publishToChannel(t.ctx, await post(id))).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/больше 50 МБ/) });
    expect(t.gateway.mediaSent).toHaveLength(0);
  });
});

describe('linkTarget', () => {
  it('reads the platform and the account from post, story, reel and channel links', () => {
    expect(linkTarget('https://www.instagram.com/p/DAbc123/')).toEqual({ platform: 'instagram', handle: null, chatId: null });
    expect(linkTarget('https://www.instagram.com/reel/XyZ/')).toEqual({ platform: 'instagram', handle: null, chatId: null });
    expect(linkTarget('https://www.instagram.com/Amina.Art/p/DAbc123/')).toEqual({ platform: 'instagram', handle: 'amina.art', chatId: null });
    expect(linkTarget('https://instagram.com/stories/mikan.studio/3456/')).toEqual({ platform: 'instagram', handle: 'mikan.studio', chatId: null });
    expect(linkTarget('https://t.me/mikan_studio/41')).toEqual({ platform: 'telegram', handle: 'mikan_studio', chatId: null });
    expect(linkTarget('https://t.me/c/1234567890/41')).toEqual({ platform: 'telegram', handle: null, chatId: '-1001234567890' });
    expect(linkTarget('https://vk.com/wall-1_2')).toEqual({ platform: null, handle: null, chatId: null });
  });
});

describe('staff private messages (grammY handlers)', () => {
  let bot: Bot;
  let calls: Array<{ method: string; payload: Record<string, unknown> }>;
  let updateId = 0;

  const from = (chatId: number) => ({ id: chatId, is_bot: false, first_name: 'Анна' });
  const chat = (chatId: number) => ({ id: chatId, type: 'private', first_name: 'Анна' });
  const message = (chatId: number, extra: Record<string, unknown>): Update =>
    ({ update_id: ++updateId, message: { message_id: updateId, date: 1_760_000_000, chat: chat(chatId), from: from(chatId), ...extra } }) as unknown as Update;
  const button = (chatId: number, data: string): Update =>
    ({
      update_id: ++updateId,
      callback_query: {
        id: `cq${updateId}`,
        from: from(chatId),
        chat_instance: 'ci',
        data,
        message: { message_id: 55, date: 1_760_000_000, chat: chat(chatId), text: 'превью' },
      },
    }) as unknown as Update;
  const userMessages = (chatId: number) =>
    t.ctx.db
      .select({ text: botMessages.text })
      .from(botMessages)
      .where(and(eq(botMessages.chatId, chatId), eq(botMessages.role, 'user')))
      .all()
      .map((m) => m.text);

  beforeEach(() => {
    calls = [];
    bot = new Bot('123:test', { botInfo });
    bot.api.config.use(async (_prev, method, payload) => {
      calls.push({ method, payload: payload as Record<string, unknown> });
      const result = method === 'sendMessage' ? { message_id: 1, date: 0, chat: { id: 1, type: 'private' } } : true;
      return { ok: true, result } as never;
    });
    registerHandlers(bot, { ctx: t.ctx, pipeline, downloadFile: async () => null });
  });

  it('«Поправить», then a text: the remark goes to the marketer and the new version comes back for approval', async () => {
    const anna = addStaff('Анна', ANNA_CHAT);
    const id = await makePost('studio');
    vi.mocked(reviseInBackground).mockImplementation(async (ctx, postId, _remark, _author, after) => {
      await after?.({ post: (await loadPost(ctx, postId))!, reply: 'Сделал короче и добавил про уход' });
      return true;
    });

    await bot.handleUpdate(button(ANNA_CHAT, `smm:remark:${id}`));
    expect(calls.find((c) => c.method === 'answerCallbackQuery')).toBeDefined();
    expect(await awaitedRemarkPost(t.ctx, ANNA_CHAT)).toBe(id);
    expect(t.gateway.smmTo(ANNA_CHAT)).toEqual(['✏️ Что поправить в «Стерильность в студии»? Напишите — текст, картинку, время.']);

    await bot.handleUpdate(message(ANNA_CHAT, { text: 'Сделай короче' }));

    expect(vi.mocked(reviseInBackground)).toHaveBeenCalledWith(t.ctx, id, 'Сделай короче', { id: anna, name: 'Анна' }, expect.any(Function), expect.any(Function));
    expect(await awaitedRemarkPost(t.ctx, ANNA_CHAT)).toBeNull();
    const texts = t.gateway.smmTo(ANNA_CHAT);
    expect(texts).toContain('✍️ Сделал короче и добавил про уход');
    expect(texts.some((m) => m.startsWith('🔁 Новая версия\n<b>Стерильность в студии</b>'))).toBe(true);
    expect(texts.at(-1)).toBe('Принял, переделываю — пришлю новую версию через минуту 👌');
    // Handled by SMM: the staff assistant never saw it.
    await pipeline.idle();
    expect(userMessages(ANNA_CHAT)).toEqual([]);
    expect(t.gateway.textsTo(ANNA_CHAT)).toEqual([]);
  });

  it('a voice message instead of the remark: asks for text and keeps waiting', async () => {
    addStaff('Анна', ANNA_CHAT);
    const id = await makePost('studio');
    await press(ANNA_CHAT, `smm:remark:${id}`);

    await bot.handleUpdate(message(ANNA_CHAT, { voice: { file_id: 'v', file_unique_id: 'v', duration: 3 } }));

    expect(t.gateway.smmTo(ANNA_CHAT).at(-1)).toBe('🎙 Голосовые я пока не разбираю — напишите замечание текстом, пожалуйста.');
    expect(await awaitedRemarkPost(t.ctx, ANNA_CHAT)).toBe(id);
    expect(vi.mocked(reviseInBackground)).not.toHaveBeenCalled();
  });

  it('hand-off: files as documents, «Выложил», then the link marks the post published', async () => {
    const anna = addStaff('Анна', ANNA_CHAT);
    const id = await makePost('studio', { platform: 'instagram', status: 'approved' });
    const url = await addPicture(id);

    expect(await sendHandoff(t.ctx, await post(id), { id: anna, name: 'Анна', chatId: ANNA_CHAT })).toBe(true);
    expect(t.gateway.mediaSent[0]!.files).toEqual([{ kind: 'document', source: { kind: 'file', path: fileOf(url) } }]);
    const handoff = t.gateway.htmlSent[0]!;
    expect(handoff.text).toMatch(/^📲 Пора выложить пост в Instagram\n<b>Стерильность в студии<\/b> · вт, 3 ноя, 12:00/);
    expect(handoff.keyboard).toEqual([[{ text: '✅ Выложил — пришлю ссылку', data: `smm:published:${id}` }]]);
    expect(await awaitedLinkPost(t.ctx, ANNA_CHAT)).toBe(id);

    await bot.handleUpdate(button(ANNA_CHAT, `smm:published:${id}`));
    expect(t.gateway.smmTo(ANNA_CHAT).at(-1)).toMatch(/^Супер! Пришлите ссылку на «Стерильность в студии»/);

    await bot.handleUpdate(message(ANNA_CHAT, { text: 'Готово: https://www.instagram.com/p/DAbc123/).' }));

    expect(await post(id)).toMatchObject({ status: 'published', publishedUrl: 'https://www.instagram.com/p/DAbc123/' });
    expect(await awaitedLinkPost(t.ctx, ANNA_CHAT)).toBeNull();
    expect(t.gateway.smmTo(ANNA_CHAT).at(-1)).toBe('✅ Записал: «Стерильность в студии» вышла. Ссылка уже в приложении, цифры подтяну в аналитику.');
    await pipeline.idle();
    expect(userMessages(ANNA_CHAT)).toEqual([]);
  });

  it('a link without the button finds the last hand-off of that person', async () => {
    const anna = addStaff('Анна', ANNA_CHAT);
    const other = await makePost('studio', { platform: 'instagram', status: 'approved', topic: 'Чужая передача' });
    const mine = await makePost('author', { platform: 'instagram', status: 'approved', topic: 'Моя передача' });
    await updatePost(t.ctx, other, { handoffAt: new Date().toISOString() });
    await updatePost(t.ctx, mine, { handoffAt: new Date(Date.now() - 3_600_000).toISOString(), assigneeId: anna });

    await bot.handleUpdate(message(ANNA_CHAT, { text: 'https://www.instagram.com/reel/XyZ987/' }));

    expect(await post(mine)).toMatchObject({ status: 'published', publishedUrl: 'https://www.instagram.com/reel/XyZ987/' });
    expect((await post(other)).status).toBe('approved');
  });

  it('a link from an employee nothing was handed to reaches the staff assistant and marks nothing', async () => {
    const anna = addStaff('Анна', ANNA_CHAT);
    addStaff('Борис', BORIS_CHAT);
    const annas = await makePost('studio', { platform: 'instagram', status: 'approved', topic: 'Передано Анне' });
    await updatePost(t.ctx, annas, { handoffAt: new Date().toISOString(), assigneeId: anna });

    await bot.handleUpdate(message(BORIS_CHAT, { text: 'Глянь, какой рилс у соседей https://www.instagram.com/reel/Other1/' }));
    await pipeline.idle();

    expect((await post(annas)).status).toBe('approved');
    expect(userMessages(BORIS_CHAT)).toEqual(['Глянь, какой рилс у соседей https://www.instagram.com/reel/Other1/']);
  });

  it('without a hand-off in the chat, two posts waiting for the person are not guessed: the message goes on', async () => {
    const anna = addStaff('Анна', ANNA_CHAT);
    const first = await makePost('studio', { platform: 'instagram', status: 'approved', topic: 'Первая' });
    const second = await makePost('author', { platform: 'instagram', status: 'approved', topic: 'Вторая' });
    for (const id of [first, second]) await updatePost(t.ctx, id, { handoffAt: new Date().toISOString(), assigneeId: anna });

    await bot.handleUpdate(message(ANNA_CHAT, { text: 'https://www.instagram.com/p/Unknown1/' }));
    await pipeline.idle();

    expect((await post(first)).status).toBe('approved');
    expect((await post(second)).status).toBe('approved');
    expect(userMessages(ANNA_CHAT)).toEqual(['https://www.instagram.com/p/Unknown1/']);
  });

  it('the handle in the link picks the profile: a studio link never marks the author post', async () => {
    const anna = addStaff('Анна', ANNA_CHAT);
    addInstagram('studio', 'mikan.studio');
    addInstagram('author', 'amina.art');
    const studio = await makePost('studio', { platform: 'instagram', status: 'approved', topic: 'Студийный рилс' });
    const author = await makePost('author', { platform: 'instagram', status: 'approved', topic: 'Личный пост' });
    expect(await sendHandoff(t.ctx, await post(author), { id: anna, name: 'Анна', chatId: ANNA_CHAT })).toBe(true);
    expect(await sendHandoff(t.ctx, await post(studio), { id: anna, name: 'Анна', chatId: ANNA_CHAT })).toBe(true);

    await bot.handleUpdate(message(ANNA_CHAT, { text: 'https://www.instagram.com/amina.art/p/Mine42/' }));

    expect(await post(author)).toMatchObject({ status: 'published', publishedUrl: 'https://www.instagram.com/amina.art/p/Mine42/' });
    expect((await post(studio)).status).toBe('approved');
    expect(await awaitedLinkPost(t.ctx, ANNA_CHAT)).toBe(studio);
  });

  it('the platform of the link picks the post: a t.me link goes to the Telegram hand-off', async () => {
    const anna = addStaff('Анна', ANNA_CHAT);
    const story = await makePost('studio', { platform: 'telegram', format: 'story', status: 'approved', topic: 'Сторис в канале' });
    const reel = await makePost('studio', { platform: 'instagram', format: 'reel', status: 'approved', topic: 'Рилс' });
    for (const id of [story, reel]) await sendHandoff(t.ctx, await post(id), { id: anna, name: 'Анна', chatId: ANNA_CHAT });

    await bot.handleUpdate(message(ANNA_CHAT, { text: 'https://t.me/mikan_studio/77' }));

    expect((await post(story)).status).toBe('published');
    expect((await post(reel)).status).toBe('approved');
  });

  it('two hand-offs and a link that fits both: the bot asks which one with buttons, the answer marks it', async () => {
    const anna = addStaff('Анна', ANNA_CHAT);
    const first = await makePost('studio', { platform: 'instagram', status: 'approved', topic: 'Пост про уход' });
    const second = await makePost('studio', { platform: 'instagram', format: 'carousel', status: 'approved', topic: 'Карусель эскизов' });
    for (const id of [first, second]) await sendHandoff(t.ctx, await post(id), { id: anna, name: 'Анна', chatId: ANNA_CHAT });

    await bot.handleUpdate(message(ANNA_CHAT, { text: 'Готово https://www.instagram.com/p/Both1/' }));

    expect((await post(first)).status).toBe('approved');
    expect((await post(second)).status).toBe('approved');
    const question = t.gateway.htmlSent.at(-1)!;
    expect(question.text).toBe('🔗 К какой публикации эта ссылка? Нажмите нужную.');
    const choices = question.keyboard!.map((row) => row[0]!);
    expect(choices.map((b) => b.data)).toEqual([`smm:link:${second}`, `smm:link:${first}`]);
    expect(choices[0]!.text).toMatch(/^Карусель эскизов · Instagram · /);

    expect(await press(ANNA_CHAT, `smm:link:${first}`)).toEqual({ text: 'Записал' });
    expect(await post(first)).toMatchObject({ status: 'published', publishedUrl: 'https://www.instagram.com/p/Both1/' });
    expect((await post(second)).status).toBe('approved');
    expect(await awaitedLinkPost(t.ctx, ANNA_CHAT)).toBe(second);
    expect(await press(ANNA_CHAT, `smm:link:${second}`)).toEqual({ text: 'Пришлите ссылку ещё раз' });
    await pipeline.idle();
    expect(userMessages(ANNA_CHAT)).toEqual([]);
  });

  it('«Выложил» on one of two hand-offs sends the next link straight to it', async () => {
    const anna = addStaff('Анна', ANNA_CHAT);
    const first = await makePost('studio', { platform: 'instagram', status: 'approved', topic: 'Первая' });
    const second = await makePost('studio', { platform: 'instagram', status: 'approved', topic: 'Вторая' });
    for (const id of [first, second]) await sendHandoff(t.ctx, await post(id), { id: anna, name: 'Анна', chatId: ANNA_CHAT });

    await bot.handleUpdate(button(ANNA_CHAT, `smm:published:${first}`));
    await bot.handleUpdate(message(ANNA_CHAT, { text: 'https://www.instagram.com/p/First1/' }));

    expect((await post(first)).status).toBe('published');
    expect((await post(second)).status).toBe('approved');
    expect(await awaitedLinkPost(t.ctx, ANNA_CHAT)).toBe(second);
  });

  it('reads the old single-post wait from the settings', async () => {
    addStaff('Анна', ANNA_CHAT);
    const id = await makePost('studio', { platform: 'instagram', status: 'approved' });
    writeKey(t.ctx.db, `smm_await_link:${ANNA_CHAT}`, { postId: id, until: Date.now() + 60_000 });

    await bot.handleUpdate(message(ANNA_CHAT, { text: 'https://www.instagram.com/p/Old1/' }));

    expect((await post(id)).status).toBe('published');
  });

  it('nothing SMM to handle: staff talk to the staff assistant, a client link goes to the client bot', async () => {
    addStaff('Анна', ANNA_CHAT);
    const client = await make(t, '/api/clients', { name: 'Ольга', phone: '+79990009999' });
    linkTelegram(t.ctx.db, client.id, CLIENT_CHAT, 'olga');
    const id = await makePost('studio', { platform: 'instagram', status: 'approved' });
    await updatePost(t.ctx, id, { handoffAt: new Date().toISOString() });

    await bot.handleUpdate(message(ANNA_CHAT, { text: 'Что у нас сегодня?' }));
    await bot.handleUpdate(message(CLIENT_CHAT, { text: 'Вот мой пост https://www.instagram.com/p/Client1/' }));
    await bot.handleUpdate(message(ANNA_CHAT, { voice: { file_id: 'v', file_unique_id: 'v', duration: 3 } }));
    await pipeline.idle();

    expect(userMessages(ANNA_CHAT)).toEqual(['Что у нас сегодня?', '[Голосовое сообщение]']);
    expect(userMessages(CLIENT_CHAT)).toEqual(['Вот мой пост https://www.instagram.com/p/Client1/']);
    expect((await post(id)).status).toBe('approved');
    expect(t.gateway.htmlSent).toHaveLength(0);
  });

  it('a button pressed through grammY gets its toast', async () => {
    addStaff('Анна', ANNA_CHAT);
    const id = await makePost('studio');

    await bot.handleUpdate(button(ANNA_CHAT, await approveData(id)));

    expect(calls.find((c) => c.method === 'answerCallbackQuery')?.payload).toMatchObject({ text: 'Одобрено' });
    expect(t.gateway.edits).toContainEqual({ kind: 'keyboard', chatId: ANNA_CHAT, messageId: 55, keyboard: null });
  });
});
