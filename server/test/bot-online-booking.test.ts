import type Anthropic from '@anthropic-ai/sdk';
import type { Bot } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bookingOffer } from '../src/bot/booking-start.js';
import { buildClientToolHandlers } from '../src/bot/client-tools.js';
import { BotController } from '../src/bot/index.js';
import { handleContact, handleStart, SHARE_PHONE_HINT } from '../src/bot/onboarding.js';
import { BotPipeline } from '../src/bot/pipeline.js';
import { buildStablePrompt } from '../src/bot/prompt.js';
import { emptySink } from '../src/bot/tools.js';
import { createTestApp, FakeQrProvider, make, message, ScriptedAi, text, toolUse, type TestApp } from './helpers.js';
import {
  addMaster,
  auditEntries,
  bindStaffChat,
  FRIDAY_NOON,
  linkChat,
  NOW,
  pub,
  PUBLIC_URL,
  STAFF_CHAT,
  type Json,
} from './online-booking-fixtures.js';

const CHAT = 730_001;
const from = { chatId: CHAT, telegramName: 'Анна', username: 'anna' };

describe('bot: book_appointment', () => {
  let t: TestApp;
  let ai: ScriptedAi;
  let bank: FakeQrProvider;
  let pipeline: BotPipeline;
  let lobe: Json;
  let tattoo: Json;
  let fatima: Json;
  let anna: Json;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    ai = new ScriptedAi();
    bank = new FakeQrProvider();
    t = await createTestApp({ ai, qr: bank, env: { PUBLIC_URL } });
    pipeline = new BotPipeline(t.ctx, 0);
    bindStaffChat(t);
    lobe = await make(t, '/api/services', { name: 'Мочка', category: 'piercing', price: 1600, durationMin: 30 });
    tattoo = await make(t, '/api/services', { name: 'Тату мини', category: 'tattoo', price: 5000, durationMin: 60, depositAmount: 1000 });
    fatima = await addMaster(t, 'Фатима', 'fatima');
    anna = await make(t, '/api/clients', { name: 'Анна', phone: '+79991234567' });
    await linkChat(t, anna.id, CHAT);
    t.gateway.sent = [];
  });
  afterEach(async () => {
    vi.useRealTimers();
    await t.close();
  });

  const say = async (value: string) => {
    pipeline.receive(from, value);
    await pipeline.idle();
  };
  const toolResults = (call: number) =>
    (ai.calls[call]!.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[]).map((r) => ({ content: String(r.content), isError: r.is_error }));
  const appointments = async () => (await t.api('GET', '/api/appointments?from=2026-10-01T00:00:00Z&to=2026-12-31T00:00:00Z')).json().items as Json[];

  it('books the linked client through the engine and lets the AI tell them', async () => {
    ai.push(
      message([toolUse('a', 'book_appointment', { items: [{ serviceId: lobe.id }], masterId: fatima.id, startsAt: '2026-10-16 12:00', comment: 'гвоздик' })], 'tool_use'),
      message([text('Записала вас на пятницу, 16 октября, в 12:00 к Фатиме 🙌 Студия подтвердит запись.')]),
    );
    await say('Да, записывайте');
    const [result] = toolResults(1);
    const [booked] = await appointments();
    expect(result).toEqual({
      content:
        `Запись №${booked!.id} создана: 16 октября, 12:00, Мочка, мастер Фатима, стоимость 1 600 ₽. Время за клиентом, запись ждёт подтверждения ` +
        'студии — администратор подтвердит её в ближайшее время, и клиенту придёт сообщение. Скажи это клиенту простыми словами.',
      isError: false,
    });
    expect(booked).toMatchObject({ channel: 'bot', onlineState: 'awaiting_confirmation', client: { id: anna.id }, notes: 'гвоздик' });
    // The AI speaks to the client; the engine adds no «Заявка принята…» of its own.
    expect(t.gateway.textsTo(CHAT)).toEqual(['Записала вас на пятницу, 16 октября, в 12:00 к Фатиме 🙌 Студия подтвердит запись.']);
    expect(t.gateway.textsTo(STAFF_CHAT)).toEqual([
      '🆕 Онлайн-запись (бот): Анна, +79991234567, Мочка — 16 октября, 12:00, мастер Фатима · ждёт подтверждения\nКомментарий: гвоздик',
    ]);
    expect((await auditEntries(t, booked!.id))[0]).toMatchObject({ source: 'bot', employee: null, action: 'appointment.create' });
  });

  it('with a prepayment sends the payment button after the reply (also when the AI ends without text)', async () => {
    ai.push(
      message([toolUse('a', 'book_appointment', { items: [{ serviceId: tattoo.id }], startsAt: '2026-10-16 12:00' })], 'tool_use'),
      message([]),
    );
    await say('Давайте');
    expect(toolResults(1)[0]!.content).toContain('сразу после твоего ответа клиенту придёт сообщение с кнопкой «💳 Оплатить предоплату» (1 000 ₽, через СБП)');
    const toClient = t.gateway.sent.filter((m) => m.chatId === CHAT);
    expect(toClient.map((m) => m.text)).toEqual([
      'Готово! Время за вами 🙌 Осталось внести предоплату — кнопка в следующем сообщении.',
      expect.stringContaining('Время **16 октября, 12:00** за вами до 12:15'),
    ]);
    expect(toClient[1]!.keyboard).toEqual([[{ text: '💳 Оплатить предоплату', url: 'https://qr.nspk.ru/QR1?type=02&sum=100000' }]]);
    const [booked] = await appointments();
    expect(booked).toMatchObject({ onlineState: 'awaiting_payment', master: { id: 1 } }); // «any»: the lowest id when equal
  });

  it('tells the AI what went wrong: a taken time with the free ones, online booking off, an unknown chat', async () => {
    const other = await make(t, '/api/clients', { name: 'Пётр', phone: '+79990000001' });
    await make(t, '/api/appointments', { clientId: other.id, masterId: fatima.id, title: 'x', startsAt: FRIDAY_NOON, endsAt: '2026-10-16T10:00:00.000Z' });
    ai.push(
      message([
        toolUse('a', 'book_appointment', { items: [{ serviceId: lobe.id }], masterId: fatima.id, startsAt: '2026-10-16 12:00' }),
        toolUse('b', 'book_appointment', { items: [{ serviceId: lobe.id }], startsAt: 'в пятницу' }),
        toolUse('c', 'book_appointment', { items: [] , startsAt: '2026-10-16 12:00' }),
      ], 'tool_use'),
      message([text('Это время занято.')]),
    );
    await say('В пятницу в 12');
    const [taken, unparsed, empty] = toolResults(1);
    expect(taken).toEqual({
      content: 'Это время уже занято (или не подходит по длительности — 30 мин). Свободно в этот день: 11:00, 11:30, 13:00, 13:30, 14:00, 14:30, 15:00, 15:30. Предложи клиенту другое время.',
      isError: true,
    });
    expect(unparsed!.isError).toBe(true);
    expect(empty!.isError).toBe(true);

    await t.api('PUT', '/api/settings/studio', { onlineBooking: { enabled: false } });
    ai.push(message([toolUse('d', 'book_appointment', { items: [{ serviceId: lobe.id }], startsAt: '2026-10-16 14:00' })], 'tool_use'), message([text('Оформлю заявку')]));
    await say('Тогда в 14');
    expect(toolResults(3)[0]!.content).toContain('Онлайн-запись сейчас выключена студией. Оформи заявку через create_booking_request');

    await t.api('PUT', '/api/settings/studio', { onlineBooking: { enabled: true } });
    const stranger = { chatId: 730_002, telegramName: 'Гость', username: null };
    ai.push(message([toolUse('e', 'book_appointment', { items: [{ serviceId: lobe.id }], startsAt: '2026-10-16 14:00' })], 'tool_use'), message([text('Поделитесь номером')]));
    pipeline.receive(stranger, 'Запишите меня');
    await pipeline.idle();
    expect(toolResults(5)[0]!.content).toContain('Клиент не идентифицирован');
    expect(await appointments()).toHaveLength(1);
  });

  it('/bot/test checks the booking and writes nothing', async () => {
    ai.push(
      message([toolUse('a', 'book_appointment', { items: [{ serviceId: tattoo.id }], startsAt: '2026-10-16 12:00' })], 'tool_use'),
      message([text('Записала!')]),
    );
    const res = await t.api('POST', '/api/bot/test', { text: 'Запишите на тату в пятницу в 12' });
    expect(res.json().reply).toBe('Записала!\n\n— Тест: создана бы онлайн-запись: Тату мини, 2026-10-16 12:00');
    expect(toolResults(1)[0]!.content).toBe(
      'Тестовый режим: запись не создана, но для клиента всё выглядит так, будто она создана: мастер Админ, стоимость 5 000 ₽. ' +
        'Клиенту пришла бы ссылка на предоплату 1 000 ₽.',
    );
    expect(await appointments()).toEqual([]);
    expect(bank.created).toEqual([]);
    expect(t.gateway.sent).toEqual([]);
  });

  it('switches the booking rule of the prompt with the setting', async () => {
    expect(buildStablePrompt(t.ctx.db)).toContain('вызови book_appointment');
    await t.api('PUT', '/api/settings/studio', { onlineBooking: { enabled: false } });
    const off = buildStablePrompt(t.ctx.db);
    expect(off).toContain('5. Новая запись: время подтверждает администратор.');
    expect(off).not.toContain('вызови book_appointment');
  });

  it('free_slots follows the online booking step and horizon', async () => {
    await t.api('PUT', '/api/settings/studio', { onlineBooking: { stepMinutes: 60, horizonDays: 10 } });
    const scope = { mode: 'test' as const, chatId: null, clientId: null, telegramName: null, username: null, lastUserText: '' };
    const tools = buildClientToolHandlers(t.ctx, scope, emptySink());
    const friday = await tools.free_slots!({ date: '2026-10-16', serviceId: lobe.id, masterId: fatima.id });
    expect(friday.content).toContain(`• Фатима [id ${fatima.id}]: 11:00, 12:00, 13:00, 14:00, 15:00, 16:00, 17:00, 18:00, 19:00, 20:00`);
    expect(friday.content).toContain('шаг 60 мин');
    expect(await tools.free_slots!({ date: '2026-10-26', serviceId: lobe.id })).toEqual({
      content: 'Можно смотреть не дальше чем на 10 дней вперёд.',
      isError: true,
    });
  });
});

