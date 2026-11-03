import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onlineOutcome } from '../src/domain/growth.js';
import type { ApnsRequest, ApnsResponse, ApnsTransport } from '../src/push/apns.js';
import { pushesSettled } from '../src/push/staff-push.js';
import { createTestApp, type TestApp } from './helpers.js';
import { appointment, cab, cabinetWorld, DAY, miniApp, type CabinetWorld } from './cabinet-fixtures.js';
import {
  auditEntries,
  bindStaffChat,
  BOT_TOKEN,
  FRIDAY_NOON,
  initData,
  NOW,
  pub,
  PUBLIC_URL,
  STAFF_CHAT,
  type Json,
} from './online-booking-fixtures.js';

const MIN = 60_000;
const at = (iso: string, minutes: number) => new Date(Date.parse(iso) + minutes * MIN).toISOString();
const SATURDAY_NOON = '2026-10-17T09:00:00.000Z';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const APNS_ENV = {
  APNS_KEY_ID: 'ABC123DEFG',
  APNS_TEAM_ID: 'G99YH9UK8C',
  APNS_PRIVATE_KEY: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' }) as string).toString('base64'),
  APNS_BUNDLE_ID: 'com.mikanstudio.crm',
};

class RecordingApns implements ApnsTransport {
  requests: ApnsRequest[] = [];
  async send(request: ApnsRequest): Promise<ApnsResponse> {
    this.requests.push(request);
    return { status: 200, reason: null };
  }
  types(): string[] {
    return this.requests.map((r) => (JSON.parse(r.body) as Json).type as string);
  }
}

