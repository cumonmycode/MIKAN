import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { employees, smmAccounts, smmPosts } from '../src/db/schema.js';
import { setChatEmployee, upsertChat } from '../src/domain/bot-chats.js';
import { readKey } from '../src/domain/settings.js';
import { claimPlan, ensurePlan, insertPost, listComments, loadPlan, loadPost, updatePlan, updatePost } from '../src/smm/db.js';
import { chatJson } from '../src/smm/ai.js';
import { generateReport } from '../src/smm/report.js';
import { studyInBackground } from '../src/smm/study.js';
import { SmmError, type SmmProfile } from '../src/smm/types.js';
import { smmTick } from '../src/smm/workflow.js';
import { writePost } from '../src/smm/writer.js';
import { createTestApp, type TestApp } from './helpers.js';

/**
 * The cron steps that need the AI key (smm/workflow.ts): preparing ideas, the weekly report, the weekly study and
 * the next month plan. The AI work itself is stubbed — only how the cron schedules, retries and reports it.
 */

vi.mock('../src/smm/writer.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/smm/writer.js')>()),
  writePost: vi.fn(),
}));
vi.mock('../src/smm/report.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/smm/report.js')>()),
  generateReport: vi.fn(),
}));
// The planner stays real (planner → analytics → workflow is an import cycle a planner mock would not reach through):
// its model calls are scripted instead.
vi.mock('../src/smm/ai.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/smm/ai.js')>()),
  chatJson: vi.fn(),
}));
vi.mock('../src/smm/study.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/smm/study.js')>()),
  studyInBackground: vi.fn(),
}));

const MINUTE = 60_000;
const APPROVER_CHAT = 7101;
/** Tuesday, 3 November 2026, 09:00 in Moscow (the studio timezone): no weekly or monthly job is due. */
const TUESDAY = Date.parse('2026-11-03T06:00:00.000Z');
/** Monday, 2 November 2026, 11:30 in Moscow: the weekly report is due. */
const MONDAY = Date.parse('2026-11-02T08:30:00.000Z');
/** Wednesday, 4 November 2026, 04:30 in Moscow: the weekly study is due. */
const WEDNESDAY = Date.parse('2026-11-04T01:30:00.000Z');
/** Friday, 25 December 2026, 12:30 in Moscow: the plan for January 2027 is due. */
const DEC_25 = Date.parse('2026-12-25T09:30:00.000Z');

let t: TestApp;

const offline: typeof fetch = async () => {
  throw new Error('offline in tests');
};

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(TUESDAY);
  t = await createTestApp({ env: { AI_API_KEY: 'test-ai-key' } });
  t.ctx.smmFetch = offline;
  // The studio is in use (has a platform), and the admin approves it from their bot chat.
  const now = Date.now();
  t.ctx.db
    .insert(smmAccounts)
    .values({ id: randomUUID(), profile: 'studio', platform: 'telegram', title: 'MIKAN', handle: 'mikan_test', tgChatId: '@mikan_test', canPublish: true, createdAt: now, updatedAt: now })
    .run();
  const admin = t.ctx.db.select({ id: employees.id }).from(employees).get()!;
  upsertChat(t.ctx.db, APPROVER_CHAT, { telegramName: 'Админ' });
  setChatEmployee(t.ctx.db, APPROVER_CHAT, admin.id);
  vi.mocked(writePost).mockReset();
  vi.mocked(generateReport).mockReset();
  vi.mocked(chatJson).mockReset();
  vi.mocked(studyInBackground).mockReset();
});

afterEach(async () => {
  await t.close();
  vi.useRealTimers();
});

const at = (ms: number) => vi.setSystemTime(ms);
const toApprover = () => t.gateway.htmlSent.filter((m) => m.chat === APPROVER_CHAT).map((m) => m.text);
const marks = (profile: SmmProfile = 'studio') => readKey<Record<string, unknown>>(t.ctx.db, `smm_cron:${profile}`) ?? {};

