import { generateKeyPairSync, verify } from 'node:crypto';
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import type { InjectOptions } from 'fastify';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleCallback } from '../src/bot/callbacks.js';
import { handleStaffCommand, handleStart } from '../src/bot/onboarding.js';
import { BotPipeline } from '../src/bot/pipeline.js';
import { processDueMessages } from '../src/bot/sender.js';
import { issueStaffCode, notifyStaff } from '../src/bot/staff.js';
import { auditLog, appointments, pushDevices } from '../src/db/schema.js';
import { getAppointmentRow } from '../src/domain/refs.js';
import { setStaffChatId } from '../src/domain/settings.js';
import {
  apnsPayload,
  apnsRequest,
  createHttp2Transport,
  providerTokens,
  signProviderToken,
  type ApnsRequest,
  type ApnsResponse,
  type ApnsTransport,
} from '../src/push/apns.js';
import { clientCancelledPush, onlineBookingPush } from '../src/push/staff-events.js';
import { pushesSettled, pushToStaff, type StaffPush } from '../src/push/staff-push.js';
import { createTestApp, FakeQrProvider, make, message, ScriptedAi, testConfig, text, toolUse, type TestApp } from './helpers.js';

const NOW = Date.parse('2026-10-15T09:00:00.000Z'); // Thu 12:00 Moscow
const STAFF_CHAT = -100_900;
const CHAT = 900_001;
const from = { chatId: CHAT, telegramName: 'Мария', username: 'masha' };

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const P8_BASE64 = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' }) as string).toString('base64');
const APNS_ENV = {
  APNS_KEY_ID: 'ABC123DEFG',
  APNS_TEAM_ID: 'G99YH9UK8C',
  APNS_PRIVATE_KEY: P8_BASE64,
  APNS_BUNDLE_ID: 'com.mikanstudio.crm',
};

/** A 64-hex-digit device token: `deviceToken(1)` → `0101…01`. */
const deviceToken = (n: number) => n.toString(16).padStart(2, '0').repeat(32);

type Json = Record<string, any>;

/** Records every APNs request; answers 200 unless told otherwise for a device token. */
class FakeApns implements ApnsTransport {
  requests: ApnsRequest[] = [];
  answers = new Map<string, ApnsResponse | Error>();
  /** Answer of every device without its own entry. */
  fallback: ApnsResponse | Error = { status: 200, reason: null };

  async send(request: ApnsRequest): Promise<ApnsResponse> {
    this.requests.push(request);
    const answer = this.answers.get(request.deviceToken) ?? this.fallback;
    if (answer instanceof Error) throw answer;
    return answer;
  }
  tokens(): string[] {
    return this.requests.map((r) => r.deviceToken).sort();
  }
  payloads(): Json[] {
    return this.requests.map((r) => JSON.parse(r.body) as Json);
  }
}

type Api = (method: InjectOptions['method'], url: string, payload?: unknown) => ReturnType<TestApp['api']>;

async function signIn(t: TestApp, login: string): Promise<Api> {
  const res = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login, password: 'secret123' } });
  const token = res.json<{ token: string }>().token;
  return (method, url, payload) =>
    t.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload === undefined ? {} : { payload: payload as InjectOptions['payload'] }),
    });
}

async function addEmployee(t: TestApp, login: string, role: 'owner' | 'admin' | 'master', name = login) {
  const employee = await make(t, '/api/employees', { name, login, password: 'secret123', isMaster: role === 'master', role });
  return { employee: employee as Json, api: await signIn(t, login) };
}

const devicesOf = (t: TestApp) => t.ctx.db.select().from(pushDevices).all();

