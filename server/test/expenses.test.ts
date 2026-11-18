import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chargeDates } from '../src/domain/expenses.js';
import { createTestApp, type TestApp } from './helpers.js';
import { at, ok, staff } from './payroll-fixtures.js';

describe('chargeDates', () => {
  const monthly = (date: string, endDate: string | null = null) => ({ repeat: 'monthly', date, endDate });

  it('charges a monthly expense on its day every month of the period', () => {
    expect(chargeDates(monthly('2026-09-05'), '2026-10-01', '2026-12-31')).toEqual(['2026-10-05', '2026-11-05', '2026-12-05']);
  });

  it('starts at its first date and stops at the end date', () => {
    expect(chargeDates(monthly('2026-11-10'), '2026-10-01', '2026-12-31')).toEqual(['2026-11-10', '2026-12-10']);
    expect(chargeDates(monthly('2026-09-05', '2026-11-04'), '2026-10-01', '2026-12-31')).toEqual(['2026-10-05']);
    expect(chargeDates(monthly('2026-10-20'), '2026-10-01', '2026-10-15')).toEqual([]);
  });

  it('moves the 31st to the last day of a shorter month and crosses the year', () => {
    expect(chargeDates(monthly('2026-01-31'), '2026-12-01', '2027-02-28')).toEqual(['2026-12-31', '2027-01-31', '2027-02-28']);
  });

  it('charges a one-time expense only on its date', () => {
    const once = { repeat: 'once', date: '2026-11-18', endDate: null };
    expect(chargeDates(once, '2026-11-01', '2026-11-30')).toEqual(['2026-11-18']);
    expect(chargeDates(once, '2026-12-01', '2026-12-31')).toEqual([]);
  });
});

describe('expenses endpoints', () => {
  let t: TestApp;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026-11-18T10:00:00.000Z');
    t = await createTestApp();
  });
  afterEach(async () => {
    await t.close();
    vi.useRealTimers();
  });

  const rent = { name: 'Аренда', category: 'rent', amount: 60000, repeat: 'monthly', date: '2026-10-01' };
  const wardrobe = { name: 'Шкаф', category: 'furniture', amount: 15000, repeat: 'once', date: '2026-11-18', note: 'IKEA' };

  it('creates, lists, edits and deletes expenses', async () => {
    const created = await ok(t.api, 'POST', '/api/expenses', rent);
    expect(created).toMatchObject({ ...rent, endDate: null, note: null, createdBy: { id: 1 } });
    await ok(t.api, 'POST', '/api/expenses', wardrobe);

    const list = await ok(t.api, 'GET', '/api/expenses');
    expect(list.items.map((e: { name: string }) => e.name)).toEqual(['Аренда', 'Шкаф']);

    const edited = await ok(t.api, 'PATCH', `/api/expenses/${created.id}`, { amount: 65000, endDate: '2026-12-31' });
    expect(edited).toMatchObject({ amount: 65000, endDate: '2026-12-31', name: 'Аренда' });
    // A one-time expense has no end date.
    expect(await ok(t.api, 'PATCH', `/api/expenses/${created.id}`, { repeat: 'once' })).toMatchObject({ endDate: null });

    expect((await t.api('DELETE', `/api/expenses/${created.id}`)).statusCode).toBe(204);
    expect((await t.api('DELETE', `/api/expenses/${created.id}`)).statusCode).toBe(404);
  });

  it('rejects invalid expenses', async () => {
    for (const body of [
      { ...rent, amount: 0 },
      { ...rent, name: ' ' },
      { ...rent, category: 'coffee' },
      { ...rent, date: '2026-13-01' },
      { ...rent, endDate: '2026-09-30' },
      { ...wardrobe, endDate: '2026-12-01' },
    ]) {
      expect((await t.api('POST', '/api/expenses', body)).statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it('is for the owner and the administrator only', async () => {
    const master = await staff(t, 'Фатима', 'fatima', 'master');
    const admin = await staff(t, 'Амина', 'amina', 'admin');
    expect((await master.api('GET', '/api/expenses')).statusCode).toBe(403);
    expect((await master.api('POST', '/api/expenses', rent)).statusCode).toBe(403);
    expect((await admin.api('POST', '/api/expenses', rent)).statusCode).toBe(200);
  });

  it('shows the expenses charged in the analytics period', async () => {
    await ok(t.api, 'POST', '/api/expenses', rent);
    await ok(t.api, 'POST', '/api/expenses', { ...rent, name: 'Свет', category: 'utilities', amount: 4000, date: '2026-10-25' });
    await ok(t.api, 'POST', '/api/expenses', wardrobe);
    await ok(t.api, 'POST', '/api/expenses', { ...wardrobe, date: '2026-10-02' });

    // November in Moscow.
    const report = await ok(t.api, 'GET', '/api/reports/analytics?from=2026-10-31T21:00:00.000Z&to=2026-11-30T21:00:00.000Z');
    expect(report.expenses).toEqual({
      total: 79000,
      monthly: 64000,
      once: 15000,
      byCategory: [
        { category: 'rent', amount: 60000 },
        { category: 'furniture', amount: 15000 },
        { category: 'utilities', amount: 4000 },
      ],
      items: [
        { id: 1, name: 'Аренда', category: 'rent', repeat: 'monthly', times: 1, amount: 60000 },
        { id: 3, name: 'Шкаф', category: 'furniture', repeat: 'once', times: 1, amount: 15000 },
        { id: 2, name: 'Свет', category: 'utilities', repeat: 'monthly', times: 1, amount: 4000 },
      ],
    });
    expect(report.totals.studioExpenses).toBe(79000);
    // The 30 days before, 2–31 October: electricity from the 25th and the other one-time purchase, not the rent of the 1st.
    expect(report.previous.studioExpenses).toBe(4000 + 15000);
  });
});
