import { asc, eq, inArray } from 'drizzle-orm';
import { DateTime } from 'luxon';
import type { AppContext } from '../context.js';
import type { DbOrTx } from '../db/client.js';
import { saleItems, saleRefundItems, saleRefunds, sales } from '../db/schema.js';
import { badRequest, conflict, errorMessage } from '../lib/errors.js';
import type { ClientRow, SaleRow } from '../lib/serialize.js';
import { formatAmount, formatRub } from '../lib/text.js';
import { findChat, findClientChat, storeMessage, upsertChat } from './bot-chats.js';
import { deliveryProblem, sendToClientChat } from './deposit-messages.js';
import { announceBonusEarned, saleBonusLine } from './loyalty.js';
import { getClientRow, getSaleRow } from './refs.js';
import { getStudioSettings } from './settings.js';

/**
 * The client's Telegram messages about a sale (docs/API.md «Receipt in Telegram»): the receipt after a paid sale
 * and the notice of a refund. Both never throw — the sale or refund is already recorded; staff can resend the receipt.
 */

type RefundRow = typeof saleRefunds.$inferSelect;
/** How a sale was paid, or how a refund gave the money back (the same columns on both). */
type PayParts = Pick<SaleRow, 'payCash' | 'payCard' | 'payTransfer' | 'payQr' | 'payDeposit' | 'payBonus' | 'payCertificate'>;
type PartWords = ReadonlyArray<readonly [keyof PayParts, string]>;

const PAID_WITH: PartWords = [
  ['payCash', 'наличными'],
  ['payCard', 'картой'],
  ['payTransfer', 'переводом'],
  ['payQr', 'по QR'],
  ['payDeposit', 'предоплатой'],
  ['payBonus', 'бонусами'],
  ['payCertificate', 'сертификатом'],
];
/** Bonuses paid that come back are told on their own line («Бонусы вернули: +300»). */
const RETURNED_TO: PartWords = [
  ['payCash', 'наличными'],
  ['payCard', 'на карту'],
  ['payTransfer', 'переводом'],
  ['payQr', 'по СБП'],
  ['payDeposit', 'в предоплату записи'],
  ['payCertificate', 'на сертификат'],
];

/** «наличными 3 100 ₽, предоплатой 2 000 ₽» — the parts that are not 0. */
const partsText = (row: PayParts, words: PartWords): string =>
  words
    .filter(([key]) => row[key] > 0)
    .map(([key, word]) => `${word} ${formatRub(row[key])}`)
    .join(', ');

/** «Серьга × 2 — 1 600 ₽» (no «× 1»). */
const lineText = (name: string, quantity: number, amount: number): string =>
  `${quantity > 1 ? `${name} × ${quantity}` : name} — ${formatRub(amount)}`;

/** «20 октября, 15:42» (with the year when it is not the current one); `time: false` — the day only. */
function whenText(ms: number, tz: string, now: number, time = true): string {
  const at = DateTime.fromMillis(ms, { zone: tz }).setLocale('ru');
  const day = at.year === DateTime.fromMillis(now, { zone: tz }).year ? 'd MMMM' : 'd MMMM yyyy';
  return at.toFormat(time ? `${day}, HH:mm` : day);
}

function refundsOf(db: DbOrTx, saleId: number): RefundRow[] {
  return db.select().from(saleRefunds).where(eq(saleRefunds.saleId, saleId)).orderBy(asc(saleRefunds.createdAt), asc(saleRefunds.id)).all();
}

/** The lines refunds returned, in order: name, units and what they returned. */
function refundItems(db: DbOrTx, refundIds: number[]) {
  if (refundIds.length === 0) return [];
  return db
    .select({ refundId: saleRefundItems.refundId, quantity: saleRefundItems.quantity, amount: saleRefundItems.amount, name: saleItems.name })
    .from(saleRefundItems)
    .innerJoin(saleItems, eq(saleItems.id, saleRefundItems.saleItemId))
    .where(inArray(saleRefundItems.refundId, refundIds))
    .orderBy(asc(saleRefundItems.id))
    .all();
}

/** «↩️ Возврат 21 октября: −1 350 ₽ (Лабрет — 8 мм)» per refund, oldest first. */
function refundLines(db: DbOrTx, saleId: number, tz: string, now: number): string[] {
  const refunds = refundsOf(db, saleId);
  const items = refundItems(db, refunds.map((r) => r.id));
  return refunds.map((r) => {
    const what = items.filter((i) => i.refundId === r.id).map((i) => (i.quantity > 1 ? `${i.name} × ${i.quantity}` : i.name));
    return `↩️ Возврат ${whenText(r.createdAt, tz, now, false)}: −${formatRub(r.amount)}${what.length ? ` (${what.join(', ')})` : ''}`;
  });
}

/**
 * The receipt as the client reads it: lines, discount, total, how it was paid, refunds made so far, the loyalty
 * notice when given, thanks.
 */