describe('APNs configuration', () => {
  it('is off without any APNS_* setting', () => {
    const config = testConfig();
    expect(config.apns).toBeNull();
    expect(config.apnsProblem).toBeNull();
  });

  it('reports a partial setup instead of half-using it', () => {
    const config = testConfig({ APNS_KEY_ID: 'ABC123DEFG', APNS_TEAM_ID: 'G99YH9UK8C' });
    expect(config.apns).toBeNull();
    expect(config.apnsProblem).toBe('не заданы APNS_PRIVATE_KEY, APNS_BUNDLE_ID');
  });

  it('reports an invalid key or id', () => {
    expect(testConfig({ ...APNS_ENV, APNS_PRIVATE_KEY: Buffer.from('not a key').toString('base64') }).apnsProblem).toMatch(
      /^APNS_PRIVATE_KEY/,
    );
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    expect(testConfig({ ...APNS_ENV, APNS_PRIVATE_KEY: Buffer.from(rsa).toString('base64') }).apnsProblem).toMatch(/^APNS_PRIVATE_KEY/);
    expect(testConfig({ ...APNS_ENV, APNS_KEY_ID: 'short' }).apnsProblem).toMatch(/^APNS_KEY_ID/);
    expect(testConfig({ ...APNS_ENV, APNS_TEAM_ID: 'g99yh9uk8c!' }).apnsProblem).toMatch(/^APNS_TEAM_ID/);
    expect(testConfig({ ...APNS_ENV, APNS_BUNDLE_ID: 'mikan' }).apnsProblem).toMatch(/^APNS_BUNDLE_ID/);
    expect(testConfig({ ...APNS_ENV, APNS_KEY_ID: 'short' }).apns).toBeNull();
  });

  it('loads a complete setup', () => {
    const config = testConfig(APNS_ENV);
    expect(config.apnsProblem).toBeNull();
    expect(config.apns).toMatchObject({ keyId: 'ABC123DEFG', teamId: 'G99YH9UK8C', bundleId: 'com.mikanstudio.crm' });
    expect(config.apns!.privateKey.asymmetricKeyType).toBe('ec');
  });
});

describe('APNs provider token', () => {
  const apns = () => testConfig(APNS_ENV).apns!;
  const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Json;

  it('is an ES256 JWT with the key id and team id, signed by the .p8 key', () => {
    const token = signProviderToken(apns(), NOW + 999);
    const [header, claims, signature] = token.split('.') as [string, string, string];
    expect(decode(header)).toEqual({ alg: 'ES256', kid: 'ABC123DEFG' });
    expect(decode(claims)).toEqual({ iss: 'G99YH9UK8C', iat: NOW / 1000 });
    const raw = Buffer.from(signature, 'base64url');
    expect(raw).toHaveLength(64); // r‖s, not DER
    expect(verify('sha256', Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, raw)).toBe(true);
    const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey;
    expect(verify('sha256', Buffer.from(`${header}.${claims}`), { key: other, dsaEncoding: 'ieee-p1363' }, raw)).toBe(false);
  });

  it('is reused for up to 50 minutes, then signed anew; a refused one is dropped', () => {
    const tokens = providerTokens(apns());
    const first = tokens.current(NOW);
    expect(tokens.current(NOW + 49 * 60_000)).toBe(first);
    const second = tokens.current(NOW + 50 * 60_000);
    expect(second).not.toBe(first);
    expect(decode(second.split('.')[1]!).iat).toBe(NOW / 1000 + 50 * 60);

    tokens.invalidate(first); // already replaced: keeps the current one
    expect(tokens.current(NOW + 51 * 60_000)).toBe(second);
    tokens.invalidate(second);
    const third = tokens.current(NOW + 52 * 60_000);
    expect(decode(third.split('.')[1]!).iat).toBe(NOW / 1000 + 52 * 60);
  });
});

