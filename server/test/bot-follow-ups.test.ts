import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleCallback } from '../src/bot/callbacks.js';
import { FOLLOW_UP_REPLIES } from '../src/bot/follow-ups.js';
import { handleStaffCommand, handleStart } from '../src/bot/onboarding.js';
import { BotPipeline } from '../src/bot/pipeline.js';
import { processDueMessages } from '../src/bot/sender.js';
import { issueStaffCode } from '../src/bot/staff.js';
import { clients } from '../src/db/schema.js';
import { getStudioSettings, saveStudioSettings, type StudioSettings } from '../src/domain/settings.js';
import { createTestApp, make, message, openShift, ScriptedAi, text, type TestApp } from './helpers.js';

const NOW = Date.parse('2026-10-15T09:00:00.000Z'); // Thu 12:00 Moscow
const CHAT = 740_001;
const STAFF = -740;
const from = { chatId: CHAT, telegramName: 'Иван', username: 'ivanp' };
const stranger = { chatId: CHAT + 9, telegramName: 'Чужой', username: null };

type Scheduled = { id: number; kind: string; appointmentId: number; sendAt: string; status: string; text: string; error: string | null };

describe('bot: follow-ups after a visit', () => {
  let t: TestApp;
  let ai: ScriptedAi;
  let pipeline: BotPipeline;
  let client: { id: number };
  let helix: { id: number };
  let tragus: { id: number };

  const link = async (clientId: number, chat = from) => {
    const url = (await t.api('POST', `/api/clients/${clientId}/telegram-link`)).json().url as string;
    handleStart(t.ctx, chat, new URL(url).searchParams.get('start')!);
  };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    ai = new ScriptedAi();
    t = await createTestApp({ ai });
    await openShift(t);
    pipeline = new BotPipeline(t.ctx, 0);
    handleStaffCommand(t.ctx, STAFF, issueStaffCode(t.ctx.db).code);
    client = await make(t, '/api/clients', { name: 'Иван', phone: '+79991234567' });
    await link(client.id);
    helix = await make(t, '/api/services', { name: 'Хеликс', category: 'piercing', price: 3000, durationMin: 30, freshProcedure: true, jewelryChangeWeeks: 6 });
    tragus = await make(t, '/api/services', {
      name: 'Трагус', category: 'piercing', price: 3500, durationMin: 30, freshProcedure: true, healingCheckDays: 10, jewelryChangeWeeks: 8,
    });
  });
  afterEach(async () => {
    await t.close();
    vi.useRealTimers();
  });

  const scheduled = async (status = 'pending') =>
    ((await t.api('GET', `/api/bot/scheduled?status=${status}`)).json().items as Scheduled[]).filter((m) => m.kind !== 'aftercare' && m.kind !== 'reminder');
  const book = (services: Array<{ id: number }>, clientId = client.id) =>
    make(t, '/api/appointments', { clientId, masterId: 1, services: services.map((s) => ({ serviceId: s.id })), startsAt: '2026-10-15T07:00:00Z', force: true });
  const complete = async (id: number, body: Record<string, unknown> = {}) =>
    (await t.api('POST', `/api/appointments/${id}/complete`, { sendAftercare: true, ...body })).json();
  const press = (data: string, messageId: number | null, chat: typeof from | typeof stranger = from) =>
    handleCallback({ ctx: t.ctx, pipeline }, { from: chat, data, message: messageId === null ? null : { messageId, isPhoto: false } });
  const history = async () =>
    (await t.api('GET', `/api/bot/chats/${CHAT}/messages`)).json().items.map((m: { role: string; text: string }) => `${m.role}:${m.text}`);
  const setReviewLinks = (reviewLinks: Record<string, string>) =>
    saveStudioSettings(t.ctx.db, { ...getStudioSettings(t.ctx.db), reviewLinks } as StudioSettings);

  it('schedules one of each at aftercareHour: the largest days, the smallest weeks; never twice per visit', async () => {
    const appt = await book([helix, tragus]);
    // The memo switch of the app does not concern them; the memo count stays the memo count.
    expect((await complete(appt.id, { sendAftercare: false })).scheduledMessages).toBe(0);
    expect((await scheduled()).map(({ kind, sendAt, text: body, appointmentId }) => ({ kind, sendAt, text: body, appointmentId }))).toEqual([
      {
        kind: 'healing_check',
        sendAt: '2026-10-25T09:00:00.000Z', // 10 days later, 12:00 Moscow
        text: 'Здравствуйте, Иван! Прошло 10 дней после процедур «Хеликс» и «Трагус». Как заживает? 🙂',
        appointmentId: appt.id,
      },
      {
        kind: 'jewelry_change',
        sendAt: '2026-11-26T09:00:00.000Z', // 6 weeks later
        text: 'Иван, прошло 6 недель после проколов «Хеликс» и «Трагус» — самое время заменить украшение на подходящее по размеру. Записаться?',
        appointmentId: appt.id,
      },
    ]);

    // Completing again (or after staff cancelled one) schedules nothing new.
    const [healing] = await scheduled();
    await t.api('POST', `/api/bot/scheduled/${healing!.id}/cancel`);
    await complete(appt.id);
    expect((await scheduled()).map((m) => m.kind)).toEqual(['jewelry_change']);

    // The hour follows the bot settings; a visit with one service names it alone.
    await t.api('PUT', '/api/settings/bot', { aftercareHour: 15 });
    const single = await book([helix]);
    await complete(single.id);
    expect((await scheduled()).filter((m) => m.appointmentId === single.id).map((m) => [m.kind, m.sendAt, m.text])).toEqual([
      ['healing_check', '2026-10-22T12:00:00.000Z', 'Здравствуйте, Иван! Прошла неделя после процедуры «Хеликс». Как заживает? 🙂'],
      ['jewelry_change', '2026-11-26T12:00:00.000Z', expect.stringMatching(/^Иван, прошло 6 недель после прокола «Хеликс» — /)],
    ]);
  });

  it('schedules nothing without Telegram, with the bot off for the client or for the studio, or without settings', async () => {
    const offline = await make(t, '/api/clients', { name: 'Пётр', phone: '+79990000001' });
    await complete((await book([helix], offline.id)).id);

    const swap = await make(t, '/api/services', { name: 'Замена украшения', category: 'piercing', price: 500, durationMin: 15 });
    await complete((await book([swap])).id);

    await t.api('PATCH', `/api/clients/${client.id}`, { botEnabled: false });
    await complete((await book([helix])).id);
    await t.api('PATCH', `/api/clients/${client.id}`, { botEnabled: true });

    await t.api('PUT', '/api/settings/bot', { enabled: false });
    await complete((await book([helix])).id);
    expect(await scheduled()).toEqual([]);
  });

  it('a sale that completes the visit schedules them too; paying a completed visit adds nothing', async () => {
    const appt = await book([helix]);
    const sale = await t.api('POST', '/api/sales', {
      appointmentId: appt.id,
      items: [{ type: 'service', serviceId: helix.id, quantity: 1 }],
      discount: 0,
      payments: { cash: 0, card: 3000, transfer: 0 },
    });
    expect(sale.statusCode).toBe(200);
    expect((await scheduled()).map((m) => [m.kind, m.appointmentId, m.sendAt])).toEqual([
      ['healing_check', appt.id, '2026-10-22T09:00:00.000Z'],
      ['jewelry_change', appt.id, '2026-11-26T09:00:00.000Z'],
    ]);

    const done = await book([tragus]);
    await complete(done.id);
    for (const m of (await scheduled()).filter((x) => x.appointmentId === done.id)) await t.api('POST', `/api/bot/scheduled/${m.id}/cancel`);
    const paid = await t.api('POST', '/api/sales', {
      appointmentId: done.id,
      items: [{ type: 'service', serviceId: tragus.id, quantity: 1 }],
      discount: 0,
      payments: { cash: 0, card: 3500, transfer: 0 },
    });
    expect(paid.statusCode).toBe(200);
    expect((await scheduled()).filter((m) => m.appointmentId === done.id)).toEqual([]);
  });

  it('sends the healing check with its buttons; «👍 Всё хорошо» thanks and offers the review links, no AI', async () => {
    const appt = await book([helix]);
    await complete(appt.id);
    expect(await processDueMessages(t.ctx, Date.parse('2026-10-22T09:00:01Z'))).toMatchObject({ sent: 1 });
    const check = t.gateway.sent.at(-1)!;
    expect(check).toMatchObject({ chatId: CHAT, text: 'Здравствуйте, Иван! Прошла неделя после процедуры «Хеликс». Как заживает? 🙂' });
    expect(check.keyboard).toEqual([[{ text: '👍 Всё хорошо', data: `ho:${appt.id}` }, { text: '🤔 Есть вопрос', data: `hq:${appt.id}` }]]);

    setReviewLinks({ yandex: ' https://yandex.ru/maps/org/mikan/1 ', twogis: 'не ссылка', google: 'https://g.page/mikan' });
    expect(await press(`ho:${appt.id}`, check.messageId)).toEqual({ text: 'Спасибо! 🙌' });
    expect(t.gateway.edits.at(-1)).toEqual({ kind: 'keyboard', chatId: CHAT, messageId: check.messageId, keyboard: null });
    expect(t.gateway.sent.at(-1)).toMatchObject({
      chatId: CHAT,
      text: FOLLOW_UP_REPLIES.healingOkReview,
      keyboard: [[{ text: '⭐ Яндекс Карты', url: 'https://yandex.ru/maps/org/mikan/1' }], [{ text: '⭐ Google', url: 'https://g.page/mikan' }]],
    });
    expect((await history()).slice(-3)).toEqual([
      'system:Здравствуйте, Иван! Прошла неделя после процедуры «Хеликс». Как заживает? 🙂',
      'user:[Кнопка] 👍 Всё хорошо',
      `assistant:${FOLLOW_UP_REPLIES.healingOkReview}`,
    ]);

    // No links (or none set yet): just the thanks. A button Telegram no longer shows answers with a new message.
    setReviewLinks({ yandex: '', twogis: '', google: '' });
    expect(await press(`ho:${appt.id}`, null)).toEqual({ text: 'Спасибо! 🙌' });
    expect(t.gateway.sent.at(-1)).toEqual({ chatId: CHAT, text: FOLLOW_UP_REPLIES.healingOk, messageId: expect.any(Number) });
    expect(ai.calls).toHaveLength(0);
    expect(t.gateway.textsTo(STAFF)).toEqual([]);
  });

  it('«🤔 Есть вопрос» asks for a photo, flags the chat and tells the staff chat', async () => {
    const appt = await book([helix]);
    await complete(appt.id);
    await processDueMessages(t.ctx, Date.parse('2026-10-22T09:00:01Z'));
    const check = t.gateway.sent.at(-1)!;

    expect(await press(`hq:${appt.id}`, check.messageId)).toEqual({ text: 'Передали мастеру 🙏' });
    expect(t.gateway.edits.at(-1)).toMatchObject({ kind: 'keyboard', keyboard: null });
    expect((await history()).slice(-2)).toEqual(['user:[Кнопка] 🤔 Есть вопрос по заживлению', `assistant:${FOLLOW_UP_REPLIES.healingQuestion}`]);
    const chat = (await t.api('GET', '/api/bot/chats')).json().items.find((c: { chatId: number }) => c.chatId === CHAT);
    expect(chat.needsAttention).toBe(true);
    expect(t.gateway.textsTo(STAFF).at(-1)).toBe(`🩹 Иван: вопрос по заживлению после «Хеликс», запись №${appt.id}`);
    expect(ai.calls).toHaveLength(0);
  });

  it('jewelry change: «Позже» answers by itself and keeps «📅 Записаться», which hands the booking to the AI', async () => {
    const appt = await book([helix]);
    await complete(appt.id);
    expect(await processDueMessages(t.ctx, Date.parse('2026-11-26T09:00:01Z'))).toMatchObject({ sent: 2 }); // the check and the change
    const change = t.gateway.sent.at(-1)!;
    expect(change.text).toMatch(/^Иван, прошло 6 недель после прокола «Хеликс»/);
    expect(change.keyboard).toEqual([[{ text: '📅 Записаться', data: `cb:${appt.id}` }, { text: 'Позже', data: `cl:${appt.id}` }]]);

    expect(await press(`cl:${appt.id}`, change.messageId)).toEqual({ text: 'Хорошо 🙂' });
    expect(t.gateway.edits.at(-1)).toEqual({
      kind: 'keyboard', chatId: CHAT, messageId: change.messageId, keyboard: [[{ text: '📅 Записаться', data: `cb:${appt.id}` }]],
    });
    expect((await history()).slice(-2)).toEqual(['user:[Кнопка] Позже', `assistant:${FOLLOW_UP_REPLIES.later}`]);
    expect(ai.calls).toHaveLength(0);

    ai.push(message([text('Отлично! Когда вам удобно прийти?')]));
    expect(await press(`cb:${appt.id}`, change.messageId)).toEqual({ text: 'Подберём время 🙌' });
    await pipeline.idle();
    expect(t.gateway.edits.at(-1)).toMatchObject({ kind: 'keyboard', keyboard: null });
    expect(JSON.stringify(ai.calls[0]!.messages)).toContain('[Кнопка] 📅 Хочу записаться на замену украшения после «Хеликс»');
    expect(t.gateway.textsTo(CHAT).at(-1)).toBe('Отлично! Когда вам удобно прийти?');
  });

  it('only the client of the visit, in the chat linked to their card, can use the buttons', async () => {
    const other = await make(t, '/api/clients', { name: 'Пётр', phone: '+79990000002' });
    const theirs = await book([helix], other.id);
    await complete(theirs.id);
    const mine = await book([helix]);
    await complete(mine.id);
    const sentBefore = t.gateway.sent.length;

    expect(await press(`ho:${mine.id}`, 55, stranger)).toEqual({ text: 'Эта кнопка уже неактуальна' });
    expect(t.gateway.edits.at(-1)).toEqual({ kind: 'keyboard', chatId: stranger.chatId, messageId: 55, keyboard: null });
    expect(await press(`hq:${theirs.id}`, null)).toEqual({ text: 'Эта кнопка уже неактуальна' });
    expect(await press(`cb:999`, null)).toEqual({ text: 'Эта кнопка уже неактуальна' });
    expect(t.gateway.sent.length).toBe(sentBefore);
    expect((await history()).filter((m: string) => !m.startsWith('system:'))).toEqual([]); // only the «Telegram подключён» note
    expect(ai.calls).toHaveLength(0);
  });

  it('cancels pending follow-ups when the client turns the bot off or the chat moves to another card', async () => {
    await complete((await book([helix])).id);
    await t.api('PATCH', `/api/clients/${client.id}`, { botEnabled: false });
    expect(await scheduled()).toEqual([]);
    expect((await scheduled('cancelled')).map((m) => [m.kind, m.error])).toEqual([
      ['healing_check', 'Клиент отключил сообщения бота'],
      ['jewelry_change', 'Клиент отключил сообщения бота'],
    ]);

    await t.api('PATCH', `/api/clients/${client.id}`, { botEnabled: true });
    const second = await book([tragus]);
    await complete(second.id);
    expect(await scheduled()).toHaveLength(2);
    const anna = await make(t, '/api/clients', { name: 'Анна', phone: '+79990000003' });
    await link(anna.id); // the same Telegram chat now belongs to Anna
    expect(await scheduled()).toEqual([]);
    expect((await scheduled('cancelled')).filter((m) => m.appointmentId === second.id).map((m) => m.error)).toEqual([
      'Клиент отвязал Telegram',
      'Клиент отвязал Telegram',
    ]);
  });

  it('the sender skips follow-ups of a reopened visit or a client without a linked chat', async () => {
    const reopened = await book([helix]);
    await complete(reopened.id);
    await t.api('PATCH', `/api/appointments/${reopened.id}`, { status: 'confirmed', force: true });
    const unlinked = await book([tragus]);
    await complete(unlinked.id);
    t.ctx.db.update(clients).set({ telegramChatId: null }).where(eq(clients.id, client.id)).run();

    expect(await processDueMessages(t.ctx, Date.parse('2027-01-01T00:00:00Z'))).toMatchObject({ sent: 0, cancelled: 4 });
    const reasons = (await scheduled('cancelled')).map((m) => [m.appointmentId, m.error]);
    expect(reasons).toContainEqual([reopened.id, 'Клиент отвязал Telegram']);
    expect(reasons).toContainEqual([unlinked.id, 'Клиент отвязал Telegram']);

    // With the chat linked again, a reopened visit still sends nothing.
    await link(client.id);
    const again = await book([helix]);
    await complete(again.id);
    await t.api('PATCH', `/api/appointments/${again.id}`, { status: 'confirmed', force: true });
    expect(await processDueMessages(t.ctx, Date.parse('2027-01-01T00:00:00Z'))).toMatchObject({ sent: 0, cancelled: 2 });
    expect((await scheduled('cancelled')).filter((m) => m.appointmentId === again.id).map((m) => m.error)).toEqual([
      'Визит больше не завершён',
      'Визит больше не завершён',
    ]);
  });
});
