import { PHONE_KEYBOARD } from '../bot/keyboards.js';
import { notifyStaff } from '../bot/staff.js';
import type { AppContext } from '../context.js';
import { badRequest } from '../lib/errors.js';
import type { EmployeeRow } from '../lib/serialize.js';
import { createClient, findClientByChat, findClientByPhone } from './clients.js';
import { deliverToChat, safely } from './online-booking-messages.js';
import { employeesByIds, getClientRow } from './refs.js';
import { auditClientJoined } from './waitlist-audit.js';
import { staffJoinedText, WAITLIST_SHARE_TEXT } from './waitlist-messages.js';
import { waitlistItemsJson, type WaitlistRow } from './waitlist-store.js';
import { checkWish, insertWish, lastWaitlistId, publicWaitlistEntry, type WaitlistEntryPublic, type WaitlistInput } from './waitlist.js';

/**
 * A client puts a wish on the waitlist themselves (docs/API.md «Waitlist»): the bot's `join_waitlist`, the Mini App
 * and the booking page. The client is the chat's linked card, else the card with the phone, else a new one — like
 * online booking. The staff chat hears about it.
 */

export interface ClientJoinInput extends WaitlistInput {
  channel: 'bot' | 'miniapp' | 'web';
  /** The client known from the chat (the bot, a linked Mini App chat)… */
  clientId?: number | null;
  /** …else by phone (normalized): the card with it, or a new one with this name. */
  name?: string | null;
  phone?: string | null;
  /** The Mini App chat (the Telegram user id): asked to share its phone when it is not linked. */
  chatId?: number | null;
  now?: number;
}

const SOURCES: Record<ClientJoinInput['channel'], string> = { bot: 'telegram', miniapp: 'telegram', web: 'онлайн-запись' };

function masterOf(ctx: AppContext, row: WaitlistRow): EmployeeRow | null {
  return row.masterId != null ? (employeesByIds(ctx.db, [row.masterId]).get(row.masterId) ?? null) : null;
}

async function announceJoin(ctx: AppContext, row: WaitlistRow): Promise<void> {
  const client = getClientRow(ctx.db, row.clientId);
  const master = masterOf(ctx, row);
  auditClientJoined(ctx, row, client, master);
  await notifyStaff(ctx, staffJoinedText(ctx.db, row, client, master));
}

/** Validates, finds or creates the client and stores the wish; the same open wish is returned (`created: false`). */
export async function joinWaitlist(ctx: AppContext, input: ClientJoinInput): Promise<{ row: WaitlistRow; created: boolean }> {
  const { db } = ctx;
  const now = input.now ?? Date.now();
  const wish = checkWish(db, input, now);
  if (input.clientId == null) {
    if (!input.name?.trim()) throw badRequest('«Имя»: обязательное поле');
    if (!input.phone) throw badRequest('«Телефон»: обязательное поле');
  }
  const result = db.transaction((tx) => {
    const client =
      input.clientId != null
        ? getClientRow(tx, input.clientId)
        : (findClientByPhone(tx, input.phone!) ??
          createClient(tx, { name: input.name!.trim(), phone: input.phone!, source: SOURCES[input.channel] }));
    return insertWish(tx, client.id, wish, input.channel, now);
  });
  if (result.created) await safely(ctx, 'waitlist join notice', () => announceJoin(ctx, result.row));
  // A typed phone proves nothing: the Mini App chat is linked to a card only by sharing its own contact in the bot.
  if (input.channel === 'miniapp' && input.chatId != null && !findClientByChat(db, input.chatId)) {
    const chatId = input.chatId;
    await safely(ctx, 'waitlist share request', () => deliverToChat(ctx, chatId, { text: WAITLIST_SHARE_TEXT, replyKeyboard: PHONE_KEYBOARD }));
  }
  return result;
}

/** The honeypot's answer: looks like a new entry, nothing is stored. */
export function decoyWaitlistEntry(ctx: AppContext, input: ClientJoinInput): WaitlistEntryPublic {
  const now = input.now ?? Date.now();
  const wish = checkWish(ctx.db, input, now);
  const row: WaitlistRow = {
    id: lastWaitlistId(ctx.db) + 1,
    clientId: 0,
    items: waitlistItemsJson(wish.items),
    masterId: wish.masterId,
    dateFrom: wish.dateFrom,
    dateTo: wish.dateTo,
    status: 'waiting',
    channel: input.channel,
    notifiedAt: null,
    appointmentId: null,
    note: wish.note,
    createdAt: now,
    updatedAt: now,
  };
  return publicWaitlistEntry(ctx.db, row);
}