describe('APNs payload and request', () => {
  const push: StaffPush = {
    type: 'deposit_paid',
    title: 'Предоплата получена',
    body: 'Анна · 2 000 ₽ · запись 21 окт, 15:00',
    data: { appointmentId: 42 },
    masterId: 3,
  };

  it('puts the alert in aps and the data fields at the top level', () => {
    expect(apnsPayload(push)).toEqual({
      aps: { alert: { title: 'Предоплата получена', body: 'Анна · 2 000 ₽ · запись 21 окт, 15:00' }, sound: 'default', 'thread-id': 'deposit_paid' },
      type: 'deposit_paid',
      appointmentId: 42,
    });
    const long = apnsPayload({ ...push, body: 'х'.repeat(1000) }) as Json;
    expect(long.aps.alert.body.length).toBeLessThanOrEqual(300);
  });

  it('addresses the device with the bundle id as topic and an alert push type', () => {
    const request = apnsRequest(
      testConfig(APNS_ENV).apns!,
      'jwt.jwt.jwt',
      { token: deviceToken(7), environment: 'sandbox' },
      apnsPayload(push),
      NOW,
    );
    expect(request).toEqual({
      environment: 'sandbox',
      deviceToken: deviceToken(7),
      headers: {
        authorization: 'bearer jwt.jwt.jwt',
        'apns-topic': 'com.mikanstudio.crm',
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-expiration': String(NOW / 1000 + 24 * 60 * 60),
      },
      body: JSON.stringify(apnsPayload(push)),
    });
  });
});

