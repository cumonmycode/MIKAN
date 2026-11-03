import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CAMPAIGN_RATE_PER_SECOND, runCampaigns } from '../src/bot/campaign-sender.js';
import { BotSendError, BotUnavailableError, type PhotoSource, type SendOptions, type SentMessage } from '../src/bot/gateway.js';
import { handleStaffCommand } from '../src/bot/onboarding.js';
import { sendDueRetention } from '../src/bot/retention.js';
import { issueStaffCode } from '../src/bot/staff.js';
import { campaignRecipients, clients } from '../src/db/schema.js';
import { cancelCampaign } from '../src/domain/campaigns.js';
import { blocked, createTestApp, FakeGateway, make, type TestApp } from './helpers.js';
import { addClient, addVisit, FakeClock, monthsBefore } from './retention-fixtures.js';

const NOW = Date.parse('2026-10-19T09:00:00.000Z'); // Mon 12:00 Moscow
const STAFF_GROUP = -5001;

/** Records the clock at every send to a client (positive chat id); photos can fail like texts. */
class TimedGateway extends FakeGateway {
  times: number[] = [];
  photoFailures: Error[] = [];
  constructor(private readonly clock: FakeClock) {
    super();
  }
  override async sendText(chatId: number, text: string, options: SendOptions = {}): Promise<SentMessage> {
    if (chatId > 0) this.times.push(this.clock.now());
    return super.sendText(chatId, text, options);
  }
  override async sendPhoto(chatId: number, photo: PhotoSource, caption: string, options: SendOptions = {}): Promise<SentMessage> {
    this.times.push(this.clock.now());
    const failure = this.photoFailures.shift();
    if (failure) throw failure;
    return super.sendPhoto(chatId, photo, caption, options);
  }
}

