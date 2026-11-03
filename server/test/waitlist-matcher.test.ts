import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addedIntervals } from '../src/domain/waitlist-hooks.js';
import { offerFreedTime, MAX_TOLD_PER_PIECE } from '../src/domain/waitlist-matcher.js';
import { freedTimeMessage } from '../src/domain/waitlist-messages.js';
import { queuedFreedTime } from '../src/domain/waitlist-store.js';
import { make, type TestApp } from './helpers.js';
import { BOT_TOKEN, initData, linkChat, NOW, pub, PUBLIC_URL, STAFF_CHAT, type Json } from './online-booking-fixtures.js';
import { addEntry, ANNA_CHAT, linkedClient, msk, waitlistWorld } from './waitlist-fixtures.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const FRIDAY = '2026-10-16';

describe('waitlist: freed time', () => {
  let t: TestApp;
  let lobe: Json;
  let tattoo: Json;
  let fatima: Json;
  let anna: Json;
  let boris: Json;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    ({ t, lobe, tattoo, fatima, anna } = await waitlistWorld({ PUBLIC_URL, TELEGRAM_BOT_TOKEN: BOT_TOKEN }));
    await linkChat(t, anna.id, ANNA_CHAT);
    t.gateway.sent = [];
    boris = await make(t, '/api/clients', { name: 'Борис', phone: '+79990000002' });
  });
  afterEach(async () => {
    vi.useRealTimers();
    await t.close();
  });

  /** Boris's appointment with Fatima from `local` («2026-10-16T15:00») for `hours`. */
  const busy = async (local: string, hours = 1, masterId = fatima.id): Promise<Json> => {
    const startsAt = msk(local);
    return make(t, '/api/appointments', {
      clientId: boris.id,
      masterId,
      services: [{ serviceId: lobe.id }],
      startsAt,
      endsAt: new Date(Date.parse(startsAt) + hours * HOUR).toISOString(),
    });
  };
  const cancel = (a: Json) => t.api('PATCH', `/api/appointments/${a.id}`, { status: 'cancelled' });
  const wish = async (clientId: number, overrides: Record<string, unknown> = {}): Promise<Json> => {
    const res = await addEntry(t, { clientId, items: [{ serviceId: lobe.id }], dateFrom: FRIDAY, dateTo: '2026-10-18', ...overrides });
    expect(res.statusCode).toBe(200);
    return res.json();
  };
  const entry = async (id: number): Promise<Json> =>
    ((await t.api('GET', '/api/waitlist')).json().items as Json[]).find((e) => e.id === id)!;
  const bookingUrl = (id: number, start: string, items: string, master?: number) => {
    const query = new URLSearchParams({ wait: String(id), start, items });
    if (master !== undefined) query.set('master', String(master));
    return `${PUBLIC_URL}/book?${query.toString()}`;
  };

  it('tells the oldest fitting entry when an appointment is cancelled, with the button opening the booking flow', async () => {
    const taken = await busy(`${FRIDAY}T15:00`);
    const annas = await wish(anna.id);
    await cancel(taken);
    expect(queuedFreedTime(t.ctx.db)).toEqual([
      { masterId: fatima.id, date: FRIDAY, start: Date.parse(msk(`${FRIDAY}T15:00`)), end: Date.parse(msk(`${FRIDAY}T16:00`)) },
    ]);

    expect(await offerFreedTime(t.ctx)).toBe(1);
    const start = msk(`${FRIDAY}T15:00`);
    expect(t.gateway.sent).toEqual([
      {
        chatId: ANNA_CHAT,
        messageId: expect.any(Number),
        text:
          'Освободилось время: 16 октября, 15:00 у Фатимы — записаться?\n' +
          'Мочка — вы в листе ожидания. Время достанется тому, кто запишется первым.',
        keyboard: [[{ text: '📅 Записаться', webApp: bookingUrl(annas.id, start, String(lobe.id)) }]],
      },
    ]);
    expect(await entry(annas.id)).toMatchObject({ status: 'notified', notifiedAt: new Date(NOW).toISOString() });
    expect(queuedFreedTime(t.ctx.db)).toEqual([]);
    const log = (await t.api('GET', `/api/audit?entity=waitlist&entityId=${annas.id}`)).json().items as Json[];
    expect(log[0]).toMatchObject({
      source: 'system',
      action: 'waitlist.notify',
      summary: `Лист ожидания №${annas.id} (Анна Иванова): клиенту написали о свободном времени — 16 октября, 15:00, мастер Фатима`,
    });
    // The client books from the button (the Mini App of the linked chat): the entry is closed.
    const booked = await pub(t, 'POST', '', { items: [{ serviceId: lobe.id }], startsAt: start }, { initData: initData({ id: ANNA_CHAT }) });
    expect(booked.statusCode).toBe(200);
    expect(await entry(annas.id)).toMatchObject({ status: 'booked', appointmentId: booked.json().number });
  });

  it(`tells at most ${MAX_TOLD_PER_PIECE} entries per freed piece, oldest first`, async () => {
    const taken = await busy(`${FRIDAY}T15:00`);
    const entries: Json[] = [];
    for (const [i, name] of ['Вера', 'Галя', 'Дина', 'Елена'].entries()) {
      vi.setSystemTime(NOW + i * MIN);
      const client = await linkedClient(t, name, `+7999000001${i}`, 900_000 + i);
      entries.push(await wish(client.id, { masterId: fatima.id }));
    }
    await cancel(taken);
    expect(await offerFreedTime(t.ctx)).toBe(3);
    expect(t.gateway.sent.map((s) => s.chatId)).toEqual([900_000, 900_001, 900_002]);
    expect((await entry(entries[3]!.id)).status).toBe('waiting');
  });

  it('tells an entry at most once a day', async () => {
    const first = await busy(`${FRIDAY}T15:00`);
    const second = await busy(`${FRIDAY}T17:00`);
    const annas = await wish(anna.id);
    vi.setSystemTime(NOW + MIN);
    const clara = await linkedClient(t, 'Клара', '+79990000003', 900_100);
    const claras = await wish(clara.id);

    await cancel(first);
    expect(await offerFreedTime(t.ctx)).toBe(2);
    t.gateway.sent = [];
    await cancel(second);
    expect(await offerFreedTime(t.ctx)).toBe(0);
    expect(t.gateway.sent).toEqual([]);

    // A day later both may be told again (and stay open: whoever books first gets the time).
    const third = await busy('2026-10-17T15:00');
    vi.setSystemTime(NOW + 24 * HOUR + 2 * MIN);
    await cancel(third);
    expect(await offerFreedTime(t.ctx)).toBe(2);
    expect(t.gateway.sent.map((s) => [s.chatId, s.text.split('\n')[0]])).toEqual([
      [ANNA_CHAT, 'Освободилось время: 17 октября, 15:00 у Фатимы — записаться?'],
      [900_100, 'Освободилось время: 17 октября, 15:00 у Фатимы — записаться?'],
    ]);
    expect(await entry(annas.id)).toMatchObject({ status: 'notified', notifiedAt: new Date(NOW + 24 * HOUR + 2 * MIN).toISOString() });
    expect((await entry(claras.id)).status).toBe('notified');
  });

  it('tells only clients with a linked Telegram chat who take bot messages', async () => {
    const taken = await busy(`${FRIDAY}T15:00`);
    await wish(boris.id); // no chat
    const off = await linkedClient(t, 'Дина', '+79990000004', 900_200);
    await t.api('PATCH', `/api/clients/${off.id}`, { botEnabled: false });
    await wish(off.id);
    const annas = await wish(anna.id);
    await cancel(taken);
    expect(await offerFreedTime(t.ctx)).toBe(1);
    expect(t.gateway.sent.map((s) => s.chatId)).toEqual([ANNA_CHAT]);
    expect((await entry(annas.id)).status).toBe('notified');
  });

  it('offers only the freed master’s time that fits the wished services', async () => {
    await busy(`${FRIDAY}T14:00`);
    const freed = await busy(`${FRIDAY}T15:00`);
    await busy(`${FRIDAY}T16:00`);
    const vera = await linkedClient(t, 'Вера', '+79990000005', 900_300);
    const gala = await linkedClient(t, 'Галя', '+79990000006', 900_301);
    await wish(vera.id, { masterId: 1 }); // the admin, not Fatima
    await wish(gala.id, { items: [{ serviceId: tattoo.id }] }); // 3 hours do not fit the freed hour
    const annas = await wish(anna.id);
    await cancel(freed);
    expect(await offerFreedTime(t.ctx)).toBe(1);
    expect(t.gateway.sent.map((s) => s.chatId)).toEqual([ANNA_CHAT]);
    expect((await entry(annas.id)).status).toBe('notified');
  });

  it('a move frees the old time; an online booking rejected by staff frees its time', async () => {
    const moved = await busy(`${FRIDAY}T15:00`);
    const annas = await wish(anna.id, { dateTo: FRIDAY });
    await t.api('PATCH', `/api/appointments/${moved.id}`, { startsAt: msk('2026-10-19T15:00') });
    expect(queuedFreedTime(t.ctx.db)).toHaveLength(1);
    expect(await offerFreedTime(t.ctx)).toBe(1);
    expect(t.gateway.sent[0]!.text).toContain('16 октября, 15:00 у Фатимы');
    await t.api('PATCH', `/api/waitlist/${annas.id}`, { status: 'cancelled' });

    const clara = await linkedClient(t, 'Клара', '+79990000003', 900_100);
    await wish(clara.id, { dateTo: FRIDAY });
    const online = await pub(t, 'POST', '', {
      items: [{ serviceId: lobe.id }],
      masterId: fatima.id,
      startsAt: msk(`${FRIDAY}T18:00`),
      name: 'Олег',
      phone: '+79990000009',
    });
    t.gateway.sent = [];
    await t.api('POST', `/api/appointments/${online.json().number}/online/reject`, { reason: 'Мастер заболел' });
    expect(queuedFreedTime(t.ctx.db)).toEqual([
      { masterId: fatima.id, date: FRIDAY, start: Date.parse(msk(`${FRIDAY}T18:00`)), end: Date.parse(msk(`${FRIDAY}T18:30`)) },
    ]);
    expect(await offerFreedTime(t.ctx)).toBe(1);
    expect(t.gateway.textsTo(900_100)[0]).toContain('16 октября, 18:00 у Фатимы');
  });

  it('queues nothing without a waiting entry for that date and master, and never offers past time', async () => {
    const lonely = await busy(`${FRIDAY}T15:00`);
    await cancel(lonely);
    expect(queuedFreedTime(t.ctx.db)).toEqual([]);
    await wish(anna.id, { masterId: 1 });
    const fatimas = await busy(`${FRIDAY}T16:00`);
    await cancel(fatimas);
    expect(queuedFreedTime(t.ctx.db)).toEqual([]);

    // A no-show marked during the appointment: only its rest is freed, too soon to book online.
    await wish(anna.id, { masterId: fatima.id });
    const missed = await busy(`${FRIDAY}T17:00`);
    vi.setSystemTime(Date.parse(msk(`${FRIDAY}T17:20`)));
    await t.api('PATCH', `/api/appointments/${missed.id}`, { status: 'no_show' });
    expect(queuedFreedTime(t.ctx.db)).toEqual([
      { masterId: fatima.id, date: FRIDAY, start: Date.parse(msk(`${FRIDAY}T17:20`)), end: Date.parse(msk(`${FRIDAY}T18:00`)) },
    ]);
    expect(await offerFreedTime(t.ctx)).toBe(0);
    expect(t.gateway.sent).toEqual([]);
  });

  it('keeps the queue while the bot is stopped and drops it while online booking is off', async () => {
    const taken = await busy(`${FRIDAY}T15:00`);
    await wish(anna.id);
    await cancel(taken);
    t.gateway.running = false;
    expect(await offerFreedTime(t.ctx)).toBe(0);
    expect(queuedFreedTime(t.ctx.db)).toHaveLength(1);
    t.gateway.running = true;
    await t.api('PUT', '/api/settings/studio', { onlineBooking: { enabled: false } });
    expect(await offerFreedTime(t.ctx)).toBe(0);
    expect(queuedFreedTime(t.ctx.db)).toEqual([]);
    expect(t.gateway.sent).toEqual([]);
  });

  it('offers working time a schedule change adds', async () => {
    const weekly = Array.from({ length: 7 }, () => ({ start: '11:00', end: '15:00', breaks: [] }));
    expect((await t.api('PUT', `/api/employees/${fatima.id}/schedule`, { weekly })).statusCode).toBe(200);
    await busy(`${FRIDAY}T11:00`, 4); // Friday is full
    const annas = await wish(anna.id, { masterId: fatima.id });

    // A day off removes time: nothing to offer.
    await t.api('PUT', `/api/employees/${fatima.id}/schedule/days`, { from: '2026-10-17', off: true });
    expect(queuedFreedTime(t.ctx.db)).toEqual([]);

    await t.api('PUT', `/api/employees/${fatima.id}/schedule/days`, { from: FRIDAY, start: '11:00', end: '21:00' });
    expect(queuedFreedTime(t.ctx.db)).toEqual([
      { masterId: fatima.id, date: FRIDAY, start: Date.parse(msk(`${FRIDAY}T15:00`)), end: Date.parse(msk(`${FRIDAY}T21:00`)) },
    ]);
    // Removing the day off gives Saturday its weekly hours back.
    await t.api('DELETE', `/api/employees/${fatima.id}/schedule/days?from=2026-10-17`);
    expect(queuedFreedTime(t.ctx.db).map((p) => p.date)).toEqual([FRIDAY, '2026-10-17']);

    expect(await offerFreedTime(t.ctx)).toBe(1);
    expect(t.gateway.textsTo(ANNA_CHAT)[0]).toContain('16 октября, 15:00 у Фатимы');
    expect((await entry(annas.id)).status).toBe('notified');
    // A weekly change with longer hours is found too — on the dates without an exception of their own.
    await t.api('PUT', `/api/employees/${fatima.id}/schedule`, { weekly: weekly.map(() => ({ start: '10:00', end: '15:00', breaks: [] })) });
    expect(queuedFreedTime(t.ctx.db).map((p) => [p.date, new Date(p.start).toISOString(), new Date(p.end).toISOString()])).toEqual([
      ['2026-10-17', msk('2026-10-17T10:00'), msk('2026-10-17T11:00')],
      ['2026-10-18', msk('2026-10-18T10:00'), msk('2026-10-18T11:00')],
    ]);
  });

  it('finds working time a change adds', () => {
    const at = (h: number) => h * HOUR;
    expect(addedIntervals([{ start: at(11), end: at(21) }], [{ start: at(11), end: at(15) }])).toEqual([{ start: at(15), end: at(21) }]);
    expect(addedIntervals([{ start: at(10), end: at(20) }], [{ start: at(11), end: at(14) }, { start: at(15), end: at(19) }])).toEqual([
      { start: at(10), end: at(11) },
      { start: at(14), end: at(15) },
      { start: at(19), end: at(20) },
    ]);
    expect(addedIntervals([{ start: at(11), end: at(15) }], [{ start: at(10), end: at(21) }])).toEqual([]);
    expect(addedIntervals([{ start: at(11), end: at(15) }], [])).toEqual([{ start: at(11), end: at(15) }]);
  });
});

