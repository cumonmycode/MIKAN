import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalJson, IDEMPOTENCY_TTL_MS } from '../src/lib/idempotency.js';
import { ADMIN, createTestApp, make, openShift, type TestApp } from './helpers.js';

describe('Idempotency-Key on write endpoints', () => {
  let t: TestApp;
  let product: { id: number };

  beforeEach(async () => {
    t = await createTestApp();
    product = await make(t, '/api/products', { kind: 'jewelry', name: 'Лабрет', price: 1500, initialQuantity: 3 });
  });
  afterEach(async () => {
    await t.close();
  });

  const post = (url: string, payload: unknown, key?: string, token = t.token) =>
    t.app.inject({
      method: 'POST',
      url,
      headers: { authorization: `Bearer ${token}`, ...(key ? { 'idempotency-key': key } : {}) },
      payload: payload as Record<string, unknown>,
    });

  const saleBody = (overrides: object = {}) => ({
    items: [{ type: 'product', productId: product.id, quantity: 1, price: 1500 }],
    discount: 0,
    payments: { cash: 1500, card: 0, transfer: 0 },
    ...overrides,
  });

  const quantity = async () => (await t.api('GET', `/api/products/${product.id}`)).json().quantity as number;
  const movementsOfType = async (type: string) =>
    (await t.api('GET', `/api/products/${product.id}/movements`)).json().items.filter((m: { type: string }) => m.type === type);

  it('replays the stored sale for a repeated key without a second sale or stock movement', async () => {
    await openShift(t);
    const key = randomUUID();
    const first = await post('/api/sales', saleBody(), key);
    expect(first.statusCode).toBe(200);
    expect(first.headers['idempotent-replayed']).toBeUndefined();

    // Same key, same body with keys in another order and an upper-case key: still the same request.
    const reordered = { payments: { transfer: 0, card: 0, cash: 1500 }, discount: 0, items: saleBody().items };
    const retry = await post('/api/sales', reordered, key.toUpperCase());
    expect(retry.statusCode).toBe(200);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.json()).toEqual(first.json());

    expect((await t.api('GET', '/api/sales')).json().total).toBe(1);
    expect(await quantity()).toBe(2);
    expect(await movementsOfType('sale')).toHaveLength(1);
  });

  it('rejects a reused key with a different body or endpoint with 409 and writes nothing', async () => {
    await openShift(t);
    const key = randomUUID();
    expect((await post('/api/sales', saleBody(), key)).statusCode).toBe(200);

    const changed = await post('/api/sales', saleBody({ payments: { cash: 0, card: 1500, transfer: 0 } }), key);
    expect(changed.statusCode).toBe(409);
    expect(changed.json().error).toEqual({
      code: 'conflict',
      message: 'Повторный запрос отличается от исходного. Обновите экран и попробуйте снова.',
    });
    const otherEndpoint = await post(`/api/products/${product.id}/movements`, { type: 'receipt', quantity: 1 }, key);
    expect(otherEndpoint.statusCode).toBe(409);

    expect((await t.api('GET', '/api/sales')).json().total).toBe(1);
    expect(await quantity()).toBe(2);
  });

  it('keeps the old behaviour without the header and validates the header format', async () => {
    await openShift(t);
    expect((await post('/api/sales', saleBody())).statusCode).toBe(200);
    expect((await post('/api/sales', saleBody())).statusCode).toBe(200);
    expect((await t.api('GET', '/api/sales')).json().total).toBe(2);

    const bad = await post('/api/sales', saleBody(), 'not-a-uuid');
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toEqual({ code: 'validation_error', message: 'Некорректный заголовок Idempotency-Key: ожидается UUID' });
    expect((await t.api('GET', '/api/sales')).json().total).toBe(2);
  });

  it('does not store failures: the same key succeeds once the cause is fixed', async () => {
    await openShift(t);
    const key = randomUUID();
    const body = saleBody({ items: [{ type: 'product', productId: product.id, quantity: 4 }], payments: { cash: 6000 } });
    const short = await post('/api/sales', body, key);
    expect(short.statusCode).toBe(409);
    expect(short.json().error.code).toBe('insufficient_stock');

    await t.api('POST', `/api/products/${product.id}/movements`, { type: 'receipt', quantity: 1 });
    const ok = await post('/api/sales', body, key);
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['idempotent-replayed']).toBeUndefined();
    expect(await quantity()).toBe(0);
  });

  it('scopes keys per employee', async () => {
    await openShift(t);
    await make(t, '/api/employees', { name: 'Анна', login: 'anna', password: 'pass123', isMaster: true });
    const login = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'anna', password: 'pass123' } });
    const annaToken = login.json<{ token: string }>().token;
    const key = randomUUID();
    const admin = await post('/api/sales', saleBody(), key);
    const anna = await post('/api/sales', saleBody(), key, annaToken);
    expect(anna.statusCode).toBe(200);
    expect(anna.json().id).not.toBe(admin.json().id);
    expect(anna.json().employee.name).toBe('Анна');
    expect(admin.json().employee.name).toBe(ADMIN.name);
  });

  it('forgets keys after 24 hours', async () => {
    await openShift(t);
    const key = randomUUID();
    await post('/api/sales', saleBody(), key);
    t.ctx.sqlite.prepare('UPDATE idempotency_keys SET created_at = ?').run(Date.now() - IDEMPOTENCY_TTL_MS - 1000);
    const later = await post('/api/sales', saleBody(), key);
    expect(later.statusCode).toBe(200);
    expect(later.headers['idempotent-replayed']).toBeUndefined();
    expect((await t.api('GET', '/api/sales')).json().total).toBe(2);
    expect(t.ctx.sqlite.prepare('SELECT count(*) AS n FROM idempotency_keys').get()).toEqual({ n: 1 });
  });

  it('replays a refund without returning stock twice', async () => {
    await openShift(t);
    const sale = (await post('/api/sales', saleBody())).json();
    const key = randomUUID();
    const refund = await post(`/api/sales/${sale.id}/refund`, { reason: 'Не подошло', restock: true }, key);
    expect(refund.statusCode).toBe(200);
    const retry = await post(`/api/sales/${sale.id}/refund`, { reason: 'Не подошло', restock: true }, key);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(refund.json());
    expect(await quantity()).toBe(3);
    expect(await movementsOfType('return')).toHaveLength(1);
  });

  it('replays a cash operation and a manual stock movement', async () => {
    await t.api('POST', '/api/cash/shift/open', { openingCash: 1000 });
    const cashKey = randomUUID();
    const op = await post('/api/cash/operations', { type: 'out', amount: 300, reason: 'Хозтовары' }, cashKey);
    const opRetry = await post('/api/cash/operations', { type: 'out', amount: 300, reason: 'Хозтовары' }, cashKey);
    expect(opRetry.json()).toEqual(op.json());
    const shift = (await t.api('GET', '/api/cash/shift/current')).json().shift;
    expect(shift.operations).toHaveLength(1);
    expect(shift.expectedCash).toBe(700);

    const moveKey = randomUUID();
    const move = await post(`/api/products/${product.id}/movements`, { type: 'receipt', quantity: 5, note: 'Поставка' }, moveKey);
    const moveRetry = await post(`/api/products/${product.id}/movements`, { type: 'receipt', quantity: 5, note: 'Поставка' }, moveKey);
    expect(moveRetry.statusCode).toBe(200);
    expect(moveRetry.json()).toEqual(move.json());
    expect(await quantity()).toBe(8);
  });

  it('canonicalJson sorts object keys at every level and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: null, y: 'x' }], c: true } })).toBe('{"a":{"c":true,"d":[2,{"y":"x","z":null}]},"b":1}');
  });
});
