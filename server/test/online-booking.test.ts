import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, make, type TestApp } from './helpers.js';
import {
  addMaster,
  auditEntries,
  bindStaffChat,
  FRIDAY_NOON,
  hhmm,
  linkChat,
  NOW,
  pub,
  PUBLIC_URL,
  STAFF_CHAT,
  type Json,
} from './online-booking-fixtures.js';

describe('online booking: settings, catalog and free time', () => {
  let t: TestApp;
  let lobe: Json;
  let nipple: Json;
  let fatima: Json;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    t = await createTestApp({ env: { PUBLIC_URL } });
    lobe = await make(t, '/api/services', { name: 'Мочка', category: 'piercing', price: 1600, durationMin: 30 });
    nipple = await make(t, '/api/services', {
      name: 'Соски',
      category: 'piercing',
      price: 2500,
      durationMin: 45,
      depositAmount: 1000,
      description: 'Прокол соска',
      variants: [
        { name: 'Один', price: 2500, durationMin: null },
        { name: 'Два', price: 4000, durationMin: 60 },
      ],
    });
    fatima = await addMaster(t, 'Фатима', 'fatima');
  });
  afterEach(async () => {
    vi.useRealTimers();
    await t.close();
  });

  it('keeps the onlineBooking settings: defaults, validation, omitted fields unchanged', async () => {
    expect((await t.api('GET', '/api/settings/studio')).json().onlineBooking).toEqual({
      enabled: true, leadMinutes: 120, horizonDays: 60, holdMinutes: 15, stepMinutes: 30, note: '', confirmationHours: 24,
    });
    const put = await t.api('PUT', '/api/settings/studio', { onlineBooking: { leadMinutes: 60, note: 'Возьмите паспорт' } });
    expect(put.json().onlineBooking).toEqual({
      enabled: true, leadMinutes: 60, horizonDays: 60, holdMinutes: 15, stepMinutes: 30, note: 'Возьмите паспорт', confirmationHours: 24,
    });
    // Another subset keeps the rest; null clears the note.
    const again = await t.api('PUT', '/api/settings/studio', { name: 'MIKAN', onlineBooking: { stepMinutes: 15, note: null } });
    expect(again.json().onlineBooking).toMatchObject({ leadMinutes: 60, stepMinutes: 15, note: '' });
    for (const bad of [{ stepMinutes: 20 }, { holdMinutes: 3 }, { horizonDays: 181 }, { leadMinutes: 3000 }, { note: 'x'.repeat(501) }]) {
      const res = await t.api('PUT', '/api/settings/studio', { onlineBooking: bad });
      expect(res.statusCode).toBe(400);
    }
    expect((await t.api('GET', '/api/settings/studio')).json().onlineBooking.stepMinutes).toBe(15);
  });

  it('serves the config, the services in catalog order and the active masters without internal fields', async () => {
    await make(t, '/api/services', { name: 'Тату', category: 'tattoo', price: 15000, priceFrom: true, durationMin: 180 });
    const hidden = await make(t, '/api/services', { name: 'Старое', category: 'other', price: 100, durationMin: 10 });
    await t.api('PATCH', `/api/services/${hidden.id}`, { active: false });
    await make(t, '/api/employees', { name: 'Админ 2', login: 'admin2', password: 'secret123', isMaster: false });
    const off = await addMaster(t, 'Ушла', 'gone');
    await t.api('PATCH', `/api/employees/${off.id}`, { active: false });

    const config = (await pub(t, 'GET', '/config')).json();
    expect(config).toEqual({
      enabled: true,
      studio: { name: 'MIKAN STUDIO', address: '', phone: '', workingHours: 'Ежедневно 11:00–21:00', timezone: 'Europe/Moscow' },
      note: '',
      leadMinutes: 120,
      horizonDays: 60,
      holdMinutes: 15,
      stepMinutes: 30,
      cancellationText: 'Бесплатно отменить или перенести запись можно не позднее чем за 24 часа; при более поздней отмене предоплата не возвращается, при неявке — тоже.',
      botUsername: 'mikan_test_bot',
    });

    const services = (await pub(t, 'GET', '/services')).json().items as Json[];
    expect(services.map((s) => s.name)).toEqual(['Тату', 'Мочка', 'Соски']); // tattoo first, inactive left out
    expect(services[2]).toEqual({
      id: nipple.id,
      name: 'Соски',
      category: 'piercing',
      group: null,
      description: 'Прокол соска',
      priceText: '2 500 ₽',
      price: 2500,
      durationMin: 45,
      depositAmount: 1000,
      imageUrl: null,
      variants: [
        { name: 'Один', priceText: '2 500 ₽', price: 2500, durationMin: 45 },
        { name: 'Два', priceText: '4 000 ₽', price: 4000, durationMin: 60 },
      ],
      masterPrices: [],
      portfolio: 0,
    });
    expect(services[0]!.priceText).toBe('от 15 000 ₽');

    const masters = (await pub(t, 'GET', '/masters')).json().items as Json[];
    expect(masters).toEqual([
      { id: 1, name: 'Админ', color: expect.any(String), photos: 0, cover: null },
      { id: fatima.id, name: 'Фатима', color: expect.any(String), photos: 0, cover: null },
    ]);
  });

  it('offers free starts on the grid, after the lead time, with the masters free at each', async () => {
    // Admin busy 15:00–16:00 Moscow today.
    const client = await make(t, '/api/clients', { name: 'Пётр', phone: '+79990000001' });
    await make(t, '/api/appointments', { clientId: client.id, masterId: 1, title: 'x', startsAt: '2026-10-15T12:00:00.000Z', endsAt: '2026-10-15T13:00:00.000Z' });

    const today = (await pub(t, 'GET', `/slots?date=2026-10-15&items=${lobe.id}`)).json();
    expect(today).toMatchObject({ date: '2026-10-15', durationMin: 30 });
    const starts = today.items as Json[];
    expect(hhmm(starts[0]!.startsAt)).toBe('14:00'); // 12:00 now + 2 h lead
    expect(Date.parse(starts[1]!.startsAt) - Date.parse(starts[0]!.startsAt)).toBe(30 * 60_000);
    expect(starts.find((s) => hhmm(s.startsAt) === '14:00')!.masterIds).toEqual([1, fatima.id]);
    expect(starts.find((s) => hhmm(s.startsAt) === '15:00')!.masterIds).toEqual([fatima.id]);
    expect(hhmm(starts.at(-1)!.startsAt)).toBe('20:30');

    // A master and a variant change the answer; the variant goes URL-encoded.
    const two = (await pub(t, 'GET', `/slots?date=2026-10-16&items=${nipple.id}:${encodeURIComponent('Два')},${lobe.id}&masterId=${fatima.id}`)).json();
    expect(two.durationMin).toBe(90);
    expect((two.items as Json[]).every((s) => s.masterIds.join() === String(fatima.id))).toBe(true);
    expect(hhmm((two.items as Json[]).at(-1)!.startsAt)).toBe('19:30');

    // Step and lead follow the settings.
    await t.api('PUT', '/api/settings/studio', { onlineBooking: { stepMinutes: 60, leadMinutes: 0 } });
    const hourly = ((await pub(t, 'GET', `/slots?date=2026-10-15&items=${lobe.id}&masterId=${fatima.id}`)).json().items as Json[]).map((s) => hhmm(s.startsAt));
    expect(hourly).toEqual(['12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00', '20:00']);

    const missingVariant = await pub(t, 'GET', `/slots?date=2026-10-16&items=${nipple.id}`);
    expect(missingVariant.statusCode).toBe(400);
    expect(missingVariant.json().error.message).toBe('Выберите вариант услуги «Соски»: Один, Два');
    expect((await pub(t, 'GET', `/slots?date=2026-10-16&items=${lobe.id}&masterId=999`)).statusCode).toBe(400);
  });

  it('tells which days have free time, within the horizon and at most 31 days at once', async () => {
    const days = (await pub(t, 'GET', `/days?from=2026-10-15&to=2026-10-17&items=${lobe.id}`)).json().items;
    expect(days).toEqual([
      { date: '2026-10-15', available: true },
      { date: '2026-10-16', available: true },
      { date: '2026-10-17', available: true },
    ]);
    const edge = (await pub(t, 'GET', `/days?from=2026-12-13&to=2026-12-15&items=${lobe.id}`)).json().items;
    expect(edge).toEqual([
      { date: '2026-12-13', available: true },
      { date: '2026-12-14', available: true }, // today + 60 days
      { date: '2026-12-15', available: false },
    ]);
    expect((await pub(t, 'GET', `/days?from=2026-10-15&to=2026-11-20&items=${lobe.id}`)).statusCode).toBe(400);
    const defaults = (await pub(t, 'GET', `/days?items=${lobe.id}`)).json().items as Json[];
    expect(defaults).toHaveLength(14);
    expect(defaults[0]!.date).toBe('2026-10-15');
    expect((await pub(t, 'GET', '/days')).statusCode).toBe(400);
  });
});

