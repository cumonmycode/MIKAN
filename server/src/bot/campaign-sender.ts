import { and, asc, eq, lte } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { campaignRecipients, campaigns, clients } from '../db/schema.js';
import {
  campaignStats,
  finishIfDone,
  parseButton,
  startCampaign,
  type CampaignRow,
  type CampaignStats,
  type RecipientRow,
} from '../domain/campaigns.js';
import { studioTimezone } from '../domain/settings.js';
import { AppError, errorMessage } from '../lib/errors.js';
import { BULK_MESSAGES_PER_SECOND, bulkPacer, realClock, type Clock, type Pacer } from '../lib/pacer.js';
import type { ClientRow } from '../lib/serialize.js';
import { truncate } from '../lib/text.js';
import { BotSendError, BotUnavailableError, type InlineKeyboard } from './gateway.js';
import { newsKeyboard, personalize, sendNews, storeNews } from './marketing.js';
import { notifyStaff } from './staff.js';

/**
 * Delivers campaigns in the background (docs/API.md «Campaigns»): starts scheduled ones when their time comes, sends
 * the pending recipients at ≤ 20 messages a second (shared with birthday and win-back messages), retries failures,
 * and tells the staff chat when a campaign ends. Every recipient's outcome is stored before the next one, so a
 * restart picks up where it stopped. Delivery is at least once: a send that timed out after Telegram took it is tried
 * again, so a client may rarely get a message twice.
 */

export const CAMPAIGN_TICK_MS = 5_000;
export const CAMPAIGN_RATE_PER_SECOND = BULK_MESSAGES_PER_SECOND;
/** The first try and up to 3 retries. */
export const CAMPAIGN_MAX_ATTEMPTS = 4;
/** A failed message waits this long times the tries so far: 30 s, 1 min, 1.5 min. */
export const CAMPAIGN_RETRY_DELAY_MS = 30_000;
/** At most this many messages per tick (10 s at the full rate); the rest go in the next ticks. */
const BATCH = 200;
const BLOCKED_ERROR = 'Клиент заблокировал бота или чат недоступен';

export interface CampaignRunStats {
  started: number;
  sent: number;
  failed: number;
  blocked: number;
  retried: number;
  skipped: number;
  finished: number;
}

export interface CampaignRunOptions {
  clock?: Clock;
  /** Messages this run may send at most. */
  maxMessages?: number;
}

/** One tick's tools and tallies. */
interface Run {
  ctx: AppContext;
  clock: Clock;
  pacer: Pacer;
  stats: CampaignRunStats;
  /** Recipient id → when its next try may go (in memory: after a restart failed ones are tried at once). */
  retryAt: Map<number, number>;
}

const retryTimes = new WeakMap<AppContext, Map<number, number>>();

function retryAtOf(ctx: AppContext): Map<number, number> {
  let map = retryTimes.get(ctx);
  if (!map) {
    map = new Map();
    retryTimes.set(ctx, map);
  }
  return map;
}

/** Why a fixed recipient no longer gets the message, or null. */
function skipReason(client: ClientRow | undefined): string | null {
  if (!client) return 'Клиент удалён';
  if (client.telegramChatId == null) return 'Клиент отвязал Telegram';
  if (!client.botEnabled) return 'Клиент отключил сообщения бота';
  if (client.marketingOptOut) return 'Клиент отказался от новостей';
  if (client.archived) return 'Карточка клиента в архиве';
  return null;
}

function mark(ctx: AppContext, id: number, patch: Partial<RecipientRow>): void {
  ctx.db.update(campaignRecipients).set(patch).where(eq(campaignRecipients.id, id)).run();
}

