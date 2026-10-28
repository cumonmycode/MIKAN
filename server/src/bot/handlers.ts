import type { Bot, Context, Keyboard } from 'grammy';
import type { AppContext } from '../context.js';
import { errorMessage } from '../lib/errors.js';
import { onSmmPrivate, onSmmVoice } from '../smm/tg-handlers.js';
import { handleCallback } from './callbacks.js';
import { jewelryCategoriesMenu, sendMenu, serviceSectionsMenu } from './catalog.js';
import { BUTTONS, mainKeyboard, staffKeyboard } from './keyboards.js';
import { handleContact, handleStaffCommand, handleStart, needsPhone, PHONE_REQUIRED } from './onboarding.js';
import type { BotPipeline, IncomingFrom } from './pipeline.js';
import type { PendingImage } from './prompt.js';

export { BUTTONS, mainKeyboard, STAFF_BUTTONS, staffKeyboard } from './keyboards.js';

export const MAX_CLIENT_IMAGE_BYTES = 5 * 1024 * 1024;

const keyboardFor = (reply: { linked: boolean; staff?: boolean }): Keyboard => (reply.staff ? staffKeyboard() : mainKeyboard(reply.linked));

export interface HandlerDeps {
  ctx: AppContext;
  pipeline: BotPipeline;
  /** Downloads a Telegram file (≤ maxBytes) via the configured API root; null if too big/unavailable. */
  downloadFile(fileId: string, maxBytes: number): Promise<Buffer | null>;
}

function sender(c: Context): IncomingFrom {
  const name = [c.from?.first_name, c.from?.last_name].filter(Boolean).join(' ').trim();
  return { chatId: c.chat!.id, telegramName: name || null, username: c.from?.username ?? null };
}

const IMAGE_TYPES: Record<string, PendingImage['mediaType']> = {
  'image/jpeg': 'image/jpeg',
  'image/png': 'image/png',
  'image/webp': 'image/webp',
};

async function fetchImage(deps: HandlerDeps, fileId: string, mediaType: PendingImage['mediaType']): Promise<PendingImage | undefined> {
  try {
    const buffer = await deps.downloadFile(fileId, MAX_CLIENT_IMAGE_BYTES);
    return buffer ? { data: buffer.toString('base64'), mediaType } : undefined;
  } catch (err) {
    deps.ctx.log.warn({ err: errorMessage(err) }, 'failed to download client photo');
    return undefined;
  }
}

/** What a message is, for the chat history: its text, or a label of the attachment with its caption. */
export function describeMessage(message: Context['message']): string {
  if (!message) return '[Сообщение]';
  if (message.text) return message.text;
  const caption = message.caption?.trim();
  const withCaption = (label: string) => (caption ? `${label} ${caption}` : label);
  if (message.photo) return withCaption('[Фото]');
  if (message.document) return withCaption(`[Файл «${message.document.file_name ?? 'без названия'}»]`);
  if (message.voice || message.audio) return '[Голосовое сообщение]';
  if (message.video || message.video_note) return '[Видео]';
  if (message.sticker) return `[Стикер ${message.sticker.emoji ?? ''}]`.replace(' ]', ']');
  return withCaption('[Сообщение]');
}

/** Opens a catalog menu; when there is nothing to show, the message goes to the AI like any other. */
async function openCatalog(deps: HandlerDeps, from: IncomingFrom, text: string, which: 'jewelry' | 'services'): Promise<void> {
  const menu = which === 'jewelry' ? jewelryCategoriesMenu(deps.ctx.db) : serviceSectionsMenu(deps.ctx.db);
  if (!menu) {
    deps.pipeline.receive(from, text);
    return;
  }
  await deps.pipeline.receiveHandled(from, text, () => sendMenu(deps.ctx, from.chatId, menu));
}

