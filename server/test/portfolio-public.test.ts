import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { portfolioPhotos } from '../src/db/schema.js';
import { PUBLIC_SERVICE_PORTFOLIO_LIMIT } from '../src/domain/portfolio.js';
import { createTestApp, make, type TestApp } from './helpers.js';
import { addMaster, pub, type Json } from './online-booking-fixtures.js';

describe('portfolio on the booking page (public)', () => {
  let t: TestApp;
  let owner: Json;
  let fatima: Json;
  let helix: Json;
  let lobe: Json;

  const add = (employeeId: number, name: string, extra: Record<string, unknown> = {}) =>
    make(t, '/api/portfolio', { employeeId, imageUrl: `/uploads/${name}.jpg`, ...extra });
  const masters = async () => (await pub(t, 'GET', '/masters')).json().items as Json[];

  beforeEach(async () => {
    t = await createTestApp();
    owner = (await t.api('GET', '/api/auth/me')).json();
    fatima = await addMaster(t, 'Фатима', 'fatima');
    helix = await make(t, '/api/services', { name: 'Хеликс', category: 'piercing', price: 2500, durationMin: 30 });
    lobe = await make(t, '/api/services', { name: 'Мочка', category: 'piercing', price: 1600, durationMin: 30 });
  });
  afterEach(async () => {
    await t.close();
  });

  it('masters carry the number of photos and the cover (the first in order)', async () => {
    const a = await add(fatima.id, 'a');
    const b = await add(fatima.id, 'b');
    expect(await masters()).toEqual([
      { id: owner.id, name: owner.name, color: owner.color, photos: 0, cover: null },
      { id: fatima.id, name: 'Фатима', color: fatima.color, photos: 2, cover: '/uploads/a.jpg' },
    ]);

    await t.api('PUT', '/api/portfolio/order', { employeeId: fatima.id, ids: [b.id, a.id] });
    expect((await masters()).find((m) => m.id === fatima.id)).toMatchObject({ photos: 2, cover: '/uploads/b.jpg' });
  });

  it("a master's works in their order, without staff fields", async () => {
    await add(fatima.id, 'a', { serviceId: helix.id, caption: 'Хеликс, титан' });
    await add(fatima.id, 'b');
    await add(owner.id, 'c');

    const res = await pub(t, 'GET', `/masters/${fatima.id}/portfolio`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      items: [
        { imageUrl: '/uploads/a.jpg', caption: 'Хеликс, титан', service: { id: helix.id, name: 'Хеликс' }, master: { id: fatima.id, name: 'Фатима' } },
        { imageUrl: '/uploads/b.jpg', caption: null, service: null, master: { id: fatima.id, name: 'Фатима' } },
      ],
    });
  });

  it('answers 404 for someone who is not a working master', async () => {
    const admin = await make(t, '/api/employees', { name: 'Ольга', login: 'olga', password: 'secret123', isMaster: false, role: 'admin' });
    await add(fatima.id, 'a');
    await t.api('PATCH', `/api/employees/${fatima.id}`, { active: false });
    for (const id of [fatima.id, admin.id, 9999]) {
      const res = await pub(t, 'GET', `/masters/${id}/portfolio`);
      expect(res.statusCode).toBe(404);
      expect(res.json().error.message).toBe('Мастер не найден');
    }
    expect((await pub(t, 'GET', '/masters/abc/portfolio')).statusCode).toBe(400);
    expect((await masters()).map((m) => m.id)).toEqual([owner.id]);
  });

  it("a service's works from every working master, newest first, at most 30", async () => {
    const old = await add(fatima.id, 'old', { serviceId: helix.id });
    const newer = await add(owner.id, 'newer', { serviceId: helix.id, caption: 'Двойной' });
    await add(owner.id, 'lobe', { serviceId: lobe.id });
    t.ctx.db.update(portfolioPhotos).set({ createdAt: Date.parse('2026-01-01T00:00:00.000Z') }).run();
    const res = await pub(t, 'GET', `/portfolio?serviceId=${helix.id}`);
    expect(res.json().items).toEqual([
      { imageUrl: '/uploads/newer.jpg', caption: 'Двойной', service: { id: helix.id, name: 'Хеликс' }, master: { id: owner.id, name: owner.name } },
      { imageUrl: '/uploads/old.jpg', caption: null, service: { id: helix.id, name: 'Хеликс' }, master: { id: fatima.id, name: 'Фатима' } },
    ]);
    expect(old.id).toBeLessThan(newer.id);

    await t.api('PATCH', `/api/employees/${fatima.id}`, { active: false });
    expect((await pub(t, 'GET', `/portfolio?serviceId=${helix.id}`)).json().items.map((p: Json) => p.imageUrl)).toEqual(['/uploads/newer.jpg']);

    const now = Date.now();
    t.ctx.db
      .insert(portfolioPhotos)
      .values(Array.from({ length: 40 }, (_, i) => ({ employeeId: owner.id, serviceId: lobe.id, imageUrl: `/uploads/l${i}.jpg`, sort: i + 1, createdAt: now + i })))
      .run();
    const many = (await pub(t, 'GET', `/portfolio?serviceId=${lobe.id}`)).json().items as Json[];
    expect(many).toHaveLength(PUBLIC_SERVICE_PORTFOLIO_LIMIT);
    expect(many[0]!.imageUrl).toBe('/uploads/l39.jpg');

    expect((await pub(t, 'GET', '/portfolio')).statusCode).toBe(400);
    expect((await pub(t, 'GET', '/portfolio?serviceId=9999')).json().items).toEqual([]);
  });

  it('a hidden service is neither named nor listed', async () => {
    await add(fatima.id, 'a', { serviceId: helix.id, caption: 'Хеликс' });
    await t.api('PATCH', `/api/services/${helix.id}`, { active: false });
    const items = (await pub(t, 'GET', `/masters/${fatima.id}/portfolio`)).json().items as Json[];
    expect(items).toEqual([{ imageUrl: '/uploads/a.jpg', caption: 'Хеликс', service: null, master: { id: fatima.id, name: 'Фатима' } }]);
    expect((await pub(t, 'GET', `/portfolio?serviceId=${helix.id}`)).json().items).toEqual([]);
  });

  it('services carry the number of works from working masters', async () => {
    await add(fatima.id, 'a', { serviceId: helix.id });
    await add(owner.id, 'b', { serviceId: helix.id });
    await add(owner.id, 'c');
    const services = (await pub(t, 'GET', '/services')).json().items as Json[];
    expect(services.find((s) => s.id === helix.id)!.portfolio).toBe(2);
    expect(services.find((s) => s.id === lobe.id)!.portfolio).toBe(0);
  });

  it('still answers while online booking is off', async () => {
    await add(fatima.id, 'a', { serviceId: helix.id });
    await t.api('PUT', '/api/settings/studio', { onlineBooking: { enabled: false } });
    expect((await pub(t, 'GET', '/config')).json().enabled).toBe(false);
    expect((await pub(t, 'GET', `/masters/${fatima.id}/portfolio`)).json().items).toHaveLength(1);
    expect((await pub(t, 'GET', `/portfolio?serviceId=${helix.id}`)).json().items).toHaveLength(1);
  });
});
