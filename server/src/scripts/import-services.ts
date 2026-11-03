/**
 * Imports the studio price list (`price-list.ts`) into the service catalog and, optionally, turns appointment
 * history imported from YCLIENTS into service lines.
 *
 *   node dist/scripts/import-services.js [--apply] [--update-existing] [--link-history] [--images=<dir>]
 *
 * - Services are matched to the catalog (same category) by normalized name, then by alias, then by cover subject;
 *   unmatched entries are created. A matched service only gets its empty fields filled, unless --update-existing
 *   (then the price-list fields are overwritten; duration, active, photos and an existing picture are kept).
 * - A service without a picture gets `<images>/<key>.jpg|.png` (default `./assets/service-images`) copied into
 *   DATA_DIR/uploads.
 * - --link-history: appointments without service lines get lines parsed from their title («LOBE Мочка + ROOK Руук»),
 *   the appointment price split across them, and `service_id` set to the first catalog service. Only titles naming at
 *   least one price-list service are linked (other parts become custom lines); the title itself is never changed.
 * Without --apply it is a dry run: everything runs inside a transaction that is rolled back, and no files are copied.
 * Re-running is safe (also for `import-appointments`, which recognizes imported visits by their title).
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { asc, eq, isNotNull } from 'drizzle-orm';
import { openDatabase, type Db, type DbOrTx } from '../db/client.js';
import { aftercareTemplates, appointmentServices, appointments, services } from '../db/schema.js';
import { DEFAULT_HEALING_CHECK_DAYS } from '../domain/follow-ups.js';
import { parseVariants } from '../lib/serialize.js';
import { normalizeSearchTerm } from '../lib/text.js';
import { isEntryPoint } from './cli.js';
import { PRICE_LIST, type PriceListService } from './price-list.js';

type ServiceRow = typeof services.$inferSelect;
type ServicePatch = Partial<typeof services.$inferInsert>;

const PICTURE_EXTENSIONS = ['.jpg', '.png'];
const TITLE_SEPARATOR = /\s+\+\s+/;
const UNMAPPED_REPORT_LIMIT = 40;
const SAMPLE_LIMIT = 20;
const SORT_STEP = 10;

export interface ServiceImportOptions {
  apply: boolean;
  /** Overwrite the price-list fields of matched services instead of only filling empty ones. */
  updateExisting: boolean;
  linkHistory: boolean;
  /** Directory with `<key>.jpg` / `<key>.png` cover pictures. */
  imagesDir: string;
  /** DATA_DIR/uploads — pictures are copied here (apply mode only) and served as `/uploads/<name>`. */
  uploadsDir: string;
}

export interface ServiceImportSummary {
  mode: 'apply' | 'dry-run';
  services: {
    created: string[];
    matched: Array<{ existing: string; priceList: string }>;
    updated: number;
    imagesAttached: number;
    /** Keys of services left without a picture because `<key>.jpg|.png` was not found. */
    missingImages: string[];
  };
  history: HistorySummary | null;
}

export interface LinkedSample {
  title: string;
  lines: string[];
}

export interface HistorySummary {
  appointmentsLinked: number;
  linesCreated: number;
  /** Appointments left as they were because no part of their title names a price-list service. */
  skippedUnmapped: number;
  mappedByService: Record<string, number>;
  /** Raw title parts that matched no price-list service, in linked and skipped titles (top 40 by count). */
  unmapped: Record<string, number>;
  /** The first linked appointments (up to 20): original title → line names. */
  sampleLinked: LinkedSample[];
}

/** Thrown at the end of a dry run to roll the transaction back. */
class DryRunRollback extends Error {}

const normalize = normalizeSearchTerm;

const priceFromOf = (entry: PriceListService): boolean => Boolean(entry.priceFrom) || entry.priceMax !== undefined;

