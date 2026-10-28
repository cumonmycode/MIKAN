import { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BotUnavailableError } from '../src/bot/gateway.js';
import { mainKeyboard, registerHandlers } from '../src/bot/handlers.js';
import { BotController } from '../src/bot/index.js';
import { STAFF_KEYBOARD } from '../src/bot/keyboards.js';
import { BotPipeline } from '../src/bot/pipeline.js';
import { issueStaffCode } from '../src/bot/staff.js';
import { linkTelegram } from '../src/domain/clients.js';
import { setCachedBotUsername } from '../src/domain/settings.js';
import { createTestApp, make, message, ScriptedAi, text, type TestApp } from './helpers.js';

const USER = 9_001;
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

interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}

describe('grammY handlers (no network)', () => {
  let t: TestApp;
  let bot: Bot;
  let calls: ApiCall[];
  let pipeline: BotPipeline;
  let ai: ScriptedAi;
  let updateId = 0;

  const privateMsg = (extra: Record<string, unknown>): Update =>
    ({
      update_id: ++updateId,
      message: {
        message_id: updateId,
        date: 1_760_000_000,
        chat: { id: USER, type: 'private', first_name: 'Ольга' },
        from: { id: USER, is_bot: false, first_name: 'Ольга', last_name: 'Ли', username: 'olga' },
        ...extra,
      },
    }) as unknown as Update;
  const command = (body: string, chat: Record<string, unknown> = { id: USER, type: 'private', first_name: 'Ольга' }) =>
    ({
      ...privateMsg({ text: body, entities: [{ type: 'bot_command', offset: 0, length: body.split(' ')[0]!.length }] }),
      message: {
        ...(privateMsg({}) as { message: object }).message,
        chat,
        text: body,
        entities: [{ type: 'bot_command', offset: 0, length: body.split(' ')[0]!.length }],
      },
    }) as unknown as Update;
  const replies = () => calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload);
  /** The chat belongs to a client already (it shared the phone earlier), so the bot talks to it. */
  const linkChat = async () => {
    const client = await make(t, '/api/clients', { name: 'Ольга', phone: '+79990009999' });
    linkTelegram(t.ctx.db, client.id, USER, 'olga');
  };
  const keyboardOf = (reply: Record<string, unknown>) =>
    (reply.reply_markup as { keyboard: Array<Array<{ text: string; request_contact?: boolean }>> }).keyboard;

  beforeEach(async () => {
    ai = new ScriptedAi();
    t = await createTestApp({ ai });
    pipeline = new BotPipeline(t.ctx, 0);
    calls = [];
    bot = new Bot('123:test', { botInfo });
    bot.api.config.use(async (_prev, method, payload) => {
      calls.push({ method, payload: payload as Record<string, unknown> });
      const result = method === 'sendMessage' ? { message_id: 1, date: 0, chat: { id: USER, type: 'private' } } : true;
      return { ok: true, result } as never;
    });
    registerHandlers(bot, { ctx: t.ctx, pipeline, downloadFile: async () => Buffer.from('jpegbytes') });
  });
  afterEach(async () => {
    await t.close();
  });

  it('answers /start of a new chat with the greeting and only the button that shares the phone', async () => {
    await bot.handleUpdate(command('/start'));
    const [reply] = replies();
    expect(reply!.text).toMatch(/^Здравствуйте!/);
    expect(reply!.text).toMatch(/Чтобы начать, нажмите «📱 Поделиться номером» внизу 👇/);
    expect(reply!.reply_markup).toMatchObject({ resize_keyboard: true, is_persistent: true });
    expect(keyboardOf(reply!)).toEqual([[{ text: '📱 Поделиться номером', request_contact: true }]]);
    expect(mainKeyboard(true).build().flat().map((b) => b.text)).toEqual(['💉 Услуги и цены', '💎 Украшения', '📅 Записаться', '🩹 Уход после процедуры', '👤 Мои записи и бонусы']);
  });

  it('nothing works until a new chat shares its phone; then the earlier question gets its answer', async () => {
    ai.push(message([text('Мочка — 1 600 ₽ 🙂')]));
    await bot.handleUpdate(privateMsg({ text: 'Сколько стоит прокол мочки?' }));
    await bot.handleUpdate(privateMsg({ text: '💎 Украшения' }));
    await bot.handleUpdate(privateMsg({ voice: { file_id: 'v', file_unique_id: 'v', duration: 3 } }));
    await pipeline.idle();
    expect(ai.calls).toHaveLength(0);
    const asked = t.gateway.sent.filter((m) => m.chatId === USER);
    expect(asked.map((m) => m.text)).toEqual(Array(3).fill('Чтобы я мог помочь, нажмите «📱 Поделиться номером» внизу 👇 Это нужно сделать один раз.'));
    expect(asked[0]!.replyKeyboard).toEqual([[{ text: '📱 Поделиться номером', requestContact: true }]]);
    expect(calls.some((c) => c.method === 'sendPhoto')).toBe(false);

    await bot.handleUpdate(privateMsg({ contact: { phone_number: '79990001122', first_name: 'Ольга', last_name: 'Ли', user_id: USER } }));
    await pipeline.idle();
    expect(replies().map((r) => r.text)).toEqual(['Спасибо, Ольга! Номер сохранён ✅ Чем могу помочь?']);
    expect(keyboardOf(replies()[0]!).flat().map((b) => b.text)).toContain('💎 Украшения');
    // The answer (the birthday question follows it, see bot-birthday.test.ts).
    expect(t.gateway.textsTo(USER)).toContain('Мочка — 1 600 ₽ 🙂');
    // The AI saw the question asked before the phone.
    expect(JSON.stringify(ai.calls[0]!.messages)).toContain('Сколько стоит прокол мочки?');
    const client = (await t.api('GET', '/api/clients?search=79990001122')).json().items[0];
    expect(client).toMatchObject({ name: 'Ольга', lastName: 'Ли', phone: '+79990001122', telegramLinked: true });
  });

  it('a shared phone that is already in the base links that client to the chat', async () => {
    const existing = await make(t, '/api/clients', { name: 'Ирина', phone: '+79990007777' });
    await bot.handleUpdate(privateMsg({ contact: { phone_number: '+7 999 000-77-77', first_name: 'Ира', user_id: USER } }));
    expect(replies()[0]!.text).toMatch(/^Спасибо, Ирина! Номер подтверждён ✅/);
    expect((await t.api('GET', `/api/clients/${existing.id}`)).json()).toMatchObject({ name: 'Ирина', telegramLinked: true });
    expect((await t.api('GET', '/api/clients?search=Ира')).json().items.filter((c: { name: string }) => c.name === 'Ира')).toHaveLength(0);
  });

  it('inline buttons of a chat without the phone ask for it too', async () => {
    await bot.handleUpdate({
      update_id: ++updateId,
      callback_query: {
        id: 'cb', chat_instance: 'ci', data: 'jc:0',
        from: { id: USER, is_bot: false, first_name: 'Ольга' },
        message: { message_id: 5, date: 1_760_000_000, chat: { id: USER, type: 'private', first_name: 'Ольга' }, text: 'Каталог' },
      },
    } as unknown as Update);
    expect(calls.find((c) => c.method === 'answerCallbackQuery')!.payload).toMatchObject({ text: 'Сначала поделитесь номером — кнопка внизу 👇' });
    expect(replies()[0]!.text).toMatch(/^Чтобы я мог помочь/);
  });

  it('links the chat from a deep-link payload and from a shared contact', async () => {
    const client = await make(t, '/api/clients', { name: 'Иван', phone: '+79990000106' });
    const url = (await t.api('POST', `/api/clients/${client.id}/telegram-link`)).json().url as string;
    await bot.handleUpdate(command(`/start ${new URL(url).searchParams.get('start')}`));
    expect(replies()[0]!.text).toMatch(/^Иван, ваш Telegram подключён/);
    expect((await t.api('GET', `/api/clients/${client.id}`)).json().telegramLinked).toBe(true);

    await bot.handleUpdate(privateMsg({ contact: { phone_number: '+79990001122', first_name: 'Ольга', user_id: USER } }));
    expect(replies()[1]!.text).toBe('Спасибо, Ольга! Номер сохранён ✅ Чем могу помочь?');
  });

  it('binds the staff chat with /staff in a group', async () => {
    const { code } = issueStaffCode(t.ctx.db);
    await bot.handleUpdate(command(`/staff ${code}`, { id: -100123, type: 'supergroup', title: 'Команда' }));
    expect(replies()[0]!.text).toMatch(/^✅ Этот чат подключён/);
    expect((await t.api('GET', '/api/settings/bot')).json().staffChatBound).toBe(true);
  });

  it('routes text, photos, image documents, other files, stickers and voice into the pipeline', async () => {
    await linkChat();
    ai.push(message([text('Ответ 1')]), message([text('Ответ 2')]), message([text('Ответ 3')]), message([text('Ответ 4')]), message([text('😊')]));
    await bot.handleUpdate(privateMsg({ text: 'Привет' }));
    await pipeline.idle();
    await bot.handleUpdate(privateMsg({ photo: [{ file_id: 'small', file_unique_id: 's', width: 90, height: 90, file_size: 1000 }, { file_id: 'big', file_unique_id: 'b', width: 900, height: 900, file_size: 9_000_000 }], caption: 'заживает?' }));
    await pipeline.idle();
    await bot.handleUpdate(privateMsg({ document: { file_id: 'doc', file_unique_id: 'd', mime_type: 'image/png', file_size: 2000, file_name: 'x.png' } }));
    await pipeline.idle();
    await bot.handleUpdate(privateMsg({ document: { file_id: 'pdf', file_unique_id: 'p', mime_type: 'application/pdf', file_name: 'эскиз.pdf' }, caption: 'вот' }));
    await pipeline.idle();
    await bot.handleUpdate(privateMsg({ sticker: { file_id: 'st', file_unique_id: 'st', type: 'regular', width: 1, height: 1, is_animated: false, is_video: false, emoji: '😊' } }));
    await pipeline.idle();
    await bot.handleUpdate(privateMsg({ voice: { file_id: 'v', file_unique_id: 'v', duration: 3 } }));
    await pipeline.idle();

    const texts = (await t.api('GET', `/api/bot/chats/${USER}/messages`)).json().items.map((m: { role: string; text: string }) => `${m.role}:${m.text}`);
    expect(texts).toEqual([
      'user:Привет',
      'assistant:Ответ 1',
      'user:[Фото] заживает?',
      'assistant:Ответ 2',
      'user:[Фото]',
      'assistant:Ответ 3',
      'user:[Файл «эскиз.pdf»] вот',
      'assistant:Ответ 4',
      'user:[Стикер 😊]',
      'assistant:😊',
      'user:[Голосовое сообщение]',
      expect.stringMatching(/^assistant:Голосовые и видео/),
    ]);
    const photoTurn = ai.calls[1]!.messages.at(-1)!.content as Array<{ type: string; source?: { media_type: string; data: string } }>;
    expect(photoTurn[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: Buffer.from('jpegbytes').toString('base64') } });
    const pngTurn = ai.calls[2]!.messages.at(-1)!.content as Array<{ type: string; source?: { media_type: string } }>;
    expect(pngTurn[0]!.source!.media_type).toBe('image/png');
    expect(calls.some((c) => c.method === 'sendChatAction')).toBe(false); // typing goes through the gateway, not this bot
    expect((await t.api('GET', '/api/bot/chats')).json().items[0]).toMatchObject({ telegramName: 'Ольга Ли', username: 'olga' });
  });

  it('does not block update handling while a photo downloads (#3)', async () => {
    await linkChat();
    let release!: (b: Buffer) => void;
    const slow = new Promise<Buffer>((resolve) => (release = resolve));
    const slowBot = new Bot('123:test', { botInfo });
    slowBot.api.config.use(async () => ({ ok: true, result: { message_id: 1, date: 0, chat: { id: USER, type: 'private' } } }) as never);
    registerHandlers(slowBot, { ctx: t.ctx, pipeline, downloadFile: () => slow });
    ai.push(message([text('Вижу фото')]));

    const handled = await Promise.race([
      slowBot.handleUpdate(privateMsg({ photo: [{ file_id: 'p', file_unique_id: 'p', width: 9, height: 9, file_size: 10 }] })).then(() => 'handled'),
      new Promise((r) => setTimeout(() => r('blocked'), 200)),
    ]);
    expect(handled).toBe('handled');
    expect(ai.calls).toHaveLength(0); // the AI call waits for the download, the update loop does not

    release(Buffer.from('late-image'));
    await pipeline.idle();
    const content = ai.calls[0]!.messages.at(-1)!.content as Array<{ type: string; source?: { data: string } }>;
    expect(content[0]!.source!.data).toBe(Buffer.from('late-image').toString('base64'));
  });

  it('opens catalogs from the keyboard buttons and /catalog without the AI, and answers inline button presses', async () => {
    await linkChat();
    const helix = await make(t, '/api/services', { name: 'Хеликс', category: 'piercing', price: 3000, durationMin: 30 });
    await make(t, '/api/products', { kind: 'jewelry', name: 'Лабрет', price: 1500, serviceIds: [helix.id], variants: [{ name: '6 мм', initialQuantity: 2 }] });

    await bot.handleUpdate(privateMsg({ text: '💎 Украшения' }));
    await bot.handleUpdate(command('/catalog'));
    await bot.handleUpdate(privateMsg({ text: '💉 Услуги и цены' }));
    await pipeline.idle();
    expect(ai.calls).toHaveLength(0);
    const menus = t.gateway.sent.filter((s) => s.chatId === USER);
    expect(menus.map((m) => m.text)).toEqual([
      expect.stringMatching(/^💎 Украшения в наличии/),
      expect.stringMatching(/^💎 Украшения в наличии/),
      expect.stringMatching(/^💉 Услуги и цены/),
    ]);
    expect(menus[0]!.keyboard!.flat().map((b) => b.text)).toEqual(['Все украшения', '💉 Услуги и цены']);
    const texts = (await t.api('GET', `/api/bot/chats/${USER}/messages`)).json().items.map((m: { role: string; text: string }) => `${m.role}:${m.text}`);
    expect(texts.slice(0, 2)).toEqual(['user:💎 Украшения', expect.stringMatching(/^assistant:\[Каталог\] 💎 Украшения в наличии/)]);

    const open = menus[0]!.keyboard![0]![0]!.data;
    await bot.handleUpdate({
      update_id: ++updateId,
      callback_query: {
        id: 'cb1',
        from: { id: USER, is_bot: false, first_name: 'Ольга' },
        chat_instance: 'ci',
        data: open,
        message: { message_id: menus[0]!.messageId, date: 0, chat: { id: USER, type: 'private', first_name: 'Ольга' }, text: menus[0]!.text },
      },
    } as unknown as Update);
    expect(t.gateway.sent.at(-1)!.text).toContain('Лабрет'); // no photo → a text card with buttons
    expect(calls.filter((c) => c.method === 'answerCallbackQuery').map((c) => c.payload)).toEqual([{ callback_query_id: 'cb1' }]);

    // A button under a message Telegram no longer shows to the bot (inaccessible, date 0) answers with a new message.
    const card = t.gateway.sent.at(-1)!;
    const all = card.keyboard!.flat().find((b) => b.text === '📂 Все украшения')!.data;
    const sentBefore = t.gateway.sent.length;
    await bot.handleUpdate({
      update_id: ++updateId,
      callback_query: {
        id: 'cb2',
        from: { id: USER, is_bot: false, first_name: 'Ольга' },
        chat_instance: 'ci',
        data: all,
        message: { message_id: card.messageId, date: 0, chat: { id: USER, type: 'private', first_name: 'Ольга' } },
      },
    } as unknown as Update);
    expect(t.gateway.sent).toHaveLength(sentBefore + 1);
    expect(t.gateway.sent.at(-1)!.text).toMatch(/^💎 Украшения в наличии/);
    expect(t.gateway.edits.filter((e) => e.messageId === card.messageId)).toEqual([]);
  });

  it('shows the staff keyboard to a recognised employee', async () => {
    await make(t, '/api/employees', { name: 'Анна', login: 'anna', password: 'secret123', phone: '8 (999) 000-11-22' });
    // Telegram usually sends the number without «+».
    await bot.handleUpdate(privateMsg({ contact: { phone_number: '79990001122', first_name: 'Анна', user_id: USER } }));
    const reply = replies().at(-1)!;
    expect(reply.text).toMatch(/^Здравствуйте, Анна! Узнал вас/);
    const keyboard = (reply.reply_markup as { keyboard: Array<Array<{ text: string }>> }).keyboard;
    expect(keyboard.flat().map((b) => b.text)).toEqual(['📋 Что сегодня', '📊 Выручка за неделю', '📦 Что заканчивается', '💎 Украшения']);
  });

  it('ignores private-only handlers in groups', async () => {
    await bot.handleUpdate({
      update_id: 999,
      message: { message_id: 1, date: 0, chat: { id: -5, type: 'group', title: 'G' }, from: { id: USER, is_bot: false, first_name: 'A' }, text: 'привет' },
    } as unknown as Update);
    await pipeline.idle();
    expect((await t.api('GET', '/api/bot/chats')).json().items).toHaveLength(0);
  });
});