export function registerHandlers(bot: Bot, deps: HandlerDeps): void {
  const { ctx, pipeline } = deps;

  // Works in any chat (group or private): binds the staff notification chat.
  bot.command('staff', async (c) => {
    await c.reply(handleStaffCommand(ctx, c.chat.id, String(c.match ?? '')));
  });

  const pm = bot.chatType('private');

  pm.command('start', async (c) => {
    const reply = handleStart(ctx, sender(c), String(c.match ?? ''));
    await c.reply(reply.text, { reply_markup: keyboardFor(reply) });
  });

  pm.on('message:contact', async (c) => {
    const contact = c.message.contact;
    const reply = await handleContact(
      ctx,
      { ...sender(c), userId: c.from.id },
      { userId: contact.user_id, phone: contact.phone_number, firstName: contact.first_name, lastName: contact.last_name },
    );
    await c.reply(reply.text, { reply_markup: keyboardFor(reply) });
    // What the person asked before sharing the phone gets its answer now.
    if (reply.linked || reply.staff) pipeline.answerPending(c.chat.id);
  });

  // Until a new chat shares its phone nothing else works: every message is answered with the request for the phone
  // (staff chats and chats linked to a client pass).
  pm.use(async (c, next) => {
    if (!c.message && !c.callbackQuery) return next();
    const from = sender(c);
    if (!needsPhone(ctx.db, from.chatId)) return next();
    if (c.callbackQuery) {
      await c.answerCallbackQuery({ text: 'Сначала поделитесь номером — кнопка внизу 👇' }).catch(() => undefined);
      await c.reply(PHONE_REQUIRED, { reply_markup: mainKeyboard(false) });
      return;
    }
    await pipeline.receiveWithoutPhone(from, describeMessage(c.message));
  });

  // Interactive catalogs: the keyboard buttons and /catalog open menus with inline buttons (no AI call).
  pm.command('catalog', async (c) => {
    await openCatalog(deps, sender(c), c.message.text, 'jewelry');
  });
  pm.hears(BUTTONS.jewelry, async (c) => {
    await openCatalog(deps, sender(c), BUTTONS.jewelry, 'jewelry');
  });
  pm.hears(BUTTONS.services, async (c) => {
    await openCatalog(deps, sender(c), BUTTONS.services, 'services');
  });

  pm.on('callback_query:data', async (c) => {
    const message = c.callbackQuery.message;
    const answer = await handleCallback(
      { ctx, pipeline },
      {
        from: sender(c),
        data: c.callbackQuery.data,
        // An old message Telegram no longer shows to the bot comes as «inaccessible» (date 0): answer with new messages.
        message:
          message && message.date !== 0
            ? { messageId: message.message_id, isPhoto: 'photo' in message && Array.isArray(message.photo) }
            : null,
      },
    );
    await c.answerCallbackQuery(answer.text ? { text: answer.text } : undefined).catch(() => undefined);
  });

  pm.on('message:photo', async (c) => {
    const caption = c.message.caption?.trim();
    // Staff: the caption may be the awaited SMM remark or the link to a published post.
    if (caption && (await onSmmPrivate(ctx, c.chat.id, caption))) return;
    const sizes = [...c.message.photo].reverse();
    const best = sizes.find((s) => (s.file_size ?? 0) <= MAX_CLIENT_IMAGE_BYTES);
    // Not awaited: grammY handles updates one by one, so a slow download must not stall other chats.
    // The pipeline awaits the promise when it builds the AI request.
    const image = best ? fetchImage(deps, best.file_id, 'image/jpeg') : undefined;
    pipeline.receive(sender(c), caption ? `[Фото] ${caption}` : '[Фото]', image);
  });

  pm.on('message:document', async (c) => {
    const doc = c.message.document;
    const caption = c.message.caption?.trim();
    const mediaType = doc.mime_type ? IMAGE_TYPES[doc.mime_type] : undefined;
    if (mediaType && (doc.file_size ?? 0) <= MAX_CLIENT_IMAGE_BYTES) {
      const image = fetchImage(deps, doc.file_id, mediaType);
      pipeline.receive(sender(c), caption ? `[Фото] ${caption}` : '[Фото]', image);
      return;
    }
    pipeline.receive(sender(c), `[Файл «${doc.file_name ?? 'без названия'}»]${caption ? ` ${caption}` : ''}`);
  });

  pm.on(['message:voice', 'message:audio'], async (c) => {
    // Staff answering an SMM «Поправить» by voice are asked to write the remark (no speech recognition here).
    if (await onSmmVoice(ctx, c.chat.id)) return;
    await pipeline.receiveUnsupported(sender(c), '[Голосовое сообщение]');
  });

  pm.on(['message:video', 'message:video_note'], async (c) => {
    await pipeline.receiveUnsupported(sender(c), '[Видео]');
  });

  pm.on('message:sticker', async (c) => {
    pipeline.receive(sender(c), `[Стикер ${c.message.sticker.emoji ?? ''}]`.replace(' ]', ']'));
  });

  pm.on('message:text', async (c) => {
    // Staff: an awaited SMM remark or the link to a published post is handled there, not by the staff assistant.
    if (await onSmmPrivate(ctx, c.chat.id, c.message.text)) return;
    pipeline.receive(sender(c), c.message.text);
  });
}
