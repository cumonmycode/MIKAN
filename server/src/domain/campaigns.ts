import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { campaignRecipients, campaigns } from '../db/schema.js';
import { conflict, notFound } from '../lib/errors.js';
import { toIso } from '../lib/time.js';
import { insertRecipients, parseStoredSegment, type CampaignSegment } from './campaign-segment.js';
import { employeeRefOrMissing, employeesByIds } from './refs.js';

/**
 * Telegram campaigns (docs/API.md «Campaigns»): a draft is edited, then sent now (the recipients are fixed and the
 * background sender delivers them, see bot/campaign-sender.ts) or scheduled; a scheduled or sending one can be
 * cancelled. Everything here is synchronous and touches only the database.
 */

export const CAMPAIGN_STATUSES = ['draft', 'scheduled', 'sending', 'sent', 'cancelled'] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];
export type CampaignRow = typeof campaigns.$inferSelect;
export type RecipientRow = typeof campaignRecipients.$inferSelect;

export interface CampaignButton {
  text: string;
  kind: 'book' | 'url';
  /** `https://…` for `url`, null for `book`. */
  url: string | null;
}

export interface CampaignInput {
  title: string;
  text: string;
  imageUrl: string | null;
  button: CampaignButton | null;
  segment: CampaignSegment;
}

export interface CampaignStats {
  recipients: number;
  sent: number;
  failed: number;
  blocked: number;
  pending: number;
}

const EDITABLE: readonly string[] = ['draft', 'scheduled'];

export const NOT_EDITABLE_MESSAGE = 'Рассылку уже нельзя изменить: она отправляется или завершена';

export function getCampaignRow(db: DbOrTx, id: number): CampaignRow {
  const row = db.select().from(campaigns).where(eq(campaigns.id, id)).get();
  if (!row) throw notFound('Рассылка не найдена');
  return row;
}

export function parseButton(json: string | null): CampaignButton | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json) as Partial<CampaignButton> | null;
    if (!value || (value.kind !== 'book' && value.kind !== 'url') || typeof value.text !== 'string') return null;
    return { text: value.text, kind: value.kind, url: typeof value.url === 'string' ? value.url : null };
  } catch {
    return null;
  }
}

const EMPTY_STATS: CampaignStats = { recipients: 0, sent: 0, failed: 0, blocked: 0, pending: 0 };

/** Delivery counts per campaign; `recipients` also counts the ones skipped (opted out meanwhile, cancelled). */
export function campaignStats(db: DbOrTx, ids: number[]): Map<number, CampaignStats> {
  const result = new Map<number, CampaignStats>(ids.map((id) => [id, { ...EMPTY_STATS }]));
  if (ids.length === 0) return result;
  const rows = db
    .select({ campaignId: campaignRecipients.campaignId, status: campaignRecipients.status, n: sql<number>`count(*)` })
    .from(campaignRecipients)
    .where(inArray(campaignRecipients.campaignId, ids))
    .groupBy(campaignRecipients.campaignId, campaignRecipients.status)
    .all();
  for (const row of rows) {
    const stats = result.get(row.campaignId)!;
    stats.recipients += row.n;
    if (row.status === 'sent' || row.status === 'failed' || row.status === 'blocked' || row.status === 'pending') stats[row.status] += row.n;
  }
  return result;
}

export function serializeCampaigns(db: DbOrTx, rows: CampaignRow[]) {
  const stats = campaignStats(db, rows.map((r) => r.id));
  const authors = employeesByIds(db, rows.map((r) => r.createdBy));
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    text: row.text,
    imageUrl: row.imageUrl,
    button: parseButton(row.button),
    segment: parseStoredSegment(row.segment),
    status: row.status,
    scheduledAt: toIso(row.scheduledAt),
    startedAt: toIso(row.startedAt),
    finishedAt: toIso(row.finishedAt),
    stats: stats.get(row.id)!,
    createdBy: employeeRefOrMissing(authors, row.createdBy),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  }));
}

export type CampaignOut = ReturnType<typeof serializeCampaigns>[number];

export const serializeCampaign = (db: DbOrTx, row: CampaignRow): CampaignOut => serializeCampaigns(db, [row])[0]!;

export function listCampaigns(db: DbOrTx): CampaignRow[] {
  return db.select().from(campaigns).orderBy(desc(campaigns.createdAt), desc(campaigns.id)).all();
}

const stored = (input: Partial<CampaignInput>) => ({
  ...(input.title !== undefined ? { title: input.title } : {}),
  ...(input.text !== undefined ? { text: input.text } : {}),
  ...(input.imageUrl !== undefined ? { imageUrl: input.imageUrl } : {}),
  ...(input.button !== undefined ? { button: input.button ? JSON.stringify(input.button) : null } : {}),
  ...(input.segment !== undefined ? { segment: JSON.stringify(input.segment) } : {}),
});

