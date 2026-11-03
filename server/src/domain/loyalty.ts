import { count, desc, eq, inArray } from 'drizzle-orm';
import { DateTime } from 'luxon';
import type { AppContext } from '../context.js';
import type { DbOrTx } from '../db/client.js';
import { bonusOperations, sales } from '../db/schema.js';
import { errorMessage } from '../lib/errors.js';
import { employeeRef, type ClientLoyalty, type ClientRow } from '../lib/serialize.js';
import { formatAmount } from '../lib/text.js';
import { HOUR_MS, toIso } from '../lib/time.js';
import { bonusBalance, bonusesText, expireBonusLots, nearestExpiring, type BonusRow } from './bonuses.js';
import { expireCertificates } from './certificates.js';
import { sendToClientChat } from './deposit-messages.js';
import { employeesByIds, getClientRow } from './refs.js';
import { getRetentionSettings, type BirthdaySettings } from './retention-settings.js';
import { studioTimezone } from './settings.js';

/** What staff and clients see of the bonus ledger: the client card's `loyalty`, the ledger list, the bot notice. */

/** The client's birthday in `year` (29 February → the 28th in other years). */
function birthdayIn(birthday: string, year: number, tz: string): DateTime | null {
  const [, month, day] = birthday.split('-').map(Number);
  if (!month || !day) return null;
  const date = DateTime.fromObject({ year, month, day }, { zone: tz });
  if (date.isValid) return date;
  const fallback = DateTime.fromObject({ year, month, day: day - 1 }, { zone: tz });
  return fallback.isValid ? fallback : null;
}

/**
 * The birthday discount while today (studio date) is inside `[birthday − daysBefore, birthday + daysAfter]` of the
 * nearest birthday; null outside it, without a birthday, or when the birthday offer or its discount is off.
 */
export function birthdayDiscount(
  client: Pick<ClientRow, 'birthday'>,
  settings: BirthdaySettings,
  now: number,
  tz: string,
): ClientLoyalty['birthdayDiscount'] {
  if (!client.birthday || !settings.enabled || settings.discountPercent <= 0) return null;
  const today = DateTime.fromMillis(now, { zone: tz }).startOf('day');
  for (const year of [today.year - 1, today.year, today.year + 1]) {
    const day = birthdayIn(client.birthday, year, tz);
    if (!day) continue;
    const from = day.minus({ days: settings.discountDaysBefore });
    const until = day.plus({ days: settings.discountDaysAfter });
    if (today >= from && today <= until) return { percent: settings.discountPercent, until: until.toISODate() ?? '' };
  }
  return null;
}

/** `Client.loyalty` of the client card (`GET /clients/:id`). */
export function clientLoyalty(db: DbOrTx, client: ClientRow, now = Date.now()): ClientLoyalty {
  const expiring = nearestExpiring(db, client.id, now);
  return {
    bonusBalance: bonusBalance(db, client.id, now),
    expiring: expiring ? { amount: expiring.amount, at: toIso(expiring.at) } : null,
    birthdayDiscount: birthdayDiscount(client, getRetentionSettings(db).birthday, now, studioTimezone(db)),
  };
}

export function serializeBonusOperations(db: DbOrTx, rows: BonusRow[]) {
  const saleIds = [...new Set(rows.map((r) => r.saleId).filter((id): id is number => id != null))];
  const numbers = new Map(
    saleIds.length
      ? db.select({ id: sales.id, number: sales.number }).from(sales).where(inArray(sales.id, saleIds)).all().map((s) => [s.id, s.number])
      : [],
  );
  const people = employeesByIds(db, rows.map((r) => r.employeeId));
  return rows.map((r) => {
    const employee = r.employeeId != null ? people.get(r.employeeId) : undefined;
    return {
      id: r.id,
      type: r.type,
      amount: r.amount,
      remaining: r.remaining,
      expiresAt: toIso(r.expiresAt),
      saleId: r.saleId,
      saleNumber: r.saleId != null ? (numbers.get(r.saleId) ?? null) : null,
      note: r.note,
      employee: employee ? employeeRef(employee) : null,
      createdAt: toIso(r.createdAt),
    };
  });
}

/** `GET /clients/:id/bonuses`: the balance and the ledger, newest first. */
export function listBonusOperations(db: DbOrTx, clientId: number, page: { limit: number; offset: number }) {
  getClientRow(db, clientId);
  const where = eq(bonusOperations.clientId, clientId);
  const rows = db
    .select()
    .from(bonusOperations)
    .where(where)
    .orderBy(desc(bonusOperations.createdAt), desc(bonusOperations.id))
    .limit(page.limit)
    .offset(page.offset)
    .all();
  const total = db.select({ n: count() }).from(bonusOperations).where(where).get()?.n ?? 0;
  return { balance: bonusBalance(db, clientId), items: serializeBonusOperations(db, rows), total };
}