/** «📣 Рассылка «Осень» завершена» with what came of it. */
export function campaignSummary(title: string, stats: CampaignStats): string {
  if (stats.recipients === 0) return `📣 Рассылка «${title}»: под её условия не подошёл ни один клиент — ничего не отправлено`;
  const skipped = stats.recipients - stats.sent - stats.failed - stats.blocked - stats.pending;
  return [
    `📣 Рассылка «${title}» завершена`,
    `✅ Доставлено: ${stats.sent} из ${stats.recipients}`,
    ...(stats.blocked ? [`🚫 Заблокировали бота: ${stats.blocked}`] : []),
    ...(stats.failed ? [`⚠️ Не доставлено: ${stats.failed}`] : []),
    ...(skipped > 0 ? [`➖ Пропущено (отписались или отвязали Telegram): ${skipped}`] : []),
  ].join('\n');
}

async function announceFinished(ctx: AppContext, row: CampaignRow): Promise<void> {
  await notifyStaff(ctx, campaignSummary(row.title, campaignStats(ctx.db, [row.id]).get(row.id)!));
}

/** Scheduled campaigns whose time has come start now (recipients fixed as of now). */
async function startDue(run: Run): Promise<void> {
  const { ctx, stats } = run;
  const now = run.clock.now();
  const due = ctx.db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.status, 'scheduled'), lte(campaigns.scheduledAt, now)))
    .orderBy(asc(campaigns.scheduledAt), asc(campaigns.id))
    .all();
  const tz = studioTimezone(ctx.db);
  for (const campaign of due) {
    let row: CampaignRow;
    try {
      row = startCampaign(ctx.db, campaign.id, now, tz, 'schedule').row;
    } catch (err) {
      // Staff started or cancelled it at this very moment: nothing to do.
      const raced = err instanceof AppError && err.code === 'conflict';
      ctx.log[raced ? 'warn' : 'error']({ campaignId: campaign.id, err: errorMessage(err) }, 'scheduled campaign did not start');
      continue;
    }
    stats.started += 1;
    if (row.status === 'sent') {
      stats.finished += 1;
      await announceFinished(ctx, row);
    }
  }
}

const isSending = (ctx: AppContext, id: number) =>
  ctx.db.select({ status: campaigns.status }).from(campaigns).where(eq(campaigns.id, id)).get()?.status === 'sending';

const recipientRow = (ctx: AppContext, id: number) => ctx.db.select().from(campaignRecipients).where(eq(campaignRecipients.id, id)).get();

/** `done` — the outcome is stored; `stop` — the bot went offline or Telegram asked to wait, nothing counted. */
type SendOutcome = 'done' | 'stop';

/** Stores a failed try: blocked, out of tries, or waiting for its next one. */
function noteFailure(run: Run, campaign: CampaignRow, recipient: RecipientRow, chatId: number, err: unknown): void {
  const { ctx, stats } = run;
  const attempts = recipient.attempts + 1;
  if (err instanceof BotSendError && err.blocked) {
    mark(ctx, recipient.id, { status: 'blocked', attempts, error: BLOCKED_ERROR, chatId });
    stats.blocked += 1;
    run.retryAt.delete(recipient.id);
  } else if (attempts >= CAMPAIGN_MAX_ATTEMPTS) {
    mark(ctx, recipient.id, { status: 'failed', attempts, error: truncate(errorMessage(err), 500), chatId });
    stats.failed += 1;
    run.retryAt.delete(recipient.id);
  } else {
    mark(ctx, recipient.id, { attempts, error: truncate(errorMessage(err), 500) });
    stats.retried += 1;
    run.retryAt.set(recipient.id, run.clock.now() + attempts * CAMPAIGN_RETRY_DELAY_MS);
  }
  ctx.log.warn({ campaignId: campaign.id, clientId: recipient.clientId, attempts, err: errorMessage(err) }, 'campaign message not delivered');
}

