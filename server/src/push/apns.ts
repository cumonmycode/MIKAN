import { sign } from 'node:crypto';
import http2, { type ClientHttp2Session } from 'node:http2';
import { truncate } from '../lib/text.js';
import { DAY_MS, MINUTE_MS } from '../lib/time.js';
import type { ApnsConfig } from './apns-config.js';

/** The APNs provider API (token auth, HTTP/2) — no SDK: a signed JWT and one POST per device. */

export const APNS_ENVIRONMENTS = ['production', 'sandbox'] as const;
/** `production` — TestFlight and App Store builds; `sandbox` — debug builds from Xcode. */
export type ApnsEnvironment = (typeof APNS_ENVIRONMENTS)[number];

export const APNS_ORIGINS: Readonly<Record<ApnsEnvironment, string>> = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
};

/** Apple accepts a provider token for an hour and refuses new ones more often than every 20 minutes. */
export const PROVIDER_TOKEN_TTL_MS = 50 * MINUTE_MS;
export const APNS_TIMEOUT_MS = 10_000;
/** An idle connection to Apple is closed after this long (pushes are rare: a few a day). */
export const APNS_IDLE_MS = 5 * MINUTE_MS;
/** How long Apple keeps retrying a device that is offline. */
export const PUSH_EXPIRATION_MS = DAY_MS;
const MAX_TITLE = 100;
const MAX_BODY = 300;

export interface ApnsRequest {
  environment: ApnsEnvironment;
  deviceToken: string;
  headers: Record<string, string>;
  /** JSON payload. */
  body: string;
}

export interface ApnsResponse {
  status: number;
  /** Apple's reason of a refusal (`BadDeviceToken`, `Unregistered`, `ExpiredProviderToken`, …); null on success. */
  reason: string | null;
}

/** Sends one request to Apple (HTTP/2 in prod, a fake in tests). Rejects on network errors and timeouts. */
export interface ApnsTransport {
  send(request: ApnsRequest): Promise<ApnsResponse>;
}

/** What a push shows and carries: `type` is the event, `data` the ids the app opens on tap. */
export interface PushMessage {
  type: string;
  title: string;
  body: string;
  data: Readonly<Record<string, string | number>>;
}

export interface PushDevice {
  token: string;
  environment: ApnsEnvironment;
}

type ProviderKey = Pick<ApnsConfig, 'keyId' | 'teamId' | 'privateKey'>;

const base64url = (data: string | Buffer): string => Buffer.from(data).toString('base64url');

/** The provider token: an ES256 JWT `{ alg, kid }.{ iss: team, iat }` signed by the `.p8` key (raw r‖s signature). */
export function signProviderToken(key: ProviderKey, issuedAtMs: number): string {
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: key.keyId }));
  const claims = base64url(JSON.stringify({ iss: key.teamId, iat: Math.floor(issuedAtMs / 1000) }));
  const input = `${header}.${claims}`;
  const signature = sign('sha256', Buffer.from(input), { key: key.privateKey, dsaEncoding: 'ieee-p1363' });
  return `${input}.${base64url(signature)}`;
}

export interface ProviderTokens {
  /** The cached token, signed anew once it is PROVIDER_TOKEN_TTL_MS old. */
  current(now?: number): string;
  /** Drops `token` after Apple refused it, unless a newer one already replaced it. */
  invalidate(token: string): void;
}

export function providerTokens(key: ProviderKey): ProviderTokens {
  let cached: { token: string; issuedAt: number } | null = null;
  return {
    current(now = Date.now()) {
      const fresh = cached && now >= cached.issuedAt && now - cached.issuedAt < PROVIDER_TOKEN_TTL_MS;
      if (!fresh) cached = { token: signProviderToken(key, now), issuedAt: now };
      return cached!.token;
    },
    invalidate(token) {
      if (cached?.token === token) cached = null;
    },
  };
}

