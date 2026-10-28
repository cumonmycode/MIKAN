import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitlistEntries } from '../src/db/schema.js';
import { CLIENT_LIMIT_MESSAGE, CLOSED_MESSAGE, expireWaitlist, STAFF_LIMIT_MESSAGE } from '../src/domain/waitlist.js';
import { make, type TestApp } from './helpers.js';
import { loginAs, NOW, type Json } from './online-booking-fixtures.js';
import { addEntry, msk, waitlistWorld } from './waitlist-fixtures.js';

const DAY = 24 * 60 * 60_000;

describe('waitlist: staff entries', () => {
  let t: TestApp;
  let lobe: Json;
  let nipple: Json;
  let fatima: Json;
  let anna: Json;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    ({ t, lobe, nipple, fatima, anna } = await waitlistWorld());
  });
  afterEach(async () => {
    vi.useRealTimers();
    await t.close();
  });

  const wish = (overrides: Record<string, unknown> = {}) => ({
    clientId: anna.id,
    items: [{ serviceId: lobe.id }],
    dateFrom: '2026-10-21',
    dateTo: '2026-10-25',
    ...overrides,
  });
  const badge = async () => (await t.api('GET', '/api/badges')).json().waitlist as number;

  it('adds an entry for a client and lists it with its references', async () => {
    const res = await addEntry(t, wish({ items: [{ serviceId: lobe.id }, { serviceId: nipple.id, variant: 'два' }], masterId: fatima.id, note: '  после 18:00 ' }));
    expect(res.statusCode).toBe(200);
    const entry = res.json();
    expect(entry).toEqual({
      id: entry.id,
      client: { id: anna.id, name: 'Анна', lastName: 'Иванова', phone: '+79991234567', telegramLinked: false },
      items: [
        { serviceId: lobe.id, variant: null, name: 'Мочка' },
        // The variant as the catalog names it.
        { serviceId: nipple.id, variant: 'Два', name: 'Соски' },
      ],
      master: { id: fatima.id, name: 'Фатима', color: fatima.color },
      dateFrom: '2026-10-21',
      dateTo: '2026-10-25',
      status: 'waiting',
      channel: 'app',
      notifiedAt: null,
      appointmentId: null,
      note: 'после 18:00',
      createdAt: new Date(NOW).toISOString(),
    });
    expect((await t.api('GET', '/api/waitlist')).json().items).toEqual([entry]);
    expect(await badge()).toBe(1);
    // Nothing is said to the staff chat about what staff added themselves.
    expect(t.gateway.sent).toEqual([]);
  });

  it('checks services, master, dates, client and note', async () => {
    const admin2 = await make(t, '/api/employees', { name: 'Админ 2', login: 'admin2', password: 'secret123', isMaster: false });
    const old = await make(t, '/api/services', { name: 'Старое', category: 'other', price: 100, durationMin: 10 });
    await t.api('PATCH', `/api/services/${old.id}`, { active: false });
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ dateFrom: '2026-10-14' }, 'Начало периода уже прошло — выберите даты с сегодняшнего дня'],
      [{ dateTo: '2026-10-20' }, 'Конец периода должен быть не раньше начала'],
      [{ dateFrom: '2026-10-15', dateTo: '2026-11-14' }, 'Период — не больше 30 дней'],
      [{ dateFrom: '2027-10-15', dateTo: '2027-10-17' }, 'Лист ожидания — не дальше чем на год вперёд'],
      [{ dateFrom: '2026-02-30', dateTo: '2026-03-01' }, 'Даты должны быть в формате ГГГГ-ММ-ДД'],
      [{ items: [{ serviceId: old.id }] }, 'Эта услуга сейчас недоступна для онлайн-записи — обновите список услуг'],
      [{ items: [{ serviceId: nipple.id }] }, 'Выберите вариант услуги «Соски»: Один, Два'],
      [{ masterId: admin2.id }, 'Этот мастер сейчас не принимает записи — выберите другого или «Любой мастер»'],
      [{ clientId: 9999 }, 'Клиент не найден'],
      [{ note: 'x'.repeat(501) }, '«Комментарий»: максимум 500 символов'],
      [{ items: [] }, '«Позиции»: нужно указать хотя бы 1'],
      [{ dateFrom: undefined }, '«Даты с»: обязательное поле'],
    ];
    for (const [overrides, message] of cases) {
      const res = await addEntry(t, wish(overrides));
      expect({ status: res.statusCode, message: res.json().error.message }).toEqual({ status: 400, message });
    }
    // 30 days inclusive and a year ahead are fine.
    expect((await addEntry(t, wish({ dateFrom: '2026-10-15', dateTo: '2026-11-13' }))).statusCode).toBe(200);
    expect((await addEntry(t, wish({ dateFrom: '2027-10-10', dateTo: '2027-10-15' }))).statusCode).toBe(200);
  });

  it('keeps at most 3 open entries per client and returns the same open wish instead of a copy', async () => {
    const first = (await addEntry(t, wish())).json();
    expect((await addEntry(t, wish())).json().id).toBe(first.id);
    await addEntry(t, wish({ dateFrom: '2026-10-26', dateTo: '2026-10-28' }));
    await addEntry(t, wish({ masterId: fatima.id }));
    const fourth = await addEntry(t, wish({ items: [{ serviceId: nipple.id, variant: 'Один' }] }));
    expect(fourth.statusCode).toBe(409);
    expect(fourth.json().error).toEqual({ code: 'conflict', message: STAFF_LIMIT_MESSAGE });
    expect(STAFF_LIMIT_MESSAGE).toBe('В листе ожидания уже 3 заявки этого клиента');
    expect(CLIENT_LIMIT_MESSAGE).toContain('У вас уже 3 заявки в листе ожидания');
    // A cancelled entry frees a place.
    await t.api('PATCH', `/api/waitlist/${first.id}`, { status: 'cancelled' });
    expect((await addEntry(t, wish({ items: [{ serviceId: nipple.id, variant: 'Один' }] }))).statusCode).toBe(200);
    expect(await badge()).toBe(3);
  });

  it('cancels open entries only', async () => {
    const entry = (await addEntry(t, wish())).json();
    const cancelled = await t.api('PATCH', `/api/waitlist/${entry.id}`, { status: 'cancelled' });
    expect(cancelled.json()).toMatchObject({ id: entry.id, status: 'cancelled' });
    expect(await badge()).toBe(0);
    // Again: as is.
    expect((await t.api('PATCH', `/api/waitlist/${entry.id}`, { status: 'cancelled' })).statusCode).toBe(200);
    // A booked entry is closed.
    const other = (await addEntry(t, wish({ dateFrom: '2026-10-16', dateTo: '2026-10-16' }))).json();
    await make(t, '/api/appointments', {
      clientId: anna.id,
      masterId: fatima.id,
      services: [{ serviceId: lobe.id }],
      startsAt: msk('2026-10-16T15:00'),
    });
    const closed = await t.api('PATCH', `/api/waitlist/${other.id}`, { status: 'cancelled' });
    expect(closed.statusCode).toBe(409);
    expect(closed.json().error.message).toBe(CLOSED_MESSAGE);
    expect((await t.api('PATCH', '/api/waitlist/9999', { status: 'cancelled' })).statusCode).toBe(404);
    expect((await t.api('PATCH', `/api/waitlist/${entry.id}`, { status: 'waiting' })).statusCode).toBe(400);
  });

  it('filters by status, oldest first, and shows closed entries of the last 90 days', async () => {
    const a = (await addEntry(t, wish())).json();
    vi.setSystemTime(NOW + 60_000);
    const b = (await addEntry(t, wish({ masterId: fatima.id }))).json();
    await t.api('PATCH', `/api/waitlist/${a.id}`, { status: 'cancelled' });
    const ids = async (query = '') => ((await t.api('GET', `/api/waitlist${query}`)).json().items as Json[]).map((e) => e.id);
    expect(await ids()).toEqual([a.id, b.id]);
    expect(await ids('?status=waiting')).toEqual([b.id]);
    expect(await ids('?status=cancelled,waiting')).toEqual([a.id, b.id]);
    const bad = await t.api('GET', '/api/waitlist?status=lost');
    expect(bad.json().error.message).toBe('«Статус»: недопустимое значение «lost»');
    // Closed 91 days ago: no longer listed.
    t.ctx.db.update(waitlistEntries).set({ updatedAt: NOW - 91 * DAY }).where(eq(waitlistEntries.id, a.id)).run();
    expect(await ids()).toEqual([b.id]);
    expect(await ids('?status=cancelled')).toEqual([]);
  });

  it('lets every staff role read, add and cancel', async () => {
    await make(t, '/api/employees', { name: 'Мастер', login: 'master', password: 'secret123', isMaster: true, role: 'master' });
    const asMaster = await loginAs(t, 'master');
    const added = await asMaster('POST', '/api/waitlist', wish());
    expect(added.statusCode).toBe(200);
    expect((await asMaster('GET', '/api/waitlist')).json().items).toHaveLength(1);
    expect((await asMaster('PATCH', `/api/waitlist/${added.json().id}`, { status: 'cancelled' })).statusCode).toBe(200);
  });

  it('logs adding and cancelling', async () => {
    const entry = (await addEntry(t, wish({ masterId: fatima.id }))).json();
    await t.api('PATCH', `/api/waitlist/${entry.id}`, { status: 'cancelled' });
    const log = ((await t.api('GET', `/api/audit?entity=waitlist&entityId=${entry.id}`)).json().items as Json[]).reverse();
    expect(log.map((e) => ({ source: e.source, action: e.action, summary: e.summary, changes: e.changes }))).toEqual([
      {
        source: 'app',
        action: 'waitlist.create',
        summary: `Лист ожидания №${entry.id} (Анна Иванова): добавлена заявка — Мочка, 21–25 октября, мастер Фатима`,
        changes: null,
      },
      {
        source: 'app',
        action: 'waitlist.cancel',
        summary: `Лист ожидания №${entry.id} (Анна Иванова): заявка отменена — Мочка, 21–25 октября, мастер Фатима`,
        changes: { status: { from: 'waiting', to: 'cancelled' } },
      },
    ]);
  });

  it('expires entries whose last date is before today', async () => {
    const ending = (await addEntry(t, wish({ dateFrom: '2026-10-15', dateTo: '2026-10-16' }))).json();
    const later = (await addEntry(t, wish())).json();
    // Friday 23:59 Moscow: the last day is still today.
    vi.setSystemTime(Date.parse('2026-10-16T20:59:00Z'));
    expect(expireWaitlist(t.ctx.db)).toBe(0);
    vi.setSystemTime(Date.parse('2026-10-16T21:01:00Z'));
    expect(expireWaitlist(t.ctx.db)).toBe(1);
    const rows = t.ctx.db.select().from(waitlistEntries).all();
    expect(rows.map((r) => [r.id, r.status])).toEqual([
      [ending.id, 'expired'],
      [later.id, 'waiting'],
    ]);
    expect(await badge()).toBe(1);
  });
});

