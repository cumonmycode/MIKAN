import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../src/db/client.js';
import * as schema from '../src/db/schema.js';
import { listCategories } from '../src/domain/categories.js';
import { createTestApp, make, openShift, type TestApp } from './helpers.js';

interface Category {
  id: number;
  name: string;
  position: number;
  itemCount: number;
  serviceCategory: string | null;
}

describe('unified warehouse', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
    await openShift(t);
  });
  afterEach(async () => {
    await t.close();
  });

  const categories = async (section: string): Promise<Category[]> =>
    (await t.api('GET', `/api/catalog/categories?section=${section}`)).json().items;
  const names = (list: Category[]) => list.map((c) => [c.name, c.position, c.itemCount]);

  describe('categories', () => {
    it('items register their categories; matching names reuse the stored spelling', async () => {
      await make(t, '/api/products', { kind: 'jewelry', name: 'Лабрет', category: 'Лабрет', price: 1500 });
      const ring = await make(t, '/api/products', { kind: 'jewelry', name: 'Кольцо', category: ' лабрёт ', price: 900 });
      expect(ring.category).toBe('Лабрет');
      await make(t, '/api/products', { kind: 'goods', name: 'Спрей', category: 'Уход', price: 700 });
      await make(t, '/api/services', { name: 'Хеликс', category: 'piercing', group: 'Ухо', price: 3000, durationMin: 30 });
      await make(t, '/api/services', { name: 'Мини тату', category: 'tattoo', group: 'Ухо', price: 3000, durationMin: 30 });

      expect(names(await categories('jewelry'))).toEqual([['Лабрет', 0, 2]]);
      expect(names(await categories('goods'))).toEqual([['Уход', 0, 1]]);
      const services = await categories('service');
      expect(services.map((c) => [c.serviceCategory, c.name])).toEqual([
        ['piercing', 'Ухо'],
        ['tattoo', 'Ухо'],
      ]);
    });

    it('creates, renames (items follow), orders, merges and deletes', async () => {
      const labret = await make(t, '/api/products', { kind: 'jewelry', name: 'Лабрет', category: 'Лабреты', price: 1500 });
      await make(t, '/api/products', { kind: 'jewelry', name: 'Кольцо', category: 'Кольца', price: 900 });
      const empty = await make(t, '/api/catalog/categories', { section: 'jewelry', name: 'Септум' });
      expect(empty).toMatchObject({ name: 'Септум', position: 2, itemCount: 0, serviceCategory: null });
      const dup = await t.api('POST', '/api/catalog/categories', { section: 'jewelry', name: 'кольца' });
      expect(dup.statusCode).toBe(409);
      expect(dup.json().error.message).toBe('Категория «Кольца» уже есть');
      expect((await t.api('POST', '/api/catalog/categories', { section: 'service', name: 'Ухо' })).statusCode).toBe(400);

      const [lab, rings] = await categories('jewelry');
      const renamed = await t.api('PATCH', `/api/catalog/categories/${lab!.id}`, { name: 'Лабреты титан' });
      expect(renamed.json()).toMatchObject({ name: 'Лабреты титан', itemCount: 1 });
      expect((await t.api('GET', `/api/products/${labret.id}`)).json().category).toBe('Лабреты титан');
      expect((await t.api('GET', '/api/products?search=титан')).json().items.map((p: { id: number }) => p.id)).toEqual([labret.id]);

      const ordered = await t.api('PUT', '/api/catalog/categories/order', { ids: [empty.id, rings!.id, lab!.id] });
      expect(names(ordered.json().items)).toEqual([
        ['Септум', 0, 0],
        ['Кольца', 1, 1],
        ['Лабреты титан', 2, 1],
      ]);
      expect((await t.api('PUT', '/api/catalog/categories/order', { ids: [empty.id] })).statusCode).toBe(400);

      const merged = await t.api('POST', `/api/catalog/categories/${lab!.id}/merge`, { intoId: rings!.id });
      expect(merged.json()).toMatchObject({ name: 'Кольца', itemCount: 2 });
      expect((await t.api('GET', `/api/products/${labret.id}`)).json().category).toBe('Кольца');
      expect(names(await categories('jewelry'))).toEqual([
        ['Септум', 0, 0],
        ['Кольца', 1, 2],
      ]);

      expect((await t.api('DELETE', `/api/catalog/categories/${rings!.id}`)).statusCode).toBe(204);
      expect((await t.api('GET', `/api/products/${labret.id}`)).json().category).toBeNull();
      expect(names(await categories('jewelry'))).toEqual([['Септум', 0, 0]]);
    });

    it('a product or service moved to another section takes its category along', async () => {
      const p = await make(t, '/api/products', { kind: 'jewelry', name: 'Спрей', category: 'Уход', price: 700 });
      await t.api('PATCH', `/api/products/${p.id}`, { kind: 'goods' });
      expect(names(await categories('goods'))).toEqual([['Уход', 0, 1]]);
      expect(names(await categories('jewelry'))).toEqual([['Уход', 0, 0]]);
      const s = await make(t, '/api/services', { name: 'Чистка', category: 'piercing', group: 'Доп. услуги', price: 500, durationMin: 15 });
      await t.api('PATCH', `/api/services/${s.id}`, { category: 'other' });
      expect((await categories('service')).map((c) => [c.serviceCategory, c.name, c.itemCount])).toEqual([
        ['other', 'Доп. услуги', 1],
        ['piercing', 'Доп. услуги', 0],
      ]);
    });

    it('registers category names written outside the API (imports)', () => {
      t.ctx.sqlite.exec(`INSERT INTO services (name, category, group_name, price, duration_min, created_at, updated_at) VALUES ('Бровь', 'piercing', 'Лицо', 2000, 30, 1, 1)`);
      expect(listCategories(t.ctx.db, 'service').map((c) => c.name)).toEqual(['Лицо']);
    });
  });

  describe('goods and presence consumables', () => {
    it('sells goods with sizes like jewelry', async () => {
      const spray = await make(t, '/api/products', {
        kind: 'goods', name: 'Спрей', price: 700, variants: [{ name: '50 мл', initialQuantity: 2 }, { name: '100 мл', price: 1100, initialQuantity: 1 }],
      });
      const sale = await t.api('POST', '/api/sales', {
        items: [{ type: 'product', productId: spray.id, variantId: spray.variants[1].id, quantity: 1 }], discount: 0, payments: { cash: 1100 },
      });
      expect(sale.json().items[0]).toMatchObject({ name: 'Спрей — 100 мл', price: 1100 });
    });

    it('tracks a consumable as «есть / заканчивается / нет»', async () => {
      const soap = await make(t, '/api/products', { kind: 'consumable', name: 'Мыло', stockMode: 'presence' });
      expect(soap).toMatchObject({ stockMode: 'presence', presenceStatus: 'out', lowStock: true });
      const ok = await t.api('PATCH', `/api/products/${soap.id}`, { presenceStatus: 'ok' });
      expect(ok.json()).toMatchObject({ presenceStatus: 'ok', lowStock: false });
      const move = await t.api('POST', `/api/products/${soap.id}/movements`, { type: 'receipt', quantity: 1 });
      expect(move.statusCode).toBe(400);
      expect(move.json().error.message).toBe('«Мыло» учитывается как «есть / нет» — отметьте наличие в карточке расходника');
      await t.api('PATCH', `/api/products/${soap.id}`, { presenceStatus: 'low' });
      expect((await t.api('GET', '/api/products?lowStock=true')).json().items.map((p: { id: number }) => p.id)).toEqual([soap.id]);
      expect((await t.api('GET', '/api/badges')).json().lowStock).toBe(1);

      const gloves = await make(t, '/api/products', { kind: 'consumable', name: 'Перчатки', initialQuantity: 5 });
      expect(gloves).toMatchObject({ stockMode: 'quantity', presenceStatus: null });
      const switched = await t.api('PATCH', `/api/products/${gloves.id}`, { stockMode: 'presence' });
      expect(switched.json()).toMatchObject({ stockMode: 'presence', presenceStatus: 'ok' });
      const jewelry = await t.api('POST', '/api/products', { kind: 'jewelry', name: 'Кольцо', stockMode: 'presence' });
      expect(jewelry.json().error.message).toBe('Учёт «есть / нет» — только для расходников');
      const status = await t.api('PATCH', `/api/products/${(await make(t, '/api/products', { kind: 'consumable', name: 'Иглы' })).id}`, { presenceStatus: 'ok' });
      expect(status.statusCode).toBe(400);
    });
  });

  describe('services: compatible jewelry and consumption norms', () => {
    it('links jewelry from either side and validates kinds', async () => {
      const labret = await make(t, '/api/products', { kind: 'jewelry', name: 'Лабрет', price: 1500, initialQuantity: 1 });
      const needles = await make(t, '/api/products', { kind: 'consumable', name: 'Иглы', initialQuantity: 10 });
      const helix = await make(t, '/api/services', {
        name: 'Хеликс', category: 'piercing', price: 3000, durationMin: 30,
        jewelryIds: [labret.id], consumables: [{ productId: needles.id, quantity: 1 }],
      });
      expect(helix).toMatchObject({ jewelryIds: [labret.id], consumables: [{ productId: needles.id, quantity: 1 }] });
      expect((await t.api('GET', `/api/products/${labret.id}`)).json().serviceIds).toEqual([helix.id]);

      const ring = await make(t, '/api/products', { kind: 'jewelry', name: 'Кольцо', price: 900, serviceIds: [helix.id] });
      expect((await t.api('GET', '/api/services')).json().items[0].jewelryIds).toEqual([labret.id, ring.id]);
      const replaced = await t.api('PATCH', `/api/services/${helix.id}`, { jewelryIds: [ring.id] });
      expect(replaced.json().jewelryIds).toEqual([ring.id]);

      expect((await t.api('PATCH', `/api/services/${helix.id}`, { jewelryIds: [needles.id] })).json().error.message).toBe('Украшение не найдено');
      expect((await t.api('PATCH', `/api/services/${helix.id}`, { consumables: [{ productId: ring.id, quantity: 1 }] })).json().error.message).toBe('Расходник не найден');
      expect(
        (await t.api('PATCH', `/api/services/${helix.id}`, { consumables: [{ productId: needles.id, quantity: 1 }, { productId: needles.id, quantity: 2 }] })).json().error.message,
      ).toBe('Расходник указан дважды');
    });

    it('completing without a list deducts the norms of every service line and reports shortages', async () => {
      const client = await make(t, '/api/clients', { name: 'Иван', phone: '+79991234567' });
      const needles = await make(t, '/api/products', { kind: 'consumable', name: 'Иглы', initialQuantity: 10 });
      const gloves = await make(t, '/api/products', { kind: 'consumable', name: 'Перчатки', initialQuantity: 1 });
      const soap = await make(t, '/api/products', { kind: 'consumable', name: 'Мыло', stockMode: 'presence' });
      const helix = await make(t, '/api/services', {
        name: 'Хеликс', category: 'piercing', price: 3000, durationMin: 30,
        consumables: [{ productId: needles.id, quantity: 1 }, { productId: gloves.id, quantity: 2 }, { productId: soap.id, quantity: 1 }],
      });
      const lobe = await make(t, '/api/services', { name: 'Мочка', category: 'piercing', price: 2000, durationMin: 30, consumables: [{ productId: needles.id, quantity: 2 }] });
      const appt = await make(t, '/api/appointments', {
        clientId: client.id, masterId: 1, services: [{ serviceId: helix.id }, { serviceId: lobe.id }], startsAt: '2026-10-20T10:00:00Z',
      });
      const done = (await t.api('POST', `/api/appointments/${appt.id}/complete`, { sendAftercare: false })).json();
      expect(done.consumption).toEqual({
        used: [
          { productId: needles.id, productName: 'Иглы', quantity: 3 },
          { productId: gloves.id, productName: 'Перчатки', quantity: 1 },
        ],
        shortages: [{ productId: gloves.id, productName: 'Перчатки', needed: 2, deducted: 1 }],
      });
      expect((await t.api('GET', `/api/products/${needles.id}`)).json().quantity).toBe(7);
      const again = (await t.api('POST', `/api/appointments/${appt.id}/complete`, { sendAftercare: false })).json();
      expect(again.consumption).toEqual({ used: [], shortages: [] });
      expect((await t.api('GET', `/api/products/${needles.id}`)).json().quantity).toBe(7);

      // An explicit list is exact and strict (older builds always send one).
      const appt2 = await make(t, '/api/appointments', { clientId: client.id, masterId: 1, services: [{ serviceId: helix.id }], startsAt: '2026-10-21T10:00:00Z' });
      const strict = await t.api('POST', `/api/appointments/${appt2.id}/complete`, { sendAftercare: false, consumables: [{ productId: gloves.id, quantity: 1 }] });
      expect(strict.json().error.code).toBe('insufficient_stock');
      const listed = (await t.api('POST', `/api/appointments/${appt2.id}/complete`, { sendAftercare: false, consumables: [] })).json();
      expect(listed.consumption).toEqual({ used: [], shortages: [] });
      expect((await t.api('GET', `/api/products/${needles.id}`)).json().quantity).toBe(7);
    });

    it('a sale that completes a visit deducts its norms once', async () => {
      const client = await make(t, '/api/clients', { name: 'Иван', phone: '+79991234567' });
      const needles = await make(t, '/api/products', { kind: 'consumable', name: 'Иглы', initialQuantity: 10 });
      const lobe = await make(t, '/api/services', { name: 'Мочка', category: 'piercing', price: 2000, durationMin: 30, consumables: [{ productId: needles.id, quantity: 2 }] });
      const appt = await make(t, '/api/appointments', { clientId: client.id, masterId: 1, services: [{ serviceId: lobe.id }], startsAt: '2026-10-20T10:00:00Z' });
      const sale = await t.api('POST', '/api/sales', {
        appointmentId: appt.id, items: [{ type: 'service', serviceId: lobe.id }], discount: 0, payments: { transfer: 2000, deposit: 0 },
      });
      expect(sale.statusCode).toBe(200);
      expect((await t.api('GET', `/api/products/${needles.id}`)).json().quantity).toBe(8);
      await t.api('POST', `/api/sales/${sale.json().id}/refund`, { reason: 'Ошибка', restock: false });
      expect((await t.api('GET', `/api/products/${needles.id}`)).json().quantity).toBe(8);
    });
  });

  describe('stock counts', () => {
    it('adjusts differing sizes, marks presence consumables and keeps the totals', async () => {
      const labret = await make(t, '/api/products', {
        kind: 'jewelry', name: 'Лабрет', price: 1500, cost: 600, variants: [{ name: '6 мм', initialQuantity: 4 }, { name: '8 мм', cost: 700, initialQuantity: 2 }],
      });
      const soap = await make(t, '/api/products', { kind: 'consumable', name: 'Мыло', stockMode: 'presence', presenceStatus: 'ok' });
      const [six, eight] = labret.variants;
      const post = (body: object, key = 'f47ac10b-58cc-4372-a567-0e02b2c3d479') =>
        t.app.inject({ method: 'POST', url: '/api/stock/revisions', headers: { authorization: `Bearer ${t.token}`, 'idempotency-key': key }, payload: body });
      const body = {
        section: 'jewelry',
        note: 'Конец месяца',
        counts: [{ variantId: six.id, quantity: 3 }, { variantId: eight.id, quantity: 4 }],
        presence: [{ productId: soap.id, status: 'low' }],
      };
      const res = await post(body);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        number: 1, section: 'jewelry', note: 'Конец месяца', counted: 3, changed: 3,
        surplus: 2, shortage: 1, surplusCost: 1400, shortageCost: 600,
        presenceChanges: [{ productId: soap.id, productName: 'Мыло', from: 'ok', to: 'low' }],
      });
      expect(res.json().movements.map((m: { variantName: string; delta: number; note: string; revisionId: number }) => [m.variantName, m.delta, m.note, m.revisionId])).toEqual([
        ['6 мм', -1, 'Ревизия №1 · Конец месяца', res.json().id],
        ['8 мм', 2, 'Ревизия №1 · Конец месяца', res.json().id],
      ]);
      expect((await post(body)).headers['idempotent-replayed']).toBe('true');

      const quiet = await post({ counts: [{ variantId: six.id, quantity: 3 }], presence: [] }, '9b2d6f3a-1111-4c1e-9d6a-3c3b2d1e0f00');
      expect(quiet.json()).toMatchObject({ number: 2, counted: 1, changed: 0, movements: [] });

      const list = (await t.api('GET', '/api/stock/revisions')).json();
      expect(list.total).toBe(2);
      expect(list.items.map((r: { number: number; movements: unknown[] }) => [r.number, r.movements.length])).toEqual([
        [2, 0],
        [1, 0],
      ]);
      expect((await t.api('GET', `/api/stock/revisions/${res.json().id}`)).json().movements).toHaveLength(2);

      const empty = await t.api('POST', '/api/stock/revisions', { counts: [], presence: [] });
      expect(empty.json().error.message).toBe('Ревизия пустая');
      const wrong = await t.api('POST', '/api/stock/revisions', { counts: [], presence: [{ productId: labret.id, status: 'ok' }] });
      expect(wrong.json().error.message).toBe('«Лабрет» считается в штуках — укажите количество');
    });
  });
});

