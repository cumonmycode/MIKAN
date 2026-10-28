import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ImageGenerator } from '../src/context.js';
import { defaultImageSubject, ImageGenerationError, SERVICE_IMAGE_MODEL, serviceImagePrompt } from '../src/lib/service-images.js';
import { formatServicePrice } from '../src/lib/text.js';
import { createTestApp, make, type TestApp } from './helpers.js';

const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(32)]);
const AI_ENV = { AI_API_KEY: 'polza-test-key', AI_BASE_URL: 'https://polza.test/api' };
const BASE = { category: 'piercing', price: 2500, durationMin: 45 };

describe('formatServicePrice', () => {
  it('formats ranges, «from» prices, free and fixed prices', () => {
    expect(formatServicePrice(2000, 5000, true)).toBe('от 2 000 до 5 000 ₽');
    expect(formatServicePrice(0, 10000, true)).toBe('до 10 000 ₽');
    expect(formatServicePrice(15000, null, true)).toBe('от 15 000 ₽');
    expect(formatServicePrice(0, null, false)).toBe('Бесплатно');
    expect(formatServicePrice(2500, null, false)).toBe('2 500 ₽');
    expect(formatServicePrice(0, null, true)).toBe('от 0 ₽');
  });
});

describe('service cards', () => {
  let t: TestApp;
  afterEach(async () => {
    await t.close();
  });

  const error = async (method: 'POST' | 'PATCH', url: string, body: Record<string, unknown>) => {
    const res = await t.api(method, url, body);
    expect(res.statusCode).toBe(400);
    return res.json().error.message as string;
  };

  it('creates a card with group, price range, picture, photos and variants', async () => {
    t = await createTestApp();
    const created = await make(t, '/api/services', {
      ...BASE, name: 'Соски', group: '  Тело ', priceMax: 4000, description: 'Nipple',
      imageUrl: '/uploads/cover.jpg', imagePrompt: 'a schematic male chest', photos: ['/uploads/1.jpg', 'https://cdn.example/2.jpg'],
      variants: [{ name: 'Один', price: 2500 }, { name: 'Два', price: 4000, durationMin: 60 }],
    });
    expect(created).toEqual({
      id: created.id, name: 'Соски', category: 'piercing', group: 'Тело', price: 2500, priceMax: 4000, priceFrom: true,
      durationMin: 45, description: 'Nipple', imageUrl: '/uploads/cover.jpg', imagePrompt: 'a schematic male chest',
      photos: ['/uploads/1.jpg', 'https://cdn.example/2.jpg'],
      variants: [{ name: 'Один', price: 2500, durationMin: null }, { name: 'Два', price: 4000, durationMin: 60 }],
      depositAmount: 0, masterPrices: [], aftercareTemplateId: null, freshProcedure: false, healingCheckDays: null, jewelryChangeWeeks: null,
      jewelryIds: [], consumables: [], active: true, sort: 0,
    });
    const listed = (await t.api('GET', '/api/services')).json().items.find((s: { id: number }) => s.id === created.id);
    expect(listed).toEqual(created);

    const plain = await make(t, '/api/services', { ...BASE, name: 'Мочка', group: '', imageUrl: '', imagePrompt: '' });
    expect(plain).toMatchObject({ group: null, priceMax: null, priceFrom: false, imageUrl: null, imagePrompt: null, photos: [], variants: [] });
  });

  it('stores priceFrom whenever priceMax is set and keeps priceMax above price (create and patch)', async () => {
    t = await createTestApp();
    const upTo = await make(t, '/api/services', { ...BASE, name: 'До', price: 0, priceMax: 10000, priceFrom: false });
    expect(upTo).toMatchObject({ price: 0, priceMax: 10000, priceFrom: true });

    const rangeError = 'Максимальная цена должна быть больше минимальной';
    expect(await error('POST', '/api/services', { ...BASE, name: 'X', price: 5000, priceMax: 5000 })).toBe(rangeError);
    expect(await error('POST', '/api/services', { ...BASE, name: 'X', price: 5000, priceMax: 100 })).toBe(rangeError);

    const id = upTo.id;
    expect(await error('PATCH', `/api/services/${id}`, { price: 12000 })).toBe(rangeError);
    expect(await error('PATCH', `/api/services/${id}`, { priceMax: 0 })).toBe(rangeError);
    const raised = await t.api('PATCH', `/api/services/${id}`, { price: 12000, priceMax: 20000 });
    expect(raised.json()).toMatchObject({ price: 12000, priceMax: 20000, priceFrom: true });
    // priceFrom cannot be switched off while a range is set.
    expect((await t.api('PATCH', `/api/services/${id}`, { priceFrom: false })).json()).toMatchObject({ priceMax: 20000, priceFrom: true });

    const cleared = await t.api('PATCH', `/api/services/${id}`, { priceMax: null });
    expect(cleared.json()).toMatchObject({ price: 12000, priceMax: null, priceFrom: true });
    expect((await t.api('PATCH', `/api/services/${id}`, { priceFrom: false })).json()).toMatchObject({ priceMax: null, priceFrom: false });
    // Absent priceMax on PATCH leaves it untouched.
    expect((await t.api('PATCH', `/api/services/${id}`, { name: 'До v2' })).json()).toMatchObject({ name: 'До v2', priceMax: null, priceFrom: false });
  });

  it('replaces photos and variants on PATCH only when sent', async () => {
    t = await createTestApp();
    const s = await make(t, '/api/services', {
      ...BASE, name: 'Септум', group: 'Лицо', imageUrl: '/uploads/a.png', imagePrompt: 'septum', photos: ['/uploads/1.jpg'],
      variants: [{ name: 'Стандарт', price: 2500 }],
    });
    const patch = async (body: Record<string, unknown>) => (await t.api('PATCH', `/api/services/${s.id}`, body)).json();

    expect(await patch({ name: 'Септум 2', photos: null, variants: null })).toMatchObject({
      name: 'Септум 2', group: 'Лицо', imageUrl: '/uploads/a.png', imagePrompt: 'septum', photos: ['/uploads/1.jpg'],
      variants: [{ name: 'Стандарт', price: 2500, durationMin: null }],
    });
    expect(await patch({ photos: ['/uploads/2.jpg', '/uploads/3.jpg'], variants: [{ name: 'Двойной', price: 4000, durationMin: 50 }] })).toMatchObject({
      photos: ['/uploads/2.jpg', '/uploads/3.jpg'], variants: [{ name: 'Двойной', price: 4000, durationMin: 50 }],
    });
    expect(await patch({ photos: [], variants: [], group: null, imageUrl: null, imagePrompt: '' })).toMatchObject({
      photos: [], variants: [], group: null, imageUrl: null, imagePrompt: null,
    });
  });

  it('validates the new card fields with Russian messages', async () => {
    t = await createTestApp();
    const s = await make(t, '/api/services', { ...BASE, name: 'Хеликс' });
    const url = `/api/services/${s.id}`;

    expect(await error('PATCH', url, { variants: [{ name: 'Один', price: 1 }, { name: ' один ', price: 2 }] })).toBe(
      'Варианты: названия не должны повторяться',
    );
    expect(await error('POST', '/api/services', { ...BASE, name: 'X', variants: [{ name: 'A', price: 1 }, { name: 'a', price: 2 }] })).toBe(
      'Варианты: названия не должны повторяться',
    );
    expect(await error('PATCH', url, { photos: ['ftp://x/1.jpg'] })).toBe('«Фото (№1)»: ссылка должна начинаться с /uploads/ или http(s)://');
    expect(await error('PATCH', url, { photos: Array.from({ length: 13 }, (_, i) => `/uploads/${i}.jpg`) })).toBe('«Фото»: не больше 12 элементов');
    expect(await error('PATCH', url, { imageUrl: 'C:/cover.jpg' })).toBe('«Картинка»: ссылка должна начинаться с /uploads/ или http(s)://');
    expect(await error('PATCH', url, { imagePrompt: 'x'.repeat(1001) })).toBe('«Описание картинки»: максимум 1000 символов');
    expect(await error('PATCH', url, { group: 'x'.repeat(101) })).toBe('«Группа»: максимум 100 символов');
    expect(await error('PATCH', url, { priceMax: -1 })).toBe('«Максимальная цена»: должно быть не меньше 0');
    const many = Array.from({ length: 21 }, (_, i) => ({ name: `V${i}`, price: i }));
    expect(await error('PATCH', url, { variants: many })).toBe('«Варианты»: не больше 20 элементов');
    expect(await error('PATCH', url, { variants: [{ name: '', price: 1 }] })).toBe('«Название / имя (№1)»: не может быть пустым');
    expect(await error('PATCH', url, { variants: [{ name: 'A', price: -5 }] })).toBe('«Цена (№1)»: должно быть не меньше 0');
    expect(await error('PATCH', url, { variants: [{ name: 'A', price: 1, durationMin: 0 }] })).toBe('«Длительность (№1)»: должно быть не меньше 1');
    expect(await error('PATCH', url, { variants: [{ name: 'A' }] })).toBe('«Цена (№1)»: обязательное поле');

    // Nothing was changed by the rejected requests.
    expect((await t.api('GET', '/api/services')).json().items.find((x: { id: number }) => x.id === s.id)).toEqual(s);
  });
});

