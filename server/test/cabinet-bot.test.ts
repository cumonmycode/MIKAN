import { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cabinetMessage, CABINET_LINK_TOOL } from '../src/bot/cabinet.js';
import { registerHandlers } from '../src/bot/handlers.js';
import { BotPipeline } from '../src/bot/pipeline.js';
import { buildStablePrompt } from '../src/bot/prompt.js';
import { buildToolHandlers, emptySink, TOOLS } from '../src/bot/tools.js';
import { clientAccessTokens } from '../src/db/schema.js';
import { linkTelegram } from '../src/domain/clients.js';
import { createTestApp, make, message, ScriptedAi, text, toolUse, type TestApp } from './helpers.js';
import { cab } from './cabinet-fixtures.js';
import { NOW, PUBLIC_URL, type Json } from './online-booking-fixtures.js';

const USER = 9_101;
const botInfo = {
  id: 1, is_bot: true, first_name: 'MIKAN', username: 'mikan_test_bot', can_join_groups: true,
  can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false,
} as unknown as UserFromGetMe;

const CABINET_TEXT =
  '👤 Личный кабинет MIKAN STUDIO: ваши записи (можно перенести или отменить), бонусы, памятки по уходу и сертификаты.\n\n' +
  '«🌐 Открыть в браузере» — вход на сайте без Telegram: ссылка действует 30 дней, не пересылайте её никому.';