async function idea(topic: string, hoursAhead: number): Promise<string> {
  return insertPost(t.ctx, {
    profile: 'studio',
    platform: 'telegram',
    format: 'post',
    publishAt: new Date(Date.now() + hoursAhead * 3_600_000).toISOString(),
    topic,
  });
}

/** writePost as the real one ends: success — on review; failure — free with the error, then the throw. */
function scriptWriter(outcome: (topic: string) => 'ok' | SmmError): void {
  vi.mocked(writePost).mockImplementation(async (ctx, postId) => {
    const post = (await loadPost(ctx, postId))!;
    const result = outcome(post.topic);
    if (result === 'ok') {
      await updatePost(ctx, postId, { busy: null, status: 'review', error: null });
      return (await loadPost(ctx, postId))!;
    }
    await updatePost(ctx, postId, { busy: null, error: result.message });
    throw result;
  });
}

const written = () => vi.mocked(writePost).mock.calls.map((c) => c[1]);

describe('preparing ideas', () => {
  it('a broken idea does not block the next ones and is left alone for 45 minutes', async () => {
    const broken = await idea('Сломанная идея', 2);
    const next = await idea('Следующая', 3);
    const later = await idea('Ещё одна', 4);
    scriptWriter((topic) => (topic === 'Сломанная идея' ? new SmmError('Маркетолог ответил не по форме', 502) : 'ok'));

    await smmTick(t.ctx);
    expect(written()).toEqual([broken, next]);
    expect((await loadPost(t.ctx, broken))!).toMatchObject({ status: 'idea', error: 'Маркетолог ответил не по форме' });
    expect((await loadPost(t.ctx, next))!.status).toBe('review');

    vi.mocked(writePost).mockClear();
    at(TUESDAY + MINUTE);
    await smmTick(t.ctx);
    expect(written()).toEqual([later]);

    vi.mocked(writePost).mockClear();
    at(TUESDAY + 46 * MINUTE);
    await smmTick(t.ctx);
    expect(written()).toEqual([broken]);
  });

  it('tries at most three ideas a tick, and none after the money ran out (402)', async () => {
    for (let i = 0; i < 5; i += 1) await idea(`Идея ${i}`, 2 + i);
    scriptWriter(() => new SmmError('Ошибка модели', 502));

    await smmTick(t.ctx);
    expect(written()).toHaveLength(3);

    vi.mocked(writePost).mockClear();
    scriptWriter(() => new SmmError('Бюджет на нейросети в этом месяце закончился', 402));
    at(TUESDAY + MINUTE);
    await smmTick(t.ctx);
    expect(written()).toHaveLength(1);
  });
});

