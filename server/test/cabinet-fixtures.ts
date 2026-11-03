import type { InjectOptions } from 'fastify';
import { make, type TestApp } from './helpers.js';
import { addMaster, initData, linkChat, type Json } from './online-booking-fixtures.js';

/** Shared setup of the client cabinet tests: the cabinet API as the Mini App or the website calls it. */

export const ANNA_CHAT = 770_001;
export const SIGN_IN = { error: { code: 'unauthorized', message: 'Войдите через Telegram-бота студии' } };
export const DAY = 24 * 60 * 60_000;

export interface Who {
  initData?: string;
  token?: string;
  ip?: string;
}

/** A request to `/api/public/cabinet…` without staff auth. */
export function cab(t: TestApp, method: InjectOptions['method'], path: string, payload?: unknown, who: Who = {}) {
  return t.app.inject({
    method,
    url: `/api/public/cabinet${path}`,
    headers: {
      ...(who.ip ? { 'x-forwarded-for': who.ip } : {}),
      ...(who.initData !== undefined ? { 'x-telegram-init-data': who.initData } : {}),
      ...(who.token !== undefined ? { 'x-client-token': who.token } : {}),
    },
    ...(payload === undefined ? {} : { payload: payload as InjectOptions['payload'] }),
  });
}

/** The Mini App of the chat (init data signed now). */
export const miniApp = (chatId = ANNA_CHAT, now = Date.now()): Who => ({ initData: initData({ id: chatId }, now) });

export interface CabinetWorld {
  anna: Json;
  boris: Json;
  lobe: Json;
  nipple: Json;
  fatima: Json;
}

/** Anna (linked to ANNA_CHAT), Boris (another client), a 30-min lobe, a nipple with a 1 000 ₽ prepayment, master Fatima. */
export async function cabinetWorld(t: TestApp): Promise<CabinetWorld> {
  const lobe = await make(t, '/api/services', { name: 'Мочка', category: 'piercing', price: 1600, durationMin: 30 });
  const nipple = await make(t, '/api/services', { name: 'Соски', category: 'piercing', price: 2500, durationMin: 60, depositAmount: 1000 });
  const fatima = await addMaster(t, 'Фатима', 'fatima');
  const anna = await make(t, '/api/clients', { name: 'Анна', lastName: 'Иванова', phone: '+79991234501' });
  const boris = await make(t, '/api/clients', { name: 'Борис', phone: '+79991234502' });
  await linkChat(t, anna.id, ANNA_CHAT);
  return { anna, boris, lobe, nipple, fatima };
}

/** An appointment made by staff. */
export async function appointment(t: TestApp, body: Json): Promise<Json> {
  return make(t, '/api/appointments', body);
}
