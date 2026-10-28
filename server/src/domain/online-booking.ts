import { randomBytes } from 'node:crypto';
import { and, count, eq, gt, inArray, lt, notInArray } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import type { DbOrTx } from '../db/client.js';
import { appointments, qrPayments } from '../db/schema.js';
import { AppError, badRequest, conflict, errorMessage, scheduleConflict } from '../lib/errors.js';
import type { AppointmentRow, ClientRow, QrPaymentRow } from '../lib/serialize.js';
import { pluralWord } from '../lib/text.js';
import { localDate, MINUTE_MS } from '../lib/time.js';
import type { CreatedQr } from '../payments/qr-provider.js';
import { createAppointment } from './appointments.js';
import { auditBirthdayGiven, fillBirthday } from './client-birthday.js';
import { createClient, findClientByChat, findClientByPhone } from './clients.js';
import { forbidden } from './permissions.js';
import { auditOnlineBooked } from './online-booking-audit.js';
import { resolveItems, type BookingItem, type ResolvedItems } from './online-booking-items.js';
import { announceBooking, askToShareNumber } from './online-booking-messages.js';
import { assertOnlineMaster, bookingDates, chooseMaster, freeStart } from './online-booking-slots.js';
import { registerBankCode } from './qr-payments.js';
import { getClientRow } from './refs.js';
import { getStudioSettings, type OnlineBookingSettings } from './settings.js';

/**
 * The online booking engine shared by every channel (docs/API.md «Online booking»): the AI in Telegram (`bot`), the
 * Telegram Mini App (`miniapp`) and the booking page (`web`). A booking holds its time at once: with a prepayment
 * (and QR payments configured) it waits `holdMinutes` for the client to pay by QR, otherwise for staff to confirm it.
 * What happens next lives in online-booking-lifecycle.ts.
 */

export const ONLINE_CHANNELS = ['bot', 'miniapp', 'web'] as const;
export type OnlineChannel = (typeof ONLINE_CHANNELS)[number];
export const ONLINE_STATES = ['awaiting_payment', 'awaiting_confirmation'] as const;
export type OnlineState = (typeof ONLINE_STATES)[number];

/** Unsettled online bookings one client may have at once. */
export const MAX_UNSETTLED_PER_CLIENT = 2;
export const ONLINE_DISABLED = 'Онлайн-запись временно недоступна';
export const SLOT_TAKEN = 'Это время только что заняли — выберите другое';
export const TOO_MANY_UNSETTLED = 'У вас уже есть записи, которые ждут подтверждения — дождитесь ответа студии';
export const CLIENT_BUSY = 'У вас уже есть запись на это время';
/** Where a card created by online booking says it came from. */
const CLIENT_SOURCES: Record<OnlineChannel, string> = { bot: 'telegram', miniapp: 'telegram', web: 'онлайн-запись' };
const OPEN_STATUSES = ['scheduled', 'confirmed'];

export interface OnlineBookingInput {
  channel: OnlineChannel;
  items: BookingItem[];
  /** A master, else «any». */
  masterId?: number | null;
  startsAt: number;
  comment?: string | null;
  /** The client known from the chat (the bot, a linked Mini App chat)… */
  clientId?: number | null;
  /** …else by phone (normalized): the card with it, or a new one with this name. */
  name?: string | null;
  phone?: string | null;
  /** The Mini App chat (the Telegram user id): told about the booking. */
  chatId?: number | null;
  /** The client's birthday from the page (`YYYY-MM-DD`, 1900 = year unknown): fills a card that has none. */
  birthday?: string | null;
  now?: number;
}

export interface OnlineBookingResult {
  appointment: AppointmentRow;
  /** The prepayment code while the booking waits for the payment. */
  payment: QrPaymentRow | null;
  client: ClientRow;
  /** The booking filled in the birthday of a card that already existed. */
  birthdayFilled?: boolean;
}

/** What a booking would be, validated without writing (also the bot's test mode). */
export interface BookingCheck {
  /** Priced by `masterId` (see service-prices.ts). */
  items: ResolvedItems;
  startsAt: number;
  endsAt: number;
  /** Masters free at that start (only the chosen one when a master was asked for). */
  masterIds: number[];
  /** The master the booking goes to: the chosen one, else the one «any» picks now. */
  masterId: number;
  /** The booking will wait for the prepayment (else for staff). */
  prepayment: boolean;
}

