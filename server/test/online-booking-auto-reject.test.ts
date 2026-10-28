import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitlistEntries } from '../src/db/schema.js';
import { confirmationDeadline, rejectUnconfirmedBookings, UNCONFIRMED_REASON } from '../src/domain/online-booking-lifecycle.js';
import { queuedFreedTime } from '../src/domain/waitlist-store.js';
import { createTestApp, make, type TestApp } from './helpers.js';
import {
  addMaster,
  auditEntries,
  bindStaffChat,
  FRIDAY_NOON,
  hhmm,
  linkChat,
  MIN,
  NOW,
  pub,
  PUBLIC_URL,
  STAFF_CHAT,
  type Json,
} from './online-booking-fixtures.js';

/** docs/API.md «StudioSettings» → `onlineBooking.confirmationHours`: unconfirmed online bookings reject themselves. */

const CHAT = 611;
const HOUR = 60 * MIN;
/** Monday 19 October, 12:00 Moscow: far enough for the «N hours after it was made» deadline to come first. */
const MONDAY_NOON = '2026-10-19T09:00:00.000Z';
const REASON = 'Студия не успела подтвердить запись — выберите, пожалуйста, другое время';

describe('online booking: unconfirmed bookings are rejected by themselves', () => {
  let t: TestApp;
  let lobe: Json;
  let fatima: Json;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    t = await createTestApp({ env: { PUBLIC_URL } });
    bindStaffChat(t);
    lobe = await make(t, '/api/services', { name: 'Мочка', category: 'piercing', price: 1600, durationMin: 30 });
    fatima = await addMaster(t, 'Фатима', 'fatima');
    const anna = await make(t, '/api/clients', { name: 'Анна', phone: '+79991234567' });
    await linkChat(t, anna.id, CHAT);
  });
  afterEach(async () => {
    vi.useRealTimers();
    await t.close();
  });

  const book = async (startsAt: string) =>
    (await pub(t, 'POST', '', { items: [{ serviceId: lobe.id }], masterId: fatima.id, startsAt, name: 'Анна', phone: '+79991234567' })).json();
  const appointment = async (id: number) => (await t.api('GET', `/api/appointments/${id}`)).json() as Json;
  const setHours = (confirmationHours: number | null) => t.api('PUT', '/api/settings/studio', { onlineBooking: { confirmationHours } });

  it('keeps confirmationHours: default 24, 1…168 or null (never), omitted unchanged', async () => {
    expect((await t.api('GET', '/api/settings/studio')).json().onlineBooking.confirmationHours).toBe(24);
    for (const bad of [0, 169, 1.5, '12', -1]) {
      const res = await setHours(bad as number);
      expect(res.statusCode).toBe(400);
    }
    expect((await setHours(1)).json().onlineBooking.confirmationHours).toBe(1);
    expect((await setHours(168)).json().onlineBooking.confirmationHours).toBe(168);
    expect((await setHours(null)).json().onlineBooking.confirmationHours).toBeNull();
    // Older builds never send it: it stays as it is.
    const other = await t.api('PUT', '/api/settings/studio', { onlineBooking: { leadMinutes: 60, note: null } });
    expect(other.json().onlineBooking).toMatchObject({ leadMinutes: 60, confirmationHours: null });
    expect((await t.api('GET', '/api/settings/studio')).json().onlineBooking.confirmationHours).toBeNull();
  });

  it('the deadline is N hours after the booking was made or 2 hours before its start, whichever comes first', () => {
    const createdAt = NOW;
    expect(confirmationDeadline({ createdAt, startsAt: NOW + 72 * HOUR }, 24)).toBe(NOW + 24 * HOUR);
    expect(confirmationDeadline({ createdAt, startsAt: NOW + 10 * HOUR }, 24)).toBe(NOW + 8 * HOUR);
    // Never sooner than 30 minutes after it was made: the nearest free time is not rejected at once.
    expect(confirmationDeadline({ createdAt, startsAt: NOW + 2 * HOUR }, 24)).toBe(NOW + 30 * MIN);
    expect(confirmationDeadline({ createdAt, startsAt: NOW + 2 * HOUR + 45 * MIN }, 24)).toBe(NOW + 45 * MIN);
  });

  it('gives a booking for the nearest time 30 minutes before rejecting it', async () => {
    await t.api('PUT', '/api/settings/studio', { onlineBooking: { leadMinutes: 60, stepMinutes: 60 } });
    const booking = await book('2026-10-15T10:00:00.000Z'); // 13:00 Moscow, an hour from now
    vi.setSystemTime(NOW + MIN);
    expect(await rejectUnconfirmedBookings(t.ctx)).toBe(0);
    vi.setSystemTime(NOW + 29 * MIN);
    expect(await rejectUnconfirmedBookings(t.ctx)).toBe(0);
    vi.setSystemTime(NOW + 30 * MIN);
    expect(await rejectUnconfirmedBookings(t.ctx)).toBe(1);
    expect((await appointment(booking.number)).status).toBe('cancelled');
  });

  it('leaves a booking that holds a prepayment to staff (nothing is kept by the cancellation rules)', async () => {
    await t.api('PUT', '/api/settings/studio', { cancellation: { autoRetain: true } });
    const booking = await book(FRIDAY_NOON);
    expect((await t.api('POST', `/api/appointments/${booking.number}/deposit`, { amount: 500, method: 'transfer' })).statusCode).toBe(200);
    vi.setSystemTime(NOW + 30 * HOUR);
    expect(await rejectUnconfirmedBookings(t.ctx)).toBe(0);
    expect(await appointment(booking.number)).toMatchObject({ status: 'scheduled', onlineState: 'awaiting_confirmation', deposit: 500 });
  });

  it('rejects one N hours after it was made, like staff would: client, staff chat, freed time, audit as system', async () => {
    const booking = await book(MONDAY_NOON);
    // Someone waits for that day: the freed time is queued for the waitlist.
    const boris = await make(t, '/api/clients', { name: 'Борис', phone: '+79990000002' });
    t.ctx.db
      .insert(waitlistEntries)
      .values({
        clientId: boris.id, items: JSON.stringify([{ serviceId: lobe.id }]), masterId: null, dateFrom: '2026-10-19', dateTo: '2026-10-19',
        status: 'waiting', channel: 'web', createdAt: NOW, updatedAt: NOW,
      })
      .run();

    vi.setSystemTime(NOW + 24 * HOUR - MIN);
    expect(await rejectUnconfirmedBookings(t.ctx)).toBe(0);
    expect((await appointment(booking.number)).onlineState).toBe('awaiting_confirmation');

    vi.setSystemTime(NOW + 24 * HOUR);
    expect(await rejectUnconfirmedBookings(t.ctx)).toBe(1);
    expect(await appointment(booking.number)).toMatchObject({
      status: 'cancelled',
      onlineState: null,
      notes: `Онлайн-запись отклонена: ${REASON}`,
    });
    expect((await pub(t, 'GET', `/b/${booking.token}`)).json().status).toBe('cancelled');
    expect(t.gateway.textsTo(CHAT).at(-1)).toBe(
      `😔 Не получится принять запись на 19 октября, 12:00.\nПричина: ${REASON}\n\nВыберите другое время: ${PUBLIC_URL}/book`,
    );
    expect(t.gateway.textsTo(STAFF_CHAT).at(-1)).toBe(
      `⌛ Онлайн-запись №${booking.number} отклонена — её не подтвердили вовремя: Анна, +79991234567, Мочка — 19 октября, 12:00, мастер Фатима`,
    );
    expect((await auditEntries(t, booking.number)).at(-1)).toMatchObject({
      source: 'system',
      employee: null,
      action: 'appointment.online_reject',
      summary: `Онлайн-запись №${booking.number} (Анна) на 19 октября, 12:00 отклонена: её не подтвердили вовремя`,
      changes: { status: { from: 'scheduled', to: 'cancelled' } },
    });
    expect(queuedFreedTime(t.ctx.db)).toEqual([
      { masterId: fatima.id, date: '2026-10-19', start: Date.parse(MONDAY_NOON), end: Date.parse(MONDAY_NOON) + 30 * MIN },
    ]);
    const slots = (await pub(t, 'GET', `/slots?date=2026-10-19&items=${lobe.id}&masterId=${fatima.id}`)).json().items as Json[];
    expect(slots.map((s) => hhmm(s.startsAt))).toContain('12:00');
    expect((await t.api('GET', '/api/badges')).json().onlineAwaiting).toBe(0);

    // Once only.
    vi.setSystemTime(NOW + 25 * HOUR);
    expect(await rejectUnconfirmedBookings(t.ctx)).toBe(0);
  });

  it('rejects one 2 hours before its start when that comes first', async () => {
    await setHours(168);
    const booking = await book(FRIDAY_NOON);
    vi.setSystemTime(Date.parse(FRIDAY_NOON) - 2 * HOUR - MIN);
    expect(await rejectUnconfirmedBookings(t.ctx)).toBe(0);
    vi.setSystemTime(Date.parse(FRIDAY_NOON) - 2 * HOUR);
    expect(await rejectUnconfirmedBookings(t.ctx)).toBe(1);
    expect(await appointment(booking.number)).toMatchObject({ status: 'cancelled', notes: `Онлайн-запись отклонена: ${REASON}` });
    expect(t.gateway.textsTo(CHAT).at(-1)).toContain('😔 Не получится принять запись на 16 октября, 12:00.');
  });

  it('never rejects with null, and leaves confirmed and closed bookings alone', async () => {
    // One at a time: a client may have at most 2 unsettled online bookings.
    const confirmed = await book(MONDAY_NOON);
    expect((await t.api('POST', `/api/appointments/${confirmed.number}/online/confirm`)).statusCode).toBe(200);
    const cancelledByClient = await book('2026-10-19T10:00:00.000Z');
    expect((await pub(t, 'POST', `/b/${cancelledByClient.token}/cancel`)).statusCode).toBe(200);
    const waiting = await book(FRIDAY_NOON);
    await setHours(null);
    const told = t.gateway.textsTo(CHAT).length;
    vi.setSystemTime(Date.parse(FRIDAY_NOON) - MIN);
    expect(await rejectUnconfirmedBookings(t.ctx)).toBe(0);
    expect((await appointment(waiting.number)).onlineState).toBe('awaiting_confirmation');

    await setHours(24);
    vi.setSystemTime(NOW + 30 * HOUR);
    expect(await rejectUnconfirmedBookings(t.ctx)).toBe(1); // only the one still waiting
    expect(await appointment(confirmed.number)).toMatchObject({ status: 'scheduled', onlineState: null, notes: null });
    expect((await appointment(cancelledByClient.number)).notes).toBe('Отменена клиентом онлайн');
    expect(t.gateway.textsTo(CHAT).length).toBe(told + 1);
  });

  it('a booking staff confirm meanwhile is not rejected', async () => {
    const booking = await book(MONDAY_NOON);
    vi.setSystemTime(NOW + 24 * HOUR);
    expect((await t.api('POST', `/api/appointments/${booking.number}/online/confirm`)).statusCode).toBe(200);
    expect(await rejectUnconfirmedBookings(t.ctx)).toBe(0);
    expect((await appointment(booking.number)).status).toBe('scheduled');
  });

  it('names the reason as documented', () => {
    expect(UNCONFIRMED_REASON).toBe(REASON);
  });
});
