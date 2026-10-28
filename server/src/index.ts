import fs from 'node:fs';
import path from 'node:path';
import { pino } from 'pino';
import { APP_VERSION, buildApp } from './app.js';
import { createAiClient } from './bot/ai.js';
import { CAMPAIGN_TICK_MS, runCampaigns } from './bot/campaign-sender.js';
import { BotController } from './bot/index.js';
import { RETENTION_CHECK_INTERVAL_MS, sendDueRetention } from './bot/retention.js';
import { processDueMessages, SENDER_INTERVAL_MS } from './bot/sender.js';
import { loadConfig } from './config.js';
import type { AppContext } from './context.js';
import { openDatabase } from './db/client.js';
import { seedDatabase } from './db/seed.js';
import { DIGEST_CHECK_INTERVAL_MS, sendDueDigests } from './bot/digest.js';
import { checkDiskSpace, DISK_CHECK_INTERVAL_MS, raiseAlert, resolveAlerts } from './domain/alerts.js';
import { pruneAuditLog } from './domain/audit.js';
import { runBackupIfDue } from './domain/backup.js';
import { expireLoyalty, LOYALTY_EXPIRY_INTERVAL_MS } from './domain/loyalty.js';
import { HOLD_CHECK_INTERVAL_MS, rejectUnconfirmedBookings, releaseUnpaidHolds } from './domain/online-booking-lifecycle.js';
import { uploadBackupOffsite } from './domain/offsite-backup.js';
import { backupUploadsOffsite } from './domain/offsite-uploads.js';
import { QR_SWEEP_INTERVAL_MS, sweepQrPayments } from './domain/qr-payments.js';
import { studioTimezone } from './domain/settings.js';
import { expireWaitlist } from './domain/waitlist.js';
import { FREED_CHECK_INTERVAL_MS, offerFreedTime, WAITLIST_EXPIRY_INTERVAL_MS } from './domain/waitlist-matcher.js';
import { errorMessage } from './lib/errors.js';
import { localDate } from './lib/time.js';
import { createQrProvider } from './payments/tochka.js';
import { createHttp2Transport } from './push/apns.js';
import { SMM_TICK_INTERVAL_MS, smmIdle, smmTick } from './smm/workflow.js';

