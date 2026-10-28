import type Anthropic from '@anthropic-ai/sdk';
import { count, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildClientContext, buildStablePrompt } from '../src/bot/prompt.js';
import { buildToolHandlers, emptySink, TOOLS } from '../src/bot/tools.js';
import { loadAiConfig } from '../src/config.js';
import { appointments, bookingRequests, botChats, services } from '../src/db/schema.js';
import { parseCases, type EvalCase } from '../src/eval/cases.js';
import { buildEvalStudio, EVAL_CERTIFICATE_CODE, type EvalStudio } from '../src/eval/fixture.js';
import { formatReport } from '../src/eval/report.js';
import { conversationOf, exitCodeOf, runCase, runEval } from '../src/eval/runner.js';
import { aiSettingsProblem, main, parseEvalArgs, selectCases, UsageError } from '../src/scripts/ai-eval.js';
import { message, ScriptedAi, text, toolUse } from './helpers.js';

/** Thursday 15 October 2026, 10:00 in the fixture studio (Asia/Tomsk). */
const NOW = Date.parse('2026-10-15T03:00:00.000Z');
const TOMORROW = '2026-10-16';

const oneCase = (fields: Record<string, unknown>): EvalCase => parseCases({ cases: [{ id: 'c', topic: 'Тест', message: 'Привет', ...fields }] })[0]!;

