import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditLog, authSessions } from '../src/db/schema.js';
import { ADMIN, createTestApp, make, type TestApp } from './helpers.js';

const NOW = Date.parse('2026-10-15T09:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const ENDED = 'Сессия завершена — войдите снова';
const OWNER_ONLY = 'Это доступно владельцу студии';
const PHONE = 'iPhone 16 Pro · MIKAN 13';

interface SessionOut {
  id: number;
  employee: { id: number; name: string; color: string };
  device: string | null;
  ip: string | null;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

describe('sign-in sessions', () => {
  let t: TestApp;
  let master: { id: number };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    t = await createTestApp();
    master = await make(t, '/api/employees', { name: 'Анна', login: 'anna', password: 'pass123', isMaster: true, role: 'master' });
  });
  afterEach(async () => {
    await t.close();
    vi.useRealTimers();
  });

  async function login(loginName: string, password: string, headers: Record<string, string> = {}): Promise<string> {
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: loginName, password }, headers });
    expect(res.statusCode).toBe(200);
    return res.json<{ token: string }>().token;
  }
  const as = (token: string, method: 'GET' | 'POST' | 'DELETE' | 'PATCH', url: string, payload?: Record<string, unknown>) =>
    t.app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
  const sessions = async (token: string, query = ''): Promise<SessionOut[]> => {
    const res = await as(token, 'GET', `/api/auth/sessions${query}`);
    expect(res.statusCode).toBe(200);
    return res.json<{ items: SessionOut[] }>().items;
  };
  const sidOf = (token: string): unknown => t.app.jwt.decode<{ sid?: unknown }>(token)?.sid;
  const row = (id: number) => t.ctx.db.select().from(authSessions).where(eq(authSessions.id, id)).get();

  describe('login', () => {
    it('opens a session for the device and signs its id into the token', async () => {
      const token = await login('anna', 'pass123', { 'x-device': PHONE });
      const sid = sidOf(token);
      expect(sid).toEqual(expect.any(Number));

      const items = await sessions(token);
      expect(items).toEqual([
        {
          id: sid,
          employee: { id: master.id, name: 'Анна', color: expect.any(String) },
          device: PHONE,
          ip: '127.0.0.1',
          createdAt: '2026-10-15T09:00:00.000Z',
          lastSeenAt: '2026-10-15T09:00:00.000Z',
          current: true,
        },
      ]);
    });

    it('names the device by the user agent without X-Device, and reads UTF-8 header bytes', async () => {
      const byAgent = await login('anna', 'pass123', { 'user-agent': 'MIKAN/12 CFNetwork/3826 Darwin/25.0.0' });
      expect(row(sidOf(byAgent) as number)?.device).toBe('MIKAN/12 CFNetwork/3826 Darwin/25.0.0');

      // «·» sent as UTF-8 arrives as the two Latin-1 characters «Â·».
      const utf8 = await login('anna', 'pass123', { 'x-device': Buffer.from(PHONE, 'utf8').toString('latin1') });
      expect(row(sidOf(utf8) as number)?.device).toBe(PHONE);

      const long = await login('anna', 'pass123', { 'x-device': `  ${'x'.repeat(300)}  ` });
      expect(row(sidOf(long) as number)?.device).toHaveLength(200);
    });

    it('is still not logged in the audit log', async () => {
      const before = t.ctx.db.select().from(auditLog).all().length;
      await login('anna', 'pass123', { 'x-device': PHONE });
      expect(t.ctx.db.select().from(auditLog).all()).toHaveLength(before);
    });
  });

  describe('authenticate', () => {
    it('rejects the token of an ended session; other devices keep working', async () => {
      const phone = await login('anna', 'pass123', { 'x-device': PHONE });
      const tablet = await login('anna', 'pass123', { 'x-device': 'iPad · MIKAN 13' });

      const out = await as(phone, 'POST', '/api/auth/logout');
      expect(out.statusCode).toBe(204);
      const denied = await as(phone, 'GET', '/api/auth/me');
      expect(denied.statusCode).toBe(401);
      expect(denied.json().error).toEqual({ code: 'unauthorized', message: ENDED });
      expect((await as(tablet, 'GET', '/api/auth/me')).statusCode).toBe(200);
    });

    it('keeps tokens issued before sessions (no sid) working until the password changes', async () => {
      const legacy = t.app.jwt.sign({ sub: String(master.id), tv: 0 });
      expect((await as(legacy, 'GET', '/api/auth/me')).json().login).toBe('anna');
      const listed = await sessions(legacy);
      expect(listed.every((s) => !s.current)).toBe(true);
      // Signing out of an old token has no session to end.
      expect((await as(legacy, 'POST', '/api/auth/logout')).statusCode).toBe(204);
      expect((await as(legacy, 'GET', '/api/auth/me')).statusCode).toBe(200);

      await t.api('PATCH', `/api/employees/${master.id}`, { password: 'newpass9' });
      expect((await as(legacy, 'GET', '/api/auth/me')).statusCode).toBe(401);
    });

    it('rejects a session id that is unknown or belongs to someone else', async () => {
      const unknown = t.app.jwt.sign({ sub: String(master.id), tv: 0, sid: 999 } as never);
      expect((await as(unknown, 'GET', '/api/auth/me')).json().error.message).toBe(ENDED);
      const adminSid = sidOf(t.token) as number;
      const borrowed = t.app.jwt.sign({ sub: String(master.id), tv: 0, sid: adminSid } as never);
      expect((await as(borrowed, 'GET', '/api/auth/me')).statusCode).toBe(401);
      const malformed = t.app.jwt.sign({ sub: String(master.id), tv: 0, sid: 'one' } as never);
      expect((await as(malformed, 'GET', '/api/auth/me')).statusCode).toBe(401);
    });

    it('updates lastSeenAt at most once a minute', async () => {
      const token = await login('anna', 'pass123');
      const sid = sidOf(token) as number;

      vi.setSystemTime(NOW + 30_000);
      await as(token, 'GET', '/api/auth/me');
      expect(row(sid)?.lastSeenAt).toBe(NOW);

      vi.setSystemTime(NOW + 61_000);
      await as(token, 'GET', '/api/auth/me');
      expect(row(sid)?.lastSeenAt).toBe(NOW + 61_000);

      vi.setSystemTime(NOW + 90_000);
      await as(token, 'GET', '/api/auth/me');
      expect(row(sid)?.lastSeenAt).toBe(NOW + 61_000);
      expect((await sessions(token))[0]?.lastSeenAt).toBe(new Date(NOW + 61_000).toISOString());
    });

    it('ends a session unused for 90 days', async () => {
      const recent = await login('anna', 'pass123', { 'x-device': 'recent' });
      const idle = await login('anna', 'pass123', { 'x-device': 'idle' });
      t.ctx.db.update(authSessions).set({ lastSeenAt: NOW - 89 * DAY }).where(eq(authSessions.id, sidOf(recent) as number)).run();
      t.ctx.db.update(authSessions).set({ lastSeenAt: NOW - 91 * DAY }).where(eq(authSessions.id, sidOf(idle) as number)).run();

      // Not listed even before it is used again.
      expect((await sessions(t.token, `?employeeId=${master.id}`)).map((s) => s.device)).toEqual(['recent']);
      const denied = await as(idle, 'GET', '/api/auth/me');
      expect(denied.statusCode).toBe(401);
      expect(denied.json().error.message).toBe(ENDED);
      expect(row(sidOf(idle) as number)?.revokedAt).toBe(NOW);
      expect((await as(recent, 'GET', '/api/auth/me')).statusCode).toBe(200);
    });

    it('a password change or deactivation ends all of the employee’s sessions', async () => {
      const first = await login('anna', 'pass123');
      const second = await login('anna', 'pass123');
      await t.api('PATCH', `/api/employees/${master.id}`, { password: 'newpass9' });
      for (const token of [first, second]) expect(row(sidOf(token) as number)?.revokedAt).toBe(NOW);

      const third = await login('anna', 'newpass9');
      await t.api('PATCH', `/api/employees/${master.id}`, { name: 'Анна П.' });
      expect(row(sidOf(third) as number)?.revokedAt).toBeNull();
      await t.api('PATCH', `/api/employees/${master.id}`, { active: false });
      expect(row(sidOf(third) as number)?.revokedAt).toBe(NOW);
      await t.api('PATCH', `/api/employees/${master.id}`, { active: true });
      expect(await sessions(t.token, `?employeeId=${master.id}`)).toEqual([]);
      // The owner's own session is untouched.
      expect(row(sidOf(t.token) as number)?.revokedAt).toBeNull();
    });
  });

  describe('GET /auth/sessions', () => {
    it('lists the employee’s own active sessions, most recent first', async () => {
      const old = await login('anna', 'pass123', { 'x-device': 'old' });
      vi.setSystemTime(NOW + 5 * 60_000);
      const fresh = await login('anna', 'pass123', { 'x-device': 'fresh' });
      const ended = await login('anna', 'pass123', { 'x-device': 'ended' });
      await as(ended, 'POST', '/api/auth/logout');

      const items = await sessions(old);
      expect(items.map((s) => [s.device, s.current])).toEqual([
        ['fresh', false],
        ['old', true],
      ]);
      expect(items.every((s) => s.employee.id === master.id)).toBe(true);
      expect((await sessions(fresh))[0]?.current).toBe(true);
    });

    it('gives the owner everyone’s sessions, filtered by ?employeeId=', async () => {
      await login('anna', 'pass123', { 'x-device': PHONE });
      const all = await sessions(t.token);
      expect(all.map((s) => s.employee.name).sort()).toEqual([ADMIN.name, 'Анна'].sort());
      expect(all.find((s) => s.employee.name === ADMIN.name)?.current).toBe(true);

      const filtered = await sessions(t.token, `?employeeId=${master.id}`);
      expect(filtered.map((s) => s.device)).toEqual([PHONE]);
      expect((await t.api('GET', '/api/auth/sessions?employeeId=abc')).statusCode).toBe(400);
    });

    it('forbids someone else’s sessions to anyone but the owner', async () => {
      const token = await login('anna', 'pass123');
      expect((await sessions(token, `?employeeId=${master.id}`)).length).toBe(1);
      const res = await as(token, 'GET', '/api/auth/sessions?employeeId=1');
      expect(res.statusCode).toBe(403);
      expect(res.json().error.message).toBe(OWNER_ONLY);
    });
  });

  describe('DELETE /auth/sessions/:id', () => {
    it('ends your own session on another device', async () => {
      const phone = await login('anna', 'pass123', { 'x-device': PHONE });
      const tablet = await login('anna', 'pass123', { 'x-device': 'iPad' });
      const res = await as(phone, 'DELETE', `/api/auth/sessions/${sidOf(tablet)}`);
      expect(res.statusCode).toBe(204);
      expect((await as(tablet, 'GET', '/api/auth/me')).json().error.message).toBe(ENDED);
      expect((await sessions(phone)).map((s) => s.device)).toEqual([PHONE]);
      // Ending it again changes nothing.
      expect((await as(phone, 'DELETE', `/api/auth/sessions/${sidOf(tablet)}`)).statusCode).toBe(204);
    });

    it('lets the owner end anyone’s session; others get 403', async () => {
      const anna = await login('anna', 'pass123', { 'x-device': PHONE });
      const forbidden = await as(anna, 'DELETE', `/api/auth/sessions/${sidOf(t.token)}`);
      expect(forbidden.statusCode).toBe(403);
      expect(forbidden.json().error.message).toBe(OWNER_ONLY);
      expect(row(sidOf(t.token) as number)?.revokedAt).toBeNull();

      expect((await t.api('DELETE', `/api/auth/sessions/${sidOf(anna)}`)).statusCode).toBe(204);
      expect((await as(anna, 'GET', '/api/auth/me')).statusCode).toBe(401);
      expect((await t.api('DELETE', '/api/auth/sessions/999')).statusCode).toBe(404);
      expect((await t.api('DELETE', '/api/auth/sessions/abc')).statusCode).toBe(400);
    });
  });

  describe('audit log', () => {
    const entries = () =>
      t.ctx.db
        .select()
        .from(auditLog)
        .all()
        .filter((e) => e.action !== 'employee.create')
        .map((e) => ({ action: e.action, entity: e.entity, entityId: e.entityId, employeeId: e.employeeId, summary: e.summary }));

    it('records signing out and ending a session with the device', async () => {
      const anna = await login('anna', 'pass123', { 'x-device': PHONE });
      const tablet = await login('anna', 'pass123', { 'x-device': 'iPad · MIKAN 13' });
      await as(anna, 'POST', '/api/auth/logout');
      await t.api('DELETE', `/api/auth/sessions/${sidOf(tablet)}`);
      const legacy = t.app.jwt.sign({ sub: String(master.id), tv: 0 });
      await as(legacy, 'POST', '/api/auth/logout');

      expect(entries()).toEqual([
        {
          action: 'employee.logout',
          entity: 'employee',
          entityId: master.id,
          employeeId: master.id,
          summary: `Выход из приложения на устройстве «${PHONE}»`,
        },
        {
          action: 'employee.session_end',
          entity: 'employee',
          entityId: master.id,
          employeeId: 1,
          summary: 'Сессия «Анна» на устройстве «iPad · MIKAN 13» завершена',
        },
        { action: 'employee.logout', entity: 'employee', entityId: null, employeeId: master.id, summary: 'Выход из приложения' },
      ]);
    });

    it('logs nothing for a refused session end', async () => {
      const anna = await login('anna', 'pass123');
      await as(anna, 'DELETE', `/api/auth/sessions/${sidOf(t.token)}`);
      await t.api('DELETE', '/api/auth/sessions/999');
      expect(entries()).toEqual([]);
    });
  });
});
