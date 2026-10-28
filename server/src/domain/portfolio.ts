import { and, asc, count, desc, eq, inArray, max, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { employees, portfolioPhotos, services } from '../db/schema.js';
import { badRequest, notFound } from '../lib/errors.js';
import { serviceRef, type EmployeeRow, type ServiceRow } from '../lib/serialize.js';
import { toIso } from '../lib/time.js';
import { onlineMasters } from './online-booking-slots.js';
import { forbidden, roleOf } from './permissions.js';
import { employeeRefOrMissing, employeesByIds, servicesByIds } from './refs.js';

/**
 * Masters' portfolio (docs/API.md «Portfolio»): photos of their work, optionally tied to a service. Masters manage
 * their own, owner and admin everyone's; the booking page and the bot show the photos of working masters.
 */

export type PortfolioRow = typeof portfolioPhotos.$inferSelect;

export const MAX_PORTFOLIO_PHOTOS = 100;
export const MAX_PORTFOLIO_CAPTION = 300;
/** Photos of one service on the booking page (every master's, newest first). */
export const PUBLIC_SERVICE_PORTFOLIO_LIMIT = 30;
export const OWN_PORTFOLIO_MESSAGE = 'Можно менять только своё портфолио';
const NOT_A_MASTER_MESSAGE = 'Портфолио ведётся только у работающих мастеров';

/** `403` unless the employee may change this master's portfolio: a master only their own. */
export function assertManagesPortfolio(actor: Pick<EmployeeRow, 'id' | 'role'>, employeeId: number): void {
  if (roleOf(actor) === 'master' && actor.id !== employeeId) throw forbidden(OWN_PORTFOLIO_MESSAGE);
}

export function getPortfolioRow(db: DbOrTx, id: number): PortfolioRow {
  const row = db.select().from(portfolioPhotos).where(eq(portfolioPhotos.id, id)).get();
  if (!row) throw notFound('Фото не найдено');
  return row;
}

/** Staff shape, refs looked up in two queries for the whole list. */
export function serializePortfolio(db: DbOrTx, rows: PortfolioRow[]) {
  const masters = employeesByIds(db, rows.map((r) => r.employeeId));
  const serviceRows = servicesByIds(db, rows.map((r) => r.serviceId));
  return rows.map((r) => {
    const service = r.serviceId == null ? undefined : serviceRows.get(r.serviceId);
    return {
      id: r.id,
      employee: employeeRefOrMissing(masters, r.employeeId)!,
      imageUrl: r.imageUrl,
      caption: r.caption,
      service: service ? serviceRef(service) : null,
      sort: r.sort,
      createdAt: toIso(r.createdAt),
    };
  });
}
export type PortfolioPhotoOut = ReturnType<typeof serializePortfolio>[number];

export const serializePortfolioPhoto = (db: DbOrTx, row: PortfolioRow): PortfolioPhotoOut => serializePortfolio(db, [row])[0]!;

const byMasterOrder = [asc(portfolioPhotos.employeeId), asc(portfolioPhotos.sort), asc(portfolioPhotos.id)];

function masterRows(db: DbOrTx, employeeId: number): PortfolioRow[] {
  return db.select().from(portfolioPhotos).where(eq(portfolioPhotos.employeeId, employeeId)).orderBy(...byMasterOrder).all();
}

/** `GET /portfolio`: in each master's order. */
export function listPortfolio(db: DbOrTx, q: { employeeId?: number; serviceId?: number }): PortfolioPhotoOut[] {
  const where: SQL[] = [];
  if (q.employeeId !== undefined) where.push(eq(portfolioPhotos.employeeId, q.employeeId));
  if (q.serviceId !== undefined) where.push(eq(portfolioPhotos.serviceId, q.serviceId));
  const rows = db.select().from(portfolioPhotos).where(and(...where)).orderBy(...byMasterOrder).all();
  return serializePortfolio(db, rows);
}

/** The master whose portfolio is changed: an active employee who performs procedures. */
function assertPortfolioMaster(db: DbOrTx, employeeId: number): void {
  const master = db.select().from(employees).where(eq(employees.id, employeeId)).get();
  if (!master) throw notFound('Сотрудник не найден');
  if (!master.active || !master.isMaster) throw badRequest(NOT_A_MASTER_MESSAGE);
}

function assertService(db: DbOrTx, serviceId: number | null | undefined): void {
  if (serviceId == null) return;
  if (!db.select({ id: services.id }).from(services).where(eq(services.id, serviceId)).get()) throw badRequest('Услуга не найдена');
}

export interface PortfolioPhotoInput {
  employeeId: number;
  imageUrl: string;
  serviceId?: number | null;
  caption?: string | null;
}

/** Appends a photo to the end of the master's portfolio. */
export function addPortfolioPhoto(db: DbOrTx, input: PortfolioPhotoInput, createdBy: number): PortfolioPhotoOut {
  return db.transaction((tx) => {
    assertPortfolioMaster(tx, input.employeeId);
    assertService(tx, input.serviceId);
    const stats = tx
      .select({ n: count(), last: max(portfolioPhotos.sort) })
      .from(portfolioPhotos)
      .where(eq(portfolioPhotos.employeeId, input.employeeId))
      .get();
    if ((stats?.n ?? 0) >= MAX_PORTFOLIO_PHOTOS) throw badRequest(`В портфолио мастера не больше ${MAX_PORTFOLIO_PHOTOS} фото`);
    const row = tx
      .insert(portfolioPhotos)
      .values({
        employeeId: input.employeeId,
        serviceId: input.serviceId ?? null,
        imageUrl: input.imageUrl,
        caption: input.caption ?? null,
        sort: stats?.last == null ? 0 : stats.last + 1,
        createdBy,
        createdAt: Date.now(),
      })
      .returning()
      .get();
    return serializePortfolioPhoto(tx, row);
  });
}

/** `undefined` leaves a field as it is, `null` clears it. */
export function updatePortfolioPhoto(
  db: DbOrTx,
  id: number,
  input: { caption?: string | null; serviceId?: number | null },
): PortfolioPhotoOut {
  return db.transaction((tx) => {
    const current = getPortfolioRow(tx, id);
    assertService(tx, input.serviceId);
    const row = tx
      .update(portfolioPhotos)
      .set({
        caption: input.caption === undefined ? current.caption : input.caption,
        serviceId: input.serviceId === undefined ? current.serviceId : input.serviceId,
      })
      .where(eq(portfolioPhotos.id, id))
      .returning()
      .get();
    return serializePortfolioPhoto(tx, row);
  });
}

/** Puts every photo of the master in the given order. */
export function orderPortfolio(db: DbOrTx, employeeId: number, ids: number[]): PortfolioPhotoOut[] {
  return db.transaction((tx) => {
    if (new Set(ids).size !== ids.length) throw badRequest('Фото указано дважды');
    const current = new Set(masterRows(tx, employeeId).map((r) => r.id));
    if (current.size !== ids.length || ids.some((id) => !current.has(id))) throw badRequest('Перечислите все фото мастера');
    ids.forEach((id, sort) => tx.update(portfolioPhotos).set({ sort }).where(eq(portfolioPhotos.id, id)).run());
    return serializePortfolio(tx, masterRows(tx, employeeId));
  });
}

export function deletePortfolioPhoto(db: DbOrTx, id: number): void {
  getPortfolioRow(db, id);
  db.delete(portfolioPhotos).where(eq(portfolioPhotos.id, id)).run();
}

// ---------- what clients see ----------

export interface PublicPortfolioItem {
  imageUrl: string;
  caption: string | null;
  service: { id: number; name: string } | null;
  master: { id: number; name: string };
}

function publicItems(db: DbOrTx, rows: PortfolioRow[], masters: Map<number, EmployeeRow>): PublicPortfolioItem[] {
  const serviceRows = servicesByIds(db, rows.map((r) => r.serviceId));
  return rows.flatMap((r) => {
    const master = masters.get(r.employeeId);
    if (!master) return [];
    // A hidden service is not in the public catalog, so clients do not see its name either.
    const service: ServiceRow | undefined = r.serviceId == null ? undefined : serviceRows.get(r.serviceId);
    const shown = service?.active ? service : undefined;
    return [
      {
        imageUrl: r.imageUrl,
        caption: r.caption,
        service: shown ? { id: shown.id, name: shown.name } : null,
        master: { id: master.id, name: master.name },
      },
    ];
  });
}

const workingMasters = (db: DbOrTx): Map<number, EmployeeRow> => new Map(onlineMasters(db).map((m) => [m.id, m]));

/** A working master's photos in their order; `404` for anyone clients cannot book. */
export function publicMasterPortfolio(db: DbOrTx, masterId: number): PublicPortfolioItem[] {
  const masters = workingMasters(db);
  if (!masters.has(masterId)) throw notFound('Мастер не найден');
  return publicItems(db, masterRows(db, masterId), masters);
}

/** Photos of an active service by every working master, newest first. */
export function publicServicePortfolio(db: DbOrTx, serviceId: number, limit = PUBLIC_SERVICE_PORTFOLIO_LIMIT): PublicPortfolioItem[] {
  const masters = workingMasters(db);
  const service = db.select({ active: services.active }).from(services).where(eq(services.id, serviceId)).get();
  if (masters.size === 0 || !service?.active) return [];
  const rows = db
    .select()
    .from(portfolioPhotos)
    .where(and(eq(portfolioPhotos.serviceId, serviceId), inArray(portfolioPhotos.employeeId, [...masters.keys()])))
    .orderBy(desc(portfolioPhotos.createdAt), desc(portfolioPhotos.id))
    .limit(limit)
    .all();
  return publicItems(db, rows, masters);
}

/** Per master: how many photos and the first one (the cover). */
export function portfolioCovers(db: DbOrTx, masterIds: number[]): Map<number, { photos: number; cover: string | null }> {
  const result = new Map(masterIds.map((id) => [id, { photos: 0, cover: null as string | null }]));
  if (masterIds.length === 0) return result;
  const rows = db
    .select({ employeeId: portfolioPhotos.employeeId, imageUrl: portfolioPhotos.imageUrl })
    .from(portfolioPhotos)
    .where(inArray(portfolioPhotos.employeeId, masterIds))
    .orderBy(...byMasterOrder)
    .all();
  for (const row of rows) {
    const entry = result.get(row.employeeId)!;
    result.set(row.employeeId, { photos: entry.photos + 1, cover: entry.cover ?? row.imageUrl });
  }
  return result;
}

/** Per service: the number of working masters' photos of it. */
export function servicePortfolioCounts(db: DbOrTx): Map<number, number> {
  const masterIds = onlineMasters(db).map((m) => m.id);
  if (masterIds.length === 0) return new Map();
  const rows = db
    .select({ serviceId: portfolioPhotos.serviceId, n: count() })
    .from(portfolioPhotos)
    .where(inArray(portfolioPhotos.employeeId, masterIds))
    .groupBy(portfolioPhotos.serviceId)
    .all();
  return new Map(rows.flatMap((r) => (r.serviceId == null ? [] : [[r.serviceId, r.n] as const])));
}
