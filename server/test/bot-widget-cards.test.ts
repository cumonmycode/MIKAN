import { deflateSync } from 'node:zlib';
import type { Api } from 'grammy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotSendError } from '../src/bot/gateway.js';
import { answerWidgetQuery } from '../src/bot/handlers.js';
import { handleStaffCommand, handleStart } from '../src/bot/onboarding.js';
import { BotPipeline } from '../src/bot/pipeline.js';
import { processDueMessages } from '../src/bot/sender.js';
import { issueStaffCode } from '../src/bot/staff.js';
import { widgetQueryOf, type WidgetQuery } from '../src/bot/widget-api.js';
import {
  REMINDER_CARD_HTML,
  reminderCardData,
  WIDGET_MAX_COMPRESSED_HTML_BYTES,
  WIDGET_MAX_DATA_BYTES,
  WIDGET_MAX_HTML_BYTES,
  type CardData,
} from '../src/bot/widget-card.js';
import { appointments } from '../src/db/schema.js';
import { createTestApp, make, message, ScriptedAi, text, type TestApp } from './helpers.js';

const NOW = Date.parse('2026-10-15T09:00:00.000Z'); // Thu 12:00 Moscow
const REMINDER_DUE = Date.parse('2026-10-16T11:00:01Z');
const CHAT = 740_001;
const STAFF = -740;
const from = { chatId: CHAT, telegramName: 'Иван', username: 'ivanp' };

const card = (json: string): CardData => JSON.parse(json) as CardData;