describe('AI quality check: fixture and runner', () => {
  let ai: ScriptedAi;
  let studio: EvalStudio;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    ai = new ScriptedAi();
    studio = buildEvalStudio({ ai, aiConfig: loadAiConfig({}) });
  });
  afterEach(() => {
    studio.close();
    vi.useRealTimers();
  });

  const serviceId = (name: string) => studio.ctx.db.select().from(services).where(eq(services.name, name)).get()!.id;
  const toolResults = (call: number) =>
    (ai.calls[call]!.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[]).map((b) => String(b.content));

  it('builds a studio with the facts the cases check', async () => {
    const prompt = buildStablePrompt(studio.ctx.db);
    for (const fact of ['Мочка · 1 600 ₽', 'Пара (оба уха) — 2 800 ₽', 'Хеликс · 1 800 ₽', 'Трагус · 1 900 ₽', 'от 2 000 до 5 000 ₽', 'от 12 000 ₽']) {
      expect(prompt, fact).toContain(fact);
    }
    for (const fact of ['проспект Ленина', 'с 11:00 до 21:00', 'предоплата 1 000 ₽', 'не позднее чем за 24 часа', 'только с 18 лет', 'до 30% чека']) {
      expect(prompt, fact).toContain(fact);
    }
    expect(prompt).toContain('Лабрет с плоским диском');
    expect(prompt).not.toContain('Нострил-гвоздик золотой'); // out of stock
    expect(prompt).not.toContain('Проверьте'); // the seeded knowledge drafts are replaced

    const context = buildClientContext(studio.ctx.db, NOW, studio.client, null);
    expect(context).toContain('Клиент: Анна Смирнова');
    expect(context).toContain('Бонусы клиента: 1 400');
    expect(context).toContain('18 октября в 15:00 — Мини тату до 5 см, мастер Катя, ждём предоплату 1 000 ₽');

    const handlers = buildToolHandlers(studio.ctx, { mode: 'test', chatId: studio.chatId, clientId: studio.client.id, telegramName: null, username: null, lastUserText: '' }, emptySink());
    const certificate = await handlers.certificate_balance!({ code: EVAL_CERTIFICATE_CODE.toLowerCase() });
    expect(certificate.content).toContain('на нём 3 000 ₽ из 5 000 ₽');
    expect(certificate.content).not.toContain('Ольга');
    expect((await handlers.find_jewelry!({ query: 'нострил золото' })).content).toContain('нет в наличии');
    expect((await handlers.my_appointments!({})).content).toContain('Мини тату до 5 см');
  });

  it('runs a case with the production prompt, tools and client context, and checks the answer', async () => {
    ai.push(
      message([toolUse('t1', 'free_slots', { date: TOMORROW, serviceId: serviceId('Хеликс') })], 'tool_use'),
      message([text('Завтра свободно в **12:00** и **15:30** 🙂 Какое время удобно?')]),
    );
    const result = await runCase(
      studio,
      ai,
      oneCase({ message: 'Есть время на хеликс завтра?', expectTools: ['free_slots'], forbidTools: ['book_appointment'], expectHandoff: false }),
    );

    expect(result).toMatchObject({ id: 'c', passed: true, failures: [], tools: ['free_slots'], handedOff: false, outcome: 'ok' });
    expect(result.answer).toBe('Завтра свободно в **12:00** и **15:30** 🙂 Какое время удобно?');
    const first = ai.calls[0]!;
    expect(first.tools!.map((t) => (t as Anthropic.Tool).name)).toEqual(TOOLS.map((t) => t.name));
    const system = first.system as Anthropic.TextBlockParam[];
    expect(system[0]!.text).toBe(buildStablePrompt(studio.ctx.db));
    expect(system[1]!.text).toBe(buildClientContext(studio.ctx.db, NOW, studio.client, null));
    expect(first.messages).toEqual([{ role: 'user', content: 'Есть время на хеликс завтра?' }]);
    const [slots] = toolResults(1);
    expect(slots).toContain('Алина [id 1]: 11:00, 11:30');
    expect(slots).toContain('Катя');
  });

  it('sends the history as earlier turns, merging consecutive messages of one side', () => {
    const c = oneCase({
      history: [
        { role: 'user', text: 'Хочу проколоть мочку' },
        { role: 'assistant', text: 'Одну или обе?' },
        { role: 'user', text: 'Обе' },
      ],
      message: 'Сколько будет?',
    });
    expect(conversationOf(c)).toEqual([
      { role: 'user', content: 'Хочу проколоть мочку' },
      { role: 'assistant', content: 'Одну или обе?' },
      { role: 'user', content: 'Обе\n\nСколько будет?' },
    ]);
  });

  it('writes and sends nothing in test mode, notes what would have happened and detects the handoff', async () => {
    const countOf = (table: typeof appointments | typeof bookingRequests | typeof botChats) =>
      studio.ctx.db.select({ n: count() }).from(table).get()!.n;
    const before = { appointments: countOf(appointments), requests: countOf(bookingRequests), chats: countOf(botChats) };
    ai.push(
      message(
        [
          toolUse('t1', 'book_appointment', { items: [{ serviceId: serviceId('Мини тату до 5 см') }], startsAt: `${TOMORROW} 14:00` }),
          toolUse('t2', 'create_booking_request', { contactName: 'Анна', phone: '+79990001122', serviceName: 'Мини тату', preferredTime: 'вечером' }),
          toolUse('t3', 'handoff_to_staff', { reason: 'Клиент просит человека' }),
        ],
        'tool_use',
      ),
      message([text('Готово! Администратор скоро подключится 🙏')]),
    );
    const result = await runCase(studio, ai, oneCase({ expectHandoff: true, expectTools: ['book_appointment'] }));

    expect(result.passed).toBe(true);
    expect(result.handedOff).toBe(true);
    expect(result.notes).toEqual([
      `создана бы онлайн-запись: Мини тату до 5 см, ${TOMORROW} 14:00`,
      `создана бы заявка: Анна, +79990001122, Мини тату, вечером`,
      'диалог передан бы администратору: Клиент просит человека',
    ]);
    // Online prepayment is possible, as in production with the bank configured.
    expect(toolResults(1)[0]).toContain('Клиенту пришла бы ссылка на предоплату 1 000 ₽');
    expect({ appointments: countOf(appointments), requests: countOf(bookingRequests), chats: countOf(botChats) }).toEqual(before);
  });

  it('summarises a run, prints the table and the failed details, and exits with 1 on a failure', async () => {
    ai.push(message([text('Прокол мочки — **1 600 ₽** 🙂')]), message([text('Хеликс стоит 2 000 ₽')]));
    const cases = parseCases({
      cases: [
        { id: 'price-lobe', topic: 'Цены', message: 'Сколько стоит мочка?', mustInclude: ['1600'] },
        { id: 'price-helix', topic: 'Цены', message: 'Сколько стоит хеликс?', mustInclude: ['1800'], expectHandoff: false },
      ],
    });
    const progress: string[] = [];
    const report = await runEval(studio, ai, cases, (r, done, total) => progress.push(`${done}/${total} ${r.id}`));

    expect(progress).toEqual(['1/2 price-lobe', '2/2 price-helix']);
    expect(report.summary).toMatchObject({ total: 2, passed: 1, failed: 1, notRun: 0, passRate: 50 });
    expect(report.summary.usage).toEqual({ input: 200, output: 40, cacheRead: 100 });
    expect(report.model).toBe('test-model');
    expect(report.aborted).toBeNull();
    expect(exitCodeOf(report)).toBe(1);

    const printed = formatReport(report);
    expect(printed).toMatch(/price-lobe\s+OK\s+—\s+—\s+Прокол мочки — \*\*1 600 ₽\*\* 🙂/);
    expect(printed).toMatch(/price-helix\s+FAIL\s+mustInclude\s+—\s+Хеликс стоит 2 000 ₽/);
    expect(printed).toContain('Итого: прошли 1 из 2 (50%), не прошли 1 · модель test-model');
    expect(printed).toContain('По темам: Цены 1/2');
    expect(printed).toContain('Не прошли:\n\n✗ price-helix [Цены]\n  Клиент: Сколько стоит хеликс?\n  • mustInclude: нет ни одного из: 1800');
    expect(printed).toContain('  Ответ:\n    Хеликс стоит 2 000 ₽');

    const allPassed = await runEval(studio, ai.push(message([text('1 600 ₽')])), [cases[0]!]);
    expect(exitCodeOf(allPassed)).toBe(0);
  });

  it('stops after several AI errors in a row', async () => {
    ai.push(new Error('401 invalid key'), new Error('401 invalid key'), new Error('401 invalid key'));
    const cases = parseCases({
      cases: ['a', 'b', 'c', 'd'].map((id) => ({ id, topic: 'Т', message: 'Привет' })),
    });
    const report = await runEval(studio, ai, cases);

    expect(report.results.map((r) => r.failures[0]?.check)).toEqual(['outcome', 'outcome', 'outcome']);
    expect(report.summary).toMatchObject({ total: 4, failed: 3, notRun: 1, passRate: 0 });
    expect(report.aborted).toContain('3 кейса подряд завершились ошибкой (error: 401 invalid key)');
    expect(formatReport(report)).toContain('не запускались 1');
    expect(exitCodeOf(report)).toBe(1);
  });

  it('fails a case that crashes and goes on with the next one', async () => {
    studio.ctx.sqlite.close();
    const cases = parseCases({ cases: ['a', 'b'].map((id) => ({ id, topic: 'Т', message: 'Привет' })) });
    const report = await runEval(studio, ai, cases);

    expect(report.results.map((r) => [r.id, r.outcome, r.failures[0]!.check])).toEqual([
      ['a', 'error', 'outcome'],
      ['b', 'error', 'outcome'],
    ]);
    expect(report.results[0]!.failures[0]!.detail).toContain('database connection is not open');
    expect(report.summary).toMatchObject({ failed: 2, notRun: 0 });
    expect(ai.calls).toHaveLength(0);
  });

  it('accepts a reply that is only an action the bot confirms itself', async () => {
    ai.push(message([toolUse('t1', 'handoff_to_staff', { reason: 'Осложнение' })], 'tool_use'), message([]));
    const result = await runCase(studio, ai, oneCase({ expectHandoff: true }));
    expect(result).toMatchObject({ passed: true, answer: '', handedOff: true });
  });
});

