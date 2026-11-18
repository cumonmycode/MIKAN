import { deflateSync } from 'node:zlib';
import { eq } from 'drizzle-orm';
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
  APPOINTMENT_CARD_HTML,
  appointmentCardData,
  routeLink,
  WIDGET_MAX_COMPRESSED_HTML_BYTES,
  WIDGET_MAX_DATA_BYTES,
  WIDGET_MAX_HTML_BYTES,
  WIDGET_MAX_LINK_LENGTH,
  type CardData,
} from '../src/bot/widget-card.js';
import { refreshWidgetCards } from '../src/bot/widget-cards.js';
import { appointments, widgetCards } from '../src/db/schema.js';
import { bookingFacts, clientBookingMessage, tellClient } from '../src/domain/online-booking-messages.js';
import { DEFAULT_BOT } from '../src/domain/settings.js';
import { createTestApp, FakeQrProvider, make, message, ScriptedAi, text, type TestApp } from './helpers.js';

const NOW = Date.parse('2026-10-15T09:00:00.000Z'); // Thu 12:00 Moscow
const STARTS = '2026-10-17T11:00:00.000Z'; // Sat 14:00 Moscow
const REMINDER_DUE = Date.parse('2026-10-16T11:00:01Z');
const CHAT = 740_001;
const STAFF = -740;
const from = { chatId: CHAT, telegramName: 'Иван', username: 'ivanp' };

const card = (json: string): CardData => JSON.parse(json) as CardData;
const buttonTexts = (data: CardData): string[] => data.b.map(([label]) => label);

