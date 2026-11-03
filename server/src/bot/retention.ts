import { DateTime } from 'luxon';
import type { AppContext } from '../context.js';
import { giftBonusExpiry, grantGiftBonuses } from '../domain/gift-bonuses.js';
import {
  birthdayCandidates,
  claimRetentionSend,
  releaseRetentionSend,
  winbackCandidates,
  winbacksToday,
  type RetentionCandidate,
  type RetentionKind,
} from '../domain/retention-audience.js';
import { getRetentionSettings, type RetentionSettings } from '../domain/retention-settings.js';
import { studioTimezone } from '../domain/settings.js';
import { errorMessage } from '../lib/errors.js';
import { bulkPacer, realClock, type Clock, type Pacer } from '../lib/pacer.js';
import { formatAmount, pluralWord } from '../lib/text.js';
import { HOUR_MS, localDayBounds, parseTimeOfDay } from '../lib/time.js';
import { BotSendError, BotUnavailableError, type InlineKeyboard } from './gateway.js';
import { newsKeyboard, personalize, sendNews, storeNews } from './marketing.js';
import { notifyStaff } from './staff.js';

/**
 * Birthday greetings and win-back messages (docs/API.md «Birthday and win-back»), checked every minute: each goes out
 * at its `sendAt` studio time (not later than RETENTION_GRACE_MS after it, e.g. after a restart). A send is logged in
 * `retention_sends` before it goes out, so neither a restart nor a parallel run repeats it; a delivery failure frees
 * the log for the next minute, up to RETENTION_MAX_ATTEMPTS tries, and Telegram's flood limit holds every bulk sender.
 * The gift bonuses are credited once the message is delivered; if that fails, the staff chat is asked to do it.
 */

export const RETENTION_CHECK_INTERVAL_MS = 60_000;
export const RETENTION_GRACE_MS = 6 * HOUR_MS;
/** The first try and up to 3 retries (one a minute). */
export const RETENTION_MAX_ATTEMPTS = 4;

export const GIFT_NOTES = { birthday: 'Подарок на день рождения', winback: 'Подарок: давно не виделись' } as const;
/** «в подарок на день рождения» — what a gift was for, in the staff alert. */
const GIFT_REASONS = { birthday: 'на день рождения', winback: 'к сообщению «давно не виделись»' } as const;

export interface RetentionRunStats {
  birthday: number;
  winback: number;
}

export interface RetentionRunOptions {
  now?: number;
  clock?: Clock;
}

interface Gift {
  amount: number;
  days: number;
}

/** Failed tries per send (`kind:client:period`) of each app context; a restart starts the count again. */
const failures = new WeakMap<AppContext, Map<string, number>>();

/** Whether a message set for `sendAt` is due now (studio time, within the grace period of today). */
export function isDue(sendAt: string, now: number, tz: string): boolean {
  const minutes = parseTimeOfDay(sendAt);
  if (minutes === null) return false;
  const moment = DateTime.fromMillis(localDayBounds(now, tz).start, { zone: tz }).plus({ minutes }).toMillis();
  return now >= moment && now < moment + RETENTION_GRACE_MS;
}

const dayMonth = (date: string) => DateTime.fromISO(date, { zone: 'utc' }).setLocale('ru').toFormat('d MMMM');
const bonusWords = (n: number) => `${formatAmount(n)} ${pluralWord(n, 'бонус', 'бонуса', 'бонусов')}`;

/** Gift bonuses only while the loyalty programme is on: otherwise they could not be spent. */
function giftOf(settings: RetentionSettings, amount: number, days: number): Gift | null {
  return settings.loyalty.enabled && amount > 0 ? { amount, days } : null;
}

/** «🎁 Дарим 500 бонусов — они действуют до 2 ноября» */
const giftLine = (gift: Gift, now: number, tz: string) =>
  `🎁 Дарим ${bonusWords(gift.amount)} — они действуют до ${dayMonth(giftBonusExpiry(now, gift.days, tz).lastDay)}`;

const withLines = (greeting: string, lines: string[]) => (lines.length ? `${greeting}\n\n${lines.join('\n')}` : greeting);

/** The birthday greeting with its gift lines. */
export function birthdayText(settings: RetentionSettings, name: string, now: number, tz: string): string {
  const b = settings.birthday;
  const gift = giftOf(settings, b.bonusAmount, b.bonusDays);
  const lines = gift ? [giftLine(gift, now, tz)] : [];
  if (b.discountPercent > 0) {
    const until = DateTime.fromMillis(now, { zone: tz }).plus({ days: b.discountDaysAfter }).toISODate() ?? '';
    lines.push(b.discountDaysAfter > 0 ? `💝 Скидка ${b.discountPercent}% до ${dayMonth(until)}` : `💝 Сегодня — скидка ${b.discountPercent}%`);
  }
  return withLines(personalize(b.text, name), lines);
}

/** The win-back message with its gift line. */
export function winbackText(settings: RetentionSettings, name: string, now: number, tz: string): string {
  const gift = giftOf(settings, settings.winback.bonusAmount, settings.winback.bonusDays);
  return withLines(personalize(settings.winback.text, name), gift ? [giftLine(gift, now, tz)] : []);
}

interface RetentionMessage {
  kind: RetentionKind;
  candidate: RetentionCandidate;
  text: string;
  keyboard: InlineKeyboard;
  gift: Gift | null;
}

type Outcome = 'sent' | 'skipped' | 'failed' | 'offline';

