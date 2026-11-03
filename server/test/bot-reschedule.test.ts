import type Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rescheduleForClient } from '../src/bot/client-appointments.js';
import { handleStaffCommand, handleStart } from '../src/bot/onboarding.js';
import { BotPipeline } from '../src/bot/pipeline.js';
import { issueStaffCode } from '../src/bot/staff.js';
import { freeSlots } from '../src/domain/free-slots.js';
import { createTestApp, make, message, ScriptedAi, text, toolUse, type TestApp } from './helpers.js';

const NOW = Date.parse('2026-10-15T09:00:00.000Z'); // Thu 12:00 Moscow
const CHAT = 720_001;
const STAFF = -720;
const from = { chatId: CHAT, telegramName: 'Иван', username: 'ivanp' };
const MIN = 60_000;

const hhmm = (ms: number, tz = 'Europe/Moscow') =>
  new Intl.DateTimeFormat('ru-RU', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(ms);

describe('bot: free slots and rescheduling', () => {
  let t: TestApp;
  let ai: ScriptedAi;
  let pipeline: BotPipeline;
  let client: { id: number };
  let other: { id: number };
  let boris: { id: number };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    ai = new ScriptedAi();
    t = await createTestApp({ ai });
    pipeline = new BotPipeline(t.ctx, 0);
    handleStaffCommand(t.ctx, STAFF, issueStaffCode(t.ctx.db).code);
    client = await make(t, '/api/clients', { name: 'Иван', lastName: 'Петров', phone: '+79991234567' });
    other = await make(t, '/api/clients', { name: 'Пётр', phone: '+79990000104' });
    boris = await make(t, '/api/employees', { name: 'Борис', login: 'boris', password: 'secret123', isMaster: true });
    const url = (await t.api('POST', `/api/clients/${client.id}/telegram-link`)).json().url as string;
    handleStart(t.ctx, from, new URL(url).searchParams.get('start')!);
  });
  afterEach(async () => {
    await t.close();
    vi.useRealTimers();
  });

  const book = (clientId: number, startsAt: string, endsAt: string, masterId = 1) =>
    make(t, '/api/appointments', { clientId, masterId, startsAt, endsAt, title: 'Хеликс' });
  const toolResults = (call: number) => (ai.calls[call]!.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[]).map((r) => ({ content: String(r.content), isError: r.is_error }));
  const say = async (textValue: string) => {
    pipeline.receive(from, textValue);
    await pipeline.idle();
  };

  it('offers starts inside the working hours of the studio day, every 30 minutes, around busy time', async () => {
    const slots = (date: string, opts: { durationMin?: number; masterId?: number; excludeAppointmentId?: number } = {}) =>
      freeSlots(t.ctx.db, { date, durationMin: opts.durationMin ?? 60, masterId: opts.masterId ?? 1, excludeAppointmentId: opts.excludeAppointmentId });
    const friday = slots('2026-10-16')[0]!.starts;
    expect(friday).toHaveLength(19); // 11:00 … 20:00 (the last ends at 21:00)
    expect(friday[0]).toBe(Date.parse('2026-10-16T08:00:00Z'));
    expect(hhmm(friday.at(-1)!)).toBe('20:00');
    expect(friday[1]! - friday[0]!).toBe(30 * MIN);

    // Busy 13:00–14:30 Moscow: 12:30, 13:00, 13:30 and 14:00 are taken, 12:00 and 14:30 touch it and stay free.
    const busy = await book(other.id, '2026-10-16T10:00:00Z', '2026-10-16T11:30:00Z');
    await book(other.id, '2026-10-16T14:00:00Z', '2026-10-16T15:00:00Z', boris.id); // another master
    const cancelled = await book(other.id, '2026-10-16T15:00:00Z', '2026-10-16T16:00:00Z');
    await t.api('PATCH', `/api/appointments/${cancelled.id}`, { status: 'cancelled' });
    const around = slots('2026-10-16').flatMap((m) => m.starts.map((s) => hhmm(s)));
    expect(around).toContain('12:00');
    expect(around).toContain('14:30');
    expect(around).toContain('18:00'); // the cancelled appointment does not block
    for (const taken of ['12:30', '13:00', '13:30', '14:00']) expect(around).not.toContain(taken);
    expect(slots('2026-10-16', { excludeAppointmentId: busy.id })[0]!.starts).toHaveLength(19);

    // Both masters without a masterId; today starts `onlineBooking.leadMinutes` (2 h) from now (12:00 → 14:00).
    const today = freeSlots(t.ctx.db, { date: '2026-10-15', durationMin: 30 });
    expect(today.map((m) => m.master.name).sort()).toEqual(['Админ', 'Борис']);
    expect(hhmm(today[0]!.starts[0]!)).toBe('14:00');

    // Another timezone and working hours move the window.
    await t.api('PUT', '/api/settings/studio', { timezone: 'Asia/Novosibirsk', workdayStart: '10:00', workdayEnd: '12:00' });
    const nsk = slots('2026-10-20')[0]!.starts;
    expect(nsk.map((s) => hhmm(s, 'Asia/Novosibirsk'))).toEqual(['10:00', '10:30', '11:00']);
    expect(nsk[0]).toBe(Date.parse('2026-10-20T03:00:00Z'));
  });

  it('my_appointments and free_slots show the client only their own future appointments and the free time', async () => {
    const mine = await book(client.id, '2026-10-17T11:00:00Z', '2026-10-17T12:00:00Z');
    const theirs = await book(other.id, '2026-10-18T09:00:00Z', '2026-10-18T10:00:00Z');
    ai.push(
      message([
        toolUse('a', 'my_appointments', {}),
        toolUse('b', 'free_slots', { date: '2026-10-18', appointmentId: mine.id }),
        toolUse('c', 'free_slots', { date: '2026-10-18', appointmentId: theirs.id }),
        toolUse('d', 'free_slots', { date: '2026-10-01' }),
      ], 'tool_use'),
      message([text('На воскресенье есть 13:00 и 15:00.')]),
    );
    await say('Хочу перенести запись на воскресенье');
    const [list, free, foreign, past] = toolResults(1);
    expect(list!.content).toBe(`Предстоящие записи клиента:\n№${mine.id} · суббота, 17 октября в 14:00–15:00 · Хеликс · мастер Админ · ожидает подтверждения`);
    expect(free!.content).toContain(`для переноса записи №${mine.id}: длительность 60 мин, тот же мастер`);
    expect(free!.content).toContain('• Админ [id 1]: 11:00, 13:00, 13:30'); // 11:30–12:30 would overlap Пётр at 12:00
    expect(free!.content).not.toContain('Борис');
    expect(free!.content).toContain('«2026-10-18 11:00»');
    expect(foreign).toEqual({ content: `Запись №${theirs.id} не найдена среди записей этого клиента.`, isError: true });
    expect(past!.isError).toBe(true);
    expect(JSON.stringify(ai.calls[0]!.system)).toContain('сегодня 2026-10-15');
  });

  it('reschedules only its own active appointment, conflict-checked, notifies staff and re-syncs reminders', async () => {
    const mine = await book(client.id, '2026-10-17T11:00:00Z', '2026-10-17T12:00:00Z');
    const theirs = await book(other.id, '2026-10-18T09:00:00Z', '2026-10-18T10:00:00Z');
    const pending = async () =>
      (await t.api('GET', '/api/bot/scheduled?status=pending')).json().items.filter((m: { appointmentId: number }) => m.appointmentId === mine.id);
    expect((await pending()).map((m: { sendAt: string }) => m.sendAt)).toEqual(['2026-10-16T11:00:00.000Z']);

    ai.push(
      message([
        toolUse('a', 'reschedule_appointment', { appointmentId: mine.id, startsAt: '2026-10-18 12:00' }), // busy (Пётр)
        toolUse('b', 'reschedule_appointment', { appointmentId: theirs.id, startsAt: '2026-10-19 12:00' }), // not theirs
        toolUse('c', 'reschedule_appointment', { appointmentId: mine.id, startsAt: '2026-10-18 21:00' }), // after hours
        toolUse('d', 'reschedule_appointment', { appointmentId: mine.id, startsAt: 'в воскресенье в 15' }),
      ], 'tool_use'),
      message([text('Это время занято, давайте выберем другое.')]),
    );
    await say('Перенесите на воскресенье в 12');
    const refused = toolResults(1);
    expect(refused.every((r) => r.isError)).toBe(true);
    expect(refused[0]!.content).toContain('уже занято');
    expect(refused[1]!.content).toContain('не найдена среди записей этого клиента');
    expect(refused[2]!.content).toContain('вне часов работы');
    expect(refused[3]!.content).toContain('не распознано');
    expect((await t.api('GET', `/api/appointments/${theirs.id}`)).json().startsAt).toBe('2026-10-18T09:00:00.000Z');

    ai.push(message([toolUse('e', 'reschedule_appointment', { appointmentId: mine.id, startsAt: '2026-10-18 15:00' })], 'tool_use'), message([]));
    await say('Давайте в 15:00');
    expect(toolResults(3)[0]).toEqual({ content: `Запись №${mine.id} перенесена на воскресенье, 18 октября в 15:00. Напоминания обновлены.`, isError: false });
    expect(t.gateway.textsTo(CHAT).at(-1)).toBe('Готово! Запись перенесена — напоминание придёт заранее 🙌');
    const moved = (await t.api('GET', `/api/appointments/${mine.id}`)).json();
    expect(moved).toMatchObject({ startsAt: '2026-10-18T12:00:00.000Z', endsAt: '2026-10-18T13:00:00.000Z', master: { id: 1 } });
    expect((await pending()).map((m: { sendAt: string }) => m.sendAt)).toEqual(['2026-10-17T12:00:00.000Z']);
    expect(t.gateway.textsTo(STAFF).at(-1)).toBe(
      `🔁 Клиент Иван Петров перенёс запись №${mine.id} через бота\nБыло: суббота, 17 октября в 14:00\nСтало: воскресенье, 18 октября в 15:00–16:00\nХеликс · мастер Админ`,
    );

    // A cancelled appointment cannot be moved; the app test mode writes nothing.
    await t.api('PATCH', `/api/appointments/${mine.id}`, { status: 'cancelled' });
    expect(await rescheduleForClient(t.ctx, { clientId: client.id, appointmentId: mine.id, startsAt: Date.parse('2026-10-19T09:00:00Z') })).toMatchObject({ ok: false });
    const fresh = await book(client.id, '2026-10-20T09:00:00Z', '2026-10-20T10:00:00Z');
    const dry = await rescheduleForClient(t.ctx, { clientId: client.id, appointmentId: fresh.id, startsAt: Date.parse('2026-10-21T09:00:00Z'), dryRun: true });
    expect(dry).toMatchObject({ ok: true, text: expect.stringContaining('Тестовый режим') });
    expect((await t.api('GET', `/api/appointments/${fresh.id}`)).json().startsAt).toBe('2026-10-20T09:00:00.000Z');
  });

  it('an old chat merely attributed to the client (re-linked elsewhere) sees and moves nothing', async () => {
    const mine = await book(client.id, '2026-10-17T11:00:00Z', '2026-10-17T12:00:00Z');
    const url = (await t.api('POST', `/api/clients/${client.id}/telegram-link`)).json().url as string;
    handleStart(t.ctx, { chatId: CHAT + 9, telegramName: 'Иван', username: null }, new URL(url).searchParams.get('start')!);
    ai.push(
      message([toolUse('a', 'my_appointments', {}), toolUse('b', 'reschedule_appointment', { appointmentId: mine.id, startsAt: '2026-10-18 15:00' })], 'tool_use'),
      message([text('Поделитесь номером, пожалуйста.')]),
    );
    await say('Когда моя запись?'); // the old chat CHAT still has clientId, but the client is linked to CHAT + 9 now
    expect(toolResults(1).every((r) => r.content.startsWith('Клиент не идентифицирован'))).toBe(true);
    expect((await t.api('GET', `/api/appointments/${mine.id}`)).json().startsAt).toBe('2026-10-17T11:00:00.000Z');
  });

  it('asks an unidentified chat to share the phone before showing appointments', async () => {
    const stranger = { chatId: CHAT + 1, telegramName: 'Гость', username: null };
    ai.push(message([toolUse('a', 'my_appointments', {}), toolUse('b', 'reschedule_appointment', { appointmentId: 1, startsAt: '2026-10-18 15:00' })], 'tool_use'), message([text('Поделитесь номером, пожалуйста.')]));
    pipeline.receive(stranger, 'Когда моя запись?');
    await pipeline.idle();
    const results = toolResults(1);
    expect(results.every((r) => r.content.startsWith('Клиент не идентифицирован'))).toBe(true);
  });
});
