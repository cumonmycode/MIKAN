import fs from 'node:fs';
import path from 'node:path';
import { pino } from 'pino';
import { APP_VERSION, buildApp } from './app.js';
import { createAiClient } from './bot/ai.js';
import { BotController } from './bot/index.js';
import { processDueMessages, SENDER_INTERVAL_MS } from './bot/sender.js';
import { loadConfig } from './config.js';
import type { AppContext } from './context.js';
import { openDatabase } from './db/client.js';
import { seedDatabase } from './db/seed.js';
import { DIGEST_CHECK_INTERVAL_MS, sendDueDigests } from './bot/digest.js';
import { runBackupIfDue } from './domain/backup.js';
import { QR_SWEEP_INTERVAL_MS, sweepQrPayments } from './domain/qr-payments.js';
import { studioTimezone } from './domain/settings.js';
import { errorMessage } from './lib/errors.js';
import { createQrProvider } from './payments/tochka.js';
import { SMM_TICK_INTERVAL_MS, smmIdle, smmTick } from './smm/workflow.js';

const BACKUP_CHECK_MS = 10 * 60_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const log = pino({
    level: config.logLevel,
    redact: { paths: ['req.headers.authorization', 'password', '*.password', 'token', '*.token'], censor: '[redacted]' },
  });
  fs.mkdirSync(path.join(config.dataDir, 'backups'), { recursive: true });
  const { db, sqlite } = openDatabase(path.join(config.dataDir, 'mikan.db'));
  seedDatabase(db, config);

  const ctx = {
    db,
    sqlite,
    config,
    log,
    ai: createAiClient(config.ai),
    qr: createQrProvider(config.tochka),
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
    },
    'MIKAN server started',
  );
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

  const backupDir = path.join(config.dataDir, 'backups');
  const backupTick = () =>
    runBackupIfDue(sqlite, backupDir, studioTimezone(db))
      .then((file) => file && log.info({ file }, 'database backup created'))
      .catch((err) => log.error({ err: errorMessage(err) }, 'database backup failed'));
  const backupTimer = setInterval(backupTick, BACKUP_CHECK_MS);
  void backupTick();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutting down');
    clearInterval(senderTimer);
    clearInterval(qrTimer);
    clearInterval(digestTimer);
    clearInterval(smmTimer);
    clearInterval(backupTimer);
    const force = setTimeout(() => process.exit(1), 15_000);
    force.unref();
    try {
      // An SMM tick may be publishing right now: let it finish before the bot and the database go away
      // (the force exit above still caps the wait; a post cut off mid-way is recovered by the next start).
      await smmIdle(ctx);
      await controller.stop();
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