const BACKUP_CHECK_MS = 10 * 60_000;
const AUDIT_PRUNE_MS = 24 * 60 * 60_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const log = pino({
    level: config.logLevel,
    redact: { paths: ['req.headers.authorization', 'password', '*.password', 'token', '*.token'], censor: '[redacted]' },
  });
  fs.mkdirSync(path.join(config.dataDir, 'backups'), { recursive: true });
  const { db, sqlite } = openDatabase(path.join(config.dataDir, 'mikan.db'));
  seedDatabase(db, config);

  const apns = config.apns ? createHttp2Transport() : undefined;
  const ctx = {
    db,
    sqlite,
    config,
    log,
    ai: createAiClient(config.ai),
    qr: createQrProvider(config.tochka),
    apns,
    onBotSettingsChanged: () => controller.refresh(),
  } as Omit<AppContext, 'gateway'> as AppContext;
  const controller = new BotController(ctx);
  ctx.gateway = controller;

  const app = await buildApp(ctx, { loggerInstance: log });
  await app.listen({ port: config.port, host: config.host });
  log.info(
    {
      version: APP_VERSION,
      dataDir: config.dataDir,
      ai: ctx.ai ? { model: config.ai.model, gateway: config.ai.baseUrl ?? 'anthropic' } : 'disabled',
      telegram: config.telegram.enabled ? config.telegram.apiRoot : 'disabled',
      qrPayments: ctx.qr ? ctx.qr.name : 'disabled',
      push: config.apns ? 'apns' : 'disabled',
    },
    'MIKAN server started',
  );
  if (config.apnsProblem) log.warn({ problem: config.apnsProblem }, 'APNs is not fully configured: staff push notifications are off');
  if (config.tochka.jwt && !ctx.qr) {
    log.warn('TOCHKA_JWT is set but TOCHKA_MERCHANT_ID / TOCHKA_ACCOUNT_ID are not: run dist/scripts/tochka-setup.js');
  }

  controller.refresh();

  let sending = false;
  const senderTimer = setInterval(() => {
    if (sending) return;
    sending = true;
    processDueMessages(ctx)
      .catch((err) => log.error({ err: errorMessage(err) }, 'scheduled sender failed'))
      .finally(() => {
        sending = false;
      });
  }, SENDER_INTERVAL_MS);

  let sweeping = false;
  const qrTimer = setInterval(() => {
    if (sweeping || !ctx.qr) return;
    sweeping = true;
    sweepQrPayments(ctx)
      .catch((err) => log.error({ err: errorMessage(err) }, 'QR payment sweep failed'))
      .finally(() => {
        sweeping = false;
      });
  }, QR_SWEEP_INTERVAL_MS);

  // Online bookings whose prepayment did not arrive in time free their time, and the ones nobody confirmed in time are
  // rejected (docs/API.md «Online booking», «StudioSettings»).
  let releasing = false;
  const holdTimer = setInterval(() => {
    if (releasing) return;
    releasing = true;
    releaseUnpaidHolds(ctx)
      .then((released) => released && log.info({ released }, 'unpaid online holds released'))
      .catch((err) => log.error({ err: errorMessage(err) }, 'online hold check failed'))
      .then(() => rejectUnconfirmedBookings(ctx))
      .then((rejected) => rejected && log.info({ rejected }, 'unconfirmed online bookings rejected'))
      .catch((err) => log.error({ err: errorMessage(err) }, 'unconfirmed online booking check failed'))
      .finally(() => {
        releasing = false;
      });
  }, HOLD_CHECK_INTERVAL_MS);

  // Freed time is offered to the waitlist; entries past their dates expire (docs/API.md «Waitlist»).
  let offering = false;
  const waitlistTimer = setInterval(() => {
    if (offering) return;
    offering = true;
    offerFreedTime(ctx)
      .then((told) => told && log.info({ told }, 'waitlist clients told about freed time'))
      .catch((err) => log.error({ err: errorMessage(err) }, 'waitlist freed time check failed'))
      .finally(() => {
        offering = false;
      });
  }, FREED_CHECK_INTERVAL_MS);
  const waitlistExpiryTick = () => {
    try {
      const expired = expireWaitlist(db);
      if (expired) log.info({ expired }, 'waitlist entries expired');
    } catch (err) {
      log.error({ err: errorMessage(err) }, 'waitlist expiry failed');
    }
  };
  const waitlistExpiryTimer = setInterval(waitlistExpiryTick, WAITLIST_EXPIRY_INTERVAL_MS);
  waitlistExpiryTick();

  let digesting = false;
  const digestTimer = setInterval(() => {
    if (digesting) return;
    digesting = true;
    sendDueDigests(ctx)
      .then((sent) => sent && log.info({ sent }, 'staff digests sent'))
      .catch((err) => log.error({ err: errorMessage(err) }, 'staff digests failed'))
      .finally(() => {
        digesting = false;
      });
  }, DIGEST_CHECK_INTERVAL_MS);

  // SMM marketer: publishes on time, hands posts over, reminds, prepares the next posts, collects numbers.
  // Steps that need the AI key are skipped inside the tick when it is missing; publishing still runs.
  let smmRunning = false;
  const smmTimer = setInterval(() => {
    if (smmRunning) return;
    smmRunning = true;
    smmTick(ctx)
      .catch((err) => log.error({ err: errorMessage(err) }, 'SMM tick failed'))
      .finally(() => {
        smmRunning = false;
      });
  }, SMM_TICK_INTERVAL_MS);
  // Telegram campaigns: scheduled starts and delivery at a safe rate (docs/API.md «Campaigns»).
  let campaigning = false;
  const campaignTimer = setInterval(() => {
    if (campaigning) return;
    campaigning = true;
    runCampaigns(ctx)
      .then((run) => (run.sent || run.failed || run.blocked || run.started) && log.info(run, 'campaign messages sent'))
      .catch((err) => log.error({ err: errorMessage(err) }, 'campaign sender failed'))
      .finally(() => {
        campaigning = false;
      });
  }, CAMPAIGN_TICK_MS);

  // Birthday greetings and win-back messages, each once (docs/API.md «Birthday and win-back»).
  let retaining = false;
  const retentionTimer = setInterval(() => {
    if (retaining) return;
    retaining = true;
    sendDueRetention(ctx)
      .then((run) => (run.birthday || run.winback) && log.info(run, 'retention messages sent'))
      .catch((err) => log.error({ err: errorMessage(err) }, 'retention messages failed'))
      .finally(() => {
        retaining = false;
      });
  }, RETENTION_CHECK_INTERVAL_MS);

  const backupDir = path.join(config.dataDir, 'backups');
  // The daily copy, then its encrypted off-site copy and the photo archive; staff hear about failures (domain/alerts.ts).
  const copyOffsite = async (file: string) => {
    if (!config.offsiteBackup) {
      if (config.offsiteBackupProblem) {
        await raiseAlert(ctx, 'offsite_backup', `⚠️ Бэкапы вне сервера не настроены до конца: ${config.offsiteBackupProblem}`);
      }
      return;
    }
    try {
      const copy = await uploadBackupOffsite(config.offsiteBackup, file);
      log.info({ key: copy.key, bytes: copy.bytes, pruned: copy.pruned.length }, 'off-site backup uploaded');
      await resolveAlerts(ctx, ['offsite_backup'], '✅ Бэкап снова уходит во внешнее хранилище');
    } catch (err) {
      log.error({ err: errorMessage(err) }, 'off-site backup failed');
      await raiseAlert(ctx, 'offsite_backup', `⚠️ Не удалось отправить бэкап во внешнее хранилище: ${errorMessage(err)}`);
    }
  };
  const backupTick = () =>
    runBackupIfDue(sqlite, backupDir, studioTimezone(db))
      .then(
        async (file) => {
          if (!file) return;
          log.info({ file }, 'database backup created');
          await resolveAlerts(ctx, ['backup'], '✅ Бэкап базы снова создаётся');
          await copyOffsite(file);
          if (config.offsiteBackup) await backupUploadsOffsite(ctx, config.offsiteBackup, localDate(Date.now(), studioTimezone(db)));
        },
        async (err) => {
          log.error({ err: errorMessage(err) }, 'database backup failed');
          await raiseAlert(ctx, 'backup', `⚠️ Не удалось создать бэкап базы: ${errorMessage(err)}`);
        },
      )
      .catch((err) => log.error({ err: errorMessage(err) }, 'backup alert failed'));
  const backupTimer = setInterval(backupTick, BACKUP_CHECK_MS);
  void backupTick();

  const diskTick = () =>
    checkDiskSpace(ctx, config.dataDir).catch((err) => log.error({ err: errorMessage(err) }, 'disk space check failed'));
  const diskTimer = setInterval(diskTick, DISK_CHECK_INTERVAL_MS);
  void diskTick();

  // The action log keeps 2 years (docs/API.md «Audit log»).
  const auditPruneTick = () => {
    try {
      const pruned = pruneAuditLog(db);
      if (pruned) log.info({ pruned }, 'old audit log entries pruned');
    } catch (err) {
      log.error({ err: errorMessage(err) }, 'audit log pruning failed');
    }
  };
  const auditPruneTimer = setInterval(auditPruneTick, AUDIT_PRUNE_MS);
  auditPruneTick();

  // Bonus lots and gift certificates burn at their expiresAt (docs/API.md «Loyalty bonuses», «Gift certificates»).
  const loyaltyTick = () => {
    try {
      const burnt = expireLoyalty(db);
      if (burnt.bonuses.lots || burnt.certificates.certificates) log.info(burnt, 'expired bonuses and certificates recorded');
    } catch (err) {
      log.error({ err: errorMessage(err) }, 'loyalty expiry failed');
    }
  };
  const loyaltyTimer = setInterval(loyaltyTick, LOYALTY_EXPIRY_INTERVAL_MS);
  loyaltyTick();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutting down');
    clearInterval(senderTimer);
    clearInterval(qrTimer);
    clearInterval(holdTimer);
    clearInterval(waitlistTimer);
    clearInterval(waitlistExpiryTimer);
    clearInterval(digestTimer);
    clearInterval(smmTimer);
    clearInterval(campaignTimer);
    clearInterval(retentionTimer);
    clearInterval(backupTimer);
    clearInterval(diskTimer);
    clearInterval(auditPruneTimer);
    clearInterval(loyaltyTimer);
    const force = setTimeout(() => process.exit(1), 15_000);
    force.unref();
    try {
      // An SMM tick may be publishing right now: let it finish before the bot and the database go away
      // (the force exit above still caps the wait; a post cut off mid-way is recovered by the next start).
      await smmIdle(ctx);
      await controller.stop();
      apns?.close();
      await app.close();
      sqlite.close();
    } catch (err) {
      log.error({ err: errorMessage(err) }, 'error during shutdown');
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => log.error({ err: errorMessage(reason) }, 'unhandled rejection'));
}

main().catch((err: unknown) => {
  process.stderr.write(`Fatal: ${errorMessage(err)}\n`);
  process.exit(1);
});
