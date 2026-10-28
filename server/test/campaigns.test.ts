import type { InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleStaffCommand } from '../src/bot/onboarding.js';
import { issueStaffCode } from '../src/bot/staff.js';
import { setChatEmployee, upsertChat } from '../src/domain/bot-chats.js';
import { createTestApp, make, type TestApp } from './helpers.js';
import { addClient } from './retention-fixtures.js';

const NOW = Date.parse('2026-10-19T09:00:00.000Z'); // Mon 12:00 Moscow
const STAFF_GROUP = -5001;
const MANAGERS = 'Это доступно владельцу и администратору';

const draftBody = {
  title: 'Осенняя акция',
  text: '{name}, скидка 15% на проколы до конца октября!',
  segment: { categories: ['piercing'] },
};

describe('campaigns API', () => {
  let t: TestApp;

  const create = async (body: Record<string, unknown> = draftBody) => {
    const res = await t.api('POST', '/api/campaigns', body);
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  };
  const audit = async () =>
    (await t.api('GET', '/api/audit?entity=campaign')).json().items.map((e: { action: string; summary: string }) => [e.action, e.summary]);

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    t = await createTestApp();
  });
  afterEach(async () => {
    await t.close();
    vi.useRealTimers();
  });

  it('creates a draft and lists campaigns newest first, every field present', async () => {
    const first = await create();
    expect(first).toEqual({
      id: expect.any(Number),
      title: 'Осенняя акция',
      text: '{name}, скидка 15% на проколы до конца октября!',
      imageUrl: null,
      button: null,
      segment: {
        lastVisitMonthsAgoMin: null,
        lastVisitMonthsAgoMax: null,
        neverVisited: null,
        categories: ['piercing'],
        masterIds: null,
        minVisits: null,
        birthdayMonth: null,
        hasBonuses: null,
        createdWithinDays: null,
      },
      status: 'draft',
      scheduledAt: null,
      startedAt: null,
      finishedAt: null,
      stats: { recipients: 0, sent: 0, failed: 0, blocked: 0, pending: 0 },
      createdBy: { id: 1, name: 'Админ', color: expect.any(String) },
      createdAt: '2026-10-19T09:00:00.000Z',
      updatedAt: '2026-10-19T09:00:00.000Z',
    });
    const second = await create({
      ...draftBody,
      title: 'Новая коллекция',
      imageUrl: 'https://cdn.example.com/rings.jpg',
      button: { kind: 'url', text: 'Смотреть', url: 'https://mikan.example/new' },
    });
    expect(second.button).toEqual({ text: 'Смотреть', kind: 'url', url: 'https://mikan.example/new' });
    const booked = await create({ ...draftBody, title: 'Запись', button: { kind: 'book' } });
    expect(booked.button).toEqual({ text: '📅 Записаться', kind: 'book', url: null });

    const list = (await t.api('GET', '/api/campaigns')).json().items;
    expect(list.map((c: { title: string }) => c.title)).toEqual(['Запись', 'Новая коллекция', 'Осенняя акция']);

    const one = await t.api('GET', `/api/campaigns/${first.id}`);
    expect(one.statusCode).toBe(200);
    expect(one.json()).toEqual(first);
    const missing = await t.api('GET', '/api/campaigns/999');
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.message).toBe('Рассылка не найдена');
  });

  it('validates the text, the picture caption limit, buttons and links', async () => {
    const bad = async (body: Record<string, unknown>) => {
      const res = await t.api('POST', '/api/campaigns', { ...draftBody, ...body });
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      return res.json().error.message as string;
    };
    expect(await bad({ text: 'x'.repeat(3501) })).toBe('«Текст»: максимум 3500 символов');
    expect(await bad({ text: '  ' })).toBe('«Текст»: не может быть пустым');
    expect(await bad({ imageUrl: 'https://cdn.example.com/a.jpg', text: 'x'.repeat(1025) })).toBe(
      '«Текст»: с картинкой — не длиннее 1 024 символов (это подпись к фото)',
    );
    expect(await bad({ imageUrl: 'ftp://cdn.example.com/a.jpg' })).toBe('«Картинка»: загрузите картинку или укажите ссылку https://…');
    expect(await bad({ button: { kind: 'url', text: 'Сайт', url: 'http://mikan.example' } })).toBe('«Кнопка»: укажите ссылку, начинающуюся с https://');
    expect(await bad({ button: { kind: 'url', url: 'https://mikan.example' } })).toBe('«Кнопка»: укажите текст кнопки');
    expect(await bad({ button: { kind: 'call' } })).toMatch(/^«Тип»: недопустимое значение/);

    // 1 024 characters with a picture is fine; a long text without one too.
    await create({ ...draftBody, imageUrl: '/uploads/a.jpg', text: 'x'.repeat(1024) });
    const long = await create({ ...draftBody, text: 'x'.repeat(3500) });
    // Adding a picture to a long text later is refused as well.
    const res = await t.api('PATCH', `/api/campaigns/${long.id}`, { imageUrl: 'https://cdn.example.com/a.jpg' });
    expect(res.statusCode).toBe(400);
  });

  it('edits drafts and scheduled ones only; deletes drafts only', async () => {
    const campaign = await create();
    const patched = await t.api('PATCH', `/api/campaigns/${campaign.id}`, {
      title: 'Осень',
      button: { kind: 'book', text: 'Записаться со скидкой' },
      segment: { minVisits: 2 },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({
      title: 'Осень',
      text: draftBody.text,
      button: { text: 'Записаться со скидкой', kind: 'book', url: null },
      segment: { minVisits: 2, categories: null },
    });
    const cleared = await t.api('PATCH', `/api/campaigns/${campaign.id}`, { button: null, imageUrl: null });
    expect(cleared.json().button).toBeNull();

    const scheduled = await t.api('POST', `/api/campaigns/${campaign.id}/send`, { at: '2026-10-20T07:00:00.000Z' });
    expect(scheduled.json()).toMatchObject({ status: 'scheduled', scheduledAt: '2026-10-20T07:00:00.000Z' });
    expect((await t.api('PATCH', `/api/campaigns/${campaign.id}`, { title: 'Осень-2' })).statusCode).toBe(200);
    expect((await t.api('DELETE', `/api/campaigns/${campaign.id}`)).statusCode).toBe(409);

    await t.api('POST', `/api/campaigns/${campaign.id}/cancel`);
    const late = await t.api('PATCH', `/api/campaigns/${campaign.id}`, { title: 'Ещё' });
    expect(late.statusCode).toBe(409);
    expect(late.json().error.message).toBe('Рассылку уже нельзя изменить: она отправляется или завершена');

    const draft = await create();
    expect((await t.api('DELETE', `/api/campaigns/${draft.id}`)).statusCode).toBe(204);
    expect((await t.api('PATCH', `/api/campaigns/${draft.id}`, { title: 'x' })).statusCode).toBe(404);
    expect((await t.api('POST', '/api/campaigns/999/send', {})).statusCode).toBe(404);
  });

  it('sending now fixes the recipients; nobody to send to or the bot offline is refused', async () => {
    const campaign = await create({ ...draftBody, segment: {} });
    const empty = await t.api('POST', `/api/campaigns/${campaign.id}/send`, {});
    expect(empty.statusCode).toBe(409);
    expect(empty.json().error).toEqual({
      code: 'conflict',
      message: 'Под условия рассылки не подходит ни один клиент с Telegram, который согласен получать новости',
    });
    expect((await t.api('GET', '/api/campaigns')).json().items[0].status).toBe('draft');

    await addClient(t, 'Анна', { chatId: 7001 });
    await addClient(t, 'Борис', { chatId: 7002 });
    await addClient(t, 'Вера');
    t.gateway.running = false;
    const offline = await t.api('POST', `/api/campaigns/${campaign.id}/send`, {});
    expect(offline.statusCode).toBe(409);
    expect(offline.json().error.message).toBe('Telegram-бот не запущен — проверьте настройки бота');

    t.gateway.running = true;
    const started = await t.api('POST', `/api/campaigns/${campaign.id}/send`, { at: null });
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({
      status: 'sending',
      startedAt: '2026-10-19T09:00:00.000Z',
      stats: { recipients: 2, sent: 0, failed: 0, blocked: 0, pending: 2 },
    });
    // A client who links Telegram later is not added.
    await addClient(t, 'Галя', { chatId: 7003 });
    expect((await t.api('GET', '/api/campaigns')).json().items[0].stats.recipients).toBe(2);

    const again = await t.api('POST', `/api/campaigns/${campaign.id}/send`, {});
    expect(again.statusCode).toBe(409);
    // A time already past means «now» (here: refused, it is already sending).
    expect((await t.api('POST', `/api/campaigns/${campaign.id}/send`, { at: '2026-10-19T08:00:00.000Z' })).statusCode).toBe(409);
  });

  it('a scheduled campaign can be sent now (send without `at`) or moved (send with `at`)', async () => {
    await addClient(t, 'Анна', { chatId: 7001 });
    const campaign = await create({ ...draftBody, segment: {} });
    await t.api('POST', `/api/campaigns/${campaign.id}/send`, { at: '2026-10-25T07:00:00.000Z' });
    const moved = await t.api('POST', `/api/campaigns/${campaign.id}/send`, { at: '2026-10-26T07:00:00.000Z' });
    expect(moved.json()).toMatchObject({ status: 'scheduled', scheduledAt: '2026-10-26T07:00:00.000Z', startedAt: null });
    const now = await t.api('POST', `/api/campaigns/${campaign.id}/send`, {});
    expect(now.statusCode).toBe(200);
    expect(now.json()).toMatchObject({
      status: 'sending',
      scheduledAt: null,
      startedAt: '2026-10-19T09:00:00.000Z',
      stats: { recipients: 1, pending: 1 },
    });
  });

  it('schedules, reschedules and cancels', async () => {
    const campaign = await create();
    const bad = await t.api('POST', `/api/campaigns/${campaign.id}/send`, { at: 'завтра' });
    expect(bad.statusCode).toBe(400);
    expect((await t.api('POST', `/api/campaigns/${campaign.id}/send`, { at: '2028-01-01T00:00:00.000Z' })).statusCode).toBe(400);

    await t.api('POST', `/api/campaigns/${campaign.id}/send`, { at: '2026-10-20T07:00:00.000Z' });
    const moved = await t.api('POST', `/api/campaigns/${campaign.id}/send`, { at: '2026-10-21T07:00:00.000Z' });
    expect(moved.json()).toMatchObject({ status: 'scheduled', scheduledAt: '2026-10-21T07:00:00.000Z' });

    const cancelled = await t.api('POST', `/api/campaigns/${campaign.id}/cancel`);
    expect(cancelled.json()).toMatchObject({ status: 'cancelled', finishedAt: '2026-10-19T09:00:00.000Z' });
    expect((await t.api('POST', `/api/campaigns/${campaign.id}/cancel`)).statusCode).toBe(409);
    expect((await t.api('POST', `/api/campaigns/${campaign.id}/send`, {})).statusCode).toBe(409);
    const draft = await create();
    const notRunning = await t.api('POST', `/api/campaigns/${draft.id}/cancel`);
    expect(notRunning.statusCode).toBe(409);
    expect(notRunning.json().error.message).toBe('Остановить можно только запланированную или идущую рассылку');
  });

  it('a test goes to the employee’s own staff chat, else the staff group (Mini App as a link there)', async () => {
    const res = await t.api('PUT', '/api/settings/studio', { onlineBooking: { enabled: true } });
    expect(res.statusCode).toBe(200);
    t.ctx.config.publicUrl = 'https://mikan.example';
    const campaign = await create({ ...draftBody, button: { kind: 'book' } });

    const nowhere = await t.api('POST', `/api/campaigns/${campaign.id}/test`);
    expect(nowhere.statusCode).toBe(409);
    expect(nowhere.json().error.message).toMatch(/^Некуда отправить тест/);

    handleStaffCommand(t.ctx, STAFF_GROUP, issueStaffCode(t.ctx.db).code);
    t.gateway.sent = [];
    expect((await t.api('POST', `/api/campaigns/${campaign.id}/test`)).json()).toEqual({ sent: true });
    expect(t.gateway.sent).toEqual([
      {
        chatId: STAFF_GROUP,
        text: 'Админ, скидка 15% на проколы до конца октября!',
        messageId: expect.any(Number),
        keyboard: [
          [{ text: '📅 Записаться', url: 'https://mikan.example/book' }],
          [{ text: '🔕 Не присылать новости', data: 'mo' }],
        ],
      },
    ]);

    upsertChat(t.ctx.db, 4242, { telegramName: 'Админ', username: null });
    setChatEmployee(t.ctx.db, 4242, 1);
    await t.api('POST', `/api/campaigns/${campaign.id}/test`);
    expect(t.gateway.sent[1]).toMatchObject({ chatId: 4242, keyboard: [[{ text: '📅 Записаться', webApp: 'https://mikan.example/book' }], expect.anything()] });

    t.gateway.failures.push(new Error('Telegram: Bad Request'));
    const failed = await t.api('POST', `/api/campaigns/${campaign.id}/test`);
    expect(failed.statusCode).toBe(502);
    expect(failed.json().error.code).toBe('upstream_error');
    // Tests are not stored in chats and do not change the campaign.
    expect((await t.api('GET', '/api/campaigns')).json().items[0].status).toBe('draft');
  });

  it('owner and admin only: a master gets 403 everywhere', async () => {
    await make(t, '/api/employees', { name: 'Мастер', login: 'master', password: 'secret123', isMaster: true, role: 'master' });
    const login = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'master', password: 'secret123' } });
    const token = login.json().token as string;
    const asMaster = (method: InjectOptions['method'], url: string, payload?: unknown) =>
      t.app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload === undefined ? {} : { payload: payload as InjectOptions['payload'] }) });
    const campaign = await create();
    for (const [method, url, body] of [
      ['GET', '/api/campaigns'],
      ['GET', `/api/campaigns/${campaign.id}`],
      ['POST', '/api/campaigns', draftBody],
      ['PATCH', `/api/campaigns/${campaign.id}`, { title: 'x' }],
      ['POST', '/api/campaigns/preview', { segment: {} }],
      ['POST', `/api/campaigns/${campaign.id}/test`],
      ['POST', `/api/campaigns/${campaign.id}/send`, {}],
      ['POST', `/api/campaigns/${campaign.id}/cancel`],
      ['DELETE', `/api/campaigns/${campaign.id}`],
    ] as Array<[InjectOptions['method'], string, unknown?]>) {
      const res = await asMaster(method, url, body);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().error.message).toBe(MANAGERS);
    }
    const admin = await make(t, '/api/employees', { name: 'Ольга', login: 'olga', password: 'secret123', role: 'admin' });
    expect(admin.role).toBe('admin');
    const adminToken = (await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'olga', password: 'secret123' } })).json().token;
    const list = await t.app.inject({ method: 'GET', url: '/api/campaigns', headers: { authorization: `Bearer ${adminToken}` } });
    expect(list.statusCode).toBe(200);
  });

  it('writes Russian audit summaries; the preview is not logged', async () => {
    await addClient(t, 'Анна', { chatId: 7001 });
    const campaign = await create({ ...draftBody, segment: {} });
    await t.api('PATCH', `/api/campaigns/${campaign.id}`, { text: 'Новый текст', segment: { minVisits: 1 }, title: 'Осень' });
    await t.api('PATCH', `/api/campaigns/${campaign.id}`, { title: 'Осень' });
    await t.api('POST', '/api/campaigns/preview', { segment: {} });
    await t.api('POST', `/api/campaigns/${campaign.id}/send`, { at: '2026-10-20T07:00:00.000Z' });
    await t.api('POST', `/api/campaigns/${campaign.id}/cancel`);
    const second = await create({ ...draftBody, title: 'Зима', segment: {} });
    handleStaffCommand(t.ctx, STAFF_GROUP, issueStaffCode(t.ctx.db).code);
    await t.api('POST', `/api/campaigns/${second.id}/test`);
    await t.api('POST', `/api/campaigns/${second.id}/send`, {});
    await t.api('POST', `/api/campaigns/${second.id}/cancel`);
    const third = await create({ ...draftBody, title: 'Черновик' });
    await t.api('DELETE', `/api/campaigns/${third.id}`);

    expect((await audit()).reverse()).toEqual([
      ['campaign.create', 'Рассылка «Осенняя акция» создана (черновик)'],
      ['campaign.update', 'Рассылка «Осень» изменена: название, текст, получатели'],
      ['campaign.update', 'Рассылка «Осень» сохранена без изменений'],
      ['campaign.schedule', 'Рассылка «Осень» запланирована на 20 октября, 10:00'],
      ['campaign.cancel', 'Запланированная рассылка «Осень» отменена'],
      ['campaign.create', 'Рассылка «Зима» создана (черновик)'],
      ['campaign.test', 'Рассылка «Зима»: тестовое сообщение отправлено себе'],
      ['campaign.send', 'Рассылка «Зима» запущена: 1 получатель'],
      ['campaign.cancel', 'Рассылка «Зима» остановлена: отправлено 0 из 1'],
      ['campaign.create', 'Рассылка «Черновик» создана (черновик)'],
      ['campaign.delete', 'Черновик рассылки «Черновик» удалён'],
    ]);
  });
});