/** `aps` with the alert, the default sound and a thread per event type; the event and its ids at the top level. */
export function apnsPayload(message: PushMessage): Record<string, unknown> {
  return {
    aps: {
      alert: { title: truncate(message.title, MAX_TITLE), body: truncate(message.body, MAX_BODY) },
      sound: 'default',
      'thread-id': message.type,
    },
    type: message.type,
    ...message.data,
  };
}

export function apnsRequest(
  config: Pick<ApnsConfig, 'bundleId'>,
  providerToken: string,
  device: PushDevice,
  payload: Record<string, unknown>,
  now = Date.now(),
): ApnsRequest {
  return {
    environment: device.environment,
    deviceToken: device.token,
    headers: {
      authorization: `bearer ${providerToken}`,
      'apns-topic': config.bundleId,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-expiration': String(Math.floor((now + PUSH_EXPIRATION_MS) / 1000)),
    },
    body: JSON.stringify(payload),
  };
}

function reasonOf(body: string): string | null {
  if (!body) return null;
  try {
    const reason = (JSON.parse(body) as { reason?: unknown }).reason;
    return typeof reason === 'string' ? reason : null;
  } catch {
    return null;
  }
}

export interface Http2TransportOptions {
  /** Apple's hosts by default; tests point both at a local server. */
  origins?: Readonly<Record<ApnsEnvironment, string>>;
  timeoutMs?: number;
  idleMs?: number;
}

export interface Http2ApnsTransport extends ApnsTransport {
  /** Closes the open connections (shutdown, tests). */
  close(): void;
}

/** One HTTP/2 connection per environment, opened on demand and reused until idle. */
export function createHttp2Transport(options: Http2TransportOptions = {}): Http2ApnsTransport {
  const origins = options.origins ?? APNS_ORIGINS;
  const timeoutMs = options.timeoutMs ?? APNS_TIMEOUT_MS;
  const idleMs = options.idleMs ?? APNS_IDLE_MS;
  const sessions = new Map<string, ClientHttp2Session>();

  const drop = (origin: string, session: ClientHttp2Session) => {
    if (sessions.get(origin) === session) sessions.delete(origin);
  };

  const sessionFor = (origin: string): ClientHttp2Session => {
    const open = sessions.get(origin);
    if (open && !open.closed && !open.destroyed) return open;
    const session = http2.connect(origin);
    const forget = () => drop(origin, session);
    // A connection error also fails its streams, which reject their sends.
    session.on('error', forget);
    session.on('goaway', forget);
    session.on('close', forget);
    session.setTimeout(idleMs, () => session.close());
    sessions.set(origin, session);
    return session;
  };

  const send = (request: ApnsRequest): Promise<ApnsResponse> =>
    new Promise<ApnsResponse>((resolve, reject) => {
      const origin = origins[request.environment];
      const session = sessionFor(origin);
      const stream = session.request({
        ':method': 'POST',
        ':path': `/3/device/${request.deviceToken}`,
        'content-type': 'application/json',
        ...request.headers,
      });
      const timer = setTimeout(() => {
        reject(new Error(`APNs не ответил за ${timeoutMs} мс`));
        // A connection that stopped answering (e.g. half-open) is not reused: the next push connects anew.
        drop(origin, session);
        session.destroy();
      }, timeoutMs);
      let status = 0;
      let body = '';
      stream.setEncoding('utf8');
      stream.on('response', (headers) => {
        status = Number(headers[':status']);
      });
      stream.on('data', (chunk: string) => {
        body += chunk;
      });
      stream.on('end', () => {
        clearTimeout(timer);
        resolve({ status, reason: reasonOf(body) });
      });
      stream.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      // After `end` this is a no-op; before it, the stream was reset without an answer.
      stream.on('close', () => {
        clearTimeout(timer);
        reject(new Error(`APNs закрыл запрос без ответа (код ${stream.rstCode ?? '—'})`));
      });
      stream.end(request.body);
    });

  return {
    send,
    close() {
      for (const session of sessions.values()) session.close();
      sessions.clear();
    },
  };
}