describe('BotController polling lifecycle (#9)', () => {
  it('never runs two polling loops when the bot is toggled off and on quickly', async () => {
    const t = await createTestApp({ env: { BOT_ENABLED: 'true', TELEGRAM_BOT_TOKEN: '123:fake' } });
    let running = 0;
    let maxRunning = 0;
    let created = 0;
    const factory = () => {
      created += 1;
      let finish: (() => void) | null = null;
      let isRunning = false;
      return {
        botInfo,
        isInited: () => true,
        isRunning: () => isRunning,
        init: async () => undefined,
        start: async (opts: { onStart?: (info: UserFromGetMe) => void }) => {
          isRunning = true;
          running += 1;
          maxRunning = Math.max(maxRunning, running);
          opts.onStart?.(botInfo);
          await new Promise<void>((resolve) => (finish = resolve));
          running -= 1;
          isRunning = false;
        },
        // Like grammY: stop() resolves only after one last in-flight getUpdates returns.
        stop: async () => {
          await new Promise((r) => setTimeout(r, 50));
          finish?.();
        },
      } as unknown as Bot;
    };
    const controller = new BotController(t.ctx, { botFactory: factory, debounceMs: 0 });
    const setEnabled = async (enabled: boolean) => {
      await t.api('PUT', '/api/settings/bot', { enabled });
      controller.refresh();
    };
    controller.refresh();
    await new Promise((r) => setTimeout(r, 10));
    expect(controller.isRunning()).toBe(true);
    expect(controller.username()).toBe('mikan_test_bot');

    await setEnabled(false);
    await setEnabled(true); // re-enabled while the old loop is still unwinding
    await new Promise((r) => setTimeout(r, 150));
    expect(maxRunning).toBe(1);
    expect(created).toBe(2);
    expect(controller.isRunning()).toBe(true);

    await controller.stop();
    expect(controller.isRunning()).toBe(false);
    expect(running).toBe(0);
    await t.close();
  });
});

