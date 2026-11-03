import { eq } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import type { DbOrTx } from '../db/client.js';
import { clients } from '../db/schema.js';
import { writeAudit } from '../domain/audit.js';
import { quote } from '../domain/audit-text.js';
import { storeMessage, upsertChat } from '../domain/bot-chats.js';
import type { CampaignButton } from '../domain/campaigns.js';
import { findClientByChat } from '../domain/clients.js';
import { bookingWebAppUrl } from '../domain/online-booking-links.js';
import { getStudioSettings } from '../domain/settings.js';
import { errorMessage } from '../lib/errors.js';
import { clientFullName, type ClientRow } from '../lib/serialize.js';
import { TELEGRAM_MAX_CAPTION } from '../lib/text.js';
import { encodeCallback, type CallbackAction } from './callback-data.js';
import type { CallbackAnswer, CallbackDeps, CallbackQueryInput } from './callbacks.js';
import type { InlineButton, InlineKeyboard } from './gateway.js';
import { photoMessageText, photoSourceFor } from './media.js';

/**
 * News messages — campaigns, birthday greetings, win-back (docs/API.md «Campaigns», «Birthday and win-back»): their
 * text and buttons, delivery, and the buttons' answers. Every news message carries «🔕 Не присылать новости».
 */

export const MARKETING_BUTTONS = {
  optOut: '🔕 Не присылать новости',
  optIn: '🔔 Снова получать новости',
  book: '📅 Записаться',
} as const;

export const MARKETING_REPLIES = {
  optedOut:
    'Хорошо, больше не будем присылать новости и предложения 🙌\n' +
    'Напоминания о записях и памятки по уходу будут приходить, как раньше.',
  optedIn: 'Готово! Снова будем присылать новости и предложения студии 💛',
} as const;

/** The client's message stored when «📅 Записаться» hands the chat to the AI. */
export const BOOKING_WISH = '[Кнопка] 📅 Хочу записаться';

/** `{name}` → the client's first name. */
export const personalize = (text: string, name: string): string => text.replaceAll('{name}', name.trim());

/** A cut further back than this share of the limit loses too much: then the text is cut mid-word. */
const MIN_WORD_CUT = 0.8;

/**
 * At most `max` characters: cut at the last word boundary with «…» (staff check the limit with `{name}` as written, so
 * a long name may push a caption a little over it).
 */
export function cutAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max - 1);
  const space = head.search(/\s\S*$/);
  return `${(space >= max * MIN_WORD_CUT ? head.slice(0, space) : head).trimEnd()}…`;
}

/** «📅 Записаться»: the booking Mini App while online booking is on (and the page is https), else the AI books. */
export function bookButton(ctx: AppContext, text: string = MARKETING_BUTTONS.book): InlineButton {
  const url = getStudioSettings(ctx.db).onlineBooking.enabled ? bookingWebAppUrl(ctx.config) : null;
  return url ? { text, webApp: url } : { text, data: encodeCallback({ kind: 'marketingBook' }) };
}

const optOutRow = (): InlineButton[] => [{ text: MARKETING_BUTTONS.optOut, data: encodeCallback({ kind: 'marketingOptOut' }) }];

/** The buttons under a news message: its own button on top (if any), «🔕 Не присылать новости» below. */
export function newsKeyboard(ctx: AppContext, button: CampaignButton | 'book' | null): InlineKeyboard {
  let own: InlineButton | null = null;
  if (button === 'book') own = bookButton(ctx);
  else if (button?.kind === 'book') own = bookButton(ctx, button.text);
  else if (button?.kind === 'url' && button.url) own = { text: button.text, url: button.url };
  return [...(own ? [[own]] : []), optOutRow()];
}

/** Group chats can't open Mini Apps: there a `web_app` button becomes a link to the same page. */
export function forGroupChat(keyboard: InlineKeyboard): InlineKeyboard {
  return keyboard.map((row) => row.map((b): InlineButton => (b.webApp !== undefined ? { text: b.text, url: b.webApp } : b)));
}

export interface NewsMessage {
  text: string;
  imageUrl?: string | null;
  keyboard: InlineKeyboard;
}

