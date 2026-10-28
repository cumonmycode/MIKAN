import { and, desc, eq, gte, isNull, type SQL } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { DbOrTx } from '../db/client.js';
import { authSessions } from '../db/schema.js';
import { notFound, unauthorized } from '../lib/errors.js';
import { employeeRef, type EmployeeRef } from '../lib/serialize.js';
import { toIso } from '../lib/time.js';
import { employeesByIds } from './refs.js';

/**
 * Sign-in sessions (docs/API.md «Sessions»): every login opens one, its id (`sid`) rides in the token, and a request
 * with the token of an ended session is refused. Tokens issued before sessions existed carry no `sid` and are
 * checked only by `tokenVersion`, as before.
 */

export type SessionRow = typeof authSessions.$inferSelect;

/** How long a token lives (`expiresIn` of the JWT) and how long an unused session lasts. */
export const SESSION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_MS = SESSION_DAYS * DAY_MS;
/** `lastSeenAt` is written at most this often. */
export const SEEN_THROTTLE_MS = 60_000;
const MAX_DEVICE = 200;

export const SESSION_ENDED_MESSAGE = 'Сессия завершена — войдите снова';
const NOT_FOUND_MESSAGE = 'Сессия не найдена';

const sessionEnded = () => unauthorized(SESSION_ENDED_MESSAGE);

/**
 * Node reads header bytes as Latin-1; the app sends UTF-8 («·» in «iPhone 16 Pro · MIKAN 13»). Bytes that form valid
 * UTF-8 are decoded as such, anything else is kept as it came.
 */
function headerText(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return null;
  let text = raw;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(raw, 'latin1'));
  } catch {
    // Not UTF-8: a plain Latin-1 value.
  }
  const trimmed = text.trim();
  return trimmed ? trimmed.slice(0, MAX_DEVICE) : null;
}

/** «iPhone 16 Pro · MIKAN 13» from `X-Device`, else the user agent. */
export function deviceOf(request: FastifyRequest): string | null {
  return headerText(request.headers['x-device']) ?? headerText(request.headers['user-agent']);
}

export function openSession(db: DbOrTx, input: { employeeId: number; device: string | null; ip: string | null }, now = Date.now()): SessionRow {
  return db
    .insert(authSessions)
    .values({ employeeId: input.employeeId, device: input.device, ip: input.ip, createdAt: now, lastSeenAt: now })
    .returning()
    .get();
}

/** Not ended, used within the last 90 days, and its token not yet expired. */
function liveCondition(now: number): SQL {
  return and(isNull(authSessions.revokedAt), gte(authSessions.lastSeenAt, now - SESSION_MS), gte(authSessions.createdAt, now - SESSION_MS))!;
}

/**
 * The session of a token (`sid`): ended, unknown or someone else's → `401`; unused for 90 days → ended now, `401`.
 * Marks it seen (at most once a minute).
 */
export function touchSession(db: DbOrTx, sid: unknown, employeeId: number, now = Date.now()): number {
  if (typeof sid !== 'number' || !Number.isSafeInteger(sid) || sid <= 0) throw sessionEnded();
  const row = db.select().from(authSessions).where(eq(authSessions.id, sid)).get();
  if (!row || row.employeeId !== employeeId || row.revokedAt !== null) throw sessionEnded();
  if (row.lastSeenAt < now - SESSION_MS) {
    endSession(db, sid, now);
    throw sessionEnded();
  }
  if (now - row.lastSeenAt >= SEEN_THROTTLE_MS) {
    db.update(authSessions).set({ lastSeenAt: now }).where(eq(authSessions.id, sid)).run();
  }
  return sid;
}

/** Ends one session; an ended one stays as it was. */
export function endSession(db: DbOrTx, id: number, now = Date.now()): void {
  db.update(authSessions)
    .set({ revokedAt: now })
    .where(and(eq(authSessions.id, id), isNull(authSessions.revokedAt)))
    .run();
}

/** A password change or deactivation signs the employee out everywhere. */
export function endEmployeeSessions(db: DbOrTx, employeeId: number, now = Date.now()): void {
  db.update(authSessions)
    .set({ revokedAt: now })
    .where(and(eq(authSessions.employeeId, employeeId), isNull(authSessions.revokedAt)))
    .run();
}

export function getSessionRow(db: DbOrTx, id: number): SessionRow {
  const row = db.select().from(authSessions).where(eq(authSessions.id, id)).get();
  if (!row) throw notFound(NOT_FOUND_MESSAGE);
  return row;
}

export interface SessionOut {
  id: number;
  employee: EmployeeRef;
  device: string | null;
  ip: string | null;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

/** Active sessions, most recently used first; `employeeId` limits them to one employee. */
export function listSessions(db: DbOrTx, filter: { employeeId?: number }, currentId: number | null, now = Date.now()): SessionOut[] {
  const live = liveCondition(now);
  const rows = db
    .select()
    .from(authSessions)
    .where(filter.employeeId === undefined ? live : and(live, eq(authSessions.employeeId, filter.employeeId)))
    .orderBy(desc(authSessions.lastSeenAt), desc(authSessions.id))
    .all();
  const people = employeesByIds(db, rows.map((r) => r.employeeId));
  return rows.flatMap((r) => {
    const employee = people.get(r.employeeId);
    if (!employee) return [];
    return [
      {
        id: r.id,
        employee: employeeRef(employee),
        device: r.device,
        ip: r.ip,
        createdAt: toIso(r.createdAt),
        lastSeenAt: toIso(r.lastSeenAt),
        current: r.id === currentId,
      },
    ];
  });
}

/** What the audit entry of ending a session names: whose and which device. */
export interface SessionSnapshot {
  employee: { id: number; name: string };
  device: string | null;
}

export function sessionSnapshot(db: DbOrTx, id: number | null): SessionSnapshot | undefined {
  if (id === null || !Number.isSafeInteger(id)) return undefined;
  const row = db.select().from(authSessions).where(eq(authSessions.id, id)).get();
  if (!row) return undefined;
  const employee = employeesByIds(db, [row.employeeId]).get(row.employeeId);
  return { employee: { id: row.employeeId, name: employee?.name ?? `№${row.employeeId}` }, device: row.device };
}