describe('migration 0010_catalog_reorganization', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('registers every category in use, in alphabetical order (services in price-list order)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mikan-migrations-'));
    dirs.push(dir);
    fs.cpSync(MIGRATIONS_DIR, dir, { recursive: true });
    const journalPath = path.join(dir, 'meta', '_journal.json');
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as { entries: Array<{ tag: string }> };
    journal.entries = journal.entries.filter((e) => e.tag < '0010');
    fs.writeFileSync(journalPath, JSON.stringify(journal));
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: dir });
    const t = 1_790_000_000_000;
    sqlite.exec(`
      INSERT INTO products (kind, name, name_sort, category, price, created_at, updated_at) VALUES
        ('jewelry', 'Лабрет', 'лабрет', ' Лабрет ', 1500, ${t}, ${t}),
        ('jewelry', 'Кольцо', 'кольцо', 'Кольца', 900, ${t}, ${t}),
        ('jewelry', 'Банан', 'банан', '', 900, ${t}, ${t}),
        ('consumable', 'Иглы', 'иглы', 'Иглы', 0, ${t}, ${t});
      INSERT INTO services (name, category, group_name, price, duration_min, sort, created_at, updated_at) VALUES
        ('Хеликс', 'piercing', 'Ухо', 3000, 30, 5, ${t}, ${t}),
        ('Бровь', 'piercing', 'Лицо', 2000, 30, 9, ${t}, ${t}),
        ('Замена', 'piercing', 'Доп. услуги', 300, 15, 20, ${t}, ${t}),
        ('Тату', 'tattoo', NULL, 3000, 60, 0, ${t}, ${t});
    `);
    migrate(db, { migrationsFolder: MIGRATIONS_DIR });
    expect(sqlite.prepare('SELECT section, service_category, name, position FROM catalog_categories ORDER BY section, service_category, position').all()).toEqual([
      { section: 'consumable', service_category: '', name: 'Иглы', position: 0 },
      { section: 'jewelry', service_category: '', name: 'Кольца', position: 0 },
      { section: 'jewelry', service_category: '', name: 'Лабрет', position: 1 },
      { section: 'service', service_category: 'piercing', name: 'Ухо', position: 0 },
      { section: 'service', service_category: 'piercing', name: 'Лицо', position: 1 },
      { section: 'service', service_category: 'piercing', name: 'Доп. услуги', position: 2 },
    ]);
    expect(sqlite.prepare("SELECT name, category FROM products ORDER BY id").all()).toEqual([
      { name: 'Лабрет', category: 'Лабрет' },
      { name: 'Кольцо', category: 'Кольца' },
      { name: 'Банан', category: null },
      { name: 'Иглы', category: 'Иглы' },
    ]);
    expect(sqlite.prepare("SELECT stock_mode, presence_status FROM products LIMIT 1").get()).toEqual({ stock_mode: 'quantity', presence_status: 'ok' });
    sqlite.close();
  });
});
