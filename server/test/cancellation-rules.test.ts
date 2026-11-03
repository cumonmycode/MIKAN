import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleStart } from '../src/bot/onboarding.js';
import { buildClientContext, buildStablePrompt } from '../src/bot/prompt.js';
import { processDueMessages } from '../src/bot/sender.js';
import { settings } from '../src/db/schema.js';
import { appointmentCancellation, cancellationPolicyText, closingRetain } from '../src/domain/cancellation.js';
import { getClientRow } from '../src/domain/refs.js';
import { DEFAULT_STUDIO, getStudioSettings, type CancellationRules } from '../src/domain/settings.js';
import { createTestApp, make, type TestApp } from './helpers.js';

const NOW = Date.parse('2026-10-15T09:00:00.000Z'); // Thu 12:00 Moscow
const STARTS = '2026-10-17T11:00:00.000Z'; // Sat 14:00 Moscow
const STARTS_MS = Date.parse(STARTS);
const FREE_UNTIL = '2026-10-16T11:00:00.000Z'; // 24 h before: Fri 14:00 Moscow
const HOUR = 3_600_000;
const CHAT = 740_001;

type Json = Record<string, any>;

const rules = (patch: Partial<CancellationRules> = {}): CancellationRules => ({ ...DEFAULT_STUDIO.cancellation, ...patch });

describe('cancellation rules: pure helpers', () => {
  it('words the rules for clients, naming shares below 100 %', () => {
    expect(cancellationPolicyText(rules())).toBe(
      'Бесплатно отменить или перенести запись можно не позднее чем за 24 часа; при более поздней отмене предоплата не ' +
        'возвращается, при неявке — тоже.',
    );
    expect(cancellationPolicyText(rules({ freeHours: 48, lateRetainPercent: 50 }))).toBe(
      'Бесплатно отменить или перенести запись можно не позднее чем за 48 часов; при более поздней отмене студия оставляет ' +
        'себе половину предоплаты, при неявке предоплата не возвращается.',
    );
    expect(cancellationPolicyText(rules({ freeHours: 0, lateRetainPercent: 30, noShowRetainPercent: 30 }))).toBe(
      'Бесплатной отмены нет: при отмене записи студия оставляет себе 30% предоплаты, при неявке — тоже.',
    );
    expect(cancellationPolicyText(rules({ freeHours: 21, noShowRetainPercent: 0 }))).toContain('за 21 час;');
    expect(cancellationPolicyText(rules({ freeHours: 21, noShowRetainPercent: 0 }))).toContain('при неявке предоплата возвращается');
    expect(cancellationPolicyText(rules({ freeHours: 72 }))).toContain('за 72 часа;');
    expect(cancellationPolicyText(rules({ freeHours: 12 }))).toContain('за 12 часов;');
  });

  it('counts from the held prepayment, else the required one; null without either', () => {
    const a = { startsAt: STARTS_MS, depositRequired: 2000 };
    expect(appointmentCancellation(a, 0, rules())).toEqual({ freeUntil: FREE_UNTIL, lateRetain: 2000, noShowRetain: 2000 });
    expect(appointmentCancellation(a, 1500, rules({ lateRetainPercent: 50, noShowRetainPercent: 33 }))).toEqual({
      freeUntil: FREE_UNTIL, lateRetain: 750, noShowRetain: 495,
    });
    expect(appointmentCancellation({ ...a, depositRequired: 0 }, 1001, rules({ freeHours: 0, lateRetainPercent: 50 }))).toEqual({
      freeUntil: null, lateRetain: 501, noShowRetain: 1001,
    });
    expect(appointmentCancellation({ ...a, depositRequired: 0 }, 0, rules())).toBeNull();
  });

  it('keeps a share on a late cancellation or a no-show, nothing on an early one', () => {
    const lateAt = STARTS_MS - 10 * HOUR;
    const earlyAt = STARTS_MS - 30 * HOUR;
    expect(closingRetain('cancelled', STARTS_MS, lateAt, 2000, rules())).toEqual({
      amount: 2000, reason: 'Поздняя отмена — меньше 24 ч до записи',
    });
    expect(closingRetain('cancelled', STARTS_MS, earlyAt, 2000, rules())).toBeNull();
    expect(closingRetain('cancelled', STARTS_MS, STARTS_MS - 24 * HOUR, 2000, rules())).toBeNull(); // the last free moment
    expect(closingRetain('cancelled', STARTS_MS, earlyAt, 2000, rules({ freeHours: 0 }))?.amount).toBe(2000);
    expect(closingRetain('no_show', STARTS_MS, earlyAt, 2000, rules({ noShowRetainPercent: 50 }))).toEqual({ amount: 1000, reason: 'Неявка' });
    expect(closingRetain('completed', STARTS_MS, lateAt, 2000, rules())).toBeNull();
  });
});

