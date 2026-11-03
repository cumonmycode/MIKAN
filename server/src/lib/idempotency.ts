import { createHash } from 'node:crypto';
import { and, eq, lt } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db, DbOrTx } from '../db/client.js';
import { idempotencyKeys } from '../db/schema.js';
import { badRequest, conflict } from './errors.js';

/** How long a stored response is replayed for a repeated key. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
export const IDEMPOTENCY_HEADER = 'idempotency-key';
/** Set on a response that was replayed from storage instead of being executed again. */
export const REPLAYED_HEADER = 'idempotent-replayed';

const keySchema = z.uuid();

/** The validated, lower-cased `Idempotency-Key` header, or null when the request has none. */
export function idempotencyKeyOf(request: FastifyRequest): string | null {
  const raw = request.headers[IDEMPOTENCY_HEADER];
  if (raw === undefined) return null;
  const parsed = keySchema.safeParse(typeof raw === 'string' ? raw.trim() : raw);
  if (!parsed.success) throw badRequest('Некорректный заголовок Idempotency-Key: ожидается UUID');
  return parsed.data.toLowerCase();
}

/** JSON with object keys sorted, so the same body always hashes the same regardless of key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function requestHash(endpoint: string, body: unknown): string {
  return createHash('sha256').update(`${endpoint}\n${canonicalJson(body ?? null)}`).digest('hex');
}

/** Prunes expired keys and returns the stored response of `key`, `409` when it was stored for another request. */
function storedResponse(db: DbOrTx, scope: number, key: string, hash: string, now: number): { json: string } | null {
  db.delete(idempotencyKeys).where(lt(idempotencyKeys.createdAt, now - IDEMPOTENCY_TTL_MS)).run();
  const stored = db
    .select()
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.employeeId, scope), eq(idempotencyKeys.key, key)))
    .get();
  if (!stored) return null;
  if (stored.requestHash !== hash) throw conflict('Повторный запрос отличается от исходного. Обновите экран и попробуйте снова.');
  return { json: stored.responseJson };
}

/** Keys of the public booking API (no employee): stored with `employee_id` 0. */
export const PUBLIC_IDEMPOTENCY_SCOPE = 0;

/** Async runs in progress per database, so a retry arriving meanwhile waits and replays instead of running twice. */
const running = new WeakMap<Db, Map<string, Promise<unknown>>>();

/**
 * `idempotent` for an asynchronous write (one that awaits a bank or Telegram): the same rules, for keys of `scope`.
 * The response is stored once `run` succeeds; a repeat arriving while it runs waits for it, then replays it.
 */
export async function idempotentAsync<T>(
  db: Db,
  request: FastifyRequest,
  reply: FastifyReply,
  scope: number,
  run: () => Promise<T>,
): Promise<T> {
  const key = idempotencyKeyOf(request);
  if (!key) return run();
  const endpoint = `${request.method} ${request.url.split('?')[0]}`;
  const hash = requestHash(endpoint, request.body);
  const inFlight = running.get(db) ?? new Map<string, Promise<unknown>>();
  running.set(db, inFlight);
  const slot = `${scope}:${key}`;
  for (let previous = inFlight.get(slot); previous; previous = inFlight.get(slot)) await previous.catch(() => undefined);
  const stored = storedResponse(db, scope, key, hash, Date.now());
  if (stored) {
    reply.header(REPLAYED_HEADER, 'true');
    return JSON.parse(stored.json) as T;
  }
  const work = run();
  inFlight.set(slot, work);
  try {
    const response = await work;
    db.insert(idempotencyKeys)
      .values({ key, employeeId: scope, endpoint, requestHash: hash, responseJson: JSON.stringify(response), createdAt: Date.now() })
      .onConflictDoNothing()
      .run();
    return response;
  } finally {
    if (inFlight.get(slot) === work) inFlight.delete(slot);
  }
}

/**
 * Runs a write at most once per `Idempotency-Key` (per employee, kept 24 h).
 *
 * The first request executes `run` and stores its response in the same transaction; a repeat with the same key,
 * endpoint and body gets the stored response (with `Idempotent-Replayed: true`) without executing `run` again.
 * A repeat with a different endpoint or body is `409 conflict`. Errors are not stored: a failed write changed
 * nothing, so retrying it with the same key simply executes it again. Without the header `run` just executes.
 *
 * Everything here is synchronous (better-sqlite3), so concurrent retries of one key cannot interleave.
 */
export function idempotent<T>(db: Db, request: FastifyRequest, reply: FastifyReply, run: (tx: DbOrTx) => T): T {
  const key = idempotencyKeyOf(request);
  if (!key) return run(db);
  const endpoint = `${request.method} ${request.url.split('?')[0]}`;
  const hash = requestHash(endpoint, request.body);
  const employeeId = request.employee.id;

  return db.transaction((tx) => {
    const now = Date.now();
    const stored = storedResponse(tx, employeeId, key, hash, now);
    if (stored) {
      reply.header(REPLAYED_HEADER, 'true');
      return JSON.parse(stored.json) as T;
    }
    const response = run(tx);
    tx.insert(idempotencyKeys)
      .values({ key, employeeId, endpoint, requestHash: hash, responseJson: JSON.stringify(response), createdAt: now })
      .run();
    return response;
  });
}
