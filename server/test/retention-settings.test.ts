import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_RETENTION } from '../src/domain/retention-settings.js';
import { writeRetentionStored } from '../src/domain/settings.js';
import { createTestApp, make, type TestApp } from './helpers.js';

describe('retention settings', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(() => t.close());

  it('starts from the defaults', async () => {
    const res = await t.api('GET', '/api/settings/retention');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(DEFAULT_RETENTION);
  });

  it('keeps omitted groups and fields, and null means «never»', async () => {
    const res = await t.api('PUT', '/api/settings/retention', {
      loyalty: { cashbackPercent: 7, expiryDays: 180 },
      birthday: { sendAt: '9:30', bonusAmount: 0 },
      certificates: { validityMonths: null },
    });
    expect(res.statusCode).toBe(200);
    const saved = res.json();
    expect(saved.loyalty).toEqual({ ...DEFAULT_RETENTION.loyalty, cashbackPercent: 7, expiryDays: 180 });
    expect(saved.birthday).toEqual({ ...DEFAULT_RETENTION.birthday, sendAt: '09:30', bonusAmount: 0 });
    expect(saved.winback).toEqual(DEFAULT_RETENTION.winback);
    expect(saved.certificates).toEqual({ validityMonths: null });

    const back = await t.api('PUT', '/api/settings/retention', { loyalty: { expiryDays: null } });
    expect(back.json().loyalty.expiryDays).toBeNull();
    expect(back.json().loyalty.cashbackPercent).toBe(7);
  });

  it('rejects values out of range with a 400', async () => {
    for (const body of [
      { loyalty: { cashbackPercent: 51 } },
      { loyalty: { maxPaymentPercent: -1 } },
      { birthday: { sendAt: '25:00' } },
      { winback: { afterMonths: 0 } },
      { winback: { text: '   ' } },
      { certificates: { validityMonths: 61 } },
    ]) {
      expect((await t.api('PUT', '/api/settings/retention', body)).statusCode).toBe(400);
    }
  });

  it('fills fields missing from what an older server saved', async () => {
    writeRetentionStored(t.ctx.db, { loyalty: { cashbackPercent: 3 } });
    const res = await t.api('GET', '/api/settings/retention');
    expect(res.json().loyalty).toEqual({ ...DEFAULT_RETENTION.loyalty, cashbackPercent: 3 });
    expect(res.json().birthday).toEqual(DEFAULT_RETENTION.birthday);
  });

  it('lets only the owner and admin change them', async () => {
    await make(t, '/api/employees', { name: 'Фатима', login: 'fatima', password: 'secret123', color: '#FF00AA', isMaster: true });
    const login = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'fatima', password: 'secret123' } });
    const auth = { authorization: `Bearer ${login.json().token}` };
    const read = await t.app.inject({ method: 'GET', url: '/api/settings/retention', headers: auth });
    expect(read.statusCode).toBe(200);
    const write = await t.app.inject({ method: 'PUT', url: '/api/settings/retention', headers: auth, payload: { loyalty: { cashbackPercent: 50 } } });
    expect(write.statusCode).toBe(403);
  });
});
