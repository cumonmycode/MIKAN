import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DateTime } from 'luxon';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { BotGateway } from '../src/bot/gateway.js';
import { loadConfig } from '../src/config.js';
import { silentLogger, type AppContext } from '../src/context.js';
import { openDatabase } from '../src/db/client.js';
import { smmSpend } from '../src/db/schema.js';
import { seedDatabase } from '../src/db/seed.js';
import { studioTimezone } from '../src/domain/settings.js';
import { decryptSecret, encryptSecret, maskSecret } from '../src/lib/secrets.js';
import {
  chatJson,
  extractJson,
  generateImage,
  monthSpend,
  polzaBalance,
  pollVideo,
  recordSpend,
  resultUrl,
  smmModels,
  SMM_MODELS,
  startVideo,
} from '../src/smm/ai.js';
import { absoluteUrl, removeSmmFile, saveSmmFile, smmFilePath, storeRemote } from '../src/smm/files.js';
import { publicMediaUrl, relayUrl, webFetch } from '../src/smm/relay.js';
import { saveSmmSettings } from '../src/smm/settings.js';
import { SmmError } from '../src/smm/types.js';

interface Call {
  url: string;
  init: RequestInit;
  body: Record<string, unknown> | undefined;
}

type Handler = (url: string, call: Call) => Response | Promise<Response>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const chat = (content: string, cost = 1, finish = 'stop') =>
  json({ choices: [{ finish_reason: finish, message: { content } }], usage: { cost_rub: cost } });

const opened: AppContext[] = [];

/**
 * Контекст без app.ts и test/helpers.ts (они тянут маршруты и бота с модулями остальных частей раздела); сеть —
 * только через подменённый smmFetch, настоящей сети нет. Бот ядру не нужен.
 */
function makeCtx(env: Record<string, string> = {}, handler: Handler = () => json({}, 500)) {
  const config = loadConfig({
    JWT_SECRET: 'test-secret-test-secret-test-secret-42',
    ADMIN_PASSWORD: 'secret123',
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'mikan-smm-core-')),
    AI_API_KEY: 'polza-test-key',
    PUBLIC_URL: 'https://crm.mikan.test',
    ...env,
  });
  const { db, sqlite } = openDatabase(':memory:');
  seedDatabase(db, config);
  const calls: Call[] = [];
  const smmFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    let body: Record<string, unknown> | undefined;
    try {
      body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    } catch {
      body = undefined;
    }
    const call = { url, init, body };
    calls.push(call);
    return handler(url, call);
  }) as typeof fetch;
  const ctx: AppContext = {
    db,
    sqlite,
    config,
    log: silentLogger,
    gateway: {} as BotGateway,
    ai: null,
    qr: null,
    smmFetch,
    onBotSettingsChanged: () => undefined,
  };
  opened.push(ctx);
  return { ctx, calls };
}

afterEach(() => {
  for (const ctx of opened.splice(0)) {
    ctx.sqlite.close();
    fs.rmSync(ctx.config.dataDir, { recursive: true, force: true });
  }
});

const Title = z.object({ title: z.string().min(1) });

