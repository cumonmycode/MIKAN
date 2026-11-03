import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DateTime } from 'luxon';
import { OfflineGateway } from '../bot/gateway.js';
import { loadConfig, type Config } from '../config.js';
import { silentLogger, type AiClient, type AppContext, type Logger } from '../context.js';
import { openDatabase, type DbOrTx } from '../db/client.js';
import {
  appointments,
  appointmentServices,
  certificateOperations,
  employees,
  giftCertificates,
  knowledgeEntries,
  portfolioPhotos,
  services,
} from '../db/schema.js';
import { seedDatabase } from '../db/seed.js';
import { adjustBonuses, creditGiftBonuses } from '../domain/bonuses.js';
import { createClient } from '../domain/clients.js';
import { createProduct } from '../domain/products.js';
import { getStudioSettings, saveStudioSettings } from '../domain/settings.js';
import type { ClientRow } from '../lib/serialize.js';
import { DAY_MS } from '../lib/time.js';
import type { QrProvider } from '../payments/qr-provider.js';
import { FIXTURE_JEWELRY, FIXTURE_KNOWLEDGE, FIXTURE_SERVICES, STUDIO_FACTS } from './fixture-data.js';

/** The fixture studio of the AI quality check, in an in-memory database. */

export const EVAL_CHAT_ID = 900_001;
export const EVAL_CERTIFICATE_CODE = 'MIKAN-7K3Q-9F2D';
/** The owner created by the seed is a master too. */
const OWNER_NAME = 'Алина';
const SECOND_MASTER = 'Катя';
const UPCOMING_IN_DAYS = 3;
const CERTIFICATE_VALID_DAYS = 200;

export interface EvalStudio {
  ctx: AppContext;
  /** The client the AI talks to: identified, as every client chat in production (the phone is shared first). */
  client: ClientRow;
  chatId: number;
  close(): void;
}

/**
 * A bank that is never called: test-mode bookings only check that online prepayment is possible (as in production,
 * where Tochka is configured), they create no payment.
 */
const UNUSED_BANK: QrProvider = {
  name: 'eval',
  createQr: async () => {
    throw new Error('the AI quality check never creates payments');
  },
  paymentStatus: async () => {
    throw new Error('the AI quality check never checks payments');
  },
};

function fixtureConfig(dataDir: string, ai: Config['ai']): Config {
  const base = loadConfig({
    JWT_SECRET: 'ai-eval-fixture-only-ai-eval-fixture-only',
    ADMIN_LOGIN: 'eval',
    ADMIN_PASSWORD: 'eval-fixture-only',
    ADMIN_NAME: OWNER_NAME,
    DATA_DIR: dataDir,
  });
  return { ...base, ai };
}

function addStudio(db: DbOrTx): void {
  saveStudioSettings(db, {
    ...getStudioSettings(db),
    name: STUDIO_FACTS.name,
    address: STUDIO_FACTS.address,
    phone: STUDIO_FACTS.phone,
    workingHours: STUDIO_FACTS.workingHours,
    timezone: STUDIO_FACTS.timezone,
    about: STUDIO_FACTS.about,
    workdayStart: '11:00',
    workdayEnd: '21:00',
  });
  const now = Date.now();
  db.delete(knowledgeEntries).run();
  db.insert(knowledgeEntries)
    .values(FIXTURE_KNOWLEDGE.map((k, sort) => ({ ...k, active: true, sort, createdAt: now, updatedAt: now })))
    .run();
}

/** Services by fixture key → id. Pictures are files in `dataDir/uploads`. */
function addServices(db: DbOrTx, dataDir: string): Map<string, number> {
  const now = Date.now();
  const ids = new Map<string, number>();
  FIXTURE_SERVICES.forEach((s, sort) => {
    const imageUrl = s.picture ? `/uploads/eval-${s.key}.jpg` : null;
    if (imageUrl) fs.writeFileSync(path.join(dataDir, 'uploads', path.basename(imageUrl)), 'eval');
    const row = db
      .insert(services)
      .values({
        name: s.name,
        category: s.category,
        groupName: s.group,
        price: s.price,
        priceMax: s.priceMax ?? null,
        priceFrom: s.priceFrom ?? false,
        durationMin: s.durationMin,
        description: s.description,
        imageUrl,
        variantsJson: JSON.stringify(s.variants ?? []),
        depositAmount: s.deposit ?? 0,
        sort,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: services.id })
      .get();
    ids.set(s.key, row.id);
  });
  return ids;
}

function addJewelry(db: DbOrTx, dataDir: string, serviceIds: Map<string, number>, ownerId: number): void {
  FIXTURE_JEWELRY.forEach((j, index) => {
    const photo = j.photo ? `/uploads/eval-jewelry-${index + 1}.jpg` : null;
    if (photo) fs.writeFileSync(path.join(dataDir, 'uploads', path.basename(photo)), 'eval');
    createProduct(
      db,
      {
        kind: 'jewelry',
        name: j.name,
        category: j.category,
        material: j.material,
        threadType: j.threadType ?? null,
        thicknessMm: j.thicknessMm,
        color: j.color ?? null,
        stone: j.stone ?? null,
        description: j.description ?? null,
        price: j.sizes[0]!.price,
        photos: photo ? [photo] : [],
        serviceIds: j.suits.map((key) => serviceIds.get(key)!),
        variants: j.sizes.map((s) => ({ name: s.name, price: s.price, initialQuantity: s.quantity })),
      },
      ownerId,
    );
  });
}

