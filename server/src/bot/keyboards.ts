import { Keyboard } from 'grammy';
import type { ReplyKeyboard } from './gateway.js';

export const BUTTONS = {
  services: '💉 Услуги и цены',
  jewelry: '💎 Украшения',
  booking: '📅 Записаться',
  aftercare: '🩹 Уход после процедуры',
  contact: '📱 Поделиться номером',
  cabinet: '👤 Мои записи и бонусы',
} as const;

/** Keyboard of a staff chat: quick questions to the staff-mode AI and the catalog. */
export const STAFF_BUTTONS = {
  today: '📋 Что сегодня',
  revenue: '📊 Выручка за неделю',
  low: '📦 Что заканчивается',
} as const;

/** The staff keyboard as plain rows: also sent through the gateway when a chat is bound from the app. */
export const STAFF_KEYBOARD: ReplyKeyboard = [
  [{ text: STAFF_BUTTONS.today }, { text: STAFF_BUTTONS.revenue }],
  [{ text: STAFF_BUTTONS.low }, { text: BUTTONS.jewelry }],
];

/** A resized, persistent grammY keyboard from plain rows. */
export function toGrammyKeyboard(rows: ReplyKeyboard): Keyboard {
  return Keyboard.from(rows.map((row) => row.map((b) => (b.requestContact ? Keyboard.requestContact(b.text) : Keyboard.text(b.text)))))
    .resized()
    .persistent();
}

export function staffKeyboard(): Keyboard {
  return toGrammyKeyboard(STAFF_KEYBOARD);
}

/** The only keyboard of a chat that has not shared its phone yet: nothing else works until it does. */
export const PHONE_KEYBOARD: ReplyKeyboard = [[{ text: BUTTONS.contact, requestContact: true }]];

/** Keyboard of a client chat; until the chat is linked to a client — only the button that shares the phone. */
export function mainKeyboard(linked: boolean): Keyboard {
  if (!linked) return toGrammyKeyboard(PHONE_KEYBOARD);
  return toGrammyKeyboard([
    [{ text: BUTTONS.services }, { text: BUTTONS.jewelry }],
    [{ text: BUTTONS.booking }, { text: BUTTONS.aftercare }],
    [{ text: BUTTONS.cabinet }],
  ]);
}