describe('waitlist: a booking closes the matching entries', () => {
  let t: TestApp;
  let lobe: Json;
  let tattoo: Json;
  let fatima: Json;
  let anna: Json;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    ({ t, lobe, tattoo, fatima, anna } = await waitlistWorld());
  });
  afterEach(async () => {
    vi.useRealTimers();
    await t.close();
  });

  const book = (overrides: Record<string, unknown>) =>
    t.api('POST', '/api/appointments', {
      clientId: anna.id,
      masterId: fatima.id,
      services: [{ serviceId: lobe.id }],
      startsAt: msk('2026-10-22T15:00'),
      ...overrides,
    });
  const statusOf = async (id: number) =>
    ((await t.api('GET', '/api/waitlist')).json().items as Json[]).find((e) => e.id === id) as Json;

  it('books an entry in range with its master and one of its services', async () => {
    const entry = (await addEntry(t, { clientId: anna.id, items: [{ serviceId: lobe.id }, { serviceId: tattoo.id }], masterId: fatima.id, dateFrom: '2026-10-21', dateTo: '2026-10-25' })).json();
    const admin = 1;
    // Another master, a date outside the range, another service, a cancelled appointment, another client: no.
    expect((await book({ masterId: admin })).statusCode).toBe(200);
    expect((await book({ startsAt: msk('2026-10-26T12:00') })).statusCode).toBe(200);
    const other = await make(t, '/api/services', { name: 'Септум', category: 'piercing', price: 2000, durationMin: 30 });
    expect((await book({ services: [{ serviceId: other.id }], startsAt: msk('2026-10-23T12:00') })).statusCode).toBe(200);
    expect((await book({ status: 'cancelled', startsAt: msk('2026-10-23T14:00') })).statusCode).toBe(200);
    const boris = await make(t, '/api/clients', { name: 'Борис', phone: '+79990000002' });
    expect((await book({ clientId: boris.id, startsAt: msk('2026-10-24T12:00') })).statusCode).toBe(200);
    expect((await statusOf(entry.id)).status).toBe('waiting');

    const booked = (await book({ startsAt: msk('2026-10-25T20:00') })).json();
    expect(await statusOf(entry.id)).toMatchObject({ status: 'booked', appointmentId: booked.id });
    const log = (await t.api('GET', `/api/audit?entity=waitlist&entityId=${entry.id}`)).json().items as Json[];
    expect(log[0]).toMatchObject({
      source: 'system',
      action: 'waitlist.book',
      summary: `Лист ожидания №${entry.id} (Анна Иванова) закрыт записью №${booked.id}`,
    });
  });

  it('books an entry for «any master» with whoever the appointment is with', async () => {
    const entry = (await addEntry(t, { clientId: anna.id, items: [{ serviceId: lobe.id }], dateFrom: '2026-10-21', dateTo: '2026-10-21' })).json();
    const booked = (await book({ masterId: 1, startsAt: msk('2026-10-21T11:00') })).json();
    expect(await statusOf(entry.id)).toMatchObject({ status: 'booked', appointmentId: booked.id });
  });
});