describe('client cabinet: rescheduling and cancelling', () => {
  let t: TestApp;
  let w: CabinetWorld;
  let apns: RecordingApns;
  /** Anna's hour-long appointment on Friday 12:00–13:00 (Moscow) with Fatima. */
  let visit: Json;

  const reschedule = (id: number, startsAt: string, who = miniApp()) => cab(t, 'POST', `/appointments/${id}/reschedule`, { startsAt }, who);
  const cancel = (id: number, who = miniApp()) => cab(t, 'POST', `/appointments/${id}/cancel`, {}, who);
  const staffTexts = () => t.gateway.textsTo(STAFF_CHAT);
  const pendingReminders = async (id: number) =>
    ((await t.api('GET', '/api/bot/scheduled?status=pending')).json().items as Json[]).filter((m) => m.appointmentId === id && m.kind === 'reminder');

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    apns = new RecordingApns();
    t = await createTestApp({ env: { PUBLIC_URL, TELEGRAM_BOT_TOKEN: BOT_TOKEN, ...APNS_ENV }, apns });
    w = await cabinetWorld(t);
    bindStaffChat(t);
    await t.api('POST', '/api/devices', { token: 'ab'.repeat(32), environment: 'production' });
    visit = await appointment(t, {
      clientId: w.anna.id, masterId: w.fatima.id, services: [{ serviceId: w.lobe.id }], startsAt: FRIDAY_NOON, endsAt: at(FRIDAY_NOON, 60),
    });
    t.gateway.sent = [];
  });
  afterEach(async () => {
    vi.useRealTimers();
    await t.close();
  });

  it('offers the free starts of the appointment\'s master and duration: its own time is free, its start is not offered', async () => {
    await appointment(t, { clientId: w.boris.id, masterId: w.fatima.id, services: [{ serviceId: w.lobe.id }], startsAt: at(FRIDAY_NOON, 180) }); // 15:00–15:30
    const days = (await cab(t, 'GET', `/appointments/${visit.id}/days?from=2026-10-15&to=2026-10-17`, undefined, miniApp())).json();
    expect(days).toEqual({ items: [{ date: '2026-10-15', available: true }, { date: '2026-10-16', available: true }, { date: '2026-10-17', available: true }] });
    const slots = (await cab(t, 'GET', `/appointments/${visit.id}/slots?date=2026-10-16`, undefined, miniApp())).json();
    expect(slots.durationMin).toBe(60);
    const times = (slots.items as Json[]).map((s) => s.startsAt);
    expect(times.slice(0, 3)).toEqual([at(FRIDAY_NOON, -60), at(FRIDAY_NOON, -30), at(FRIDAY_NOON, 30)]); // 11:00, 11:30, 12:30
    expect(times).not.toContain(FRIDAY_NOON);
    expect(times).not.toContain(at(FRIDAY_NOON, 150)); // 14:30–15:30 overlaps Boris
    expect(times).not.toContain(at(FRIDAY_NOON, 180));
    expect(times.at(-1)).toBe(at(FRIDAY_NOON, 480)); // 20:00–21:00, the end of the day
    expect(slots.items[0].masterIds).toEqual([w.fatima.id]);
    // Thursday: nothing before the lead time (now 12:00 + 2 h).
    const today = (await cab(t, 'GET', `/appointments/${visit.id}/slots?date=2026-10-15`, undefined, miniApp())).json().items as Json[];
    expect(today[0]!.startsAt).toBe('2026-10-15T11:00:00.000Z'); // 14:00
    expect((await cab(t, 'GET', `/appointments/${visit.id}/days?from=2026-10-01&to=2026-11-15`, undefined, miniApp())).statusCode).toBe(400);
    expect((await cab(t, 'GET', `/appointments/${visit.id}/slots`, undefined, miniApp())).statusCode).toBe(400);
  });

  it('moves the client\'s appointment: reminders rebuilt, staff chat told, audited as online', async () => {
    // The reminder 24 h before 12:00 Friday would be due right now: none is pending.
    expect(await pendingReminders(visit.id)).toEqual([]);
    const res = await reschedule(visit.id, at(FRIDAY_NOON, 30));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: visit.id, startsAt: at(FRIDAY_NOON, 30), endsAt: at(FRIDAY_NOON, 90), status: 'scheduled', canReschedule: true });
    const reminders = await pendingReminders(visit.id);
    expect(reminders.map((m) => m.sendAt)).toEqual([at(FRIDAY_NOON, 30 - 24 * 60)]);
    expect(reminders[0]!.text).toContain('12:30');
    expect(staffTexts()).toEqual([
      '🔁 Клиент Анна Иванова перенёс запись №' + visit.id + ' в личном кабинете\n' +
        'Было: пятница, 16 октября в 12:00\nСтало: пятница, 16 октября в 12:30–13:30\nМочка · мастер Фатима',
    ]);
    const [, moved] = await auditEntries(t, visit.id);
    expect(moved).toMatchObject({
      source: 'online',
      employee: null,
      action: 'appointment.move',
      summary: `Запись №${visit.id} (Анна Иванова) перенесена клиентом в личном кабинете с 16 октября, 12:00 на 16 октября, 12:30`,
    });
    // The same start again changes nothing.
    t.gateway.sent = [];
    expect((await reschedule(visit.id, at(FRIDAY_NOON, 30))).json().startsAt).toBe(at(FRIDAY_NOON, 30));
    expect(staffTexts()).toEqual([]);
    // Another move replaces the reminder.
    await reschedule(visit.id, at(FRIDAY_NOON, 60));
    expect((await pendingReminders(visit.id)).map((m) => m.sendAt)).toEqual([at(FRIDAY_NOON, 60 - 24 * 60)]);
  });

  it('refuses times the online booking rules do not offer, never naming another client', async () => {
    await appointment(t, { clientId: w.boris.id, masterId: w.fatima.id, services: [{ serviceId: w.lobe.id }], startsAt: at(FRIDAY_NOON, 180) });
    const taken = await reschedule(visit.id, at(FRIDAY_NOON, 150));
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error).toEqual({ code: 'schedule_conflict', message: 'Это время уже занято' });
    expect((await reschedule(visit.id, at(FRIDAY_NOON, 10))).statusCode).toBe(409); // off the 30-minute grid
    expect((await reschedule(visit.id, at(FRIDAY_NOON, 9 * 60))).statusCode).toBe(409); // 21:00, after closing
    const soon = await reschedule(visit.id, '2026-10-15T10:00:00.000Z'); // today 13:00, within the 2-hour lead
    expect(soon.statusCode).toBe(400);
    expect(soon.json().error.message).toBe('Это время уже недоступно — выберите время попозже');
    const far = await reschedule(visit.id, new Date(NOW + 62 * DAY).toISOString());
    expect(far.statusCode).toBe(400);
    expect(far.json().error.message).toBe('Перенести можно не дальше чем на 60 дней вперёд');
    expect((await cab(t, 'POST', `/appointments/${visit.id}/reschedule`, { startsAt: 'завтра' }, miniApp())).statusCode).toBe(400);
    expect((await t.api('GET', `/api/appointments/${visit.id}`)).json().startsAt).toBe(FRIDAY_NOON);
    expect(staffTexts()).toEqual([]);
  });

  it('changes only the client\'s own future appointments, only while online booking is on', async () => {
    const borisVisit = await appointment(t, { clientId: w.boris.id, masterId: w.fatima.id, services: [{ serviceId: w.lobe.id }], startsAt: SATURDAY_NOON });
    expect((await reschedule(borisVisit.id, at(SATURDAY_NOON, 60))).statusCode).toBe(404);
    expect((await cancel(borisVisit.id)).statusCode).toBe(404);
    expect((await cab(t, 'GET', `/appointments/${borisVisit.id}/slots?date=2026-10-17`, undefined, miniApp())).statusCode).toBe(404);
    expect((await cancel(99_999)).statusCode).toBe(404);

    const done = await appointment(t, {
      clientId: w.anna.id, masterId: w.fatima.id, services: [{ serviceId: w.lobe.id }], startsAt: new Date(NOW - DAY).toISOString(), status: 'completed',
    });
    expect((await cancel(done.id)).json().error).toEqual({ code: 'conflict', message: 'Визит уже состоялся' });
    expect((await reschedule(done.id, at(SATURDAY_NOON, 60))).statusCode).toBe(409);

    await t.api('PUT', '/api/settings/studio', { onlineBooking: { enabled: false } });
    for (const res of [await reschedule(visit.id, at(FRIDAY_NOON, 30)), await cancel(visit.id), await cab(t, 'GET', `/appointments/${visit.id}/days`, undefined, miniApp())]) {
      expect(res.statusCode).toBe(403);
      expect(res.json().error.message).toBe('Онлайн-запись временно недоступна');
    }
    await t.api('PUT', '/api/settings/studio', { onlineBooking: { enabled: true } });

    vi.setSystemTime(Date.parse(FRIDAY_NOON) + MIN); // under way
    expect((await cancel(visit.id)).json().error.message).toBe('Запись уже началась — отменить её можно только через студию');
    expect((await reschedule(visit.id, at(FRIDAY_NOON, 120), miniApp(undefined, Date.now()))).json().error.message).toBe(
      'Запись уже началась — перенести её можно только через студию',
    );
  });

  it('cancels early: the prepayment stays held for staff, reminders dropped, staff told by chat and push, audited', async () => {
    await t.api('PUT', '/api/settings/studio', { cancellation: { freeHours: 24, lateRetainPercent: 100, noShowRetainPercent: 100, autoRetain: true } });
    const nipple = await appointment(t, { clientId: w.anna.id, masterId: w.fatima.id, services: [{ serviceId: w.nipple.id }], startsAt: SATURDAY_NOON });
    await t.api('POST', `/api/appointments/${nipple.id}/deposit`, { amount: 1000, method: 'card' });
    await pushesSettled(t.ctx);
    apns.requests = [];
    t.gateway.sent = [];

    const res = await cancel(nipple.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: nipple.id, status: 'cancelled', deposit: 1000, canCancel: false, canReschedule: false, freeCancellationUntil: null });
    expect(await pendingReminders(nipple.id)).toEqual([]);
    const card = (await t.api('GET', `/api/appointments/${nipple.id}`)).json();
    expect(card.notes).toBe('Отменена клиентом онлайн — личный кабинет');
    expect(staffTexts()).toEqual([
      `❌ Клиент отменил запись №${nipple.id} в личном кабинете: Анна Иванова, +79991234501, Соски — 17 октября, 12:00, мастер Фатима\n` +
        'За записью предоплата 1 000 ₽ — верните или удержите её по правилам в карточке записи.',
    ]);
    await pushesSettled(t.ctx);
    expect(apns.types()).toEqual(['client_cancelled']);
    expect((await auditEntries(t, nipple.id)).at(-1)).toMatchObject({
      source: 'online',
      action: 'appointment.status',
      summary: `Запись №${nipple.id} (Анна Иванова) на 17 октября, 12:00 отменена клиентом в личном кабинете`,
    });
    const again = await cancel(nipple.id);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.message).toBe('Запись уже отменена');
  });

  it('offers no move of a prepaid appointment once its free changes are over (a move then a cancel would dodge the rule)', async () => {
    const nipple = await appointment(t, { clientId: w.anna.id, masterId: w.fatima.id, services: [{ serviceId: w.nipple.id }], startsAt: SATURDAY_NOON });
    vi.setSystemTime(Date.parse(FRIDAY_NOON) + 60 * MIN); // 23 h before the visit, past the 24 h of free changes
    const who = () => miniApp(undefined, Date.now());
    const upcoming = (await cab(t, 'GET', '', undefined, who())).json().upcoming as Json[];
    expect(upcoming).toEqual([expect.objectContaining({ id: nipple.id, canReschedule: false, canCancel: true })]);
    const moved = await reschedule(nipple.id, new Date(Date.parse(SATURDAY_NOON) + 3 * DAY).toISOString(), who());
    expect(moved.statusCode).toBe(409);
    expect(moved.json().error.message).toBe('Перенести запись с предоплатой меньше чем за 24 ч до начала можно только через студию');
    // Without a prepayment nothing is locked; with no free time at all (freeHours 0) neither.
    const plain = await appointment(t, { clientId: w.anna.id, masterId: w.fatima.id, services: [{ serviceId: w.lobe.id }], startsAt: at(SATURDAY_NOON, 120) });
    expect((await reschedule(plain.id, at(SATURDAY_NOON, 180), who())).statusCode).toBe(200);
    await t.api('PUT', '/api/settings/studio', { cancellation: { freeHours: 0, lateRetainPercent: 100, noShowRetainPercent: 100, autoRetain: false } });
    expect((await cab(t, 'GET', '', undefined, who())).json().upcoming.find((a: Json) => a.id === nipple.id).canReschedule).toBe(true);
  });

  it('cancels late: the rules keep their share by themselves when autoRetain is on', async () => {
    await t.api('PUT', '/api/settings/studio', { cancellation: { freeHours: 24, lateRetainPercent: 50, noShowRetainPercent: 100, autoRetain: true } });
    const nipple = await appointment(t, { clientId: w.anna.id, masterId: w.fatima.id, services: [{ serviceId: w.nipple.id }], startsAt: SATURDAY_NOON });
    await t.api('POST', `/api/appointments/${nipple.id}/deposit`, { amount: 1000, method: 'card' });
    expect((await cab(t, 'GET', '', undefined, miniApp())).json().upcoming[1].freeCancellationUntil).toBe(FRIDAY_NOON);
    vi.setSystemTime(Date.parse(FRIDAY_NOON) + 60 * MIN); // 23 h before the visit
    t.gateway.sent = [];

    const res = await cancel(nipple.id, miniApp(undefined, Date.now()));
    expect(res.json()).toMatchObject({ status: 'cancelled', deposit: 500 });
    expect(staffTexts()[0]).toContain('По правилам отмены удержано 500 ₽ предоплаты.\nЗа записью предоплата 500 ₽');
    const ops = (await t.api('GET', `/api/appointments/${nipple.id}`)).json().depositOperations as Json[];
    expect(ops.map((o) => [o.type, o.amount])).toEqual([['receive', 1000], ['retain', 500]]);
  });

  it('a late cancellation without autoRetain keeps the prepayment held for staff', async () => {
    const nipple = await appointment(t, { clientId: w.anna.id, masterId: w.fatima.id, services: [{ serviceId: w.nipple.id }], startsAt: SATURDAY_NOON });
    await t.api('POST', `/api/appointments/${nipple.id}/deposit`, { amount: 1000, method: 'card' });
    vi.setSystemTime(Date.parse(FRIDAY_NOON) + 60 * MIN);
    expect((await cancel(nipple.id, miniApp(undefined, Date.now()))).json()).toMatchObject({ status: 'cancelled', deposit: 1000 });
  });

  it('cancelling an unsettled online booking settles it as cancelled by the client', async () => {
    const booked = (await pub(t, 'POST', '', { items: [{ serviceId: w.lobe.id }], masterId: w.fatima.id, startsAt: SATURDAY_NOON }, { initData: initData({ id: 770_001 }) })).json();
    const res = await cancel(booked.number);
    expect(res.json()).toMatchObject({ status: 'cancelled', onlineState: null, bookingToken: booked.token });
    const row = (await t.api('GET', `/api/appointments/${booked.number}`)).json();
    expect(onlineOutcome({ status: row.status, onlineState: row.onlineState, notes: row.notes })).toBe('cancelledByClient');
    expect((await pub(t, 'GET', `/b/${booked.token}`)).json().status).toBe('cancelled');
  });

  it('limits writes per IP', async () => {
    for (let i = 0; i < 20; i += 1) expect((await cab(t, 'POST', '/logout', {}, { ip: '203.0.113.9' })).statusCode).toBe(401);
    const limited = await cab(t, 'POST', '/logout', {}, { ip: '203.0.113.9' });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('rate_limited');
    expect((await cab(t, 'POST', '/logout', {}, { ip: '203.0.113.10' })).statusCode).toBe(401);
  });
});