describe('AI quality check: command line', () => {
  it('parses the arguments', () => {
    expect(parseEvalArgs([])).toEqual({ caseIds: [], model: null, json: false, help: false });
    expect(parseEvalArgs(['--case', 'a,b', '--case=c', '--model', 'google/gemini-3.1-pro', '--json'])).toEqual({
      caseIds: ['a', 'b', 'c'],
      model: 'google/gemini-3.1-pro',
      json: true,
      help: false,
    });
    expect(() => parseEvalArgs(['--model'])).toThrow('После --model нужно значение');
    expect(() => parseEvalArgs(['--model='])).toThrow('После --model нужно значение');
    expect(() => parseEvalArgs(['--case', ' '])).toThrow('После --case нужно значение');
    expect(() => parseEvalArgs(['--case', '--json'])).toThrow(UsageError);
    expect(() => parseEvalArgs(['--verbose'])).toThrow('Неизвестный аргумент: --verbose');
  });

  it('selects cases by id in file order', () => {
    const cases = parseCases({ cases: ['a', 'b', 'c'].map((id) => ({ id, topic: 'Т', message: 'Привет' })) });
    expect(selectCases(cases, []).map((c) => c.id)).toEqual(['a', 'b', 'c']);
    expect(selectCases(cases, ['c', 'a']).map((c) => c.id)).toEqual(['a', 'c']);
    expect(() => selectCases(cases, ['a', 'x'])).toThrow('Нет таких кейсов: x');
  });

  it('needs the AI key and says so', async () => {
    expect(aiSettingsProblem(loadAiConfig({}))).toContain('задайте AI_API_KEY');
    expect(aiSettingsProblem(loadAiConfig({ AI_API_KEY: 'key', AI_BASE_URL: 'https://polza.example/api' }))).toBeNull();

    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await main([], {})).toBe(2);
      expect(String(stderr.mock.calls[0]![0])).toContain('Нет доступа к ИИ: задайте AI_API_KEY');
      expect(await main(['--case', 'no-such-case'], { AI_API_KEY: 'key' })).toBe(2);
      expect(String(stderr.mock.calls[1]![0])).toContain('Нет таких кейсов: no-such-case');
    } finally {
      stderr.mockRestore();
    }
  });
});
