import { and, desc, eq, inArray } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { pushDevices } from '../db/schema.js';
import { badRequest } from '../lib/errors.js';
import type { ApnsEnvironment } from './apns.js';

/** The staff iPhones that get pushes: registered after sign-in, removed on sign-out or when Apple rejects them. */

/** APNs tokens are hex of variable length (32 bytes today); stored lowercase. ≤ 100 digits: Fastify's path param limit. */
const DEVICE_TOKEN = /^(?:[0-9a-f]{2}){16,50}$/;
/** More devices than anyone uses: the least recently seen beyond it are forgotten. */
export const MAX_DEVICES_PER_EMPLOYEE = 10;

/** The token in its stored form, or `400` «Некорректный токен устройства». */
export function deviceToken(value: unknown): string {
  const token = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!DEVICE_TOKEN.test(token)) throw badRequest('Некорректный токен устройства');
  return token;
}

/**
 * Registers the device for the employee: a token registered by someone else moves to them; `lastSeenAt` is now.
 * Keeps the employee's MAX_DEVICES_PER_EMPLOYEE most recently seen devices.
 */
export function registerDevice(
  db: DbOrTx,
  employeeId: number,
  device: { token: string; environment: ApnsEnvironment },
  now = Date.now(),
): void {
  db.insert(pushDevices)
    .values({ employeeId, token: device.token, environment: device.environment, createdAt: now, lastSeenAt: now })
    .onConflictDoUpdate({
      target: pushDevices.token,
      set: { employeeId, environment: device.environment, lastSeenAt: now },
    })
    .run();
  const stale = db
    .select({ id: pushDevices.id })
    .from(pushDevices)
    .where(eq(pushDevices.employeeId, employeeId))
    .orderBy(desc(pushDevices.lastSeenAt), desc(pushDevices.id))
    .all()
    .slice(MAX_DEVICES_PER_EMPLOYEE)
    .map((row) => row.id);
  if (stale.length > 0) db.delete(pushDevices).where(inArray(pushDevices.id, stale)).run();
}

/** Sign-out: removes the employee's own device (someone else's token is left alone). */
export function unregisterDevice(db: DbOrTx, employeeId: number, token: string): void {
  db.delete(pushDevices)
    .where(and(eq(pushDevices.token, token), eq(pushDevices.employeeId, employeeId)))
    .run();
}
