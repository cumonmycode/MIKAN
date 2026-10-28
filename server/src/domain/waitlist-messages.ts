import { eq } from 'drizzle-orm';
import type { InlineKeyboard } from '../bot/gateway.js';
import { BUTTONS } from '../bot/keyboards.js';
import type { Config } from '../config.js';
import type { DbOrTx } from '../db/client.js';
import { waitlistEntries } from '../db/schema.js';
import { genitiveName } from '../lib/name-cases.js';
import { clientFullName, type ClientRow, type EmployeeRow } from '../lib/serialize.js';
import { toIso } from '../lib/time.js';
import { formatWhen } from './audit-text.js';
import { findClientByChat } from './clients.js';
import { BOOKING_MENU_TEXT, bookingPageUrl } from './online-booking-links.js';
import { CHANNEL_LABELS, type ClientMessage } from './online-booking-messages.js';
import { servicesByIds } from './refs.js';
import { getStudioSettings } from './settings.js';
import { datesLabel } from './work-schedule.js';
import { isOpenStatus, parseWaitlistItems, type WaitlistItem, type WaitlistRow } from './waitlist-store.js';

/** Texts and links of the waitlist (docs/API.md «Waitlist»): the staff chat, the client's chat, the bot deep link. */

/** Start parameter of `https://t.me/<bot>?start=w_<id>`. */
export const WAITLIST_START_PREFIX = 'w_';
export const WAITLIST_SHARE_TEXT =
  `Чтобы сообщение о свободном времени пришло сюда, нажмите «${BUTTONS.contact}» внизу 👇 Это нужно сделать один раз.`;

/** «Мочка, Соски — Два» */
export function wishWhat(db: DbOrTx, items: WaitlistItem[]): string {
  const services = servicesByIds(db, items.map((i) => i.serviceId));
  const names = items.map((i) => {
    const name = services.get(i.serviceId)?.name ?? 'Услуга';
    return i.variant ? `${name} — ${i.variant}` : name;
  });
  return names.join(', ') || 'услуга';
}

/** «21–25 октября», «30 октября – 3 ноября», «21 октября». */
export const wishDates = (row: Pick<WaitlistRow, 'dateFrom' | 'dateTo'>): string => datesLabel(row.dateFrom, row.dateTo);

/** «Мочка, 21–25 октября, мастер Фатима» */
export function wishSummary(db: DbOrTx, row: WaitlistRow, master: EmployeeRow | null): string {
  return `${wishWhat(db, parseWaitlistItems(row.items))}, ${wishDates(row)}${master ? `, мастер ${master.name}` : ''}`;
}

/** «⏳ Анна Иванова встал(а) в лист ожидания (сайт): Мочка, 21–25 октября, мастер Фатима» */
export function staffJoinedText(db: DbOrTx, row: WaitlistRow, client: ClientRow, master: EmployeeRow | null): string {
  const channel = CHANNEL_LABELS[row.channel] ?? row.channel;
  const head = `⏳ ${clientFullName(client)} встал(а) в лист ожидания (${channel}): ${wishSummary(db, row, master)}`;
  return row.note ? `${head}\nКомментарий: ${row.note}` : head;
}

/** `items` of the booking page and the public API: `serviceId[:encodeURIComponent(variant)]`, comma-separated. */
export const itemsParam = (items: WaitlistItem[]): string =>
  items.map((i) => (i.variant ? `${i.serviceId}:${encodeURIComponent(i.variant)}` : String(i.serviceId))).join(',');

/** `PUBLIC_URL/book?wait=<id>&start=<iso>&items=<items>&master=<id>` — the booking flow opened on the freed time. */
export function waitlistBookingUrl(config: Pick<Config, 'publicUrl'>, row: WaitlistRow, start: number): string | null {
  const page = bookingPageUrl(config);
  if (!page) return null;
  const query = new URLSearchParams({ wait: String(row.id), start: toIso(start), items: itemsParam(parseWaitlistItems(row.items)) });
  if (row.masterId != null) query.set('master', String(row.masterId));
  return `${page}?${query.toString()}`;
}

/** «Освободилось время: 21 октября, 15:00 у Фатимы — записаться?» with «📅 Записаться» opening the booking flow. */
export function freedTimeMessage(
  db: DbOrTx,
  config: Pick<Config, 'publicUrl'>,
  row: WaitlistRow,
  master: EmployeeRow,
  start: number,
  now = Date.now(),
): ClientMessage {
  const when = formatWhen(start, getStudioSettings(db).timezone, now);
  const whose = genitiveName(master.name);
  const at = whose ? `${when} у ${whose}` : `${when}, мастер ${master.name}`;
  const text =
    `Освободилось время: ${at} — записаться?\n` +
    `${wishWhat(db, parseWaitlistItems(row.items))} — вы в листе ожидания. Время достанется тому, кто запишется первым.`;
  const url = waitlistBookingUrl(config, row, start);
  if (!url) return { text };
  const keyboard: InlineKeyboard = url.startsWith('https://')
    ? [[{ text: BOOKING_MENU_TEXT, webApp: url }]]
    : [[{ text: BOOKING_MENU_TEXT, url }]];
  return { text, keyboard };
}

/** «Получить сообщение в Telegram» on the booking page: `https://t.me/<bot>?start=w_<id>`. */
export function waitlistTelegramLink(botUsername: string | null, id: number): string | null {
  return botUsername ? `https://t.me/${botUsername}?start=${WAITLIST_START_PREFIX}${id}` : null;
}

/**
 * `/start w_<id>`: the entry only for a chat linked to its client — the link proves nothing about who opens it. An
 * unlinked chat is asked to share its phone (the greeting adds the hint), which links it to the card with that phone.
 */
export function waitlistStartText(db: DbOrTx, chatId: number, payload: string): string {
  const id = Number(payload);
  const row = Number.isSafeInteger(id) && id > 0 ? db.select().from(waitlistEntries).where(eq(waitlistEntries.id, id)).get() : undefined;
  const linked = findClientByChat(db, chatId);
  if (!linked) return 'Чтобы получить сообщение о свободном времени, поделитесь номером — так я найду вашу заявку.';
  if (!row || row.clientId !== linked.id) {
    return 'Не нашёл эту заявку листа ожидания среди ваших — возможно, она оформлена на другой номер телефона.';
  }
  if (!isOpenStatus(row.status)) return `${linked.name}, эта заявка листа ожидания уже закрыта.`;
  return (
    `${linked.name}, вы в листе ожидания ✅ ${wishWhat(db, parseWaitlistItems(row.items))}, ${wishDates(row)}. ` +
    'Напишу сюда, как только освободится время.'
  );
}
