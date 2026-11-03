import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { morningDigest } from '../src/bot/digest.js';
import { sendDueRetention } from '../src/bot/retention.js';
import { buildStaffToolHandlers } from '../src/bot/staff-tools.js';
import { employees } from '../src/db/schema.js';
import { birthdayDiscount } from '../src/domain/loyalty.js';
import { DEFAULT_RETENTION } from '../src/domain/retention-settings.js';
import { createTestApp, make, type TestApp } from './helpers.js';
import { addClient, FakeClock } from './retention-fixtures.js';

/** The year 1900 is «year unknown»: every use of the birthday takes only its day and month. */

const msk = (date: string, time: string) => Date.parse(`${date}T${time}:00+03:00`);
const TZ = 'Europe/Moscow';

describe('a birthday without a year (stored as 1900)', () => {
  let t: TestApp;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(msk('2026-10-19', '08:00'));
    t = await createTestApp();
  });
  afterEach(async () => {
    await t.close();
    vi.useRealTimers();
  });

  it('staff can save and clear it, 29 February included; the API returns it as stored', async () => {
    const client = await make(t, '/api/clients', { name: 'Анна', phone: '+79990000301', birthday: '1900-04-12' });
    expect(client.birthday).toBe('1900-04-12');
    const leap = await t.api('PATCH', `/api/clients/${client.id}`, { birthday: '1900-02-29' });
    expect(leap.statusCode, leap.body).toBe(200);
    expect(leap.json().birthday).toBe('1900-02-29');
    expect((await t.api('PATCH', `/api/clients/${client.id}`, { birthday: '1995-02-29' })).statusCode).toBe(400);
    expect((await t.api('PATCH', `/api/clients/${client.id}`, { birthday: '1900-02-30' })).statusCode).toBe(400);
    expect((await t.api('PATCH', `/api/clients/${client.id}`, { birthday: null })).json().birthday).toBeNull();
  });

  it('is greeted on its day, and 29 February on the 28th in other years', async () => {
    await addClient(t, 'Анна', { chatId: 7101, birthday: '1900-10-19' });
    await addClient(t, 'Борис', { chatId: 7102, birthday: '1900-10-20' });
    const clock = new FakeClock(msk('2026-10-19', '10:00'));
    expect((await sendDueRetention(t.ctx, { now: clock.t, clock })).birthday).toBe(1);
    expect(t.gateway.textsTo(7101)).toHaveLength(1);
    expect(t.gateway.textsTo(7102)).toHaveLength(0);

    await addClient(t, 'Вера', { chatId: 7103, birthday: '1900-02-29' });
    const feb = new FakeClock(msk('2027-02-28', '10:00'));
    vi.setSystemTime(feb.t);
    expect((await sendDueRetention(t.ctx, { now: feb.t, clock: feb })).birthday).toBe(1);
    expect(t.gateway.textsTo(7103)).toHaveLength(1);
  });

  it('opens the birthday discount window around day and month', () => {
    const settings = { ...DEFAULT_RETENTION.birthday, discountPercent: 10 };
    expect(birthdayDiscount({ birthday: '1900-10-20' }, settings, msk('2026-10-15', '12:00'), TZ)).toEqual({ percent: 10, until: '2026-10-27' });
    expect(birthdayDiscount({ birthday: '1900-10-23' }, settings, msk('2026-10-15', '12:00'), TZ)).toBeNull();
    expect(birthdayDiscount({ birthday: '1900-01-03' }, settings, msk('2026-12-30', '12:00'), TZ)).toEqual({ percent: 10, until: '2027-01-10' });
    expect(birthdayDiscount({ birthday: '1900-02-29' }, settings, msk('2027-02-22', '12:00'), TZ)).toEqual({ percent: 10, until: '2027-03-07' });
  });

  it('is named in the morning digest, 29 February on the 28th in other years', async () => {
    const lobe = await make(t, '/api/services', { name: 'Мочка', category: 'piercing', price: 1600, durationMin: 30 });
    const anna = await make(t, '/api/clients', { name: 'Анна', phone: '+79990000311', birthday: '1900-10-19' });
    const vera = await make(t, '/api/clients', { name: 'Вера', phone: '+79990000312', birthday: '1900-02-28' });
    const book = (clientId: number, startsAt: string) =>
      make(t, '/api/appointments', { services: [{ serviceId: lobe.id }], force: true, clientId, masterId: 1, startsAt });
    await book(anna.id, '2026-10-19T09:00:00.000Z');
    await book(vera.id, '2026-10-19T11:00:00.000Z');
    const admin = t.ctx.db.select().from(employees).where(eq(employees.id, 1)).get()!;
    const text = morningDigest(t.ctx.db, msk('2026-10-19', '09:40'), admin);
    expect(text).toContain('• 🎂 Сегодня день рождения: Анна — запись в 12:00');
    expect(text).not.toContain('день рождения: Вера');

    const leap = await make(t, '/api/clients', { name: 'Лея', phone: '+79990000313', birthday: '1900-02-29' });
    await book(leap.id, '2027-02-28T09:00:00.000Z');
    expect(morningDigest(t.ctx.db, msk('2027-02-28', '09:40'), admin)).toContain('• 🎂 Сегодня день рождения: Лея — запись в 12:00');
  });

  it('matches the campaign birthday month', async () => {
    await addClient(t, 'Анна', { chatId: 7201, birthday: '1900-11-03' });
    await addClient(t, 'Борис', { chatId: 7202, birthday: '1990-10-19' });
    const preview = await t.api('POST', '/api/campaigns/preview', { segment: { birthdayMonth: 11 } });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().count).toBe(1);
    expect(preview.json().sample.map((c: { name: string }) => c.name)).toEqual(['Анна']);
  });

  it('the staff bot shows it without the year and never an age', async () => {
    await make(t, '/api/clients', { name: 'Анна', phone: '+79990000321', birthday: '1900-04-12' });
    await make(t, '/api/clients', { name: 'Борис', phone: '+79990000322', birthday: '1995-04-12' });
    const admin = t.ctx.db.select().from(employees).where(eq(employees.id, 1)).get()!;
    const tools = buildStaffToolHandlers(t.ctx, admin);
    const anna = String((await tools.client_info!({ query: 'Анна' })).content);
    expect(anna).toContain('День рождения: 12 апреля\n');
    expect(anna).not.toContain('1900');
    const boris = String((await tools.client_info!({ query: 'Борис' })).content);
    expect(boris).toContain('День рождения: 12 апреля 1995');
  });
});