export function createCampaign(db: DbOrTx, input: CampaignInput, employeeId: number, now = Date.now()): CampaignRow {
  return db
    .insert(campaigns)
    .values({
      title: input.title,
      text: input.text,
      imageUrl: input.imageUrl,
      button: input.button ? JSON.stringify(input.button) : null,
      segment: JSON.stringify(input.segment),
      status: 'draft',
      createdBy: employeeId,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
}

/** The campaign as it would be after the patch (for checks that span fields, e.g. the caption limit). */
export function mergedCampaign(row: CampaignRow, patch: Partial<CampaignInput>): { text: string; imageUrl: string | null } {
  return { text: patch.text ?? row.text, imageUrl: patch.imageUrl !== undefined ? patch.imageUrl : row.imageUrl };
}

export function assertEditable(row: CampaignRow): void {
  if (!EDITABLE.includes(row.status)) throw conflict(NOT_EDITABLE_MESSAGE);
}

export function updateCampaign(db: DbOrTx, id: number, patch: Partial<CampaignInput>, now = Date.now()): CampaignRow {
  const row = getCampaignRow(db, id);
  assertEditable(row);
  return db
    .update(campaigns)
    .set({ ...stored(patch), updatedAt: now })
    .where(eq(campaigns.id, id))
    .returning()
    .get();
}

export function deleteCampaign(db: DbOrTx, id: number): void {
  const row = getCampaignRow(db, id);
  if (row.status !== 'draft') throw conflict('Удалить можно только черновик — запущенную рассылку можно остановить');
  db.delete(campaigns).where(eq(campaigns.id, id)).run();
}

/** The campaign whose sending may start: a draft or a scheduled one. */
function startable(db: DbOrTx, id: number): CampaignRow {
  const row = getCampaignRow(db, id);
  if (!EDITABLE.includes(row.status)) throw conflict('Эта рассылка уже отправляется или завершена');
  return row;
}

export function scheduleCampaign(db: DbOrTx, id: number, at: number, now = Date.now()): CampaignRow {
  startable(db, id);
  return db
    .update(campaigns)
    .set({ status: 'scheduled', scheduledAt: at, updatedAt: now })
    .where(eq(campaigns.id, id))
    .returning()
    .get();
}

export const NOBODY_MESSAGE = 'Под условия рассылки не подходит ни один клиент с Telegram, который согласен получать новости';

/**
 * Fixes the recipients (the segment as it is now) and marks the campaign `sending`; the background sender takes it
 * from there. Started by staff («send now», also for a scheduled one): with nobody to send to it is refused (`409`),
 * and a planned time is dropped. Started by its schedule: with nobody to send to it ends at once as `sent`.
 */
export function startCampaign(
  db: DbOrTx,
  id: number,
  now: number,
  tz: string,
  startedBy: 'staff' | 'schedule',
): { row: CampaignRow; recipients: number } {
  return db.transaction((tx) => {
    const row = startable(tx, id);
    const recipients = insertRecipients(tx, id, parseStoredSegment(row.segment), now, tz);
    if (recipients === 0 && startedBy === 'staff') throw conflict(NOBODY_MESSAGE);
    const updated = tx
      .update(campaigns)
      .set({
        status: recipients === 0 ? 'sent' : 'sending',
        scheduledAt: startedBy === 'staff' ? null : row.scheduledAt,
        startedAt: now,
        finishedAt: recipients === 0 ? now : null,
        updatedAt: now,
      })
      .where(eq(campaigns.id, id))
      .returning()
      .get();
    return { row: updated, recipients };
  });
}

/** Stops a scheduled or sending campaign: whoever was not reached yet is `skipped`, sent messages stay. */
export function cancelCampaign(db: DbOrTx, id: number, now = Date.now()): CampaignRow {
  return db.transaction((tx) => {
    const row = getCampaignRow(tx, id);
    if (row.status !== 'scheduled' && row.status !== 'sending') throw conflict('Остановить можно только запланированную или идущую рассылку');
    tx.update(campaignRecipients)
      .set({ status: 'skipped', error: 'Рассылка остановлена' })
      .where(and(eq(campaignRecipients.campaignId, id), eq(campaignRecipients.status, 'pending')))
      .run();
    return tx
      .update(campaigns)
      .set({ status: 'cancelled', finishedAt: now, updatedAt: now })
      .where(eq(campaigns.id, id))
      .returning()
      .get();
  });
}

/** Marks a sending campaign `sent` once nobody is pending; returns the row when it just finished. */
export function finishIfDone(db: DbOrTx, id: number, now = Date.now()): CampaignRow | null {
  return db.transaction((tx) => {
    const row = tx.select().from(campaigns).where(eq(campaigns.id, id)).get();
    if (!row || row.status !== 'sending') return null;
    const pending = tx
      .select({ n: sql<number>`count(*)` })
      .from(campaignRecipients)
      .where(and(eq(campaignRecipients.campaignId, id), eq(campaignRecipients.status, 'pending')))
      .get()?.n;
    if (pending) return null;
    return tx.update(campaigns).set({ status: 'sent', finishedAt: now, updatedAt: now }).where(eq(campaigns.id, id)).returning().get();
  });
}
