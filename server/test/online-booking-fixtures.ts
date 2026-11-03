import type { InjectOptions } from 'fastify';
import { handleStaffCommand, handleStart } from '../src/bot/onboarding.js';
import { issueStaffCode } from '../src/bot/staff.js';
import { initDataHash } from '../src/lib/telegram-webapp.js';
import { make, type TestApp } from './helpers.js';

/** Shared setup of the online booking tests: studio time, the public API, Telegram chats and Mini App init data. */

export type Json = Record<string, any>;

export const NOW = Date.parse('2026-10-15T09:00:00.000Z'); // Thursday 12:00 Moscow
export const FRIDAY_NOON = '2026-10-16T09:00:00.000Z'; // Friday 12:00 Moscow
export const STAFF_CHAT = -100_555;
export const PUBLIC_URL = 'https://mikan.example';
export const BOT_TOKEN = '123456:test-token';
export const MIN = 60_000;

export const hhmm = (ms: number | string) =>
  new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' }).format(new Date(ms));

/** A request to `/api/public/booking…` without auth, optionally from another IP / with Mini App init data. */
export function pub(
  t: TestApp,
  method: InjectOptions['method'],
  path: string,
  payload?: unknown,
  opts: { ip?: string; initData?: string; idempotencyKey?: string } = {},
) {
  return t.app.inject({
    method,
    url: `/api/public/booking${path}`,
    headers: {
      ...(opts.ip ? { 'x-forwarded-for': opts.ip } : {}),
      ...(opts.initData !== undefined ? { 'x-telegram-init-data': opts.initData } : {}),
      ...(opts.idempotencyKey !== undefined ? { 'idempotency-key': opts.idempotencyKey } : {}),
    },
    ...(payload === undefined ? {} : { payload: payload as InjectOptions['payload'] }),
  });
}

export function bindStaffChat(t: TestApp): void {
  handleStaffCommand(t.ctx, STAFF_CHAT, issueStaffCode(t.ctx.db).code);
}

/** Links a client card to a Telegram chat through the card's deep link. */
export async function linkChat(t: TestApp, clientId: number, chatId: number): Promise<void> {
  const url = (await t.api('POST', `/api/clients/${clientId}/telegram-link`)).json().url as string;
  handleStart(t.ctx, { chatId, telegramName: 'Клиент', username: null }, new URL(url).searchParams.get('start')!);
}

export async function addMaster(t: TestApp, name: string, login: string): Promise<Json> {
  return make(t, '/api/employees', { name, login, password: 'secret123', isMaster: true });
}

export async function loginAs(t: TestApp, login: string): Promise<(method: InjectOptions['method'], url: string, payload?: unknown) => ReturnType<TestApp['app']['inject']>> {
  const res = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login, password: 'secret123' } });
  const token = res.json().token as string;
  return (method, url, payload) =>
    t.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload === undefined ? {} : { payload: payload as InjectOptions['payload'] }),
    });
}

/** Init data as Telegram signs it for the Mini App. */
export function initData(user: { id: number; first_name?: string; username?: string }, authDate = NOW, token = BOT_TOKEN): string {
  const params = new URLSearchParams({
    query_id: 'AAHdF6IQAAAAAN0XohDhrOrc',
    user: JSON.stringify({ first_name: 'Анна', ...user }),
    auth_date: String(Math.floor(authDate / 1000)),
  });
  params.set('hash', initDataHash(params, token));
  return params.toString();
}

export const auditEntries = async (t: TestApp, entityId: number) =>
  ((await t.api('GET', `/api/audit?entity=appointment&entityId=${entityId}`)).json().items as Json[]).reverse();
