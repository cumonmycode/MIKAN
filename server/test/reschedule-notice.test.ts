import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleStart } from '../src/bot/onboarding.js';
import { processDueMessages } from '../src/bot/sender.js';
import { createTestApp, make, type TestApp } from './helpers.js';

const NOW = Date.parse('2026-10-15T09:00:00.000Z'); // Thu 12:00 Moscow
const CHAT = 740_001;

type Scheduled = { id: number; kind: string; appointmentId: number; chatId: number; sendAt: string; status: string; text: string; error: string | null };

const noticeText = (was: string, now: string, master: string) =>
  `Анна, ваша запись перенесена 🗓\n\nБыло: ${was}\nСтало: **${now}**\nМастер: ${master}\n\n` +
  'Если новое время не подходит — нажмите «🔁 Перенести».';

describe('moving an appointment notifies the client in Telegram', () => {
  let t: TestApp;
  let client: { id: number };
  let fatima: { id: number };

  async function linkTelegram(clientId: number, chat = CHAT) {
    const url = (await t.api('POST', `/api/clients/${clientId}/telegram-link`)).json().url as string;
    handleStart(t.ctx, { chatId: chat, telegramName: 'Анна', username: 'anna' }, new URL(url).searchParams.get('start')!);
  }

  const scheduled = async (status?: string) =>
    ((await t.api('GET', `/api/bot/scheduled${status ? `?status=${status}` : ''}`)).json().items as Scheduled[]);
  const notices = async (status?: string) => (await scheduled(status)).filter((m) => m.kind === 'reschedule_notice');
  const book = (clientId = client.id) =>
    make(t, '/api/appointments', {
      clientId,
      masterId: fatima.id,
      startsAt: '2026-10-20T11:00:00Z', // Tue 14:00 Moscow
      endsAt: '2026-10-20T12:00:00Z',
      title: 'Хеликс',
      force: true,
    });
  const move = (id: number, body: Record<string, unknown>) => t.api('PATCH', `/api/appointments/${id}`, body);

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    t = await createTestApp();
    fatima = await make(t, '/api/employees', { name: 'Фатима', login: 'fatima', password: 'pass123', isMaster: true });
    client = await make(t, '/api/clients', { name: 'Анна', lastName: 'Смирнова', phone: '+79991234567' });
  });
  afterEach(async () => {
    await t.close();
    vi.useRealTimers();
  });

  it('queues a notice at once, sends it with the reminder buttons and reschedules the reminders', async () => {
    await linkTelegram(client.id);
    const appt = await book();
    const res = await move(appt.id, { startsAt: '2026-10-21T12:00:00Z', endsAt: '2026-10-21T13:00:00Z', notifyClient: true });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ startsAt: '2026-10-21T12:00:00.000Z', endsAt: '2026-10-21T13:00:00.000Z' });

    const [notice, ...rest] = await notices('pending');
    expect(rest).toEqual([]);
    expect(notice).toMatchObject({
      kind: 'reschedule_notice',
      chatId: CHAT,
      appointmentId: appt.id,
      sendAt: new Date(NOW).toISOString(),
      text: noticeText('20 октября, 14:00', '21 октября, 15:00', 'Фатима'),
    });
    // Reminders follow the new time as before.
    const reminders = (await scheduled('pending')).filter((m) => m.kind === 'reminder');
    expect(reminders.map((m) => m.sendAt)).toEqual(['2026-10-20T12:00:00.000Z']);

    expect(await processDueMessages(t.ctx, NOW + 1_000)).toMatchObject({ sent: 1, cancelled: 0 });
    expect(t.gateway.sent.at(-1)).toEqual({
      chatId: CHAT,
      messageId: expect.any(Number),
      text: noticeText('20 октября, 14:00', '21 октября, 15:00', 'Фатима'),
      keyboard: [[{ text: '✅ Приду', data: `rc:${appt.id}` }, { text: '🔁 Перенести', data: `rm:${appt.id}` }]],
    });
    expect((await notices('sent')).map((m) => m.id)).toEqual([notice!.id]);
  });

  it('a second move replaces the pending notice; a move without the flag drops it', async () => {
    await linkTelegram(client.id);
    const appt = await book();
    await move(appt.id, { startsAt: '2026-10-21T12:00:00Z', notifyClient: true });
    // Dragged to another master's column too: the notice names the new master.
    await move(appt.id, { startsAt: '2026-10-22T08:30:00Z', masterId: 1, notifyClient: true });

    const pending = await notices('pending');
    expect(pending).toHaveLength(1);
    expect(pending[0]!.text).toBe(noticeText('21 октября, 15:00', '22 октября, 11:30', 'Админ'));
    expect(await notices('cancelled')).toHaveLength(1);

    await move(appt.id, { startsAt: '2026-10-23T08:30:00Z' });
    expect(await notices('pending')).toEqual([]);
    expect(await processDueMessages(t.ctx, NOW + 1_000)).toMatchObject({ sent: 0 });
  });

  it('sends nothing without Telegram, with the bot off for the client, without the flag or without a new time', async () => {
    const unlinked = await book();
    expect((await move(unlinked.id, { startsAt: '2026-10-21T12:00:00Z', notifyClient: true })).statusCode).toBe(200);
    expect(await notices()).toEqual([]);

    await linkTelegram(client.id);
    const appt = await book();
    await move(appt.id, { startsAt: '2026-10-21T14:00:00Z' });
    await move(appt.id, { startsAt: '2026-10-21T16:00:00Z', notifyClient: false });
    await move(appt.id, { status: 'confirmed', notifyClient: true });
    await move(appt.id, { endsAt: '2026-10-21T18:00:00Z', notifyClient: true });
    // Moved into the past (fixing the history): nobody is told.
    await move(appt.id, { startsAt: '2026-10-14T10:00:00Z', endsAt: '2026-10-14T11:00:00Z', notifyClient: true });
    // Moved while cancelled.
    await move(appt.id, { status: 'cancelled' });
    await move(appt.id, { startsAt: '2026-10-25T10:00:00Z', endsAt: '2026-10-25T11:00:00Z', notifyClient: true });
    expect(await notices()).toEqual([]);

    await t.api('PATCH', `/api/clients/${client.id}`, { botEnabled: false });
    const quiet = await book();
    await move(quiet.id, { startsAt: '2026-10-21T09:00:00Z', notifyClient: true });
    expect(await notices()).toEqual([]);
  });

  it('is skipped when the appointment is cancelled before it goes out', async () => {
    await linkTelegram(client.id);
    const appt = await book();
    await move(appt.id, { startsAt: '2026-10-21T12:00:00Z', notifyClient: true });
    await move(appt.id, { status: 'cancelled' });
    const sentBefore = t.gateway.sent.length;

    expect(await processDueMessages(t.ctx, NOW + 1_000)).toMatchObject({ sent: 0, cancelled: 1 });
    expect(t.gateway.sent).toHaveLength(sentBefore);
    expect(await notices('cancelled')).toMatchObject([{ error: 'Запись отменена или завершена' }]);
  });

  it('rejects a non-boolean flag', async () => {
    const appt = await book();
    const res = await move(appt.id, { startsAt: '2026-10-21T12:00:00Z', notifyClient: 'yes' });
    expect(res.statusCode).toBe(400);
  });
});