function assertPriceList(list: PriceListService[]): void {
  const keys = new Set<string>();
  for (const entry of list) {
    if (keys.has(entry.key)) throw new Error(`Прайс-лист: ключ ${entry.key} повторяется`);
    keys.add(entry.key);
    if (entry.priceMax !== undefined && entry.priceMax <= entry.price) {
      throw new Error(`Прайс-лист: у «${entry.name}» priceMax должен быть больше price`);
    }
  }
}

/** Runs the import in one transaction; a dry run (`apply: false`) rolls it back and copies no files. */
export function importServices(db: Db, opts: ServiceImportOptions, now = Date.now()): ServiceImportSummary {
  assertPriceList(PRICE_LIST);
  const summary: ServiceImportSummary = {
    mode: opts.apply ? 'apply' : 'dry-run',
    services: { created: [], matched: [], updated: 0, imagesAttached: 0, missingImages: [] },
    history: null,
  };
  const copied: string[] = [];
  try {
    db.transaction((tx) => {
      const catalog = importCatalog(tx, opts, now, summary.services, copied);
      if (opts.linkHistory) summary.history = linkHistory(tx, catalog, now);
      if (!opts.apply) throw new DryRunRollback();
    });
  } catch (error) {
    if (error instanceof DryRunRollback) return summary;
    for (const file of copied) fs.rmSync(file, { force: true });
    throw error;
  }
  return summary;
}

// ---------- Services ----------

/** Pairs price-list entries with existing services: exact names first, then aliases, then the cover subject. */
function matchExisting(rows: ServiceRow[]): Map<string, ServiceRow> {
  const rules: Array<(entry: PriceListService, row: ServiceRow) => boolean> = [
    (entry, row) => normalize(row.name) === normalize(entry.name),
    (entry, row) => entry.aliases.some((alias) => normalize(alias) === normalize(row.name)),
    (entry, row) => row.imagePrompt === entry.imageSubject,
  ];
  const matches = new Map<string, ServiceRow>();
  const claimed = new Set<number>();
  for (const rule of rules) {
    for (const entry of PRICE_LIST) {
      if (matches.has(entry.key)) continue;
      const row = rows.find((r) => r.category === entry.category && !claimed.has(r.id) && rule(entry, r));
      if (!row) continue;
      matches.set(entry.key, row);
      claimed.add(row.id);
    }
  }
  return matches;
}

function firstTemplateByCategory(db: DbOrTx): Map<string, number> {
  const rows = db.select().from(aftercareTemplates).orderBy(asc(aftercareTemplates.id)).all();
  const byCategory = new Map<string, number>();
  for (const row of rows) if (!byCategory.has(row.category)) byCategory.set(row.category, row.id);
  return byCategory;
}

/** Imports every price-list entry and returns the resulting catalog rows by price-list key. */
function importCatalog(
  tx: DbOrTx,
  opts: ServiceImportOptions,
  now: number,
  out: ServiceImportSummary['services'],
  copied: string[],
): Map<string, ServiceRow> {
  const templates = firstTemplateByCategory(tx);
  const matches = matchExisting(tx.select().from(services).orderBy(asc(services.id)).all());
  const catalog = new Map<string, ServiceRow>();

  PRICE_LIST.forEach((entry, index) => {
    const templateId = entry.aftercare ? (templates.get(entry.aftercare) ?? null) : null;
    const existing = matches.get(entry.key);
    if (!existing) {
      out.created.push(entry.name);
      const imageUrl = attachPicture(entry.key, opts, out, copied);
      catalog.set(entry.key, insertService(tx, entry, index, templateId, imageUrl, now));
      return;
    }
    out.matched.push({ existing: existing.name, priceList: entry.name });
    const patch = changedFields(existing, {
      ...fillEmptyFields(existing, entry, templateId),
      ...(opts.updateExisting ? priceListFields(entry, index) : {}),
    });
    if (!existing.imageUrl) {
      const imageUrl = attachPicture(entry.key, opts, out, copied);
      if (imageUrl) patch.imageUrl = imageUrl;
    }
    if (Object.keys(patch).length === 0) {
      catalog.set(entry.key, existing);
      return;
    }
    out.updated += 1;
    catalog.set(
      entry.key,
      tx.update(services).set({ ...patch, updatedAt: now }).where(eq(services.id, existing.id)).returning().get(),
    );
  });
  return catalog;
}

