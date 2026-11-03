import { and, eq, getTableName, sql } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { DbOrTx } from '../db/client.js';
import {
  appointments,
  auditLog,
  bonusOperations,
  bookingRequests,
  botChats,
  campaignRecipients,
  clientAccessTokens,
  clients,
  giftCertificates,
  openReceipts,
  qrPayments,
  retentionSends,
  sales,
  scheduledMessages,
  waitlistEntries,
} from '../db/schema.js';
import { badRequest } from '../lib/errors.js';
import type { ClientRow } from '../lib/serialize.js';
import { searchKey } from '../lib/text.js';
import { moveDismissedPairs } from './client-duplicates.js';
import { CLIENT_NOTES_MAX, derivedClientFields } from './clients.js';
import { getClientRow } from './refs.js';
import { syncRemindersForClient } from './scheduling.js';

/**
 * Merging two client cards (docs/API.md «Clients» → «Merge»): everything of the source moves to the kept card, the
 * kept card's empty fields take the source's values, then the source is deleted — in one transaction.
 */

const ref = (table: SQLiteTable, column: SQLiteColumn) => ({ table: getTableName(table), column: column.name });

/** Columns simply re-pointed at the kept card. */
const MOVED = [
  ref(appointments, appointments.clientId),
  ref(sales, sales.clientId),
  ref(openReceipts, openReceipts.clientId),
  ref(botChats, botChats.clientId),
  ref(scheduledMessages, scheduledMessages.clientId),
  ref(bookingRequests, bookingRequests.clientId),
  ref(bonusOperations, bonusOperations.clientId),
  ref(giftCertificates, giftCertificates.buyerClientId),
  ref(waitlistEntries, waitlistEntries.clientId),
  ref(clientAccessTokens, clientAccessTokens.clientId),
];

/**
 * Every column that points at a client (a test checks it against the schema's foreign keys): the plain moves and the
 * rows unique per client, where the kept card may already have one.
 */
export const CLIENT_REFERENCES: ReadonlyArray<{ table: string; column: string }> = [
  ...MOVED,
  ref(campaignRecipients, campaignRecipients.clientId),
  ref(retentionSends, retentionSends.clientId),
];

const MERGE_SELF_MESSAGE = 'Нельзя объединить карточку саму с собой';
const NOTES_TOO_LONG_MESSAGE = `Заметки двух карточек вместе длиннее ${CLIENT_NOTES_MAX} символов — сократите их и повторите`;

const filled = (value: string | null): string | null => (value?.trim() ? value : null);
const fill = (kept: string | null, source: string | null): string | null => filled(kept) ?? filled(source);

/** Both texts, the kept card's first; a text the other already contains is not repeated. */
function joinNotes(kept: string | null, source: string | null): string | null {
  const a = kept?.trim() || null;
  const b = source?.trim() || null;
  if (!a || !b) return a ?? b;
  if (a.includes(b)) return a;
  if (b.includes(a)) return b;
  return `${a}\n\n${b}`;
}

/** Joining made the notes longer than a card may hold (the app could not save the card afterwards). */
function notesTooLong(kept: ClientRow, source: ClientRow, joined: string | null): boolean {
  const length = joined?.length ?? 0;
  return length > CLIENT_NOTES_MAX && length > Math.max(kept.notes?.length ?? 0, source.notes?.length ?? 0);
}

/** The words after the first of an older card that holds the whole name in `name` («Анна Иванова»). */
const lastNameInName = (name: string): string | null => filled(name.trim().split(/\s+/).slice(1).join(' '));

/**
 * The source's last name (its `lastName`, or what follows the first name in an older card's `name`), unless the kept
 * card already spells it in its own `name`.
 */
function lastNameOf(kept: ClientRow, source: ClientRow): string | null {
  if (filled(kept.lastName)) return kept.lastName;
  const last = filled(source.lastName) ?? lastNameInName(source.name);
  if (!last) return null;
  const words = searchKey(kept.name).split(' ');
  return searchKey(last)
    .split(' ')
    .every((w) => words.includes(w))
    ? null
    : last;
}

/**
 * The Telegram link: the kept card's own; else the source's (with its username); with neither linked, a link sent
 * to the source but not opened yet keeps working for the kept card.
 */
function telegramOf(kept: ClientRow, source: ClientRow) {
  if (kept.telegramChatId != null) {
    return { telegramChatId: kept.telegramChatId, telegramUsername: kept.telegramUsername, linkToken: kept.linkToken };
  }
  if (source.telegramChatId != null) {
    return { telegramChatId: source.telegramChatId, telegramUsername: source.telegramUsername, linkToken: kept.linkToken };
  }
  return {
    telegramChatId: null,
    telegramUsername: fill(kept.telegramUsername, source.telegramUsername),
    linkToken: kept.linkToken ?? source.linkToken,
  };
}

