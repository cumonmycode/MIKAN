import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeCallback, encodeCallback } from '../src/bot/callback-data.js';
import { MIGRATIONS_DIR } from '../src/db/client.js';
import * as schema from '../src/db/schema.js';
import { daysElapsedText, healingCheckText, jewelryChangeText, quotedNames, weeksElapsedText } from '../src/domain/follow-ups.js';
import { createTestApp, make, type TestApp } from './helpers.js';

const BASE = { category: 'piercing', price: 3000, durationMin: 30 };

describe('service follow-ups: «Спросить, как заживает» and «Напомнить о замене украшения»', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(async () => {
    await t.close();
  });

  const create = (body: Record<string, unknown>) => make(t, '/api/services', { ...BASE, ...body });
  const patch = async (id: number, body: Record<string, unknown>) => (await t.api('PATCH', `/api/services/${id}`, body)).json();

  it('a new fresh procedure asks how it heals after a week; everything else is off unless chosen', async () => {
    expect(await create({ name: 'Хеликс', freshProcedure: true })).toMatchObject({ healingCheckDays: 7, jewelryChangeWeeks: null });
    // Older builds send no switch: a service with its own memo template is a fresh procedure.
    expect(await create({ name: 'Трагус', aftercareTemplateId: 2 })).toMatchObject({ freshProcedure: true, healingCheckDays: 7 });
    expect(await create({ name: 'Замена украшения' })).toMatchObject({ freshProcedure: false, healingCheckDays: null, jewelryChangeWeeks: null });
    expect(await create({ name: 'Мочка', freshProcedure: true, healingCheckDays: null })).toMatchObject({ healingCheckDays: null });
    expect(await create({ name: 'Индастриал', freshProcedure: true, healingCheckDays: 14, jewelryChangeWeeks: 6 })).toMatchObject({
      healingCheckDays: 14,
      jewelryChangeWeeks: 6,
    });
    expect(await create({ name: 'Чистка', healingCheckDays: 3 })).toMatchObject({ freshProcedure: false, healingCheckDays: 3 });
  });

  it('PATCH changes them only when sent; null turns them off', async () => {
    const helix = await create({ name: 'Хеликс', freshProcedure: true, jewelryChangeWeeks: 6 });
    expect(await patch(helix.id, { price: 3500 })).toMatchObject({ healingCheckDays: 7, jewelryChangeWeeks: 6 });
    expect(await patch(helix.id, { healingCheckDays: 10 })).toMatchObject({ healingCheckDays: 10, jewelryChangeWeeks: 6 });
    expect(await patch(helix.id, { healingCheckDays: null, jewelryChangeWeeks: 8 })).toMatchObject({ healingCheckDays: null, jewelryChangeWeeks: 8 });
    // Turning the fresh-procedure switch off or on does not touch them.
    expect(await patch(helix.id, { freshProcedure: false })).toMatchObject({ healingCheckDays: null, jewelryChangeWeeks: 8 });
    const listed = (await t.api('GET', '/api/services')).json().items.find((s: { id: number }) => s.id === helix.id);
    expect(listed).toMatchObject({ healingCheckDays: null, jewelryChangeWeeks: 8 });
  });

  it('rejects values out of range, on create and on patch', async () => {
    const cases: Array<[string, unknown, RegExp]> = [
      ['healingCheckDays', 0, /^«Спросить, как заживает»: должно быть не меньше 1/],
      ['healingCheckDays', 61, /^«Спросить, как заживает»: должно быть не больше 60/],
      ['healingCheckDays', 1.5, /^«Спросить, как заживает»/],
      ['jewelryChangeWeeks', 0, /^«Напомнить о замене украшения»: должно быть не меньше 1/],
      ['jewelryChangeWeeks', 53, /^«Напомнить о замене украшения»: должно быть не больше 52/],
      ['jewelryChangeWeeks', '6', /^«Напомнить о замене украшения»/],
    ];
    for (const [field, value, message] of cases) {
      const res = await t.api('POST', '/api/services', { ...BASE, name: 'X', [field]: value });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(message);
    }
    const edge = await create({ name: 'Край', healingCheckDays: 60, jewelryChangeWeeks: 52 });
    expect(edge).toMatchObject({ healingCheckDays: 60, jewelryChangeWeeks: 52 });
    expect(await patch(edge.id, { healingCheckDays: 1, jewelryChangeWeeks: 1 })).toMatchObject({ healingCheckDays: 1, jewelryChangeWeeks: 1 });
    expect((await t.api('PATCH', `/api/services/${edge.id}`, { jewelryChangeWeeks: 100 })).statusCode).toBe(400);
  });
});

