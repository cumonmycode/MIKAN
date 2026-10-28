import { and, desc, eq, inArray } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import type { DbOrTx } from '../db/client.js';
import { botMessages } from '../db/schema.js';
import { chatEmployee, findChat, storeMessage } from '../domain/bot-chats.js';
import { auditBirthdayGiven, fillBirthday, markBirthdayAsked } from '../domain/client-birthday.js';
import { findClientByChat } from '../domain/clients.js';
import { studioTimezone } from '../domain/settings.js';
import { parseBirthdayReply } from '../lib/birthday.js';
import { errorMessage } from '../lib/errors.js';
import { DAY_MS, localDate } from '../lib/time.js';
import { encodeCallback } from './callback-data.js';
import type { CallbackAnswer, CallbackDeps, CallbackQueryInput } from './callbacks.js';
import type { InlineKeyboard } from './gateway.js';
import { BUTTONS } from './keyboards.js';
import type { IncomingFrom } from './pipeline.js';

/**
 * The bot asks a client for the birthday once, right after the chat shares its phone or links a card (docs/API.md
 * «Collecting birthdays»). The question is open while it is the newest thing in the chat — nothing from the client,
 * staff or the AI since — for at most a few days; then the client's next message is read as the answer. A date is saved, a
 * garbled one gets one gentle retry, a refusal or the second miss closes it; anything that is clearly not a date goes to
 * the usual pipeline (and closes the question, as every client message does).
 */

export const BIRTHDAY_SKIP_BUTTON = 'Пропустить';

export const BIRTHDAY_TEXTS = {
  ask: 'Подскажите дату рождения — в этот день пришлём подарок 🎁',
  retry: 'Не получилось разобрать дату 🙈 Напишите, пожалуйста, так: 12.04.1995 или 12 апреля — год можно не указывать.',
  thanks: 'Записал! В этот день будет подарок 🎁',
  skipped: `Хорошо! Если захотите, дату рождения можно добавить позже в «${BUTTONS.cabinet}» 🙂`,
  giveUp: `Ничего страшного 🙂 Дату рождения можно добавить позже в «${BUTTONS.cabinet}».`,
} as const;

/** After this long without an answer the question is over: a later message is an ordinary one. */
export const BIRTHDAY_ANSWER_WINDOW_MS = 3 * DAY_MS;

const QUESTIONS: readonly string[] = [BIRTHDAY_TEXTS.ask, BIRTHDAY_TEXTS.retry];

const skipKeyboard = (): InlineKeyboard => [[{ text: BIRTHDAY_SKIP_BUTTON, data: encodeCallback({ kind: 'birthdaySkip' }) }]];

/** Sends the question (or the retry) with «Пропустить» and stores it; false when Telegram refused it. */
async function sendQuestion(ctx: AppContext, chatId: number, text: string): Promise<boolean> {
  try {
    await ctx.gateway.sendText(chatId, text, { keyboard: skipKeyboard() });
    storeMessage(ctx.db, chatId, 'assistant', text);
    return true;
  } catch (err) {
    ctx.log.warn({ chatId, err: errorMessage(err) }, 'birthday question not sent');
    return false;
  }
}

/**
 * Asks the client of this chat for the birthday — once ever: only a client chat (not a staff one) whose card has no
 * birthday and was never asked, and that the bot may send greetings to (bot messages on, news not refused — else the
 * promised gift never comes). `birthdayAskedAt` is set before sending, so it is never asked twice; a question Telegram
 * refused does not count.
 */
export async function askBirthday(ctx: AppContext, chatId: number, now = Date.now()): Promise<boolean> {
  const { db } = ctx;
  if (chatEmployee(db, findChat(db, chatId))) return false;
  const client = findClientByChat(db, chatId);
  if (!client || client.birthday || client.birthdayAskedAt != null || client.archived) return false;
  if (!client.botEnabled || client.marketingOptOut) return false;
  markBirthdayAsked(db, client.id, now);
  const sent = await sendQuestion(ctx, chatId, BIRTHDAY_TEXTS.ask);
  if (!sent) markBirthdayAsked(db, client.id, null);
  return sent;
}

/**
 * The open question of this chat (`retried` — the retry was sent), or null: the newest message from the client, staff
 * or the bot's replies (not `system` notices) must be the question, at most BIRTHDAY_ANSWER_WINDOW_MS old.
 */
function openQuestion(db: DbOrTx, chatId: number, now: number): { retried: boolean } | null {
  const last = db
    .select({ role: botMessages.role, text: botMessages.text, createdAt: botMessages.createdAt })
    .from(botMessages)
    .where(and(eq(botMessages.chatId, chatId), inArray(botMessages.role, ['user', 'staff', 'assistant'])))
    .orderBy(desc(botMessages.id))
    .limit(1)
    .get();
  const asked = last?.role === 'assistant' && QUESTIONS.includes(last.text);
  if (!last || !asked || now - last.createdAt > BIRTHDAY_ANSWER_WINDOW_MS) return null;
  return { retried: last.text === BIRTHDAY_TEXTS.retry };
}

/**
 * A client's text while the question is open: true when it was the answer (saved, retried, skipped — and replied to),
 * false when it is something else and goes to the usual pipeline.
 */
export async function answerBirthdayQuestion(deps: CallbackDeps, from: IncomingFrom, text: string, now = Date.now()): Promise<boolean> {
  const { ctx, pipeline } = deps;
  const { db } = ctx;
  const question = openQuestion(db, from.chatId, now);
  if (!question || chatEmployee(db, findChat(db, from.chatId))) return false;
  const client = findClientByChat(db, from.chatId);
  if (!client || client.birthday) return false;
  const reply = parseBirthdayReply(text, localDate(now, studioTimezone(db)));
  switch (reply.kind) {
    case 'other':
      return false;
    case 'date': {
      const saved = fillBirthday(db, client.id, reply.birthday, now);
      if (saved) auditBirthdayGiven(ctx, saved, 'bot');
      await pipeline.receiveHandled(from, text, BIRTHDAY_TEXTS.thanks);
      return true;
    }
    case 'skip':
      await pipeline.receiveHandled(from, text, BIRTHDAY_TEXTS.skipped);
      return true;
    case 'invalid':
      if (question.retried) await pipeline.receiveHandled(from, text, BIRTHDAY_TEXTS.giveUp);
      else await pipeline.receiveHandled(from, text, () => sendQuestion(ctx, from.chatId, BIRTHDAY_TEXTS.retry));
      return true;
  }
}

/** «Пропустить» under the question: the button goes away; while the question is open the bot says it is fine. */
export async function birthdaySkipButton(deps: CallbackDeps, query: CallbackQueryInput): Promise<CallbackAnswer> {
  const { ctx, pipeline } = deps;
  const chatId = query.from.chatId;
  if (query.message) await ctx.gateway.editKeyboard(chatId, query.message.messageId, null).catch(() => undefined);
  if (findClientByChat(ctx.db, chatId)?.birthday) return { text: 'Дата рождения уже сохранена 🎁' };
  if (openQuestion(ctx.db, chatId, Date.now())) {
    await pipeline.receiveHandled(query.from, `[Кнопка] ${BIRTHDAY_SKIP_BUTTON}`, BIRTHDAY_TEXTS.skipped);
  }
  return { text: 'Хорошо 👌' };
}
