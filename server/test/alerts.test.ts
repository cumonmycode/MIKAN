import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setChatEmployee, upsertChat } from '../src/domain/bot-chats.js';
import {
  AI_FAILURES_TO_ALERT,
  ALERT_REPEAT_MS,
  alertStaff,
  checkDiskSpace,
  noteAiOutcome,
  raiseAlert,
  resolveAlerts,
} from '../src/domain/alerts.js';
import { getAlertStates, setStaffChatId } from '../src/domain/settings.js';
import { createTestApp, make, type TestApp } from './helpers.js';

const GROUP_CHAT = -100500;
const ADMIN_CHAT = 7001;
const MASTER_CHAT = 7002;
const CLIENT_CHAT = 7003;
const NOW = Date.parse('2026-10-19T10:00:00Z');

describe('alerts', () => {
  let t: TestApp;
  const texts = () => t.gateway.sent.map((m) => m.text);

  beforeEach(async () => {
    t = await createTestApp();
    const master = await make(t, '/api/employees', { name: 'Фатима', login: 'fatima', password: 'secret123', color: '#FF00AA', isMaster: true });
    for (const [chatId, employeeId] of [
      [ADMIN_CHAT, 1],
      [MASTER_CHAT, master.id],
      [CLIENT_CHAT, null],
    ] as const) {
      upsertChat(t.ctx.db, chatId, { telegramName: `chat ${chatId}`, username: null });
      if (employeeId !== null) setChatEmployee(t.ctx.db, chatId, employeeId);
    }
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await t.close();
  });

  describe('delivery', () => {
    it('goes to the staff group chat when it is bound', async () => {
      setStaffChatId(t.ctx.db, GROUP_CHAT);
      expect(await alertStaff(t.ctx, 'тест')).toBe(1);
      expect(t.gateway.sent.map((m) => m.chatId)).toEqual([GROUP_CHAT]);
    });

    it('goes to every staff chat, never to clients, without a group chat', async () => {
      expect(await alertStaff(t.ctx, 'тест')).toBe(2);
      expect(t.gateway.sent.map((m) => m.chatId).sort()).toEqual([ADMIN_CHAT, MASTER_CHAT]);
    });

    it('still reaches the others when one staff chat fails', async () => {
      t.gateway.failures.push(new Error('blocked by user'));
      expect(await alertStaff(t.ctx, 'тест')).toBe(1);
    });

    it('sends nothing while the bot is off', async () => {
      t.gateway.running = false;
      expect(await alertStaff(t.ctx, 'тест')).toBe(0);
      expect(t.gateway.sent).toEqual([]);
    });
  });

  describe('raise and resolve', () => {
    beforeEach(() => setStaffChatId(t.ctx.db, GROUP_CHAT));

    it('tells staff once, repeats after 6 hours, and reports the recovery once', async () => {
      expect(await raiseAlert(t.ctx, 'backup', '⚠️ бэкап', NOW)).toBe(true);
      expect(await raiseAlert(t.ctx, 'backup', '⚠️ бэкап', NOW + ALERT_REPEAT_MS - 1)).toBe(false);
      expect(await raiseAlert(t.ctx, 'backup', '⚠️ бэкап', NOW + ALERT_REPEAT_MS)).toBe(true);
      expect(getAlertStates(t.ctx.db).backup).toEqual({ active: true, since: NOW, lastSentAt: NOW + ALERT_REPEAT_MS });

      expect(await resolveAlerts(t.ctx, ['backup'], '✅ бэкап', NOW + ALERT_REPEAT_MS + 1)).toBe(true);
      expect(await resolveAlerts(t.ctx, ['backup'], '✅ бэкап', NOW + ALERT_REPEAT_MS + 2)).toBe(false);
      expect(texts()).toEqual(['⚠️ бэкап', '⚠️ бэкап', '✅ бэкап']);
      expect(getAlertStates(t.ctx.db).backup!.active).toBe(false);
    });

    it('says nothing on recovery when nothing was raised', async () => {
      expect(await resolveAlerts(t.ctx, ['disk', 'backup'], '✅', NOW)).toBe(false);
      expect(t.gateway.sent).toEqual([]);
    });

    it('keeps kinds apart and starts over after a recovery', async () => {
      await raiseAlert(t.ctx, 'disk', 'диск', NOW);
      await raiseAlert(t.ctx, 'backup', 'бэкап', NOW + 1);
      await resolveAlerts(t.ctx, ['disk'], 'диск ок', NOW + 2);
      expect(await raiseAlert(t.ctx, 'disk', 'диск', NOW + 3)).toBe(true);
      expect(getAlertStates(t.ctx.db).disk!.since).toBe(NOW + 3);
      expect(getAlertStates(t.ctx.db).backup!.active).toBe(true);
    });
  });

  describe('AI outcomes', () => {
    beforeEach(() => setStaffChatId(t.ctx.db, GROUP_CHAT));
    const failure = { outcome: 'error', error: 'Request timed out', errorStatus: 504 };

    it('raises the balance alert on the first 402 and resolves it on the next reply', async () => {
      await noteAiOutcome(t.ctx, { outcome: 'error', error: 'Payment required', errorStatus: 402, errorCode: 'INSUFFICIENT_BALANCE' });
      expect(texts()).toEqual(['⚠️ Закончился баланс ИИ (Polza) — бот отвечает клиентам заглушкой. Пополните баланс.']);
      await noteAiOutcome(t.ctx, { outcome: 'replied' });
      expect(texts().at(-1)).toBe('✅ ИИ снова отвечает клиентам');
      expect(getAlertStates(t.ctx.db).ai_balance!.active).toBe(false);
    });

    it('recognises the balance code without the status', async () => {
      await noteAiOutcome(t.ctx, { outcome: 'error', errorCode: 'insufficient_balance' });
      expect(getAlertStates(t.ctx.db).ai_balance!.active).toBe(true);
    });

    it(`raises the error alert only after ${AI_FAILURES_TO_ALERT} failures in a row`, async () => {
      await noteAiOutcome(t.ctx, failure);
      await noteAiOutcome(t.ctx, failure);
      await noteAiOutcome(t.ctx, { outcome: 'replied' });
      await noteAiOutcome(t.ctx, failure);
      await noteAiOutcome(t.ctx, failure);
      expect(t.gateway.sent).toEqual([]);
      await noteAiOutcome(t.ctx, failure);
      expect(texts()).toEqual(['⚠️ ИИ не отвечает: 3 ошибки подряд. Последняя: Request timed out']);
    });

    it('stays quiet on successful replies when nothing was wrong', async () => {
      await noteAiOutcome(t.ctx, { outcome: 'replied' });
      expect(t.gateway.sent).toEqual([]);
    });

    it('never throws, even when the bookkeeping fails', async () => {
      t.ctx.sqlite.close();
      await expect(noteAiOutcome(t.ctx, failure)).resolves.toBeUndefined();
    });
  });

  describe('disk space', () => {
    beforeEach(() => setStaffChatId(t.ctx.db, GROUP_CHAT));

    it('warns below 1 GB free and reports when space is back', async () => {
      const statfs = vi.spyOn(fs, 'statfsSync');
      statfs.mockReturnValue({ bavail: 128 * 1024, bsize: 4096 } as fs.StatsFs);
      expect(await checkDiskSpace(t.ctx, t.ctx.config.dataDir, NOW)).toBe(512 * 1024 ** 2);
      expect(texts()).toEqual(['⚠️ На сервере мало места: свободно 0,5 ГБ. Без места не сохранятся записи и бэкапы.']);

      statfs.mockReturnValue({ bavail: 1024 * 1024, bsize: 4096 } as fs.StatsFs);
      await checkDiskSpace(t.ctx, t.ctx.config.dataDir, NOW + 1);
      expect(texts().at(-1)).toBe('✅ Место на сервере снова есть');
    });

    it('reads the real free space of the data folder', async () => {
      expect(await checkDiskSpace(t.ctx, t.ctx.config.dataDir, NOW)).toBeGreaterThan(0);
    });
  });
});