describe('migration 0014_service_followups', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('gives fresh procedures the healing check a week after the visit; the jewelry change stays off', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mikan-migrations-'));
    dirs.push(dir);
    fs.cpSync(MIGRATIONS_DIR, dir, { recursive: true });
    const journalPath = path.join(dir, 'meta', '_journal.json');
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as { entries: Array<{ tag: string }> };
    journal.entries = journal.entries.filter((e) => e.tag < '0014');
    fs.writeFileSync(journalPath, JSON.stringify(journal));

    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: dir });
    const now = 1_790_000_000_000;
    sqlite.exec(`
      INSERT INTO services (id, name, category, price, duration_min, fresh_procedure, created_at, updated_at) VALUES
        (1, 'Хеликс', 'piercing', 3000, 30, 1, ${now}, ${now}),
        (2, 'Замена украшения', 'piercing', 300, 15, 0, ${now}, ${now}),
        (3, 'Мини тату', 'tattoo', 5000, 60, 1, ${now}, ${now});
    `);
    migrate(db, { migrationsFolder: MIGRATIONS_DIR });
    expect(sqlite.prepare('SELECT id, healing_check_days, jewelry_change_weeks FROM services ORDER BY id').all()).toEqual([
      { id: 1, healing_check_days: 7, jewelry_change_weeks: null },
      { id: 2, healing_check_days: null, jewelry_change_weeks: null },
      { id: 3, healing_check_days: 7, jewelry_change_weeks: null },
    ]);
    sqlite.close();
  });
});

describe('follow-up texts and buttons', () => {
  it('names the time that passed in Russian', () => {
    expect([1, 2, 5, 7, 10, 14, 21, 22, 30].map(daysElapsedText)).toEqual([
      'Прошёл день', 'Прошло 2 дня', 'Прошло 5 дней', 'Прошла неделя', 'Прошло 10 дней', 'Прошло 14 дней', 'Прошёл 21 день',
      'Прошло 22 дня', 'Прошло 30 дней',
    ]);
    expect([1, 2, 4, 5, 6, 11, 21, 52].map(weeksElapsedText)).toEqual([
      'прошла неделя', 'прошло 2 недели', 'прошло 4 недели', 'прошло 5 недель', 'прошло 6 недель', 'прошло 11 недель',
      'прошла 21 неделя', 'прошло 52 недели',
    ]);
    expect([[], ['Хеликс'], ['Хеликс', 'Трагус'], ['Хеликс', 'Трагус', 'Мочка']].map(quotedNames)).toEqual([
      '', '«Хеликс»', '«Хеликс» и «Трагус»', '«Хеликс», «Трагус» и «Мочка»',
    ]);
  });

  it('builds the messages of the contract', () => {
    expect(healingCheckText('Анна', 7, ['Хеликс'])).toBe('Здравствуйте, Анна! Прошла неделя после процедуры «Хеликс». Как заживает? 🙂');
    expect(healingCheckText(' ', 10, ['Хеликс', 'Трагус'])).toBe('Здравствуйте! Прошло 10 дней после процедур «Хеликс» и «Трагус». Как заживает? 🙂');
    expect(jewelryChangeText('Анна', 6, ['Хеликс'], true)).toBe(
      'Анна, прошло 6 недель после прокола «Хеликс» — самое время заменить украшение на подходящее по размеру. Записаться?',
    );
    expect(jewelryChangeText('', 3, ['Хеликс', 'Трагус'], true)).toBe(
      'Прошло 3 недели после проколов «Хеликс» и «Трагус» — самое время заменить украшение на подходящее по размеру. Записаться?',
    );
    expect(jewelryChangeText('Анна', 1, ['Микродермал'], false)).toMatch(/^Анна, прошла неделя после процедуры «Микродермал» — /);
  });

  it('carries the appointment in the button payloads; malformed ones are refused', () => {
    const kinds = ['healingOk', 'healingQuestion', 'jewelryChangeBook', 'jewelryChangeLater'] as const;
    expect(kinds.map((kind) => encodeCallback({ kind, appointmentId: 42 }))).toEqual(['ho:42', 'hq:42', 'cb:42', 'cl:42']);
    for (const kind of kinds) expect(decodeCallback(encodeCallback({ kind, appointmentId: 7 }))).toEqual({ kind, appointmentId: 7 });
    expect(decodeCallback('rc:5')).toEqual({ kind: 'reminderConfirm', appointmentId: 5 });
    for (const bad of ['ho', 'ho:', 'ho:x', 'hq:1:2', 'cb:-1', 'zz:1', 'constructor:1', 'toString:1']) expect(decodeCallback(bad)).toBeNull();
  });
});