function receiptText(db: DbOrTx, sale: SaleRow, bonusLine: string | null, now = Date.now()): string {
  const studio = getStudioSettings(db);
  const items = db.select().from(saleItems).where(eq(saleItems.saleId, sale.id)).orderBy(asc(saleItems.id)).all();
  const lines = [`🧾 Чек №${sale.number} · ${studio.name}`, whenText(sale.createdAt, studio.timezone, now), ''];
  lines.push(...items.map((item) => lineText(item.name, item.quantity, item.total)));
  if (sale.discount > 0) lines.push(`Скидка: −${formatRub(sale.discount)}`);
  lines.push(`**Итого: ${formatRub(sale.total)}**`);
  const paid = partsText(sale, PAID_WITH);
  if (paid) lines.push(`Оплата: ${paid}`);
  lines.push(...refundLines(db, sale.id, studio.timezone, now), '');
  if (bonusLine) lines.push(bonusLine);
  lines.push('Спасибо, что пришли к нам! 🧡');
  return lines.join('\n');
}

/** «↩️ Возврат по чеку №17», the returned lines, how the money went back and what happened to the bonuses. */
function refundNoticeText(db: DbOrTx, sale: SaleRow, refund: RefundRow): string {
  const items = refundItems(db, [refund.id]);
  const lines = [`↩️ Возврат по чеку №${sale.number}`, ...items.map((i) => lineText(i.name, i.quantity, i.amount))];
  const returned = partsText(refund, RETURNED_TO);
  if (returned) lines.push(`Вернули: ${returned}`);
  if (refund.bonusTakenBack > 0) lines.push(`Бонусы: −${formatAmount(refund.bonusTakenBack)}`);
  if (refund.payBonus > 0) lines.push(`Бонусы вернули: +${formatAmount(refund.payBonus)}`);
  return lines.join('\n');
}

/** The client the bot may write to about a sale on its own: Telegram linked, the bot on for them, not archived. */
function reachableClient(db: DbOrTx, sale: SaleRow): (ClientRow & { telegramChatId: number }) | null {
  if (sale.clientId == null) return null;
  const client = getClientRow(db, sale.clientId);
  if (client.telegramChatId == null || !client.botEnabled || client.archived) return null;
  return { ...client, telegramChatId: client.telegramChatId };
}

function markSent(db: DbOrTx, saleId: number, at: number): SaleRow {
  return db.update(sales).set({ receiptSentAt: at }).where(eq(sales.id, saleId)).returning().get()!;
}

/**
 * After a paid sale: the receipt with the loyalty notice in the client's linked chat, when `pos.sendReceipt`; with
 * it off, only the loyalty notice goes, as its own message (see `announceBonusEarned`).
 */
export async function sendSaleReceipt(ctx: AppContext, saleId: number): Promise<void> {
  try {
    const { db } = ctx;
    if (!getStudioSettings(db).pos.sendReceipt) {
      await announceBonusEarned(ctx, saleId);
      return;
    }
    const sale = getSaleRow(db, saleId);
    const client = reachableClient(db, sale);
    if (!client || !ctx.gateway.isRunning()) return;
    const now = Date.now();
    await sendToClientChat(ctx, client.telegramChatId, client.id, receiptText(db, sale, saleBonusLine(db, sale.id, now), now));
    markSent(db, sale.id, Date.now());
  } catch (err) {
    ctx.log.warn({ err: errorMessage(err), saleId }, 'sale receipt not delivered');
  }
}

/** After a refund: what came back, in the client's linked chat (same conditions as the receipt). */
export async function sendRefundNotice(ctx: AppContext, refundId: number): Promise<void> {
  try {
    const { db } = ctx;
    if (!getStudioSettings(db).pos.sendReceipt || !ctx.gateway.isRunning()) return;
    const refund = db.select().from(saleRefunds).where(eq(saleRefunds.id, refundId)).get();
    if (!refund) return;
    const sale = getSaleRow(db, refund.saleId);
    const client = reachableClient(db, sale);
    if (!client) return;
    await sendToClientChat(ctx, client.telegramChatId, client.id, refundNoticeText(db, sale, refund));
  } catch (err) {
    ctx.log.warn({ err: errorMessage(err), refundId }, 'refund notice not delivered');
  }
}

/** Where staff send a receipt: the chat they chose, else the client's (the linked one, else the latest). */
function receiptChat(db: DbOrTx, sale: SaleRow, chatId: number | null): number {
  if (chatId != null) {
    if (!findChat(db, chatId)) throw badRequest('Чат Telegram не найден');
    return chatId;
  }
  if (sale.clientId == null) throw conflict('В чеке нет клиента');
  const chat = findClientChat(db, getClientRow(db, sale.clientId));
  if (!chat) throw conflict('У клиента нет Telegram — отправить чек некуда');
  return chat.chatId;
}

/**
 * `POST /sales/:id/send`: staff send (or resend) the receipt, without the loyalty notice. The copy is kept in that
 * conversation; an anonymous chat becomes the sale's client's.
 */
export async function sendReceiptByStaff(ctx: AppContext, saleId: number, chatId: number | null): Promise<SaleRow> {
  const { db } = ctx;
  const sale = getSaleRow(db, saleId);
  const target = receiptChat(db, sale, chatId);
  if (!ctx.gateway.isRunning()) throw conflict('Telegram-бот выключен — чек не отправлен');
  const text = receiptText(db, sale, null);
  try {
    await ctx.gateway.sendText(target, text);
  } catch (err) {
    throw conflict(deliveryProblem(err));
  }
  const owner = findChat(db, target)?.clientId ?? null;
  upsertChat(db, target, owner == null && sale.clientId != null ? { clientId: sale.clientId } : {});
  storeMessage(db, target, 'system', text);
  return markSent(db, sale.id, Date.now());
}