function insertService(
  tx: DbOrTx,
  entry: PriceListService,
  index: number,
  templateId: number | null,
  imageUrl: string | null,
  now: number,
): ServiceRow {
  return tx
    .insert(services)
    .values({
      ...priceListFields(entry, index),
      category: entry.category,
      durationMin: entry.durationMin,
      imageUrl,
      photosJson: '[]',
      aftercareTemplateId: templateId,
      freshProcedure: templateId !== null,
      healingCheckDays: templateId !== null ? DEFAULT_HEALING_CHECK_DAYS : null,
      active: true,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
}

/** Fields that `--update-existing` overwrites (and a new service gets). */
function priceListFields(entry: PriceListService, index: number) {
  return {
    name: entry.name,
    groupName: entry.group,
    price: entry.price,
    priceMax: entry.priceMax ?? null,
    priceFrom: priceFromOf(entry),
    description: entry.description,
    variantsJson: JSON.stringify(entry.variants ?? []),
    sort: (index + 1) * SORT_STEP,
    imagePrompt: entry.imageSubject,
  };
}

/** Price-list values for the fields the studio left empty. */
function fillEmptyFields(row: ServiceRow, entry: PriceListService, templateId: number | null): ServicePatch {
  const patch: ServicePatch = {};
  if (!row.groupName?.trim()) patch.groupName = entry.group;
  // A price range always means «the final price is set per appointment» (and must stay above the base price).
  if (row.priceMax === null && entry.priceMax !== undefined && entry.priceMax > row.price) {
    patch.priceMax = entry.priceMax;
    patch.priceFrom = true;
  }
  if (!row.description?.trim()) patch.description = entry.description;
  if (entry.variants?.length && parseVariants(row.variantsJson).length === 0) {
    patch.variantsJson = JSON.stringify(entry.variants);
  }
  if (!row.imagePrompt?.trim()) patch.imagePrompt = entry.imageSubject;
  if (row.aftercareTemplateId === null && templateId !== null) {
    patch.aftercareTemplateId = templateId;
    patch.freshProcedure = true;
  }
  return patch;
}

/** Drops the fields whose value is already stored. */
function changedFields(row: ServiceRow, patch: ServicePatch): ServicePatch {
  const current = row as Record<string, unknown>;
  return Object.fromEntries(Object.entries(patch).filter(([key, value]) => current[key] !== value)) as ServicePatch;
}

function findPicture(dir: string, key: string): string | null {
  for (const ext of PICTURE_EXTENSIONS) {
    const file = path.join(dir, `${key}${ext}`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/**
 * Returns the upload path of the service picture (copying the file in apply mode), or `null` when there is none.
 * A dry run returns a would-be path too, so its summary matches the real run; its transaction is rolled back.
 */
function attachPicture(
  key: string,
  opts: ServiceImportOptions,
  out: ServiceImportSummary['services'],
  copied: string[],
): string | null {
  const source = findPicture(opts.imagesDir, key);
  if (!source) {
    out.missingImages.push(key);
    return null;
  }
  out.imagesAttached += 1;
  const name = `${randomUUID()}${path.extname(source).toLowerCase()}`;
  if (opts.apply) {
    fs.mkdirSync(opts.uploadsDir, { recursive: true });
    const target = path.join(opts.uploadsDir, name);
    copied.push(target);
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(target, 0o644);
  }
  return `/uploads/${name}`;
}

// ---------- History ----------

interface LinePlan {
  service: ServiceRow | null;
  name: string;
  /** Raw title part of an unmapped line (for the report). */
  raw: string | null;
}

/** The longest run of consecutive title parts from `start` that names a service («Замена украшения + чистка прокола»). */
function longestMatch(parts: string[], start: number, lookup: Map<string, ServiceRow>) {
  for (let length = parts.length - start; length > 0; length -= 1) {
    const service = lookup.get(normalize(parts.slice(start, start + length).join(' + ')));
    if (service) return { service, length };
  }
  return null;
}

/** Title parts → service lines; a part that names no service becomes a custom line. */
export function matchTitleParts(parts: string[], lookup: Map<string, ServiceRow>): LinePlan[] {
  const lines: LinePlan[] = [];
  let i = 0;
  while (i < parts.length) {
    const match = longestMatch(parts, i, lookup);
    if (match) {
      lines.push({ service: match.service, name: match.service.name, raw: null });
      i += match.length;
    } else {
      lines.push({ service: null, name: prettifyName(parts[i]!), raw: parts[i]! });
      i += 1;
    }
  }
  return lines;
}

/** «ТАТУ» → «Тату»; names in normal case are kept. */
export function prettifyName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, ' ');
  const allCaps = name.length > 1 && name === name.toUpperCase() && name !== name.toLowerCase();
  return allCaps ? `${name[0]}${name.slice(1).toLowerCase()}` : name;
}

/** Splits `total` proportionally to `weights` (rounded down); the remainder goes to the heaviest line. */
export function splitPrice(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  const shares = weights.map((w) => Math.floor((total * w) / sum));
  const heaviest = weights.indexOf(Math.max(...weights));
  const remainder = total - shares.reduce((a, b) => a + b, 0);
  return shares.map((share, i) => (i === heaviest ? share + remainder : share));
}

const catalogWeight = (service: ServiceRow): number =>
  service.price > 0 ? service.price : service.priceMax && service.priceMax > 0 ? service.priceMax : 1;

function lineWeights(lines: LinePlan[]): number[] {
  const mapped = lines.flatMap((l) => (l.service ? [catalogWeight(l.service)] : []));
  const unmappedWeight = mapped.length > 0 ? mapped.reduce((a, b) => a + b, 0) / mapped.length : 1;
  return lines.map((l) => (l.service ? catalogWeight(l.service) : unmappedWeight));
}

/** Normalized names and aliases of the price-list entries → their catalog rows. */
function buildLookup(catalog: Map<string, ServiceRow>): Map<string, ServiceRow> {
  const lookup = new Map<string, ServiceRow>();
  for (const entry of PRICE_LIST) {
    const row = catalog.get(entry.key);
    if (!row) continue;
    for (const name of [row.name, entry.name, ...entry.aliases]) {
      const key = normalize(name);
      if (!lookup.has(key)) lookup.set(key, row);
    }
  }
  return lookup;
}

const increment = (counts: Map<string, number>, key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);

function topCounts(counts: Map<string, number>, limit = Infinity): Record<string, number> {
  const sorted = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ru'));
  return Object.fromEntries(sorted.slice(0, limit));
}

/**
 * Inserts the lines and points the appointment at the first catalog service. The title is kept as is: it is the
 * original YCLIENTS text, and `import-appointments` recognizes already imported visits by it.
 */
function saveLines(tx: DbOrTx, appointmentId: number, lines: LinePlan[], prices: number[], now: number): void {
  tx.insert(appointmentServices)
    .values(
      lines.map((line, position) => ({
        appointmentId,
        serviceId: line.service?.id ?? null,
        name: line.name,
        price: prices[position]!,
        durationMin: line.service?.durationMin ?? null,
        position,
      })),
    )
    .run();
  tx.update(appointments)
    .set({ serviceId: lines.find((l) => l.service)?.service?.id ?? null, updatedAt: now })
    .where(eq(appointments.id, appointmentId))
    .run();
}

/** Appointments with a title and no service lines yet, oldest first. */
function unlinkedAppointments(tx: DbOrTx) {
  const withLines = new Set(
    tx.selectDistinct({ id: appointmentServices.appointmentId }).from(appointmentServices).all().map((r) => r.id),
  );
  return tx
    .select({ id: appointments.id, title: appointments.title, price: appointments.price })
    .from(appointments)
    .where(isNotNull(appointments.title))
    .orderBy(asc(appointments.id))
    .all()
    .filter((a) => !withLines.has(a.id));
}

const titleParts = (title: string): string[] =>
  title
    .split(TITLE_SEPARATOR)
    .map((p) => p.trim().replace(/\s+/g, ' '))
    .filter(Boolean);

function linkHistory(tx: DbOrTx, catalog: Map<string, ServiceRow>, now: number): HistorySummary {
  const lookup = buildLookup(catalog);
  const mapped = new Map<string, number>();
  const unmapped = new Map<string, number>();
  const summary = { appointmentsLinked: 0, linesCreated: 0, skippedUnmapped: 0, sampleLinked: [] as LinkedSample[] };
  for (const appointment of unlinkedAppointments(tx)) {
    const title = appointment.title ?? '';
    const lines = matchTitleParts(titleParts(title), lookup);
    if (lines.length === 0) continue;
    for (const line of lines) if (!line.service) increment(unmapped, line.raw ?? line.name);
    // A title that names no catalog service is a free-form description (or a service outside the price list).
    if (!lines.some((l) => l.service)) {
      summary.skippedUnmapped += 1;
      continue;
    }

    saveLines(tx, appointment.id, lines, splitPrice(appointment.price, lineWeights(lines)), now);
    summary.appointmentsLinked += 1;
    summary.linesCreated += lines.length;
    for (const line of lines) if (line.service) increment(mapped, line.name);
    if (summary.sampleLinked.length < SAMPLE_LIMIT) summary.sampleLinked.push({ title, lines: lines.map((l) => l.name) });
  }
  return { ...summary, mappedByService: topCounts(mapped), unmapped: topCounts(unmapped, UNMAPPED_REPORT_LIMIT) };
}

// ---------- CLI ----------

const USAGE =
  'Usage: node dist/scripts/import-services.js [--apply] [--update-existing] [--link-history] [--images=<dir>]\n';
const FLAGS = new Set(['--apply', '--update-existing', '--link-history']);
const IMAGES_FLAG = '--images=';

/** Parses the command line; `null` when it contains an unknown argument. */
export function parseArgs(args: string[], dataDir: string, cwd = process.cwd()): ServiceImportOptions | null {
  if (args.some((a) => !FLAGS.has(a) && !(a.startsWith(IMAGES_FLAG) && a.length > IMAGES_FLAG.length))) return null;
  const images = args.find((a) => a.startsWith(IMAGES_FLAG))?.slice(IMAGES_FLAG.length);
  return {
    apply: args.includes('--apply'),
    updateExisting: args.includes('--update-existing'),
    linkHistory: args.includes('--link-history'),
    imagesDir: path.resolve(cwd, images ?? 'assets/service-images'),
    uploadsDir: path.resolve(cwd, dataDir, 'uploads'),
  };
}

function main(): void {
  const dataDir = process.env.DATA_DIR ?? './data';
  const opts = parseArgs(process.argv.slice(2), dataDir);
  if (!opts) {
    process.stderr.write(USAGE);
    process.exit(2);
  }
  const dbFile = path.join(dataDir, 'mikan.db');
  if (!fs.existsSync(dbFile)) {
    process.stderr.write(`База данных не найдена: ${path.resolve(dbFile)} (проверьте DATA_DIR)\n`);
    process.exit(1);
  }
  const { db, sqlite } = openDatabase(dbFile);
  try {
    process.stdout.write(`${JSON.stringify(importServices(db, opts), null, 2)}\n`);
  } finally {
    sqlite.close();
  }
}

if (isEntryPoint(import.meta.url)) main();
