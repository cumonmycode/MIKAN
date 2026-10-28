import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotSendError } from '../src/bot/gateway.js';
import { handleContact, handleStaffCommand, handleStart } from '../src/bot/onboarding.js';
import { BotPipeline } from '../src/bot/pipeline.js';
import { MAX_ATTEMPTS, processDueMessages } from '../src/bot/sender.js';
import { issueStaffCode, notifyStaff } from '../src/bot/staff.js';
import { storeMessage, upsertChat } from '../src/domain/bot-chats.js';
import { blocked, createTestApp, make, type TestApp } from './helpers.js';

const CHAT = 800_001;
const STAFF = -42;

describe('bot chats API, staff chat, onboarding and scheduled sender', () => {
  let t: TestApp;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-10-15T09:00:00.000Z'));
    t = await createTestApp();
  });
  afterEach(async () => {
    await t.close();
    vi.useRealTimers();
  });

  it('lists chats, pages messages, marks read, and refuses staff replies while the bot is off', async () => {
    upsertChat(t.ctx.db, CHAT, { telegramName: 'Ольга', username: 'olga' });
    for (let i = 1; i <= 5; i++) storeMessage(t.ctx.db, CHAT, 'user', `m${i}`, { bumpUnread: true });
    upsertChat(t.ctx.db, CHAT + 1, { telegramName: 'Старый' });
    vi.setSystemTime(Date.parse('2026-10-15T10:00:00.000Z'));
    storeMessage(t.ctx.db, CHAT, 'assistant', 'ответ');

    const chats = (await t.api('GET', '/api/bot/chats')).json().items;
    expect(chats.map((c: { chatId: number }) => c.chatId)).toEqual([CHAT, CHAT + 1]);
    expect(chats[0]).toMatchObject({ unreadCount: 5, lastMessage: { role: 'assistant', text: 'ответ' }, updatedAt: '2026-10-15T10:00:00.000Z' });
    expect(chats[1].lastMessage).toBeNull();

    const latest = (await t.api('GET', `/api/bot/chats/${CHAT}/messages?limit=2`)).json().items;
    expect(latest.map((m: { text: string }) => m.text)).toEqual(['m5', 'ответ']);
    const before = (await t.api('GET', `/api/bot/chats/${CHAT}/messages?beforeId=${latest[0].id}&limit=3`)).json().items;
    expect(before.map((m: { text: string }) => m.text)).toEqual(['m2', 'm3', 'm4']);
    expect((await t.api('GET', '/api/bot/chats/1/messages')).statusCode).toBe(404);

    const read = await t.api('POST', `/api/bot/chats/${CHAT}/read`);
    expect(read.statusCode).toBe(204);
    expect((await t.api('GET', '/api/badges')).json().unreadChats).toBe(0);

    t.gateway.running = false;
    const off = await t.api('POST', `/api/bot/chats/${CHAT}/messages`, { text: 'Привет' });
    expect(off.statusCode).toBe(409);
    expect(off.json().error.message).toMatch(/Telegram-бот выключен/);
    t.gateway.running = true;
    t.gateway.failures.push(blocked());
    const blockedRes = await t.api('POST', `/api/bot/chats/${CHAT}/messages`, { text: 'Привет' });
    expect(blockedRes.json().error).toEqual({ code: 'conflict', message: 'Клиент заблокировал бота — сообщение не доставлено' });
    t.gateway.failures.push(new BotSendError('timeout', false));
    expect((await t.api('POST', `/api/bot/chats/${CHAT}/messages`, { text: 'Привет' })).statusCode).toBe(500);
    expect((await t.api('PATCH', '/api/bot/chats/1', { aiPaused: true })).statusCode).toBe(404);
  });

  it('binds the staff chat with a fresh 6-digit code and reports it in bot settings', async () => {
    const res = await t.api('POST', '/api/bot/staff-code');
    const { code, expiresAt, instruction } = res.json();
    expect(code).toMatch(/^[A-HJKMNP-Z2-9]{10}$/);
    expect(expiresAt).toBe('2026-10-15T09:15:00.000Z');
    expect(instruction).toBe(`Добавьте бота @mikan_test_bot в рабочий чат и отправьте: /staff ${code}`);
    expect(await notifyStaff(t.ctx, 'тест')).toBe(false);

    expect(handleStaffCommand(t.ctx, STAFF, '000000')).toMatch(/^❌/);
    vi.setSystemTime(Date.parse('2026-10-15T09:16:00.000Z'));
    expect(handleStaffCommand(t.ctx, STAFF, code)).toMatch(/^❌/);
    const fresh = issueStaffCode(t.ctx.db);
    expect(handleStaffCommand(t.ctx, STAFF, fresh.code.toLowerCase())).toMatch(/^✅/);
    expect(handleStaffCommand(t.ctx, STAFF, fresh.code)).toMatch(/^❌/); // single use

    expect(await notifyStaff(t.ctx, 'тест')).toBe(true);
    expect(t.gateway.textsTo(STAFF)).toEqual(['тест']);
    const settings = (await t.api('GET', '/api/settings/bot')).json();
    expect(settings).toMatchObject({ staffChatBound: true, botUsername: 'mikan_test_bot', aiConfigured: false, enabled: true, aftercareHour: 12 });
  });

  it('burns the staff code after 5 wrong guesses (review #8)', async () => {
    const { code } = issueStaffCode(t.ctx.db);
    for (let i = 0; i < 4; i++) expect(handleStaffCommand(t.ctx, 999, 'WRONGCODE1')).toMatch(/^❌ Код неверный/);
    expect(handleStaffCommand(t.ctx, 999, 'WRONGCODE1')).toMatch(/^❌ Слишком много неверных попыток/);
    expect(handleStaffCommand(t.ctx, STAFF, code)).toMatch(/^❌/); // the real code no longer works
    expect((await t.api('GET', '/api/settings/bot')).json().staffChatBound).toBe(false);
  });

  it('links via /start deep link and via a shared contact; notifies staff about new clients', async () => {
    const { code } = issueStaffCode(t.ctx.db);
    handleStaffCommand(t.ctx, STAFF, code);
    const from = { chatId: CHAT, telegramName: 'Ольга', username: 'olga' };

    const plain = handleStart(t.ctx, from, '');
    expect(plain).toEqual({ text: expect.stringContaining('Здравствуйте!'), linked: false });
    expect(handleStart(t.ctx, from, 'cbad-token-123').text).toMatch(/^Ссылка для подключения устарела/);

    const foreign = await handleContact(t.ctx, { ...from, userId: CHAT }, { userId: 123, phone: '+79990001111', firstName: 'X', lastName: undefined });
    expect(foreign.text).toMatch(/своим номером/);

    const created = await handleContact(t.ctx, { ...from, userId: CHAT }, { userId: CHAT, phone: '79990001111', firstName: 'Ольга', lastName: 'Ли' });
    expect(created).toEqual({ text: 'Спасибо, Ольга! Номер сохранён ✅ Чем могу помочь?', linked: true, cardLinked: true });
    const client = (await t.api('GET', '/api/clients?search=Ольга')).json().items[0];
    expect(client).toMatchObject({
      name: 'Ольга', lastName: 'Ли', phone: '+79990001111', source: 'telegram', telegramLinked: true, telegramUsername: 'olga',
    });
    expect(t.gateway.textsTo(STAFF)).toEqual(['👤 Новый клиент через бота: Ольга Ли, +79990001111 (@olga)']);
    expect((await t.api('GET', '/api/bot/chats')).json().items[0].client).toMatchObject({ id: client.id, telegramLinked: true });

    // A staff-created client links through the deep link; the chat moves to them.
    const ivan = await make(t, '/api/clients', { name: 'Иван', phone: '+79995556677' });
    const url = (await t.api('POST', `/api/clients/${ivan.id}/telegram-link`)).json().url as string;
    const linked = handleStart(t.ctx, from, new URL(url).searchParams.get('start')!);
    expect(linked).toEqual({ text: expect.stringContaining('Иван, ваш Telegram подключён к MIKAN STUDIO ✅'), linked: true, cardLinked: true });
    expect((await t.api('GET', `/api/clients/${client.id}`)).json().telegramLinked).toBe(false);
    expect((await t.api('GET', `/api/clients/${ivan.id}`)).json().telegramLinked).toBe(true);
    expect(handleStart(t.ctx, from, new URL(url).searchParams.get('start')!).text).toMatch(/устарела/); // token is single use

    // Shared contact of an existing client links that client.
    const existing = await handleContact(t.ctx, { ...from, userId: CHAT }, { userId: CHAT, phone: '+7 999 555-66-77', firstName: 'Ваня', lastName: undefined });
    expect(existing.text).toMatch(/^Спасибо, Иван! Номер подтверждён/);
    expect(await handleContact(t.ctx, { ...from, userId: CHAT }, { userId: CHAT, phone: '12', firstName: 'X', lastName: undefined })).toMatchObject({ linked: true });
  });

  it('sends due aftercare/reminders, stores them as system messages, handles blocked/retry/disabled', async () => {
    // Without the healing check-in (bot-follow-ups.test.ts covers it), so only the memo steps are queued.
    const service = await make(t, '/api/services', {
      name: 'Прокол', category: 'piercing', price: 2500, durationMin: 30, aftercareTemplateId: 2, healingCheckDays: null,
    });
    const client = await make(t, '/api/clients', { name: 'Иван', phone: '+79991234567' });
    const url = (await t.api('POST', `/api/clients/${client.id}/telegram-link`)).json().url as string;
    handleStart(t.ctx, { chatId: CHAT, telegramName: 'Иван', username: null }, new URL(url).searchParams.get('start')!);
    const appt = await make(t, '/api/appointments', { clientId: client.id, masterId: 1, serviceId: service.id, startsAt: '2026-10-15T08:00:00Z' });
    expect((await t.api('POST', `/api/appointments/${appt.id}/complete`, { sendAftercare: true })).json().scheduledMessages).toBe(6);

    t.gateway.running = false;
    expect(await processDueMessages(t.ctx, Date.parse('2026-10-15T10:00:00Z'))).toEqual({ sent: 0, failed: 0, cancelled: 0, retried: 0 });
    t.gateway.running = true;

    // Day 0 (09:05Z) is due; day 1 (Oct 16 09:00Z) is not.
    expect(await processDueMessages(t.ctx, Date.parse('2026-10-15T10:00:00Z'))).toMatchObject({ sent: 1 });
    expect(t.gateway.textsTo(CHAT).at(-1)).toMatch(/^MIKAN STUDIO · уход после процедуры\n\nПрокол сделан!/);
    const history = (await t.api('GET', `/api/bot/chats/${CHAT}/messages`)).json().items;
    expect(history.at(-1)).toMatchObject({ role: 'system', text: expect.stringMatching(/^MIKAN STUDIO · уход после процедуры/) });
    const sent = (await t.api('GET', '/api/bot/scheduled?status=sent')).json().items;
    expect(sent).toHaveLength(1);
    expect(sent[0].sentAt).not.toBeNull();

    // Day 1: transient error → retried until MAX_ATTEMPTS, then failed.
    const day1 = Date.parse('2026-10-16T09:00:01Z');
    for (let i = 0; i < MAX_ATTEMPTS; i++) t.gateway.failures.push(new BotSendError('timeout', false));
    expect(await processDueMessages(t.ctx, day1)).toMatchObject({ retried: 1 });
    expect(await processDueMessages(t.ctx, day1)).toMatchObject({ retried: 1 });
    expect(await processDueMessages(t.ctx, day1)).toMatchObject({ failed: 1 });
    const failed = (await t.api('GET', '/api/bot/scheduled?status=failed')).json().items;
    expect(failed[0]).toMatchObject({ status: 'failed', error: 'timeout' });

    // Day 3: blocked → failed immediately.
    t.gateway.failures.push(blocked());
    expect(await processDueMessages(t.ctx, Date.parse('2026-10-18T09:00:01Z'))).toMatchObject({ failed: 1 });

    // Manual cancel, then the client turns the bot off → remaining are cancelled.
    const pending = (await t.api('GET', '/api/bot/scheduled?status=pending')).json().items;
    expect(pending).toHaveLength(3);
    const cancel = await t.api('POST', `/api/bot/scheduled/${pending[0].id}/cancel`);
    expect(cancel.json().status).toBe('cancelled');
    expect((await t.api('POST', `/api/bot/scheduled/${pending[0].id}/cancel`)).statusCode).toBe(409);
    expect((await t.api('POST', '/api/bot/scheduled/999/cancel')).statusCode).toBe(404);
    await t.api('PATCH', `/api/clients/${client.id}`, { botEnabled: false });
    expect(await processDueMessages(t.ctx, Date.parse('2026-12-01T00:00:00Z'))).toMatchObject({ cancelled: 2 });
    expect((await t.api('GET', '/api/bot/scheduled?status=pending')).json().items).toHaveLength(0);
  });

  it('cancels reminders whose appointment is no longer active when they come due', async () => {
    const client = await make(t, '/api/clients', { name: 'Иван', phone: '+79990000105' });
    const url = (await t.api('POST', `/api/clients/${client.id}/telegram-link`)).json().url as string;
    handleStart(t.ctx, { chatId: CHAT, telegramName: 'Иван', username: null }, new URL(url).searchParams.get('start')!);
    const appt = await make(t, '/api/appointments', { clientId: client.id, masterId: 1, startsAt: '2026-10-17T11:00:00Z', endsAt: '2026-10-17T12:00:00Z' });
    const reminder = (await t.api('GET', '/api/bot/scheduled?status=pending')).json().items[0];
    expect(reminder.kind).toBe('reminder');
    // Simulate a stale pending reminder for an appointment that was moved into the past.
    t.ctx.sqlite.prepare('update appointments set starts_at = ? where id = ?').run(Date.parse('2026-10-16T10:00:00Z'), appt.id);
    expect(await processDueMessages(t.ctx, Date.parse('2026-10-16T11:00:00Z'))).toMatchObject({ cancelled: 1 });
  });

  it('collapses rapid messages into a single AI run per chat', async () => {
    const pipeline = new BotPipeline(t.ctx, 20);
    pipeline.receive({ chatId: CHAT, telegramName: 'A', username: null }, 'раз');
    pipeline.receive({ chatId: CHAT, telegramName: 'A', username: null }, 'два');
    vi.useRealTimers();
    await pipeline.idle();
    // AI not configured → a single "administrator will reply" message.
    expect(t.gateway.textsTo(CHAT)).toHaveLength(1);
  });
});