describe('online booking: booking from the page', () => {
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
  });
  afterEach(async () => {
    vi.useRealTimers();
    await t.close();
  });

  const book = (extra: Json = {}, ip = '10.0.0.1') =>
    pub(t, 'POST', '', { items: [{ serviceId: lobe.id }], masterId: fatima.id, startsAt: FRIDAY_NOON, name: 'Анна', phone: '8 (999) 123-45-67', ...extra }, { ip });

  it('books without a prepayment: the time is held and waits for staff; the staff chat is told', async () => {
    const res = await book({ comment: 'Хочу гвоздик' });
    expect(res.statusCode).toBe(200);
    const booking = res.json();
    expect(booking).toEqual({
      token: expect.stringMatching(/^[A-Za-z0-9_-]{24}$/),
      status: 'awaiting_confirmation',
      number: expect.any(Number),
      items: [{ name: 'Мочка', price: 1600 }],
      master: { name: 'Фатима' },
      startsAt: FRIDAY_NOON,
      endsAt: '2026-10-16T09:30:00.000Z',
      price: 1600,
      depositRequired: 0,
      holdUntil: null,
      payment: null,
      studio: { name: 'MIKAN STUDIO', address: '', phone: '' },
      telegramLink: `https://t.me/mikan_test_bot?start=b_${booking.token}`,
      calendarUrl: `${PUBLIC_URL}/api/public/booking/b/${booking.token}/calendar.ics`,
    });

    const appointment = (await t.api('GET', `/api/appointments/${booking.number}`)).json();
    expect(appointment).toMatchObject({
      channel: 'web',
      onlineState: 'awaiting_confirmation',
      holdUntil: null,
      status: 'scheduled',
      master: { id: fatima.id },
      client: { name: 'Анна', phone: '+79991234567' },
      services: [{ serviceId: lobe.id, name: 'Мочка', price: 1600, durationMin: 30 }],
      price: 1600,
      notes: 'Хочу гвоздик',
    });
    const card = (await t.api('GET', `/api/clients/${appointment.client.id}`)).json();
    expect(card).toMatchObject({ name: 'Анна', source: 'онлайн-запись' });
    expect(t.gateway.textsTo(STAFF_CHAT)).toContain(
      '🆕 Онлайн-запись (сайт): Анна, +79991234567, Мочка — 16 октября, 12:00, мастер Фатима · ждёт подтверждения\nКомментарий: Хочу гвоздик',
    );
    // The app sees it waiting: badge, filter, the online fields.
    expect((await t.api('GET', '/api/badges')).json().onlineAwaiting).toBe(1);
    const waiting = (await t.api('GET', '/api/appointments?onlineState=awaiting_confirmation')).json().items as Json[];
    expect(waiting.map((a) => a.id)).toEqual([booking.number]);
    expect((await t.api('GET', '/api/appointments?onlineState=awaiting_payment')).json().items).toEqual([]);
    expect((await t.api('GET', '/api/appointments?onlineState=nope')).statusCode).toBe(400);
    expect((await t.api('GET', '/api/audit?source=online')).json().items).toHaveLength(1);
    const [created] = await auditEntries(t, booking.number);
    expect(created).toMatchObject({
      source: 'online',
      employee: null,
      action: 'appointment.create',
      summary: `Запись №${booking.number} (Анна) создана онлайн (сайт) на 16 октября, 12:00 — Мочка, мастер Фатима · ждёт подтверждения`,
    });
    // Its page shows it, its time is no longer offered.
    expect((await pub(t, 'GET', `/b/${booking.token}`)).json()).toEqual(booking);
    const slots = (await pub(t, 'GET', `/slots?date=2026-10-16&items=${lobe.id}&masterId=${fatima.id}`)).json().items as Json[];
    expect(slots.map((s) => hhmm(s.startsAt))).not.toContain('12:00');
  });

  it('uses the client card with that phone and tells a Telegram-linked client', async () => {
    const anna = await make(t, '/api/clients', { name: 'Анна', lastName: 'Иванова', phone: '+79991234567' });
    await linkChat(t, anna.id, 501);
    const booking = (await book({ name: 'Аня' })).json();
    const appointment = (await t.api('GET', `/api/appointments/${booking.number}`)).json();
    expect(appointment.client).toMatchObject({ id: anna.id, name: 'Анна', lastName: 'Иванова' });
    expect(t.gateway.textsTo(501).at(-1)).toBe('Заявка принята, время за вами 🙌 Подтвердим в ближайшее время.\n\n**16 октября, 12:00** — Мочка\nМастер: Фатима');
  });

  it('gives «any master» to the free master with the fewest appointments that day, then the lowest id', async () => {
    const first = (await book({ masterId: null, phone: '+79990000011' })).json();
    expect((await t.api('GET', `/api/appointments/${first.number}`)).json().master.id).toBe(1); // both free and empty: lowest id
    const second = (await book({ masterId: null, phone: '+79990000012', startsAt: '2026-10-16T11:00:00.000Z' })).json();
    expect((await t.api('GET', `/api/appointments/${second.number}`)).json().master.id).toBe(fatima.id); // fewer that day
    const third = (await book({ masterId: null, phone: '+79990000013' })).json(); // 12:00: only Fatima is free
    expect((await t.api('GET', `/api/appointments/${third.number}`)).json().master.id).toBe(fatima.id);
    const full = await book({ masterId: null, phone: '+79990000014' });
    expect(full.statusCode).toBe(409);
    expect(full.json().error).toEqual({ code: 'schedule_conflict', message: 'Это время только что заняли — выберите другое' });
  });

  it('refuses a taken time, an unknown service or master, bad input and a third unsettled booking', async () => {
    expect((await book()).statusCode).toBe(200);
    const taken = await book({ phone: '+79990000002' });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error.message).toBe('Это время только что заняли — выберите другое'); // never names the other client
    expect((await book({ items: [{ serviceId: 999 }] }, '10.0.0.2')).json().error.message).toBe(
      'Эта услуга сейчас недоступна для онлайн-записи — обновите список услуг',
    );
    const notMaster = await make(t, '/api/employees', { name: 'Админ 2', login: 'admin2', password: 'secret123', isMaster: false });
    expect((await book({ masterId: notMaster.id }, '10.0.0.2')).statusCode).toBe(400);
    expect((await book({ phone: '12' }, '10.0.0.2')).statusCode).toBe(400);
    expect((await book({ name: '' }, '10.0.0.2')).json().error.message).toBe('«Имя»: обязательное поле');
    expect((await book({ name: 'x'.repeat(101) }, '10.0.0.3')).statusCode).toBe(400);
    expect((await book({ startsAt: '2026-10-15T09:30:00.000Z' }, '10.0.0.3')).json().error.message).toBe(
      'Это время уже недоступно для онлайн-записи — выберите время попозже',
    );
    expect((await book({ startsAt: '2027-01-15T09:00:00.000Z' }, '10.0.0.3')).json().error.message).toBe(
      'Онлайн-запись открыта на 60 дней вперёд — выберите дату пораньше',
    );
    // Two unsettled bookings are the limit for one client.
    expect((await book({ startsAt: '2026-10-16T10:00:00.000Z' }, '10.0.0.4')).statusCode).toBe(200);
    const third = await book({ startsAt: '2026-10-16T11:00:00.000Z' }, '10.0.0.4');
    expect(third.statusCode).toBe(409);
    expect(third.json().error.message).toBe('У вас уже есть записи, которые ждут подтверждения — дождитесь ответа студии');
  });

  it('answers a filled honeypot as if booked and stores nothing', async () => {
    const res = await book({ website: 'http://spam.example' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'awaiting_confirmation', items: [{ name: 'Мочка', price: 1600 }], master: { name: 'Фатима' } });
    expect((await t.api('GET', '/api/appointments?from=2026-10-01T00:00:00Z&to=2026-11-01T00:00:00Z')).json().items).toEqual([]);
    expect((await t.api('GET', '/api/clients')).json().items).toEqual([]);
    expect(t.gateway.textsTo(STAFF_CHAT).some((m) => m.startsWith('🆕'))).toBe(false);
    expect((await pub(t, 'GET', `/b/${res.json().token}`)).statusCode).toBe(404);
  });

  it('limits booking to 5 an hour per IP', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await book({ phone: `+7999000002${i}`, startsAt: new Date(Date.parse(FRIDAY_NOON) + i * 3_600_000).toISOString() }, '10.9.9.9');
      expect(res.statusCode).toBe(200);
    }
    const sixth = await book({ phone: '+79990000030', startsAt: '2026-10-17T09:00:00.000Z' }, '10.9.9.9');
    expect(sixth.statusCode).toBe(429);
    expect(sixth.json().error.code).toBe('rate_limited');
    expect((await book({ phone: '+79990000030', startsAt: '2026-10-17T09:00:00.000Z' }, '10.9.9.10')).statusCode).toBe(200);
  });

  it('counts only bookings made: taken times and invalid input do not use up the limit', async () => {
    expect((await book({}, '10.8.8.8')).statusCode).toBe(200);
    for (let i = 0; i < 6; i++) expect((await book({ phone: `+7999000004${i}` }, '10.8.8.8')).statusCode).toBe(409); // taken
    expect((await book({ phone: '+79990000049', startsAt: '2026-10-16T13:00:00.000Z' }, '10.8.8.8')).statusCode).toBe(200);
  });

  it('never books one person twice at the same time (a double submit for «any master»)', async () => {
    const [first, second] = await Promise.all([book({ masterId: null }), book({ masterId: null })]);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(409);
    expect(second.json().error.message).toBe('У вас уже есть запись на это время');
    expect((await t.api('GET', '/api/appointments?onlineState=awaiting_confirmation')).json().items).toHaveLength(1);
  });

  it('replays a booking retried with the same Idempotency-Key', async () => {
    const key = '3f9b7c1e-2a4d-4e8f-9b6a-1c2d3e4f5a6b';
    const body = { items: `${lobe.id}`, masterId: fatima.id, startsAt: FRIDAY_NOON, name: 'Анна', phone: '+79991234567' };
    const [first, raced] = await Promise.all([
      pub(t, 'POST', '', body, { idempotencyKey: key }),
      pub(t, 'POST', '', body, { idempotencyKey: key }),
    ]);
    expect(first.statusCode).toBe(200);
    expect(raced.statusCode).toBe(200);
    const again = await pub(t, 'POST', '', body, { idempotencyKey: key.toUpperCase() });
    expect(again.statusCode).toBe(200);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json()).toEqual(first.json());
    expect(raced.json()).toEqual(first.json());
    expect((await t.api('GET', '/api/appointments?onlineState=awaiting_confirmation')).json().items).toHaveLength(1);
    expect(t.gateway.textsTo(STAFF_CHAT).filter((m) => m.startsWith('🆕'))).toHaveLength(1);

    const changed = await pub(t, 'POST', '', { ...body, comment: 'другое' }, { idempotencyKey: key });
    expect(changed.statusCode).toBe(409);
    expect(changed.json().error.message).toBe('Повторный запрос отличается от исходного. Обновите экран и попробуйте снова.');
    expect((await pub(t, 'POST', '', body, { idempotencyKey: 'not-a-uuid' })).statusCode).toBe(400);
    // A failed request is not stored: the same key runs again once the time is free.
    const busyKey = '0e1d2c3b-4a59-4687-9a8b-7c6d5e4f3a2b';
    const taken = await pub(t, 'POST', '', { ...body, phone: '+79990000060' }, { idempotencyKey: busyKey });
    expect(taken.statusCode).toBe(409);
    await t.api('POST', `/api/appointments/${first.json().number}/online/reject`, {});
    expect((await pub(t, 'POST', '', { ...body, phone: '+79990000060' }, { idempotencyKey: busyKey })).statusCode).toBe(200);
  });

  it('is closed while staff have online booking off', async () => {
    await t.api('PUT', '/api/settings/studio', { onlineBooking: { enabled: false } });
    expect((await pub(t, 'GET', '/config')).json().enabled).toBe(false);
    for (const res of [await book(), await pub(t, 'GET', `/slots?date=2026-10-16&items=${lobe.id}`), await pub(t, 'GET', `/days?items=${lobe.id}`)]) {
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toEqual({ code: 'forbidden', message: 'Онлайн-запись временно недоступна' });
    }
  });

  it('lets the client cancel on the booking page until the start; staff are told', async () => {
    const booking = (await book()).json();
    const res = await pub(t, 'POST', `/b/${booking.token}/cancel`);
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('cancelled');
    const appointment = (await t.api('GET', `/api/appointments/${booking.number}`)).json();
    expect(appointment).toMatchObject({ status: 'cancelled', onlineState: null, notes: 'Отменена клиентом онлайн' });
    expect(t.gateway.textsTo(STAFF_CHAT).at(-1)).toBe(
      `❌ Клиент отменил онлайн-запись №${booking.number}: Анна, +79991234567, Мочка — 16 октября, 12:00, мастер Фатима`,
    );
    expect((await auditEntries(t, booking.number)).at(-1)).toMatchObject({ source: 'online', action: 'appointment.status' });
    expect((await pub(t, 'POST', `/b/${booking.token}/cancel`)).json().error.message).toBe('Запись уже отменена');
    expect((await t.api('GET', '/api/badges')).json().onlineAwaiting).toBe(0);

    const later = (await book({ phone: '+79990000050' })).json();
    vi.setSystemTime(Date.parse(FRIDAY_NOON) + 60_000);
    expect((await pub(t, 'POST', `/b/${later.token}/cancel`)).json().error.message).toBe('Запись уже началась — отменить её можно только через студию');
    expect((await pub(t, 'GET', '/b/not-a-real-token-at-all')).statusCode).toBe(404);
    expect((await pub(t, 'POST', '/b/x/cancel')).statusCode).toBe(404);
  });

  it('offers the booking as an .ics event', async () => {
    const booking = (await book()).json();
    const res = await pub(t, 'GET', `/b/${booking.token}/calendar.ics`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/calendar; charset=utf-8');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="mikan-studio-${booking.number}.ics"`);
    const lines = res.body.split('\r\n');
    expect(lines).toContain('BEGIN:VEVENT');
    expect(lines).toContain('DTSTART:20261016T090000Z');
    expect(lines).toContain('DTEND:20261016T093000Z');
    expect(lines).toContain('SUMMARY:Мочка — MIKAN STUDIO');
    expect(lines).toContain('STATUS:TENTATIVE');
    expect(lines).toContain(`UID:${booking.token}@mikan`);
  });

  it('keeps staff-made appointments out of online booking: channel app, no online state', async () => {
    const client = await make(t, '/api/clients', { name: 'Пётр', phone: '+79990000099' });
    const row = await make(t, '/api/appointments', { clientId: client.id, masterId: 1, services: [{ serviceId: lobe.id }], startsAt: FRIDAY_NOON });
    expect(row).toMatchObject({ channel: 'app', onlineState: null, holdUntil: null });
  });
});