/**
 * Sends a news message — a photo with the text as its caption (≤ 1 024 characters) when it has a picture Telegram can
 * show, else text. Throws what the gateway throws. Returns the text to store in the chat.
 */
export async function sendNews(ctx: AppContext, chatId: number, message: NewsMessage): Promise<string> {
  const photo = message.imageUrl ? photoSourceFor(ctx.config.dataDir, message.imageUrl) : null;
  if (photo) {
    const caption = cutAtWord(message.text, TELEGRAM_MAX_CAPTION);
    await ctx.gateway.sendPhoto(chatId, photo, caption, { keyboard: message.keyboard });
    return photoMessageText(caption);
  }
  await ctx.gateway.sendText(chatId, message.text, { keyboard: message.keyboard });
  return message.text;
}

/** A delivered news message, in the client's chat as `system`. */
export function storeNews(db: DbOrTx, chatId: number, clientId: number, text: string): void {
  upsertChat(db, chatId, { clientId });
  storeMessage(db, chatId, 'system', text);
}

/** Sets the client's `marketingOptOut`; a change is written to the audit log as the client's own action. */
function setOptOut(ctx: AppContext, client: ClientRow, optOut: boolean): void {
  if (client.marketingOptOut === optOut) return;
  ctx.db.update(clients).set({ marketingOptOut: optOut, updatedAt: Date.now() }).where(eq(clients.id, client.id)).run();
  const who = quote(clientFullName(client));
  writeAudit(
    ctx.db,
    {
      source: 'bot',
      employeeId: null,
      action: optOut ? 'client.marketing_opt_out' : 'client.marketing_opt_in',
      entity: 'client',
      entityId: client.id,
      summary: optOut ? `Клиент ${who} отказался от новостей и предложений в боте` : `Клиент ${who} снова получает новости и предложения (в боте)`,
      changes: { marketingOptOut: { from: !optOut, to: optOut } },
    },
    ctx.log,
  );
}

/** Sends a reply with its buttons and stores it; a failed delivery is only logged. */
async function reply(ctx: AppContext, chatId: number, text: string, keyboard?: InlineKeyboard): Promise<void> {
  try {
    await ctx.gateway.sendText(chatId, text, keyboard ? { keyboard } : {});
    storeMessage(ctx.db, chatId, 'assistant', text);
  } catch (err) {
    ctx.log.warn({ chatId, err: errorMessage(err) }, 'failed to deliver the news button reply');
  }
}

type MarketingAction = Extract<CallbackAction, { kind: 'marketingOptOut' | 'marketingOptIn' | 'marketingBook' }>;

/** «🔕 Не присылать новости», «🔔 Снова получать новости» and «📅 Записаться» (no Mini App) under news messages. */
export async function marketingButton(deps: CallbackDeps, query: CallbackQueryInput, action: MarketingAction): Promise<CallbackAnswer> {
  const { ctx, pipeline } = deps;
  const chatId = query.from.chatId;
  if (action.kind === 'marketingBook') {
    pipeline.receive(query.from, BOOKING_WISH);
    return { text: 'Подберём время 🙌' };
  }
  // Only the chat linked to a client card (a staff chat sees these buttons under a test message).
  const client = findClientByChat(ctx.db, chatId);
  if (!client) return { text: 'Эта кнопка работает в чатах клиентов' };
  if (action.kind === 'marketingOptOut') {
    setOptOut(ctx, client, true);
    const keyboard: InlineKeyboard = [[{ text: MARKETING_BUTTONS.optIn, data: encodeCallback({ kind: 'marketingOptIn' }) }]];
    await pipeline.receiveHandled(query.from, `[Кнопка] ${MARKETING_BUTTONS.optOut}`, () => reply(ctx, chatId, MARKETING_REPLIES.optedOut, keyboard));
    return { text: 'Больше не пришлём новостей' };
  }
  setOptOut(ctx, client, false);
  if (query.message) await ctx.gateway.editKeyboard(chatId, query.message.messageId, null).catch(() => undefined);
  await pipeline.receiveHandled(query.from, `[Кнопка] ${MARKETING_BUTTONS.optIn}`, () => reply(ctx, chatId, MARKETING_REPLIES.optedIn));
  return { text: 'Готово 💛' };
}
