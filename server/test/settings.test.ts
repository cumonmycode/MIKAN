import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backupFileName, pruneBackups, runBackupIfDue } from '../src/domain/backup.js';
import { createTestApp, make, type TestApp } from './helpers.js';

const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(32)]);

function multipart(field: string, filename: string, mime: string, data: Buffer) {
  const boundary = '----mikanboundary';
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

describe('settings, catalog, knowledge and uploads', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(async () => {
    await t.close();
  });

  it('reads and updates studio settings with timezone validation', async () => {
    expect((await t.api('GET', '/api/settings/studio')).json()).toEqual({
      name: 'MIKAN STUDIO', address: '', phone: '', workingHours: 'Ежедневно 11:00–21:00',
      instagram: '', website: '', about: '', timezone: 'Europe/Moscow', workdayStart: '11:00', workdayEnd: '21:00',
      cancellation: { freeHours: 24, lateRetainPercent: 100, noShowRetainPercent: 100, autoRetain: false },
      reviewLinks: { yandex: '', twogis: '', google: '' },
      onlineBooking: { enabled: true, leadMinutes: 120, horizonDays: 60, holdMinutes: 15, stepMinutes: 30, note: '', confirmationHours: 24 },
      pos: { sendReceipt: true },
    });
    const put = await t.api('PUT', '/api/settings/studio', { name: 'MIKAN', address: 'ул. Ленина, 1', about: null, timezone: 'Asia/Novosibirsk' });
    expect(put.json()).toMatchObject({ name: 'MIKAN', address: 'ул. Ленина, 1', about: '', timezone: 'Asia/Novosibirsk', workingHours: 'Ежедневно 11:00–21:00' });
    const bad = await t.api('PUT', '/api/settings/studio', { timezone: 'Mars/Olympus' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toBe('«Часовой пояс»: неизвестный часовой пояс (пример: Europe/Moscow)');
  });

  it('updates bot settings, ignores read-only fields and triggers a bot refresh on enable/disable', async () => {
    const refresh = vi.fn();
    t.ctx.onBotSettingsChanged = refresh;
    const res = await t.api('PUT', '/api/settings/bot', {
      enabled: false, aiEnabled: false, greeting: 'Привет!', extraInstructions: 'Не обещай скидок', aftercareHour: 10,
      remindersEnabled: false, reminderHoursBefore: 48, botUsername: 'hacker', staffChatBound: true, aiConfigured: true,
    });
    expect(res.json()).toEqual({
      enabled: false, aiEnabled: false, greeting: 'Привет!', extraInstructions: 'Не обещай скидок', aftercareHour: 10,
      remindersEnabled: false, reminderOffsets: [2880], reminderHoursBefore: 48, morningDigestAt: '09:30', eveningDigestAt: '21:30',
      botUsername: 'mikan_test_bot', staffChatBound: false, aiConfigured: false,
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    await t.api('PUT', '/api/settings/bot', { greeting: 'Снова привет' });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect((await t.api('PUT', '/api/settings/bot', { aftercareHour: 24 })).statusCode).toBe(400);
  });

  it('manages services sorted by sort then name, with template validation', async () => {
    await make(t, '/api/services', { name: 'Б-услуга', category: 'tattoo', price: 5000, priceFrom: true, durationMin: 60, sort: 1 });
    const a = await make(t, '/api/services', { name: 'А-услуга', category: 'piercing', price: 2500, durationMin: 30, sort: 1, aftercareTemplateId: 2 });
    const first = await make(t, '/api/services', { name: 'Я-первая', category: 'other', price: 0, durationMin: 15, sort: 0, description: 'Консультация' });
    expect(first).toEqual({
      id: first.id, name: 'Я-первая', category: 'other', group: null, price: 0, priceMax: null, priceFrom: false, durationMin: 15,
      description: 'Консультация', imageUrl: null, imagePrompt: null, photos: [], variants: [], depositAmount: 0, masterPrices: [], aftercareTemplateId: null, freshProcedure: false, healingCheckDays: null, jewelryChangeWeeks: null, jewelryIds: [], consumables: [], active: true, sort: 0,
    });
    const names = async (q = '') => (await t.api('GET', `/api/services${q}`)).json().items.map((s: { name: string }) => s.name);
    expect(await names()).toEqual(['Я-первая', 'А-услуга', 'Б-услуга']);
    await t.api('PATCH', `/api/services/${a.id}`, { active: false, aftercareTemplateId: null, price: 3000 });
    expect(await names()).toEqual(['Я-первая', 'Б-услуга']);
    expect(await names('?includeInactive=true')).toHaveLength(3);
    expect((await t.api('POST', '/api/services', { name: 'X', category: 'tattoo', price: 1, durationMin: 10, aftercareTemplateId: 99 })).statusCode).toBe(400);
    expect((await t.api('POST', '/api/services', { name: 'X', category: 'bad', price: 1, durationMin: 10 })).statusCode).toBe(400);
    expect((await t.api('PATCH', '/api/services/99', { name: 'X' })).statusCode).toBe(404);
  });

  it('manages aftercare templates; deleting one detaches services', async () => {
    const seeded = (await t.api('GET', '/api/aftercare-templates')).json().items;
    expect(seeded.map((x: { name: string }) => x.name)).toEqual(['Уход за проколом', 'Уход за татуировкой']);
    expect(seeded[1].steps.map((s: { dayOffset: number }) => s.dayOffset)).toEqual([0, 1, 3, 7, 14, 30]);

    const tpl = await make(t, '/api/aftercare-templates', { name: 'Брови', category: 'other', steps: [{ dayOffset: 7, text: 'Неделя' }, { dayOffset: 0, text: 'Сразу' }] });
    expect(tpl.steps).toEqual([{ dayOffset: 0, text: 'Сразу' }, { dayOffset: 7, text: 'Неделя' }]);
    expect((await t.api('POST', '/api/aftercare-templates', { name: 'X', category: 'other', steps: [] })).statusCode).toBe(400);
    const patched = await t.api('PATCH', `/api/aftercare-templates/${tpl.id}`, { name: 'Брови v2', steps: [{ dayOffset: 1, text: 'Завтра' }] });
    expect(patched.json()).toMatchObject({ name: 'Брови v2', steps: [{ dayOffset: 1, text: 'Завтра' }] });

    const service = await make(t, '/api/services', { name: 'Брови', category: 'other', price: 1, durationMin: 10, aftercareTemplateId: tpl.id });
    expect((await t.api('DELETE', `/api/aftercare-templates/${tpl.id}`)).statusCode).toBe(204);
    const after = (await t.api('GET', '/api/services')).json().items.find((s: { id: number }) => s.id === service.id);
    expect(after.aftercareTemplateId).toBeNull();
    expect((await t.api('DELETE', `/api/aftercare-templates/${tpl.id}`)).statusCode).toBe(404);
    expect((await t.api('PATCH', `/api/aftercare-templates/${tpl.id}`, { name: 'x' })).statusCode).toBe(404);
  });

  it('manages knowledge entries (seeded drafts are marked for review)', async () => {
    const seeded = (await t.api('GET', '/api/knowledge')).json().items;
    expect(seeded.length).toBeGreaterThanOrEqual(3);
    expect(seeded.every((k: { title: string; active: boolean }) => k.title.startsWith('⚠️ Проверьте: ') && k.active)).toBe(true);
    const k = await make(t, '/api/knowledge', { title: 'Парковка', content: 'Бесплатная парковка во дворе', sort: -1 });
    expect(k).toMatchObject({ title: 'Парковка', active: true, sort: -1 });
    expect((await t.api('GET', '/api/knowledge')).json().items[0].id).toBe(k.id);
    expect((await t.api('PATCH', `/api/knowledge/${k.id}`, { active: false })).json().active).toBe(false);
    expect((await t.api('DELETE', `/api/knowledge/${k.id}`)).statusCode).toBe(204);
    expect((await t.api('DELETE', `/api/knowledge/${k.id}`)).statusCode).toBe(404);
    expect((await t.api('PATCH', `/api/knowledge/${k.id}`, { title: 'x' })).statusCode).toBe(404);
  });

  it('uploads images (mime + signature) and serves them publicly', async () => {
    const ok = multipart('file', 'photo.png', 'image/png', PNG);
    const res = await t.app.inject({ method: 'POST', url: '/api/uploads', headers: { ...ok.headers, authorization: `Bearer ${t.token}` }, payload: ok.payload });
    expect(res.statusCode).toBe(200);
    const { url } = res.json();
    expect(url).toMatch(/^\/uploads\/[0-9a-f-]{36}\.png$/);
    const served = await t.app.inject({ method: 'GET', url });
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toBe('image/png');
    expect((await t.app.inject({ method: 'GET', url: '/uploads/missing.png' })).statusCode).toBe(404);

    const fake = multipart('file', 'evil.png', 'image/png', Buffer.from('<?php echo 1; ?>'));
    const r2 = await t.app.inject({ method: 'POST', url: '/api/uploads', headers: { ...fake.headers, authorization: `Bearer ${t.token}` }, payload: fake.payload });
    expect(r2.statusCode).toBe(400);
    const pdf = multipart('file', 'doc.pdf', 'application/pdf', PNG);
    const r3 = await t.app.inject({ method: 'POST', url: '/api/uploads', headers: { ...pdf.headers, authorization: `Bearer ${t.token}` }, payload: pdf.payload });
    expect(r3.json().error.message).toBe('Поддерживаются только изображения JPEG, PNG, HEIC и WebP');
    const big = multipart('file', 'big.png', 'image/png', Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]));
    const r4 = await t.app.inject({ method: 'POST', url: '/api/uploads', headers: { ...big.headers, authorization: `Bearer ${t.token}` }, payload: big.payload });
    expect(r4.statusCode).toBe(400);
    expect(r4.json().error.message).toBe('Файл слишком большой (максимум 10 МБ)');
    expect((await t.api('POST', '/api/uploads', { file: 'x' })).statusCode).toBe(400);
    const anon = await t.app.inject({ method: 'POST', url: '/api/uploads', headers: ok.headers, payload: ok.payload });
    expect(anon.statusCode).toBe(401);
  });
});

describe('daily backup', () => {
  it('backs up once per studio-local day after 04:00 and keeps the newest 14', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mikan-backup-'));
    const sqlite = new Database(':memory:');
    sqlite.exec('create table x (a int); insert into x values (42);');
    const tz = 'Europe/Moscow';
    expect(await runBackupIfDue(sqlite, dir, tz, Date.parse('2026-10-15T00:30:00Z'))).toBeNull(); // 03:30 Moscow
    const file = await runBackupIfDue(sqlite, dir, tz, Date.parse('2026-10-15T01:05:00Z')); // 04:05 Moscow
    expect(file).toBe(path.join(dir, backupFileName('2026-10-15')));
    expect(new Database(file!).prepare('select a from x').get()).toEqual({ a: 42 });
    expect(await runBackupIfDue(sqlite, dir, tz, Date.parse('2026-10-15T10:00:00Z'))).toBeNull();

    for (let d = 1; d <= 20; d++) fs.writeFileSync(path.join(dir, backupFileName(`2026-09-${String(d).padStart(2, '0')}`)), '');
    fs.writeFileSync(path.join(dir, 'other.txt'), '');
    const removed = pruneBackups(dir);
    expect(removed).toHaveLength(7);
    expect(fs.readdirSync(dir).filter((f) => f.startsWith('mikan-')).sort()[0]).toBe('mikan-2026-09-08.db');
    expect(fs.existsSync(path.join(dir, 'other.txt'))).toBe(true);
    expect(pruneBackups(path.join(dir, 'nope'))).toEqual([]);
    sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
