import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotSendError } from '../src/bot/gateway.js';
import { handleStaffCommand } from '../src/bot/onboarding.js';
import { GIFT_NOTES, isDue, sendDueRetention } from '../src/bot/retention.js';
import { issueStaffCode } from '../src/bot/staff.js';
import { bonusOperations, retentionSends } from '../src/db/schema.js';
import { claimRetentionSend, releaseRetentionSend } from '../src/domain/retention-audience.js';
import { DEFAULT_RETENTION } from '../src/domain/retention-settings.js';
import { blocked, createTestApp, type TestApp } from './helpers.js';
import { addClient, addVisit, DAY, FakeClock, monthsBefore, TZ } from './retention-fixtures.js';

/** «HH:MM» Moscow (UTC+3) on a date → instant. */
const msk = (date: string, time: string) => Date.parse(`${date}T${time}:00+03:00`);
const BIRTHDAY_GREETING = DEFAULT_RETENTION.birthday.text.replace('{name}', 'Анна');
const OPT_OUT = [{ text: '🔕 Не присылать новости', data: 'mo' }];
const STAFF_GROUP = -5001;

describe('birthday and win-back messages', () => {
  let t: TestApp;
  let clock: FakeClock;

  const run = (now: number) => {
    clock.t = now;
    return sendDueRetention(t.ctx, { now, clock });
  };
  const settings = async (body: Record<string, unknown>) => {
    const res = await t.api('PUT', '/api/settings/retention', body);
    expect(res.statusCode, res.body).toBe(200);
  };
  const sends = () => t.ctx.db.select().from(retentionSends).orderBy(retentionSends.id).all();
  const gifts = () => t.ctx.db.select().from(bonusOperations).orderBy(bonusOperations.id).all();

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(msk('2026-10-19', '08:00'));
    clock = new FakeClock(Date.now());
    t = await createTestApp();
  });
  afterEach(async () => {
    await t.close();
    vi.useRealTimers();
  });

  it('is due from sendAt for 6 hours of that studio day', () => {
    expect(isDue('10:00', msk('2026-10-19', '09:59'), TZ)).toBe(false);
    expect(isDue('10:00', msk('2026-10-19', '10:00'), TZ)).toBe(true);
    expect(isDue('10:00', msk('2026-10-19', '15:59'), TZ)).toBe(true);
    expect(isDue('10:00', msk('2026-10-19', '16:00'), TZ)).toBe(false);
    expect(isDue('21:00', msk('2026-10-20', '01:00'), TZ)).toBe(false);
  });

  it('a send is claimed once: a parallel run cannot log it again', async () => {
    const anna = await addClient(t, 'Анна', { chatId: 7001 });
    const candidate = { clientId: anna.id, name: 'Анна', chatId: 7001, periodKey: '2026' };
    expect(claimRetentionSend(t.ctx.db, 'birthday', candidate, Date.now())).toBe(true);
    expect(claimRetentionSend(t.ctx.db, 'birthday', candidate, Date.now())).toBe(false);
    expect(claimRetentionSend(t.ctx.db, 'winback', candidate, Date.now())).toBe(true);
    releaseRetentionSend(t.ctx.db, 'birthday', candidate);
    expect(sends().map((s) => s.kind)).toEqual(['winback']);
  });

  describe('birthday', () => {
    it('greets linked clients who accept news, once a year, with the gift lines and the gift bonuses', async () => {
      const anna = await addClient(t, 'Анна', { chatId: 7001, birthday: '1995-10-19' });
      await addClient(t, 'Борис', { chatId: 7002, birthday: '1990-10-20' });
      await addClient(t, 'Вера', { birthday: '1990-10-19' });
      await addClient(t, 'Глеб', { chatId: 7004, birthday: '1990-10-19', marketingOptOut: true });
      await addClient(t, 'Дина', { chatId: 7005, birthday: '1990-10-19', botEnabled: false });
      await addClient(t, 'Ева', { chatId: 7006, birthday: '1990-10-19', archived: true });

      expect(await run(msk('2026-10-19', '09:59'))).toEqual({ birthday: 0, winback: 0 });
      expect(await run(msk('2026-10-19', '10:00'))).toEqual({ birthday: 1, winback: 0 });
      const text = `${BIRTHDAY_GREETING}\n\n🎁 Дарим 500 бонусов — они действуют до 2 ноября\n💝 Скидка 10% до 26 октября`;
      expect(t.gateway.sent).toEqual([{ chatId: 7001, text, keyboard: [OPT_OUT], messageId: expect.any(Number) }]);
      const chat = (await t.api('GET', `/api/clients/${anna.id}/chat`)).json().chat;
      expect(chat.lastMessage).toMatchObject({ role: 'system', text });
      expect(sends().map((s) => [s.clientId, s.kind, s.periodKey])).toEqual([[anna.id, 'birthday', '2026']]);
      expect(gifts().map((g) => ({ ...g, id: 0, createdAt: 0 }))).toEqual([
        {
          id: 0,
          clientId: anna.id,
          type: 'gift',
          amount: 500,
          remaining: 500,
          expiresAt: msk('2026-11-03', '00:00'),
          saleId: null,
          note: GIFT_NOTES.birthday,
          employeeId: null,
          createdAt: 0,
        },
      ]);

      // Later that day and after a restart: nothing again.
      expect(await run(msk('2026-10-19', '10:01'))).toEqual({ birthday: 0, winback: 0 });
      expect(await run(msk('2026-10-19', '15:00'))).toEqual({ birthday: 0, winback: 0 });
      // Next year — again.
      expect((await run(msk('2027-10-19', '10:00'))).birthday).toBe(1);
      expect(sends().map((s) => s.periodKey)).toEqual(['2026', '2027']);
    });

    it('the gift lines follow the settings: no bonuses without loyalty, the discount on the day only', async () => {
      await addClient(t, 'Анна', { chatId: 7001, birthday: '1995-10-19' });
      await settings({ loyalty: { enabled: false }, birthday: { discountDaysAfter: 0, sendAt: '11:30' } });
      expect((await run(msk('2026-10-19', '10:00'))).birthday).toBe(0);
      expect((await run(msk('2026-10-19', '11:30'))).birthday).toBe(1);
      expect(t.gateway.sent[0]!.text).toBe(`${BIRTHDAY_GREETING}\n\n💝 Сегодня — скидка 10%`);
      expect(gifts()).toEqual([]);

      await addClient(t, 'Анна', { chatId: 7002, birthday: '2001-10-19' });
      await settings({ loyalty: { enabled: true }, birthday: { bonusAmount: 0, discountPercent: 0, text: 'С днём рождения, {name}!' } });
      await run(msk('2026-10-19', '11:31'));
      expect(t.gateway.sent[1]!.text).toBe('С днём рождения, Анна!');
      expect(gifts()).toEqual([]);

      await settings({ birthday: { enabled: false } });
      await addClient(t, 'Анна', { chatId: 7003, birthday: '2001-10-19' });
      expect((await run(msk('2026-10-19', '11:32'))).birthday).toBe(0);
    });

    it('29 February birthdays are greeted on 28 February in other years', async () => {
      await addClient(t, 'Анна', { chatId: 7001, birthday: '2000-02-29' });
      expect((await run(msk('2027-02-28', '10:00'))).birthday).toBe(1);
      expect((await run(msk('2028-02-28', '10:00'))).birthday).toBe(0);
      expect((await run(msk('2028-02-29', '10:00'))).birthday).toBe(1);
    });

    it('a failed delivery is tried again the next minute (4 tries); blocked is not; offline does nothing', async () => {
      const anna = await addClient(t, 'Анна', { chatId: 7001, birthday: '1995-10-19' });
      const boris = await addClient(t, 'Борис', { chatId: 7002, birthday: '1995-10-19' });
      t.gateway.running = false;
      expect(await run(msk('2026-10-19', '10:00'))).toEqual({ birthday: 0, winback: 0 });
      expect(sends()).toEqual([]);
      t.gateway.running = true;

      t.gateway.failures.push(new Error('Telegram недоступен'), blocked());
      expect((await run(msk('2026-10-19', '10:01'))).birthday).toBe(0);
      // Анна's log was freed for a retry, Борис blocked the bot: logged, never tried again.
      expect(sends().map((s) => s.clientId)).toEqual([boris.id]);
      expect(gifts()).toEqual([]);
      expect((await run(msk('2026-10-19', '10:02'))).birthday).toBe(1);
      expect(sends().map((s) => s.clientId)).toEqual([boris.id, anna.id]);
      expect(t.gateway.sent.map((m) => m.chatId)).toEqual([7001]);
      expect(gifts().map((g) => g.clientId)).toEqual([anna.id]);

      const vera = await addClient(t, 'Вера', { chatId: 7003, birthday: '1995-10-19' });
      for (let i = 0; i < 4; i++) t.gateway.failures.push(new Error('Telegram недоступен'));
      for (let minute = 3; minute < 8; minute++) await run(msk('2026-10-19', `10:0${minute}`));
      expect(t.gateway.textsTo(7003)).toEqual([]);
      expect(sends().map((s) => s.clientId)).toEqual([boris.id, anna.id, vera.id]);
    });
  });

  describe('delivery problems', () => {
    it('Telegram’s flood limit (429) holds the messages for the time it asks, without counting a try', async () => {
      await addClient(t, 'Анна', { chatId: 7001, birthday: '1995-10-19' });
      t.gateway.failures.push(new BotSendError('Telegram: Too Many Requests: retry after 5', false, 5_000));
      expect((await run(msk('2026-10-19', '10:00'))).birthday).toBe(0);
      expect(sends()).toEqual([]);
      expect((await run(msk('2026-10-19', '10:00') + 4_000)).birthday).toBe(0);
      expect((await run(msk('2026-10-19', '10:00') + 5_000)).birthday).toBe(1);
      expect(t.gateway.textsTo(7001)).toHaveLength(1);
    });

    it('a gift that could not be credited is reported to the staff chat', async () => {
      handleStaffCommand(t.ctx, STAFF_GROUP, issueStaffCode(t.ctx.db).code);
      const anna = await addClient(t, 'Анна', { chatId: 7001, birthday: '1995-10-19' });
      t.ctx.sqlite.exec('drop table bonus_operations');
      expect((await run(msk('2026-10-19', '10:00'))).birthday).toBe(1);
      expect(t.gateway.textsTo(STAFF_GROUP)).toEqual([
        `⚠️ Не удалось начислить 500 бонусов в подарок на день рождения клиенту «Анна» (карточка №${anna.id}) — начислите их вручную`,
      ]);
    });
  });

  describe('win-back', () => {
    const NOON = msk('2026-10-19', '12:00');

    it('longest absent first, at most dailyLimit a day, once per absence; a new visit starts a new one', async () => {
      await settings({ winback: { dailyLimit: 2 } });
      const ulya = await addClient(t, 'Уля', { chatId: 7001 });
      addVisit(t, ulya.id, { at: monthsBefore(NOON, 12) });
      const oleg = await addClient(t, 'Олег', { chatId: 7002 });
      addVisit(t, oleg.id, { at: monthsBefore(NOON, 14) });
      addVisit(t, oleg.id, { at: monthsBefore(NOON, 8) });
      const pavel = await addClient(t, 'Павел', { chatId: 7003 });
      addVisit(t, pavel.id, { at: monthsBefore(NOON, 7) });
      // Not now: a future appointment, a recent visit, opted out, only a cancelled visit, not linked.
      const rita = await addClient(t, 'Рита', { chatId: 7004 });
      addVisit(t, rita.id, { at: monthsBefore(NOON, 10) });
      addVisit(t, rita.id, { at: NOON + 3 * DAY, status: 'scheduled' });
      const sasha = await addClient(t, 'Саша', { chatId: 7005 });
      addVisit(t, sasha.id, { at: monthsBefore(NOON, 3) });
      const tanya = await addClient(t, 'Таня', { chatId: 7006, marketingOptOut: true });
      addVisit(t, tanya.id, { at: monthsBefore(NOON, 9) });
      const ivan = await addClient(t, 'Иван', { chatId: 7007 });
      addVisit(t, ivan.id, { at: monthsBefore(NOON, 9), status: 'cancelled' });
      const yana = await addClient(t, 'Яна');
      addVisit(t, yana.id, { at: monthsBefore(NOON, 9) });

      expect((await run(NOON - 60_000)).winback).toBe(0);
      expect((await run(NOON)).winback).toBe(2);
      const greeting = (name: string) => DEFAULT_RETENTION.winback.text.replace('{name}', name);
      expect(t.gateway.sent).toEqual([
        { chatId: 7001, text: greeting('Уля'), keyboard: [[{ text: '📅 Записаться', data: 'mb' }], OPT_OUT], messageId: expect.any(Number) },
        { chatId: 7002, text: greeting('Олег'), keyboard: [[{ text: '📅 Записаться', data: 'mb' }], OPT_OUT], messageId: expect.any(Number) },
      ]);
      expect(sends().map((s) => [s.clientId, s.kind, s.periodKey])).toEqual([
        [ulya.id, 'winback', '2025-10-19'],
        [oleg.id, 'winback', '2026-02-19'],
      ]);
      expect(gifts()).toEqual([]);

      // The day's limit is used up; the next day Павел, and nobody twice.
      expect((await run(NOON + 5 * 60_000)).winback).toBe(0);
      expect((await run(NOON + DAY)).winback).toBe(1);
      expect(t.gateway.sent.at(-1)!.chatId).toBe(7003);
      expect((await run(NOON + 2 * DAY)).winback).toBe(0);

      // Олег comes back and then stays away again: a new absence, a new message — after Рита (her appointment has
      // passed) and Саша, who have been away longer by then.
      addVisit(t, oleg.id, { at: NOON + 3 * DAY });
      const later = msk('2027-05-20', '12:00');
      expect((await run(later)).winback).toBe(2);
      expect(t.gateway.sent.slice(-2).map((m) => m.chatId)).toEqual([7004, 7005]);
      expect((await run(later + DAY)).winback).toBe(1);
      expect(t.gateway.sent.at(-1)!.chatId).toBe(7002);
      expect(sends().at(-1)).toMatchObject({ clientId: oleg.id, periodKey: '2026-10-22' });
    });

    it('offers the Mini App and gift bonuses when set; disabled → nothing', async () => {
      t.ctx.config.publicUrl = 'https://mikan.example';
      await t.api('PUT', '/api/settings/studio', { onlineBooking: { enabled: true } });
      await settings({ winback: { bonusAmount: 300, bonusDays: 30, text: '{name}, ждём вас снова!' } });
      const ulya = await addClient(t, 'Уля', { chatId: 7001 });
      addVisit(t, ulya.id, { at: monthsBefore(NOON, 12) });

      expect((await run(NOON)).winback).toBe(1);
      expect(t.gateway.sent).toEqual([
        {
          chatId: 7001,
          text: 'Уля, ждём вас снова!\n\n🎁 Дарим 300 бонусов — они действуют до 18 ноября',
          keyboard: [[{ text: '📅 Записаться', webApp: 'https://mikan.example/book' }], OPT_OUT],
          messageId: expect.any(Number),
        },
      ]);
      expect(gifts().map((g) => [g.clientId, g.type, g.amount, g.remaining, g.expiresAt, g.note])).toEqual([
        [ulya.id, 'gift', 300, 300, msk('2026-11-19', '00:00'), GIFT_NOTES.winback],
      ]);

      await settings({ winback: { enabled: false } });
      const oleg = await addClient(t, 'Олег', { chatId: 7002 });
      addVisit(t, oleg.id, { at: monthsBefore(NOON, 12) });
      expect((await run(NOON + DAY)).winback).toBe(0);
      expect(t.ctx.db.select().from(retentionSends).where(eq(retentionSends.clientId, oleg.id)).all()).toEqual([]);
    });
  });
});