describe('bot: «👤 Мои записи и бонусы»', () => {
  let t: TestApp;
  let ai: ScriptedAi;
  let bot: Bot;
  let pipeline: BotPipeline;
  let calls: Array<{ method: string; payload: Record<string, unknown> }>;
  let updateId = 0;
  let olga: Json;

  const chat = { id: USER, type: 'private', first_name: 'Ольга' };
  const textMessage = (body: string, entities?: unknown[]): Update =>
    ({
      update_id: ++updateId,
      message: { message_id: updateId, date: 1_760_000_000, chat, from: { id: USER, is_bot: false, first_name: 'Ольга' }, text: body, ...(entities ? { entities } : {}) },
    }) as unknown as Update;
  const command = (body: string) => textMessage(body, [{ type: 'bot_command', offset: 0, length: body.split(' ')[0]!.length }]);
  const linkOlga = () => linkTelegram(t.ctx.db, olga.id, USER, 'olga');
  const sentTo = () => t.gateway.sent.filter((s) => s.chatId === USER);
  /** The website sign-in link of the last cabinet message. */
  const signInLink = () => new URL(sentTo().at(-1)!.keyboard!.flat().find((b) => b.text === '🌐 Открыть в браузере')!.url!);

  async function setUp(env: Record<string, string> = { PUBLIC_URL }) {
    ai = new ScriptedAi();
    t = await createTestApp({ ai, env });
    pipeline = new BotPipeline(t.ctx, 0);
    calls = [];
    bot = new Bot('123:test', { botInfo });
    bot.api.config.use(async (_prev, method, payload) => {
      calls.push({ method, payload: payload as Record<string, unknown> });
      const result = method === 'sendMessage' ? { message_id: 1, date: 0, chat: { id: USER, type: 'private' } } : true;
      return { ok: true, result } as never;
    });
    registerHandlers(bot, { ctx: t.ctx, pipeline, downloadFile: async () => null });
    olga = await make(t, '/api/clients', { name: 'Ольга', phone: '+79990009999' });
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(async () => {
    vi.useRealTimers();
    await t.close();
  });

  it('/me and the keyboard button send the Mini App and the website sign-in buttons, without the AI', async () => {
    await setUp();
    linkOlga();
    await bot.handleUpdate(command('/me'));
    await bot.handleUpdate(textMessage('👤 Мои записи и бонусы'));
    await pipeline.idle();
    expect(ai.calls).toHaveLength(0);
    const [first, second] = sentTo();
    expect(first!.text).toBe(CABINET_TEXT);
    expect(first!.keyboard).toEqual([
      [{ text: '👤 Открыть кабинет', webApp: 'https://mikan.example/book/me' }],
      [{ text: '🌐 Открыть в браузере', url: expect.stringMatching(/^https:\/\/mikan\.example\/book\/me#t=[A-Za-z0-9_-]{43}$/) }],
    ]);
    // A new link each time; each signs in as Olga.
    // The token is in the fragment, so it never reaches request logs.
    const links = [first, second].map((m) => new URLSearchParams(new URL(m!.keyboard![1]![0]!.url!).hash.slice(1)).get('t')!);
    expect(new Set(links).size).toBe(2);
    for (const token of links) expect((await cab(t, 'GET', '', undefined, { token })).json().client.name).toBe('Ольга');
    // The chat history keeps the request and the text, never the link.
    const history = (await t.api('GET', `/api/bot/chats/${USER}/messages`)).json().items.map((m: Json) => `${m.role}:${m.text}`);
    expect(history).toEqual([`user:/me`, `assistant:${CABINET_TEXT}`, 'user:👤 Мои записи и бонусы', `assistant:${CABINET_TEXT}`]);
    expect(JSON.stringify(history)).not.toContain(links[0]);
  });

  it('a chat that has not shared its phone is asked for it first; no link is issued', async () => {
    await setUp();
    await bot.handleUpdate(command('/me'));
    expect(sentTo().map((m) => m.text)).toEqual(['Чтобы я мог помочь, нажмите «📱 Поделиться номером» внизу 👇 Это нужно сделать один раз.']);
    expect(t.ctx.db.select().from(clientAccessTokens).all()).toEqual([]);
  });

  it('the keyboard of a linked client chat has the button', async () => {
    await setUp();
    linkOlga();
    await bot.handleUpdate(command('/start'));
    const keyboard = (calls.find((c) => c.method === 'sendMessage')!.payload.reply_markup as { keyboard: Array<Array<{ text: string }>> }).keyboard;
    expect(keyboard.flat().map((b) => b.text)).toContain('👤 Мои записи и бонусы');
  });

  it('/start me sends the sign-in buttons after the greeting instead of the booking offer', async () => {
    await setUp();
    linkOlga();
    await bot.handleUpdate(command('/start me'));
    expect(calls.filter((c) => c.method === 'sendMessage').map((c) => String(c.payload.text))[0]).toMatch(/^Здравствуйте!/);
    expect(sentTo().map((m) => m.text)).toEqual([CABINET_TEXT]);
  });

  it('only the website button without an https PUBLIC_URL, and an apology without any', async () => {
    await setUp({ PUBLIC_URL: 'http://localhost:3000' });
    linkOlga();
    expect(cabinetMessage(t.ctx, USER).keyboard).toEqual([[{ text: '🌐 Открыть в браузере', url: expect.stringMatching(/^http:\/\/localhost:3000\/book\/me#t=/) }]]);
    await t.close();
    await setUp({});
    linkOlga();
    expect(cabinetMessage(t.ctx, USER)).toEqual({ text: 'Личный кабинет пока недоступен — спросите здесь, я подскажу по записям и бонусам 🙂' });
    expect(t.ctx.db.select().from(clientAccessTokens).all()).toEqual([]);
  });

  it('a staff chat is told the cabinet is for clients', async () => {
    await setUp();
    await make(t, '/api/employees', { name: 'Анна', login: 'anna', password: 'secret123', phone: '+79990001122' });
    await bot.handleUpdate({
      update_id: ++updateId,
      message: { message_id: 999, date: 0, chat, from: { id: USER, is_bot: false, first_name: 'Анна' }, contact: { phone_number: '79990001122', first_name: 'Анна', user_id: USER } },
    } as unknown as Update);
    expect(cabinetMessage(t.ctx, USER)).toEqual({ text: 'Личный кабинет — для клиентов студии. Все записи и клиенты есть в приложении MIKAN.' });
  });

  it('the AI sends the buttons after its reply when the client asks for the cabinet', async () => {
    await setUp();
    linkOlga();
    ai.push(message([toolUse('a', 'cabinet_link', {})], 'tool_use'), message([text('Открываю кабинет — там записи и бонусы 🙂')]));
    pipeline.receive({ chatId: USER, telegramName: 'Ольга', username: null }, 'Где посмотреть мои бонусы и записи?');
    await pipeline.idle();
    expect(sentTo().map((m) => m.text)).toEqual(['Открываю кабинет — там записи и бонусы 🙂', CABINET_TEXT]);
    expect(signInLink().pathname).toBe('/book/me');
    expect(ai.calls[0]!.tools!.map((tool) => (tool as { name: string }).name)).toContain('cabinet_link');
    expect(buildStablePrompt(t.ctx.db)).toContain('вызови cabinet_link');
  });

  it('the AI confirms by itself when it ends without text; an unknown chat and the test mode send nothing', async () => {
    await setUp();
    linkOlga();
    ai.push(message([toolUse('a', 'cabinet_link', {})], 'tool_use'), message([]));
    pipeline.receive({ chatId: USER, telegramName: 'Ольга', username: null }, 'Личный кабинет');
    await pipeline.idle();
    expect(sentTo().map((m) => m.text)).toEqual(['Вот ваш личный кабинет: записи, бонусы и памятки по уходу 👇', CABINET_TEXT]);

    const sink = emptySink();
    const scope = { mode: 'test' as const, chatId: USER, clientId: olga.id, telegramName: null, username: null, lastUserText: '' };
    const tested = await buildToolHandlers(t.ctx, scope, sink).cabinet_link!({});
    expect(tested.content).toMatch(/^Тестовый режим/);
    expect(sink.after).toEqual([]);
    expect(sink.notes).toEqual(['отправлены бы кнопки входа в личный кабинет']);
    const anonymous = await buildToolHandlers(t.ctx, { ...scope, mode: 'live', chatId: 555 }, emptySink()).cabinet_link!({});
    expect(anonymous.content).toMatch(/^Клиент не идентифицирован/);
    expect(TOOLS).toContain(CABINET_LINK_TOOL);
  });
});
