import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerHandlers } from '../src/bot/handlers.js';
import { BotPipeline } from '../src/bot/pipeline.js';
import { botMessages } from '../src/db/schema.js';
import { storeMessage } from '../src/domain/bot-chats.js';
import { keepChatPhoto, MAX_CHAT_PHOTOS_PER_DAY } from '../src/domain/chat-photos.js';
import { linkTelegram } from '../src/domain/clients.js';
import { DAY_MS } from '../src/lib/time.js';
import { createTestApp, make, message, ScriptedAi, text, type TestApp } from './helpers.js';

const USER = 9_001;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
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

const PHOTO = { photo: [{ file_id: 'p', file_unique_id: 'p', width: 900, height: 900, file_size: 1000 }] };

interface StoredMessage {
  role: string;
  text: string;
  photoFile: string | null;
}

describe('client photos kept for staff', () => {
  let t: TestApp;
  let ai: ScriptedAi;
  let pipeline: BotPipeline;
  let downloaded: () => Promise<Buffer>;
  let bot: Bot;
  let updateId = 0;

  const send = async (extra: Record<string, unknown>) => {
    await bot.handleUpdate({
      update_id: ++updateId,
      message: {
        message_id: updateId,
        date: 1_760_000_000,
        chat: { id: USER, type: 'private', first_name: 'Ольга' },
        from: { id: USER, is_bot: false, first_name: 'Ольга' },
        ...extra,
      },
    } as unknown as Update);
    await pipeline.idle();
  };
  const linkChat = async () => {
    const client = await make(t, '/api/clients', { name: 'Ольга', phone: '+79990009999' });
    linkTelegram(t.ctx.db, client.id, USER, 'olga');
  };
  const incoming = async (): Promise<StoredMessage[]> =>
    (await t.api('GET', `/api/bot/chats/${USER}/messages`)).json().items.filter((m: StoredMessage) => m.role === 'user');

  beforeEach(async () => {
    ai = new ScriptedAi();
    t = await createTestApp({ ai });
    pipeline = new BotPipeline(t.ctx, 0);
    downloaded = async () => JPEG;
    bot = new Bot('123:test', { botInfo });
    bot.api.config.use(async () => ({ ok: true, result: { message_id: 1, date: 0, chat: { id: USER, type: 'private' } } }) as never);
    registerHandlers(bot, { ctx: t.ctx, pipeline, downloadFile: () => downloaded() });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await t.close();
  });

  it('shows staff the picture a client sent, keeping the caption in the text', async () => {
    await linkChat();
    ai.push(message([text('Вижу')]));

    await send({ ...PHOTO, caption: 'он прям будто впивается' });

    const [photo] = await incoming();
    expect(photo!.text).toBe('[Фото] он прям будто впивается');
    expect(photo!.photoFile).toMatch(/^[0-9a-f-]{36}\.jpg$/);
    const res = await t.api('GET', `/api/bot/photos/${photo!.photoFile}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.rawPayload.equals(JPEG)).toBe(true);
    expect(res.headers['cache-control']).toBe('private, no-store'); // no copy left on the employee's phone
  });

  it('still hands the picture to the AI', async () => {
    await linkChat();
    ai.push(message([text('Вижу')]));

    await send(PHOTO);

    const content = ai.calls[0]!.messages.at(-1)!.content as Array<{ type: string; source?: { data: string } }>;
    expect(content[0]!.source!.data).toBe(JPEG.toString('base64'));
  });

  it('gives the picture only to a signed-in employee and never through the public uploads', async () => {
    await linkChat();
    ai.push(message([text('Вижу')]));

    await send(PHOTO);

    const [photo] = await incoming();
    const anonymous = await t.app.inject({ method: 'GET', url: `/api/bot/photos/${photo!.photoFile}` });
    expect(anonymous.statusCode).toBe(401);
    const publicLink = await t.app.inject({ method: 'GET', url: `/uploads/${photo!.photoFile}` });
    expect(publicLink.statusCode).toBe(404);
    expect(fs.existsSync(path.join(t.ctx.config.dataDir, 'uploads', photo!.photoFile!))).toBe(false);
  });

  it('keeps an image sent as a file under its real type', async () => {
    await linkChat();
    ai.push(message([text('Вижу')]));
    downloaded = async () => PNG;

    await send({ document: { file_id: 'd', file_unique_id: 'd', mime_type: 'image/png', file_size: 2000, file_name: 'x.png' } });

    const [photo] = await incoming();
    expect(photo!.photoFile).toMatch(/\.png$/);
    expect((await t.api('GET', `/api/bot/photos/${photo!.photoFile}`)).headers['content-type']).toBe('image/png');
  });

  it('keeps the photo of a chat that has not shared its phone yet', async () => {
    await send({ ...PHOTO, caption: 'можно так?' });

    const [photo] = await incoming();
    expect(photo!.text).toBe('[Фото] можно так?');
    expect(photo!.photoFile).toMatch(/\.jpg$/);
    expect(ai.calls).toHaveLength(0);
  });

  it('labels an image sent as a file by a chat without a phone as a photo', async () => {
    await send({ document: { file_id: 'd', file_unique_id: 'd', mime_type: 'image/jpeg', file_size: 20, file_name: 'x.jpg' }, caption: 'вот' });

    const [photo] = await incoming();
    expect(photo!.text).toBe('[Фото] вот');
    expect(photo!.photoFile).toMatch(/\.jpg$/);
  });

  it('stops keeping the photos of a chat over the daily limit, other chats and later days are not affected', async () => {
    const keep = async (chatId: number) => {
      const stored = storeMessage(t.ctx.db, chatId, 'user', '[Фото]');
      return { id: stored.id, notKept: await keepChatPhoto(t.ctx.db, t.ctx.config.dataDir, stored, JPEG) };
    };
    for (let i = 0; i < MAX_CHAT_PHOTOS_PER_DAY; i++) expect((await keep(USER)).notKept).toBeNull();

    const refused = await keep(USER);
    expect(refused.notKept).toBe('over_limit');
    const row = t.ctx.db.select().from(botMessages).where(eq(botMessages.id, refused.id)).get();
    expect(row!.photoFile).toBeNull();
    expect((await keep(USER + 1)).notKept).toBeNull();

    t.ctx.db.update(botMessages).set({ createdAt: Date.now() - DAY_MS - 1 }).where(eq(botMessages.chatId, USER)).run();
    expect((await keep(USER)).notKept).toBeNull();
  });

  it('stores nothing when the disk is nearly full', async () => {
    vi.spyOn(fsPromises, 'statfs').mockResolvedValue({ bavail: 1024, bsize: 4096 } as Awaited<ReturnType<typeof fsPromises.statfs>>);
    const stored = storeMessage(t.ctx.db, USER, 'user', '[Фото]');

    expect(await keepChatPhoto(t.ctx.db, t.ctx.config.dataDir, stored, JPEG)).toBe('no_space');

    expect(fs.readdirSync(path.join(t.ctx.config.dataDir, 'chat-photos'))).toEqual([]);
    expect(t.ctx.db.select().from(botMessages).where(eq(botMessages.id, stored.id)).get()!.photoFile).toBeNull();
  });

  it('does not keep bytes that are not a picture', async () => {
    await linkChat();
    ai.push(message([text('Ок')]));
    downloaded = async () => Buffer.from('<script>alert(1)</script>');

    await send({ document: { file_id: 'd', file_unique_id: 'd', mime_type: 'image/jpeg', file_size: 20, file_name: 'x.jpg' } });

    const [photo] = await incoming();
    expect(photo!.text).toBe('[Фото]');
    expect(photo!.photoFile).toBeNull();
  });

  it('leaves the label alone when the download fails', async () => {
    await linkChat();
    ai.push(message([text('Ок')]));
    downloaded = async () => {
      throw new Error('Telegram недоступен');
    };

    await send(PHOTO);

    const [photo] = await incoming();
    expect(photo!.text).toBe('[Фото]');
    expect(photo!.photoFile).toBeNull();
  });

  it('has no picture on an ordinary message', async () => {
    await linkChat();
    ai.push(message([text('Здравствуйте')]));

    await send({ text: 'Привет' });

    expect((await incoming())[0]!.photoFile).toBeNull();
  });

  it('answers 404 for names outside the photos folder', async () => {
    fs.writeFileSync(path.join(t.ctx.config.dataDir, 'secret.jpg'), JPEG);
    for (const name of ['..%2Fsecret.jpg', 'secret.jpg', '00000000-0000-0000-0000-000000000000.jpg']) {
      expect((await t.api('GET', `/api/bot/photos/${name}`)).statusCode).toBe(404);
    }
  });
});