describe('POST /services/:id/image/generate', () => {
  let t: TestApp;
  let calls: Array<{ config: Parameters<ImageGenerator>[0]; prompt: string }>;
  afterEach(async () => {
    await t.close();
  });

  const recording = (result: () => Promise<{ data: Buffer; costRub: number | null }>): ImageGenerator => async (config, prompt) => {
    calls.push({ config, prompt });
    return result();
  };
  const setup = async (env: Record<string, string> = AI_ENV, generate?: ImageGenerator) => {
    calls = [];
    t = await createTestApp({ env, generateImage: generate ?? recording(async () => ({ data: PNG, costRub: 12.5 })) });
  };
  const generate = (id: number, body?: Record<string, unknown>) => t.api('POST', `/api/services/${id}/image/generate`, body);
  const uploadsDir = () => path.join(t.ctx.config.dataDir, 'uploads');

  it('generates the cover, stores it as an upload and saves the prompt', async () => {
    await setup();
    const s = await make(t, '/api/services', { ...BASE, name: 'Соски', description: 'Прокол через сосок' });

    const res = await generate(s.id, { prompt: '  a schematic male chest with a barbell  ' });
    expect(res.statusCode).toBe(200);
    const out = res.json();
    expect(out.imageUrl).toMatch(/^\/uploads\/[0-9a-f-]{36}\.png$/);
    expect(out.imagePrompt).toBe('a schematic male chest with a barbell');
    expect(fs.readFileSync(path.join(uploadsDir(), path.basename(out.imageUrl)))).toEqual(PNG);
    expect((await t.app.inject({ method: 'GET', url: out.imageUrl })).statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.config).toMatchObject({ apiKey: 'polza-test-key', baseUrl: 'https://polza.test/api', model: SERVICE_IMAGE_MODEL });
    expect(calls[0]!.prompt).toBe(serviceImagePrompt('a schematic male chest with a barbell'));

    // Without a prompt the saved imagePrompt is reused; the previous file is kept.
    const again = (await generate(s.id)).json();
    expect(calls[1]!.prompt).toBe(serviceImagePrompt('a schematic male chest with a barbell'));
    expect(again.imageUrl).not.toBe(out.imageUrl);
    expect(again.imagePrompt).toBe('a schematic male chest with a barbell');
    expect(fs.existsSync(path.join(uploadsDir(), path.basename(out.imageUrl)))).toBe(true);
  });

  it('resets the saved prompt when prompt is empty or null', async () => {
    await setup();
    const s = await make(t, '/api/services', { ...BASE, name: 'Септум', description: 'Перегородка', imagePrompt: 'old subject' });
    const fallback = serviceImagePrompt(defaultImageSubject({ name: 'Септум', category: 'piercing', description: 'Перегородка' }));

    const reset = (await generate(s.id, { prompt: '' })).json();
    expect(calls[0]!.prompt).toBe(fallback);
    expect(reset.imagePrompt).toBeNull();

    await t.api('PATCH', `/api/services/${s.id}`, { imagePrompt: 'another subject' });
    expect((await generate(s.id, { prompt: null })).json().imagePrompt).toBeNull();
    expect(calls[1]!.prompt).toBe(fallback);

    await t.api('PATCH', `/api/services/${s.id}`, { imagePrompt: 'kept subject' });
    expect((await generate(s.id, {})).json().imagePrompt).toBe('kept subject');
    expect(calls[2]!.prompt).toBe(serviceImagePrompt('kept subject'));
  });

  it('keeps fields edited while the picture was being generated', async () => {
    let release!: () => void;
    await setup(AI_ENV, async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { data: PNG, costRub: null };
    });
    const s = await make(t, '/api/services', { ...BASE, name: 'Мочка', imagePrompt: 'old subject' });
    const waitForGenerator = () => new Promise((resolve) => setTimeout(resolve, 20));

    const pending = generate(s.id);
    await waitForGenerator();
    await t.api('PATCH', `/api/services/${s.id}`, { name: 'Мочка уха', price: 3000, imagePrompt: 'edited subject', photos: ['/uploads/w.jpg'] });
    release();
    const out = (await pending).json();
    expect(out).toMatchObject({ name: 'Мочка уха', price: 3000, imagePrompt: 'edited subject', photos: ['/uploads/w.jpg'] });
    expect(out.imageUrl).toMatch(/^\/uploads\/.+\.png$/);

    // An explicitly sent prompt is saved even if imagePrompt was edited meanwhile.
    const withPrompt = generate(s.id, { prompt: 'sent subject' });
    await waitForGenerator();
    await t.api('PATCH', `/api/services/${s.id}`, { imagePrompt: 'late edit', description: 'Новое описание' });
    release();
    expect((await withPrompt).json()).toMatchObject({ name: 'Мочка уха', imagePrompt: 'sent subject', description: 'Новое описание' });
  });

  it('treats a blank prompt as a reset, and honours AI_IMAGE_MODEL', async () => {
    await setup({ ...AI_ENV, AI_IMAGE_MODEL: 'google/test-image' });
    const s = await make(t, '/api/services', { ...BASE, name: 'Мочка', description: 'Классический прокол' });
    const res = await generate(s.id, { prompt: '   ' });
    expect(res.statusCode).toBe(200);
    expect(res.json().imagePrompt).toBeNull();
    expect(calls[0]!.config.model).toBe('google/test-image');
    expect(calls[0]!.prompt).toBe(serviceImagePrompt('the piercing studio service «Мочка». Details: Классический прокол'));
  });

  it('refuses with 409 when the Polza key or base URL is not configured', async () => {
    for (const env of [{}, { AI_API_KEY: 'k' }, { AI_BASE_URL: 'https://polza.test/api' }]) {
      await setup(env);
      const s = await make(t, '/api/services', { ...BASE, name: 'Мочка' });
      const res = await generate(s.id);
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toEqual({ code: 'conflict', message: 'Генерация картинок недоступна: не настроен ключ Polza AI' });
      expect(calls).toHaveLength(0);
      await t.close();
    }
    await setup(); // for afterEach
  });

  it('answers 502 upstream_error when generation fails, leaving the service untouched', async () => {
    let failure: Error = new ImageGenerationError('Генерация не удалась: content policy');
    await setup(AI_ENV, async () => {
      throw failure;
    });
    const s = await make(t, '/api/services', { ...BASE, name: 'Мочка', imagePrompt: 'old' });

    const res = await generate(s.id, { prompt: 'new subject' });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toEqual({ code: 'upstream_error', message: 'Генерация не удалась: content policy' });

    failure = new TypeError('fetch failed');
    const crashed = await generate(s.id);
    expect(crashed.statusCode).toBe(502);
    expect(crashed.json().error).toEqual({ code: 'upstream_error', message: 'Сервис генерации картинок недоступен, попробуйте позже' });

    const after = (await t.api('GET', '/api/services')).json().items.find((x: { id: number }) => x.id === s.id);
    expect(after).toMatchObject({ imageUrl: null, imagePrompt: 'old' });
    expect(fs.readdirSync(uploadsDir())).toEqual([]);
  });

  it('rejects downloads that are not images', async () => {
    await setup(AI_ENV, async () => ({ data: Buffer.from('<html>oops</html>'), costRub: null }));
    const s = await make(t, '/api/services', { ...BASE, name: 'Мочка' });
    const res = await generate(s.id);
    expect(res.statusCode).toBe(502);
    expect(res.json().error.message).toBe('Сервис генерации вернул файл, который не является картинкой');
    expect(fs.readdirSync(uploadsDir())).toEqual([]);
  });

  it('validates input, 404s unknown services and refuses a second run for the same service', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await setup(AI_ENV, async () => {
      await gate;
      return { data: PNG, costRub: null };
    });
    const s = await make(t, '/api/services', { ...BASE, name: 'Мочка' });
    expect((await generate(999)).statusCode).toBe(404);
    const long = await generate(s.id, { prompt: 'x'.repeat(1001) });
    expect(long.statusCode).toBe(400);
    expect(long.json().error.message).toBe('«Описание картинки»: максимум 1000 символов');

    const first = generate(s.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await generate(s.id);
    expect(second.statusCode).toBe(409);
    expect(second.json().error.message).toBe('Картинка для этой услуги уже генерируется — подождите пару минут');
    release();
    expect((await first).statusCode).toBe(200);
    expect((await generate(s.id)).statusCode).toBe(200);
  });
});