/** Sends one message; the recipient's outcome is stored at once. */
async function deliverOne(run: Run, campaign: CampaignRow, keyboard: InlineKeyboard, recipient: RecipientRow, client: ClientRow): Promise<SendOutcome> {
  const { ctx } = run;
  const chatId = client.telegramChatId!;
  try {
    const stored = await sendNews(ctx, chatId, { text: personalize(campaign.text, client.name), imageUrl: campaign.imageUrl, keyboard });
    mark(ctx, recipient.id, { status: 'sent', attempts: recipient.attempts + 1, error: null, sentAt: run.clock.now(), chatId });
    storeNews(ctx.db, chatId, client.id, stored);
    run.stats.sent += 1;
    run.retryAt.delete(recipient.id);
    return 'done';
  } catch (err) {
    if (err instanceof BotUnavailableError) return 'stop';
    if (err instanceof BotSendError && err.retryAfterMs !== null) {
      run.pacer.holdFor(err.retryAfterMs);
      ctx.log.warn({ campaignId: campaign.id, retryAfterMs: err.retryAfterMs }, 'Telegram flood limit: campaign paused');
      return 'stop';
    }
    noteFailure(run, campaign, recipient, chatId, err);
    return 'done';
  }
}

/**
 * Sends up to `budget` pending messages of one campaign: fresh recipients first, then retries whose time has come.
 * Stops when the campaign is cancelled meanwhile. Returns how many messages went to Telegram and whether to stop.
 */
async function deliverCampaign(run: Run, campaign: CampaignRow, budget: number): Promise<{ attempted: number; stop: boolean }> {
  const { ctx } = run;
  const keyboard = newsKeyboard(ctx, parseButton(campaign.button));
  const batch = ctx.db
    .select()
    .from(campaignRecipients)
    .where(and(eq(campaignRecipients.campaignId, campaign.id), eq(campaignRecipients.status, 'pending')))
    .orderBy(asc(campaignRecipients.attempts), asc(campaignRecipients.id))
    .limit(budget)
    .all();
  let attempted = 0;
  for (const listed of batch) {
    if (!ctx.gateway.isRunning()) return { attempted, stop: true };
    if ((run.retryAt.get(listed.id) ?? 0) > run.clock.now()) continue;
    const client = ctx.db.select().from(clients).where(eq(clients.id, listed.clientId)).get();
    const reason = skipReason(client);
    if (!reason) await run.pacer.wait();
    // Checked after the wait: a cancel that came meanwhile stops the campaign before its next message.
    if (!isSending(ctx, campaign.id)) break;
    const recipient = recipientRow(ctx, listed.id);
    if (recipient?.status !== 'pending') continue;
    if (reason || !client) {
      mark(ctx, recipient.id, { status: 'skipped', error: reason });
      run.stats.skipped += 1;
      continue;
    }
    attempted += 1;
    if ((await deliverOne(run, campaign, keyboard, recipient, client)) === 'stop') return { attempted, stop: true };
  }
  return { attempted, stop: false };
}

/** One tick of the background sender (every CAMPAIGN_TICK_MS). Does nothing while the bot is offline or held. */
export async function runCampaigns(ctx: AppContext, options: CampaignRunOptions = {}): Promise<CampaignRunStats> {
  const clock = options.clock ?? realClock;
  const stats: CampaignRunStats = { started: 0, sent: 0, failed: 0, blocked: 0, retried: 0, skipped: 0, finished: 0 };
  const run: Run = { ctx, clock, pacer: bulkPacer(clock), stats, retryAt: retryAtOf(ctx) };
  if (!ctx.gateway.isRunning() || run.pacer.isHeld()) return stats;
  await startDue(run);
  let budget = options.maxMessages ?? BATCH;
  const sending = ctx.db
    .select()
    .from(campaigns)
    .where(eq(campaigns.status, 'sending'))
    .orderBy(asc(campaigns.startedAt), asc(campaigns.id))
    .all();
  for (const campaign of sending) {
    if (budget <= 0) break;
    const outcome = await deliverCampaign(run, campaign, budget);
    budget -= outcome.attempted;
    if (outcome.stop) break;
    const finished = finishIfDone(ctx.db, campaign.id, clock.now());
    if (finished) {
      stats.finished += 1;
      await announceFinished(ctx, finished);
    }
  }
  return stats;
}
