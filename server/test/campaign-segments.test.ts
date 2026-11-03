import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, make, type TestApp } from './helpers.js';
import { addBonusLot, addClient, addVisit, DAY, monthsBefore } from './retention-fixtures.js';

const NOW = Date.parse('2026-10-19T09:00:00.000Z'); // Mon 12:00 Moscow

describe('campaign segments and preview', () => {
  let t: TestApp;
  let fatima: { id: number };

  const preview = async (segment: Record<string, unknown>) => {
    const res = await t.api('POST', '/api/campaigns/preview', { segment });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as { count: number; sample: Array<{ name: string; lastName: string | null; telegramLinked: boolean }> };
  };
  const names = async (segment: Record<string, unknown>) => (await preview(segment)).sample.map((c) => c.name);

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    t = await createTestApp();
    fatima = await make(t, '/api/employees', { name: 'Фатима', login: 'fatima', password: 'secret123', color: '#FF00AA', isMaster: true });
    const helix = await make(t, '/api/services', { name: 'Хеликс', category: 'piercing', price: 3000, durationMin: 30 });
    const tattoo = await make(t, '/api/services', { name: 'Тату', category: 'tattoo', price: 9000, durationMin: 120 });

    // Анна: two piercing visits with the admin, the last 4 months ago; a burnt bonus lot.
    const anna = await addClient(t, 'Анна', { chatId: 9001, birthday: '1995-11-03', createdAt: NOW - 400 * DAY });
    addVisit(t, anna.id, { at: monthsBefore(NOW, 8), serviceIds: [helix.id] });
    addVisit(t, anna.id, { at: monthsBefore(NOW, 4), serviceIds: [helix.id] });
    addVisit(t, anna.id, { at: NOW + 3 * DAY, status: 'scheduled', serviceIds: [helix.id] });
    addBonusLot(t, anna.id, 100, NOW - DAY);
    // Борис: one tattoo with Фатима 13 months ago.
    const boris = await addClient(t, 'Борис', { chatId: 9002, birthday: '1990-10-19', createdAt: NOW - 400 * DAY });
    addVisit(t, boris.id, { at: monthsBefore(NOW, 13), masterId: fatima.id, serviceIds: [tattoo.id] });
    // Вера: new, never visited.
    await addClient(t, 'Вера', { chatId: 9003 });
    // Зоя: only a cancelled visit (not a visit), bonuses that still work.
    const zoya = await addClient(t, 'Зоя', { chatId: 9004, createdAt: NOW - 60 * DAY });
    addVisit(t, zoya.id, { at: monthsBefore(NOW, 2), status: 'cancelled', serviceIds: [tattoo.id] });
    addBonusLot(t, zoya.id, 300, NOW + 30 * DAY);

    // Never in any audience: opted out, archived, no Telegram, the bot turned off for them.
    for (const [name, options] of [
      ['Глеб', { chatId: 9005, marketingOptOut: true }],
      ['Дина', { chatId: 9006, archived: true }],
      ['Егор', {}],
      ['Фёдор', { chatId: 9007, botEnabled: false }],
    ] as const) {
      const c = await addClient(t, name, { ...options, birthday: '1990-10-01' });
      addVisit(t, c.id, { at: monthsBefore(NOW, 9), serviceIds: [helix.id, tattoo.id] });
      addBonusLot(t, c.id, 500, null);
    }
  });
  afterEach(async () => {
    await t.close();
    vi.useRealTimers();
  });

  it('an empty segment: every linked client who accepts news, by name', async () => {
    const result = await preview({});
    expect(result.count).toBe(4);
    expect(result.sample.map((c) => c.name)).toEqual(['Анна', 'Борис', 'Вера', 'Зоя']);
    expect(result.sample[0]).toEqual({ id: expect.any(Number), name: 'Анна', lastName: null, phone: expect.any(String), telegramLinked: true });
  });

  it('last visit = the last completed appointment, in calendar months', async () => {
    expect(await names({ lastVisitMonthsAgoMin: 6 })).toEqual(['Борис']);
    expect(await names({ lastVisitMonthsAgoMax: 6 })).toEqual(['Анна']);
    expect(await names({ lastVisitMonthsAgoMin: 3, lastVisitMonthsAgoMax: 12 })).toEqual(['Анна']);
    expect(await names({ lastVisitMonthsAgoMin: 4 })).toEqual(['Анна', 'Борис']);
    expect(await names({ lastVisitMonthsAgoMin: 0, lastVisitMonthsAgoMax: 14 })).toEqual(['Анна', 'Борис']);
  });

  it('neverVisited and hasBonuses filter only when true', async () => {
    expect(await names({ neverVisited: true })).toEqual(['Вера', 'Зоя']);
    expect((await preview({ neverVisited: false })).count).toBe(4);
    expect(await names({ hasBonuses: true })).toEqual(['Зоя']);
    expect((await preview({ hasBonuses: false, neverVisited: null })).count).toBe(4);
  });

  it('categories and masters of completed visits, visit count, birthday month, new clients', async () => {
    expect(await names({ categories: ['tattoo'] })).toEqual(['Борис']);
    expect(await names({ categories: ['piercing'] })).toEqual(['Анна']);
    expect(await names({ categories: ['piercing', 'tattoo'] })).toEqual(['Анна', 'Борис']);
    expect(await names({ masterIds: [fatima.id] })).toEqual(['Борис']);
    expect(await names({ masterIds: [1, fatima.id] })).toEqual(['Анна', 'Борис']);
    expect(await names({ minVisits: 2 })).toEqual(['Анна']);
    expect(await names({ minVisits: 1 })).toEqual(['Анна', 'Борис']);
    expect(await names({ birthdayMonth: 11 })).toEqual(['Анна']);
    expect(await names({ birthdayMonth: 10 })).toEqual(['Борис']);
    expect(await names({ createdWithinDays: 30 })).toEqual(['Вера']);
    expect(await names({ createdWithinDays: 90 })).toEqual(['Вера', 'Зоя']);
  });

  it('conditions combine with AND; empty lists mean no condition', async () => {
    expect(await names({ categories: ['piercing'], minVisits: 2, birthdayMonth: 11, lastVisitMonthsAgoMax: 6 })).toEqual(['Анна']);
    expect((await preview({ categories: ['piercing'], masterIds: [fatima.id] })).count).toBe(0);
    expect((await preview({ neverVisited: true, minVisits: 1 })).count).toBe(0);
    expect((await preview({ categories: [], masterIds: [] })).count).toBe(4);
  });

  it('shows at most 5 clients in the sample but counts all', async () => {
    for (let i = 0; i < 6; i++) await addClient(t, `Ян${i}`, { chatId: 9100 + i });
    const result = await preview({});
    expect(result.count).toBe(10);
    expect(result.sample).toHaveLength(5);
  });

  it('rejects malformed segments with a 400', async () => {
    for (const segment of [
      { lastVisitMonthsAgoMin: 12, lastVisitMonthsAgoMax: 3 },
      { categories: ['massage'] },
      { birthdayMonth: 13 },
      { minVisits: 0 },
      { masterIds: [0] },
      { createdWithinDays: -1 },
    ]) {
      const res = await t.api('POST', '/api/campaigns/preview', { segment });
      expect(res.statusCode, JSON.stringify(segment)).toBe(400);
      expect(res.json().error.code).toBe('validation_error');
    }
    const missing = await t.api('POST', '/api/campaigns/preview', {});
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.message).toBe('«Получатели»: обязательное поле');
    const order = await t.api('POST', '/api/campaigns/preview', { segment: { lastVisitMonthsAgoMin: 12, lastVisitMonthsAgoMax: 3 } });
    expect(order.json().error.message).toBe('«Последний визит — до, месяцев назад»: должно быть не меньше, чем «от»');
  });
});