function noteFailure(ctx: AppContext, msg: RetentionMessage, err: unknown): void {
  const key = `${msg.kind}:${msg.candidate.clientId}:${msg.candidate.periodKey}`;
  const counts = failures.get(ctx) ?? new Map<string, number>();
  failures.set(ctx, counts);
  const tries = (counts.get(key) ?? 0) + 1;
  const blocked = err instanceof BotSendError && err.blocked;
  // Blocked, or out of tries: the log stays and the message is not tried again for this period.
  if (!blocked && tries < RETENTION_MAX_ATTEMPTS) {
    counts.set(key, tries);
    releaseRetentionSend(ctx.db, msg.kind, msg.candidate);
  } else {
    counts.delete(key);
  }
  ctx.log.warn({ kind: msg.kind, clientId: msg.candidate.clientId, tries, blocked, err: errorMessage(err) }, 'retention message not delivered');
}

/** Credits the gift of a delivered message; a failure is told to the staff chat (the client was promised it). */
async function creditGift(ctx: AppContext, msg: RetentionMessage, gift: Gift, now: number): Promise<void> {
  const { candidate } = msg;
  try {
    grantGiftBonuses(ctx, candidate.clientId, gift.amount, gift.days, GIFT_NOTES[msg.kind], now);
  } catch (err) {
    ctx.log.error({ kind: msg.kind, clientId: candidate.clientId, err: errorMessage(err) }, 'gift bonuses not credited');
    await notifyStaff(
      ctx,
      `⚠️ Не удалось начислить ${bonusWords(gift.amount)} в подарок ${GIFT_REASONS[msg.kind]} клиенту «${candidate.name}» ` +
        `(карточка №${candidate.clientId}) — начислите их вручную`,
    );
  }
}

async function deliver(ctx: AppContext, msg: RetentionMessage, pacer: Pacer, now: number): Promise<Outcome> {
  const { candidate } = msg;
  if (!claimRetentionSend(ctx.db, msg.kind, candidate, now)) return 'skipped';
  await pacer.wait();
  try {
    const stored = await sendNews(ctx, candidate.chatId, { text: msg.text, keyboard: msg.keyboard });
    storeNews(ctx.db, candidate.chatId, candidate.clientId, stored);
  } catch (err) {
    const flood = err instanceof BotSendError && err.retryAfterMs !== null;
    if (err instanceof BotUnavailableError || flood) {
      // Not the client's fault: nothing counted, tried again once the bot is back / the hold is over.
      releaseRetentionSend(ctx.db, msg.kind, candidate);
      if (flood) pacer.holdFor((err as BotSendError).retryAfterMs!);
      return 'offline';
    }
    noteFailure(ctx, msg, err);
    return 'failed';
  }
  failures.get(ctx)?.delete(`${msg.kind}:${candidate.clientId}:${candidate.periodKey}`);
  if (msg.gift) await creditGift(ctx, msg, msg.gift, now);
  return 'sent';
}

/** Sends the messages in order; stops when the bot goes offline or Telegram holds us. Returns how many were delivered. */
async function deliverAll(ctx: AppContext, messages: RetentionMessage[], pacer: Pacer, now: number): Promise<{ sent: number; offline: boolean }> {
  let sent = 0;
  for (const msg of messages) {
    if (!ctx.gateway.isRunning()) return { sent, offline: true };
    const outcome = await deliver(ctx, msg, pacer, now);
    if (outcome === 'offline') return { sent, offline: true };
    if (outcome === 'sent') sent += 1;
  }
  return { sent, offline: false };
}

function birthdayMessages(ctx: AppContext, settings: RetentionSettings, now: number, tz: string): RetentionMessage[] {
  const gift = giftOf(settings, settings.birthday.bonusAmount, settings.birthday.bonusDays);
  const keyboard = newsKeyboard(ctx, null);
  return birthdayCandidates(ctx.db, now, tz).map((candidate) => ({
    kind: 'birthday',
    candidate,
    text: birthdayText(settings, candidate.name, now, tz),
    keyboard,
    gift,
  }));
}

function winbackMessages(ctx: AppContext, settings: RetentionSettings, now: number, tz: string): RetentionMessage[] {
  const w = settings.winback;
  const gift = giftOf(settings, w.bonusAmount, w.bonusDays);
  const keyboard = newsKeyboard(ctx, 'book');
  const left = w.dailyLimit - winbacksToday(ctx.db, now, tz);
  return winbackCandidates(ctx.db, now, tz, w.afterMonths, left).map((candidate) => ({
    kind: 'winback',
    candidate,
    text: winbackText(settings, candidate.name, now, tz),
    keyboard,
    gift,
  }));
}

/** One check (every RETENTION_CHECK_INTERVAL_MS). Does nothing while the bot is offline or Telegram holds us. */
export async function sendDueRetention(ctx: AppContext, options: RetentionRunOptions = {}): Promise<RetentionRunStats> {
  const clock = options.clock ?? realClock;
  const now = options.now ?? clock.now();
  const stats: RetentionRunStats = { birthday: 0, winback: 0 };
  const pacer = bulkPacer(clock);
  if (!ctx.gateway.isRunning() || pacer.isHeld()) return stats;
  const settings = getRetentionSettings(ctx.db);
  const tz = studioTimezone(ctx.db);
  if (settings.birthday.enabled && isDue(settings.birthday.sendAt, now, tz)) {
    const result = await deliverAll(ctx, birthdayMessages(ctx, settings, now, tz), pacer, now);
    stats.birthday = result.sent;
    if (result.offline) return stats;
  }
  if (settings.winback.enabled && isDue(settings.winback.sendAt, now, tz)) {
    stats.winback = (await deliverAll(ctx, winbackMessages(ctx, settings, now, tz), pacer, now)).sent;
  }
  return stats;
}