describe('campaign delivery', () => {
  let t: TestApp;
  let clock: FakeClock;
  let gateway: TimedGateway;

  const create = async (body: Record<string, unknown> = {}) => {
    const res = await t.api('POST', '/api/campaigns', { title: 'Осень', text: '{name}, скидка 15%!', segment: {}, ...body });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as { id: number };
  };
  const send = async (id: number, at?: string) => {
    const res = await t.api('POST', `/api/campaigns/${id}/send`, at ? { at } : {});
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  };
  const campaign = async (id: number) => (await t.api('GET', '/api/campaigns')).json().items.find((c: { id: number }) => c.id === id);
  const recipients = (id: number) =>
    t.ctx.db.select().from(campaignRecipients).where(eq(campaignRecipients.campaignId, id)).orderBy(campaignRecipients.id).all();
  const run = (options: { maxMessages?: number } = {}) => runCampaigns(t.ctx, { clock, ...options });

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    clock = new FakeClock(NOW);
    gateway = new TimedGateway(clock);
    t = await createTestApp({ gateway });
    handleStaffCommand(t.ctx, STAFF_GROUP, issueStaffCode(t.ctx.db).code);
  });
  afterEach(async () => {
    await t.close();
    vi.useRealTimers();
  });

  it('sends each recipient the text with {name}, the buttons and stores it in the chat; staff get a summary', async () => {
    const anna = await addClient(t, 'Анна', { lastName: 'Иванова', chatId: 7001 });
    await addClient(t, 'Борис', { chatId: 7002 });
    const c = await create({ button: { kind: 'url', text: 'Подробнее', url: 'https://mikan.example/sale' } });
    await send(c.id);
    gateway.sent = [];

    expect(await run()).toMatchObject({ sent: 2, failed: 0, blocked: 0, finished: 1 });
    const keyboard = [[{ text: 'Подробнее', url: 'https://mikan.example/sale' }], [{ text: '🔕 Не присылать новости', data: 'mo' }]];
    expect(gateway.sent.slice(0, 2)).toEqual([
      { chatId: 7001, text: 'Анна, скидка 15%!', keyboard, messageId: expect.any(Number) },
      { chatId: 7002, text: 'Борис, скидка 15%!', keyboard, messageId: expect.any(Number) },
    ]);
    expect(gateway.textsTo(STAFF_GROUP)).toEqual(['📣 Рассылка «Осень» завершена\n✅ Доставлено: 2 из 2']);

    const done = await campaign(c.id);
    expect(done).toMatchObject({ status: 'sent', finishedAt: '2026-10-19T09:00:00.050Z', stats: { recipients: 2, sent: 2, failed: 0, blocked: 0, pending: 0 } });
    const chat = (await t.api('GET', `/api/clients/${anna.id}/chat`)).json().chat;
    expect(chat.lastMessage).toMatchObject({ role: 'system', text: 'Анна, скидка 15%!' });

    // Another tick sends nothing again.
    gateway.sent = [];
    expect(await run()).toMatchObject({ sent: 0, finished: 0 });
    expect(gateway.sent).toEqual([]);
  });

  it('«📅 Записаться» opens the Mini App while online booking is on, else asks the AI (callback)', async () => {
    await addClient(t, 'Анна', { chatId: 7001 });
    const c = await create({ button: { kind: 'book' } });
    await send(c.id);
    await run();
    expect(gateway.sent[0]!.keyboard![0]).toEqual([{ text: '📅 Записаться', data: 'mb' }]);

    t.ctx.config.publicUrl = 'https://mikan.example';
    await t.api('PUT', '/api/settings/studio', { onlineBooking: { enabled: true } });
    const second = await create({ button: { kind: 'book', text: 'Записаться со скидкой' } });
    await send(second.id);
    gateway.sent = [];
    await run();
    expect(gateway.sent[0]!.keyboard![0]).toEqual([{ text: 'Записаться со скидкой', webApp: 'https://mikan.example/book' }]);

    await t.api('PUT', '/api/settings/studio', { onlineBooking: { enabled: false } });
    const third = await create({ button: { kind: 'book' } });
    await send(third.id);
    gateway.sent = [];
    await run();
    expect(gateway.sent[0]!.keyboard![0]).toEqual([{ text: '📅 Записаться', data: 'mb' }]);
  });

  it('a picture goes as a photo with the text as caption, cut to 1 024 characters after {name}', async () => {
    await addClient(t, 'Анастасия', { chatId: 7001 });
    const text = `{name}${'x'.repeat(1018)}`;
    const c = await create({ text, imageUrl: 'https://cdn.example.com/autumn.jpg' });
    await send(c.id);
    await run();
    expect(gateway.photos).toHaveLength(1);
    const photo = gateway.photos[0]!;
    expect(photo.photo).toEqual({ kind: 'url', url: 'https://cdn.example.com/autumn.jpg' });
    expect(photo.caption).toHaveLength(1024);
    expect(photo.caption.startsWith('Анастасияxxx')).toBe(true);
    expect(photo.caption.endsWith('…')).toBe(true);
    expect(photo.keyboard).toEqual([[{ text: '🔕 Не присылать новости', data: 'mo' }]]);
    const messages = (await t.api('GET', '/api/bot/chats/7001/messages')).json().items;
    expect(messages.at(-1).text).toBe(`[Фото] ${photo.caption}`);

    // A long name pushes the caption past the limit: it is cut at a word boundary with «…».
    const template = `{name}, ${'скидка '.repeat(200).slice(0, 1016)}`;
    expect(template).toHaveLength(1024);
    const words = await create({ text: template, imageUrl: 'https://cdn.example.com/b.jpg' });
    await send(words.id);
    await run();
    const cut = gateway.photos[1]!.caption;
    expect(cut.length).toBeLessThanOrEqual(1024);
    expect(cut).toMatch(/^Анастасия, скидка .* скидка…$/);

    // An upload that is missing on disk falls back to text.
    const second = await create({ text: 'Без фото', imageUrl: '/uploads/missing.jpg' });
    await send(second.id);
    await run();
    expect(gateway.textsTo(7001)).toEqual(['Без фото']);
  });

  it('never more than 20 messages in any second', async () => {
    for (let i = 0; i < 45; i++) await addClient(t, `Клиент${i}`, { chatId: 8000 + i });
    const c = await create();
    await send(c.id);
    const start = clock.now();
    expect((await run()).sent).toBe(45);
    const times = gateway.times;
    expect(times).toHaveLength(45);
    for (let i = CAMPAIGN_RATE_PER_SECOND; i < times.length; i++) {
      expect(times[i]! - times[i - CAMPAIGN_RATE_PER_SECOND]!).toBeGreaterThanOrEqual(1000);
    }
    expect(clock.now() - start).toBeGreaterThanOrEqual(2200);
  });

  it('retries a failed message after 30 s, 1 min, 1.5 min (4 tries); a blocked client is «blocked»', async () => {
    const anna = await addClient(t, 'Анна', { chatId: 7001 });
    await addClient(t, 'Борис', { chatId: 7002 });
    await addClient(t, 'Вера', { chatId: 7003 });
    const c = await create();
    await send(c.id);

    gateway.failures.push(new Error('Telegram недоступен'), blocked(), new Error('Telegram недоступен'));
    expect(await run()).toMatchObject({ sent: 0, blocked: 1, retried: 2, finished: 0 });
    expect(recipients(c.id).map((r) => [r.status, r.attempts])).toEqual([
      ['pending', 1],
      ['blocked', 1],
      ['pending', 1],
    ]);
    // Not before the delay.
    clock.advance(29_000);
    expect(await run()).toMatchObject({ sent: 0, retried: 0, finished: 0 });
    expect(gateway.textsTo(7001)).toEqual([]);

    // Анна fails three more times (4 tries in all) → failed; Вера goes through on her third try.
    clock.advance(1_200);
    gateway.failures.push(new Error('e2'), new Error('e2'));
    expect(await run()).toMatchObject({ sent: 0, retried: 2 });
    clock.advance(59_000);
    expect(await run()).toMatchObject({ sent: 0, retried: 0 });
    clock.advance(1_200);
    gateway.failures.push(new Error('e3'));
    expect(await run()).toMatchObject({ sent: 1, retried: 1 });
    clock.advance(90_200);
    gateway.failures.push(new Error('e4'));
    expect(await run()).toMatchObject({ sent: 0, failed: 1, finished: 1 });

    const rows = recipients(c.id);
    expect(rows.map((r) => [r.clientId === anna.id, r.status, r.attempts])).toEqual([
      [true, 'failed', 4],
      [false, 'blocked', 1],
      [false, 'sent', 3],
    ]);
    expect(rows[0]!.error).toBe('e4');
    expect(rows[1]!.error).toBe('Клиент заблокировал бота или чат недоступен');
    expect((await campaign(c.id)).stats).toEqual({ recipients: 3, sent: 1, failed: 1, blocked: 1, pending: 0 });
    expect(gateway.textsTo(STAFF_GROUP)).toEqual([
      '📣 Рассылка «Осень» завершена\n✅ Доставлено: 1 из 3\n🚫 Заблокировали бота: 1\n⚠️ Не доставлено: 1',
    ]);
  });

  it('a failing photo is retried like text', async () => {
    await addClient(t, 'Анна', { chatId: 7001 });
    const c = await create({ imageUrl: 'https://cdn.example.com/a.jpg' });
    await send(c.id);
    gateway.photoFailures.push(new Error('Telegram: wrong file'));
    expect(await run()).toMatchObject({ retried: 1, sent: 0 });
    clock.advance(30_000);
    expect(await run()).toMatchObject({ sent: 1, finished: 1 });
  });

  it('Telegram’s flood limit (429) pauses sending for the time it asks, without counting a try', async () => {
    await addClient(t, 'Анна', { chatId: 7001 });
    await addClient(t, 'Борис', { chatId: 7002 });
    const c = await create();
    await send(c.id);
    gateway.failures.push(new BotSendError('Telegram: Too Many Requests: retry after 3', false, 3_000));
    expect(await run()).toMatchObject({ sent: 0, retried: 0, failed: 0 });
    expect(recipients(c.id).map((r) => [r.status, r.attempts])).toEqual([
      ['pending', 0],
      ['pending', 0],
    ]);
    clock.advance(2_000);
    expect(await run()).toMatchObject({ sent: 0 });
    clock.advance(1_000);
    expect(await run()).toMatchObject({ sent: 2, finished: 1 });
  });

  it('campaigns, birthday and win-back messages share one rate: ≤ 20 a second together', async () => {
    const helix = await make(t, '/api/services', { name: 'Хеликс', category: 'piercing', price: 3000, durationMin: 30 });
    for (let i = 0; i < 25; i++) {
      const client = await addClient(t, `Клиент${i}`, { chatId: 8000 + i });
      addVisit(t, client.id, { at: monthsBefore(NOW, 12), serviceIds: [helix.id] });
    }
    await t.api('PUT', '/api/settings/retention', { winback: { sendAt: '12:00', dailyLimit: 25 } });
    const c = await create();
    await send(c.id);
    const [campaignRun, retentionRun] = await Promise.all([run(), sendDueRetention(t.ctx, { now: NOW, clock })]);
    expect(campaignRun.sent).toBe(25);
    expect(retentionRun.winback).toBe(25);
    const times = [...gateway.times].sort((a, b) => a - b);
    expect(times).toHaveLength(50);
    for (let i = CAMPAIGN_RATE_PER_SECOND; i < times.length; i++) {
      expect(times[i]! - times[i - CAMPAIGN_RATE_PER_SECOND]!).toBeGreaterThanOrEqual(1000);
    }
  });

  it('stops while the bot is offline and resumes where it stopped (a restart repeats nothing)', async () => {
    for (let i = 0; i < 5; i++) await addClient(t, `Клиент${i}`, { chatId: 8000 + i });
    const c = await create();
    await send(c.id);
    expect(await run({ maxMessages: 2 })).toMatchObject({ sent: 2, finished: 0 });
    // A send that dies with the bot (stopped meanwhile) is not counted against the client.
    gateway.failures.push(new BotUnavailableError());
    expect(await run()).toMatchObject({ sent: 0, retried: 0 });
    expect(recipients(c.id).map((r) => r.attempts)).toEqual([1, 1, 0, 0, 0]);
    expect((await campaign(c.id)).stats).toMatchObject({ sent: 2, pending: 3 });

    gateway.running = false;
    expect(await run()).toMatchObject({ sent: 0 });
    gateway.running = true;
    expect(await run()).toMatchObject({ sent: 3, finished: 1 });
    expect(gateway.sent.filter((m) => m.chatId > 0).map((m) => m.chatId)).toEqual([8000, 8001, 8002, 8003, 8004]);
  });

  it('cancel stops a sending campaign: the rest are skipped, the sent stay', async () => {
    for (let i = 0; i < 4; i++) await addClient(t, `Клиент${i}`, { chatId: 8000 + i });
    const c = await create();
    await send(c.id);
    await run({ maxMessages: 1 });
    const cancelled = await t.api('POST', `/api/campaigns/${c.id}/cancel`);
    expect(cancelled.json()).toMatchObject({ status: 'cancelled', stats: { recipients: 4, sent: 1, pending: 0 } });
    expect(await run()).toMatchObject({ sent: 0, finished: 0 });
    expect(recipients(c.id).map((r) => r.status)).toEqual(['sent', 'skipped', 'skipped', 'skipped']);
    expect(gateway.textsTo(STAFF_GROUP)).toEqual([]);
  });

  it('a cancel that comes while the sender waits for its rate stops it before the next message', async () => {
    for (let i = 0; i < 3; i++) await addClient(t, `Клиент${i}`, { chatId: 8000 + i });
    const c = await create();
    await send(c.id);
    const sleep = clock.sleep.bind(clock);
    clock.sleep = async (ms: number) => {
      cancelCampaign(t.ctx.db, c.id);
      await sleep(ms);
    };
    expect(await run()).toMatchObject({ sent: 1, finished: 0 });
    expect(recipients(c.id).map((r) => r.status)).toEqual(['sent', 'skipped', 'skipped']);
  });

  it('a client who opts out or unlinks after the start is skipped', async () => {
    const anna = await addClient(t, 'Анна', { chatId: 7001 });
    const boris = await addClient(t, 'Борис', { chatId: 7002 });
    await addClient(t, 'Вера', { chatId: 7003 });
    const c = await create();
    await send(c.id);
    await t.api('PATCH', `/api/clients/${anna.id}`, { marketingOptOut: true });
    t.ctx.db.update(clients).set({ telegramChatId: null }).where(eq(clients.id, boris.id)).run();
    expect(await run()).toMatchObject({ sent: 1, skipped: 2, finished: 1 });
    expect(recipients(c.id).map((r) => [r.status, r.error])).toEqual([
      ['skipped', 'Клиент отказался от новостей'],
      ['skipped', 'Клиент отвязал Telegram'],
      ['sent', null],
    ]);
    expect(gateway.textsTo(STAFF_GROUP)[0]).toBe(
      '📣 Рассылка «Осень» завершена\n✅ Доставлено: 1 из 3\n➖ Пропущено (отписались или отвязали Telegram): 2',
    );
  });

  it('a scheduled campaign starts when its time comes, with the recipients of that moment', async () => {
    await addClient(t, 'Анна', { chatId: 7001 });
    const c = await create();
    const scheduled = await send(c.id, '2026-10-19T12:00:00.000Z');
    expect(scheduled.status).toBe('scheduled');
    expect(await run()).toMatchObject({ started: 0, sent: 0 });
    await addClient(t, 'Борис', { chatId: 7002 });

    clock.t = Date.parse('2026-10-19T12:00:00.000Z');
    expect(await run()).toMatchObject({ started: 1, sent: 2, finished: 1 });
    expect(await campaign(c.id)).toMatchObject({ status: 'sent', startedAt: '2026-10-19T12:00:00.000Z', stats: { recipients: 2, sent: 2 } });

    // A scheduled one with nobody left to send to ends at once; staff are told.
    const empty = await create({ segment: { birthdayMonth: 2 } });
    await send(empty.id, '2026-10-19T13:00:00.000Z');
    clock.t = Date.parse('2026-10-19T13:00:00.000Z');
    expect(await run()).toMatchObject({ started: 1, finished: 1, sent: 0 });
    expect((await campaign(empty.id)).status).toBe('sent');
    expect(gateway.textsTo(STAFF_GROUP).at(-1)).toBe('📣 Рассылка «Осень»: под её условия не подошёл ни один клиент — ничего не отправлено');
  });
});