describe('cancellation rules: settings, appointments, auto retain, bot', () => {
  let t: TestApp;
  let tattoo: Json;
  let consult: Json;
  let client: Json;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    t = await createTestApp();
    tattoo = await make(t, '/api/services', { name: 'Тату среднее', category: 'tattoo', price: 8000, durationMin: 120, depositAmount: 2000 });
    consult = await make(t, '/api/services', { name: 'Консультация', category: 'other', price: 0, durationMin: 15 });
    client = await make(t, '/api/clients', { name: 'Иван Петров', phone: '+79991234567' });
  });
  afterEach(async () => {
    vi.useRealTimers();
    await t.close();
  });

  const putStudio = (body: Record<string, unknown>) => t.api('PUT', '/api/settings/studio', body);
  const setRules = async (patch: Partial<CancellationRules>) => {
    const res = await putStudio({ cancellation: patch });
    if (res.statusCode !== 200) throw new Error(res.body);
  };
  const book = (extra: object = {}) =>
    make(t, '/api/appointments', { clientId: client.id, masterId: 1, services: [{ serviceId: tattoo.id }], startsAt: STARTS, ...extra });
  const pay = async (id: number, amount = 2000) => {
    const res = await t.api('POST', `/api/appointments/${id}/deposit`, { amount, method: 'transfer' });
    if (res.statusCode !== 200) throw new Error(res.body);
  };
  const setStatus = async (id: number, status: string) => (await t.api('PATCH', `/api/appointments/${id}`, { status })).json() as Json;
  const retains = (a: Json) => (a.depositOperations as Json[]).filter((op) => op.type === 'retain');

  describe('settings', () => {
    it('saves the rules field by field; omitted = unchanged; settings saved before them read the defaults', async () => {
      expect((await putStudio({ cancellation: { freeHours: 48 } })).json().cancellation).toEqual({
        freeHours: 48, lateRetainPercent: 100, noShowRetainPercent: 100, autoRetain: false,
      });
      expect((await putStudio({ cancellation: { autoRetain: true, lateRetainPercent: 50, freeHours: null } })).json().cancellation).toEqual({
        freeHours: 48, lateRetainPercent: 50, noShowRetainPercent: 100, autoRetain: true,
      });
      expect((await putStudio({ name: 'MIKAN', cancellation: null })).json().cancellation).toMatchObject({ freeHours: 48, autoRetain: true });
      expect((await putStudio({ cancellation: { freeHours: 0, noShowRetainPercent: 0 } })).json().cancellation).toEqual({
        freeHours: 0, lateRetainPercent: 50, noShowRetainPercent: 0, autoRetain: true,
      });

      const legacy = JSON.stringify({ name: 'Старая', timezone: 'Europe/Moscow' });
      t.ctx.db.update(settings).set({ value: legacy }).where(eq(settings.key, 'studio')).run();
      expect((await t.api('GET', '/api/settings/studio')).json()).toMatchObject({
        name: 'Старая', cancellation: DEFAULT_STUDIO.cancellation, reviewLinks: { yandex: '', twogis: '', google: '' },
      });
    });

    it('rejects invalid rules with a field name', async () => {
      const cases: Array<[unknown, string]> = [
        [{ freeHours: 337 }, '«Бесплатная отмена, часов»: должно быть не больше 336'],
        [{ freeHours: -1 }, '«Бесплатная отмена, часов»: должно быть не меньше 0'],
        [{ freeHours: 1.5 }, '«Бесплатная отмена, часов»: должно быть целым числом'],
        [{ lateRetainPercent: 101 }, '«Удержание при поздней отмене, %»: должно быть не больше 100'],
        [{ noShowRetainPercent: -5 }, '«Удержание при неявке, %»: должно быть не меньше 0'],
        [{ autoRetain: 'да' }, '«Удерживать автоматически»: должно быть «да» или «нет»'],
        ['24', '«Отмена и предоплата»: должно быть объектом'],
      ];
      for (const [cancellation, message] of cases) {
        const res = await putStudio({ cancellation });
        expect(res.statusCode).toBe(400);
        expect(res.json().error.message).toBe(message);
      }
      expect(getStudioSettings(t.ctx.db).cancellation).toEqual(DEFAULT_STUDIO.cancellation);
    });

    it('stores review links: https only, ≤ 500 characters, "" or null clears, omitted = unchanged', async () => {
      const yandex = 'https://yandex.ru/maps/org/mikan/123/reviews/';
      expect((await putStudio({ reviewLinks: { yandex, twogis: ' https://2gis.ru/tomsk/firm/1 ' } })).json().reviewLinks).toEqual({
        yandex, twogis: 'https://2gis.ru/tomsk/firm/1', google: '',
      });
      expect((await putStudio({ name: 'MIKAN', reviewLinks: { google: 'https://g.page/r/abc/review' } })).json().reviewLinks).toEqual({
        yandex, twogis: 'https://2gis.ru/tomsk/firm/1', google: 'https://g.page/r/abc/review',
      });
      expect((await putStudio({ reviewLinks: { twogis: '', google: null } })).json().reviewLinks).toEqual({ yandex, twogis: '', google: '' });

      for (const bad of ['http://2gis.ru/x', 'javascript:alert(1)', '2gis.ru/tomsk', `https://x.ru/${'a'.repeat(490)}`]) {
        const res = await putStudio({ reviewLinks: { twogis: bad } });
        expect(res.statusCode).toBe(400);
        expect(res.json().error.message).toMatch(/^«2ГИС»: /);
      }
      expect(getStudioSettings(t.ctx.db).reviewLinks).toEqual({ yandex, twogis: '', google: '' });
    });
  });

  describe('Appointment.cancellation', () => {
    it('shows the rules for an appointment with a prepayment, required until it is paid, then held', async () => {
      const a = await book();
      expect(a.cancellation).toEqual({ freeUntil: FREE_UNTIL, lateRetain: 2000, noShowRetain: 2000 });
      await setRules({ lateRetainPercent: 50, noShowRetainPercent: 100 });
      await pay(a.id, 1500);
      const held = (await t.api('GET', `/api/appointments/${a.id}`)).json();
      expect(held.cancellation).toEqual({ freeUntil: FREE_UNTIL, lateRetain: 750, noShowRetain: 1500 });

      await setRules({ freeHours: 0 });
      const list = (await t.api('GET', '/api/appointments')).json().items as Json[];
      expect(list.find((x) => x.id === a.id).cancellation).toEqual({ freeUntil: null, lateRetain: 750, noShowRetain: 1500 });
    });

    it('is null without a prepayment', async () => {
      const a = await book({ services: [{ serviceId: consult.id }] });
      expect(a.depositRequired).toBe(0);
      expect(a.cancellation).toBeNull();
    });
  });

  describe('auto retain', () => {
    it('keeps the whole prepayment on a late cancellation, recorded by the employee who cancelled', async () => {
      await setRules({ autoRetain: true });
      const a = await book();
      await pay(a.id);
      vi.setSystemTime(STARTS_MS - 10 * HOUR);
      const cancelled = await setStatus(a.id, 'cancelled');
      expect(cancelled).toMatchObject({ status: 'cancelled', deposit: 0, depositStatus: 'retained' });
      expect(retains(cancelled)).toEqual([
        expect.objectContaining({ amount: 2000, method: null, note: 'Поздняя отмена — меньше 24 ч до записи', employee: expect.objectContaining({ id: 1 }) }),
      ]);
      // Back in the schedule and cancelled again: nothing is held, nothing more is kept.
      await setStatus(a.id, 'scheduled');
      expect(retains(await setStatus(a.id, 'cancelled'))).toHaveLength(1);
    });

    it('keeps a share on a no-show and leaves the remainder held for a refund', async () => {
      await setRules({ autoRetain: true, noShowRetainPercent: 50 });
      const a = await book();
      await pay(a.id);
      vi.setSystemTime(STARTS_MS + HOUR);
      const missed = await setStatus(a.id, 'no_show');
      expect(missed).toMatchObject({ deposit: 1000, depositStatus: 'paid' });
      expect(retains(missed)).toEqual([expect.objectContaining({ amount: 1000, note: 'Неявка' })]);
      // A later status change between «closed» statuses keeps nothing more.
      expect(retains(await setStatus(a.id, 'cancelled'))).toHaveLength(1);
      const refund = await t.api('POST', `/api/appointments/${a.id}/deposit/refund`, {});
      expect(refund.json()).toMatchObject({ deposit: 0, depositStatus: 'retained' });
    });

    it('keeps nothing on an early cancellation, with autoRetain off, at 0 % or without a prepayment', async () => {
      await setRules({ autoRetain: true });
      const early = await book();
      await pay(early.id);
      vi.setSystemTime(STARTS_MS - 30 * HOUR);
      expect(await setStatus(early.id, 'cancelled')).toMatchObject({ deposit: 2000, depositStatus: 'paid' });

      const unpaid = await book({ startsAt: '2026-10-17T15:00:00.000Z' });
      vi.setSystemTime(STARTS_MS - HOUR);
      expect(await setStatus(unpaid.id, 'no_show')).toMatchObject({ deposit: 0, depositOperations: [] });

      await setRules({ autoRetain: false });
      const manual = await book({ startsAt: '2026-10-18T11:00:00.000Z' });
      await pay(manual.id);
      expect(retains(await setStatus(manual.id, 'no_show'))).toEqual([]);

      await setRules({ autoRetain: true, lateRetainPercent: 0 });
      const free = await book({ startsAt: '2026-10-17T13:00:00.000Z' });
      await pay(free.id);
      expect(retains(await setStatus(free.id, 'cancelled'))).toEqual([]);
    });
  });

  describe('bot', () => {
    const linkTelegram = async () => {
      const url = (await t.api('POST', `/api/clients/${client.id}/telegram-link`)).json().url as string;
      handleStart(t.ctx, { chatId: CHAT, telegramName: 'Иван', username: 'ivanp' }, new URL(url).searchParams.get('start')!);
      t.gateway.sent = [];
    };

    it('tells the rules in the system prompt and the free-cancellation time of a paid booking', async () => {
      await linkTelegram();
      const prompt = buildStablePrompt(t.ctx.db);
      expect(prompt).toContain('## Отмена и предоплата');
      expect(prompt).toContain(
        '«Бесплатно отменить или перенести запись можно не позднее чем за 24 часа; при более поздней отмене предоплата не ' +
          'возвращается, при неявке — тоже.»',
      );
      expect(prompt).toContain('когда клиент записывается на услугу с предоплатой');

      const a = await book();
      const row = getClientRow(t.ctx.db, client.id);
      expect(buildClientContext(t.ctx.db, Date.now(), row, null)).not.toContain('бесплатно отменить');
      await pay(a.id);
      expect(buildClientContext(t.ctx.db, Date.now(), row, null)).toContain(
        'предоплата 2 000 ₽ внесена, бесплатно отменить можно до 16 октября, 14:00',
      );
      expect(buildClientContext(t.ctx.db, STARTS_MS - 2 * HOUR, row, null)).toContain('срок бесплатной отмены уже прошёл');

      await setRules({ freeHours: 48, lateRetainPercent: 50 });
      expect(buildStablePrompt(t.ctx.db)).toContain('за 48 часов; при более поздней отмене студия оставляет себе половину предоплаты');
    });

    it('adds the free-cancellation line to a reminder of a paid booking while it is still ahead', async () => {
      await t.api('PUT', '/api/settings/bot', { reminderOffsets: [2880, 120] });
      await linkTelegram();
      const paid = await book();
      await pay(paid.id);
      const unpaid = await book({ startsAt: '2026-10-17T15:00:00.000Z' });

      await processDueMessages(t.ctx, Date.parse('2026-10-15T11:00:00.000Z')); // 48 h before the paid one
      const [first] = t.gateway.textsTo(CHAT);
      expect(first).toContain('Когда: суббота, 17 октября в 14:00');
      expect(first).toContain('\n\nБесплатно отменить можно до 16 октября, 14:00\n\nПодтвердите, пожалуйста, визит');
      const sent = (await t.api('GET', '/api/bot/scheduled?status=sent')).json().items as Json[];
      expect(sent.find((m) => m.appointmentId === paid.id)!.text).toBe(first);

      // Nothing held → no line; the 2-hour reminder comes after the free-cancellation time.
      await processDueMessages(t.ctx, Date.parse('2026-10-15T15:00:00.000Z'));
      await processDueMessages(t.ctx, Date.parse('2026-10-17T09:00:00.000Z'));
      const later = t.gateway.textsTo(CHAT).slice(1);
      expect(later).toHaveLength(2);
      expect(later.every((text) => !text.includes('Бесплатно отменить'))).toBe(true);
      const unpaidReminder = (await t.api('GET', '/api/bot/scheduled?status=sent')).json().items.find((m: Json) => m.appointmentId === unpaid.id);
      expect(unpaidReminder.text).not.toContain('Бесплатно отменить');
    });
  });
});
