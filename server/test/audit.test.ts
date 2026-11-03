import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { confirmForClient, rescheduleForClient } from '../src/bot/client-appointments.js';
import { handleStaffCommand } from '../src/bot/onboarding.js';
import { BotPipeline } from '../src/bot/pipeline.js';
import { issueStaffCode } from '../src/bot/staff.js';
import { silentLogger } from '../src/context.js';
import { auditLog, employees } from '../src/db/schema.js';
import { pruneAuditLog, writeAudit } from '../src/domain/audit.js';
import { createTestApp, FakeQrProvider, make, message, openShift, ScriptedAi, text, toolUse, type TestApp } from './helpers.js';

const NOW = Date.parse('2026-10-15T09:00:00.000Z'); // Thu 12:00 Moscow

interface Entry {
  id: number;
  at: string;
  employee: { id: number; name: string } | null;
  source: string;
  action: string;
  entity: string;
  entityId: number | null;
  summary: string;
  changes: Record<string, { from: unknown; to: unknown }> | null;
}

describe('audit log', () => {
  let t: TestApp;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    t = await createTestApp();
  });
  afterEach(async () => {
    await t.close();
    vi.useRealTimers();
  });

  const log = async (query = '') => {
    const res = await t.api('GET', `/api/audit${query}`);
    expect(res.statusCode).toBe(200);
    return res.json() as { items: Entry[]; total: number };
  };
  const latest = async (query = '') => (await log(query)).items[0]!;
  const anna = () => make(t, '/api/clients', { name: 'Анна', lastName: 'Иванова', phone: '+79991234567' });
  const book = (clientId: number, startsAt = '2026-10-20T11:00:00.000Z', endsAt = '2026-10-20T12:00:00.000Z') =>
    make(t, '/api/appointments', { clientId, masterId: 1, startsAt, endsAt, title: 'Хеликс' });

  describe('capture of app writes', () => {
    it('records a client card created and edited, with what changed', async () => {
      const client = await anna();
      await t.api('PATCH', `/api/clients/${client.id}`, { phone: '+79990000001', notes: 'Аллергия на никель' });

      const { items, total } = await log();
      expect(total).toBe(2);
      expect(items[0]).toMatchObject({
        source: 'app',
        employee: { id: 1, name: 'Админ' },
        action: 'client.update',
        entity: 'client',
        entityId: client.id,
        summary: 'Карточка клиента «Анна Иванова» изменена: телефон, заметки',
        changes: { phone: { from: '+79991234567', to: '+79990000001' }, notes: { from: null, to: 'Аллергия на никель' } },
      });
      expect(Object.keys(items[0]!.changes!).sort()).toEqual(['notes', 'phone']);
      expect(items[1]).toMatchObject({ action: 'client.create', summary: 'Карточка клиента «Анна Иванова» создана', changes: null });
      expect(items[0]!.at).toBe(new Date(NOW).toISOString());
    });

    it('describes a created, moved, cancelled and completed appointment', async () => {
      const client = await anna();
      const a = await book(client.id);
      expect(await latest()).toMatchObject({
        action: 'appointment.create',
        entityId: a.id,
        summary: `Запись №${a.id} (Анна Иванова) создана на 20 октября, 14:00 — Хеликс, мастер Админ`,
      });

      await t.api('PATCH', `/api/appointments/${a.id}`, { startsAt: '2026-10-21T12:00:00.000Z' });
      const moved = await latest();
      expect(moved).toMatchObject({
        action: 'appointment.move',
        summary: `Запись №${a.id} (Анна Иванова) перенесена с 20 октября, 14:00 на 21 октября, 15:00`,
        changes: {
          startsAt: { from: '2026-10-20T11:00:00.000Z', to: '2026-10-21T12:00:00.000Z' },
          endsAt: { from: '2026-10-20T12:00:00.000Z', to: '2026-10-21T13:00:00.000Z' },
        },
      });
      expect(moved.changes).not.toHaveProperty('updatedAt');

      await t.api('PATCH', `/api/appointments/${a.id}`, { price: 5000, notes: 'Эскиз согласован' });
      expect((await latest()).summary).toBe(`Запись №${a.id} (Анна Иванова) изменена: цена 0 → 5 000 ₽, заметки`);

      await t.api('PATCH', `/api/appointments/${a.id}`, { status: 'cancelled' });
      expect(await latest()).toMatchObject({
        action: 'appointment.status',
        summary: `Запись №${a.id} (Анна Иванова) отменена`,
        changes: { status: { from: 'scheduled', to: 'cancelled' } },
      });

      const b = await book(client.id, '2026-10-22T11:00:00.000Z', '2026-10-22T12:00:00.000Z');
      expect((await t.api('POST', `/api/appointments/${b.id}/complete`, { sendAftercare: false })).statusCode).toBe(200);
      expect(await latest()).toMatchObject({
        action: 'appointment.complete',
        entityId: b.id,
        summary: `Запись №${b.id} (Анна Иванова) завершена`,
        changes: { status: { from: 'scheduled', to: 'completed' } },
      });
    });

    it('describes prepayments, sales, refunds and the cash register', async () => {
      const client = await anna();
      const a = await book(client.id);
      await make(t, '/api/cash/shift/open', { openingCash: 5000 });
      expect((await latest()).summary).toBe('Смена №1 открыта: в кассе 5 000 ₽');

      await make(t, `/api/appointments/${a.id}/deposit`, { amount: 2000, method: 'cash' });
      expect(await latest()).toMatchObject({
        action: 'deposit.receive',
        entity: 'deposit',
        entityId: a.id,
        summary: `Предоплата по записи №${a.id} (Анна Иванова) принята: 2 000 ₽, наличными`,
      });

      const product = await make(t, '/api/products', { kind: 'jewelry', name: 'Лабрет', price: 1500, initialQuantity: 3 });
      const sale = await make(t, '/api/sales', {
        clientId: client.id,
        items: [{ type: 'product', productId: product.id, quantity: 1 }],
        discount: 0,
        payments: { cash: 1500, card: 0, transfer: 0 },
      });
      expect(await latest()).toMatchObject({
        action: 'sale.create',
        entity: 'sale',
        entityId: sale.id,
        summary: `Продажа №${sale.number} (Анна Иванова) проведена: 1 500 ₽ — Лабрет`,
      });

      await make(t, `/api/sales/${sale.id}/refund`, { reason: 'Не подошёл размер' });
      expect(await latest()).toMatchObject({
        action: 'sale.refund',
        entityId: sale.id,
        summary: `Продажа №${sale.number} возвращена: 1 500 ₽. Причина: Не подошёл размер`,
      });

      await make(t, '/api/cash/operations', { type: 'out', amount: 1000, reason: 'Инкассация' });
      expect(await latest()).toMatchObject({ action: 'cash.out', entity: 'cash', entityId: 1, summary: 'Изъятие из кассы: 1 000 ₽ — Инкассация' });
    });

    it('words catalog changes: a service price, a product, stock and categories', async () => {
      const lobe = await make(t, '/api/services', { name: 'Мочка', category: 'piercing', price: 1600, durationMin: 30 });
      expect((await latest()).summary).toBe('Услуга «Мочка» добавлена: 1 600 ₽');
      await t.api('PATCH', `/api/services/${lobe.id}`, { price: 1800 });
      expect(await latest()).toMatchObject({
        action: 'service.price',
        entity: 'service',
        entityId: lobe.id,
        summary: 'Цена «Мочка»: 1 600 → 1 800 ₽',
        changes: { price: { from: 1600, to: 1800 } },
      });

      const labret = await make(t, '/api/products', { kind: 'jewelry', name: 'Лабрет', price: 1500, initialQuantity: 3 });
      expect((await latest()).summary).toBe('Украшение «Лабрет» добавлено: 1 500 ₽');
      await t.api('PATCH', `/api/products/${labret.id}`, { price: 1700, material: 'Титан' });
      expect((await latest()).summary).toBe('Цена «Лабрет»: 1 500 → 1 700 ₽; также изменено: материал');

      await make(t, `/api/products/${labret.id}/movements`, { type: 'receipt', quantity: 5 });
      expect(await latest()).toMatchObject({
        action: 'stock.receipt',
        entity: 'stock',
        entityId: labret.id,
        summary: 'Приход: Лабрет, +5 шт (остаток 8)',
      });

      const category = await make(t, '/api/catalog/categories', { section: 'jewelry', name: 'Лабреты' });
      expect((await latest()).summary).toBe('Категория «Лабреты» (Украшения) добавлена');
      await t.api('PATCH', `/api/catalog/categories/${category.id}`, { name: 'Лабреты и микробананы' });
      expect((await latest()).summary).toBe('Категория «Лабреты» переименована в «Лабреты и микробананы»');
      expect((await t.api('DELETE', `/api/catalog/categories/${category.id}`)).statusCode).toBe(204);
      expect(await latest()).toMatchObject({ action: 'category.delete', entityId: category.id, summary: 'Категория «Лабреты и микробананы» удалена' });
    });

    it('records settings, knowledge and booking requests', async () => {
      await t.api('PUT', '/api/settings/studio', { address: 'Томск, Ленина 1', cancellation: { freeHours: 48 } });
      expect(await latest()).toMatchObject({
        action: 'settings.studio',
        entity: 'settings',
        entityId: null,
        summary: 'Настройки студии изменены: адрес, правила отмены',
      });
      const entry = await make(t, '/api/knowledge', { title: 'Противопоказания', content: 'Беременность' });
      expect((await latest()).summary).toBe('Запись базы знаний «Противопоказания» добавлена');
      await t.api('DELETE', `/api/knowledge/${entry.id}`);
      expect(await latest()).toMatchObject({ action: 'knowledge.delete', entityId: entry.id, summary: 'Запись базы знаний «Противопоказания» удалена' });
    });

    it('never stores passwords, password hashes or tokens', async () => {
      const fatima = await make(t, '/api/employees', { name: 'Фатима', login: 'fatima', password: 'first-pass-1', isMaster: true });
      await t.api('PATCH', `/api/employees/${fatima.id}`, { password: 'second-pass-2', phone: '+79995554433' });
      expect(await latest()).toMatchObject({
        action: 'employee.update',
        entityId: fatima.id,
        summary: 'Профиль «Фатима» изменён: телефон, пароль',
        changes: { phone: { from: null, to: '+79995554433' } },
      });
      const client = await anna();
      const link = (await t.api('POST', `/api/clients/${client.id}/telegram-link`)).json().url as string;
      const token = new URL(link).searchParams.get('start')!.slice(1);
      expect((await latest()).summary).toBe('Для карточки клиента «Анна Иванова» создана ссылка привязки Telegram');

      const stored = JSON.stringify(t.ctx.db.select().from(auditLog).all());
      const hash = t.ctx.db.select().from(employees).all().find((e) => e.id === fatima.id)!.passwordHash;
      for (const secret of ['first-pass-1', 'second-pass-2', hash, token, t.token]) expect(stored).not.toContain(secret);
    });

    it('skips reads, excluded endpoints, failed requests and idempotent replays', async () => {
      const handled = new BotPipeline(t.ctx, 0);
      handleStaffCommand(t.ctx, -100, issueStaffCode(t.ctx.db).code);
      handled.receive({ chatId: 42, telegramName: 'Иван', username: null }, 'Привет');
      await handled.idle();
      expect((await t.api('POST', '/api/bot/chats/42/read')).statusCode).toBe(204);
      expect((await t.api('POST', '/api/bot/staff-code')).statusCode).toBe(200);
      await t.api('GET', '/api/clients');
      expect((await t.api('PATCH', '/api/clients/999', { notes: 'x' })).statusCode).toBe(404);
      expect((await t.api('POST', '/api/clients', { name: 'Без телефона' })).statusCode).toBe(400);
      expect((await log()).total).toBe(0);

      await openShift(t);
      const product = await make(t, '/api/products', { kind: 'goods', name: 'Спрей', price: 500, initialQuantity: 5 });
      const key = randomUUID();
      const sell = () =>
        t.app.inject({
          method: 'POST',
          url: '/api/sales',
          headers: { authorization: `Bearer ${t.token}`, 'idempotency-key': key },
          payload: { items: [{ type: 'product', productId: product.id, quantity: 1 }], discount: 0, payments: { cash: 500, card: 0, transfer: 0 } },
        });
      expect((await sell()).statusCode).toBe(200);
      expect((await sell()).headers['idempotent-replayed']).toBe('true');
      expect((await log('?entity=sale')).total).toBe(1);
    });

    it('does not fail the request when the log cannot be written', async () => {
      const errors: unknown[] = [];
      t.ctx.log = { ...silentLogger, error: (obj: unknown) => void errors.push(obj) };
      t.ctx.sqlite.exec('DROP TABLE audit_log');
      const res = await t.api('POST', '/api/clients', { name: 'Анна', phone: '+79991234567' });
      expect(res.statusCode).toBe(200);
      expect((await t.api('GET', `/api/clients/${res.json().id}`)).statusCode).toBe(200);
      expect(errors).toEqual([expect.objectContaining({ action: 'client.create' })]);
    });
  });

  describe('GET /audit', () => {
    const seed = () => {
      const day = 24 * 60 * 60_000;
      const base = { changes: null, summary: '…', entityId: 7 };
      writeAudit(t.ctx.db, { ...base, at: NOW - 3 * day, source: 'app', employeeId: 1, action: 'appointment.create', entity: 'appointment' });
      writeAudit(t.ctx.db, { ...base, at: NOW - 2 * day, source: 'system', employeeId: null, action: 'deposit.retain', entity: 'deposit' });
      writeAudit(t.ctx.db, { ...base, at: NOW - day, source: 'bot', employeeId: null, action: 'appointment.confirm', entity: 'appointment' });
      writeAudit(t.ctx.db, { ...base, at: NOW, source: 'app', employeeId: 1, action: 'client.update', entity: 'client', entityId: 3 });
    };

    it('filters by employee, section, entity, source and time, newest first with paging', async () => {
      seed();
      const all = await log();
      expect(all.total).toBe(4);
      expect(all.items.map((e) => e.action)).toEqual(['client.update', 'appointment.confirm', 'deposit.retain', 'appointment.create']);
      expect(all.items[1]).toMatchObject({ employee: null, source: 'bot' });

      expect((await log('?employeeId=1')).items.map((e) => e.action)).toEqual(['client.update', 'appointment.create']);
      expect((await log('?entity=appointment,deposit&entityId=7')).total).toBe(3);
      expect((await log('?entity=client')).items.map((e) => e.entityId)).toEqual([3]);
      expect((await log('?source=system')).items.map((e) => e.action)).toEqual(['deposit.retain']);
      const window = await log(`?from=${new Date(NOW - 2.5 * 86_400_000).toISOString()}&to=${new Date(NOW).toISOString()}`);
      expect(window.items.map((e) => e.action)).toEqual(['appointment.confirm', 'deposit.retain']);
      const page = await log('?limit=2&offset=2');
      expect(page).toMatchObject({ total: 4 });
      expect(page.items.map((e) => e.action)).toEqual(['deposit.retain', 'appointment.create']);
      expect((await t.api('GET', '/api/audit?source=robot')).statusCode).toBe(400);
    });

    it('is open to the owner only', async () => {
      await make(t, '/api/employees', { name: 'Борис', login: 'boris', password: 'secret123', isMaster: false });
      const login = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'boris', password: 'secret123' } });
      const res = await t.app.inject({ method: 'GET', url: '/api/audit', headers: { authorization: `Bearer ${login.json().token}` } });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: { code: 'forbidden', message: 'Это доступно владельцу студии' } });
    });

    it('prunes entries older than two years', () => {
      const day = 24 * 60 * 60_000;
      const base = { source: 'app' as const, employeeId: 1, action: 'client.update', entity: 'client', entityId: 1, summary: '…' };
      writeAudit(t.ctx.db, { ...base, at: Date.parse('2024-10-14T09:00:00.000Z') });
      writeAudit(t.ctx.db, { ...base, at: Date.parse('2024-10-16T09:00:00.000Z') });
      writeAudit(t.ctx.db, { ...base, at: NOW - day });
      expect(pruneAuditLog(t.ctx.db, NOW)).toBe(1);
      expect(t.ctx.db.select().from(auditLog).all()).toHaveLength(2);
    });
  });

  describe('bot and server sources', () => {
    it('records a booking request, a confirmation and a reschedule made by the client in the bot', async () => {
      const ai = new ScriptedAi();
      t.ctx.ai = ai;
      const pipeline = new BotPipeline(t.ctx, 0);
      handleStaffCommand(t.ctx, -100, issueStaffCode(t.ctx.db).code);
      ai.push(
        message([toolUse('tu_1', 'create_booking_request', {
          contactName: 'Мария', phone: '8 999 111-22-33', serviceName: 'Прокол хеликса', preferredTime: 'суббота после 15:00',
        })], 'tool_use'),
        message([text('Готово!')]),
      );
      pipeline.receive({ chatId: 700_001, telegramName: 'Мария', username: 'masha' }, 'Хочу на хеликс');
      await pipeline.idle();
      expect(await latest()).toMatchObject({
        source: 'bot',
        employee: null,
        action: 'bot.booking_create',
        entity: 'bot',
        entityId: 1,
        summary: 'Заявка на запись №1 из бота: Мария — Прокол хеликса, суббота после 15:00',
      });

      const client = await anna();
      const a = await book(client.id);
      expect((await confirmForClient(t.ctx, client.id, a.id)).ok).toBe(true);
      expect(await latest()).toMatchObject({
        source: 'bot',
        employee: null,
        action: 'appointment.confirm',
        entity: 'appointment',
        entityId: a.id,
        summary: `Запись №${a.id} (Анна Иванова) подтверждена клиентом в боте`,
        changes: { status: { from: 'scheduled', to: 'confirmed' } },
      });

      const moved = await rescheduleForClient(t.ctx, { clientId: client.id, appointmentId: a.id, startsAt: Date.parse('2026-10-21T12:00:00.000Z') });
      expect(moved.ok).toBe(true);
      expect(await latest()).toMatchObject({
        source: 'bot',
        action: 'appointment.move',
        summary: `Запись №${a.id} (Анна Иванова) перенесена клиентом через бота с 20 октября, 14:00 на 21 октября, 15:00`,
        changes: { startsAt: { from: '2026-10-20T11:00:00.000Z', to: '2026-10-21T12:00:00.000Z' } },
      });
    });

    it('records the automatic prepayment retain as the server', async () => {
      await t.api('PUT', '/api/settings/studio', { cancellation: { autoRetain: true } });
      const client = await anna();
      const a = await book(client.id, '2026-10-15T15:00:00.000Z', '2026-10-15T16:00:00.000Z');
      await make(t, `/api/appointments/${a.id}/deposit`, { amount: 2000, method: 'transfer' });
      await t.api('PATCH', `/api/appointments/${a.id}`, { status: 'cancelled' });

      const { items } = await log(`?entity=appointment,deposit&entityId=${a.id}`);
      expect(items.map((e) => [e.source, e.action])).toEqual([
        ['app', 'appointment.status'],
        ['system', 'deposit.retain'],
        ['app', 'deposit.receive'],
        ['app', 'appointment.create'],
      ]);
      expect(items[1]).toMatchObject({
        employee: null,
        entity: 'deposit',
        entityId: a.id,
        summary: `Предоплата по записи №${a.id} (Анна Иванова) удержана автоматически: 2 000 ₽ — Поздняя отмена — меньше 24 ч до записи`,
      });
    });

    it('records a QR payment confirmed by the bank as the server', async () => {
      await t.close();
      const qr = new FakeQrProvider();
      t = await createTestApp({ qr });
      await openShift(t);
      const product = await make(t, '/api/products', { kind: 'goods', name: 'Спрей', price: 500, initialQuantity: 5 });
      const code = await make(t, '/api/qr-payments', {
        items: [{ type: 'product', productId: product.id, quantity: 1 }],
        discount: 0,
        payments: { cash: 0, card: 0, transfer: 0, qr: 500 },
      });
      expect(await latest()).toMatchObject({ source: 'app', action: 'sale.qr_create', summary: `QR-код на оплату №${code.id} выдан: 500 ₽` });

      qr.statuses.set('QR1', 'paid');
      const paid = (await t.api('GET', `/api/qr-payments/${code.id}`)).json();
      expect(paid.status).toBe('paid');
      expect(await latest()).toMatchObject({
        source: 'system',
        employee: null,
        action: 'sale.qr_paid',
        entity: 'sale',
        entityId: paid.sale.id,
        summary: `Оплата по QR-коду №${code.id} подтверждена банком: продажа №${paid.sale.number}, 500 ₽`,
      });
    });
  });
});