describe('bot: booking links and the Mini App button', () => {
  let t: TestApp;
  let lobe: Json;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    t = await createTestApp({ env: { PUBLIC_URL } });
    lobe = await make(t, '/api/services', { name: 'Мочка', category: 'piercing', price: 1600, durationMin: 30 });
  });
  afterEach(async () => {
    vi.useRealTimers();
    await t.close();
  });

  const book = async (phone = '+79991234567', startsAt = FRIDAY_NOON) =>
    (await pub(t, 'POST', '', { items: [{ serviceId: lobe.id }], masterId: 1, startsAt, name: 'Анна', phone })).json();

  it('/start b_<token> answers with the status and links only through the shared contact', async () => {
    const booking = await book();
    const reply = handleStart(t.ctx, from, `b_${booking.token}`);
    // A booking link proves nothing about who opens it: the chat is asked for its own phone.
    expect(reply).toEqual({
      text: `Запись №${booking.number}: 16 октября, 12:00 — Мочка, мастер Админ\nСтатус: ждёт подтверждения студии\n\n${SHARE_PHONE_HINT}`,
      linked: false,
    });
    expect((await t.api('GET', `/api/appointments/${booking.number}`)).json().client.telegramLinked).toBe(false);
    // Sharing the own contact links the card with that phone; later notices go to Telegram.
    const shared = await handleContact(t.ctx, { ...from, userId: CHAT }, { userId: CHAT, phone: '79991234567', firstName: 'Анна', lastName: undefined });
    expect(shared.linked).toBe(true);
    expect(handleStart(t.ctx, from, `b_${booking.token}`).text).toBe(
      `Анна, нашёл вашу запись ✅\n\nЗапись №${booking.number}: 16 октября, 12:00 — Мочка, мастер Админ\nСтатус: ждёт подтверждения студии\n\n` +
        'Сюда придут уведомления о ней и напоминание перед визитом.',
    );
    await t.api('POST', `/api/appointments/${booking.number}/online/confirm`);
    expect(t.gateway.textsTo(CHAT).at(-1)).toBe('✅ Запись подтверждена: 16 октября, 12:00, мастер Админ\nМочка');
  });

  it('/start b_<token> never links a chat of another client; an unknown token falls back to the greeting', async () => {
    const other = await make(t, '/api/clients', { name: 'Пётр', phone: '+79990000001' });
    await linkChat(t, other.id, 730_009);
    const fresh = await book('+79990000077');
    const reply = handleStart(t.ctx, { chatId: 730_009, telegramName: 'Пётр', username: null }, `b_${fresh.token}`);
    expect(reply).toEqual({ text: `Запись №${fresh.number}: 16 октября, 12:00 — Мочка, мастер Админ\nСтатус: ждёт подтверждения студии`, linked: true });
    expect((await t.api('GET', `/api/appointments/${fresh.number}`)).json().client.telegramLinked).toBe(false);
    expect(handleStart(t.ctx, from, 'b_unknown-token-xxxxxxxx').text).toMatch(/^Не нашёл эту запись — возможно, ссылка устарела\./);
  });

  it('offers the Mini App button under the greeting of client chats only', async () => {
    expect(bookingOffer(t.ctx, {})).toEqual({
      text: '📅 Записаться можно прямо здесь: выберите услугу, мастера и свободное время — это займёт минуту.',
      keyboard: [[{ text: '📅 Записаться онлайн', webApp: `${PUBLIC_URL}/book` }]],
    });
    expect(bookingOffer(t.ctx, { staff: true })).toBeNull();
    await t.api('PUT', '/api/settings/studio', { onlineBooking: { enabled: false } });
    expect(bookingOffer(t.ctx, {})).toBeNull();
    const plain = await createTestApp({ env: { PUBLIC_URL: 'http://localhost:3000' } });
    expect(bookingOffer(plain.ctx, {})).toBeNull(); // Telegram opens only https web apps
    await plain.close();
  });
});

