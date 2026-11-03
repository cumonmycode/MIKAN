import type { InjectOptions } from 'fastify';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bookingRequests, employees } from '../src/db/schema.js';
import { assertOwnerRemains } from '../src/domain/permissions.js';
import { createTestApp, make, type TestApp } from './helpers.js';

const NOW = Date.parse('2026-10-15T09:00:00.000Z'); // Thu 12:00 Moscow
const OWNER_ONLY = 'Это доступно владельцу студии';
const MANAGERS = 'Это доступно владельцу и администратору';
const OWN_ONLY = 'Можно менять только свои записи';

type Method = InjectOptions['method'];
type Api = (method: Method, url: string, payload?: unknown) => ReturnType<TestApp['api']>;
interface Session {
  employee: { id: number; name: string; role: string };
  api: Api;
}

/** Owner+admin rows of the «Roles» table: one entry per restricted route (ids need not exist — the role decides first). */
const MANAGER_ROUTES: Array<[Method, string]> = [
  ['POST', '/api/services'],
  ['PATCH', '/api/services/1'],
  ['POST', '/api/services/1/image/generate'],
  ['POST', '/api/aftercare-templates'],
  ['PATCH', '/api/aftercare-templates/1'],
  ['DELETE', '/api/aftercare-templates/1'],
  ['POST', '/api/catalog/categories'],
  ['PATCH', '/api/catalog/categories/1'],
  ['PUT', '/api/catalog/categories/order'],
  ['POST', '/api/catalog/categories/1/merge'],
  ['DELETE', '/api/catalog/categories/1'],
  ['POST', '/api/products'],
  ['PATCH', '/api/products/1'],
  ['DELETE', '/api/products/1'],
  ['POST', '/api/products/1/movements'],
  ['POST', '/api/products/1/movements/batch'],
  ['POST', '/api/products/1/purchases'],
  ['POST', '/api/stock/revisions'],
  ['POST', '/api/stock/deliveries'],
  ['GET', '/api/reports/summary?from=2026-10-01T00:00:00.000Z&to=2026-10-31T00:00:00.000Z'],
  ['GET', '/api/reports/analytics?from=2026-10-01&to=2026-10-31'],
  ['GET', '/api/reports/growth?from=2026-10-01T00:00:00.000Z&to=2026-10-31T00:00:00.000Z'],
  ['PUT', '/api/settings/studio'],
  ['PUT', '/api/settings/bot'],
  ['POST', '/api/knowledge'],
  ['PATCH', '/api/knowledge/1'],
  ['DELETE', '/api/knowledge/1'],
  ['PUT', '/api/bot/chats/1/employee'],
  ['DELETE', '/api/bot/chats/1/employee'],
  ['POST', '/api/bot/test'],
];

