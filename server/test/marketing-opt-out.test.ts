import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeCallback, encodeCallback } from '../src/bot/callback-data.js';
import { handleCallback } from '../src/bot/callbacks.js';
import { MARKETING_REPLIES } from '../src/bot/marketing.js';
import { BotPipeline } from '../src/bot/pipeline.js';
import { upsertChat, setChatEmployee } from '../src/domain/bot-chats.js';
import { createTestApp, message, ScriptedAi, text, type TestApp } from './helpers.js';
import { addClient } from './retention-fixtures.js';

const NOW = Date.parse('2026-10-19T09:00:00.000Z');
const CHAT = 7001;
const from = { chatId: CHAT, telegramName: 'Анна', username: 'anna' };

describe('news opt-out', () => {
  let t: TestApp;
  let ai: ScriptedAi;
  let pipeline: BotPipeline;
  let anna: { id: number };

  const press = (data: string, chat = from, messageId: number | null = 555) =>
    handleCallback({ ctx: t.ctx, pipeline }, { from: chat, data, message: messageId === null ? null : { messageId, isPhoto: false } });
  const card = async () => (await t.api('GET', `/api/clients/${anna.id}`)).json();
  const history = async () =>
    (await t.api('GET', `/api/bot/chats/${CHAT}/messages`)).json().items.map((m: { role: string; text: string }) => `${m.role}:${m.text}`);
  const audience = async () => (await t.api('POST', '/api/campaigns/preview', { segment: {} })).json().count as number;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    ai = new ScriptedAi();
    t = await createTestApp({ ai });
    pipeline = new BotPipeline(t.ctx, 0);
    anna = await addClient(t, 'Анна', { lastName: 'Иванова', chatId: CHAT });
    upsertChat(t.ctx.db, CHAT, { telegramName: 'Анна', username: 'anna' });
  });
  afterEach(async () => {
    await pipeline.idle();
    await t.close();
    vi.useRealTimers();
  });

  it('button payloads are short tags without arguments', () => {
    expect(encodeCallback({ kind: 'marketingOptOut' })).toBe('mo');
    expect(encodeCallback({ kind: 'marketingOptIn' })).toBe('mi');
    expect(encodeCallback({ kind: 'marketingBook' })).toBe('mb');
    expect(decodeCallback('mo')).toEqual({ kind: 'marketingOptOut' });
    expect(decodeCallback('mi')).toEqual({ kind: 'marketingOptIn' });
    expect(decodeCallback('mb')).toEqual({ kind: 'marketingBook' });
    expect(decodeCallback('mo:1')).toBeNull();
  });

  it('«🔕 Не присылать новости» opts the client out; «Снова получать новости» brings them back', async () => {
    expect((await card()).marketingOptOut).toBe(false);
    expect(await audience()).toBe(1);

    expect(await press('mo')).toEqual({ text: 'Больше не пришлём новостей' });
    expect((await card()).marketingOptOut).toBe(true);
    expect(await audience()).toBe(0);
    expect(t.gateway.sent.at(-1)).toEqual({
      chatId: CHAT,
      text: MARKETING_REPLIES.optedOut,
      messageId: expect.any(Number),
      keyboard: [[{ text: '🔔 Снова получать новости', data: 'mi' }]],
    });
    expect(await history()).toEqual(['user:[Кнопка] 🔕 Не присылать новости', `assistant:${MARKETING_REPLIES.optedOut}`]);

    // Pressing it again only confirms.
    await press('mo');
    expect((await card()).marketingOptOut).toBe(true);

    expect(await press('mi', from, 777)).toEqual({ text: 'Готово 💛' });
    expect((await card()).marketingOptOut).toBe(false);
    expect(t.gateway.edits).toContainEqual({ kind: 'keyboard', chatId: CHAT, messageId: 777, keyboard: null });
    expect(t.gateway.textsTo(CHAT).at(-1)).toBe(MARKETING_REPLIES.optedIn);
    expect(await audience()).toBe(1);
    expect(ai.calls).toHaveLength(0);

    const entries = (await t.api('GET', `/api/audit?entity=client&entityId=${anna.id}&source=bot`)).json().items;
    expect(entries.map((e: { action: string; summary: string }) => [e.action, e.summary]).reverse()).toEqual([
      ['client.marketing_opt_out', 'Клиент «Анна Иванова» отказался от новостей и предложений в боте'],
      ['client.marketing_opt_in', 'Клиент «Анна Иванова» снова получает новости и предложения (в боте)'],
    ]);
  });

  it('works only in a chat linked to a client card', async () => {
    upsertChat(t.ctx.db, 4242, { telegramName: 'Админ', username: null });
    setChatEmployee(t.ctx.db, 4242, 1);
    expect(await press('mo', { chatId: 4242, telegramName: 'Админ', username: null })).toEqual({ text: 'Эта кнопка работает в чатах клиентов' });
    expect((await card()).marketingOptOut).toBe(false);
  });

  it('«📅 Записаться» without the Mini App hands the chat to the AI as a booking wish', async () => {
    ai.push(message([text('С радостью запишу вас! На какую процедуру и когда удобно?')]));
    expect(await press('mb')).toEqual({ text: 'Подберём время 🙌' });
    await pipeline.idle();
    expect(ai.calls).toHaveLength(1);
    expect(await history()).toEqual([
      'user:[Кнопка] 📅 Хочу записаться',
      'assistant:С радостью запишу вас! На какую процедуру и когда удобно?',
    ]);
  });

  it('staff set it on the client card; the audit names it', async () => {
    const res = await t.api('PATCH', `/api/clients/${anna.id}`, { marketingOptOut: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().marketingOptOut).toBe(true);
    // Omitted / null leaves it as is; a list returns it too.
    expect((await t.api('PATCH', `/api/clients/${anna.id}`, { notes: 'VIP', marketingOptOut: null })).json().marketingOptOut).toBe(true);
    expect((await t.api('GET', '/api/clients')).json().items[0].marketingOptOut).toBe(true);
    expect((await t.api('PATCH', `/api/clients/${anna.id}`, { marketingOptOut: 'да' })).statusCode).toBe(400);
    await t.api('PATCH', `/api/clients/${anna.id}`, { marketingOptOut: false });

    const entries = (await t.api('GET', `/api/audit?entity=client&entityId=${anna.id}&source=app`)).json().items;
    const summaries = entries.map((e: { summary: string }) => e.summary).reverse();
    expect(summaries).toContain('Карточка клиента «Анна Иванова» изменена: новости и предложения отключены');
    expect(summaries).toContain('Карточка клиента «Анна Иванова» изменена: новости и предложения снова включены');
  });
});