describe('weekly report', () => {
  beforeEach(async () => {
    at(MONDAY);
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const id = await insertPost(t.ctx, { profile: 'studio', platform: 'telegram', format: 'post', publishAt: twoDaysAgo, topic: 'Вышедший пост' });
    t.ctx.db
      .update(smmPosts)
      .set({ status: 'published', publishedAt: Date.now() - 2 * 86_400_000, tgMessageId: 41, publishedUrl: 'https://t.me/mikan_test/41' })
      .where(eq(smmPosts.id, id))
      .run();
  });

  it('a failure is reported once and retried a few times that day; the mark comes only with success', async () => {
    vi.mocked(generateReport).mockRejectedValue(new SmmError('Бюджет на нейросети в этом месяце закончился (3000 из 3000 ₽)', 402));

    await smmTick(t.ctx);
    expect(vi.mocked(generateReport)).toHaveBeenCalledTimes(1);
    expect(marks().report).toBeUndefined();
    const told = toApprover().filter((m) => m.startsWith('❗ Не получился отчёт за неделю'));
    expect(told).toEqual(['❗ Не получился отчёт за неделю: Бюджет на нейросети в этом месяце закончился (3000 из 3000 ₽)\nПопробую ещё раз позже.']);

    at(MONDAY + 10 * MINUTE);
    await smmTick(t.ctx);
    expect(vi.mocked(generateReport)).toHaveBeenCalledTimes(1);

    at(MONDAY + 31 * MINUTE);
    await smmTick(t.ctx);
    at(MONDAY + 62 * MINUTE);
    await smmTick(t.ctx);
    expect(vi.mocked(generateReport)).toHaveBeenCalledTimes(3);
    at(MONDAY + 93 * MINUTE);
    await smmTick(t.ctx);
    expect(vi.mocked(generateReport)).toHaveBeenCalledTimes(3);
    expect(toApprover().filter((m) => m.startsWith('❗'))).toHaveLength(1);
  });

  it('after a failure the next try succeeds: the report goes out and the day is marked', async () => {
    vi.mocked(generateReport).mockRejectedValueOnce(new SmmError('Polza недоступна', 502));
    await smmTick(t.ctx);

    vi.mocked(generateReport).mockResolvedValue({
      id: 'r1',
      periodFrom: '2026-10-26',
      periodTo: '2026-11-01',
      title: 'Неделя 26 окт — 1 ноя',
      summary: 'Охват вырос',
      metrics: [],
      recommendations: [],
      createdAt: new Date().toISOString(),
    });
    at(MONDAY + 31 * MINUTE);
    await smmTick(t.ctx);
    expect(toApprover().at(-1)).toBe('📊 <b>Неделя 26 окт — 1 ноя</b>\nОхват вырос');
    expect(marks()).toMatchObject({ report: '2026-11-02', failed: {} });

    at(MONDAY + 62 * MINUTE);
    await smmTick(t.ctx);
    expect(vi.mocked(generateReport)).toHaveBeenCalledTimes(2);
  });
});

describe('weekly study', () => {
  beforeEach(() => at(WEDNESDAY));

  it('runs in the background once at a time; the mark comes when it finishes, a failure is reported and retried', async () => {
    let done: ((error: unknown) => void | Promise<void>) | undefined;
    vi.mocked(studyInBackground).mockImplementation(async (_ctx, _profile, _what, finish) => {
      done = finish;
      return true;
    });

    await smmTick(t.ctx);
    at(WEDNESDAY + MINUTE);
    await smmTick(t.ctx);
    expect(vi.mocked(studyInBackground)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(studyInBackground).mock.calls[0]?.slice(1, 3)).toEqual(['studio', 'socials']);

    await done!(new SmmError('На балансе Polza не хватает денег — пополните баланс на polza.ai', 402));
    expect(marks().study).toBeUndefined();
    expect(toApprover().filter((m) => m.startsWith('❗ Не получилось заново изучить соцсети'))).toHaveLength(1);

    at(WEDNESDAY + 32 * MINUTE);
    await smmTick(t.ctx);
    expect(vi.mocked(studyInBackground)).toHaveBeenCalledTimes(2);
    await done!(null);
    expect(marks().study).toBe('2026-11-04');

    at(WEDNESDAY + 40 * MINUTE);
    await smmTick(t.ctx);
    expect(vi.mocked(studyInBackground)).toHaveBeenCalledTimes(2);
    expect(toApprover().filter((m) => m.startsWith('❗'))).toHaveLength(1);
  });

  it('a study already running from the app counts for the day', async () => {
    vi.mocked(studyInBackground).mockResolvedValue(false);

    await smmTick(t.ctx);

    expect(marks().study).toBe('2026-11-04');
  });
});