/** `403` «Онлайн-запись временно недоступна» while staff have it off. */
export function assertOnlineEnabled(db: DbOrTx): OnlineBookingSettings {
  const settings = getStudioSettings(db).onlineBooking;
  if (!settings.enabled) throw forbidden(ONLINE_DISABLED);
  return settings;
}

export const newPublicToken = (): string => randomBytes(18).toString('base64url');
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

export function findBookingByToken(db: DbOrTx, token: string): AppointmentRow | null {
  if (!TOKEN_PATTERN.test(token)) return null;
  return db.select().from(appointments).where(eq(appointments.publicToken, token)).get() ?? null;
}

/** Online bookings of the client still waiting for a payment or for staff. */
export function unsettledCount(db: DbOrTx, clientId: number): number {
  return (
    db
      .select({ n: count() })
      .from(appointments)
      .where(
        and(
          eq(appointments.clientId, clientId),
          inArray(appointments.onlineState, [...ONLINE_STATES]),
          inArray(appointments.status, OPEN_STATUSES),
        ),
      )
      .get()?.n ?? 0
  );
}

/** A double submit (or the AI calling twice) must not book the same person twice at once with another master. */
function assertClientFree(db: DbOrTx, clientId: number, startsAt: number, endsAt: number): void {
  const clash = db
    .select({ id: appointments.id })
    .from(appointments)
    .where(
      and(
        eq(appointments.clientId, clientId),
        lt(appointments.startsAt, endsAt),
        gt(appointments.endsAt, startsAt),
        notInArray(appointments.status, ['cancelled', 'no_show']),
      ),
    )
    .get();
  if (clash) throw conflict(CLIENT_BUSY);
}

function assertBookableTime(db: DbOrTx, startsAt: number, now: number, settings: OnlineBookingSettings): void {
  if (startsAt < now + settings.leadMinutes * MINUTE_MS) {
    throw badRequest('Это время уже недоступно для онлайн-записи — выберите время попозже');
  }
  if (localDate(startsAt, getStudioSettings(db).timezone) > bookingDates(db, now).last) {
    const days = `${settings.horizonDays} ${pluralWord(settings.horizonDays, 'день', 'дня', 'дней')}`;
    throw badRequest(`Онлайн-запись открыта на ${days} вперёд — выберите дату пораньше`);
  }
}

/** Services, master and time: `400` / `403` / `409` with the reason, nothing written. */
export function checkOnlineBooking(ctx: AppContext, input: Omit<OnlineBookingInput, 'channel'>): BookingCheck {
  const { db } = ctx;
  const settings = assertOnlineEnabled(db);
  const now = input.now ?? Date.now();
  const { durationMin } = resolveItems(db, input.items);
  if (input.masterId != null) assertOnlineMaster(db, input.masterId);
  assertBookableTime(db, input.startsAt, now, settings);
  const option = freeStart(db, { startsAt: input.startsAt, durationMin, masterId: input.masterId, now });
  if (!option) throw scheduleConflict(SLOT_TAKEN);
  // «Any master» costs what the master it goes to charges.
  const masterId = input.masterId ?? chooseMaster(db, input.startsAt, option.masterIds);
  const items = resolveItems(db, input.items, masterId);
  return {
    items,
    startsAt: input.startsAt,
    endsAt: input.startsAt + durationMin * MINUTE_MS,
    masterIds: option.masterIds,
    masterId,
    prepayment: items.depositRequired > 0 && ctx.qr !== null,
  };
}

/** The client of a booking that is about to be written: by chat, else by phone (null = a new card). */
function existingClient(db: DbOrTx, input: OnlineBookingInput): ClientRow | null {
  if (input.clientId != null) return getClientRow(db, input.clientId);
  if (!input.name?.trim()) throw badRequest('«Имя»: обязательное поле');
  if (!input.phone) throw badRequest('«Телефон»: обязательное поле');
  return findClientByPhone(db, input.phone);
}

/** A one-off prepayment code valid while the time is held; a bank failure leaves the booking for staff to confirm. */
async function registerHoldCode(ctx: AppContext, amount: number, holdMinutes: number): Promise<CreatedQr | null> {
  try {
    const purpose = `Предоплата, ${getStudioSettings(ctx.db).name}`.slice(0, 140);
    return await registerBankCode(ctx, ctx.qr!, { amount, purpose, ttlMinutes: holdMinutes });
  } catch (err) {
    ctx.log.error({ err: errorMessage(err) }, 'online booking: no prepayment code, the booking waits for staff');
    return null;
  }
}

