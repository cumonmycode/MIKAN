import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleCallback } from '../src/bot/callbacks.js';
import { handleStaffCommand, handleStart } from '../src/bot/onboarding.js';
import { BotPipeline } from '../src/bot/pipeline.js';
import { processDueMessages } from '../src/bot/sender.js';
import { issueStaffCode } from '../src/bot/staff.js';
import { settings } from '../src/db/schema.js';
import { getBotSettings } from '../src/domain/settings.js';
import { createTestApp, make, message, ScriptedAi, text, type TestApp } from './helpers.js';

const NOW = Date.parse('2026-10-15T09:00:00.000Z'); // Thu 12:00 Moscow
const CHAT = 730_001;
const STAFF = -730;
const from = { chatId: CHAT, telegramName: 'Иван', username: 'ivanp' };

type Scheduled = { id: number; kind: string; appointmentId: number; sendAt: string; status: string; text: string };

describe('bot: reminders at several moments, with buttons', () => {
  let t: TestApp;
  let ai: ScriptedAi;
  let pipeline: BotPipeline;
  let client: { id: number };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    ai = new ScriptedAi();
    t = await createTestApp({ ai });
    pipeline = new BotPipeline(t.ctx, 0);
    handleStaffCommand(t.ctx, STAFF, issueStaffCode(t.ctx.db).code);
    client = await make(t, '/api/clients', { name: 'Иван', phone: '+79991234567' });
    const url = (await t.api('POST', `/api/clients/${client.id}/telegram-link`)).json().url as string;
    handleStart(t.ctx, from, new URL(url).searchParams.get('start')!);
  });
  afterEach(async () => {
    await t.close();
    vi.useRealTimers();
  });

  const pending = async () => (await t.api('GET', '/api/bot/scheduled?status=pending')).json().items as Scheduled[];
  const putBot = (body: Record<string, unknown>) => t.api('PUT', '/api/settings/bot', body);
  const book = (startsAt: string, endsAt: string, clientId = client.id) =>
    make(t, '/api/appointments', { clientId, masterId: 1, startsAt, endsAt, title: 'Хеликс' });

  it('edits the reminder moments in settings: validated, sorted, older builds still work', async () => {
    const res = await putBot({ reminderOffsets: [120, 1440] });
    expect(res.json()).toMatchObject({ reminderOffsets: [1440, 120], reminderHoursBefore: 24, remindersEnabled: true });
    for (const bad of [[], [10], [20_161], [60, 60], [15, 30, 60, 120, 180, 360, 720], [1.5]]) {
      const r = await putBot({ reminderOffsets: bad });
      expect(r.statusCode).toBe(400);
      expect(r.json().error.message).toMatch(/^«Напоминания/);
    }
    // Older builds resend the hours they read (kept as is) or change them (a single reminder).
    expect((await putBot({ reminderHoursBefore: 24, greeting: 'Привет' })).json().reminderOffsets).toEqual([1440, 120]);
    expect((await putBot({ reminderHoursBefore: 3 })).json()).toMatchObject({ reminderOffsets: [180], reminderHoursBefore: 3 });
    // A reminder 14 days ahead still reads as 168 hours, so builds that resend the value can save.
    expect((await putBot({ reminderOffsets: [20_160] })).json()).toMatchObject({ reminderHoursBefore: 168 });
    expect((await putBot({ reminderHoursBefore: 168, greeting: 'Снова' })).json().reminderOffsets).toEqual([20_160]);
    // Settings stored before the list existed.
    t.ctx.db.update(settings).set({ value: JSON.stringify({ enabled: true, reminderHoursBefore: 48 }) }).run();
    expect(getBotSettings(t.ctx.db).reminderOffsets).toEqual([2880]);
    expect((await t.api('GET', '/api/settings/bot')).json()).toMatchObject({ reminderOffsets: [2880], reminderHoursBefore: 48 });
  });

  it('schedules one reminder per moment, re-syncs them on reschedule and when the settings change', async () => {
    await putBot({ reminderOffsets: [1440, 120] });
    const appt = await book('2026-10-17T11:00:00Z', '2026-10-17T12:00:00Z'); // Sat 14:00 Moscow
    let list = await pending();
    expect(list.map((m) => [m.kind, m.sendAt])).toEqual([
      ['reminder', '2026-10-16T11:00:00.000Z'],
      ['reminder', '2026-10-17T09:00:00.000Z'],
    ]);
    expect(list[0]!.text).toMatch(/^🗓 Напоминаем о записи в MIKAN STUDIO\nКогда: суббота, 17 октября в 14:00/);
    expect(list[1]!.text).toMatch(/^⏰ Сегодня ждём вас в MIKAN STUDIO\nКогда: суббота, 17 октября в 14:00/);
    expect(list[1]!.text).toContain('«✅ Приду»');

    await t.api('PATCH', `/api/appointments/${appt.id}`, { startsAt: '2026-10-18T11:00:00Z' });
    expect((await pending()).map((m) => m.sendAt)).toEqual(['2026-10-17T11:00:00.000Z', '2026-10-18T09:00:00.000Z']);

    // A moment already in the past is skipped.
    const soon = await book('2026-10-15T12:00:00Z', '2026-10-15T13:00:00Z');
    expect((await pending()).filter((m) => m.appointmentId === soon.id).map((m) => m.sendAt)).toEqual(['2026-10-15T10:00:00.000Z']);

    await putBot({ reminderOffsets: [60] });
    list = await pending();
    expect(list.map((m) => [m.appointmentId, m.sendAt])).toEqual([
      [soon.id, '2026-10-15T11:00:00.000Z'],
      [appt.id, '2026-10-18T10:00:00.000Z'],
    ]);
    await putBot({ remindersEnabled: false });
    expect(await pending()).toEqual([]);
  });

  it('sends reminders with «✅ Приду» / «🔁 Перенести»: confirm sets confirmed, move starts a dialog', async () => {
    const appt = await book('2026-10-17T11:00:00Z', '2026-10-17T12:00:00Z');
    expect(await processDueMessages(t.ctx, Date.parse('2026-10-16T11:00:01Z'))).toMatchObject({ sent: 1 });
    const reminder = t.gateway.sent.at(-1)!;
    expect(reminder.chatId).toBe(CHAT);
    expect(reminder.keyboard).toEqual([[{ text: '✅ Приду', data: `rc:${appt.id}` }, { text: '🔁 Перенести', data: `rm:${appt.id}` }]]);

    const press = (data: string, chat = from) => handleCallback({ ctx: t.ctx, pipeline }, { from: chat, data, message: { messageId: reminder.messageId, isPhoto: false } });

    // Somebody else's chat cannot confirm it.
    const stranger = { chatId: CHAT + 5, telegramName: 'Чужой', username: null };
    expect(await press(`rc:${appt.id}`, stranger)).toEqual({ text: 'Эта запись уже неактуальна', error: true });
    expect((await t.api('GET', `/api/appointments/${appt.id}`)).json().status).toBe('scheduled');

    expect(await press(`rc:${appt.id}`)).toEqual({ text: 'Запись подтверждена ✅' });
    expect((await t.api('GET', `/api/appointments/${appt.id}`)).json().status).toBe('confirmed');
    expect(t.gateway.edits.at(-1)).toEqual({
      kind: 'keyboard', chatId: CHAT, messageId: reminder.messageId, keyboard: [[{ text: '🔁 Перенести', data: `rm:${appt.id}` }]],
    });
    expect(t.gateway.textsTo(CHAT).at(-1)).toBe('Спасибо, что подтвердили! Ждём вас суббота, 17 октября в 14:00 ✨');
    expect(t.gateway.textsTo(STAFF).at(-1)).toBe(`✅ Иван подтвердил(а) запись №${appt.id}: суббота, 17 октября в 14:00, Хеликс, мастер Админ`);
    const history = (await t.api('GET', `/api/bot/chats/${CHAT}/messages`)).json().items.map((m: { role: string; text: string }) => `${m.role}:${m.text}`);
    expect(history.slice(-3)).toEqual([
      expect.stringMatching(/^system:🗓 Напоминаем/),
      'user:[Кнопка] ✅ Приду',
      'assistant:Спасибо, что подтвердили! Ждём вас суббота, 17 октября в 14:00 ✨',
    ]);
    expect(ai.calls).toHaveLength(0);

    ai.push(message([text('Конечно! На какой день удобно перенести?')]));
    expect(await press(`rm:${appt.id}`)).toEqual({ text: 'Подберём другое время 🙌' });
    await pipeline.idle();
    expect(JSON.stringify(ai.calls[0]!.messages)).toContain(`[Кнопка] 🔁 Хочу перенести запись №${appt.id}: суббота, 17 октября в 14:00 — Хеликс`);
    expect(t.gateway.textsTo(CHAT).at(-1)).toBe('Конечно! На какой день удобно перенести?');

    // A cancelled appointment's buttons are gone.
    await t.api('PATCH', `/api/appointments/${appt.id}`, { status: 'cancelled' });
    expect(await press(`rc:${appt.id}`)).toEqual({ text: 'Эта запись уже неактуальна', error: true });
    expect(t.gateway.edits.at(-1)).toMatchObject({ kind: 'keyboard', keyboard: null });
  });
});
