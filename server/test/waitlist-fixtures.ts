import { createTestApp, make, type TestApp } from './helpers.js';
import { addMaster, bindStaffChat, linkChat, NOW, PUBLIC_URL, type Json } from './online-booking-fixtures.js';

/** Shared setup of the waitlist tests: a studio with services, a master and clients (NOW: Thursday 15 October, 12:00). */

export interface WaitlistWorld {
  t: TestApp;
  lobe: Json;
  nipple: Json;
  tattoo: Json;
  fatima: Json;
  anna: Json;
}

export const ANNA_CHAT = 840_001;

export async function waitlistWorld(env: Record<string, string> = { PUBLIC_URL }): Promise<WaitlistWorld> {
  const t = await createTestApp({ env });
  bindStaffChat(t);
  const lobe = await make(t, '/api/services', { name: 'Мочка', category: 'piercing', price: 1600, durationMin: 30 });
  const nipple = await make(t, '/api/services', {
    name: 'Соски',
    category: 'piercing',
    price: 2500,
    durationMin: 45,
    variants: [
      { name: 'Один', price: 2500, durationMin: null },
      { name: 'Два', price: 4000, durationMin: 60 },
    ],
  });
  const tattoo = await make(t, '/api/services', { name: 'Тату', category: 'tattoo', price: 15000, durationMin: 180 });
  const fatima = await addMaster(t, 'Фатима', 'fatima');
  const anna = await make(t, '/api/clients', { name: 'Анна', lastName: 'Иванова', phone: '+79991234567' });
  t.gateway.sent = [];
  return { t, lobe, nipple, tattoo, fatima, anna };
}

/** A client with a linked Telegram chat. */
export async function linkedClient(t: TestApp, name: string, phone: string, chatId: number): Promise<Json> {
  const client = await make(t, '/api/clients', { name, phone });
  await linkChat(t, client.id, chatId);
  t.gateway.sent = [];
  return client;
}

/** `POST /api/waitlist`, returning the response. */
export function addEntry(t: TestApp, body: Record<string, unknown>) {
  return t.api('POST', '/api/waitlist', body);
}

/** «2026-10-16T12:00» Moscow → instant ISO. */
export const msk = (local: string): string => new Date(`${local}:00+03:00`).toISOString();

export { NOW };