/**
 * The kept card after the merge. Besides the contract's fills: a «no news» request of either card stays, the card is
 * archived only when both were, and it dates from the earlier card.
 */
export function mergedClientFields(kept: ClientRow, source: ClientRow) {
  const next = {
    name: kept.name,
    lastName: lastNameOf(kept, source),
    phone: fill(kept.phone, source.phone),
    instagram: fill(kept.instagram, source.instagram),
    telegramNick: fill(kept.telegramNick, source.telegramNick),
    ...telegramOf(kept, source),
  };
  return {
    ...next,
    ...derivedClientFields(next),
    birthday: fill(kept.birthday, source.birthday),
    source: fill(kept.source, source.source),
    notes: joinNotes(kept.notes, source.notes),
    marketingOptOut: kept.marketingOptOut || source.marketingOptOut,
    archived: kept.archived && source.archived,
    createdAt: Math.min(kept.createdAt, source.createdAt),
  };
}

/** Campaign rows by how far they got: the kept one is the one already delivered (so nobody gets it twice). */
const RECIPIENT_RANK: Record<string, number> = { sent: 4, blocked: 3, failed: 2, skipped: 1, pending: 0 };
const rank = (status: string): number => RECIPIENT_RANK[status] ?? 0;

/** One recipient row per campaign and client: of two, the one that got further stays. */
function moveCampaignRecipients(tx: DbOrTx, sourceId: number, keptId: number): void {
  const rows = tx.select().from(campaignRecipients).where(eq(campaignRecipients.clientId, sourceId)).all();
  for (const row of rows) {
    const existing = tx
      .select()
      .from(campaignRecipients)
      .where(and(eq(campaignRecipients.campaignId, row.campaignId), eq(campaignRecipients.clientId, keptId)))
      .get();
    if (existing && rank(existing.status) >= rank(row.status)) {
      tx.delete(campaignRecipients).where(eq(campaignRecipients.id, row.id)).run();
      continue;
    }
    if (existing) tx.delete(campaignRecipients).where(eq(campaignRecipients.id, existing.id)).run();
    tx.update(campaignRecipients).set({ clientId: keptId }).where(eq(campaignRecipients.id, row.id)).run();
  }
}

function moveReferences(tx: DbOrTx, sourceId: number, keptId: number): void {
  for (const { table, column } of MOVED) {
    tx.run(sql`update ${sql.identifier(table)} set ${sql.identifier(column)} = ${keptId} where ${sql.identifier(column)} = ${sourceId}`);
  }
  moveCampaignRecipients(tx, sourceId, keptId);
  // A birthday or win-back already sent for the same period is the same fact: the kept card's row stays.
  tx.run(sql`update or ignore ${retentionSends} set client_id = ${keptId} where client_id = ${sourceId}`);
  tx.delete(retentionSends).where(eq(retentionSends.clientId, sourceId)).run();
  tx.update(auditLog)
    .set({ entityId: keptId })
    .where(and(eq(auditLog.entity, 'client'), eq(auditLog.entityId, sourceId)))
    .run();
  // A checkout QR code not paid yet sells its cart to the client in it once the bank confirms.
  tx.run(sql`update ${qrPayments} set sale_input_json = json_set(sale_input_json, '$.clientId', ${keptId})
    where sale_input_json is not null and json_valid(sale_input_json) and json_extract(sale_input_json, '$.clientId') = ${sourceId}`);
}

/** `POST /clients/:id/merge`: merges card `sourceId` into `keptId` and returns the kept card. */
export function mergeClients(db: DbOrTx, sourceId: number, keptId: number): ClientRow {
  if (sourceId === keptId) throw badRequest(MERGE_SELF_MESSAGE);
  return db.transaction((tx) => {
    const source = getClientRow(tx, sourceId);
    const kept = getClientRow(tx, keptId);
    const fields = mergedClientFields(kept, source);
    if (notesTooLong(kept, source, fields.notes)) throw badRequest(NOTES_TOO_LONG_MESSAGE);
    moveReferences(tx, sourceId, keptId);
    // The source goes first: its phone, chat and link token are unique and may move to the kept card.
    tx.delete(clients).where(eq(clients.id, sourceId)).run();
    const now = Date.now();
    const row = tx
      .update(clients)
      .set({ ...fields, updatedAt: now })
      .where(eq(clients.id, keptId))
      .returning()
      .get()!;
    moveDismissedPairs(tx, sourceId, keptId);
    // Reminders of the upcoming visits now go to the kept card's chat (or are created when it got the link).
    syncRemindersForClient(tx, keptId, now);
    return row;
  });
}
