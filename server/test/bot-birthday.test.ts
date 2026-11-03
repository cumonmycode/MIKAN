import { eq } from 'drizzle-orm';
import { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BIRTHDAY_ANSWER_WINDOW_MS, BIRTHDAY_TEXTS } from '../src/bot/birthday.js';
import { registerHandlers } from '../src/bot/handlers.js';
import { BotPipeline } from '../src/bot/pipeline.js';
import { botMessages, clients } from '../src/db/schema.js';
import { storeMessage } from '../src/domain/bot-chats.js';
import { createTestApp, make, message, ScriptedAi, text, type TestApp } from './helpers.js';

const USER = 9_101;
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

const SKIP_KEYBOARD = [[{ text: 'Пропустить', data: 'bs' }]];

describe('the bot asks for the birthday once', () => {
  let t: TestApp;
  let bot: Bot;
  let pipeline: BotPipeline;
  let ai: ScriptedAi;
  let updateId = 0;

  const update = (extra: Record<string, unknown>): Update =>
    ({
      update_id: ++updateId,
      message: {
        message_id: updateId,
        date: 1_760_000_000,
        chat: { id: USER, type: 'private', first_name: 'Ольга' },
        from: { id: USER, is_bot: false, first_name: 'Ольга', username: 'olga' },
        ...extra,
      },
    }) as unknown as Update;
  const say = async (body: string) => {
    await bot.handleUpdate(update({ text: body }));
    await pipeline.idle();
  };
  const shareContact = async (phone = '+79990001122') => {
    await bot.handleUpdate(update({ contact: { phone_number: phone, first_name: 'Ольга', user_id: USER } }));
    await pipeline.idle();
  };
  const startCommand = async (body: string) => {
    await bot.handleUpdate(
      update({ text: body, entities: [{ type: 'bot_command', offset: 0, length: body.split(' ')[0]!.length }] }),
    );
    await pipeline.idle();
  };
  const pressSkip = async (messageId = 77) => {
    await bot.handleUpdate({
      update_id: ++updateId,
      callback_query: {
        id: `cb${updateId}`, chat_instance: 'ci', data: 'bs',
        from: { id: USER, is_bot: false, first_name: 'Ольга' },
        message: { message_id: messageId, date: 1_760_000_000, chat: { id: USER, type: 'private', first_name: 'Ольга' }, text: BIRTHDAY_TEXTS.ask },
      },
    } as unknown as Update);
    await pipeline.idle();
  };
  const card = () => t.ctx.db.select().from(clients).where(eq(clients.telegramChatId, USER)).get()!;
  const sent = () => t.gateway.sent.filter((m) => m.chatId === USER);
  const texts = () => t.gateway.textsTo(USER);
  const questionsSent = () => texts().filter((x) => x === BIRTHDAY_TEXTS.ask).length;

  beforeEach(async () => {
    ai = new ScriptedAi();
    t = await createTestApp({ ai });
    pipeline = new BotPipeline(t.ctx, 0);
    bot = new Bot('123:test', { botInfo });
    bot.api.config.use(async (_prev, method) => {
      const result = method === 'sendMessage' ? { message_id: 1, date: 0, chat: { id: USER, type: 'private' } } : true;
      return { ok: true, result } as never;
    });
    registerHandlers(bot, { ctx: t.ctx, pipeline, downloadFile: async () => null });
  });
  afterEach(async () => {
    await t.close();
  });

  it('asks a new client right after the phone is shared, with «Пропустить», and marks the card as asked', async () => {
    await shareContact();
    const question = sent().at(-1)!;
    expect(question).toMatchObject({ text: 'Подскажите дату рождения — в этот день пришлём подарок 🎁', keyboard: SKIP_KEYBOARD });
    expect(card().birthdayAskedAt).toEqual(expect.any(Number));
    // Stored in the chat so staff and the AI see it.
    const stored = t.ctx.db.select().from(botMessages).where(eq(botMessages.chatId, USER)).all();
    expect(stored.at(-1)).toMatchObject({ role: 'assistant', text: BIRTHDAY_TEXTS.ask });
  });

  it('saves a date in the reply, thanks the client and never asks again', async () => {
    await shareContact();
    await say('мой день рождения 12 апреля');
    expect(card().birthday).toBe('1900-04-12');
    expect(texts().at(-1)).toBe('Записал! В этот день будет подарок 🎁');
    expect(ai.calls).toHaveLength(0);
    const log = (await t.api('GET', `/api/audit?entity=client&entityId=${card().id}`)).json().items;
    expect(log[0]).toMatchObject({
      source: 'bot', action: 'client.birthday', summary: 'Клиент «Ольга» указал(а) дату рождения в боте: 12 апреля',
    });

    // Sharing the phone again does not ask again.
    await t.ctx.db.update(clients).set({ birthday: null }).where(eq(clients.id, card().id)).run();
    await shareContact();
    expect(questionsSent()).toBe(1);
  });

  it('reads a full date', async () => {
    await shareContact();
    await say('12.04.1995');
    expect(card().birthday).toBe('1995-04-12');
  });

  it('does not ask a card that has a birthday or was asked before, nor a staff chat', async () => {
    const withBirthday = await make(t, '/api/clients', { name: 'Ира', phone: '+79990007777', birthday: '1990-01-02' });
    await shareContact('+79990007777');
    expect(questionsSent()).toBe(0);

    await t.ctx.db.update(clients).set({ birthday: null, birthdayAskedAt: Date.now() - 1000 }).where(eq(clients.id, withBirthday.id)).run();
    await shareContact('+79990007777');
    expect(questionsSent()).toBe(0);

    // The admin's own phone turns the chat into a staff chat.
    await make(t, '/api/employees', { name: 'Анна', login: 'anna', password: 'secret123', phone: '+79990005555', isMaster: true });
    await shareContact('+79990005555');
    expect(questionsSent()).toBe(0);
  });

  it('asks after a card is linked with the link from the app', async () => {
    const client = await make(t, '/api/clients', { name: 'Иван', phone: '+79990000106' });
    const url = (await t.api('POST', `/api/clients/${client.id}/telegram-link`)).json().url as string;
    await startCommand(`/start ${new URL(url).searchParams.get('start')}`);
    expect(sent().at(-1)).toMatchObject({ text: BIRTHDAY_TEXTS.ask, keyboard: SKIP_KEYBOARD });
    await say('3 мая 1990');
    expect(card().birthday).toBe('1990-05-03');
  });

  it('asks once more gently, then moves on; later messages go to the AI', async () => {
    await shareContact();
    await say('31.02');
    expect(sent().at(-1)).toMatchObject({ text: BIRTHDAY_TEXTS.retry, keyboard: SKIP_KEYBOARD });
    await say('32.13.1995');
    expect(texts().at(-1)).toBe('Ничего страшного 🙂 Дату рождения можно добавить позже в «👤 Мои записи и бонусы».');
    expect(card().birthday).toBeNull();
    expect(ai.calls).toHaveLength(0);

    ai.push(message([text('12 апреля свободно с 12:00 🙂')]));
    await say('12.04');
    expect(card().birthday).toBeNull();
    expect(ai.calls).toHaveLength(1);
    expect(texts().at(-1)).toBe('12 апреля свободно с 12:00 🙂');
  });

  it('a date after the retry is saved', async () => {
    await shareContact();
    await say('1204');
    await say('12.04');
    expect(card().birthday).toBe('1900-04-12');
  });

  it('never swallows a real question: it goes to the AI and the question is over', async () => {
    await shareContact();
    ai.push(message([text('Мочка — 1 600 ₽ 🙂')]));
    await say('Сколько стоит прокол мочки?');
    expect(ai.calls).toHaveLength(1);
    expect(texts().at(-1)).toBe('Мочка — 1 600 ₽ 🙂');
    expect(texts()).not.toContain(BIRTHDAY_TEXTS.retry);

    ai.push(message([text('Записал вас на 12 апреля')]));
    await say('12 апреля');
    expect(card().birthday).toBeNull();
    expect(ai.calls).toHaveLength(2);
  });

  it('a booking wish with a date is not a birthday', async () => {
    await shareContact();
    ai.push(message([text('Посмотрю свободное время 🙌')]));
    await say('хочу записаться на 12.04');
    expect(card().birthday).toBeNull();
    expect(ai.calls).toHaveLength(1);
  });

  it('asks after the AI answered what was asked before the phone, so a reply to the AI is never taken for it', async () => {
    ai.push(message([text('Мочка — 1 600 ₽ 🙂')]));
    await say('Сколько стоит прокол мочки?');
    await shareContact();
    // The question goes out once that answer is delivered (not awaited by the update handler).
    await vi.waitFor(() => expect(texts().at(-1)).toBe(BIRTHDAY_TEXTS.ask));
    expect(texts().slice(-2)).toEqual(['Мочка — 1 600 ₽ 🙂', BIRTHDAY_TEXTS.ask]);
    await say('12.04.1995');
    expect(card().birthday).toBe('1995-04-12');
  });

  it('any reply of the bot after the question closes it', async () => {
    await shareContact();
    storeMessage(t.ctx.db, USER, 'assistant', 'На какую дату вас записать?');
    ai.push(message([text('Записал вас на 12 апреля')]));
    await say('12 апреля');
    expect(card().birthday).toBeNull();
    expect(ai.calls).toHaveLength(1);
  });

  it('does not ask a client who refused news or whose bot messages are off', async () => {
    await make(t, '/api/clients', { name: 'Ира', phone: '+79990007711', marketingOptOut: true });
    await shareContact('+79990007711');
    await make(t, '/api/clients', { name: 'Ада', phone: '+79990007712', botEnabled: false });
    await shareContact('+79990007712');
    expect(questionsSent()).toBe(0);
    // Still never asked: the question may come once that changes and the chat links again.
    expect(t.ctx.db.select().from(clients).all().every((c) => c.birthdayAskedAt === null)).toBe(true);
  });

  it('a question Telegram refused does not count as asked', async () => {
    const client = await make(t, '/api/clients', { name: 'Ира', phone: '+79990007721' });
    t.gateway.failures.push(new Error('Telegram is down'));
    await shareContact('+79990007721');
    expect(t.ctx.db.select().from(clients).where(eq(clients.id, client.id)).get()!.birthdayAskedAt).toBeNull();
    await shareContact('+79990007721');
    expect(questionsSent()).toBe(1);
  });

  it('«Пропустить» removes the button and closes the question', async () => {
    await shareContact();
    await pressSkip();
    expect(t.gateway.edits).toContainEqual({ kind: 'keyboard', chatId: USER, messageId: 77, keyboard: null });
    expect(texts().at(-1)).toBe('Хорошо! Если захотите, дату рождения можно добавить позже в «👤 Мои записи и бонусы» 🙂');
    ai.push(message([text('Хорошо 🙂')]));
    await say('12.04');
    expect(card().birthday).toBeNull();
    expect(ai.calls).toHaveLength(1);

    // A second press on the old button only removes it.
    const before = texts().length;
    await pressSkip();
    expect(texts()).toHaveLength(before);
  });

  it('a typed refusal is understood too', async () => {
    await shareContact();
    await say('не хочу');
    expect(texts().at(-1)).toBe(BIRTHDAY_TEXTS.skipped);
    expect(ai.calls).toHaveLength(0);
  });

  it('a reply after the window, or after staff wrote or filled the birthday, is an ordinary message', async () => {
    await shareContact();
    const asked = t.ctx.db.select().from(botMessages).where(eq(botMessages.text, BIRTHDAY_TEXTS.ask)).get()!;
    t.ctx.db.update(botMessages).set({ createdAt: Date.now() - BIRTHDAY_ANSWER_WINDOW_MS - 1000 }).where(eq(botMessages.id, asked.id)).run();
    ai.push(message([text('Здравствуйте!')]));
    await say('12.04');
    expect(card().birthday).toBeNull();
    expect(ai.calls).toHaveLength(1);
  });

  it('a birthday staff typed meanwhile is never overwritten', async () => {
    await shareContact();
    await t.api('PATCH', `/api/clients/${card().id}`, { birthday: '1991-06-01' });
    ai.push(message([text('Хорошо!')]));
    await say('12.04.1995');
    expect(card().birthday).toBe('1991-06-01');
  });
});
