import type { InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { portfolioPhotos } from '../src/db/schema.js';
import { MAX_PORTFOLIO_PHOTOS } from '../src/domain/portfolio.js';
import { createTestApp, make, type TestApp } from './helpers.js';

type Json = Record<string, any>;
type Api = (method: InjectOptions['method'], url: string, payload?: unknown) => ReturnType<TestApp['api']>;

const OWN_ONLY = 'Можно менять только своё портфолио';

describe('portfolio (staff)', () => {
  let t: TestApp;
  let owner: Json;
  let fatima: Json;
  let helix: Json;
  let lobe: Json;

  async function loginAs(login: string): Promise<Api> {
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login, password: 'secret123' } });
    const token = res.json<{ token: string }>().token;
    return (method, url, payload) =>
      t.app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${token}` },
        ...(payload === undefined ? {} : { payload: payload as InjectOptions['payload'] }),
      });
  }

  const employee = (name: string, login: string, extra: Record<string, unknown> = {}) =>
    make(t, '/api/employees', { name, login, password: 'secret123', isMaster: true, ...extra });

  const add = (employeeId: number, n: number, extra: Record<string, unknown> = {}) =>
    make(t, '/api/portfolio', { employeeId, imageUrl: `/uploads/work-${n}.jpg`, ...extra });

  const list = async (query: string) => (await t.api('GET', `/api/portfolio?${query}`)).json().items as Json[];

  beforeEach(async () => {
    t = await createTestApp();
    owner = (await t.api('GET', '/api/auth/me')).json();
    fatima = await employee('Фатима', 'fatima');
    helix = await make(t, '/api/services', { name: 'Хеликс', category: 'piercing', price: 2500, durationMin: 30 });
    lobe = await make(t, '/api/services', { name: 'Мочка', category: 'piercing', price: 1600, durationMin: 30 });
  });
  afterEach(async () => {
    await t.close();
  });

  it('adds photos last, lists them in order and filters by master and service', async () => {
    const first = await add(fatima.id, 1, { serviceId: helix.id, caption: '  Хеликс, титан  ' });
    const second = await add(fatima.id, 2);
    const own = await add(owner.id, 3, { serviceId: helix.id });

    expect(first).toEqual({
      id: first.id,
      employee: { id: fatima.id, name: 'Фатима', color: fatima.color },
      imageUrl: '/uploads/work-1.jpg',
      caption: 'Хеликс, титан',
      service: { id: helix.id, name: 'Хеликс', category: 'piercing' },
      sort: 0,
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
    });
    expect(second).toMatchObject({ caption: null, service: null, sort: 1 });
    expect(own.sort).toBe(0);

    expect((await list(`employeeId=${fatima.id}`)).map((p) => p.id)).toEqual([first.id, second.id]);
    expect((await list(`serviceId=${helix.id}`)).map((p) => p.id).sort()).toEqual([first.id, own.id].sort());
    expect((await list(`employeeId=${fatima.id}&serviceId=${helix.id}`)).map((p) => p.id)).toEqual([first.id]);
    expect(await list(`employeeId=${fatima.id}&serviceId=${lobe.id}`)).toEqual([]);
  });

  it('edits the caption and the service; null clears them and an absent field stays', async () => {
    const photo = await add(fatima.id, 1, { serviceId: helix.id, caption: 'Хеликс' });

    const moved = await t.api('PATCH', `/api/portfolio/${photo.id}`, { serviceId: lobe.id });
    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({ caption: 'Хеликс', service: { id: lobe.id, name: 'Мочка' } });

    const cleared = await t.api('PATCH', `/api/portfolio/${photo.id}`, { caption: null, serviceId: null });
    expect(cleared.json()).toMatchObject({ caption: null, service: null });

    const blank = await t.api('PATCH', `/api/portfolio/${photo.id}`, { caption: '   ' });
    expect(blank.json().caption).toBeNull();
  });

  it('reorders all photos of a master and refuses partial, foreign or repeated lists', async () => {
    const [a, b, c] = [await add(fatima.id, 1), await add(fatima.id, 2), await add(fatima.id, 3)];
    const other = await add(owner.id, 4);

    const res = await t.api('PUT', '/api/portfolio/order', { employeeId: fatima.id, ids: [c.id, a.id, b.id] });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((p: Json) => [p.id, p.sort])).toEqual([[c.id, 0], [a.id, 1], [b.id, 2]]);
    expect((await list(`employeeId=${fatima.id}`)).map((p) => p.id)).toEqual([c.id, a.id, b.id]);

    const partial = await t.api('PUT', '/api/portfolio/order', { employeeId: fatima.id, ids: [a.id, b.id] });
    expect(partial.statusCode).toBe(400);
    expect(partial.json().error.message).toBe('Перечислите все фото мастера');
    const foreign = await t.api('PUT', '/api/portfolio/order', { employeeId: fatima.id, ids: [a.id, b.id, other.id] });
    expect(foreign.json().error.message).toBe('Перечислите все фото мастера');
    const repeated = await t.api('PUT', '/api/portfolio/order', { employeeId: fatima.id, ids: [a.id, a.id, b.id] });
    expect(repeated.json().error.message).toBe('Фото указано дважды');

    // A new photo still goes last after a reorder.
    expect((await add(fatima.id, 5)).sort).toBe(3);
  });

  it('deletes a photo; an unknown one is 404', async () => {
    const photo = await add(fatima.id, 1);
    expect((await t.api('DELETE', `/api/portfolio/${photo.id}`)).statusCode).toBe(204);
    expect(await list(`employeeId=${fatima.id}`)).toEqual([]);

    const missing = await t.api('DELETE', `/api/portfolio/${photo.id}`);
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.message).toBe('Фото не найдено');
    expect((await t.api('PATCH', '/api/portfolio/9999', { caption: 'x' })).statusCode).toBe(404);
  });

  it('validates the photo, the caption, the service and the master', async () => {
    const post = (body: Record<string, unknown>) => t.api('POST', '/api/portfolio', body);

    const external = await post({ employeeId: fatima.id, imageUrl: 'https://evil.example/x.jpg' });
    expect(external.statusCode).toBe(400);
    expect(external.json().error.message).toContain('/uploads/');
    expect((await post({ employeeId: fatima.id, imageUrl: '/uploads/../secret' })).statusCode).toBe(400);

    const long = await post({ employeeId: fatima.id, imageUrl: '/uploads/a.jpg', caption: 'а'.repeat(301) });
    expect(long.statusCode).toBe(400);
    expect(long.json().error.message).toBe('«Подпись»: максимум 300 символов');

    const service = await post({ employeeId: fatima.id, imageUrl: '/uploads/a.jpg', serviceId: 9999 });
    expect(service.statusCode).toBe(400);
    expect(service.json().error.message).toBe('Услуга не найдена');

    const nobody = await post({ employeeId: 9999, imageUrl: '/uploads/a.jpg' });
    expect(nobody.statusCode).toBe(404);
    expect(nobody.json().error.message).toBe('Сотрудник не найден');

    const admin = await employee('Ольга', 'olga', { isMaster: false, role: 'admin' });
    const notMaster = await post({ employeeId: admin.id, imageUrl: '/uploads/a.jpg' });
    expect(notMaster.statusCode).toBe(400);
    expect(notMaster.json().error.message).toBe('Портфолио ведётся только у работающих мастеров');

    await t.api('PATCH', `/api/employees/${fatima.id}`, { active: false });
    expect((await post({ employeeId: fatima.id, imageUrl: '/uploads/a.jpg' })).json().error.message).toBe(
      'Портфолио ведётся только у работающих мастеров',
    );
  });

  it(`keeps at most ${MAX_PORTFOLIO_PHOTOS} photos per master`, async () => {
    const now = Date.now();
    t.ctx.db
      .insert(portfolioPhotos)
      .values(Array.from({ length: MAX_PORTFOLIO_PHOTOS }, (_, i) => ({ employeeId: fatima.id, imageUrl: `/uploads/${i}.jpg`, sort: i, createdAt: now })))
      .run();
    const res = await t.api('POST', '/api/portfolio', { employeeId: fatima.id, imageUrl: '/uploads/one-more.jpg' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe(`В портфолио мастера не больше ${MAX_PORTFOLIO_PHOTOS} фото`);
    expect((await add(owner.id, 1)).sort).toBe(0);
  });

  it('a master manages only their own portfolio; admin and owner manage any; everyone reads', async () => {
    await employee('Ольга', 'olga', { isMaster: false, role: 'admin' });
    const asFatima = await loginAs('fatima');
    const asOlga = await loginAs('olga');
    const theirs = await add(owner.id, 1);

    const own = await asFatima('POST', '/api/portfolio', { employeeId: fatima.id, imageUrl: '/uploads/mine.jpg' });
    expect(own.statusCode).toBe(200);
    const mine = own.json();
    expect((await asFatima('PATCH', `/api/portfolio/${mine.id}`, { caption: 'Моё' })).statusCode).toBe(200);
    expect((await asFatima('PUT', '/api/portfolio/order', { employeeId: fatima.id, ids: [mine.id] })).statusCode).toBe(200);

    for (const [method, url, body] of [
      ['POST', '/api/portfolio', { employeeId: owner.id, imageUrl: '/uploads/x.jpg' }],
      ['PATCH', `/api/portfolio/${theirs.id}`, { caption: 'Чужое' }],
      ['PUT', '/api/portfolio/order', { employeeId: owner.id, ids: [theirs.id] }],
      ['DELETE', `/api/portfolio/${theirs.id}`, undefined],
    ] as const) {
      const res = await asFatima(method, url, body);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().error).toEqual({ code: 'forbidden', message: OWN_ONLY });
    }
    expect((await asFatima('GET', `/api/portfolio?employeeId=${owner.id}`)).json().items).toHaveLength(1);

    expect((await asOlga('PATCH', `/api/portfolio/${mine.id}`, { caption: 'Поправила' })).statusCode).toBe(200);
    expect((await asOlga('POST', '/api/portfolio', { employeeId: fatima.id, imageUrl: '/uploads/y.jpg' })).statusCode).toBe(200);
    expect((await asOlga('DELETE', `/api/portfolio/${mine.id}`)).statusCode).toBe(204);
    expect((await asFatima('DELETE', `/api/portfolio/${(await list(`employeeId=${fatima.id}`))[0]!.id}`)).statusCode).toBe(204);
  });

  it('logs every change with a summary for people', async () => {
    const photo = await add(fatima.id, 1, { serviceId: helix.id, caption: 'Хеликс' });
    const second = await add(fatima.id, 2);
    await t.api('PATCH', `/api/portfolio/${photo.id}`, { caption: 'Хеликс, титан', serviceId: lobe.id });
    await t.api('PATCH', `/api/portfolio/${photo.id}`, { caption: 'Хеликс, титан' });
    await t.api('PUT', '/api/portfolio/order', { employeeId: fatima.id, ids: [second.id, photo.id] });
    await t.api('DELETE', `/api/portfolio/${second.id}`);

    const entries = ((await t.api('GET', '/api/audit?entity=portfolio')).json().items as Json[]).reverse();
    expect(entries.map((e) => [e.action, e.entityId, e.summary])).toEqual([
      ['portfolio.create', photo.id, `Фото №${photo.id} добавлено в портфолио «Фатима» (услуга «Хеликс»)`],
      ['portfolio.create', second.id, `Фото №${second.id} добавлено в портфолио «Фатима»`],
      ['portfolio.update', photo.id, `Фото №${photo.id} в портфолио «Фатима» изменено: подпись, услуга`],
      ['portfolio.update', photo.id, `Фото №${photo.id} в портфолио «Фатима» сохранено без изменений`],
      ['portfolio.order', null, 'Порядок фото в портфолио «Фатима» изменён'],
      ['portfolio.delete', second.id, `Фото №${second.id} удалено из портфолио «Фатима»`],
    ]);
    expect(entries[2]!.changes).toEqual({
      caption: { from: 'Хеликс', to: 'Хеликс, титан' },
      service: { from: { id: helix.id, name: 'Хеликс' }, to: { id: lobe.id, name: 'Мочка' } },
    });
  });
});