describe('appointment card template', () => {
  it('fits Telegram widget limits and loads nothing from outside', () => {
    expect(Buffer.byteLength(APPOINTMENT_CARD_HTML, 'utf8')).toBeLessThanOrEqual(WIDGET_MAX_HTML_BYTES);
    expect(deflateSync(Buffer.from(APPOINTMENT_CARD_HTML, 'utf8'), { level: 9 }).length).toBeLessThanOrEqual(WIDGET_MAX_COMPRESSED_HTML_BYTES);
    // No network, no removed elements / CSS, no HTML built from data.
    expect(APPOINTMENT_CARD_HTML).not.toMatch(/https?:\/\/[a-z]|fetch\(|XMLHttpRequest|<input|<select|<textarea|<iframe|\dvh\b|innerHTML|@font-face/);
    expect(APPOINTMENT_CARD_HTML).toContain("W.onEvent('chatDataChanged',draw)");
    expect(APPOINTMENT_CARD_HTML).toContain('W.openLink(data)');
  });

  it('has a script that parses', () => {
    const script = /<script>([\s\S]*)<\/script>/.exec(APPOINTMENT_CARD_HTML)?.[1];
    expect(script).toBeTruthy();
    expect(() => new Function(script!)).not.toThrow();
  });

  it('builds a route link only when it fits a widget link', () => {
    expect(routeLink('Москва, Тверская, 1')).toBe(`https://yandex.ru/maps/?text=${encodeURIComponent('Москва, Тверская, 1')}`);
    expect(routeLink('  ')).toBeNull();
    expect(routeLink('Очень длинный адрес '.repeat(10))).toBeNull();
    expect(routeLink('Москва, Тверская, 1')!.length).toBeLessThanOrEqual(WIDGET_MAX_LINK_LENGTH);
  });

  it('is on by default in production settings', () => {
    expect(DEFAULT_BOT.widgetCards).toBe(true);
  });
});

describe('bot: live appointment cards (widgets)', () => {
  let t: TestApp;
  let ai: ScriptedAi;
  let bank: FakeQrProvider;
  let pipeline: BotPipeline;
  let client: { id: number };
  let answers: Array<Record<string, unknown>>;
  let api: Api;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    ai = new ScriptedAi();
    bank = new FakeQrProvider();
    t = await createTestApp({ ai, qr: bank });
    pipeline = new BotPipeline(t.ctx, 0);
    handleStaffCommand(t.ctx, STAFF, issueStaffCode(t.ctx.db).code);
    client = await make(t, '/api/clients', { name: 'Иван', phone: '+79991234567' });
    const url = (await t.api('POST', `/api/clients/${client.id}/telegram-link`)).json().url as string;
    handleStart(t.ctx, from, new URL(url).searchParams.get('start')!);
    await t.api('PUT', '/api/settings/bot', { widgetCards: true });
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

  const book = (title = 'Хеликс', extra: object = {}) =>
    make(t, '/api/appointments', { clientId: client.id, masterId: 1, startsAt: STARTS, endsAt: '2026-10-17T12:00:00Z', title, ...extra });
  const row = (id: number) => t.ctx.db.select().from(appointments).where(eq(appointments.id, id)).get()!;
  const cards = () => t.ctx.db.select().from(widgetCards).all();
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
  const remind = async () => {
    expect(await processDueMessages(t.ctx, REMINDER_DUE)).toMatchObject({ sent: 1 });
    return t.gateway.widgets.at(-1)!;
  };

  it('the setting can be turned off and on', async () => {
    expect((await t.api('PUT', '/api/settings/bot', { widgetCards: false })).json().widgetCards).toBe(false);
    await book();
    await processDueMessages(t.ctx, REMINDER_DUE);
    expect(t.gateway.widgets).toHaveLength(0);
    expect(t.gateway.textsTo(CHAT).at(-1)).toMatch(/^🗓 Напоминаем/);
    expect((await t.api('PUT', '/api/settings/bot', { widgetCards: 'yes' })).statusCode).toBe(400);
  });

  it('sends the reminder as a card: its text as the caption, the buttons inside, registered for redraws', async () => {
    const appt = await book();
    const sent = await remind();
    expect(t.gateway.sent.filter((s) => s.chatId === CHAT)).toHaveLength(0);
    expect(sent.chatId).toBe(CHAT);
    expect(sent.widget.html).toBe(APPOINTMENT_CARD_HTML);
    expect(sent.widget.caption).toMatch(/^🗓 Напоминаем о записи в MIKAN STUDIO\nКогда: суббота, 17 октября в 14:00/);
    expect(card(sent.widget.chatData)).toEqual({
      t: '🗓 Напоминаем о записи в MIKAN STUDIO',
      st: '⏳ Подтвердите, пожалуйста, визит',
      s: 'p',
      r: [
        ['Когда', 'суббота, 17 октября в 14:00–15:00'],
        ['Что', 'Хеликс'],
        ['Мастер', 'Админ'],
      ],
      b: [
        ['✅ Приду', `rc:${appt.id}`],
        ['🔁 Перенести', `rm:${appt.id}`],
      ],
    });
    expect(cards()).toEqual([
      expect.objectContaining({ chatId: CHAT, messageId: sent.messageId, appointmentId: appt.id, kind: 'reminder', active: true }),
    ]);
    const history = (await t.api('GET', `/api/bot/chats/${CHAT}/messages`)).json().items as Array<{ role: string; text: string }>;
    expect(history.at(-1)).toMatchObject({ role: 'system', text: expect.stringMatching(/^🗓 Напоминаем/) });
  });

  it('falls back to the plain reminder when Telegram refuses the widget', async () => {
    const appt = await book();
    t.gateway.widgetFailures.push(new BotSendError('Telegram: Not Found: method not found', false));
    expect(await processDueMessages(t.ctx, REMINDER_DUE)).toMatchObject({ sent: 1 });
    expect(t.gateway.sent.at(-1)!.keyboard).toEqual([[{ text: '✅ Приду', data: `rc:${appt.id}` }, { text: '🔁 Перенести', data: `rm:${appt.id}` }]]);
    expect(cards()).toHaveLength(0);
  });

  it('does not fall back for a chat that blocked the bot', async () => {
    await book();
    t.gateway.widgetFailures.push(new BotSendError('Telegram: Forbidden: bot was blocked by the user', true));
    expect(await processDueMessages(t.ctx, REMINDER_DUE)).toMatchObject({ sent: 0, failed: 1 });
    expect(t.gateway.sent.filter((s) => s.chatId === CHAT)).toHaveLength(0);
  });

  it('a press confirms the visit; the card keeps its title and shows the route once confirmed', async () => {
    await t.api('PUT', '/api/settings/studio', { address: 'Москва, Тверская, 1' });
    const appt = await book();
    const { messageId } = await remind();

    await press(`rc:${appt.id}`, messageId);
    expect(answers.at(-1)).toEqual({ widget_query_id: 'q0' });
    expect(row(appt.id).status).toBe('confirmed');
    expect(t.gateway.widgetEdits.at(-1)).toMatchObject({ chatId: CHAT, messageId });
    expect(lastCard()).toMatchObject({
      t: '🗓 Напоминаем о записи в MIKAN STUDIO',
      st: '✅ Запись подтверждена',
      s: 'c',
      b: [
        ['🔁 Перенести', `rm:${appt.id}`],
        ['📍 Маршрут', routeLink('Москва, Тверская, 1')],
      ],
    });
    expect(t.gateway.textsTo(CHAT).at(-1)).toBe('Спасибо, что подтвердили! Ждём вас суббота, 17 октября в 14:00 ✨');
    // Nothing else changed: the background pass leaves the card alone.
    const edits = t.gateway.widgetEdits.length;
    expect(await refreshWidgetCards(t.ctx)).toEqual({ redrawn: 0, retired: 0 });
    expect(t.gateway.widgetEdits).toHaveLength(edits);
  });

  it('«Перенести» holds until the appointment moves; then the card shows the new time', async () => {
    const appt = await book();
    const { messageId } = await remind();
    ai.push(message([text('Конечно! На какой день удобно перенести?')]));
    await press(`rm:${appt.id}`, messageId);
    expect(lastCard()).toMatchObject({ st: '🔁 Подберём другое время — ответьте в чате', s: 'm', b: [] });
    await pipeline.idle();
    expect(JSON.stringify(ai.calls[0]!.messages)).toContain(`[Кнопка] 🔁 Хочу перенести запись №${appt.id}`);
    expect(await refreshWidgetCards(t.ctx)).toEqual({ redrawn: 0, retired: 0 });

    vi.setSystemTime(NOW + 60_000);
    await t.api('PATCH', `/api/appointments/${appt.id}`, { startsAt: '2026-10-18T11:00:00Z', endsAt: '2026-10-18T12:00:00Z' });
    expect(await refreshWidgetCards(t.ctx)).toEqual({ redrawn: 1, retired: 0 });
    expect(lastCard()).toMatchObject({
      st: '⏳ Подтвердите, пожалуйста, визит',
      r: expect.arrayContaining([['Когда', 'воскресенье, 18 октября в 14:00–15:00']]),
      b: [
        ['✅ Приду', `rc:${appt.id}`],
        ['🔁 Перенести', `rm:${appt.id}`],
      ],
    });
  });

  it('follows changes made by the studio and retires once the visit is over', async () => {
    const appt = await book();
    const { messageId } = await remind();
    await t.api('PATCH', `/api/appointments/${appt.id}`, { status: 'confirmed' });
    expect(await refreshWidgetCards(t.ctx)).toEqual({ redrawn: 1, retired: 0 });
    expect(lastCard()).toMatchObject({ st: '✅ Запись подтверждена', b: [['🔁 Перенести', `rm:${appt.id}`]] });

    await t.api('PATCH', `/api/appointments/${appt.id}`, { status: 'cancelled' });
    expect(await refreshWidgetCards(t.ctx)).toEqual({ redrawn: 1, retired: 1 });
    expect(lastCard()).toMatchObject({ st: '❌ Запись отменена', s: 'x', b: [] });
    expect(cards()[0]!.active).toBe(false);
    const edits = t.gateway.widgetEdits.length;
    await refreshWidgetCards(t.ctx);
    expect(t.gateway.widgetEdits).toHaveLength(edits);

    // A stale press answers with the error.
    await press(`rc:${appt.id}`, messageId);
    expect(answers.at(-1)).toEqual({ widget_query_id: 'q0', data: '!Эта запись уже неактуальна' });
  });

  it('retires a card whose message is gone and waits after a flood limit', async () => {
    const appt = await book();
    await remind();
    await t.api('PATCH', `/api/appointments/${appt.id}`, { status: 'confirmed' });
    t.gateway.widgetEditFailures.push(new BotSendError('Telegram: Too Many Requests', false, 5000));
    expect(await refreshWidgetCards(t.ctx)).toEqual({ redrawn: 0, retired: 0 });
    expect(cards()[0]!.active).toBe(true);
    t.gateway.widgetEditFailures.push(new BotSendError('Telegram: Bad Request: message to edit not found', false));
    expect(await refreshWidgetCards(t.ctx)).toEqual({ redrawn: 0, retired: 1 });
    expect(cards()[0]!.active).toBe(false);
  });

  it('the prepayment link goes as a card with the pay button, which turns into «получена» once paid', async () => {
    const tattoo = await make(t, '/api/services', { name: 'Тату среднее', category: 'tattoo', price: 8000, durationMin: 120, depositAmount: 2000 });
    const appt = await make(t, '/api/appointments', { clientId: client.id, masterId: 1, services: [{ serviceId: tattoo.id }], startsAt: STARTS });
    const res = await t.api('POST', `/api/appointments/${appt.id}/deposit/qr`, { delivery: 'telegram' });
    expect(res.statusCode).toBe(200);
    const payment = res.json().payment as { id: number; payload: string };
    const sent = t.gateway.widgets.at(-1)!;
    expect(sent.widget.caption).toContain(`Оплатить через СБП: ${payment.payload}`);
    expect(card(sent.widget.chatData)).toMatchObject({
      t: '🗓 Ваша запись в MIKAN STUDIO',
      st: '⏳ Ждёт подтверждения студии',
      r: expect.arrayContaining([['Предоплата', '2 000 ₽ · ожидается']]),
      b: [
        ['💳 Оплатить 2 000 ₽', payment.payload],
        ['🔁 Перенести', `rm:${appt.id}`],
      ],
    });
    expect(cards()[0]).toMatchObject({ kind: 'booking', appointmentId: appt.id });

    bank.statuses.set('QR1', 'paid');
    expect((await t.api('GET', `/api/qr-payments/${payment.id}`)).json().status).toBe('paid');
    expect(await refreshWidgetCards(t.ctx)).toEqual({ redrawn: 1, retired: 0 });
    expect(lastCard()).toMatchObject({
      r: expect.arrayContaining([['Предоплата', '2 000 ₽ · получена ✅']]),
      b: [['🔁 Перенести', `rm:${appt.id}`]],
    });
  });

  it('the online booking message goes as the booking card', async () => {
    const appt = await book();
    const a = row(appt.id);
    expect(await tellClient(t.ctx, a, clientBookingMessage(t.ctx.db, a, bookingFacts(t.ctx.db, a), null))).toBe(true);
    const sent = t.gateway.widgets.at(-1)!;
    expect(sent.widget.caption).toMatch(/^Заявка принята/);
    expect(card(sent.widget.chatData)).toMatchObject({
      t: '🗓 Ваша запись в MIKAN STUDIO',
      st: '⏳ Ждёт подтверждения студии',
      b: [['🔁 Перенести', `rm:${appt.id}`]],
    });
  });

  it('another chat gets an error and sees nothing of the appointment', async () => {
    const appt = await book();
    await press(`rc:${appt.id}`, 1, CHAT + 7);
    expect(answers.at(-1)).toEqual({ widget_query_id: 'q0', data: '!Эта запись уже неактуальна' });
    expect(t.gateway.widgetEdits).toHaveLength(0);
    expect(row(appt.id).status).toBe('scheduled');
  });

  it('keeps the card state within 1024 bytes for very long services and titles', async () => {
    const appt = await book('Очень длинное название процедуры 🌸 '.repeat(8));
    const json = appointmentCardData(t.ctx.db, row(appt.id), { kind: 'reminder', title: '⏰ '.repeat(100), pressed: null });
    expect(Buffer.byteLength(json, 'utf8')).toBeLessThanOrEqual(WIDGET_MAX_DATA_BYTES);
    expect(buttonTexts(card(json))).toEqual(['✅ Приду', '🔁 Перенести']);
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