describe('smm ai: chatJson', () => {
  it('ответ не по схеме — второй заход с текстом ошибки, расходы — в профиль', async () => {
    const answers = [chat('Вот ваш план: без JSON', 1.5), chat('```json\n{"title":"Уход за проколом"}\n```', 2)];
    const { ctx, calls } = makeCtx({}, () => answers.shift() ?? json({}, 500));

    const result = await chatJson(ctx, 'author', { system: 'sys', user: 'Тема поста', schema: Title, note: 'тест' });

    expect(result).toEqual({ title: 'Уход за проколом' });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe('https://polza.ai/api/v1/chat/completions');
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe('Bearer polza-test-key');
    expect(calls[0]?.body).toMatchObject({ model: SMM_MODELS.text, response_format: { type: 'json_object' } });
    const retry = calls[1]?.body?.['messages'] as { role: string; content: string }[];
    expect(retry.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(retry[3]?.content).toContain('Ответ не прошёл проверку');
    expect(await monthSpend(ctx, 'author')).toBe(3.5);
    expect(await monthSpend(ctx, 'studio')).toBe(0);
  });

  it('оборванный ответ — просьба короче; два неверных ответа — понятная ошибка 502', async () => {
    const answers = [chat('{"title":', 1, 'length'), chat('{"title":""}')];
    const { ctx, calls } = makeCtx({}, () => answers.shift() ?? json({}, 500));

    const failure = chatJson(ctx, 'studio', { system: 's', user: 'u', schema: Title });

    await expect(failure).rejects.toMatchObject({ status: 502, message: 'Маркетолог ответил не по форме — попробуйте ещё раз' });
    const retry = calls[1]?.body?.['messages'] as { role: string; content: string }[];
    expect(retry.map((m) => m.role)).toEqual(['system', 'user', 'user']);
    expect(retry[2]?.content).toContain('Ответ оборвался');
  });

  it('модели и адрес — из настроек сервера', async () => {
    const { ctx, calls } = makeCtx({ AI_BASE_URL: 'https://gw.example.test/api/', SMM_TEXT_MODEL: 'x/text-1' }, () =>
      chat('{"title":"ok"}'),
    );

    await chatJson(ctx, 'studio', { system: 's', user: [{ type: 'text', text: 'u' }], schema: Title });

    expect(calls[0]?.url).toBe('https://gw.example.test/api/v1/chat/completions');
    expect(calls[0]?.body?.['model']).toBe('x/text-1');
    expect(smmModels(ctx)).toEqual({
      text: 'x/text-1',
      image: SMM_MODELS.image,
      imageFallback: SMM_MODELS.imageFallback,
      video: SMM_MODELS.video,
    });
  });

  it('без ключа — 400 с подсказкой, отказ Polza — понятные ошибки', async () => {
    const noKey = makeCtx({ AI_API_KEY: '' });
    await expect(chatJson(noKey.ctx, 'studio', { system: 's', user: 'u', schema: Title })).rejects.toMatchObject({
      status: 400,
      code: 'validation_error',
      message: 'Ключ нейросетей не настроен на сервере (AI_API_KEY)',
    });
    expect(noKey.calls).toHaveLength(0);

    const broke = makeCtx({}, () => json({ error: { code: 'INSUFFICIENT_BALANCE', message: 'Недостаточно средств' } }, 402));
    await expect(chatJson(broke.ctx, 'studio', { system: 's', user: 'u', schema: Title })).rejects.toMatchObject({
      status: 402,
      code: 'payment_required',
      message: 'На балансе Polza не хватает денег — пополните баланс на polza.ai',
    });

    const rejected = makeCtx({}, () => json({ error: { message: 'bad key' } }, 401));
    await expect(chatJson(rejected.ctx, 'studio', { system: 's', user: 'u', schema: Title })).rejects.toMatchObject({
      status: 400,
      message: 'Ключ Polza не принят — проверьте AI_API_KEY на сервере',
    });

    const offline = makeCtx({}, () => Promise.reject(new TypeError('fetch failed')));
    await expect(chatJson(offline.ctx, 'studio', { system: 's', user: 'u', schema: Title })).rejects.toMatchObject({
      status: 502,
      message: 'Нет связи с нейросетью — попробуйте ещё раз',
    });
  });
});

describe('smm ai: бюджет профиля', () => {
  it('бюджет автора исчерпан — 402 без запроса к Polza; студия работает', async () => {
    const { ctx, calls } = makeCtx({}, () => chat('{"title":"ok"}'));
    saveSmmSettings(ctx.db, 'author', { monthlyBudget: 10 });
    await recordSpend(ctx, 'author', 'text', 'm', 8);

    const failure = chatJson(ctx, 'author', { system: 's', user: 'u', schema: Title });

    await expect(failure).rejects.toBeInstanceOf(SmmError);
    await expect(chatJson(ctx, 'author', { system: 's', user: 'u', schema: Title })).rejects.toMatchObject({
      status: 402,
      code: 'payment_required',
      message: 'Бюджет на нейросети в этом месяце закончился (8 из 10 ₽) — увеличьте его в настройках СММ',
    });
    await expect(generateImage(ctx, 'author', { prompt: 'p', aspect: '4:5' })).rejects.toMatchObject({ status: 402 });
    expect(calls).toHaveLength(0);
    await expect(chatJson(ctx, 'studio', { system: 's', user: 'u', schema: Title })).resolves.toEqual({ title: 'ok' });
  });

  it('месяц считается с первого числа по времени студии; без бюджета — без ограничения', async () => {
    const { ctx } = makeCtx({}, () => chat('{"title":"ok"}'));
    const monthStart = DateTime.now().setZone(studioTimezone(ctx.db)).startOf('month').toMillis();
    ctx.db
      .insert(smmSpend)
      .values([
        { profile: 'studio', at: monthStart - 1, kind: 'text', model: 'm', costRub: 100 },
        { profile: 'studio', at: monthStart, kind: 'image', model: 'm', costRub: 4 },
        { profile: 'author', at: monthStart + 1, kind: 'video', model: 'm', costRub: 45 },
      ])
      .run();
    await recordSpend(ctx, 'studio', 'text', 'm', 0);

    expect(await monthSpend(ctx, 'studio')).toBe(4);
    saveSmmSettings(ctx.db, 'studio', { monthlyBudget: 0 });
    await recordSpend(ctx, 'studio', 'text', 'm', 1_000_000);
    await expect(chatJson(ctx, 'studio', { system: 's', user: 'u', schema: Title })).resolves.toEqual({ title: 'ok' });
  });
});

describe('smm ai: картинки, видео, баланс', () => {
  it('основная модель картинок не справилась — запасная, 4:5 → 3:4', async () => {
    const { ctx, calls } = makeCtx({}, (_url, call) =>
      call.body?.['model'] === SMM_MODELS.image
        ? json({ error: { message: 'provider down' } }, 500)
        : json({ id: 'img-1', status: 'completed', data: [{ url: 'https://cdn.polza.test/img.jpg' }], usage: { cost_rub: 4 } }),
    );

    const result = await generateImage(ctx, 'studio', {
      prompt: 'Мастер готовит стерильный набор',
      aspect: '4:5',
      references: ['https://crm.mikan.test/uploads/smm-zone.jpg'],
    });

    expect(result).toEqual({ url: 'https://cdn.polza.test/img.jpg', cost: 4, model: SMM_MODELS.imageFallback });
    expect(calls.map((c) => c.url)).toEqual(['https://polza.ai/api/v1/media', 'https://polza.ai/api/v1/media']);
    expect(calls[0]?.body?.['input']).toMatchObject({ aspect_ratio: '4:5', image_resolution: '1K', output_format: 'jpeg' });
    expect(calls[1]?.body?.['input']).toMatchObject({
      aspect_ratio: '3:4',
      images: [{ type: 'url', data: 'https://crm.mikan.test/uploads/smm-zone.jpg' }],
    });
    expect(await monthSpend(ctx, 'studio')).toBe(4);
  });

  it('видео: запуск с первым кадром, опрос, расход по завершении', async () => {
    const states = [json({ id: 'vid-1', status: 'processing' }), json({ status: 'pending' }), json({
      status: 'completed',
      data: { video_url: 'https://cdn.polza.test/v.mp4' },
      usage: { cost_rub: 45 },
    })];
    const { ctx, calls } = makeCtx({ SMM_VIDEO_MODEL: 'x/video-2' }, () => states.shift() ?? json({}, 500));

    const started = await startVideo(ctx, 'author', { prompt: 'Piercing studio', aspect: '9:16', firstFrame: 'https://f/1.jpg' });
    const pending = await pollVideo(ctx, 'author', started.polzaId);
    const done = await pollVideo(ctx, 'author', started.polzaId);

    expect(started).toEqual({ polzaId: 'vid-1', model: 'x/video-2' });
    expect(calls[0]?.body).toMatchObject({
      model: 'x/video-2',
      async: true,
      input: { generationType: 'FIRST_AND_LAST_FRAMES_2_VIDEO', images: [{ type: 'url', data: 'https://f/1.jpg' }] },
    });
    expect(calls[1]?.url).toBe('https://polza.ai/api/v1/media/vid-1');
    expect(pending).toEqual({ status: 'pending' });
    expect(done).toEqual({ status: 'done', url: 'https://cdn.polza.test/v.mp4', cost: 45 });
    expect(await monthSpend(ctx, 'author')).toBe(45);
  });

  it('видео: режим не принят — повтор без него', async () => {
    const answers = [json({ error: { message: 'unknown generationType' } }, 400), json({ id: 'vid-2', status: 'pending' })];
    const { ctx, calls } = makeCtx({}, () => answers.shift() ?? json({}, 500));

    expect(await startVideo(ctx, 'studio', { prompt: 'p', aspect: '9:16' })).toMatchObject({ polzaId: 'vid-2' });
    expect(calls[1]?.body?.['input']).not.toHaveProperty('generationType');
  });

  it('баланс Polza; недоступен — null', async () => {
    const ok = makeCtx({}, () => json({ amount: '1234.50' }));
    expect(await polzaBalance(ok.ctx)).toBe(1234.5);
    expect(ok.calls[0]?.url).toBe('https://polza.ai/api/v1/balance');
    const down = makeCtx({}, () => json({}, 503));
    expect(await polzaBalance(down.ctx)).toBeNull();
  });

  it('extractJson и resultUrl понимают разные формы ответа', () => {
    expect(extractJson('Ответ:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(() => extractJson('нет')).toThrow();
    expect(resultUrl([{ url: 'ftp://x' }, { image_url: 'https://a/1.png' }])).toBe('https://a/1.png');
    expect(resultUrl({ output: { url: 'https://a/2.mp4' } })).toBe('https://a/2.mp4');
    expect(resultUrl('не ссылка')).toBeNull();
  });
});

describe('smm files', () => {
  const name = `smm-${randomUUID()}.jpg`;

  it('путь на диске только для своих файлов /uploads/smm-…', () => {
    const { ctx } = makeCtx();
    const dir = path.join(ctx.config.dataDir, 'uploads');

    expect(smmFilePath(ctx, `/uploads/${name}`)).toBe(path.join(dir, name));
    expect(smmFilePath(ctx, `https://crm.mikan.test/uploads/${name}`)).toBe(path.join(dir, name));
    for (const bad of [
      `/uploads/../${name}`,
      `/uploads/smm-../../etc/passwd`,
      '/uploads/smm-%2e%2e%2fsecret.jpg',
      `/uploads/sub/${name}`,
      '/uploads/photo.jpg',
      `https://evil.test/uploads/${name}`,
      `/uploads/${name}?x=1`,
      '',
    ]) {
      expect(smmFilePath(ctx, bad)).toBeNull();
    }
  });

  it('сохраняет, скачивает с лимитом размера и удаляет файлы', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const { ctx, calls } = makeCtx({}, (url) =>
      url.endsWith('/big.mp4') ? new Response(Buffer.alloc(2048)) : new Response(png, { status: 200 }),
    );

    const saved = await saveSmmFile(ctx, png, '.PNG');
    const stored = await storeRemote(ctx, 'https://cdn.polza.test/result.jpg', 'jpeg');

    expect(saved).toMatch(/^\/uploads\/smm-[0-9a-f-]{36}\.png$/);
    expect(stored).toMatch(/^\/uploads\/smm-[0-9a-f-]{36}\.jpg$/);
    expect(fs.readFileSync(smmFilePath(ctx, stored)!)).toEqual(png);
    expect(calls.map((c) => c.url)).toEqual(['https://cdn.polza.test/result.jpg']);
    await expect(storeRemote(ctx, 'https://cdn.polza.test/big.mp4', 'mp4', 1024)).rejects.toMatchObject({ status: 502 });
    await expect(storeRemote(ctx, 'http://cdn.polza.test/a.jpg', 'jpg')).rejects.toMatchObject({ status: 502 });
    await expect(saveSmmFile(ctx, png, '../x')).rejects.toMatchObject({ status: 400 });

    await removeSmmFile(ctx, saved);
    await removeSmmFile(ctx, 'https://elsewhere.test/a.jpg');
    expect(fs.existsSync(smmFilePath(ctx, saved)!)).toBe(false);
  });

  it('полная ссылка — PUBLIC_URL + путь, чужие ссылки — как есть', () => {
    const { ctx } = makeCtx({ PUBLIC_URL: 'https://crm.mikan.test/' });
    expect(absoluteUrl(ctx, '/uploads/smm-a.jpg')).toBe('https://crm.mikan.test/uploads/smm-a.jpg');
    expect(absoluteUrl(ctx, 'https://drive.google.com/x')).toBe('https://drive.google.com/x');
  });
});

describe('smm relay', () => {
  const worker = { TELEGRAM_API_ROOT: 'https://tg.mikan.workers.dev', SMM_RELAY_KEY: 'k'.repeat(24) };

  it('с ключом — через шлюз, без ключа или без шлюза — напрямую', () => {
    const relayed = makeCtx(worker).ctx;
    const direct = makeCtx({ TELEGRAM_API_ROOT: 'https://tg.mikan.workers.dev' }).ctx;
    const noWorker = makeCtx({ SMM_RELAY_KEY: 'k'.repeat(24) }).ctx;
    const url = 'https://graph.instagram.com/v21.0/me/media?fields=id,caption&limit=5';

    expect(relayUrl(relayed, url)).toBe(
      `https://tg.mikan.workers.dev/web/${'k'.repeat(24)}/graph.instagram.com/v21.0/me/media?fields=id,caption&limit=5`,
    );
    expect(relayUrl(relayed, 'http://t.me/s/mikan')).toBe('http://t.me/s/mikan');
    expect(relayUrl(direct, url)).toBe(url);
    expect(relayUrl(noWorker, url)).toBe(url);
  });

  it('ссылка на наш файл для Meta — через /media шлюза, иначе PUBLIC_URL', () => {
    const file = `/uploads/smm-${randomUUID()}.jpg`;
    const relayed = makeCtx(worker).ctx;
    const direct = makeCtx().ctx;

    expect(publicMediaUrl(relayed, file)).toBe(`https://tg.mikan.workers.dev/media/${file.slice('/uploads/'.length)}`);
    expect(publicMediaUrl(relayed, 'https://lh3.googleusercontent.com/d/abc')).toBe('https://lh3.googleusercontent.com/d/abc');
    expect(publicMediaUrl(direct, file)).toBe(`https://crm.mikan.test${file}`);
  });

  it('webFetch идёт через smmFetch по адресу шлюза с браузерным User-Agent', async () => {
    const { ctx, calls } = makeCtx(worker, () => new Response('<html></html>'));

    const res = await webFetch(ctx, 'https://t.me/s/mikan_studio?before=10', { headers: { accept: 'text/html' } });

    expect(await res.text()).toBe('<html></html>');
    expect(calls[0]?.url).toBe(`https://tg.mikan.workers.dev/web/${'k'.repeat(24)}/t.me/s/mikan_studio?before=10`);
    expect(calls[0]?.init).toMatchObject({ method: 'GET', headers: { accept: 'text/html' } });
    expect((calls[0]?.init.headers as Record<string, string>)['user-agent']).toMatch(/^Mozilla/);
  });
});

describe('secrets', () => {
  const ctx = { config: { jwtSecret: 'test-secret-test-secret-test-secret-42' } };

  it('шифрует и расшифровывает; подмена, чужой ключ и чужой формат — ошибка', () => {
    const enc = encryptSecret(ctx, 'IGQVJ-token-ёжик');

    expect(enc).toMatch(/^v1:[A-Za-z0-9+/=]+$/);
    expect(enc).not.toContain('IGQVJ');
    expect(encryptSecret(ctx, 'IGQVJ-token-ёжик')).not.toBe(enc);
    expect(decryptSecret(ctx, enc)).toBe('IGQVJ-token-ёжик');

    const raw = Buffer.from(enc.slice(3), 'base64');
    raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 1;
    expect(() => decryptSecret(ctx, `v1:${raw.toString('base64')}`)).toThrow();
    expect(() => decryptSecret({ config: { jwtSecret: 'another-secret-another-secret-123' } }, enc)).toThrow();
    expect(() => decryptSecret(ctx, 'v2:abc')).toThrow();
    expect(() => decryptSecret(ctx, 'v1:')).toThrow();
    expect(maskSecret('IGQVJ-token')).toBe('••••oken');
    expect(maskSecret('abc')).toBe('••••');
  });
});

describe('config: SMM', () => {
  const base = { JWT_SECRET: 'x'.repeat(32), ADMIN_PASSWORD: 'secret123', DATA_DIR: '/tmp/mikan-unused' };

  it('модели Titan по умолчанию, переменные их меняют', () => {
    expect(loadConfig(base).smm).toEqual({
      textModel: 'google/gemini-3.8-flash',
      imageModel: 'google/gemini-nano-banana-2.1',
      videoModel: 'google/veo3_fast',
      imageResolution: '1K',
      relayKey: null,
    });
    expect(
      loadConfig({ ...base, SMM_IMAGE_MODEL: ' x/img ', SMM_IMAGE_RESOLUTION: '2k', SMM_RELAY_KEY: 'abcDEF123_-abcdef', SMM_TEXT_MODEL: '' }).smm,
    ).toMatchObject({ textModel: 'google/gemini-3.8-flash', imageModel: 'x/img', imageResolution: '2K', relayKey: 'abcDEF123_-abcdef' });
  });

  it('неверные значения — ошибка конфигурации', () => {
    expect(() => loadConfig({ ...base, SMM_IMAGE_RESOLUTION: '8K' })).toThrow(/SMM_IMAGE_RESOLUTION/);
    expect(() => loadConfig({ ...base, SMM_RELAY_KEY: 'short' })).toThrow(/SMM_RELAY_KEY/);
    expect(() => loadConfig({ ...base, SMM_RELAY_KEY: 'has/slash/inside-the-key' })).toThrow(/SMM_RELAY_KEY/);
  });
});