function addMaster(db: DbOrTx, name: string): number {
  const now = Date.now();
  return db
    .insert(employees)
    .values({ name, login: 'eval-master', passwordHash: '!', color: '#5E5CE6', isMaster: true, role: 'master', createdAt: now, updatedAt: now })
    .returning({ id: employees.id })
    .get().id;
}

/** Катя's portfolio: two mini tattoos (files in `dataDir/uploads`, so the bot can send them). */
function addPortfolio(db: DbOrTx, dataDir: string, masterId: number, serviceIds: Map<string, number>): void {
  const now = Date.now();
  const serviceId = serviceIds.get('tattoo-mini') ?? null;
  const works = ['Минимализм, линии', 'Цветочная веточка'].map((caption, sort) => {
    const imageUrl = `/uploads/eval-portfolio-${sort + 1}.jpg`;
    fs.writeFileSync(path.join(dataDir, 'uploads', path.basename(imageUrl)), 'eval');
    return { employeeId: masterId, serviceId, imageUrl, caption, sort, createdAt: now };
  });
  db.insert(portfolioPhotos).values(works).run();
}

/** Анна: identified (her chat is linked), 1 400 bonuses, a mini tattoo booked in a few days and awaiting prepayment. */
function addClient(db: DbOrTx, serviceIds: Map<string, number>, ownerId: number, masterId: number): ClientRow {
  const now = Date.now();
  const anna = createClient(
    db,
    { name: 'Анна', lastName: 'Смирнова', phone: '+79990001122' },
    { telegramChatId: EVAL_CHAT_ID, telegramUsername: 'anna_eval' },
  );
  adjustBonuses(db, anna.id, { amount: 1200, note: 'Бонусы за прошлые визиты', expiresAt: null }, ownerId, now);
  creditGiftBonuses(db, anna.id, 200, 10, 'Подарок ко дню рождения', now);

  const tattoo = FIXTURE_SERVICES.find((s) => s.key === 'tattoo-mini')!;
  const startsAt = DateTime.fromMillis(now, { zone: STUDIO_FACTS.timezone })
    .plus({ days: UPCOMING_IN_DAYS })
    .set({ hour: 15, minute: 0, second: 0, millisecond: 0 })
    .toMillis();
  const appointment = db
    .insert(appointments)
    .values({
      clientId: anna.id,
      masterId,
      serviceId: serviceIds.get(tattoo.key)!,
      startsAt,
      endsAt: startsAt + tattoo.durationMin * 60_000,
      status: 'scheduled',
      price: tattoo.price,
      depositRequired: tattoo.deposit ?? 0,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: appointments.id })
    .get();
  db.insert(appointmentServices)
    .values({
      appointmentId: appointment.id,
      serviceId: serviceIds.get(tattoo.key)!,
      name: tattoo.name,
      price: tattoo.price,
      durationMin: tattoo.durationMin,
      position: 0,
    })
    .run();
  return anna;
}

/** A certificate bought by Ольга for Анна: 3 000 ₽ of 5 000 ₽ left. */
function addCertificate(db: DbOrTx, ownerId: number): void {
  const now = Date.now();
  const olga = createClient(db, { name: 'Ольга', lastName: 'Петрова', phone: '+79990003344' });
  const row = db
    .insert(giftCertificates)
    .values({
      code: EVAL_CERTIFICATE_CODE,
      amount: 5000,
      balance: 3000,
      status: 'active',
      expiresAt: now + CERTIFICATE_VALID_DAYS * DAY_MS,
      buyerClientId: olga.id,
      recipientName: 'Анне',
      createdBy: ownerId,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: giftCertificates.id })
    .get();
  db.insert(certificateOperations)
    .values([
      { certificateId: row.id, type: 'issue', amount: 5000, employeeId: ownerId, createdAt: now },
      { certificateId: row.id, type: 'redeem', amount: -2000, employeeId: ownerId, createdAt: now },
    ])
    .run();
}

/** Builds the fixture studio: a temporary data dir for the pictures and an in-memory database. Call `close()`. */
export function buildEvalStudio(opts: { ai: AiClient | null; aiConfig: Config['ai']; log?: Logger }): EvalStudio {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mikan-ai-eval-'));
  const removeDataDir = () => fs.rmSync(dataDir, { recursive: true, force: true });
  let handle: ReturnType<typeof openDatabase>;
  try {
    fs.mkdirSync(path.join(dataDir, 'uploads'));
    handle = openDatabase(':memory:');
  } catch (err) {
    removeDataDir();
    throw err;
  }
  const { db, sqlite } = handle;
  try {
    const config = fixtureConfig(dataDir, opts.aiConfig);
    seedDatabase(db, config);
    const client = db.transaction((tx) => {
      const ownerId = tx.select({ id: employees.id }).from(employees).get()!.id;
      addStudio(tx);
      const serviceIds = addServices(tx, dataDir);
      addJewelry(tx, dataDir, serviceIds, ownerId);
      const masterId = addMaster(tx, SECOND_MASTER);
      addPortfolio(tx, dataDir, masterId, serviceIds);
      addCertificate(tx, ownerId);
      return addClient(tx, serviceIds, ownerId, masterId);
    });
    const ctx: AppContext = {
      db,
      sqlite,
      config,
      log: opts.log ?? silentLogger,
      gateway: new OfflineGateway(),
      ai: opts.ai,
      qr: UNUSED_BANK,
      onBotSettingsChanged: () => undefined,
    };
    return {
      ctx,
      client,
      chatId: EVAL_CHAT_ID,
      close: () => {
        if (sqlite.open) sqlite.close();
        removeDataDir();
      },
    };
  } catch (err) {
    sqlite.close();
    removeDataDir();
    throw err;
  }
}
