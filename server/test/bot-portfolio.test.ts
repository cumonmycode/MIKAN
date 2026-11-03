import fs from 'node:fs';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BotPipeline, runTest } from '../src/bot/pipeline.js';
import { MAX_PORTFOLIO_SHOTS } from '../src/bot/portfolio.js';
import { buildStablePrompt } from '../src/bot/prompt.js';
import { portfolioPhotos } from '../src/db/schema.js';
import { createTestApp, make, message, ScriptedAi, text, toolUse, type TestApp } from './helpers.js';

type Json = Record<string, any>;

const CHAT = 700_031;
const from = { chatId: CHAT, telegramName: 'Мария', username: 'masha' };
const JPEG = Buffer.from('ffd8ffe000104a464946', 'hex');

describe('bot: show_portfolio', () => {
  let t: TestApp;
  let ai: ScriptedAi;
  let pipeline: BotPipeline;
  let owner: Json;
  let fatima: Json;
  let helix: Json;

  /** A photo with its file on disk (the bot sends only pictures it can read). */
  const photo = async (employeeId: number, name: string, extra: Record<string, unknown> = {}) => {
    fs.writeFileSync(path.join(t.ctx.config.dataDir, 'uploads', `${name}.jpg`), JPEG);
    return make(t, '/api/portfolio', { employeeId, imageUrl: `/uploads/${name}.jpg`, ...extra });
  };
  const fileOf = (name: string) => path.join(t.ctx.config.dataDir, 'uploads', `${name}.jpg`);
  const say = async (msg: string) => {
    pipeline.receive(from, msg);
    await pipeline.idle();
  };
  const toolResults = (call: number) => {
    const messages = ai.calls[call]!.messages;
    return messages[messages.length - 1]!.content as Anthropic.ToolResultBlockParam[];
  };

  beforeEach(async () => {
    ai = new ScriptedAi();
    t = await createTestApp({ ai });
    pipeline = new BotPipeline(t.ctx, 0);
    owner = (await t.api('GET', '/api/auth/me')).json();
    fatima = await make(t, '/api/employees', { name: 'Фатима', login: 'fatima', password: 'secret123', isMaster: true });
    helix = await make(t, '/api/services', { name: 'Хеликс', category: 'piercing', price: 2500, durationMin: 30 });
  });
  afterEach(async () => {
    await t.close();
  });

  it('lists the masters with ids and their works, and offers the tool', async () => {
    await photo(fatima.id, 'a');
    await photo(fatima.id, 'b');
    const prompt = buildStablePrompt(t.ctx.db);
    expect(prompt).toContain(
      ['## Мастера', `• [id ${owner.id}] ${owner.name} · работ в портфолио пока нет`, `• [id ${fatima.id}] Фатима · в портфолио 2 работы`].join('\n'),
    );
    expect(prompt).toContain('вызови show_portfolio');
  });

  it("sends up to 5 of a master's works after the reply, with the master and the service", async () => {
    await photo(fatima.id, 'w1', { serviceId: helix.id, caption: 'Хеликс, титан' });
    for (const n of [2, 3, 4, 5, 6]) await photo(fatima.id, `w${n}`);
    await photo(owner.id, 'other');

    ai.push(message([toolUse('p1', 'show_portfolio', { masterId: fatima.id })], 'tool_use'), message([text('Вот работы Фатимы 🙂')]));
    await say('Покажите работы Фатимы');

    const result = String(toolResults(1)[0]!.content);
    expect(result).toContain(`${MAX_PORTFOLIO_SHOTS} из 6`);
    expect(toolResults(1)[0]!.is_error).toBeFalsy();
    expect(t.gateway.textsTo(CHAT)).toEqual(['Вот работы Фатимы 🙂']);
    expect(t.gateway.photos).toEqual([
      { chatId: CHAT, photo: { kind: 'file', path: fileOf('w1') }, caption: 'Мастер: **Фатима** · Хеликс\nХеликс, титан' },
      ...[2, 3, 4, 5].map((n) => ({ chatId: CHAT, photo: { kind: 'file', path: fileOf(`w${n}`) }, caption: 'Мастер: **Фатима**' })),
    ]);
    const history = (await t.api('GET', `/api/bot/chats/${CHAT}/messages`)).json().items.map((m: Json) => m.text);
    expect(history.slice(0, 3)).toEqual(['Покажите работы Фатимы', 'Вот работы Фатимы 🙂', '[Фото] Мастер: **Фатима** · Хеликс\nХеликс, титан']);
  });

  it("a service's works come from every working master, newest first; the newest of the studio without filters", async () => {
    await photo(fatima.id, 'old', { serviceId: helix.id });
    await photo(owner.id, 'new', { serviceId: helix.id });
    await photo(owner.id, 'plain');
    t.ctx.db.update(portfolioPhotos).set({ createdAt: Date.parse('2026-01-01T00:00:00.000Z') }).run();

    ai.push(message([toolUse('p1', 'show_portfolio', { serviceId: helix.id })], 'tool_use'), message([text('Проколы хеликса:')]));
    await say('Покажите примеры хеликса');
    expect(t.gateway.photos.map((p) => p.photo)).toEqual([{ kind: 'file', path: fileOf('new') }, { kind: 'file', path: fileOf('old') }]);
    expect(t.gateway.photos.map((p) => p.caption)).toEqual([`Мастер: **${owner.name}** · Хеликс`, 'Мастер: **Фатима** · Хеликс']);

    t.gateway.photos = [];
    ai.push(message([toolUse('p2', 'show_portfolio', {})], 'tool_use'), message([text('Наши работы:')]));
    await say('А вообще что вы делаете?');
    expect(t.gateway.photos.map((p) => p.photo)).toEqual(['plain', 'new', 'old'].map((n) => ({ kind: 'file', path: fileOf(n) })));
  });

  it("falls back to the master's other works when none are of that service", async () => {
    await photo(fatima.id, 'a');
    ai.push(
      message([toolUse('p1', 'show_portfolio', { masterId: fatima.id, serviceId: helix.id })], 'tool_use'),
      message([text('Хеликса у Фатимы в портфолио нет, вот другие её работы.')]),
    );
    await say('Есть хеликсы у Фатимы?');
    expect(String(toolResults(1)[0]!.content)).toContain('по услуге «Хеликс» работ нет');
    expect(t.gateway.photos.map((p) => p.photo)).toEqual([{ kind: 'file', path: fileOf('a') }]);
  });

  it('answers in words when there is nothing to show and refuses unknown masters and services', async () => {
    const hidden = await make(t, '/api/employees', { name: 'Ольга', login: 'olga', password: 'secret123', isMaster: false, role: 'admin' });
    ai.push(
      message([
        toolUse('a', 'show_portfolio', { masterId: fatima.id }),
        toolUse('b', 'show_portfolio', { masterId: hidden.id }),
        toolUse('c', 'show_portfolio', { serviceId: 9999 }),
        toolUse('d', 'show_portfolio', { masterId: 'Фатима' }),
      ], 'tool_use'),
      message([text('Пока фото работ нет.')]),
    );
    await say('Покажите работы');
    const results = toolResults(1);
    expect(String(results[0]!.content)).toContain('У мастера Фатима пока нет фото работ');
    expect(results[0]!.is_error).toBeFalsy();
    expect(results.slice(1).map((r) => r.is_error)).toEqual([true, true, true]);
    expect(String(results[1]!.content)).toContain('раздела «Мастера»');
    expect(String(results[2]!.content)).toContain('Такой услуги нет');
    expect(t.gateway.photos).toEqual([]);
  });

  it('does not name a hidden service in the caption', async () => {
    await photo(fatima.id, 'a', { serviceId: helix.id });
    await t.api('PATCH', `/api/services/${helix.id}`, { active: false });
    ai.push(message([toolUse('p1', 'show_portfolio', { masterId: fatima.id })], 'tool_use'), message([text('Вот.')]));
    await say('Работы Фатимы?');
    expect(t.gateway.photos.map((p) => p.caption)).toEqual(['Мастер: **Фатима**']);
  });

  it('skips pictures Telegram cannot get and does not send the same photo twice in one answer', async () => {
    await make(t, '/api/portfolio', { employeeId: fatima.id, imageUrl: '/uploads/missing.jpg' });
    await photo(fatima.id, 'ok');
    ai.push(
      message([toolUse('a', 'show_portfolio', { masterId: fatima.id }), toolUse('b', 'show_portfolio', { masterId: fatima.id })], 'tool_use'),
      message([text('Смотрите!')]),
    );
    await say('Работы Фатимы?');
    expect(t.gateway.photos.map((p) => p.photo)).toEqual([{ kind: 'file', path: fileOf('ok') }]);
  });

  it('sends at most 5 photos after one answer, however many calls ask for them', async () => {
    for (const n of [1, 2, 3, 4]) await photo(fatima.id, `f${n}`);
    for (const n of [1, 2, 3]) await photo(owner.id, `o${n}`);
    ai.push(
      message([toolUse('a', 'show_portfolio', { masterId: fatima.id }), toolUse('b', 'show_portfolio', { masterId: owner.id }), toolUse('c', 'show_portfolio', {})], 'tool_use'),
      message([text('Вот работы обоих мастеров.')]),
    );
    await say('Покажите работы всех мастеров');
    expect(t.gateway.photos.map((p) => p.photo)).toEqual(['f1', 'f2', 'f3', 'f4', 'o1'].map((n) => ({ kind: 'file', path: fileOf(n) })));
    expect(String(toolResults(1)[1]!.content)).toContain('Фото работ (1 из 3)');
    expect(String(toolResults(1)[2]!.content)).toContain('больше за один ответ не отправляю');
  });

  it('the bot test only says what it would have sent', async () => {
    await photo(fatima.id, 'a');
    ai.push(message([toolUse('p1', 'show_portfolio', { masterId: fatima.id })], 'tool_use'), message([text('Вот работы.')]));
    const reply = await runTest(t.ctx, 'Покажите работы Фатимы');
    expect(reply).toContain('показаны бы работы: 1 фото (Фатима)');
    expect(t.gateway.photos).toEqual([]);
  });
});
