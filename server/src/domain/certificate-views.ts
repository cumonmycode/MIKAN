import { asc, desc, inArray } from 'drizzle-orm';
import { DateTime } from 'luxon';
import type { AppContext } from '../context.js';
import type { DbOrTx } from '../db/client.js';
import { certificateOperations, giftCertificates, sales } from '../db/schema.js';
import { badRequest, conflict } from '../lib/errors.js';
import { clientRef } from '../lib/serialize.js';
import { formatRub, normalizeSearchTerm } from '../lib/text.js';
import { toIso } from '../lib/time.js';
import { findChat, findClientChat, storeMessage, upsertChat } from './bot-chats.js';
import { findCertificateByCode, getCertificateRow, normalizeCertificateCode, statusOf, type CertificateRow, type CertificateStatus } from './certificates.js';
import { deliveryProblem } from './deposit-messages.js';
import { clientsByIds, getClientRow } from './refs.js';
import { getStudioSettings, studioTimezone } from './settings.js';

/** Gift certificates as staff, clients and the bot see them: the list, the card, the Telegram message. */

function saleNumbers(db: DbOrTx, ids: Array<number | null>): Map<number, number> {
  const list = [...new Set(ids.filter((id): id is number => id != null))];
  if (list.length === 0) return new Map();
  return new Map(db.select({ id: sales.id, number: sales.number }).from(sales).where(inArray(sales.id, list)).all().map((s) => [s.id, s.number]));
}

export function serializeCertificates(db: DbOrTx, rows: CertificateRow[], now = Date.now()) {
  if (rows.length === 0) return [];
  const ops = db
    .select()
    .from(certificateOperations)
    .where(inArray(certificateOperations.certificateId, rows.map((r) => r.id)))
    .orderBy(asc(certificateOperations.createdAt), asc(certificateOperations.id))
    .all();
  const numbers = saleNumbers(db, [...rows.map((r) => r.saleId), ...ops.map((op) => op.saleId)]);
  const buyers = clientsByIds(db, rows.map((r) => r.buyerClientId));
  return rows.map((r) => {
    const buyer = r.buyerClientId != null ? buyers.get(r.buyerClientId) : undefined;
    return {
      id: r.id,
      code: r.code,
      amount: r.amount,
      balance: r.balance,
      status: statusOf(r, now),
      expiresAt: toIso(r.expiresAt),
      buyer: buyer ? clientRef(buyer) : null,
      recipientName: r.recipientName,
      note: r.note,
      saleId: r.saleId,
      saleNumber: r.saleId != null ? (numbers.get(r.saleId) ?? null) : null,
      operations: ops
        .filter((op) => op.certificateId === r.id)
        .map((op) => ({
          type: op.type,
          amount: op.amount,
          saleId: op.saleId,
          saleNumber: op.saleId != null ? (numbers.get(op.saleId) ?? null) : null,
          createdAt: toIso(op.createdAt),
        })),
      createdAt: toIso(r.createdAt),
    };
  });
}

export function serializeCertificate(db: DbOrTx, row: CertificateRow, now = Date.now()) {
  return serializeCertificates(db, [row], now)[0]!;
}

/** Whether a certificate matches the search: its code (any part, dashes and case ignored) or the recipient. */
function matches(row: CertificateRow, q: string): boolean {
  const compactQuery = q.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (compactQuery && row.code.replace(/-/g, '').includes(compactQuery)) return true;
  const recipient = row.recipientName ? normalizeSearchTerm(row.recipientName) : '';
  return recipient !== '' && recipient.includes(normalizeSearchTerm(q));
}

/** `GET /certificates`: newest first, by status (as of now) and a code or recipient search. */
export function listCertificates(
  db: DbOrTx,
  f: { status?: CertificateStatus; q?: string; limit: number; offset: number },
  now = Date.now(),
) {
  // A studio sells a handful a month: filtering in memory keeps the status-as-of-now and Cyrillic search exact.
  const all = db.select().from(giftCertificates).orderBy(desc(giftCertificates.createdAt), desc(giftCertificates.id)).all();
  const q = f.q?.trim() ?? '';
  const found = all.filter((row) => (!f.status || statusOf(row, now) === f.status) && (!q || matches(row, q)));
  return { items: serializeCertificates(db, found.slice(f.offset, f.offset + f.limit), now), total: found.length };
}

