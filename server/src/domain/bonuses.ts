import { and, asc, eq, gt, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { DateTime } from 'luxon';
import type { DbOrTx } from '../db/client.js';
import { bonusOperations } from '../db/schema.js';
import { badRequest, conflict } from '../lib/errors.js';
import type { SaleRow } from '../lib/serialize.js';
import { formatAmount, formatRub, pluralWord } from '../lib/text.js';
import { getRetentionSettings, type LoyaltySettings } from './retention-settings.js';
import { studioTimezone } from './settings.js';

/**
 * The loyalty bonus ledger (docs/API.md «Loyalty bonuses»). 1 bonus = 1 ₽. Credits (`earn`, `gift`, a positive
 * `adjust`, the `reverse` of bonuses paid in a refunded sale) are lots spent oldest first; `remaining` is what is left
 * of a lot and `expiresAt` when that rest burns. Debits (`spend`, `expire`, a negative `adjust`, the `reverse` taking
 * back a refunded sale's earned bonuses) take from the lots and keep `remaining` 0. A lot past `expiresAt` is out of
 * the balance at once; the hourly job records its `expire`.
 */

export type BonusOperationType = 'earn' | 'spend' | 'gift' | 'expire' | 'adjust' | 'reverse';
export type BonusRow = typeof bonusOperations.$inferSelect;

/** «1 бонус», «3 бонуса», «1 200 бонусов». */
export const bonusesText = (n: number): string => `${formatAmount(n)} ${pluralWord(n, 'бонус', 'бонуса', 'бонусов')}`;

const isLive = (now: number) => or(isNull(bonusOperations.expiresAt), gt(bonusOperations.expiresAt, now));
const isLiveLot = (lot: BonusRow, now: number) => lot.remaining > 0 && (lot.expiresAt == null || lot.expiresAt > now);

/** Unspent lots that have not burnt, oldest first. */
function liveLots(db: DbOrTx, clientId: number, now: number): BonusRow[] {
  return db
    .select()
    .from(bonusOperations)
    .where(and(eq(bonusOperations.clientId, clientId), gt(bonusOperations.remaining, 0), isLive(now)))
    .orderBy(asc(bonusOperations.createdAt), asc(bonusOperations.id))
    .all();
}

/**
 * SQL «the client has bonuses now» for a client id expression (e.g. sql`c.id` in a segment query): a lot with an
 * unspent rest that has not burnt — exactly when `bonusBalance` > 0.
 */
export const hasBonusBalanceSql = (clientId: SQL, now: number): SQL =>
  sql`exists (select 1 from bonus_operations b where b.client_id = ${clientId} and b.remaining > 0 and (b.expires_at is null or b.expires_at > ${now}))`;

/** What the client can spend now: the unspent rest of the lots that have not burnt. */
export function bonusBalance(db: DbOrTx, clientId: number, now = Date.now()): number {
  return (
    db
      .select({ v: sql<number>`coalesce(sum(${bonusOperations.remaining}), 0)` })
      .from(bonusOperations)
      .where(and(eq(bonusOperations.clientId, clientId), gt(bonusOperations.remaining, 0), isLive(now)))
      .get()?.v ?? 0
  );
}

/** The nearest lot that will burn (lots burning at the same moment add up), or null. */
export function nearestExpiring(db: DbOrTx, clientId: number, now = Date.now()): { amount: number; at: number } | null {
  const burning = liveLots(db, clientId, now).filter((lot) => lot.expiresAt != null);
  if (burning.length === 0) return null;
  const at = Math.min(...burning.map((lot) => lot.expiresAt!));
  const amount = burning.filter((lot) => lot.expiresAt === at).reduce((sum, lot) => sum + lot.remaining, 0);
  return { amount, at };
}

/** Takes `amount` from the live lots, oldest first, and returns how much it took (less only when they run out). */
function drawFromLots(db: DbOrTx, clientId: number, amount: number, now: number): number {
  const lots = liveLots(db, clientId, now);
  let left = amount;
  for (const lot of lots) {
    if (left === 0) break;
    const take = Math.min(lot.remaining, left);
    db.update(bonusOperations).set({ remaining: lot.remaining - take }).where(eq(bonusOperations.id, lot.id)).run();
    left -= take;
  }
  return amount - left;
}

interface OperationValues {
  clientId: number;
  type: BonusOperationType;
  amount: number;
  expiresAt?: number | null;
  saleId?: number | null;
  note?: string | null;
  employeeId?: number | null;
  createdAt: number;
}

function insertOperation(db: DbOrTx, v: OperationValues): BonusRow {
  return db
    .insert(bonusOperations)
    .values({
      clientId: v.clientId,
      type: v.type,
      amount: v.amount,
      remaining: v.amount > 0 ? v.amount : 0,
      expiresAt: v.amount > 0 ? (v.expiresAt ?? null) : null,
      saleId: v.saleId ?? null,
      note: v.note ?? null,
      employeeId: v.employeeId ?? null,
      createdAt: v.createdAt,
    })
    .returning()
    .get();
}

/**
 * When bonuses given now for `days` burn: the end of the studio day `days` days from today, so a client told «они
 * действуют до 2 ноября» (`lastDay`) has the whole of that day. Earned, returned and gift bonuses all burn this way.
 */
export function bonusExpiry(now: number, days: number, tz: string): { lastDay: string; expiresAt: number } {
  const lastDay = DateTime.fromMillis(now, { zone: tz }).startOf('day').plus({ days });
  return { lastDay: lastDay.toISODate() ?? '', expiresAt: lastDay.plus({ days: 1 }).toMillis() };
}

/** When bonuses earned now burn under the loyalty settings (`null` — never). */
const earnedExpiry = (db: DbOrTx, loyalty: LoyaltySettings, now: number): number | null =>
  loyalty.expiryDays == null ? null : bonusExpiry(now, loyalty.expiryDays, studioTimezone(db)).expiresAt;

/**
 * Checks a bonus payment of a checkout (nothing is written): a client, loyalty on, at most `maxPaymentPercent` of the
 * total and at most the balance.
 */
export function assertBonusPayment(db: DbOrTx, clientId: number | null, amount: number, total: number, now = Date.now()): void {
  if (amount <= 0) return;
  if (clientId == null) throw badRequest('Чтобы оплатить бонусами, выберите клиента');
  const loyalty = getRetentionSettings(db).loyalty;
  if (!loyalty.enabled) throw conflict('Бонусная программа выключена — оплатите другим способом');
  const limit = Math.floor((total * loyalty.maxPaymentPercent) / 100);
  if (amount > limit) {
    throw badRequest(`Бонусами можно оплатить не больше ${loyalty.maxPaymentPercent}% чека — ${formatRub(limit)}`);
  }
  const balance = bonusBalance(db, clientId, now);
  if (amount > balance) throw conflict(`На счёте ${bonusesText(balance)}`);
}

/** Records the bonus part of a sale (checked by `assertBonusPayment` in the same transaction). */
export function spendBonuses(db: DbOrTx, sale: SaleRow, employeeId: number | null, now: number): void {
  if (sale.payBonus <= 0 || sale.clientId == null) return;
  const taken = drawFromLots(db, sale.clientId, sale.payBonus, now);
  if (taken !== sale.payBonus) throw conflict(`На счёте ${bonusesText(taken)}`);
  insertOperation(db, { clientId: sale.clientId, type: 'spend', amount: -sale.payBonus, saleId: sale.id, employeeId, createdAt: now });
}

/**
 * Credits the cashback of a completed sale with a client: `floor(cashbackPercent × base / 100)`, where the base is
 * what the client paid with money (`total − bonus − certificate payments − certificate lines`). Returns the amount.
 */
export function earnBonuses(db: DbOrTx, sale: SaleRow, base: number, employeeId: number | null, now: number): number {
  if (sale.clientId == null) return 0;
  const loyalty = getRetentionSettings(db).loyalty;
  if (!loyalty.enabled) return 0;
  const earned = Math.floor((Math.max(0, base) * loyalty.cashbackPercent) / 100);
  if (earned <= 0) return 0;
  insertOperation(db, {
    clientId: sale.clientId,
    type: 'earn',
    amount: earned,
    expiresAt: earnedExpiry(db, loyalty, now),
    saleId: sale.id,
    employeeId,
    createdAt: now,
  });
  return earned;
}

/** What a sale earned: its `earn` lot (`null` when it earned nothing) and how much of that lot has burnt since. */
export function saleEarnings(db: DbOrTx, saleId: number): { lot: BonusRow | null; burnt: number } {
  const ops = db.select().from(bonusOperations).where(eq(bonusOperations.saleId, saleId)).all();
  const burnt = -ops.filter((op) => op.type === 'expire').reduce((sum, op) => sum + op.amount, 0);
  return { lot: ops.find((op) => op.type === 'earn') ?? null, burnt };
}

/**
 * What `reverseSaleBonuses` would take back of `owed` (nothing is written): the unspent rest of the sale's own lot
 * (burnt by now or not), then the client's other live lots plus the `givenBack` lot it credits first, never below 0.
 */
export function previewTakeBack(
  db: DbOrTx,
  clientId: number | null,
  lot: BonusRow | null,
  owed: number,
  givenBack: number,
  now: number,
): number {
  if (clientId == null || owed <= 0) return 0;
  const fromOwnLot = Math.min(lot?.remaining ?? 0, owed);
  if (fromOwnLot === owed) return owed;
  const ownLive = lot && isLiveLot(lot, now) ? lot.remaining : 0;
  const others = bonusBalance(db, clientId, now) - ownLive + givenBack;
  return fromOwnLot + Math.min(owed - fromOwnLot, Math.max(0, others));
}

export interface BonusReversal {
  /** Bonuses paid in the returned part: they come back as a new lot. */
  givenBack: number;
  /** Earned bonuses the refund takes back (see refunds.ts), before the client's balance limits it. */
  owed: number;
  /** The refund returns the whole sale at once: the notes say «Возврат чека», else «Частичный возврат чека». */
  whole: boolean;
}

/**
 * A refund of (part of) a sale: the bonuses paid in the returned part come back first (a new lot that burns like newly
 * earned ones), then `owed` of the bonuses it earned are taken back — the unspent rest of its own lot (burnt by now or
 * not), then from the other lots, never below 0. Returns what was taken back. Works with loyalty off too.
 */
export function reverseSaleBonuses(db: DbOrTx, sale: SaleRow, reversal: BonusReversal, employeeId: number | null, now: number): number {
  if (sale.clientId == null) return 0;
  const prefix = `${reversal.whole ? 'Возврат' : 'Частичный возврат'} чека №${sale.number}`;
  if (reversal.givenBack > 0) {
    insertOperation(db, {
      clientId: sale.clientId,
      type: 'reverse',
      amount: reversal.givenBack,
      expiresAt: earnedExpiry(db, getRetentionSettings(db).loyalty, now),
      saleId: sale.id,
      note: `${prefix}: бонусы, оплаченные в чеке, вернулись`,
      employeeId,
      createdAt: now,
    });
  }
  if (reversal.owed <= 0) return 0;
  const { lot } = saleEarnings(db, sale.id);
  const fromOwnLot = Math.min(lot?.remaining ?? 0, reversal.owed);
  if (lot && fromOwnLot > 0) {
    db.update(bonusOperations).set({ remaining: lot.remaining - fromOwnLot }).where(eq(bonusOperations.id, lot.id)).run();
  }
  const taken = fromOwnLot + drawFromLots(db, sale.clientId, reversal.owed - fromOwnLot, now);
  if (taken <= 0) return 0;
  insertOperation(db, {
    clientId: sale.clientId,
    type: 'reverse',
    amount: -taken,
    saleId: sale.id,
    note: `${prefix}: начисленные бонусы списаны`,
    employeeId,
    createdAt: now,
  });
  return taken;
}

/**
 * Gift bonuses (birthday, win-back): a lot of `amount` that burns at the end of the studio day `days` days from today
 * (`bonusExpiry`). The caller decides whether gifts are on (retention settings); this only writes the lot.
 */
export function creditGiftBonuses(
  db: DbOrTx,
  clientId: number,
  amount: number,
  days: number,
  note: string | null,
  now = Date.now(),
): BonusRow {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error(`gift bonuses must be a positive integer, got ${amount}`);
  if (!Number.isSafeInteger(days) || days <= 0) throw new Error(`gift bonuses must burn after a positive number of days, got ${days}`);
  const { expiresAt } = bonusExpiry(now, days, studioTimezone(db));
  return insertOperation(db, { clientId, type: 'gift', amount, expiresAt, note, createdAt: now });
}

/** A manual correction by staff: a credit (optionally burning at `expiresAt`) or a debit within the balance. */
export function adjustBonuses(
  db: DbOrTx,
  clientId: number,
  input: { amount: number; note: string; expiresAt: number | null },
  employeeId: number,
  now = Date.now(),
): BonusRow {
  return db.transaction((tx) => {
    if (input.amount > 0) {
      if (input.expiresAt != null && input.expiresAt <= now) throw badRequest('Срок сгорания должен быть в будущем');
      return insertOperation(tx, { clientId, type: 'adjust', amount: input.amount, expiresAt: input.expiresAt, note: input.note, employeeId, createdAt: now });
    }
    const balance = bonusBalance(tx, clientId, now);
    if (-input.amount > balance) throw conflict(`На счёте только ${bonusesText(balance)}`);
    drawFromLots(tx, clientId, -input.amount, now);
    return insertOperation(tx, { clientId, type: 'adjust', amount: input.amount, note: input.note, employeeId, createdAt: now });
  });
}

/** Records the burning of every lot past `expiresAt` (the hourly job). */
export function expireBonusLots(db: DbOrTx, now = Date.now()): { lots: number; amount: number } {
  return db.transaction((tx) => {
    const due = tx
      .select()
      .from(bonusOperations)
      .where(and(gt(bonusOperations.remaining, 0), lte(bonusOperations.expiresAt, now)))
      .orderBy(asc(bonusOperations.id))
      .all();
    for (const lot of due) {
      tx.update(bonusOperations).set({ remaining: 0 }).where(eq(bonusOperations.id, lot.id)).run();
      // The sale that earned the lot stays on its expiry, so a later refund knows what of its earnings already burnt.
      // Other lots of a sale (bonuses a partial refund gave back) are not its earnings: their burn names no sale.
      const saleId = lot.type === 'earn' ? lot.saleId : null;
      insertOperation(tx, { clientId: lot.clientId, type: 'expire', amount: -lot.remaining, saleId, createdAt: now });
    }
    return { lots: due.length, amount: due.reduce((sum, lot) => sum + lot.remaining, 0) };
  });
}

/** Bonuses credited by each sale (`Sale.bonusEarned`; 0 when none). */
export function earnedBySales(db: DbOrTx, saleIds: number[]): Map<number, number> {
  if (saleIds.length === 0) return new Map();
  const rows = db
    .select({ saleId: bonusOperations.saleId, amount: bonusOperations.amount })
    .from(bonusOperations)
    .where(and(inArray(bonusOperations.saleId, saleIds), eq(bonusOperations.type, 'earn')))
    .all();
  return new Map(rows.map((r) => [r.saleId!, r.amount]));
}
