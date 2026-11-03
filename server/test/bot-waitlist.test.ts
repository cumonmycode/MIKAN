import type Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotPipeline, REPLIES } from '../src/bot/pipeline.js';
import { buildStablePrompt } from '../src/bot/prompt.js';
import { emptySink, TOOLS } from '../src/bot/tools.js';
import { buildWaitlistToolHandler } from '../src/bot/waitlist-tool.js';
import { waitlistEntries } from '../src/db/schema.js';
import { createTestApp, make, message, ScriptedAi, text, toolUse, type TestApp } from './helpers.js';
import { addMaster, bindStaffChat, linkChat, NOW, PUBLIC_URL, STAFF_CHAT, type Json } from './online-booking-fixtures.js';

const CHAT = 730_501;
const from = { chatId: CHAT, telegramName: 'Анна', username: 'anna' };

describe('bot: join_waitlist', () => {
  let t: TestApp;
  let ai: ScriptedAi;
  let pipeline: BotPipeline;
  let lobe: Json;
  let fatima: Json;
  let anna: Json;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    ai = new ScriptedAi();
    t = await createTestApp({ ai, env: { PUBLIC_URL } });
    pipeline = new BotPipeline(t.ctx, 0);
    bindStaffChat(t);
    lobe = await make(t, '/api/services', { name: 'Мочка', category: 'piercing', price: 1600, durationMin: 30 });
    fatima = await addMaster(t, 'Фатима', 'fatima');
    anna = await make(t, '/api/clients', { name: 'Анна', lastName: 'Иванова', phone: '+79991234567' });
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
  const rows = () => t.ctx.db.select().from(waitlistEntries).all();

  it('is offered to the AI and named in the booking rule', () => {
    expect(TOOLS.map((tool) => tool.name)).toContain('join_waitlist');
    expect(buildStablePrompt(t.ctx.db)).toContain('join_waitlist');
  });

  it('puts the linked client on the waitlist and tells the staff chat', async () => {
    ai.push(
      message([toolUse('w', 'join_waitlist', { items: [{ serviceId: lobe.id }], masterId: fatima.id, dateFrom: '2026-10-21', dateTo: '2026-10-25', note: 'вечером' })], 'tool_use'),
      message([text('Записала вас в лист ожидания ⏳')]),
    );
    await say('Да, поставьте меня в очередь');
    const [entry] = rows();
    expect(entry).toMatchObject({ clientId: anna.id, channel: 'bot', status: 'waiting', masterId: fatima.id, note: 'вечером' });
    expect(toolResults(1)).toEqual([
      {
        content:
          `Клиент в листе ожидания (№${entry!.id}): Мочка, 21–25 октября. Как только освободится подходящее время, бот сам ` +
          'напишет клиенту в этот чат с кнопкой записи — кто запишется первым, тому и время. Скажи это клиенту простыми словами.',
        isError: false,
      },
    ]);
    expect(t.gateway.textsTo(CHAT)).toEqual(['Записала вас в лист ожидания ⏳']);
    expect(t.gateway.textsTo(STAFF_CHAT)).toEqual([
      '⏳ Анна Иванова встал(а) в лист ожидания (бот): Мочка, 21–25 октября, мастер Фатима\nКомментарий: вечером',
    ]);
    const log = (await t.api('GET', `/api/audit?entity=waitlist&entityId=${entry!.id}`)).json().items as Json[];
    expect(log[0]).toMatchObject({ source: 'bot', action: 'waitlist.create' });
  });

  it('confirms by itself when the AI ends without text', async () => {
    ai.push(
      message([toolUse('w', 'join_waitlist', { items: [{ serviceId: lobe.id }], dateFrom: '2026-10-21', dateTo: '2026-10-21' })], 'tool_use'),
      message([]),
    );
    await say('Хочу в лист ожидания на 21-е');
    expect(rows()).toHaveLength(1);
    expect(t.gateway.textsTo(CHAT)).toEqual([REPLIES.waitlisted]);
  });

  it('explains refusals: invalid dates, an unidentified chat, online booking off; the test mode stores nothing', async () => {
    const scope = { mode: 'live' as const, chatId: CHAT, clientId: anna.id, telegramName: 'Анна', username: null, lastUserText: '' };
    const tool = buildWaitlistToolHandler(t.ctx, scope, emptySink());
    const input = { items: [{ serviceId: lobe.id }], dateFrom: '2026-10-21', dateTo: '2026-10-25' };
    expect(await tool({ ...input, dateTo: '2026-11-30' })).toEqual({
      content: 'Период — не больше 30 дней. Уточни у клиента и попробуй снова.',
      isError: true,
    });
    expect((await tool({ items: [] })).isError).toBe(true);
    const stranger = buildWaitlistToolHandler(t.ctx, { ...scope, chatId: 999 }, emptySink());
    expect((await stranger(input)).content).toContain('Клиент не идентифицирован');

    const sink = emptySink();
    const test = buildWaitlistToolHandler(t.ctx, { ...scope, mode: 'test' }, sink);
    expect((await test(input)).content).toContain('Тестовый режим');
    expect(sink.notes).toEqual(['клиент встал бы в лист ожидания: Мочка, 21–25 октября']);
    expect(rows()).toEqual([]);

    await t.api('PUT', '/api/settings/studio', { onlineBooking: { enabled: false } });
    expect(await tool(input)).toMatchObject({ isError: true, content: expect.stringContaining('лист ожидания недоступен') });
    expect(buildStablePrompt(t.ctx.db)).not.toContain('join_waitlist');
  });
});