describe('waitlist: the freed-time message', () => {
  let t: TestApp;
  let fatima: Json;
  let anna: Json;
  let lobe: Json;
  let nipple: Json;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    ({ t, fatima, anna, lobe, nipple } = await waitlistWorld());
  });
  afterEach(async () => {
    vi.useRealTimers();
    await t.close();
  });

  it('opens the Mini App over https, a plain link otherwise and has no button without PUBLIC_URL', async () => {
    const created = (
      await addEntry(t, {
        clientId: anna.id,
        items: [{ serviceId: lobe.id }, { serviceId: nipple.id, variant: 'Два' }],
        masterId: fatima.id,
        dateFrom: FRIDAY,
        dateTo: FRIDAY,
      })
    ).json();
    const row = { ...created, items: JSON.stringify([{ serviceId: lobe.id }, { serviceId: nipple.id, variant: 'Два' }]), masterId: fatima.id, clientId: anna.id } as never;
    const master = { id: fatima.id, name: 'Фатима' } as never;
    const start = Date.parse(msk(`${FRIDAY}T15:00`));
    const items = `${lobe.id},${nipple.id}:%D0%94%D0%B2%D0%B0`;
    const query = new URLSearchParams({ wait: String(created.id), start: new Date(start).toISOString(), items, master: String(fatima.id) });
    const https = freedTimeMessage(t.ctx.db, { publicUrl: PUBLIC_URL }, row, master, start);
    expect(https).toEqual({
      text:
        'Освободилось время: 16 октября, 15:00 у Фатимы — записаться?\n' +
        'Мочка, Соски — Два — вы в листе ожидания. Время достанется тому, кто запишется первым.',
      keyboard: [[{ text: '📅 Записаться', webApp: `${PUBLIC_URL}/book?${query.toString()}` }]],
    });
    expect(freedTimeMessage(t.ctx.db, { publicUrl: 'http://localhost:3000/' }, row, master, start).keyboard).toEqual([
      [{ text: '📅 Записаться', url: `http://localhost:3000/book?${query.toString()}` }],
    ]);
    expect(freedTimeMessage(t.ctx.db, { publicUrl: null }, row, master, start).keyboard).toBeUndefined();
    // A name that cannot be declined safely.
    const latin = freedTimeMessage(t.ctx.db, { publicUrl: null }, row, { id: 9, name: 'Anna Smith' } as never, start);
    expect(latin.text.split('\n')[0]).toBe('Освободилось время: 16 октября, 15:00, мастер Anna Smith — записаться?');
    expect(t.gateway.textsTo(STAFF_CHAT)).toEqual([]);
  });
});