describe('roles and permissions', () => {
  let t: TestApp;
  let admin: Session;
  let master: Session;
  let other: Session;
  let client: { id: number };

  async function session(role: 'owner' | 'admin' | 'master', login: string, name: string): Promise<Session> {
    const employee = await make(t, '/api/employees', { name, login, password: 'secret123', isMaster: role === 'master', role });
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login, password: 'secret123' } });
    const token = res.json<{ token: string }>().token;
    const api: Api = (method, url, payload) =>
      t.app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${token}` },
        ...(payload === undefined ? {} : { payload: payload as InjectOptions['payload'] }),
      });
    return { employee, api };
  }

  const appointment = (masterId: number, hour = 12, extra: Record<string, unknown> = {}) =>
    make(t, '/api/appointments', {
      clientId: client.id,
      masterId,
      title: 'Консультация',
      startsAt: `2026-10-16T${String(hour).padStart(2, '0')}:00:00.000Z`,
      endsAt: `2026-10-16T${String(hour).padStart(2, '0')}:30:00.000Z`,
      ...extra,
    });

  const expectForbidden = (res: Awaited<ReturnType<Api>>, message: string) => {
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: { code: 'forbidden', message } });
  };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    t = await createTestApp();
    admin = await session('admin', 'aida', 'Аида');
    master = await session('master', 'fatima', 'Фатима');
    other = await session('master', 'amina', 'Амина');
    client = await make(t, '/api/clients', { name: 'Иван', phone: '+79991234567' });
  });
  afterEach(async () => {
    await t.close();
    vi.useRealTimers();
  });

  describe('route table', () => {
    it('limits catalog, stock, reports, settings, knowledge and staff chat binding writes to owner and admin', async () => {
      for (const [method, url] of MANAGER_ROUTES) {
        const res = await master.api(method, url);
        expect({ method, url, status: res.statusCode }).toEqual({ method, url, status: 403 });
        expect(res.json().error).toEqual({ code: 'forbidden', message: MANAGERS });
      }
      // HEAD runs the GET handler: reports stay closed for it too.
      expect((await master.api('HEAD', '/api/reports/summary')).statusCode).toBe(403);
      for (const [method, url] of MANAGER_ROUTES) {
        const res = await admin.api(method, url);
        expect({ method, url, forbidden: res.statusCode === 403 }).toEqual({ method, url, forbidden: false });
      }
    });

    it('lets owner and admin do the real thing', async () => {
      const service = await admin.api('POST', '/api/services', { name: 'Хеликс', category: 'piercing', price: 3000, durationMin: 30 });
      expect(service.statusCode).toBe(200);
      const report = await admin.api('GET', '/api/reports/summary?from=2026-10-01T00:00:00.000Z&to=2026-10-31T00:00:00.000Z');
      expect(report.statusCode).toBe(200);
      expect((await admin.api('PUT', '/api/settings/studio', { name: 'MIKAN' })).json().name).toBe('MIKAN');
      expect((await t.api('POST', '/api/knowledge', { title: 'Адрес', content: 'Томск' })).statusCode).toBe(200);
    });

    it('leaves reads, the till, clients, chats and booking requests open to a master', async () => {
      const product = await make(t, '/api/products', { kind: 'jewelry', name: 'Лабрет', price: 1500, variants: [{ name: '6 мм', initialQuantity: 3 }] });
      for (const url of [
        '/api/employees',
        '/api/services',
        '/api/aftercare-templates',
        '/api/catalog/categories',
        '/api/products',
        `/api/products/${product.id}`,
        `/api/products/${product.id}/movements`,
        '/api/stock/movements',
        '/api/stock/revisions',
        '/api/stock/deliveries',
        '/api/stock/suppliers',
        '/api/settings/studio',
        '/api/settings/bot',
        '/api/knowledge',
        '/api/qr-payments/config',
        '/api/dashboard',
        '/api/badges',
        '/api/bot/chats',
        '/api/bot/scheduled',
        '/api/booking-requests',
        '/api/appointments?from=2026-10-01T00:00:00.000Z&to=2026-10-31T00:00:00.000Z',
      ]) {
        expect({ url, status: (await master.api('GET', url)).statusCode }).toEqual({ url, status: 200 });
      }

      // The till: shift, sale, refund, cash operation, close.
      expect((await master.api('POST', '/api/cash/shift/open', { openingCash: 1000 })).statusCode).toBe(200);
      const sale = await master.api('POST', '/api/sales', {
        clientId: client.id,
        items: [{ type: 'product', productId: product.id, variantId: product.variants[0].id, quantity: 1, price: 1500 }],
        discount: 0,
        payments: { cash: 1500, card: 0, transfer: 0 },
      });
      expect(sale.statusCode).toBe(200);
      expect((await master.api('POST', `/api/sales/${sale.json().id}/refund`, { reason: 'Не подошло', restock: true })).statusCode).toBe(200);
      expect((await master.api('POST', '/api/cash/operations', { type: 'out', amount: 100, reason: 'Вода' })).statusCode).toBe(200);
      expect((await master.api('POST', '/api/cash/shift/close', { closingCash: 900 })).statusCode).toBe(200);

      // Clients: create, edit, Telegram link.
      const created = await master.api('POST', '/api/clients', { name: 'Мария', phone: '+79161112233' });
      expect(created.statusCode).toBe(200);
      expect((await master.api('PATCH', `/api/clients/${created.json().id}`, { notes: 'Любит минимализм' })).statusCode).toBe(200);
      expect((await master.api('POST', `/api/clients/${client.id}/telegram-link`)).statusCode).toBe(200);

      // Their own staff code; booking requests (an unknown one is simply not found).
      expect((await master.api('POST', '/api/bot/staff-code')).statusCode).toBe(200);
      const now = Date.now();
      const request = t.ctx.db
        .insert(bookingRequests)
        .values({ contactName: 'Ольга', status: 'new', createdAt: now, updatedAt: now })
        .returning()
        .get();
      expect((await master.api('PATCH', `/api/booking-requests/${request.id}`, { status: 'processed' })).statusCode).toBe(200);
      expect((await master.api('PATCH', '/api/booking-requests/999', { status: 'processed' })).statusCode).toBe(404);
    });

    it('reads the role from the database on every request', async () => {
      const url = '/api/reports/summary?from=2026-10-01T00:00:00.000Z&to=2026-10-31T00:00:00.000Z';
      expectForbidden(await master.api('GET', url), MANAGERS);
      expect((await t.api('PATCH', `/api/employees/${master.employee.id}`, { role: 'admin' })).json().role).toBe('admin');
      expect((await master.api('GET', url)).statusCode).toBe(200);
    });
  });

  describe('employees', () => {
    it('lets only the owner create employees; the role defaults from isMaster', async () => {
      expectForbidden(await admin.api('POST', '/api/employees', { name: 'Олег', login: 'oleg', password: 'secret123', isMaster: true }), OWNER_ONLY);
      expectForbidden(await master.api('POST', '/api/employees', { name: 'Олег', login: 'oleg', password: 'secret123', isMaster: true }), OWNER_ONLY);

      expect(await make(t, '/api/employees', { name: 'Олег', login: 'oleg', password: 'secret123', isMaster: true })).toMatchObject({ role: 'master' });
      expect(await make(t, '/api/employees', { name: 'Вера', login: 'vera', password: 'secret123', isMaster: false })).toMatchObject({ role: 'admin' });
      expect(await make(t, '/api/employees', { name: 'Ника', login: 'nika', password: 'secret123' })).toMatchObject({ role: 'admin', isMaster: false });
      expect(await make(t, '/api/employees', { name: 'Амир', login: 'amir', password: 'secret123', isMaster: true, role: 'owner' })).toMatchObject({ role: 'owner' });
      expect((await t.api('POST', '/api/employees', { name: 'Тим', login: 'tim', password: 'secret123', role: 'boss' })).statusCode).toBe(400);
    });

    it('lets the owner change everything of others, roles and access included', async () => {
      const res = await t.api('PATCH', `/api/employees/${master.employee.id}`, {
        name: 'Фатима К.',
        login: 'fatima.k',
        isMaster: false,
        role: 'admin',
        color: '#00AA00',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ name: 'Фатима К.', login: 'fatima.k', isMaster: false, role: 'admin', color: '#00AA00' });
      expect((await t.api('PATCH', `/api/employees/${other.employee.id}`, { active: false })).json().active).toBe(false);
      expect((await t.api('PATCH', `/api/employees/${other.employee.id}`, { role: 'owner', active: true })).json()).toMatchObject({ role: 'owner', active: true });
      expect((await t.api('PATCH', `/api/employees/${other.employee.id}`, { role: 'nobody' })).statusCode).toBe(400);
    });

    it('lets anyone edit their own name, phone, color and password, and nothing else', async () => {
      const own = await master.api('PATCH', `/api/employees/${master.employee.id}`, { name: 'Фатима Н.', phone: '8 999 111-22-33', color: '#123456' });
      expect(own.statusCode).toBe(200);
      expect(own.json()).toMatchObject({ name: 'Фатима Н.', phone: '+79991112233', color: '#123456', role: 'master' });
      // The app resends the whole card: unchanged login, isMaster, role and access are fine.
      const resent = await master.api('PATCH', `/api/employees/${master.employee.id}`, {
        name: 'Фатима',
        login: 'fatima',
        isMaster: true,
        role: 'master',
        active: true,
      });
      expect(resent.statusCode).toBe(200);

      expectForbidden(await master.api('PATCH', `/api/employees/${master.employee.id}`, { login: 'boss' }), OWNER_ONLY);
      expectForbidden(await master.api('PATCH', `/api/employees/${master.employee.id}`, { isMaster: false }), OWNER_ONLY);
      expectForbidden(await admin.api('PATCH', `/api/employees/${admin.employee.id}`, { isMaster: true }), OWNER_ONLY);

      const promote = await master.api('PATCH', `/api/employees/${master.employee.id}`, { role: 'owner' });
      expect(promote.statusCode).toBe(400);
      expect(promote.json().error.message).toBe('Нельзя изменить собственную роль');
      const off = await master.api('PATCH', `/api/employees/${master.employee.id}`, { active: false });
      expect(off.statusCode).toBe(400);
      expect(off.json().error.message).toBe('Нельзя отключить собственную учётную запись');

      // Password: the old token is revoked, the new password works.
      expect((await master.api('PATCH', `/api/employees/${master.employee.id}`, { password: 'newpass9' })).statusCode).toBe(200);
      expect((await master.api('GET', '/api/auth/me')).statusCode).toBe(401);
      const relogin = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'fatima', password: 'newpass9' } });
      expect(relogin.statusCode).toBe(200);

      const row = t.ctx.db.select().from(employees).where(eq(employees.id, master.employee.id)).get()!;
      expect(row).toMatchObject({ login: 'fatima', isMaster: true, role: 'master', active: true });
    });

    it('keeps admins and masters off other employees', async () => {
      expectForbidden(await admin.api('PATCH', `/api/employees/${master.employee.id}`, { name: 'Х' }), OWNER_ONLY);
      expectForbidden(await admin.api('PATCH', `/api/employees/${master.employee.id}`, { role: 'admin' }), OWNER_ONLY);
      expectForbidden(await master.api('PATCH', `/api/employees/${other.employee.id}`, { color: '#000000' }), OWNER_ONLY);
      expectForbidden(await master.api('PATCH', '/api/employees/1', { active: false }), OWNER_ONLY);
      expect((await master.api('PATCH', '/api/employees/999', { name: 'Нет' })).statusCode).toBe(404);
    });

    it('never lets the owner change their own role', async () => {
      const res = await t.api('PATCH', '/api/employees/1', { role: 'admin' });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toBe('Нельзя изменить собственную роль');
      expect((await t.api('PATCH', '/api/employees/1', { role: 'owner', name: 'Администратор' })).json()).toMatchObject({
        role: 'owner',
        name: 'Администратор',
      });
    });

    it('keeps at least one active owner', async () => {
      const db = t.ctx.db;
      const owner = db.select().from(employees).where(eq(employees.id, 1)).get()!;
      expect(() => assertOwnerRemains(db, owner, { role: 'admin', active: true })).toThrow('В студии должен остаться хотя бы один владелец');
      expect(() => assertOwnerRemains(db, owner, { role: 'owner', active: false })).toThrow('В студии должен остаться хотя бы один владелец');
      expect(() => assertOwnerRemains(db, owner, { role: 'owner', active: true })).not.toThrow();
      // Not an owner: nothing to keep.
      const fatima = db.select().from(employees).where(eq(employees.id, master.employee.id)).get()!;
      expect(() => assertOwnerRemains(db, fatima, { role: 'master', active: false })).not.toThrow();

      // With a second active owner either may step down.
      await t.api('PATCH', `/api/employees/${other.employee.id}`, { role: 'owner' });
      expect(() => assertOwnerRemains(db, owner, { role: 'admin', active: true })).not.toThrow();
      expect((await t.api('PATCH', `/api/employees/${other.employee.id}`, { role: 'master' })).json().role).toBe('master');
      // An inactive owner does not count.
      await t.api('PATCH', `/api/employees/${other.employee.id}`, { role: 'owner', active: false });
      expect(() => assertOwnerRemains(db, owner, { role: 'admin', active: true })).toThrow('В студии должен остаться хотя бы один владелец');
    });
  });

  describe('appointments of a master', () => {
    it('creates appointments only for themselves', async () => {
      const own = await master.api('POST', '/api/appointments', {
        clientId: client.id,
        masterId: master.employee.id,
        title: 'Консультация',
        startsAt: '2026-10-16T12:00:00.000Z',
        endsAt: '2026-10-16T12:30:00.000Z',
      });
      expect(own.statusCode).toBe(200);
      expect(own.json().master.id).toBe(master.employee.id);
      expectForbidden(
        await master.api('POST', '/api/appointments', {
          clientId: client.id,
          masterId: other.employee.id,
          startsAt: '2026-10-16T14:00:00.000Z',
          endsAt: '2026-10-16T14:30:00.000Z',
        }),
        OWN_ONLY,
      );
      // A malformed body still fails validation.
      expect((await master.api('POST', '/api/appointments', { clientId: client.id })).statusCode).toBe(400);
      // Admins book for anyone.
      expect((await admin.api('POST', '/api/appointments', { clientId: client.id, masterId: other.employee.id, startsAt: '2026-10-16T15:00:00.000Z', endsAt: '2026-10-16T15:30:00.000Z' })).statusCode).toBe(200);
    });

    it('sees every appointment but changes only their own', async () => {
      const mine = await appointment(master.employee.id, 10);
      const theirs = await appointment(other.employee.id, 12);
      expect((await master.api('GET', `/api/appointments/${theirs.id}`)).statusCode).toBe(200);
      const list = await master.api('GET', '/api/appointments?from=2026-10-16T00:00:00.000Z&to=2026-10-17T00:00:00.000Z');
      expect(list.json().items.map((a: { id: number }) => a.id)).toEqual([mine.id, theirs.id]);

      const moved = await master.api('PATCH', `/api/appointments/${mine.id}`, { startsAt: '2026-10-16T11:00:00.000Z', endsAt: '2026-10-16T11:30:00.000Z' });
      expect(moved.statusCode).toBe(200);
      expectForbidden(await master.api('PATCH', `/api/appointments/${mine.id}`, { masterId: other.employee.id }), OWN_ONLY);
      expectForbidden(await master.api('PATCH', `/api/appointments/${theirs.id}`, { status: 'cancelled' }), OWN_ONLY);
      expectForbidden(await master.api('PATCH', `/api/appointments/${theirs.id}`, { masterId: master.employee.id }), OWN_ONLY);
      expect((await t.api('GET', `/api/appointments/${theirs.id}`)).json()).toMatchObject({ status: 'scheduled', master: { id: other.employee.id } });
      expect((await master.api('PATCH', '/api/appointments/999', { notes: 'x' })).statusCode).toBe(404);

      // Owner and admin change anyone's appointments, reassigning them too.
      const reassigned = await admin.api('PATCH', `/api/appointments/${theirs.id}`, { masterId: master.employee.id });
      expect(reassigned.json().master.id).toBe(master.employee.id);
      expect((await t.api('PATCH', `/api/appointments/${theirs.id}`, { status: 'confirmed' })).json().status).toBe('confirmed');
    });

    it('completes any appointment: completing a visit is a till action', async () => {
      const mine = await appointment(master.employee.id, 10);
      const theirs = await appointment(other.employee.id, 12);
      for (const id of [mine.id, theirs.id]) {
        const done = await master.api('POST', `/api/appointments/${id}/complete`, { sendAftercare: false });
        expect(done.statusCode).toBe(200);
        expect(done.json().appointment.status).toBe('completed');
      }
      expect((await t.api('GET', `/api/appointments/${theirs.id}`)).json().master.id).toBe(other.employee.id);
      expect((await master.api('POST', '/api/appointments/999/complete', { sendAftercare: false })).statusCode).toBe(404);
    });

    it('takes, refunds and retains prepayments only of their own appointments', async () => {
      const mine = await appointment(master.employee.id, 10, { depositRequired: 1000 });
      const theirs = await appointment(other.employee.id, 12, { depositRequired: 1000 });
      await t.api('POST', `/api/appointments/${theirs.id}/deposit`, { amount: 1000, method: 'card' });

      for (const [path, body] of [
        ['deposit', { amount: 500, method: 'card' }],
        ['deposit/refund', { amount: 100, method: 'card' }],
        ['deposit/retain', { amount: 100 }],
        ['deposit/qr', { delivery: 'screen' }],
        ['deposit/remind', {}],
      ] as const) {
        expectForbidden(await master.api('POST', `/api/appointments/${theirs.id}/${path}`, body), OWN_ONLY);
      }
      expect((await t.api('GET', `/api/appointments/${theirs.id}`)).json().deposit).toBe(1000);

      const received = await master.api('POST', `/api/appointments/${mine.id}/deposit`, { amount: 1000, method: 'transfer' });
      expect(received.statusCode).toBe(200);
      expect(received.json().deposit).toBe(1000);
      const refunded = await master.api('POST', `/api/appointments/${mine.id}/deposit/refund`, { amount: 400, method: 'transfer' });
      expect(refunded.json().deposit).toBe(600);
    });
  });
});
