import { eq } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import type { DbOrTx } from '../db/client.js';
import { employees, pushDevices } from '../db/schema.js';
import { roleOf, type Role } from '../domain/permissions.js';
import { errorMessage } from '../lib/errors.js';
import type { ApnsConfig } from './apns-config.js';
import {
  apnsPayload,
  apnsRequest,
  providerTokens,
  type ApnsEnvironment,
  type ApnsResponse,
  type ApnsTransport,
  type ProviderTokens,
} from './apns.js';

/** Staff pushes (docs/API.md «Push notifications»): who gets which event, delivery and cleanup of dead devices. */

export const STAFF_PUSH_TYPES = ['online_booking', 'deposit_paid', 'client_message', 'booking_request', 'client_cancelled'] as const;
export type StaffPushType = (typeof STAFF_PUSH_TYPES)[number];

/** The ids the app opens on tap — the `data` of the events table besides `type`. */
export type StaffPushData = { appointmentId: number } | { chatId: number } | { bookingRequestId: number };

export interface StaffPush {
  type: StaffPushType;
  title: string;
  body: string;
  data: StaffPushData;
  /** The booked master / the appointment's master: gets the appointment events besides owners and admins. */
  masterId?: number | null;
}

export interface PushOutcome {
  sent: number;
  failed: number;
  /** Devices Apple no longer knows, deleted. */
  removed: number;
}

const MANAGERS: readonly Role[] = ['owner', 'admin'];
/** Who gets each event: roles (or everyone), and whether the appointment's master too. */
const AUDIENCE: Readonly<Record<StaffPushType, { roles: readonly Role[] | 'everyone'; master: boolean }>> = {
  online_booking: { roles: MANAGERS, master: true },
  deposit_paid: { roles: MANAGERS, master: true },
  client_message: { roles: 'everyone', master: false },
  booking_request: { roles: MANAGERS, master: false },
  client_cancelled: { roles: MANAGERS, master: true },
};

/** Apple says the token is dead: the app was removed, or the token belongs to another environment. */
const GONE_REASONS = new Set(['BadDeviceToken', 'Unregistered']);
const PROVIDER_TOKEN_REASONS = new Set(['ExpiredProviderToken', 'InvalidProviderToken']);

const NOTHING: PushOutcome = { sent: 0, failed: 0, removed: 0 };

interface RecipientDevice {
  id: number;
  employeeId: number;
  token: string;
  environment: ApnsEnvironment;
}

/** Devices of the active employees the event is for. */
export function recipientDevices(db: DbOrTx, push: Pick<StaffPush, 'type' | 'masterId'>): RecipientDevice[] {
  const audience = AUDIENCE[push.type];
  const wanted = (employee: { id: number; role: string }) =>
    audience.roles === 'everyone' ||
    audience.roles.includes(roleOf(employee)) ||
    (audience.master && push.masterId != null && employee.id === push.masterId);
  return db
    .select({ device: pushDevices, employee: { id: employees.id, role: employees.role } })
    .from(pushDevices)
    .innerJoin(employees, eq(employees.id, pushDevices.employeeId))
    .where(eq(employees.active, true))
    .all()
    .filter((row) => wanted(row.employee))
    .map(({ device }) => ({
      id: device.id,
      employeeId: device.employeeId,
      token: device.token,
      environment: device.environment as ApnsEnvironment,
    }));
}

/** One provider token cache per configuration (the process keeps one). */
const tokenCaches = new WeakMap<ApnsConfig, ProviderTokens>();

function tokensFor(config: ApnsConfig): ProviderTokens {
  const existing = tokenCaches.get(config);
  if (existing) return existing;
  const created = providerTokens(config);
  tokenCaches.set(config, created);
  return created;
}

const isGone = (response: ApnsResponse) =>
  response.status === 410 || (response.reason !== null && GONE_REASONS.has(response.reason));

type DeviceResult = keyof PushOutcome;

async function deliver(
  ctx: AppContext,
  transport: ApnsTransport,
  config: ApnsConfig,
  device: RecipientDevice,
  payload: Record<string, unknown>,
  type: StaffPushType,
): Promise<DeviceResult> {
  const now = Date.now();
  const tokens = tokensFor(config);
  const providerToken = tokens.current(now);
  const where = { deviceId: device.id, employeeId: device.employeeId, environment: device.environment, type };
  let response: ApnsResponse;
  try {
    response = await transport.send(apnsRequest(config, providerToken, device, payload, now));
  } catch (err) {
    ctx.log.warn({ ...where, err: errorMessage(err) }, 'push not delivered');
    return 'failed';
  }
  if (response.status === 200) return 'sent';
  if (isGone(response)) {
    ctx.db.delete(pushDevices).where(eq(pushDevices.id, device.id)).run();
    ctx.log.info({ ...where, status: response.status, reason: response.reason }, 'push device removed');
    return 'removed';
  }
  if (response.reason !== null && PROVIDER_TOKEN_REASONS.has(response.reason)) tokens.invalidate(providerToken);
  ctx.log.warn({ ...where, status: response.status, reason: response.reason }, 'APNs refused a push');
  return 'failed';
}

/** A push, or how to build it — built only when pushes are on, and a failure to build it is only logged. */
export type StaffPushSource = StaffPush | (() => StaffPush);

/** Pushes still talking to Apple, per app. */
const inFlight = new WeakMap<AppContext, Set<Promise<PushOutcome>>>();

/**
 * Starts the push in the background: the action that triggered it never waits for Apple and never fails because of
 * it. Does nothing (not even building the push) without `config.apns` or a transport.
 */
export function sendStaffPush(ctx: AppContext, source: StaffPushSource): void {
  if (!ctx.config.apns || !ctx.apns) return;
  let push: StaffPush;
  try {
    push = typeof source === 'function' ? source() : source;
  } catch (err) {
    ctx.log.error({ err: errorMessage(err) }, 'staff push not built');
    return;
  }
  const pending = inFlight.get(ctx) ?? new Set<Promise<PushOutcome>>();
  inFlight.set(ctx, pending);
  const run: Promise<PushOutcome> = pushToStaff(ctx, push).finally(() => pending.delete(run));
  pending.add(run);
}

/** Resolves once every push started so far has finished (tests). */
export async function pushesSettled(ctx: AppContext): Promise<void> {
  await Promise.all([...(inFlight.get(ctx) ?? [])]);
}

/**
 * Pushes the event to the staff it is for (docs/API.md «Push notifications») and resolves when Apple answered. Off
 * without `config.apns` or a transport. Never throws: a failed push is logged.
 */
export async function pushToStaff(ctx: AppContext, push: StaffPush): Promise<PushOutcome> {
  const { apns: config } = ctx.config;
  const transport = ctx.apns;
  if (!config || !transport) return NOTHING;
  try {
    const devices = recipientDevices(ctx.db, push);
    if (devices.length === 0) return NOTHING;
    const payload = apnsPayload(push);
    const results = await Promise.all(devices.map((device) => deliver(ctx, transport, config, device, payload, push.type)));
    return {
      sent: results.filter((r) => r === 'sent').length,
      failed: results.filter((r) => r === 'failed').length,
      removed: results.filter((r) => r === 'removed').length,
    };
  } catch (err) {
    ctx.log.error({ type: push.type, err: errorMessage(err) }, 'staff push failed');
    return NOTHING;
  }
}