describe('next month plan', () => {
  /** A January plan as the model answers it; holidays left uncovered get one catch-up post. */
  function scriptPlanner(fail?: SmmError): void {
    vi.mocked(chatJson).mockImplementation(async (_ctx, _profile, opts) => {
      const note = opts.note ?? '';
      if (note.startsWith('план ')) {
        if (fail) throw fail;
        return opts.schema.parse({
          summary: 'Стратегия января: зимние тату, подарочные сертификаты и уход за проколами в мороз.',
          goals: ['10 заявок из Telegram'],
          pillars: [
            { key: 'use', title: 'Польза', share: 50, about: 'Уход' },
            { key: 'art', title: 'Работы', share: 50, about: 'Эскизы' },
          ],
          posts: [{ date: '2027-01-12', time: '12:00', platform: 'telegram', format: 'post', topic: 'Уход за проколом зимой', brief: 'Мороз и свежий прокол' }],
        });
      }
      if (note.startsWith('праздники в план')) {
        return opts.schema.parse({
          posts: [{ date: '2027-01-07', time: '11:00', platform: 'telegram', format: 'post', topic: 'Праздник: Рождество', brief: 'Тематический пост', occasion: 'Рождество' }],
        });
      }
      throw new Error(`no scripted answer for «${note}»`);
    });
  }

  const planCalls = () => vi.mocked(chatJson).mock.calls.filter((c) => (c[2].note ?? '').startsWith('план '));

  beforeEach(() => at(DEC_25));

  it('waits while the plan is being made from the app instead of making a second one next to it', async () => {
    scriptPlanner();
    const draft = await ensurePlan(t.ctx, 'studio', '2027-01');
    expect(await claimPlan(t.ctx, draft.id, 'plan')).toBe(true);

    await smmTick(t.ctx);
    expect(planCalls()).toHaveLength(0);
    expect(marks().plan).toBeUndefined();

    await updatePlan(t.ctx, draft.id, { busy: null });
    at(DEC_25 + MINUTE);
    await smmTick(t.ctx);
    expect(planCalls()).toHaveLength(1);
    expect(marks().plan).toBe('2027-01');
    expect(await loadPlan(t.ctx, 'studio', '2027-01')).toMatchObject({ busy: null, summary: expect.stringContaining('Стратегия января') });
    expect(toApprover().at(-1)).toBe('🗓 План на 2027-01 готов — посмотрите стратегию и темы и утвердите план в приложении');
    expect((await listComments(t.ctx, { planId: draft.id })).at(-1)?.text).toBe('Составил план заранее — поправь, если что-то не так.');

    at(DEC_25 + 2 * MINUTE);
    await smmTick(t.ctx);
    expect(planCalls()).toHaveLength(1);
  });

  it('a plan made from the app meanwhile is not made again', async () => {
    scriptPlanner();
    const draft = await ensurePlan(t.ctx, 'studio', '2027-01');
    await updatePlan(t.ctx, draft.id, { summary: 'Составлен вручную'.padEnd(60, '.') });

    await smmTick(t.ctx);

    expect(planCalls()).toHaveLength(0);
    expect(marks().plan).toBe('2027-01');
  });

  it('a failure frees the plan, is reported once and retried later', async () => {
    scriptPlanner(new SmmError('Polza недоступна', 502));

    await smmTick(t.ctx);
    expect(await loadPlan(t.ctx, 'studio', '2027-01')).toMatchObject({ busy: null, error: 'Polza недоступна' });
    expect(marks().plan).toBeUndefined();
    expect(toApprover().filter((m) => m.startsWith('❗ Не получился план на следующий месяц'))).toEqual([
      '❗ Не получился план на следующий месяц: Polza недоступна\nПопробую ещё раз позже.',
    ]);

    at(DEC_25 + 10 * MINUTE);
    await smmTick(t.ctx);
    expect(planCalls()).toHaveLength(1);

    scriptPlanner();
    at(DEC_25 + 31 * MINUTE);
    await smmTick(t.ctx);
    expect(planCalls()).toHaveLength(2);
    expect(marks().plan).toBe('2027-01');
    expect(toApprover().filter((m) => m.startsWith('❗'))).toHaveLength(1);
  });
});