describe('appointment card template', () => {
  it('fits Telegram widget limits and loads nothing from outside', () => {
    expect(Buffer.byteLength(REMINDER_CARD_HTML, 'utf8')).toBeLessThanOrEqual(WIDGET_MAX_HTML_BYTES);
    expect(deflateSync(Buffer.from(REMINDER_CARD_HTML, 'utf8'), { level: 9 }).length).toBeLessThanOrEqual(WIDGET_MAX_COMPRESSED_HTML_BYTES);
    // No network, no removed elements / CSS, no HTML built from data.
    expect(REMINDER_CARD_HTML).not.toMatch(/https?:\/\/|fetch\(|XMLHttpRequest|<input|<select|<textarea|<iframe|\dvh\b|innerHTML|@font-face/);
    expect(REMINDER_CARD_HTML).toContain("W.onEvent('chatDataChanged',draw)");
  });

  it('has a script that parses', () => {
    const script = /<script>([\s\S]*)<\/script>/.exec(REMINDER_CARD_HTML)?.[1];
    expect(script).toBeTruthy();
    expect(() => new Function(script!)).not.toThrow();
  });
});

describe('bot: reminders as live appointment cards (widgets)', () => {
  let t: TestApp;
  let ai: ScriptedAi;
  let pipeline: BotPipeline;
  let client: { id: number };
  let answers: Array<Record<string, unknown>>;
  let api: Api;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    ai = new ScriptedAi();
    t = await createTestApp({ ai });
    pipeline = new BotPipeline(t.ctx, 0);
    handleStaffCommand(t.ctx, STAFF, issueStaffCode(t.ctx.db).code);
    client = await make(t, '/api/clients', { name: 'Иван', phone: '+79991234567' });
    const url = (await t.api('POST', `/api/clients/${client.id}/telegram-link`)).json().url as string;
    handleStart(t.ctx, from, new URL(url).searchParams.get('start')!);
    answers = [];
    api = {
      raw: {
        answerWidgetQuery: async (payload: Record<string, unknown>) => {
          answers.push(payload);
          return true;
        },
      },
    } as unknown as Api;
  });
  afterEach(async () => {
    await t.close();
    vi.useRealTimers();
  });

  const book = (title = 'Хеликс') =>
    make(t, '/api/appointments', { clientId: client.id, masterId: 1, startsAt: '2026-10-17T11:00:00Z', endsAt: '2026-10-17T12:00:00Z', title });
  const cardsOn = () => t.api('PUT', '/api/settings/bot', { widgetCards: true });
  const press = (data: string, messageId: number, chatId = CHAT): Promise<void> => {
    const query: WidgetQuery = {
      id: `q${answers.length}`,
      from: { id: chatId, firstName: 'Иван', lastName: null, username: 'ivanp' },
      chatId,
      chatType: 'private',
      messageId,
      type: 'data',
      data,
    };
    return answerWidgetQuery({ ctx: t.ctx, pipeline, downloadFile: async () => null }, api, query);
  };
  const lastCard = () => card(t.gateway.widgetEdits.at(-1)!.chatData);

  it('the setting is off by default and saved on PUT', async () => {
    expect((await t.api('GET', '/api/settings/bot')).json().widgetCards).toBe(false);
    expect((await cardsOn()).json().widgetCards).toBe(true);
    expect((await t.api('PUT', '/api/settings/bot', { widgetCards: 'yes' })).statusCode).toBe(400);
  });

  it('sends the reminder as a card: its text as the caption, the buttons inside the card', async () => {
    await cardsOn();
    const appt = await book();
    expect(await processDueMessages(t.ctx, REMINDER_DUE)).toMatchObject({ sent: 1 });
    expect(t.gateway.sent.filter((s) => s.chatId === CHAT)).toHaveLength(0);
    const sent = t.gateway.widgets.at(-1)!;
    expect(sent.chatId).toBe(CHAT);
    expect(sent.widget.html).toBe(REMINDER_CARD_HTML);
    expect(sent.widget.caption).toMatch(/^🗓 Напоминаем о записи в MIKAN STUDIO\nКогда: суббота, 17 октября в 14:00/);
    expect(card(sent.widget.chatData)).toEqual({
      t: '🗓 Напоминаем о записи в MIKAN STUDIO',
      r: [
        ['Когда', 'суббота, 17 октября в 14:00–15:00'],
        ['Что', 'Хеликс'],
        ['Мастер', 'Админ'],
      ],
      s: 'p',
      b: [
        ['✅ Приду', `rc:${appt.id}`],
        ['🔁 Перенести', `rm:${appt.id}`],
      ],
    });
    // Stored in the chat history like a plain reminder.
    const history = (await t.api('GET', `/api/bot/chats/${CHAT}/messages`)).json().items as Array<{ role: string; text: string }>;
    expect(history.at(-1)).toMatchObject({ role: 'system', text: expect.stringMatching(/^🗓 Напоминаем/) });
  });

  it('falls back to the plain reminder when Telegram refuses the widget', async () => {
    await cardsOn();
    const appt = await book();
    t.gateway.widgetFailures.push(new BotSendError('Telegram: Not Found: method not found', false));
    expect(await processDueMessages(t.ctx, REMINDER_DUE)).toMatchObject({ sent: 1 });
    expect(t.gateway.sent.at(-1)!.keyboard).toEqual([[{ text: '✅ Приду', data: `rc:${appt.id}` }, { text: '🔁 Перенести', data: `rm:${appt.id}` }]]);
  });

  it('does not fall back for a chat that blocked the bot', async () => {
    await cardsOn();
    await book();
    t.gateway.widgetFailures.push(new BotSendError('Telegram: Forbidden: bot was blocked by the user', true));
    expect(await processDueMessages(t.ctx, REMINDER_DUE)).toMatchObject({ sent: 0, failed: 1 });
    expect(t.gateway.sent.filter((s) => s.chatId === CHAT)).toHaveLength(0);
  });

  it('a press confirms or moves the visit and the card redraws in place', async () => {
    await cardsOn();
    const appt = await book();
    await processDueMessages(t.ctx, REMINDER_DUE);
    const messageId = t.gateway.widgets.at(-1)!.messageId;

    await press(`rc:${appt.id}`, messageId);
    expect(answers.at(-1)).toEqual({ widget_query_id: 'q0' });
    expect((await t.api('GET', `/api/appointments/${appt.id}`)).json().status).toBe('confirmed');
    expect(t.gateway.widgetEdits.at(-1)).toMatchObject({ chatId: CHAT, messageId });
    expect(lastCard()).toMatchObject({ t: '🗓 Запись в MIKAN STUDIO', s: 'c', n: 'Визит подтверждён ✅ Ждём вас!', b: [['🔁 Перенести', `rm:${appt.id}`]] });
    expect(t.gateway.textsTo(CHAT).at(-1)).toBe('Спасибо, что подтвердили! Ждём вас суббота, 17 октября в 14:00 ✨');
    expect(t.gateway.edits).toHaveLength(0); // no inline keyboard to edit

    ai.push(message([text('Конечно! На какой день удобно перенести?')]));
    await press(`rm:${appt.id}`, messageId);
    expect(lastCard()).toMatchObject({ s: 'm', b: [] });
    await pipeline.idle();
    expect(JSON.stringify(ai.calls[0]!.messages)).toContain(`[Кнопка] 🔁 Хочу перенести запись №${appt.id}`);

    t.ctx.db.update(appointments).set({ status: 'cancelled' }).run();
    await press(`rc:${appt.id}`, messageId);
    expect(answers.at(-1)).toEqual({ widget_query_id: 'q2', data: '!Эта запись уже неактуальна' });
    expect(lastCard()).toMatchObject({ s: 'x', n: 'Эта запись уже неактуальна', b: [] });
  });

  it('another chat gets an error and sees nothing of the appointment', async () => {
    await cardsOn();
    const appt = await book();
    await press(`rc:${appt.id}`, 1, CHAT + 7);
    expect(answers.at(-1)).toEqual({ widget_query_id: 'q0', data: '!Эта запись уже неактуальна' });
    expect(t.gateway.widgetEdits).toHaveLength(0);
    expect((await t.api('GET', `/api/appointments/${appt.id}`)).json().status).toBe('scheduled');
  });

  it('keeps the card state within 1024 bytes for very long services and names', async () => {
    const appt = await book('Очень длинное название процедуры 🌸 '.repeat(8));
    const row = t.ctx.db.select().from(appointments).all().find((a) => a.id === appt.id)!;
    const json = reminderCardData(t.ctx.db, row, '⏰ '.repeat(100), 'p');
    expect(Buffer.byteLength(json, 'utf8')).toBeLessThanOrEqual(WIDGET_MAX_DATA_BYTES);
    expect(card(json).b).toHaveLength(2);
  });
});

describe('widget query updates', () => {
  it('reads a press and rejects malformed or inline queries', () => {
    const update = {
      update_id: 1,
      widget_query: {
        id: 'abc',
        from: { id: 5, first_name: 'Аня', username: 'anya' },
        chat: { id: 5, type: 'private' },
        message_id: 42,
        chat_instance: 'x',
        type: { type: 'data' },
        data: 'rc:7',
      },
    };
    expect(widgetQueryOf(update)).toEqual({
      id: 'abc',
      from: { id: 5, firstName: 'Аня', lastName: null, username: 'anya' },
      chatId: 5,
      chatType: 'private',
      messageId: 42,
      type: 'data',
      data: 'rc:7',
    });
    expect(widgetQueryOf({ update_id: 2, message: {} })).toBeNull();
    const { chat: _chat, message_id: _id, ...inline } = update.widget_query;
    expect(widgetQueryOf({ widget_query: { ...inline, inline_message_id: 'im' } })).toBeNull();
    expect(widgetQueryOf({ widget_query: { ...update.widget_query, data: 7 } })).toBeNull();
  });
});