describe('BotController: the booking menu button and web app buttons', () => {
  const botInfo = { id: 1, is_bot: true, first_name: 'MIKAN', username: 'mikan_test_bot' } as UserFromGetMe;

  async function controllerWith(env: Record<string, string>, setChatMenuButton: (args: unknown) => Promise<unknown>) {
    const t = await createTestApp({ env: { BOT_ENABLED: 'true', TELEGRAM_BOT_TOKEN: '123:fake', ...env } });
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
          setChatMenuButton,
          sendMessage: async (_chatId: number, _text: string, other: Record<string, unknown>) => {
            sent.push(other);
            return { message_id: sent.length };
          },
        },
      }) as unknown as Bot;
    const controller = new BotController(t.ctx, { botFactory: factory, debounceMs: 0 });
    controller.refresh();
    await new Promise((r) => setTimeout(r, 10));
    return { t, controller, sent };
  }

  it('sets the menu button to the booking Mini App at start; a failure is only logged', async () => {
    const calls: unknown[] = [];
    const { t, controller, sent } = await controllerWith({ PUBLIC_URL }, async (args) => calls.push(args));
    expect(calls).toEqual([{ menu_button: { type: 'web_app', text: '📅 Записаться', web_app: { url: `${PUBLIC_URL}/book` } } }]);
    await controller.sendText(1, 'Записаться', { keyboard: [[{ text: '📅 Записаться онлайн', webApp: `${PUBLIC_URL}/book` }]] });
    expect(sent[0]!.reply_markup).toEqual({ inline_keyboard: [[{ text: '📅 Записаться онлайн', web_app: { url: `${PUBLIC_URL}/book` } }]] });
    await controller.stop();
    await t.close();

    const failing = await controllerWith({ PUBLIC_URL }, async () => {
      throw new Error('Bad Request');
    });
    expect(failing.controller.isRunning()).toBe(true);
    await failing.controller.stop();
    await failing.t.close();

    // No https PUBLIC_URL: the default menu (resets a booking button left from before).
    const none: unknown[] = [];
    const without = await controllerWith({}, async (args) => none.push(args));
    expect(none).toEqual([{ menu_button: { type: 'default' } }]);
    await without.controller.stop();
    await without.t.close();
  });

  it('shows the default menu while online booking is off and the Mini App once it is back on', async () => {
    const calls: unknown[] = [];
    const { t, controller } = await controllerWith({ PUBLIC_URL }, async (args) => calls.push(args));
    // The app talks to the fake gateway; hand the menu refresh to the real controller under test.
    t.gateway.refreshBookingMenu = () => controller.refreshBookingMenu();
    calls.length = 0;
    expect((await t.api('PUT', '/api/settings/studio', { onlineBooking: { enabled: false } })).statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toEqual([{ menu_button: { type: 'default' } }]);
    expect((await t.api('PUT', '/api/settings/studio', { onlineBooking: { enabled: true } })).statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.at(-1)).toEqual({ menu_button: { type: 'web_app', text: '📅 Записаться', web_app: { url: `${PUBLIC_URL}/book` } } });
    await controller.stop();
    await t.close();
  });
});