/** The last day a lot burning at `ms` is valid: «14 ноября», with the year when it is not the current one. */
function lastValidDay(ms: number, tz: string, now: number): string {
  const at = DateTime.fromMillis(ms - 1, { zone: tz }).setLocale('ru');
  const sameYear = at.year === DateTime.fromMillis(now, { zone: tz }).year;
  return at.toFormat(sameYear ? 'd MMMM' : 'd MMMM yyyy');
}

/** «🎁 +75 бонусов, на счёте 1 275 — начисленные действуют до 14 ноября». */
export function bonusEarnedLine(earned: BonusRow, balance: number, tz: string, now: number): string {
  const base = `🎁 +${bonusesText(earned.amount)}, на счёте ${formatAmount(balance)}`;
  return earned.expiresAt == null ? base : `${base} — начисленные действуют до ${lastValidDay(earned.expiresAt, tz, now)}`;
}

/** «Спасибо за покупку! 🎁 +75 бонусов, на счёте 1 275 — начисленные действуют до 14 ноября». */
export function bonusEarnedText(earned: BonusRow, balance: number, tz: string, now: number): string {
  return `Спасибо за покупку! ${bonusEarnedLine(earned, balance, tz, now)}`;
}

/** The bonuses a sale earned (its `earn` lot), if any. */
function earnedBy(db: DbOrTx, saleId: number): BonusRow | undefined {
  return db.select().from(bonusOperations).where(eq(bonusOperations.saleId, saleId)).all().find((op) => op.type === 'earn');
}

/**
 * The loyalty notice of a sale as a line of its receipt (docs/API.md «Receipt in Telegram»); null when it earned
 * nothing or `loyalty.notifyClient` is off.
 */
export function saleBonusLine(db: DbOrTx, saleId: number, now = Date.now()): string | null {
  const earned = earnedBy(db, saleId);
  if (!earned || !getRetentionSettings(db).loyalty.notifyClient) return null;
  return bonusEarnedLine(earned, bonusBalance(db, earned.clientId, now), studioTimezone(db), now);
}

/**
 * The bot's line about the client's bonuses (the AI context), null while loyalty is off: «Бонусы клиента: 1 200
 * (1 бонус = 1 ₽, ими можно оплатить до 30% чека в студии); 200 из них действуют до 2 ноября.»
 */
export function bonusContextLine(db: DbOrTx, clientId: number, now: number, tz: string): string | null {
  const loyalty = getRetentionSettings(db).loyalty;
  if (!loyalty.enabled) return null;
  const expiring = nearestExpiring(db, clientId, now);
  const burning = expiring ? `; ${formatAmount(expiring.amount)} из них действуют до ${lastValidDay(expiring.at, tz, now)}` : '';
  return (
    `Бонусы клиента: ${formatAmount(bonusBalance(db, clientId, now))} (1 бонус = 1 ₽, ими можно оплатить до ` +
    `${loyalty.maxPaymentPercent}% чека в студии)${burning}.`
  );
}

/**
 * After a paid sale: tells the client in their linked Telegram chat what was credited, when `loyalty.notifyClient`
 * and the bot may write to them. Never throws — the sale is already recorded.
 */
export async function announceBonusEarned(ctx: AppContext, saleId: number): Promise<void> {
  try {
    const { db } = ctx;
    const earned = earnedBy(db, saleId);
    if (!earned || !getRetentionSettings(db).loyalty.notifyClient || !ctx.gateway.isRunning()) return;
    const client = getClientRow(db, earned.clientId);
    if (client.telegramChatId == null || !client.botEnabled || client.archived) return;
    const now = Date.now();
    const text = bonusEarnedText(earned, bonusBalance(db, client.id, now), studioTimezone(db), now);
    await sendToClientChat(ctx, client.telegramChatId, client.id, text);
  } catch (err) {
    ctx.log.warn({ err: errorMessage(err), saleId }, 'bonus notice not delivered');
  }
}

/** How often lots and certificates past their `expiresAt` are burnt (docs/API.md: «checked hourly»). */
export const LOYALTY_EXPIRY_INTERVAL_MS = HOUR_MS;

/** The hourly job: records the burning of bonus lots and certificates whose time has come. */
export function expireLoyalty(db: DbOrTx, now = Date.now()) {
  return { bonuses: expireBonusLots(db, now), certificates: expireCertificates(db, now) };
}