const formatUntil = (ms: number, tz: string): string => DateTime.fromMillis(ms, { zone: tz }).setLocale('ru').toFormat('d MMMM yyyy');

/**
 * «🎁 Подарочный сертификат MIKAN STUDIO на 5 000 ₽ · код MIKAN-7K3Q-9F2D · действует до 19 октября 2027», with the
 * recipient and what is left when it was partly spent.
 */
export function certificateCardText(db: DbOrTx, row: CertificateRow): string {
  const studio = getStudioSettings(db);
  const parts = [
    `🎁 Подарочный сертификат ${studio.name} на ${formatRub(row.amount)}`,
    `код ${row.code}`,
    row.expiresAt != null ? `действует до ${formatUntil(row.expiresAt, studio.timezone)}` : 'бессрочный',
  ];
  const lines = [parts.join(' · ')];
  if (row.balance < row.amount) lines.push(`Осталось ${formatRub(row.balance)}`);
  if (row.recipientName) lines.push(`Кому: ${row.recipientName}`);
  return lines.join('\n');
}

/**
 * `POST /certificates/:id/send`: the bot sends the certificate card to `chatId`, else to the buyer's chat. The copy
 * is kept in that conversation; an anonymous chat becomes the buyer's.
 */
export async function sendCertificate(ctx: AppContext, id: number, chatId: number | null): Promise<void> {
  const { db } = ctx;
  const row = getCertificateRow(db, id);
  if (statusOf(row, Date.now()) !== 'active') throw conflict(`Сертификат ${row.code} уже не действует — отправлять нечего`);
  let target = chatId;
  if (target != null && !findChat(db, target)) throw badRequest('Чат Telegram не найден');
  if (target == null && row.buyerClientId != null) target = findClientChat(db, getClientRow(db, row.buyerClientId))?.chatId ?? null;
  if (target == null) {
    throw conflict('Покупатель не писал боту в Telegram — выберите чат или поделитесь сертификатом другим способом');
  }
  if (!ctx.gateway.isRunning()) throw conflict('Telegram-бот выключен — поделитесь сертификатом другим способом');
  const text = certificateCardText(db, row);
  try {
    await ctx.gateway.sendText(target, text);
  } catch (err) {
    throw conflict(deliveryProblem(err));
  }
  const owner = findChat(db, target)?.clientId ?? null;
  upsertChat(db, target, owner == null && row.buyerClientId != null ? { clientId: row.buyerClientId } : {});
  storeMessage(db, target, 'system', text);
}

/** What the bot may tell a client about a certificate by its code: balance and validity, never the buyer. */
export function certificateBalanceText(db: DbOrTx, code: string, now = Date.now()): { text: string; found: boolean } {
  const normalized = normalizeCertificateCode(code);
  const row = normalized ? findCertificateByCode(db, normalized) : null;
  if (!row) return { found: false, text: 'Сертификат с таким кодом не найден. Попроси клиента проверить код (формат MIKAN-XXXX-XXXX).' };
  const tz = studioTimezone(db);
  const status = statusOf(row, now);
  const until = row.expiresAt != null ? `до ${formatUntil(row.expiresAt, tz)}` : 'бессрочно';
  const texts: Record<CertificateStatus, string> = {
    active: `Сертификат ${row.code} действует ${until}: на нём ${formatRub(row.balance)} из ${formatRub(row.amount)}. Оплатить им можно в студии.`,
    used: `Сертификат ${row.code} уже полностью использован.`,
    expired: `Срок действия сертификата ${row.code} истёк${row.expiresAt != null ? ` ${formatUntil(row.expiresAt, tz)}` : ''}.`,
    cancelled: `Сертификат ${row.code} аннулирован. Подробности — у администратора.`,
  };
  return { found: true, text: texts[status] };
}
