import type Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotPipeline } from '../src/bot/pipeline.js';
import { buildStablePrompt } from '../src/bot/prompt.js';
import { creditGiftBonuses } from '../src/domain/bonuses.js';
import { linkTelegram } from '../src/domain/clients.js';
import { createTestApp, make, message, openShift, ScriptedAi, text, toolUse, type TestApp } from './helpers.js';

const NOW = Date.parse('2026-10-15T09:00:00.000Z');
const CHAT = 700_042;
const from = { chatId: CHAT, telegramName: 'Анна', username: 'anna' };

describe('bot: bonuses and gift certificates for clients', () => {
  let t: TestApp;
  let ai: ScriptedAi;
  let pipeline: BotPipeline;
  let buyer: { id: number };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    ai = new ScriptedAi();
    t = await createTestApp({ ai });
    await openShift(t);
    pipeline = new BotPipeline(t.ctx, 0);
    buyer = await make(t, '/api/clients', { name: 'Ольга', lastName: 'Смирнова', phone: '+79990002233' });
  });
  afterEach(async () => {
    vi.useRealTimers();
    await t.close();
  });

  const say = async (msg: string) => {
    pipeline.receive(from, msg);
    await pipeline.idle();
  };
  /** The tool results the model got back in its second call. */
  const toolResults = () => {
    const last = ai.calls[1]!.messages.at(-1)!;
    return (last.content as Anthropic.ToolResultBlockParam[]).filter((b) => b.type === 'tool_result').map((b) => b.content);
  };
  const sellCertificate = async () => {
    const sale = await make(t, '/api/sales', {
      clientId: buyer.id,
      items: [{ type: 'certificate', price: 5000, recipientName: 'Маше' }],
      discount: 0,
      payments: { cash: 5000 },
    });
    return sale.items[0].name.replace('Подарочный сертификат ', '') as string;
  };

  it('offers certificate_balance and explains bonuses and certificates in the rules', () => {
    const prompt = buildStablePrompt(t.ctx.db);
    expect(prompt).toContain('12. Бонусы и подарочные сертификаты:');
    expect(prompt).toContain('certificate_balance');
  });

  it('answers a certificate code with its balance and validity, never the buyer', async () => {
    const code = await sellCertificate();
    await make(t, '/api/sales', {
      items: [{ type: 'service', name: 'Прокол', price: 2000, quantity: 1 }],
      discount: 0,
      payments: { cash: 0, certificates: [{ code, amount: 2000 }] },
    });
    ai.push(message([toolUse('c', 'certificate_balance', { code: code.toLowerCase() })], 'tool_use'), message([text('На сертификате 3 000 ₽.')]));
    await say(`Сколько осталось на сертификате ${code.toLowerCase()}?`);
    expect(ai.calls[0]!.tools?.map((tool) => (tool as Anthropic.Tool).name)).toContain('certificate_balance');
    const [result] = toolResults();
    expect(result).toBe(`Сертификат ${code} действует до 15 октября 2027: на нём 3 000 ₽ из 5 000 ₽. Оплатить им можно в студии.`);
    expect(String(result)).not.toContain('Ольга');
    expect(t.gateway.textsTo(CHAT)).toEqual(['На сертификате 3 000 ₽.']);
  });

  it('says when a code is unknown or no longer valid', async () => {
    const code = await sellCertificate();
    await t.api('POST', `/api/certificates/${(await t.api('GET', `/api/certificates/code/${code}`)).json().id}/cancel`, { reason: 'Тест' });
    ai.push(
      message([toolUse('a', 'certificate_balance', { code: 'MIKAN-AAAA-AAAA' }), toolUse('b', 'certificate_balance', { code })], 'tool_use'),
      message([text('Проверьте код, пожалуйста.')]),
    );
    await say('Проверьте сертификаты');
    expect(toolResults()).toEqual([
      'Сертификат с таким кодом не найден. Попроси клиента проверить код (формат MIKAN-XXXX-XXXX).',
      `Сертификат ${code} аннулирован. Подробности — у администратора.`,
    ]);
  });

  it('puts the linked client\'s bonus balance into the context while loyalty is on', async () => {
    const anna = await make(t, '/api/clients', { name: 'Анна', phone: '+79990001122' });
    linkTelegram(t.ctx.db, anna.id, CHAT, 'anna');
    await make(t, `/api/clients/${anna.id}/bonuses`, { amount: 1000, note: 'Старт' });
    creditGiftBonuses(t.ctx.db, anna.id, 200, 18, 'Подарок');
    ai.push(message([text('У вас 1 200 бонусов.')]));
    await say('Сколько у меня бонусов?');
    const context = (ai.calls[0]!.system as Anthropic.TextBlockParam[])[1]!.text;
    expect(context).toContain(
      'Бонусы клиента: 1 200 (1 бонус = 1 ₽, ими можно оплатить до 30% чека в студии); 200 из них действуют до 2 ноября.',
    );

    await t.api('PUT', '/api/settings/retention', { loyalty: { enabled: false } });
    ai.push(message([text('Хорошо.')]));
    await say('Спасибо');
    expect((ai.calls[1]!.system as Anthropic.TextBlockParam[])[1]!.text).not.toContain('Бонусы клиента');
  });
});
