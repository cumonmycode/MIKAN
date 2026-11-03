import { eq } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import type { DbOrTx } from '../db/client.js';
import { appointments } from '../db/schema.js';
import { storeMessage, updateChatFlags } from '../domain/bot-chats.js';
import { findClientByChat } from '../domain/clients.js';
import { followUpSubject, quotedNames } from '../domain/follow-ups.js';
import { getStudioSettings } from '../domain/settings.js';
import { errorMessage } from '../lib/errors.js';
import { clientFullName } from '../lib/serialize.js';
import { clientMessagePush } from '../push/staff-events.js';
import { encodeCallback, type CallbackAction } from './callback-data.js';
import type { CallbackAnswer, CallbackDeps, CallbackQueryInput } from './callbacks.js';
import type { InlineKeyboard } from './gateway.js';
import { notifyStaff } from './staff.js';

/** The buttons under the post-visit follow-ups (domain/follow-ups.ts) and what they do — no AI call but «Записаться». */

export const HEALING_BUTTONS = { ok: '👍 Всё хорошо', question: '🤔 Есть вопрос' } as const;
export const JEWELRY_CHANGE_BUTTONS = { book: '📅 Записаться', later: 'Позже' } as const;

export const FOLLOW_UP_REPLIES = {
  healingOk: 'Спасибо, что рассказали! Рады, что всё заживает хорошо 🙌 Если появятся вопросы — пишите сюда.',
  healingOkReview:
    'Спасибо, что рассказали! Рады, что всё заживает хорошо 🙌\n\n' +
    'Если вам у нас понравилось, оставьте, пожалуйста, отзыв — это очень помогает студии 💛',
  healingQuestion: 'Расскажите, пожалуйста, что беспокоит, и пришлите фото — мастер посмотрит и ответит здесь 🙏',
  later: 'Хорошо! Когда будет удобно, просто напишите сюда — подберём время 🙂',
} as const;

const OUTDATED = 'Эта кнопка уже неактуальна';

type FollowUpAction = Extract<CallbackAction, { kind: 'healingOk' | 'healingQuestion' | 'jewelryChangeBook' | 'jewelryChangeLater' }>;

export function healingCheckKeyboard(appointmentId: number): InlineKeyboard {
  return [
    [
      { text: HEALING_BUTTONS.ok, data: encodeCallback({ kind: 'healingOk', appointmentId }) },
      { text: HEALING_BUTTONS.question, data: encodeCallback({ kind: 'healingQuestion', appointmentId }) },
    ],
  ];
}

export function jewelryChangeKeyboard(appointmentId: number, bookOnly = false): InlineKeyboard {
  const book = { text: JEWELRY_CHANGE_BUTTONS.book, data: encodeCallback({ kind: 'jewelryChangeBook', appointmentId }) };
  if (bookOnly) return [[book]];
  return [[book, { text: JEWELRY_CHANGE_BUTTONS.later, data: encodeCallback({ kind: 'jewelryChangeLater', appointmentId }) }]];
}

/** The buttons a scheduled message of this kind is sent with; none for other kinds. */
export function followUpKeyboard(kind: string, appointmentId: number): InlineKeyboard | undefined {
  if (kind === 'healing_check') return healingCheckKeyboard(appointmentId);
  if (kind === 'jewelry_change') return jewelryChangeKeyboard(appointmentId);
  return undefined;
}

/** `StudioSettings.reviewLinks` keys in button order. */
const REVIEW_SITES = [
  { key: 'yandex', label: '⭐ Яндекс Карты' },
  { key: 'twogis', label: '⭐ 2ГИС' },
  { key: 'google', label: '⭐ Google' },
] as const;

const LINK = /^https?:\/\/\S+$/i;

/**
 * A link button per review site staff filled in (`StudioSettings.reviewLinks`), one per row. Anything but an
 * http(s) link is skipped, since Telegram would reject the whole message.
 */
export function reviewKeyboard(db: DbOrTx): InlineKeyboard {
  const links = getStudioSettings(db).reviewLinks;
  return REVIEW_SITES.flatMap(({ key, label }) => {
    const url = links[key].trim();
    return LINK.test(url) ? [[{ text: label, url }]] : [];
  });
}

/** Replaces the buttons under the pressed message (`null` removes them); a message Telegram no longer shows is left. */
async function setButtons(ctx: AppContext, query: CallbackQueryInput, keyboard: InlineKeyboard | null): Promise<void> {
  if (!query.message) return;
  await ctx.gateway.editKeyboard(query.from.chatId, query.message.messageId, keyboard).catch(() => undefined);
}

/** Sends the reply with its link buttons and stores it in the chat; a failed delivery is only logged. */
async function deliverWithButtons(ctx: AppContext, chatId: number, text: string, keyboard: InlineKeyboard): Promise<void> {
  try {
    await ctx.gateway.sendText(chatId, text, keyboard.length ? { keyboard } : {});
    storeMessage(ctx.db, chatId, 'assistant', text);
  } catch (err) {
    ctx.log.warn({ chatId, err: errorMessage(err) }, 'failed to deliver the follow-up reply');
  }
}

/** Only the client of the visit, in the chat linked to their card, can answer its follow-ups. */
export async function followUpButton(deps: CallbackDeps, query: CallbackQueryInput, action: FollowUpAction): Promise<CallbackAnswer> {
  const { ctx, pipeline } = deps;
  const chatId = query.from.chatId;
  const client = findClientByChat(ctx.db, chatId);
  const appointment = ctx.db.select().from(appointments).where(eq(appointments.id, action.appointmentId)).get();
  if (!client || !appointment || appointment.clientId !== client.id) {
    await setButtons(ctx, query, null);
    return { text: OUTDATED };
  }
  switch (action.kind) {
    case 'healingOk': {
      await setButtons(ctx, query, null);
      const links = reviewKeyboard(ctx.db);
      const reply = links.length ? FOLLOW_UP_REPLIES.healingOkReview : FOLLOW_UP_REPLIES.healingOk;
      await pipeline.receiveHandled(query.from, `[Кнопка] ${HEALING_BUTTONS.ok}`, () => deliverWithButtons(ctx, chatId, reply, links));
      return { text: 'Спасибо! 🙌' };
    }
    case 'healingQuestion': {
      await setButtons(ctx, query, null);
      await pipeline.receiveHandled(query.from, '[Кнопка] 🤔 Есть вопрос по заживлению', FOLLOW_UP_REPLIES.healingQuestion);
      const chat = updateChatFlags(ctx.db, chatId, { needsAttention: true });
      const what = quotedNames(followUpSubject(ctx.db, appointment, 'healing_check'));
      await notifyStaff(
        ctx,
        `🩹 ${clientFullName(client)}: вопрос по заживлению после ${what}, запись №${appointment.id}`,
        () => clientMessagePush(ctx.db, chat, `вопрос по заживлению после ${what}`),
      );
      return { text: 'Передали мастеру 🙏' };
    }
    case 'jewelryChangeBook': {
      await setButtons(ctx, query, null);
      const what = quotedNames(followUpSubject(ctx.db, appointment, 'jewelry_change'));
      pipeline.receive(query.from, `[Кнопка] 📅 Хочу записаться на замену украшения после ${what}`);
      return { text: 'Подберём время 🙌' };
    }
    case 'jewelryChangeLater':
      await setButtons(ctx, query, jewelryChangeKeyboard(appointment.id, true));
      await pipeline.receiveHandled(query.from, `[Кнопка] ${JEWELRY_CHANGE_BUTTONS.later}`, FOLLOW_UP_REPLIES.later);
      return { text: 'Хорошо 🙂' };
  }
}
