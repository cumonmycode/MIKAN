import { eq } from 'drizzle-orm';
import type { InjectOptions } from 'fastify';
import { expect, vi } from 'vitest';
import { employees } from '../src/db/schema.js';
import { make, type TestApp } from './helpers.js';

/** Shared setup of the payroll tests: staff with roles, rules, visits and receipts through the API. */

export type Api = TestApp['api'];
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export const at = (iso: string) => vi.setSystemTime(Date.parse(iso));

export async function ok(api: Api, method: Method, url: string, body?: object) {
  const res = await api(method, url, body);
  if (res.statusCode !== 200) throw new Error(`${method} ${url} → ${res.statusCode}: ${res.body}`);
  return res.json();
}

export interface Staff {
  id: number;
  name: string;
  api: Api;
}

/** An employee with the given role, and an API client signed in as them. */
export async function staff(t: TestApp, name: string, login: string, role: 'owner' | 'admin' | 'master'): Promise<Staff> {
  const employee = await make(t, '/api/employees', { name, login, password: 'pass123', isMaster: role === 'master' });
  t.ctx.db.update(employees).set({ role }).where(eq(employees.id, employee.id)).run();
  const signIn = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login, password: 'pass123' } });
  const token = signIn.json<{ token: string }>().token;
  const api: Api = (method, url, payload) =>
    t.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload === undefined ? {} : { payload: payload as InjectOptions['payload'] }),
    });
  return { id: employee.id as number, name, api };
}

export const setRules = (t: TestApp, employeeId: number, body: object) => ok(t.api, 'PUT', `/api/employees/${employeeId}/pay-rules`, body);

/** A visit of the master starting at `startsAt` (UTC) with the given catalog services. */
export async function visit(t: TestApp, masterId: number, clientId: number, serviceIds: number[], startsAt: string, status?: string) {
  return make(t, '/api/appointments', {
    clientId,
    masterId,
    services: serviceIds.map((serviceId) => ({ serviceId })),
    startsAt,
    ...(status ? { status } : {}),
  });
}

type Item = { type: 'service'; serviceId: number } | { type: 'product'; productId: number; quantity?: number };

/** A receipt paid by card (refunds need no cash shift), optionally for an appointment. */
export async function pay(api: Api, items: Item[], total: number, opts: { appointmentId?: number; discount?: number } = {}) {
  return ok(api, 'POST', '/api/sales', {
    ...(opts.appointmentId ? { appointmentId: opts.appointmentId } : {}),
    items: items.map((i) => ({ quantity: 1, ...i })),
    discount: opts.discount ?? 0,
    payments: { card: total },
  });
}

export async function statement(api: Api, employeeId: number, from: string, to: string) {
  const res = await api('GET', `/api/payroll/${employeeId}?from=${from}&to=${to}`);
  expect(res.statusCode).toBe(200);
  return res.json();
}
