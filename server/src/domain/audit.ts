import { and, count, desc, eq, gte, inArray, lt, type SQL } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { silentLogger, type Logger } from '../context.js';
import type { DbOrTx } from '../db/client.js';
import { auditLog } from '../db/schema.js';
import { errorMessage } from '../lib/errors.js';
import { employeeRef } from '../lib/serialize.js';
import { toIso } from '../lib/time.js';
import { employeesByIds } from './refs.js';

/**
 * The action log (docs/API.md «Audit log»): who changed what and when. Rows are written by the capture hook of every
 * successful write from the app (routes/audit-capture.ts), by client actions in the bot and by what the server does
 * by itself (domain/audit-events.ts). Writing never fails the action it describes.
 */

export const AUDIT_SOURCES = ['app', 'bot_staff', 'bot', 'online', 'system'] as const;
export type AuditSource = (typeof AUDIT_SOURCES)[number];

/** Rows older than this are pruned once a day. */
export const AUDIT_RETENTION_YEARS = 2;

export type AuditChanges = Record<string, { from: unknown; to: unknown }>;

/** What happened, without who and when. */
export interface AuditDraft {
  /** `<entity>.<verb>`, e.g. `appointment.move`. */
  action: string;
  entity: string;
  entityId: number | null;
  /** Russian, impersonal (the employee's gender is not stored). */
  summary: string;
  changes?: AuditChanges | null;
}

export interface AuditEntryInput extends AuditDraft {
  source: AuditSource;
  employeeId: number | null;
  at?: number;
}

/** Keys never stored in `changes`, at any depth: passwords, their hashes, tokens and other secrets. */
const SECRET_KEY = /pass(word)?|hash|token|secret|jwt|api_?key|staff_?code/i;
const MAX_TEXT = 300;
const MAX_SUMMARY = 1000;

let fallbackLog: Logger = silentLogger;

/** The logger for failures of writes made without one (domain code deep inside transactions). */
export function setAuditLogger(log: Logger): void {
  fallbackLog = log;
}

/** Drops secret keys and shortens long texts, recursively. */
export function scrubSecrets(value: unknown): unknown {
  if (typeof value === 'string') return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT - 1)}…` : value;
  if (Array.isArray(value)) return value.map(scrubSecrets);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !SECRET_KEY.test(key))
      .map(([key, v]) => [key, scrubSecrets(v)]),
  );
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** An embedded reference (`EmployeeRef`, `ClientRef`, `ServiceRef`) is shown by id and name only. */
function compactRef(value: unknown): unknown {
  if (!isPlainObject(value) || typeof value.id !== 'number' || typeof value.name !== 'string') return value;
  if (Object.keys(value).length > 6) return value;
  const lastName = typeof value.lastName === 'string' && value.lastName.trim() ? ` ${value.lastName.trim()}` : '';
  return { id: value.id, name: `${value.name}${lastName}` };
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * `{ field: { from, to } }` of the top-level fields both snapshots have and that differ (embedded references compared
 * by id and name), without `ignore`d fields, timestamps and secrets; null when nothing differs or a side is missing.
 */
export function diffChanges(before: unknown, after: unknown, ignore: readonly string[] = []): AuditChanges | null {
  if (!isPlainObject(before) || !isPlainObject(after)) return null;
  const skipped = new Set(['createdAt', 'updatedAt', ...ignore]);
  const changes: AuditChanges = {};
  for (const key of Object.keys(after)) {
    if (skipped.has(key) || SECRET_KEY.test(key) || !(key in before)) continue;
    const from = compactRef(before[key]);
    const to = compactRef(after[key]);
    if (!sameValue(from, to)) changes[key] = { from: scrubSecrets(from ?? null), to: scrubSecrets(to ?? null) };
  }
  return Object.keys(changes).length ? changes : null;
}

/** Records one entry. Never throws: a failure is logged and the action it describes goes on. */
export function writeAudit(db: DbOrTx, entry: AuditEntryInput, log: Logger = fallbackLog): boolean {
  try {
    const changes = entry.changes ? scrubSecrets(entry.changes) : null;
    db.insert(auditLog)
      .values({
        at: entry.at ?? Date.now(),
        employeeId: entry.employeeId,
        source: entry.source,
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId,
        summary: entry.summary.slice(0, MAX_SUMMARY),
        changes: changes && Object.keys(changes).length ? JSON.stringify(changes) : null,
      })
      .run();
    return true;
  } catch (err) {
    log.error({ err: errorMessage(err), action: entry.action, entityId: entry.entityId }, 'audit log write failed');
    return false;
  }
}

/** Builds and writes an entry (lookups included) without ever throwing. */
export function auditSafely(record: () => void, log: Logger = fallbackLog): void {
  try {
    record();
  } catch (err) {
    log.error({ err: errorMessage(err) }, 'audit log entry failed');
  }
}

/** Deletes entries older than the retention period; returns how many. */
export function pruneAuditLog(db: DbOrTx, now = Date.now()): number {
  const cutoff = DateTime.fromMillis(now, { zone: 'utc' }).minus({ years: AUDIT_RETENTION_YEARS }).toMillis();
  return db.delete(auditLog).where(lt(auditLog.at, cutoff)).run().changes;
}

export interface AuditFilter {
  from?: number;
  to?: number;
  employeeId?: number;
  /** One or several entities. */
  entities?: string[];
  entityId?: number;
  source?: AuditSource;
  limit: number;
  offset: number;
}

function parseChanges(json: string | null): AuditChanges | null {
  if (!json) return null;
  try {
    const value: unknown = JSON.parse(json);
    return isPlainObject(value) ? (value as AuditChanges) : null;
  } catch {
    return null;
  }
}

/** Newest first, with the total count for paging. */
export function listAudit(db: DbOrTx, f: AuditFilter) {
  const conditions: SQL[] = [];
  if (f.from !== undefined) conditions.push(gte(auditLog.at, f.from));
  if (f.to !== undefined) conditions.push(lt(auditLog.at, f.to));
  if (f.employeeId !== undefined) conditions.push(eq(auditLog.employeeId, f.employeeId));
  if (f.entities?.length) conditions.push(inArray(auditLog.entity, f.entities));
  if (f.entityId !== undefined) conditions.push(eq(auditLog.entityId, f.entityId));
  if (f.source !== undefined) conditions.push(eq(auditLog.source, f.source));
  const where = conditions.length ? and(...conditions) : undefined;
  const rows = db
    .select()
    .from(auditLog)
    .where(where)
    .orderBy(desc(auditLog.at), desc(auditLog.id))
    .limit(f.limit)
    .offset(f.offset)
    .all();
  const total = db.select({ n: count() }).from(auditLog).where(where).get()?.n ?? 0;
  const staff = employeesByIds(db, rows.map((r) => r.employeeId));
  const items = rows.map((r) => {
    const employee = r.employeeId != null ? staff.get(r.employeeId) : undefined;
    return {
      id: r.id,
      at: toIso(r.at),
      employee: employee ? employeeRef(employee) : null,
      source: r.source,
      action: r.action,
      entity: r.entity,
      entityId: r.entityId,
      summary: r.summary,
      changes: parseChanges(r.changes),
    };
  });
  return { items, total };
}