/** Writes the booking in one transaction, checking the time and the limit again (the bank call took a while). */
function commit(ctx: AppContext, input: OnlineBookingInput, check: BookingCheck, code: CreatedQr | null, started: number): OnlineBookingResult {
  const { db } = ctx;
  const { holdMinutes } = getStudioSettings(db).onlineBooking;
  return db.transaction((tx) => {
    const now = Date.now();
    const option = freeStart(tx, { startsAt: input.startsAt, durationMin: check.items.durationMin, masterId: input.masterId, now });
    if (!option) throw scheduleConflict(SLOT_TAKEN);
    const masterId = input.masterId ?? chooseMaster(tx, input.startsAt, option.masterIds);
    // «Any» may land on another master than when checked (the bank call took a while): their prices then.
    const items = masterId === check.masterId ? check.items : resolveItems(tx, input.items, masterId);
    const existing = existingClient(tx, input);
    const birthday = input.birthday ?? null;
    const client =
      existing ?? createClient(tx, { name: input.name!.trim(), phone: input.phone!, source: CLIENT_SOURCES[input.channel], birthday });
    const birthdayFilled = existing !== null && birthday !== null && !existing.birthday && fillBirthday(tx, existing.id, birthday, now) !== null;
    if (unsettledCount(tx, client.id) >= MAX_UNSETTLED_PER_CLIENT) throw conflict(TOO_MANY_UNSETTLED);
    assertClientFree(tx, client.id, input.startsAt, check.endsAt);
    let created: AppointmentRow;
    try {
      created = createAppointment(tx, {
        clientId: client.id,
        masterId,
        services: items.lines,
        startsAt: input.startsAt,
        endsAt: check.endsAt,
        price: items.price,
        depositRequired: items.depositRequired,
        notes: input.comment?.trim() || null,
        status: 'scheduled',
      });
    } catch (err) {
      // Never pass on the regular overlap message: it names another client.
      if (err instanceof AppError && err.code === 'schedule_conflict') throw scheduleConflict(SLOT_TAKEN);
      throw err;
    }
    const holdUntil = code ? started + holdMinutes * MINUTE_MS : null;
    const appointment = tx
      .update(appointments)
      .set({
        channel: input.channel,
        onlineState: code ? 'awaiting_payment' : 'awaiting_confirmation',
        holdUntil,
        publicToken: newPublicToken(),
        updatedAt: now,
      })
      .where(eq(appointments.id, created.id))
      .returning()
      .get()!;
    const payment = code
      ? tx
          .insert(qrPayments)
          .values({
            kind: 'deposit',
            appointmentId: appointment.id,
            provider: ctx.qr!.name,
            externalId: code.externalId,
            payload: code.payload,
            amount: check.items.depositRequired,
            status: 'pending',
            saleInputJson: null,
            // No employee issued it: the code is the booked master's (the column is required).
            employeeId: masterId,
            expiresAt: holdUntil!,
            createdAt: now,
            updatedAt: now,
          })
          .returning()
          .get()
      : null;
    return { appointment, payment, client: getClientRow(tx, client.id), ...(birthdayFilled ? { birthdayFilled } : {}) };
  });
}

/**
 * Books online: validates, registers the prepayment code when one is due, writes the booking, logs it and tells the
 * staff chat and the client (the bot's AI tells its client itself — see bot/booking-tool.ts).
 */
export async function createOnlineBooking(ctx: AppContext, input: OnlineBookingInput): Promise<OnlineBookingResult> {
  const check = checkOnlineBooking(ctx, input);
  const known = existingClient(ctx.db, input);
  if (known && unsettledCount(ctx.db, known.id) >= MAX_UNSETTLED_PER_CLIENT) throw conflict(TOO_MANY_UNSETTLED);
  const started = Date.now();
  const holdMinutes = getStudioSettings(ctx.db).onlineBooking.holdMinutes;
  const code = check.prepayment ? await registerHoldCode(ctx, check.items.depositRequired, holdMinutes) : null;
  const result = commit(ctx, input, check, code, started);
  auditOnlineBooked(ctx, result.appointment);
  if (result.birthdayFilled) auditBirthdayGiven(ctx, result.client, 'booking');
  await announceBooking(ctx, result.appointment, result.payment, {
    toClient: input.channel !== 'bot',
    chatId: input.channel === 'miniapp' ? input.chatId : null,
  });
  // A typed phone proves nothing: the Mini App chat is linked to a card only by sharing its own contact in the bot.
  if (input.channel === 'miniapp' && input.chatId != null && !findClientByChat(ctx.db, input.chatId)) {
    await askToShareNumber(ctx, input.chatId);
  }
  return result;
}
