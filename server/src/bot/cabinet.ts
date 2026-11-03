import type Anthropic from '@anthropic-ai/sdk';
import type { AppContext } from '../context.js';
import { chatEmployee, findChat, storeMessage } from '../domain/bot-chats.js';
import { CABINET_TOKEN_DAYS, cabinetSignInUrl, cabinetUrl, issueCabinetToken } from '../domain/cabinet-access.js';
import { findClientByChat } from '../domain/clients.js';
import { getStudioSettings } from '../domain/settings.js';
import { errorMessage } from '../lib/errors.js';
import type { InlineKeyboard, ReplyKeyboard } from './gateway.js';
import { BUTTONS, PHONE_KEYBOARD } from './keyboards.js';
import type { ToolHandler, ToolScope, ToolSink } from './tools.js';

/**
 * «👤 Мои записи и бонусы» (docs/API.md «Client cabinet»): the keyboard button, `/me`, `/start me` (the website's
 * «Получить ссылку» opens it) and the AI's `cabinet_link` answer with the sign-in buttons — «👤 Открыть кабинет» opens
 * the cabinet as a Mini App (the client is known by the chat; needs an `https://` `PUBLIC_URL`), «🌐 Открыть в
 * браузере» is the website link `PUBLIC_URL/book/me?t=<token>` (a new token each time, valid 30 days). The token is
 * only in the button, never in the stored chat history.
 */

/** `/start me`: sends the sign-in buttons after the greeting. */
export const CABINET_START_PAYLOAD = 'me';
export const CABINET_OPEN_BUTTON = '👤 Открыть кабинет';
export const CABINET_BROWSER_BUTTON = '🌐 Открыть в браузере';
export const CABINET_NEEDS_PHONE =
  `Чтобы открыть личный кабинет, нажмите «${BUTTONS.contact}» внизу 👇 Так я найду ваши записи и бонусы. Это нужно сделать один раз.`;
export const CABINET_FOR_CLIENTS = 'Личный кабинет — для клиентов студии. Все записи и клиенты есть в приложении MIKAN.';
export const CABINET_UNAVAILABLE = 'Личный кабинет пока недоступен — спросите здесь, я подскажу по записям и бонусам 🙂';

export interface CabinetMessage {
  text: string;
  keyboard?: InlineKeyboard;
  replyKeyboard?: ReplyKeyboard;
}

export const isCabinetStart = (payload: string): boolean => payload.trim() === CABINET_START_PAYLOAD;

export function cabinetText(studioName: string): string {
  return (
    `👤 Личный кабинет ${studioName}: ваши записи (можно перенести или отменить), бонусы, памятки по уходу и сертификаты.\n\n` +
    `«${CABINET_BROWSER_BUTTON}» — вход на сайте без Telegram: ссылка действует ${CABINET_TOKEN_DAYS} дней, не пересылайте её никому.`
  );
}

/** What the chat gets: the sign-in buttons for a linked client, else why not (an unlinked chat shares its phone). */
export function cabinetMessage(ctx: AppContext, chatId: number, now = Date.now()): CabinetMessage {
  const { db } = ctx;
  const client = findClientByChat(db, chatId);
  if (!client) {
    return chatEmployee(db, findChat(db, chatId)) ? { text: CABINET_FOR_CLIENTS } : { text: CABINET_NEEDS_PHONE, replyKeyboard: PHONE_KEYBOARD };
  }
  const page = cabinetUrl(ctx.config);
  if (!page) return { text: CABINET_UNAVAILABLE };
  const { token } = issueCabinetToken(db, client.id, now);
  const keyboard: InlineKeyboard = [];
  if (page.startsWith('https://')) keyboard.push([{ text: CABINET_OPEN_BUTTON, webApp: page }]);
  keyboard.push([{ text: CABINET_BROWSER_BUTTON, url: cabinetSignInUrl(ctx.config, token)! }]);
  return { text: cabinetText(getStudioSettings(db).name), keyboard };
}

/** Sends the cabinet message and keeps its text (without the link) in the chat; a failure is only logged. */
export async function sendCabinetLink(ctx: AppContext, chatId: number): Promise<void> {
  const message = cabinetMessage(ctx, chatId);
  try {
    await ctx.gateway.sendText(chatId, message.text, { keyboard: message.keyboard, replyKeyboard: message.replyKeyboard });
    storeMessage(ctx.db, chatId, 'assistant', message.text);
  } catch (err) {
    ctx.log.warn({ chatId, err: errorMessage(err) }, 'cabinet link not sent');
  }
}

export const CABINET_LINK_TOOL: Anthropic.Tool = {
  name: 'cabinet_link',
  description:
    'Отправляет клиенту кнопки входа в личный кабинет студии: все его записи (перенести или отменить самому), история ' +
    'визитов, бонусы и их история, памятки по уходу, подарочные сертификаты. Вызывай, когда клиент просит личный ' +
    'кабинет или хочет сам посмотреть свои записи, бонусы или историю визитов. Кнопки придут сразу после твоего ответа — ' +
    'не пиши ссылок сам. Работает для клиента, который поделился номером.',
  input_schema: { type: 'object', properties: {} },
};

const NOT_IDENTIFIED =
  'Клиент не идентифицирован, поэтому кабинет открыть нельзя. Попроси поделиться номером кнопкой «📱 Поделиться номером» ' +
  'внизу чата — после этого кнопка «👤 Мои записи и бонусы» откроет кабинет.';

export function buildCabinetToolHandler(ctx: AppContext, scope: ToolScope, sink: ToolSink): ToolHandler {
  return async () => {
    const linked = scope.chatId !== null && findClientByChat(ctx.db, scope.chatId) !== null;
    if (!linked) return { content: NOT_IDENTIFIED };
    if (!cabinetUrl(ctx.config)) return { content: 'Личный кабинет у студии пока не настроен — ответь на вопрос клиента сам или передай администратору.' };
    if (scope.mode === 'test') {
      sink.notes.push('отправлены бы кнопки входа в личный кабинет');
      return { content: 'Тестовый режим: кнопки входа в личный кабинет придут клиенту после твоего ответа.' };
    }
    const chatId = scope.chatId!;
    if (!sink.done.has('cabinet')) sink.after.push(() => sendCabinetLink(ctx, chatId));
    sink.done.add('cabinet');
    return { content: 'Кнопки входа в личный кабинет придут клиенту сразу после твоего ответа. Коротко скажи, что там можно посмотреть.' };
  };
}
