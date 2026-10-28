import fs from 'node:fs';
import { isNotNull } from 'drizzle-orm';
import { notifyStaff } from '../bot/staff.js';
import type { AppContext } from '../context.js';
import { botChats } from '../db/schema.js';
import { errorMessage } from '../lib/errors.js';
import { truncate } from '../lib/text.js';
import { chatEmployee } from './bot-chats.js';
import { getAlertStates, getStaffChatId, setAlertStates } from './settings.js';

/**
 * Alerts (docs/API.md «Alerts»): the staff chat is told when something needs a person — at most once every
 * `ALERT_REPEAT_MS` per kind while it lasts, and once more when it recovers. The state is kept in the settings, so a
 * restart neither repeats an alert nor forgets one.
 */

export type AlertKind = 'ai_balance' | 'ai_errors' | 'backup' | 'offsite_backup' | 'offsite_uploads' | 'disk';

export const ALERT_REPEAT_MS = 6 * 60 * 60_000;
/** AI failures in a row before staff hear about it (a single hiccup is retried by the client SDK already). */
export const AI_FAILURES_TO_ALERT = 3;
export const DISK_FREE_MIN_BYTES = 1024 ** 3;
export const DISK_CHECK_INTERVAL_MS = 60 * 60_000;

/** The staff group chat when bound, else every staff chat (employees recognised by the bot). Returns deliveries. */
export async function alertStaff(ctx: AppContext, text: string): Promise<number> {
  if (getStaffChatId(ctx.db) !== null) return (await notifyStaff(ctx, text)) ? 1 : 0;
  if (!ctx.gateway.isRunning()) return 0;
  const chats = ctx.db
    .select()
    .from(botChats)
    .where(isNotNull(botChats.employeeId))
    .all()
    .filter((c) => chatEmployee(ctx.db, c) !== null);
  let delivered = 0;
  for (const chat of chats) {
    try {
      await ctx.gateway.sendText(chat.chatId, text);
      delivered += 1;
    } catch (err) {
      ctx.log.warn({ chatId: chat.chatId, err: errorMessage(err) }, 'alert not delivered');
    }
  }
  return delivered;
}

/** Raises an alert; staff hear about it now unless they were told about this kind less than 6 hours ago. */
export async function raiseAlert(ctx: AppContext, kind: AlertKind, text: string, now = Date.now()): Promise<boolean> {
  const states = getAlertStates(ctx.db);
  const current = states[kind];
  if (current?.active && now - current.lastSentAt < ALERT_REPEAT_MS) return false;
  setAlertStates(ctx.db, { ...states, [kind]: { active: true, since: current?.active ? current.since : now, lastSentAt: now } });
  ctx.log.warn({ alert: kind }, text);
  await alertStaff(ctx, text);
  return true;
}

/** Clears the alerts of these kinds; when any was raised, staff get `text` once. */
export async function resolveAlerts(ctx: AppContext, kinds: AlertKind[], text: string, now = Date.now()): Promise<boolean> {
  const states = getAlertStates(ctx.db);
  const raised = kinds.filter((k) => states[k]?.active);
  if (raised.length === 0) return false;
  const next = { ...states };
  for (const kind of raised) next[kind] = { active: false, since: states[kind]!.since, lastSentAt: now };
  setAlertStates(ctx.db, next);
  ctx.log.info({ alerts: raised }, text);
  await alertStaff(ctx, text);
  return true;
}

const aiFailures = new WeakMap<AppContext, number>();

/** What an AI run's outcome means for the AI alerts. Never throws: the bot's reply must not depend on it. */
export async function noteAiOutcome(
  ctx: AppContext,
  result: { outcome: string; error?: string; errorStatus?: number; errorCode?: string },
): Promise<void> {
  try {
    if (result.outcome !== 'error') {
      aiFailures.set(ctx, 0);
      await resolveAlerts(ctx, ['ai_balance', 'ai_errors'], '✅ ИИ снова отвечает клиентам');
      return;
    }
    const failures = (aiFailures.get(ctx) ?? 0) + 1;
    aiFailures.set(ctx, failures);
    if (result.errorStatus === 402 || /INSUFFICIENT_BALANCE/i.test(result.errorCode ?? '')) {
      await raiseAlert(ctx, 'ai_balance', '⚠️ Закончился баланс ИИ (Polza) — бот отвечает клиентам заглушкой. Пополните баланс.');
      return;
    }
    if (failures >= AI_FAILURES_TO_ALERT) {
      await raiseAlert(
        ctx,
        'ai_errors',
        `⚠️ ИИ не отвечает: ${failures} ошибки подряд. Последняя: ${truncate(result.error ?? 'нет текста ошибки', 200)}`,
      );
    }
  } catch (err) {
    ctx.log.error({ err: errorMessage(err) }, 'AI alert bookkeeping failed');
  }
}

/** Free space where the database lives; staff are told below 1 GB. Returns the free bytes. */
export async function checkDiskSpace(ctx: AppContext, dir: string, now = Date.now()): Promise<number> {
  const stats = fs.statfsSync(dir);
  const free = stats.bavail * stats.bsize;
  if (free < DISK_FREE_MIN_BYTES) {
    const gb = (free / 1024 ** 3).toFixed(1).replace('.', ',');
    await raiseAlert(ctx, 'disk', `⚠️ На сервере мало места: свободно ${gb} ГБ. Без места не сохранятся записи и бэкапы.`, now);
  } else {
    await resolveAlerts(ctx, ['disk'], '✅ Место на сервере снова есть', now);
  }
  return free;
}
