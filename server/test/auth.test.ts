import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, createTestApp, make, type TestApp } from './helpers.js';

describe('auth & employees', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(async () => {
    await t.close();
  });

  it('serves health without auth', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, version: '1.0.0' });
  });

  it('logs in with the seeded admin and returns the employee', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'ADMIN', password: ADMIN.password } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.token).toEqual(expect.any(String));
    expect(body.employee).toMatchObject({ id: 1, name: ADMIN.name, login: 'admin', active: true, isMaster: true, color: '#FF7A1A' });
    expect(body.employee.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(body.employee).not.toHaveProperty('passwordHash');
  });

  it('rejects bad credentials with the error envelope', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'admin', password: 'wrong-pass' } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: { code: 'unauthorized', message: 'Неверный логин или пароль' } });
  });

  it('validates the login body in Russian', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'admin' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toEqual({ code: 'validation_error', message: '«Пароль»: обязательное поле' });
  });

  it('guards endpoints and returns the current employee', async () => {
    const anon = await t.app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(anon.statusCode).toBe(401);
    expect(anon.json().error.code).toBe('unauthorized');
    const bogus = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: 'Bearer nope' } });
    expect(bogus.statusCode).toBe(401);
    const me = await t.api('GET', '/api/auth/me');
    expect(me.statusCode).toBe(200);
    expect(me.json().login).toBe('admin');
  });

  it('rejects the token of a deactivated employee', async () => {
    const anna = await make(t, '/api/employees', { name: 'Анна', login: 'Anna', password: 'pass123', isMaster: true, color: '#00aa00' });
    expect(anna).toMatchObject({ login: 'anna', color: '#00AA00', isMaster: true, phone: null });
    const login = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'anna', password: 'pass123' } });
    const annaToken = login.json().token as string;
    const ok = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${annaToken}` } });
    expect(ok.statusCode).toBe(200);

    const off = await t.api('PATCH', `/api/employees/${anna.id}`, { active: false });
    expect(off.json().active).toBe(false);
    const denied = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${annaToken}` } });
    expect(denied.statusCode).toBe(401);
    expect(denied.json().error.code).toBe('unauthorized');
    const relogin = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'anna', password: 'pass123' } });
    expect(relogin.statusCode).toBe(401);
  });

  it('manages employees: list filter, login conflict, self-deactivation, password change', async () => {
    await make(t, '/api/employees', { name: 'Борис', login: 'boris', password: 'pass123', isMaster: false, phone: '8 999 000 11 22' });
    const dup = await t.api('POST', '/api/employees', { name: 'Борис 2', login: 'BORIS', password: 'pass123', isMaster: false });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toEqual({ code: 'conflict', message: 'Логин «boris» уже занят' });

    const short = await t.api('POST', '/api/employees', { name: 'X', login: 'xx', password: '123', isMaster: false });
    expect(short.statusCode).toBe(400);

    const self = await t.api('PATCH', '/api/employees/1', { active: false });
    expect(self.statusCode).toBe(400);
    expect(self.json().error.message).toBe('Нельзя отключить собственную учётную запись');

    const list = await t.api('GET', '/api/employees');
    expect(list.json().items.map((e: { name: string }) => e.name)).toEqual(['Админ', 'Борис']);
    const boris = list.json().items[1];
    expect(boris.phone).toBe('+79990001122');
    expect(boris.color).toBe('#5E5CE6');

    await t.api('PATCH', `/api/employees/${boris.id}`, { password: 'newpass1', active: false });
    expect((await t.api('GET', '/api/employees')).json().items).toHaveLength(1);
    expect((await t.api('GET', '/api/employees?includeInactive=true')).json().items).toHaveLength(2);
    await t.api('PATCH', `/api/employees/${boris.id}`, { active: true });
    const relogin = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'boris', password: 'newpass1' } });
    expect(relogin.statusCode).toBe(200);

    const missing = await t.api('PATCH', '/api/employees/999', { name: 'Нет' });
    expect(missing.statusCode).toBe(404);
  });

  it('maps a concurrent duplicate login to 409, not 500 (review #6)', async () => {
    const payload = { name: 'Двойной', login: 'twin', password: 'pass123', isMaster: false };
    const [a, b] = await Promise.all([t.api('POST', '/api/employees', payload), t.api('POST', '/api/employees', payload)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    const loser = a.statusCode === 409 ? a : b;
    expect(loser.json().error.code).toBe('conflict');
  });

  it('revokes existing tokens on password change and deactivation (review #7)', async () => {
    const vera = await make(t, '/api/employees', { name: 'Вера', login: 'vera', password: 'pass123', isMaster: true });
    const loginAs = async (password: string) =>
      (await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'vera', password } })).json().token as string;
    const me = (token: string) => t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });

    const oldToken = await loginAs('pass123');
    expect((await me(oldToken)).statusCode).toBe(200);
    await t.api('PATCH', `/api/employees/${vera.id}`, { password: 'newpass9' });
    expect((await me(oldToken)).statusCode).toBe(401);
    const newToken = await loginAs('newpass9');
    expect((await me(newToken)).statusCode).toBe(200);

    // Renaming does not revoke; deactivation does, and reactivation does not resurrect old tokens.
    await t.api('PATCH', `/api/employees/${vera.id}`, { name: 'Вера П.' });
    expect((await me(newToken)).statusCode).toBe(200);
    await t.api('PATCH', `/api/employees/${vera.id}`, { active: false });
    await t.api('PATCH', `/api/employees/${vera.id}`, { active: true });
    expect((await me(newToken)).statusCode).toBe(401);
    expect((await me(await loginAs('newpass9'))).statusCode).toBe(200);
  });

  it('lists the administrator account only to the administrator', async () => {
    await make(t, '/api/employees', { name: 'Мира', login: 'mira', password: 'pass123', isMaster: true });
    const names = (res: { json: () => { items: { name: string }[] } }) => res.json().items.map((e) => e.name);
    expect(names(await t.api('GET', '/api/employees'))).toEqual([ADMIN.name, 'Мира']);

    const token = (await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'mira', password: 'pass123' } })).json()
      .token as string;
    const asMira = (url: string) => t.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
    expect(names(await asMira('/api/employees'))).toEqual(['Мира']);
    expect(names(await asMira('/api/employees?includeInactive=true'))).toEqual(['Мира']);
    expect(names(await asMira('/api/smm/studio/people'))).toEqual(['Мира']);
    expect(names(await t.api('GET', '/api/smm/studio/people'))).toEqual([ADMIN.name, 'Мира']);
  });

  it('rate-limits login to 10 attempts per minute per IP', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'admin', password: 'bad-pass' } });
      statuses.push(res.statusCode);
      if (i === 10) expect(res.json().error.code).toBe('rate_limited');
    }
    // The helper already used one attempt to log in.
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);
    expect(statuses.slice(0, 9).every((s) => s === 401)).toBe(true);
  });

  it('returns JSON 404 envelopes and tolerates empty JSON bodies', async () => {
    const res = await t.api('GET', '/api/nope');
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
    const empty = await t.app.inject({
      method: 'POST',
      url: '/api/bot/staff-code',
      headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/json' },
      payload: '',
    });
    expect(empty.statusCode).toBe(200);
    const broken = await t.app.inject({
      method: 'POST',
      url: '/api/clients',
      headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/json' },
      payload: '{"name":',
    });
    expect(broken.statusCode).toBe(400);
    expect(broken.json().error).toEqual({ code: 'validation_error', message: 'Некорректный JSON в теле запроса' });
  });
});