describe('APNs HTTP/2 transport', () => {
  let server: http2.Http2Server;
  let origin: string;
  const seen: Array<{ headers: http2.IncomingHttpHeaders; body: string }> = [];

  beforeEach(async () => {
    seen.length = 0;
    server = http2.createServer();
    server.on('stream', (stream, headers) => {
      let body = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        body += chunk;
      });
      stream.on('end', () => {
        seen.push({ headers, body });
        const path = String(headers[':path']);
        if (path.endsWith(deviceToken(2))) {
          stream.respond({ ':status': 410, 'content-type': 'application/json' });
          stream.end(JSON.stringify({ reason: 'Unregistered', timestamp: 1 }));
        } else if (path.endsWith(deviceToken(3))) {
          // Never answers.
        } else {
          stream.respond({ ':status': 200, 'apns-id': 'A1' });
          stream.end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('posts to /3/device/<token> with the headers and reads status and reason, with a timeout', async () => {
    const transport = createHttp2Transport({ origins: { production: origin, sandbox: origin }, timeoutMs: 300 });
    try {
      const request = (n: number): ApnsRequest => ({
        environment: n === 1 ? 'production' : 'sandbox',
        deviceToken: deviceToken(n),
        headers: { authorization: 'bearer x.y.z', 'apns-topic': 'com.mikanstudio.crm', 'apns-push-type': 'alert' },
        body: '{"aps":{}}',
      });
      expect(await transport.send(request(1))).toEqual({ status: 200, reason: null });
      expect(seen[0]!.headers).toMatchObject({
        ':method': 'POST',
        ':path': `/3/device/${deviceToken(1)}`,
        authorization: 'bearer x.y.z',
        'apns-topic': 'com.mikanstudio.crm',
        'apns-push-type': 'alert',
        'content-type': 'application/json',
      });
      expect(seen[0]!.body).toBe('{"aps":{}}');
      expect(await transport.send(request(2))).toEqual({ status: 410, reason: 'Unregistered' });
      await expect(transport.send(request(3))).rejects.toThrow(/APNs/);
      // The connection that stopped answering is dropped; the next push connects anew and gets through.
      expect(await transport.send(request(1))).toEqual({ status: 200, reason: null });
    } finally {
      transport.close();
    }
  });

  it('rejects when Apple cannot be reached', async () => {
    const closed = http2.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const dead = `http://127.0.0.1:${port}`;
    const transport = createHttp2Transport({ origins: { production: dead, sandbox: dead }, timeoutMs: 2_000 });
    try {
      const request: ApnsRequest = { environment: 'production', deviceToken: deviceToken(1), headers: {}, body: '{}' };
      await expect(transport.send(request)).rejects.toThrow();
      await expect(transport.send(request)).rejects.toThrow(); // a fresh connection is tried again
    } finally {
      transport.close();
    }
  });
});

describe('push devices', () => {
  let t: TestApp;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    t = await createTestApp();
  });
  afterEach(async () => {
    vi.useRealTimers();
    await t.close();
  });

  it('registers the device for the current employee, any role, without an audit entry', async () => {
    const master = await addEmployee(t, 'fatima', 'master', 'Фатима');
    const res = await master.api('POST', '/api/devices', { token: deviceToken(1).toUpperCase(), environment: 'sandbox' });
    expect(res.statusCode).toBe(204);
    expect(devicesOf(t)).toEqual([
      expect.objectContaining({ employeeId: master.employee.id, token: deviceToken(1), environment: 'sandbox', createdAt: NOW, lastSeenAt: NOW }),
    ]);
    expect((await master.api('DELETE', `/api/devices/${deviceToken(1)}`)).statusCode).toBe(204);
    expect(devicesOf(t)).toEqual([]);
    const audit = t.ctx.db.select().from(auditLog).all();
    expect(audit.filter((e) => e.employeeId === master.employee.id)).toEqual([]);
  });

  it('rejects a malformed token or environment', async () => {
    for (const body of [
      { token: 'abc', environment: 'production' },
      { token: 'z'.repeat(64), environment: 'production' },
      { token: deviceToken(1), environment: 'development' },
      { token: deviceToken(1) },
      { token: 'ab'.repeat(51), environment: 'production' }, // 102 digits: longer than a path parameter may be
    ]) {
      const res = await t.api('POST', '/api/devices', body);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('validation_error');
    }
    expect((await t.api('POST', '/api/devices', { token: 'abc', environment: 'production' })).json().error.message).toBe(
      'Некорректный токен устройства',
    );
    expect((await t.api('DELETE', '/api/devices/not-hex')).statusCode).toBe(400);
    expect(devicesOf(t)).toEqual([]);
  });

  it('refreshes lastSeenAt on re-registration and moves a token registered by someone else', async () => {
    await t.api('POST', '/api/devices', { token: deviceToken(1), environment: 'production' });
    vi.setSystemTime(NOW + 60_000);
    await t.api('POST', '/api/devices', { token: deviceToken(1), environment: 'sandbox' });
    expect(devicesOf(t)).toEqual([
      expect.objectContaining({ employeeId: 1, environment: 'sandbox', createdAt: NOW, lastSeenAt: NOW + 60_000 }),
    ]);

    const admin = await addEmployee(t, 'olga', 'admin');
    vi.setSystemTime(NOW + 120_000);
    expect((await admin.api('POST', '/api/devices', { token: deviceToken(1), environment: 'production' })).statusCode).toBe(204);
    expect(devicesOf(t)).toEqual([
      expect.objectContaining({ employeeId: admin.employee.id, environment: 'production', lastSeenAt: NOW + 120_000 }),
    ]);
  });

  it('accepts tokens up to 100 hex digits and keeps the 10 most recently seen devices of an employee', async () => {
    const long = 'cd'.repeat(50);
    expect((await t.api('POST', '/api/devices', { token: long, environment: 'production' })).statusCode).toBe(204);
    expect((await t.api('DELETE', `/api/devices/${long}`)).statusCode).toBe(204);
    expect(devicesOf(t)).toEqual([]);

    for (let n = 1; n <= 11; n++) {
      vi.setSystemTime(NOW + n * 1000);
      await t.api('POST', '/api/devices', { token: deviceToken(n), environment: 'production' });
    }
    const tokens = devicesOf(t).map((d) => d.token);
    expect(tokens).toHaveLength(10);
    expect(tokens).not.toContain(deviceToken(1));
    expect(tokens).toContain(deviceToken(11));
  });

  it('signs out only the own device', async () => {
    const admin = await addEmployee(t, 'olga', 'admin');
    await admin.api('POST', '/api/devices', { token: deviceToken(2), environment: 'production' });
    expect((await t.api('DELETE', `/api/devices/${deviceToken(2)}`)).statusCode).toBe(204);
    expect((await t.api('DELETE', `/api/devices/${deviceToken(9)}`)).statusCode).toBe(204);
    expect(devicesOf(t)).toHaveLength(1);
  });
});

describe('push delivery to staff', () => {
  let t: TestApp;
  let apns: FakeApns;
  let staff: Record<'owner' | 'admin' | 'masterA' | 'masterB' | 'inactive', Json>;

  async function setup(env: Record<string, string> = APNS_ENV) {
    apns = new FakeApns();
    t = await createTestApp({ env, apns });
    const admin = await addEmployee(t, 'olga', 'admin', 'Ольга');
    const masterA = await addEmployee(t, 'fatima', 'master', 'Фатима');
    const masterB = await addEmployee(t, 'rustam', 'master', 'Рустам');
    const inactive = await addEmployee(t, 'ivan', 'admin', 'Иван');
    await t.api('POST', '/api/devices', { token: deviceToken(1), environment: 'production' });
    await admin.api('POST', '/api/devices', { token: deviceToken(2), environment: 'production' });
    await masterA.api('POST', '/api/devices', { token: deviceToken(3), environment: 'sandbox' });
    await masterA.api('POST', '/api/devices', { token: deviceToken(4), environment: 'production' });
    await masterB.api('POST', '/api/devices', { token: deviceToken(5), environment: 'production' });
    await inactive.api('POST', '/api/devices', { token: deviceToken(6), environment: 'production' });
    expect((await t.api('PATCH', `/api/employees/${inactive.employee.id}`, { active: false })).statusCode).toBe(200);
    staff = { owner: { id: 1 }, admin: admin.employee, masterA: masterA.employee, masterB: masterB.employee, inactive: inactive.employee };
  }

  afterEach(async () => {
    vi.useRealTimers();
    await t.close();
  });

  const event = (over: Partial<StaffPush> = {}): StaffPush => ({
    type: 'deposit_paid',
    title: 'Предоплата получена',
    body: 'Анна · 2 000 ₽ · запись 21 окт, 15:00',
    data: { appointmentId: 5 },
    masterId: staff.masterA.id,
    ...over,
  });

  it('sends nothing without the APNs configuration', async () => {
    await setup({});
    expect(await pushToStaff(t.ctx, event())).toEqual({ sent: 0, failed: 0, removed: 0 });
    expect(apns.requests).toEqual([]);
  });

  it('reaches owners, admins and the appointment’s master on their own environment; never inactive employees', async () => {
    await setup();
    expect(await pushToStaff(t.ctx, event())).toEqual({ sent: 4, failed: 0, removed: 0 });
    expect(apns.tokens()).toEqual([deviceToken(1), deviceToken(2), deviceToken(3), deviceToken(4)]);
    expect(apns.requests.find((r) => r.deviceToken === deviceToken(3))!.environment).toBe('sandbox');
    expect(apns.payloads()[0]).toEqual({
      aps: { alert: { title: 'Предоплата получена', body: 'Анна · 2 000 ₽ · запись 21 окт, 15:00' }, sound: 'default', 'thread-id': 'deposit_paid' },
      type: 'deposit_paid',
      appointmentId: 5,
    });
    const jwt = apns.requests[0]!.headers.authorization!.replace('bearer ', '');
    expect(apns.requests.every((r) => r.headers.authorization === `bearer ${jwt}`)).toBe(true);

    apns.requests = [];
    await pushToStaff(t.ctx, event({ type: 'client_cancelled', masterId: staff.masterB.id }));
    expect(apns.tokens()).toEqual([deviceToken(1), deviceToken(2), deviceToken(5)]);

    apns.requests = [];
    await pushToStaff(t.ctx, event({ type: 'booking_request', data: { bookingRequestId: 3 }, masterId: null }));
    expect(apns.tokens()).toEqual([deviceToken(1), deviceToken(2)]);
    expect(apns.payloads()[0]).toMatchObject({ type: 'booking_request', bookingRequestId: 3 });

    apns.requests = [];
    await pushToStaff(t.ctx, event({ type: 'client_message', data: { chatId: -12 }, masterId: null }));
    expect(apns.tokens()).toEqual([1, 2, 3, 4, 5].map(deviceToken));
    expect(apns.payloads()[0]).toMatchObject({ type: 'client_message', chatId: -12 });
  });

  it('deletes devices Apple no longer knows and keeps the rest; never throws', async () => {
    await setup();
    apns.answers.set(deviceToken(1), { status: 410, reason: 'Unregistered' });
    apns.answers.set(deviceToken(2), { status: 400, reason: 'BadDeviceToken' });
    apns.answers.set(deviceToken(3), { status: 500, reason: 'InternalServerError' });
    apns.answers.set(deviceToken(4), new Error('connect ETIMEDOUT'));
    expect(await pushToStaff(t.ctx, event())).toEqual({ sent: 0, failed: 2, removed: 2 });
    expect(devicesOf(t).map((d) => d.token).sort()).toEqual([3, 4, 5, 6].map(deviceToken));
  });

  it('pushes even when the staff chat is not bound, next to the staff chat message', async () => {
    await setup();
    expect(await notifyStaff(t.ctx, 'текст', event({ type: 'booking_request', data: { bookingRequestId: 1 }, masterId: null }))).toBe(false);
    await pushesSettled(t.ctx);
    expect(apns.tokens()).toEqual([deviceToken(1), deviceToken(2)]);
    setStaffChatId(t.ctx.db, STAFF_CHAT);
    expect(await notifyStaff(t.ctx, 'без push')).toBe(true);
    await pushesSettled(t.ctx);
    expect(t.gateway.textsTo(STAFF_CHAT)).toEqual(['без push']);
    expect(apns.requests).toHaveLength(2);
  });

  it('never makes the triggering action wait for Apple or fail on a broken push', async () => {
    await setup();
    setStaffChatId(t.ctx.db, STAFF_CHAT);
    let sends = 0;
    t.ctx.apns = {
      send: () => {
        sends += 1;
        return new Promise<ApnsResponse>(() => undefined); // Apple never answers
      },
    };
    expect(await notifyStaff(t.ctx, 'сразу', event())).toBe(true);
    expect(sends).toBe(4);
    expect(t.gateway.textsTo(STAFF_CHAT)).toEqual(['сразу']);

    const broken = () => {
      throw new Error('cannot build');
    };
    expect(await notifyStaff(t.ctx, 'и так', broken)).toBe(true);
    expect(t.gateway.textsTo(STAFF_CHAT)).toEqual(['сразу', 'и так']);
  });
});

describe('staff events', () => {
  let t: TestApp;
  let apns: FakeApns;
  let ai: ScriptedAi;
  let bank: FakeQrProvider;
  let master: Json;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    apns = new FakeApns();
    ai = new ScriptedAi();
    bank = new FakeQrProvider();
    t = await createTestApp({ env: APNS_ENV, apns, ai, qr: bank });
    handleStaffCommand(t.ctx, STAFF_CHAT, issueStaffCode(t.ctx.db).code);
    const fatima = await addEmployee(t, 'fatima', 'master', 'Фатима');
    master = fatima.employee;
    await t.api('POST', '/api/devices', { token: deviceToken(1), environment: 'production' });
    await fatima.api('POST', '/api/devices', { token: deviceToken(2), environment: 'production' });
  });
  afterEach(async () => {
    vi.useRealTimers();
    await t.close();
  });

  const say = async (pipeline: BotPipeline, msg: string) => {
    pipeline.receive(from, msg);
    await pipeline.idle();
    await pushesSettled(t.ctx);
  };
  const chatRow = async () => (await t.api('GET', '/api/bot/chats')).json().items.find((c: { chatId: number }) => c.chatId === CHAT);

  it('client_message when the AI hands the chat to staff', async () => {
    ai.push(
      message([toolUse('h', 'handoff_to_staff', { reason: 'Гной после прокола' })], 'tool_use'),
      message([text('Администратор уже в курсе.')]),
    );
    await say(new BotPipeline(t.ctx, 0), 'У меня гной и температура 38');
    expect(t.gateway.textsTo(STAFF_CHAT)[0]).toContain('Причина: Гной после прокола');
    expect(apns.tokens()).toEqual([deviceToken(1), deviceToken(2)]);
    expect(apns.payloads()[0]).toEqual({
      aps: { alert: { title: 'Клиент ждёт ответа', body: 'Мария: У меня гной и температура 38' }, sound: 'default', 'thread-id': 'client_message' },
      type: 'client_message',
      chatId: CHAT,
    });
  });

  it('client_message when the bot could not answer, and a failing APNs never breaks the escalation', async () => {
    await t.close();
    apns = new FakeApns();
    apns.fallback = new Error('socket hang up');
    t = await createTestApp({ env: APNS_ENV, apns, ai: null });
    handleStaffCommand(t.ctx, STAFF_CHAT, issueStaffCode(t.ctx.db).code);
    await t.api('POST', '/api/devices', { token: deviceToken(1), environment: 'production' });
    await say(new BotPipeline(t.ctx, 0), 'Здравствуйте');
    expect((await chatRow()).needsAttention).toBe(true);
    expect(t.gateway.textsTo(STAFF_CHAT).filter((s) => s.includes('ИИ-ответы отключены'))).toHaveLength(1);
    expect(apns.payloads()).toEqual([expect.objectContaining({ type: 'client_message', chatId: CHAT })]);
    expect(apns.payloads()[0]!.aps.alert.body).toBe('Мария: Здравствуйте');
    expect(devicesOf(t)).toHaveLength(1);
  });

  it('client_message when a client has a question about healing', async () => {
    const helix = await make(t, '/api/services', { name: 'Хеликс', category: 'piercing', price: 3000, durationMin: 30, healingCheckDays: 7 });
    const client = await make(t, '/api/clients', { name: 'Иван', phone: '+79991234569' });
    const url = (await t.api('POST', `/api/clients/${client.id}/telegram-link`)).json().url as string;
    handleStart(t.ctx, from, new URL(url).searchParams.get('start')!);
    const a = await make(t, '/api/appointments', {
      clientId: client.id, masterId: 1, services: [{ serviceId: helix.id }], startsAt: '2026-10-15T07:00:00Z', force: true,
    });
    await t.api('POST', `/api/appointments/${a.id}/complete`, {});
    await processDueMessages(t.ctx, Date.parse('2026-10-22T09:00:01Z'));
    const check = t.gateway.sent.at(-1)!;
    await handleCallback({ ctx: t.ctx, pipeline: new BotPipeline(t.ctx, 0) }, {
      from, data: `hq:${a.id}`, message: { messageId: check.messageId, isPhoto: false },
    });
    await pushesSettled(t.ctx);
    expect(t.gateway.textsTo(STAFF_CHAT).at(-1)).toContain('вопрос по заживлению');
    expect(apns.tokens()).toEqual([deviceToken(1), deviceToken(2)]);
    expect(apns.payloads()[0]).toEqual({
      aps: { alert: { title: 'Клиент ждёт ответа', body: 'Иван: вопрос по заживлению после «Хеликс»' }, sound: 'default', 'thread-id': 'client_message' },
      type: 'client_message',
      chatId: CHAT,
    });
  });

  it('booking_request for owners and admins when the bot takes a request', async () => {
    ai.push(
      message([toolUse('b', 'create_booking_request', {
        contactName: 'Анна', phone: '8 999 111-22-33', serviceName: 'Мочка', preferredTime: 'в субботу после 15:00',
      })], 'tool_use'),
      message([text('Заявка принята.')]),
    );
    await say(new BotPipeline(t.ctx, 0), 'Хочу проколоть мочку в субботу');
    const request = (await t.api('GET', '/api/booking-requests?status=new')).json().items[0];
    expect(t.gateway.textsTo(STAFF_CHAT)[0]).toContain('📅 Новая заявка на запись');
    expect(apns.tokens()).toEqual([deviceToken(1)]);
    expect(apns.payloads()[0]).toEqual({
      aps: { alert: { title: 'Новая заявка', body: 'Анна · Мочка · в субботу после 15:00' }, sound: 'default', 'thread-id': 'booking_request' },
      type: 'booking_request',
      bookingRequestId: request.id,
    });
  });

  it('deposit_paid for owners, admins and the appointment’s master when the bank confirms a QR prepayment', async () => {
    const tattoo = await make(t, '/api/services', { name: 'Тату', category: 'tattoo', price: 8000, durationMin: 120, depositAmount: 2000 });
    const client = await make(t, '/api/clients', { name: 'Анна', lastName: 'Иванова', phone: '+79991234567' });
    await t.api('POST', '/api/cash/shift/open', { openingCash: 0 });
    const a = await make(t, '/api/appointments', {
      clientId: client.id, masterId: master.id, services: [{ serviceId: tattoo.id }], startsAt: '2026-10-21T12:00:00.000Z',
    });
    const qr = (await t.api('POST', `/api/appointments/${a.id}/deposit/qr`, { delivery: 'screen' })).json();
    apns.fallback = new Error('APNs down'); // a failing push never undoes the payment
    bank.statuses.set('QR1', 'paid');
    expect((await t.api('GET', `/api/qr-payments/${qr.payment.id}`)).json().status).toBe('paid');
    await pushesSettled(t.ctx);
    expect((await t.api('GET', `/api/appointments/${a.id}`)).json().deposit).toBe(2000);
    expect(t.gateway.textsTo(STAFF_CHAT)[0]).toContain('💳 Предоплата 2 000 ₽ по СБП получена');
    expect(apns.tokens()).toEqual([deviceToken(1), deviceToken(2)]);
    expect(apns.payloads()[0]).toEqual({
      aps: { alert: { title: 'Предоплата получена', body: 'Анна Иванова · 2 000 ₽ · запись 21 окт, 15:00' }, sound: 'default', 'thread-id': 'deposit_paid' },
      type: 'deposit_paid',
      appointmentId: a.id,
    });
  });

  it('builds the online booking and client cancellation pushes for the booking engine', async () => {
    const lobe = await make(t, '/api/services', { name: 'Мочка', category: 'piercing', price: 2500, durationMin: 30 });
    const client = await make(t, '/api/clients', { name: 'Анна', phone: '+79991234568' });
    const a = await make(t, '/api/appointments', {
      clientId: client.id, masterId: master.id, services: [{ serviceId: lobe.id }], startsAt: '2026-10-21T12:00:00.000Z',
    });
    t.ctx.db.update(appointments).set({ channel: 'online', onlineState: 'awaiting_confirmation' }).where(eq(appointments.id, a.id)).run();
    expect(onlineBookingPush(t.ctx.db, getAppointmentRow(t.ctx.db, a.id))).toEqual({
      type: 'online_booking',
      title: 'Новая онлайн-запись',
      body: 'Анна · Мочка · 21 окт, 15:00 · ждёт подтверждения',
      data: { appointmentId: a.id },
      masterId: master.id,
    });
    t.ctx.db
      .update(appointments)
      .set({ onlineState: 'awaiting_payment', holdUntil: Date.parse('2026-10-15T11:35:00.000Z') })
      .where(eq(appointments.id, a.id))
      .run();
    expect(onlineBookingPush(t.ctx.db, getAppointmentRow(t.ctx.db, a.id)).body).toBe('Анна · Мочка · 21 окт, 15:00 · ждёт оплату до 14:35');
    expect(clientCancelledPush(t.ctx.db, getAppointmentRow(t.ctx.db, a.id))).toEqual({
      type: 'client_cancelled',
      title: 'Клиент отменил запись',
      body: 'Анна · 21 окт, 15:00',
      data: { appointmentId: a.id },
      masterId: master.id,
    });

    await notifyStaff(t.ctx, '❌ Клиент отменил онлайн-запись', () => clientCancelledPush(t.ctx.db, getAppointmentRow(t.ctx.db, a.id)));
    await pushesSettled(t.ctx);
    expect(apns.tokens()).toEqual([deviceToken(1), deviceToken(2)]);
  });
});
