import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAiClient, describeAiError } from '../src/bot/ai.js';
import { handleStaffCommand } from '../src/bot/onboarding.js';
import { BotPipeline, REPLIES, runTest } from '../src/bot/pipeline.js';
import { issueStaffCode } from '../src/bot/staff.js';
import { testConfig } from './helpers.js';
import { createTestApp, make, message, ScriptedAi, text, toolUse, type TestApp } from './helpers.js';

const CHAT = 700_001;
const STAFF = -100_500;
const from = { chatId: CHAT, telegramName: 'Мария', username: 'masha' };

describe('bot AI pipeline', () => {
  let t: TestApp;
  let ai: ScriptedAi;
  let pipeline: BotPipeline;

  async function setup(env: Record<string, string> = {}, withAi = true) {
    ai = new ScriptedAi();
    t = await createTestApp({ ai: withAi ? ai : null, env });
    pipeline = new BotPipeline(t.ctx, 0);
    const { code } = issueStaffCode(t.ctx.db);
    expect(handleStaffCommand(t.ctx, STAFF, code)).toMatch(/^✅/);
  }
  const say = async (msg: string, image?: { data: string; mediaType: 'image/jpeg' }) => {
    pipeline.receive(from, msg, image);
    await pipeline.idle();
  };
  const chat = async () => (await t.api('GET', '/api/bot/chats')).json().items.find((c: { chatId: number }) => c.chatId === CHAT);
  const staffTexts = () => t.gateway.textsTo(STAFF);

  afterEach(async () => {
    await t.close();
  });

  describe('with AI configured', () => {
    beforeEach(async () => {
      await setup();
    });

    it('answers with a cached stable system prompt, low effort, auto tool choice and no fallbacks', async () => {
      const lobe = await make(t, '/api/services', { name: 'Прокол мочки', category: 'piercing', price: 2500, durationMin: 30 });
      ai.push(message([text('Прокол мочки стоит 2 500 ₽.')]));
      await say('Сколько стоит прокол мочки?');

      expect(t.gateway.textsTo(CHAT)).toEqual(['Прокол мочки стоит 2 500 ₽.']);
      const params = ai.calls[0]!;
      expect(params.model).toBe('test-model');
      expect(params.output_config).toEqual({ effort: 'low' });
      expect(params.tool_choice).toEqual({ type: 'auto' });
      expect(params).not.toHaveProperty('fallbacks');
      expect(params).not.toHaveProperty('thinking');
      expect(params.tools?.map((tool) => (tool as Anthropic.Tool).name)).toEqual([
        'create_booking_request', 'handoff_to_staff', 'show_products', 'show_service', 'show_portfolio',
        'show_jewelry_for_service', 'find_jewelry', 'my_appointments', 'free_slots', 'book_appointment', 'join_waitlist',
        'reschedule_appointment',
        'certificate_balance', 'cabinet_link',
      ]);
      const system = params.system as Anthropic.TextBlockParam[];
      expect(system[0]!.cache_control).toEqual({ type: 'ephemeral' });
      expect(system[0]!.text).toContain(`### Пирсинг\n• [id ${lobe.id}] Прокол мочки · 2 500 ₽ · около 30 мин`);
      expect(system[0]!.text).toContain('### Возраст 18+ и согласие родителей');
      expect(system[0]!.text).not.toContain('⚠️');
      expect(system[1]!.text).toContain('Клиент не идентифицирован, имя в Telegram: Мария');
      expect(system[1]).not.toHaveProperty('cache_control');
      expect(params.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Сколько стоит прокол мочки?' }] }]);

      const c = await chat();
      expect(c).toMatchObject({ telegramName: 'Мария', username: 'masha', unreadCount: 1, needsAttention: false, aiPaused: false, client: null });
      expect(c.lastMessage).toMatchObject({ role: 'assistant', text: 'Прокол мочки стоит 2 500 ₽.', employee: null });
      expect((await t.api('GET', '/api/badges')).json().unreadChats).toBe(1);
    });

    it('creates a booking request through the tool loop (append-only history) and notifies staff', async () => {
      ai.push(
        message([text('Оформляю заявку.'), toolUse('tu_1', 'create_booking_request', {
          contactName: 'Мария', phone: '8 999 111-22-33', serviceName: 'Прокол хеликса', preferredTime: 'суббота после 15:00', comment: '',
        })], 'tool_use'),
        message([text('Готово! Администратор свяжется с вами для подтверждения.')]),
      );
      await say('Хочу записаться на хеликс в субботу после 15, Мария, 89991112233');

      const bookings = (await t.api('GET', '/api/booking-requests?status=new')).json().items;
      expect(bookings).toHaveLength(1);
      expect(bookings[0]).toMatchObject({
        chatId: CHAT, client: null, contactName: 'Мария', phone: '+79991112233', serviceName: 'Прокол хеликса',
        preferredTime: 'суббота после 15:00', comment: null, status: 'new',
      });
      expect(staffTexts()[0]).toContain('📅 Новая заявка на запись №1');
      expect(staffTexts()[0]).toContain('Телефон: +79991112233');
      expect(t.gateway.textsTo(CHAT)).toEqual(['Оформляю заявку.\n\nГотово! Администратор свяжется с вами для подтверждения.']);

      const second = ai.calls[1]!.messages;
      expect(second).toHaveLength(3);
      expect(second[1]).toMatchObject({ role: 'assistant', content: [{ type: 'text' }, { type: 'tool_use', id: 'tu_1' }] });
      expect(second[2]).toEqual({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: expect.stringContaining('Заявка №1 создана'), is_error: false }],
      });
      expect((await t.api('GET', '/api/badges')).json().newBookingRequests).toBe(1);
      const processed = await t.api('PATCH', `/api/booking-requests/${bookings[0].id}`, { status: 'processed' });
      expect(processed.json().status).toBe('processed');
      expect((await t.api('PATCH', '/api/booking-requests/99', { status: 'processed' })).statusCode).toBe(404);
    });

    it('returns tool errors to the model for invalid input and unknown tools', async () => {
      ai.push(
        message([toolUse('a', 'create_booking_request', { contactName: 'М', phone: '12', serviceName: 'x', preferredTime: 'y' }), toolUse('b', 'nope', {})], 'tool_use'),
        message([text('Уточните, пожалуйста, номер телефона.')]),
      );
      await say('Запишите меня');
      const results = ai.calls[1]!.messages[2]!.content as Anthropic.ToolResultBlockParam[];
      expect(results.map((r) => r.is_error)).toEqual([true, true]);
      expect(String(results[0]!.content)).toContain('проверь поля phone');
      expect((await t.api('GET', '/api/booking-requests')).json().items).toHaveLength(0);
    });

    it('hands off to staff on medical red flags', async () => {
      ai.push(
        message([toolUse('h', 'handoff_to_staff', { reason: 'Гной и температура после прокола' })], 'tool_use'),
        message([text('Пожалуйста, свяжитесь с мастером и обратитесь к врачу. Администратор уже в курсе.')]),
      );
      await say('У меня гной и температура 38');
      expect((await chat()).needsAttention).toBe(true);
      expect(staffTexts()[0]).toContain('Причина: Гной и температура после прокола');
      expect(staffTexts()[0]).toContain('Последнее сообщение: «У меня гной и температура 38»');
      expect((await t.api('GET', '/api/badges')).json().needsAttention).toBe(1);
    });

    it('sends product photos after the text reply', async () => {
      const uploads = path.join(t.ctx.config.dataDir, 'uploads');
      fs.writeFileSync(path.join(uploads, 'labret.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
      const withPhoto = await make(t, '/api/products', { kind: 'jewelry', name: 'Лабрет', material: 'Титан', price: 1500, initialQuantity: 2, photoUrl: '/uploads/labret.jpg' });
      const noPhoto = await make(t, '/api/products', { kind: 'jewelry', name: 'Кольцо', price: 900, initialQuantity: 1 });
      const soldOut = await make(t, '/api/products', { kind: 'jewelry', name: 'Нет в наличии', price: 900 });
      ai.push(
        message([toolUse('p', 'show_products', { productIds: [withPhoto.id, noPhoto.id, soldOut.id] })], 'tool_use'),
        message([text('Вот варианты:')]),
      );
      await say('Покажите украшения');
      expect(ai.calls[0]!.system).toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining(`[id ${withPhoto.id}] Лабрет · Титан · 1 500 ₽ · есть фото`) })]));
      expect(t.gateway.textsTo(CHAT)).toEqual(['Вот варианты:', '**Кольцо** — 900 ₽']);
      expect(t.gateway.photos).toEqual([
        { chatId: CHAT, photo: { kind: 'file', path: path.join(uploads, 'labret.jpg') }, caption: '**Лабрет · Титан** — 1 500 ₽' },
      ]);
      const history = (await t.api('GET', `/api/bot/chats/${CHAT}/messages`)).json().items.map((m: { text: string }) => m.text);
      expect(history).toEqual(['Покажите украшения', 'Вот варианты:', '[Фото] **Лабрет · Титан** — 1 500 ₽', '**Кольцо** — 900 ₽']);
    });

    it('falls back politely on refusal and on API errors, flagging the chat and alerting staff', async () => {
      ai.push(message([], 'refusal'));
      await say('...');
      expect(t.gateway.textsTo(CHAT)).toEqual([REPLIES.refusal]);
      expect((await chat()).needsAttention).toBe(true);
      expect(staffTexts()[0]).toContain('ИИ отказался отвечать');

      ai.push(Anthropic.APIError.generate(500, { error: { code: 'upstream_error', message: 'boom' }, trace_id: 'tr-9' }, undefined, new Headers()));
      await say('Алло?');
      expect(t.gateway.textsTo(CHAT)[1]).toBe(REPLIES.error);
      expect(staffTexts()[1]).toContain('ошибка ИИ');

      ai.push(message([text('обрыв')], 'max_tokens'));
      await say('Длинный вопрос');
      expect(t.gateway.textsTo(CHAT)[2]).toBe(REPLIES.error);

      const usage = (await t.api('GET', '/api/badges')).json();
      expect(usage.needsAttention).toBe(1);
    });

    it('does not call the AI while paused; notifies staff instead; staff replies clear attention', async () => {
      pipeline.receive(from, 'Первое');
      await pipeline.idle();
      expect((await t.api('PATCH', `/api/bot/chats/${CHAT}`, { aiPaused: true })).json().aiPaused).toBe(true);
      await say('Есть кто живой?');
      expect(ai.calls).toHaveLength(1); // the first message only (it failed: no script → fallback)
      expect(staffTexts().some((s) => s.includes('(ИИ на паузе): «Есть кто живой?»'))).toBe(true);

      const reply = await t.api('POST', `/api/bot/chats/${CHAT}/messages`, { text: 'Здравствуйте, это администратор!' });
      expect(reply.statusCode).toBe(200);
      expect(reply.json()).toMatchObject({ chatId: CHAT, role: 'staff', text: 'Здравствуйте, это администратор!', employee: { id: 1, name: 'Админ' } });
      expect((await chat()).needsAttention).toBe(false);
      expect(t.gateway.textsTo(CHAT)).toContain('Здравствуйте, это администратор!');

      await t.api('PATCH', `/api/bot/chats/${CHAT}`, { aiPaused: false });
      ai.push(message([text('Чем помочь?')]));
      await say('Спасибо');
      const turns = ai.calls[1]!.messages;
      const assistantTexts = JSON.stringify(turns.filter((m) => m.role === 'assistant'));
      expect(assistantTexts).toContain('[Администратор] Здравствуйте, это администратор!');
    });

    it('passes client photos to Claude as image blocks', async () => {
      ai.push(message([text('Выглядит как нормальное заживление, но покажите мастеру.')]));
      await say('[Фото] Это нормально?', { data: 'aGVsbG8=', mediaType: 'image/jpeg' });
      const content = ai.calls[0]!.messages[0]!.content as Anthropic.ContentBlockParam[];
      expect(content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'aGVsbG8=' } });
      expect(content[1]).toEqual({ type: 'text', text: '[Фото] Это нормально?' });
    });

    it('answers voice/video with a request to write text, without AI', async () => {
      await pipeline.receiveUnsupported(from, '[Голосовое сообщение]');
      expect(t.gateway.textsTo(CHAT)).toEqual([REPLIES.media]);
      expect(ai.calls).toHaveLength(0);
    });

    it('runs /bot/test without Telegram side effects', async () => {
      ai.push(
        message([toolUse('x', 'create_booking_request', { contactName: 'Тест', phone: '+79990000000', serviceName: 'Тату', preferredTime: 'завтра' })], 'tool_use'),
        message([text('Заявка оформлена!')]),
      );
      const res = await t.api('POST', '/api/bot/test', { text: 'Запишите меня на тату' });
      expect(res.statusCode).toBe(200);
      expect(res.json().reply).toBe('Заявка оформлена!\n\n— Тест: создана бы заявка: Тест, +79990000000, Тату, завтра');
      expect((await t.api('GET', '/api/booking-requests')).json().items).toHaveLength(0);
      expect(t.gateway.sent).toHaveLength(0);

      ai.push(new Error('network down'));
      const failed = await t.api('POST', '/api/bot/test', { text: 'Привет' });
      expect(failed.statusCode).toBe(500);
      expect(failed.json().error.code).toBe('internal');
      expect((await t.api('POST', '/api/bot/test', { text: '' })).statusCode).toBe(400);
    });
  });

  describe('review regressions', () => {
    beforeEach(async () => {
      await setup();
    });

    it('answers a follow-up sent while the AI is replying, keeping chronological turns (#1, #2)', async () => {
      let call = 0;
      t.ctx.ai = {
        model: 'test-model',
        maxTokens: 4096,
        createMessage: async (params) => {
          ai.calls.push(structuredClone(params));
          call += 1;
          if (call === 1) {
            // The client writes again (with a photo) while the first reply is being generated.
            pipeline.receive(from, '[Фото] А вот так?', { data: 'aW1n', mediaType: 'image/jpeg' });
            return message([text('Ответ на первое')]);
          }
          return message([text('Ответ на второе')]);
        },
      };
      await say('Первый вопрос');
      expect(t.gateway.textsTo(CHAT)).toEqual(['Ответ на первое', 'Ответ на второе']);
      const second = ai.calls[1]!.messages;
      expect(second.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
      const lastTurn = second[2]!.content as Anthropic.ContentBlockParam[];
      expect(lastTurn[0]).toMatchObject({ type: 'image', source: { data: 'aW1n' } });
      expect(lastTurn[1]).toEqual({ type: 'text', text: '[Фото] А вот так?' });
      expect(pipeline.pendingImageCount()).toBe(0);
    });

    it('does not keep photos in memory for paused chats (#2)', async () => {
      pipeline.receive(from, 'привет');
      await pipeline.idle(); // no script → error fallback, chat exists
      await t.api('PATCH', `/api/bot/chats/${CHAT}`, { aiPaused: true });
      for (let i = 0; i < 5; i++) pipeline.receive(from, '[Фото]', { data: 'x'.repeat(1000), mediaType: 'image/jpeg' });
      await pipeline.idle();
      expect(pipeline.pendingImageCount()).toBe(0);
    });

    it('escalates undelivered replies, crashes and capped tool loops; confirms silent bookings (#10)', async () => {
      // Delivery failure of the AI reply.
      ai.push(message([text('Ответ')]));
      t.gateway.failures.push(new Error('Telegram недоступен'));
      await say('Вопрос');
      expect((await chat()).needsAttention).toBe(true);
      expect(staffTexts().at(-1)).toContain('не удалось доставить ответ бота в Telegram');
      await t.api('POST', `/api/bot/chats/${CHAT}/read`);

      // Booking created but the model ends without text → the booking is confirmed, not an error.
      ai.push(
        message([toolUse('b', 'create_booking_request', { contactName: 'Мария', phone: '+79991112233', serviceName: 'Тату', preferredTime: 'завтра' })], 'tool_use'),
        message([]),
      );
      await say('Запишите меня');
      expect(t.gateway.textsTo(CHAT).at(-1)).toBe(REPLIES.booked);
      expect((await chat()).needsAttention).toBe(false);

      // An unexpected exception inside the run is escalated instead of being only logged.
      ai.push({ stop_reason: 'end_turn', content: null, usage: {} } as unknown as Anthropic.Message);
      await say('Ещё вопрос');
      expect((await chat()).needsAttention).toBe(true);
      expect(staffTexts().at(-1)).toContain('внутренняя ошибка бота');
      await t.api('POST', `/api/bot/chats/${CHAT}/read`);

      // Tool loop cap: the partial answer is sent and staff are alerted.
      for (let i = 0; i < 5; i++) ai.push(message([text(i === 0 ? 'Смотрю...' : ''), toolUse(`h${i}`, 'show_products', { productIds: [999] })], 'tool_use'));
      await say('Покажи всё');
      expect(t.gateway.textsTo(CHAT).at(-1)).toBe('Смотрю...');
      expect(staffTexts().at(-1)).toContain('слишком много шагов');
    });
  });

  it('replies once when AI is unavailable and alerts staff once', async () => {
    await setup({}, false);
    await say('Здравствуйте');
    await say('Ау?');
    expect(t.gateway.textsTo(CHAT)).toEqual([REPLIES.unavailable]);
    expect(staffTexts().filter((s) => s.includes('ИИ-ответы отключены'))).toHaveLength(1);
    expect((await chat()).needsAttention).toBe(true);
    const test = await t.api('POST', '/api/bot/test', { text: 'Привет' });
    expect(test.statusCode).toBe(409);
  });

  it('enforces the per-chat hourly AI limit', async () => {
    await setup({ AI_CHAT_HOURLY_LIMIT: '1' });
    ai.push(message([text('Первый ответ')]));
    await say('Вопрос 1');
    await say('Вопрос 2');
    expect(t.gateway.textsTo(CHAT)).toEqual(['Первый ответ', REPLIES.limit]);
    expect(ai.calls).toHaveLength(1);
  });

  it('enforces the global daily AI limit for /bot/test', async () => {
    await setup({ AI_DAILY_LIMIT: '1' });
    ai.push(message([text('Ок')]));
    expect((await t.api('POST', '/api/bot/test', { text: 'Привет' })).statusCode).toBe(200);
    expect((await t.api('POST', '/api/bot/test', { text: 'Привет' })).statusCode).toBe(409);
  });

  it('describes API errors without credentials and builds gateway clients', () => {
    const err = Anthropic.APIError.generate(
      429,
      { error: { code: 'rate_limit', message: 'Too many requests' }, trace_id: 'trace-1' },
      undefined,
      new Headers({ 'retry-after': '7' }),
    );
    expect(describeAiError(err)).toMatchObject({ status: 429, code: 'rate_limit', traceId: 'trace-1', retryAfter: '7', message: 'Too many requests' });
    expect(describeAiError(new Error('x'))).toEqual({ message: 'x' });

    expect(createAiClient(testConfig().ai)).toBeNull();
    const polza = createAiClient(testConfig({ AI_API_KEY: 'k', AI_BASE_URL: 'https://polza.ai/api', AI_MODEL: 'anthropic/claude-opus-5.5' }).ai);
    expect(polza?.model).toBe('anthropic/claude-opus-5.5');
    const proxied = createAiClient(testConfig({ AI_API_KEY: 'k', AI_AUTH: 'x-api-key', AI_HTTPS_PROXY: 'http://127.0.0.1:9' }).ai);
    expect(proxied?.model).toBe('claude-opus-5-5');
  });

  it('runTest refuses without a client', async () => {
    await setup({}, false);
    await expect(runTest(t.ctx, 'x')).rejects.toThrow(/ИИ не настроен/);
  });
});