describe('BotController sending', () => {
  it('sends a keyboard under the input field with the last chunk; inline buttons (callback or link) win over it', async () => {
    const t = await createTestApp({ env: { BOT_ENABLED: 'true', TELEGRAM_BOT_TOKEN: '123:fake' } });
    const sent: Array<Record<string, unknown>> = [];
    let finish: (() => void) | null = null;
    const factory = () =>
      ({
        botInfo,
        isInited: () => true,
        isRunning: () => finish !== null,
        init: async () => undefined,
        start: async (opts: { onStart?: (info: UserFromGetMe) => void }) => {
          opts.onStart?.(botInfo);
          await new Promise<void>((resolve) => (finish = resolve));
        },
        stop: async () => finish?.(),
        api: {
          sendMessage: async (_chatId: number, _text: string, other: Record<string, unknown>) => {
            sent.push(other);
            return { message_id: sent.length };
          },
        },
      }) as unknown as Bot;
    const controller = new BotController(t.ctx, { botFactory: factory, debounceMs: 0 });
    controller.refresh();
    await new Promise((r) => setTimeout(r, 10));

    await controller.sendText(USER, 'Привет', { replyKeyboard: STAFF_KEYBOARD });
    await controller.sendText(USER, 'Меню', { keyboard: [[{ text: 'Все', data: 'x' }]], replyKeyboard: STAFF_KEYBOARD });
    expect(sent[0]!.reply_markup).toMatchObject({
      keyboard: [[{ text: '📋 Что сегодня' }, { text: '📊 Выручка за неделю' }], [{ text: '📦 Что заканчивается' }, { text: '💎 Украшения' }]],
      resize_keyboard: true,
      is_persistent: true,
    });
    expect(sent[1]!.reply_markup).toEqual({ inline_keyboard: [[{ text: 'Все', callback_data: 'x' }]] });
    // Link buttons (review links) open the URL; callback buttons next to them keep their payload.
    await controller.sendText(USER, 'Отзыв', { keyboard: [[{ text: '⭐ Google', url: 'https://g.page/mikan' }], [{ text: 'Все', data: 'x' }]] });
    expect(sent[2]!.reply_markup).toEqual({
      inline_keyboard: [[{ text: '⭐ Google', url: 'https://g.page/mikan' }], [{ text: 'Все', callback_data: 'x' }]],
    });

    await controller.stop();
    await t.close();
  });
});

describe('BotController when Telegram is disabled', () => {
  it('stays offline, reports the cached username and refuses to send', async () => {
    const t = await createTestApp();
    const controller = new BotController(t.ctx);
    controller.refresh();
    expect(controller.isRunning()).toBe(false);
    expect(controller.username()).toBeNull();
    setCachedBotUsername(t.ctx.db, 'mikan_cached_bot');
    expect(controller.username()).toBe('mikan_cached_bot');
    await expect(controller.sendText(1, 'x')).rejects.toBeInstanceOf(BotUnavailableError);
    await expect(controller.sendPhoto(1, { kind: 'url', url: 'https://x' }, 'c')).rejects.toBeInstanceOf(BotUnavailableError);
    await controller.sendTyping(1);
    await controller.stop();
    await t.close();
  });
});
