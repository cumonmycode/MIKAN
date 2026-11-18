import fs from 'node:fs';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeCallback, encodeCallback, TELEGRAM_MAX_CALLBACK_DATA, type CallbackAction } from '../src/bot/callback-data.js';
import { handleCallback } from '../src/bot/callbacks.js';
import { compatibleJewelry, jewelryCategoriesMenu, jewelryPage, serviceSectionsMenu } from '../src/bot/catalog.js';
import type { InlineKeyboard } from '../src/bot/gateway.js';
import { BotPipeline } from '../src/bot/pipeline.js';
import { catalogCategories } from '../src/db/schema.js';
import { createTestApp, make, message, ScriptedAi, text, toolUse, type TestApp } from './helpers.js';

const CHAT = 710_001;
const from = { chatId: CHAT, telegramName: 'Мария', username: 'masha' };

const button = (keyboard: InlineKeyboard | null | undefined, label: string) => {
  const found = (keyboard ?? []).flat().find((b) => b.text === label);
  if (!found) throw new Error(`no button «${label}» in ${JSON.stringify(keyboard)}`);
  return found.data;
};
const labels = (keyboard: InlineKeyboard | null | undefined) => (keyboard ?? []).map((row) => row.map((b) => b.text));

describe('bot: interactive catalogs', () => {
  let t: TestApp;
  let ai: ScriptedAi;
  let pipeline: BotPipeline;
  let helix: { id: number };
  let septum: { id: number };
  let labret: { id: number; variants: Array<{ id: number; name: string }> };
  let ring: { id: number };
  let labretFile: string;

  beforeEach(async () => {
    ai = new ScriptedAi();
    t = await createTestApp({ ai });
    pipeline = new BotPipeline(t.ctx, 0);
    // The warehouse registry of categories (staff order); items link to it by name.
    const now = Date.now();
    t.ctx.db
      .insert(catalogCategories)
      .values([
        { section: 'jewelry', serviceCategory: '', name: 'Лабрет', position: 0, createdAt: now, updatedAt: now },
        { section: 'jewelry', serviceCategory: '', name: 'Кольца', position: 1, createdAt: now, updatedAt: now },
        { section: 'jewelry', serviceCategory: '', name: 'Пустая', position: 2, createdAt: now, updatedAt: now },
        { section: 'service', serviceCategory: 'piercing', name: 'Ухо', position: 0, createdAt: now, updatedAt: now },
        { section: 'service', serviceCategory: 'piercing', name: 'Лицо', position: 1, createdAt: now, updatedAt: now },
      ])
      .run();
    labretFile = path.join(t.ctx.config.dataDir, 'uploads', 'labret.jpg');
    fs.writeFileSync(labretFile, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    helix = await make(t, '/api/services', { name: 'Хеликс', category: 'piercing', group: 'Ухо', price: 3000, durationMin: 30 });
    septum = await make(t, '/api/services', { name: 'Септум', category: 'piercing', group: 'Лицо', price: 3500, durationMin: 30 });
    await make(t, '/api/services', { name: 'Тату мини', category: 'tattoo', price: 5000, priceFrom: true, durationMin: 60 });
    labret = await make(t, '/api/products', {
      kind: 'jewelry', name: 'Лабрет', category: 'Лабрет', material: 'Титан ASTM F136', thicknessMm: 1.2, price: 1500,
      photos: ['/uploads/labret.jpg'], serviceIds: [helix.id],
      variants: [{ name: '6 мм', initialQuantity: 7 }, { name: '8 мм', initialQuantity: 0 }, { name: '10 мм', price: 1700, initialQuantity: 1 }],
    });
    ring = await make(t, '/api/products', {
      kind: 'jewelry', name: 'Кольцо', category: 'Кольца', price: 900, photos: ['https://cdn.test/ring.jpg'], serviceIds: [helix.id],
      variants: [{ name: '8 мм', initialQuantity: 3 }],
    });
    await make(t, '/api/products', { kind: 'jewelry', name: 'Скрытое', price: 900, active: false, serviceIds: [helix.id], variants: [{ name: '6 мм', initialQuantity: 5 }] });
    await make(t, '/api/products', { kind: 'jewelry', name: 'Распродано', price: 900, serviceIds: [helix.id], variants: [{ name: '6 мм', initialQuantity: 0 }] });
  });
  afterEach(async () => {
    await t.close();
  });

  const press = (data: string, messageId: number | null, isPhoto: boolean) =>
    handleCallback({ ctx: t.ctx, pipeline }, { from, data, message: messageId === null ? null : { messageId, isPhoto } });
  const history = async () => (await t.api('GET', `/api/bot/chats/${CHAT}/messages`)).json().items.map((m: { role: string; text: string }) => `${m.role}:${m.text}`);

  it('offers only active compatible jewelry with a size in stock, naming sizes and prices but never quantities', async () => {
    expect(compatibleJewelry(t.ctx.db, helix.id).map((p) => p.name)).toEqual(['Кольцо', 'Лабрет']);
    expect(compatibleJewelry(t.ctx.db, septum.id)).toEqual([]);
    const page = jewelryPage(t.ctx.db, t.ctx.config.dataDir, { by: 'service', id: helix.id }, 1)!;
    expect(page.caption).toBe(
      '💎 Украшения для «Хеликс»\n\nЛабрет\nТитан ASTM F136 · 1.2 мм (16G)\nПодходит для: Хеликс\n\nВ наличии:\n• 6 мм — 1 500 ₽\n• 10 мм — 1 700 ₽',
    );
    expect(page.caption).not.toMatch(/8 мм|\b7\b|шт|осталось/);
    expect(page.photo).toEqual({ kind: 'file', path: labretFile });
    expect(labels(page.keyboard)).toEqual([['◀︎', '2 / 2', '▶︎'], ['💍 Хочу это украшение'], ['📂 Все украшения']]);
    // An index past the end (stock changed since the button was drawn) is clamped.
    expect(jewelryPage(t.ctx.db, t.ctx.config.dataDir, { by: 'service', id: helix.id }, 9)!.product.name).toBe('Лабрет');
  });

  it('show_jewelry_for_service sends a carousel after the reply; ◀︎ ▶︎ page the same message', async () => {
    ai.push(
      message([toolUse('j', 'show_jewelry_for_service', { serviceId: helix.id })], 'tool_use'),
      message([text('Для хеликса есть вот такие украшения 👇')]),
    );
    pipeline.receive(from, 'Какие украшения есть для феликса?');
    await pipeline.idle();
    const results = ai.calls[1]!.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[];
    expect(String(results[0]!.content)).toContain('Каталог «Украшения для «Хеликс»»');
    expect(String(results[0]!.content)).not.toMatch(/\d+ шт/);

    expect(t.gateway.textsTo(CHAT)).toEqual(['Для хеликса есть вот такие украшения 👇']);
    expect(t.gateway.photos).toHaveLength(1);
    const card = t.gateway.photos[0]!;
    expect(card.photo).toEqual({ kind: 'url', url: 'https://cdn.test/ring.jpg' });
    expect(card.caption).toContain('Кольцо');
    expect(labels(card.keyboard)[0]).toEqual(['◀︎', '1 / 2', '▶︎']);
    expect(await history()).toContain('assistant:[Каталог] 💎 Украшения для «Хеликс»');

    expect(await press(button(card.keyboard, '▶︎'), card.messageId!, true)).toEqual({});
    const edit = t.gateway.edits.at(-1)!;
    expect(edit).toMatchObject({ kind: 'photo', chatId: CHAT, messageId: card.messageId, photo: { kind: 'file', path: labretFile } });
    expect(edit.text).toContain('Лабрет');
    expect(labels(edit.keyboard)[0]).toEqual(['◀︎', '2 / 2', '▶︎']);
    // ▶︎ on the last page wraps around to the first.
    await press(button(edit.keyboard, '▶︎'), card.messageId!, true);
    expect(t.gateway.edits.at(-1)!.text).toContain('Кольцо');
    expect(t.gateway.photos).toHaveLength(1); // paging never sends new messages
    expect(await press(button(edit.keyboard, '2 / 2'), card.messageId!, true)).toEqual({});
  });

  it('replaces the message when paging between a piece with a photo and one without', async () => {
    await t.api('PATCH', `/api/products/${ring.id}`, { photos: [] });
    await press(encodeCallback({ kind: 'jewelryOpen', list: { by: 'service', id: helix.id } }), null, false);
    const first = t.gateway.sent.at(-1)!;
    expect(first.text).toContain('Кольцо');
    expect(labels(first.keyboard)[0]).toEqual(['◀︎', '1 / 2', '▶︎']);
    await press(button(first.keyboard, '▶︎'), first.messageId, false);
    expect(t.gateway.edits.at(-1)).toEqual({ kind: 'delete', chatId: CHAT, messageId: first.messageId });
    expect(t.gateway.photos.at(-1)!.caption).toContain('Лабрет');
  });

  it('«Хочу это украшение» asks for a size, and the choice continues the conversation with the AI', async () => {
    const list = { by: 'service' as const, id: helix.id };
    const labretPage = jewelryPage(t.ctx.db, t.ctx.config.dataDir, list, 1)!;
    expect(await press(button(labretPage.keyboard, '💍 Хочу это украшение'), 500, true)).toEqual({ text: 'Выберите размер' });
    const sizes = t.gateway.edits.at(-1)!;
    expect(sizes).toMatchObject({ kind: 'keyboard', messageId: 500 });
    expect(labels(sizes.keyboard)).toEqual([['6 мм — 1 500 ₽'], ['10 мм — 1 700 ₽'], ['◀︎ Назад']]);

    ai.push(message([text('Отличный выбор! Хотите записаться на прокол хеликса с этим лабретом?')]));
    expect(await press(button(sizes.keyboard, '10 мм — 1 700 ₽'), 500, true)).toEqual({ text: 'Отлично! Передаю ваш выбор 🙌' });
    await pipeline.idle();
    expect(labels(t.gateway.edits.at(-1)!.keyboard)).toEqual(labels(labretPage.keyboard)); // the carousel buttons are back
    const choice = `[Выбрано] Лабрет — 10 мм · 1 700 ₽ (украшение id ${labret.id}, для «Хеликс»)`;
    expect(await history()).toEqual([`user:${choice}`, 'assistant:Отличный выбор! Хотите записаться на прокол хеликса с этим лабретом?']);
    expect(JSON.stringify(ai.calls[0]!.messages)).toContain(choice);

    // A piece with a single size in stock is chosen at once.
    ai.push(message([text('Записываю кольцо.')]));
    const ringPage = jewelryPage(t.ctx.db, t.ctx.config.dataDir, list, 0)!;
    await press(button(ringPage.keyboard, '💍 Хочу это украшение'), 501, true);
    await pipeline.idle();
    expect((await history()).at(-2)).toBe(`user:[Выбрано] Кольцо — 8 мм · 900 ₽ (украшение id ${ring.id}, для «Хеликс»)`);

    // A size sold out meanwhile is refused.
    const eight = labret.variants.find((v) => v.name === '8 мм')!;
    expect(await press(encodeCallback({ kind: 'jewelrySize', list, index: 1, variantId: eight.id }), 500, true)).toEqual({
      text: 'Этот размер уже закончился — выберите другой',
    });
  });

  it('menus: jewelry categories with stock, service sections, service cards with booking and matching jewelry', async () => {
    const jewelry = jewelryCategoriesMenu(t.ctx.db)!;
    expect(labels(jewelry.keyboard)).toEqual([['Лабрет', 'Кольца'], ['💉 Услуги и цены']]);
    const services = serviceSectionsMenu(t.ctx.db)!;
    expect(labels(services.keyboard)).toEqual([['Тату', 'Пирсинг · Ухо'], ['Пирсинг · Лицо'], ['💎 Украшения']]);

    // Category → a new carousel message; «Все украшения» from a text menu edits it in place.
    await press(button(jewelry.keyboard, 'Кольца'), 600, false);
    expect(t.gateway.photos.at(-1)!.caption).toBe('💎 Кольца\n\nКольцо\nПодходит для: Хеликс\n\nВ наличии:\n• 8 мм — 900 ₽');
    await press(button(jewelry.keyboard, '💉 Услуги и цены'), 600, false);
    expect(t.gateway.edits.at(-1)).toMatchObject({ kind: 'text', messageId: 600, text: services.text });

    await press(button(services.keyboard, 'Пирсинг · Ухо'), 600, false);
    const card = t.gateway.sent.at(-1)!; // Хеликс has no picture → a text card
    expect(card.text).toBe('💉 Пирсинг · Ухо\n\n**Хеликс**\n3 000 ₽');
    expect(labels(card.keyboard)).toEqual([['📅 Записаться'], ['💎 Подходящие украшения'], ['📂 Все услуги']]);

    ai.push(message([text('С радостью запишу вас на хеликс! Как вас зовут?')]));
    expect(await press(button(card.keyboard, '📅 Записаться'), card.messageId, false)).toEqual({ text: 'Отлично! Сейчас оформим запись 🙌' });
    await pipeline.idle();
    expect(await history()).toContain(`user:[Выбрано] Записаться: Хеликс · 3 000 ₽ (услуга id ${helix.id})`);

    await press(button(card.keyboard, '💎 Подходящие украшения'), card.messageId, false);
    expect(t.gateway.photos.at(-1)!.caption).toContain('💎 Украшения для «Хеликс»');
    expect(await press(encodeCallback({ kind: 'serviceJewelry', serviceId: septum.id }), null, false)).toEqual({ text: 'Сейчас таких украшений нет в наличии' });
  });

  it('find_jewelry checks the stock per size and never reveals quantities', async () => {
    ai.push(
      message([toolUse('f1', 'find_jewelry', { query: 'лабреты 10' }), toolUse('f2', 'find_jewelry', { query: 'распродано' }), toolUse('f3', 'find_jewelry', { query: 'скрытое' })], 'tool_use'),
      message([text('Лабрет 10 мм есть — 1 700 ₽.')]),
    );
    pipeline.receive(from, 'Есть лабрет на 10 мм?');
    await pipeline.idle();
    const [found, soldOut, hidden] = (ai.calls[1]!.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[]).map((r) => String(r.content));
    expect(found).toContain(`• [id ${labret.id}] Лабрет · Лабрет · Титан ASTM F136 · 1.2 мм (16G) · подходит для: Хеликс · в наличии — размеры в наличии: 6 мм — 1 500 ₽, 10 мм — 1 700 ₽ · есть фото`);
    expect(found).not.toMatch(/\b7\b|\d+ шт/);
    expect(soldOut).toMatch(/Распродано · подходит для: Хеликс · нет в наличии \(цена 900 ₽\)/);
    expect(hidden).toContain('ничего не найдено');
  });

  it('button payloads fit Telegram limits, round-trip, and old or forged ones are refused', async () => {
    const big = 999_999_999_999;
    const actions: CallbackAction[] = [
      { kind: 'noop' },
      { kind: 'jewelryOpen', list: { by: 'category', id: big } },
      { kind: 'jewelryPage', list: { by: 'service', id: big }, index: big },
      { kind: 'jewelryWant', list: { by: 'service', id: big }, index: big, productId: big },
      { kind: 'jewelrySize', list: { by: 'category', id: 0 }, index: big, variantId: big },
      { kind: 'jewelryCategories' },
      { kind: 'serviceOpen', list: { category: 'piercing', groupId: big } },
      { kind: 'servicePage', list: { category: 'other', groupId: 0 }, index: big },
      { kind: 'serviceBook', serviceId: big },
      { kind: 'serviceJewelry', serviceId: big },
      { kind: 'serviceCategories' },
      { kind: 'reminderConfirm', appointmentId: big },
      { kind: 'reminderMove', appointmentId: big },
    ];
    for (const action of actions) {
      const data = encodeCallback(action);
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(TELEGRAM_MAX_CALLBACK_DATA);
      expect(decodeCallback(data)).toEqual(action);
    }
    for (const bad of ['', 'jp:s1', 'jp:x1:0', 'sb:-1', 'rc:1:2', 'zz', 'jw:s1:0']) expect(decodeCallback(bad)).toBeNull();
    expect(await press('jp:q', 1, true)).toEqual({ text: 'Эта кнопка устарела', error: true });
  });
});
