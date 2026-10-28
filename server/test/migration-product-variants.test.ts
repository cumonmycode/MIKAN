import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../src/db/client.js';
import * as schema from '../src/db/schema.js';
import { serializeProduct } from '../src/domain/products.js';
import { applyBankStatus } from '../src/domain/qr-payments.js';
import { getSaleRow, serializeSale } from '../src/domain/refs.js';
import { refundSale } from '../src/domain/refunds.js';
import { createSale } from '../src/domain/sales.js';
import { getProductRow, listMovements } from '../src/domain/stock.js';

/** A copy of the migrations folder that stops before `0007_product_variants`. */
function migrationsBeforeVariants(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mikan-migrations-'));
  fs.cpSync(MIGRATIONS_DIR, dir, { recursive: true });
  const journalPath = path.join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as { entries: Array<{ tag: string }> };
  journal.entries = journal.entries.filter((e) => e.tag < '0007');
  fs.writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

describe('migration 0007_product_variants', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('turns every product into one size with its stock, history, sales and pending QR carts intact', () => {
    const before = migrationsBeforeVariants();
    dirs.push(before);
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: before });

    const t = 1_790_000_000_000;
    const cart = JSON.stringify({
      items: [{ type: 'product', productId: 1, quantity: 1, price: 1500 }],
      discount: 0,
      payments: { cash: 0, card: 0, transfer: 0, qr: 1500 },
    });
    sqlite.exec(`
      INSERT INTO employees (id, name, login, password_hash, color, created_at, updated_at) VALUES (1, 'Анна', 'anna', 'x', '#FF7A1A', ${t}, ${t});
      INSERT INTO products (id, kind, name, name_sort, sku, category, category_sort, material, size, price, cost, quantity, min_quantity, unit, photo_url, active, search_text, created_at, updated_at) VALUES
        (1, 'jewelry', 'Лабрет', 'лабрет', 'LB-12-08', 'Лабрет', 'лабрет', 'Титан G23', ' 1.2×8 мм ', 1500, 600, 7, 3, 'шт', '/uploads/labret.jpg', 1, 'лабрет lb-12-08 лабрет титан g23 1.2×8 мм', ${t}, ${t + 5}),
        (2, 'consumable', 'Иглы', 'иглы', NULL, NULL, '', NULL, NULL, 0, 40, 0, 0, 'шт', NULL, 1, 'иглы', ${t}, ${t});
      INSERT INTO stock_movements (id, product_id, delta, quantity_after, type, note, employee_id, created_at) VALUES
        (1, 1, 10, 10, 'receipt', 'Начальный остаток', 1, ${t}),
        (2, 1, -3, 7, 'sale', NULL, 1, ${t + 1});
      INSERT INTO sales (id, number, employee_id, subtotal, total, pay_transfer, status, created_at) VALUES (1, 1, 1, 7000, 7000, 7000, 'completed', ${t + 1});
      INSERT INTO sale_items (id, sale_id, type, product_id, service_id, name, quantity, price, total) VALUES
        (1, 1, 'product', 1, NULL, 'Лабрет', 3, 1500, 4500),
        (2, 1, 'service', NULL, NULL, 'Прокол', 1, 2500, 2500);
      INSERT INTO qr_payments (id, kind, provider, external_id, payload, amount, status, sale_input_json, employee_id, expires_at, created_at, updated_at)
        VALUES (5, 'sale', 'tochka', 'AS5', 'https://qr.nspk.ru/AS5', 1500, 'pending', '${cart}', 1, ${t + 600_000}, ${t}, ${t});
    `);

    migrate(db, { migrationsFolder: MIGRATIONS_DIR });

    expect(sqlite.prepare('SELECT id, product_id, name, quantity, min_quantity, archived, position FROM product_variants ORDER BY id').all()).toEqual([
      { id: 1, product_id: 1, name: '1.2×8 мм', quantity: 7, min_quantity: 3, archived: 0, position: 0 },
      { id: 2, product_id: 2, name: '', quantity: 0, min_quantity: 0, archived: 0, position: 0 },
    ]);
    const columns = (sqlite.prepare('PRAGMA table_info(products)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns).not.toContain('size');
    expect(columns).not.toContain('quantity');
    expect(columns).not.toContain('min_quantity');
    expect(sqlite.prepare('SELECT id, variant_id, delta, quantity_after FROM stock_movements ORDER BY id').all()).toEqual([
      { id: 1, variant_id: 1, delta: 10, quantity_after: 10 },
      { id: 2, variant_id: 1, delta: -3, quantity_after: 7 },
    ]);
    expect(sqlite.prepare('SELECT id, variant_id, variant_name, name FROM sale_items ORDER BY id').all()).toEqual([
      { id: 1, variant_id: 1, variant_name: null, name: 'Лабрет' },
      { id: 2, variant_id: null, variant_name: null, name: 'Прокол' },
    ]);
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

    // The API reads the old product exactly as before: same totals, the old size, the photo.
    expect(serializeProduct(db, getProductRow(db, 1))).toMatchObject({
      quantity: 7,
      minQuantity: 3,
      lowStock: false,
      size: '1.2×8 мм',
      photos: ['/uploads/labret.jpg'],
      photoUrl: '/uploads/labret.jpg',
      serviceIds: [],
      threadType: null,
      variants: [{ id: 1, name: '1.2×8 мм', quantity: 7 }],
    });
    expect(serializeProduct(db, getProductRow(db, 2))).toMatchObject({ size: null, variants: [{ id: 2, name: '' }] });
    expect(listMovements(db, { productId: 1, limit: 10, offset: 0 }).items.map((m) => [m.id, m.variantName])).toEqual([
      [2, '1.2×8 мм'],
      [1, '1.2×8 мм'],
    ]);

    // An old sale is refunded into the size; a new sale without variantId (older builds) still works.
    refundSale(db, 1, { reason: 'Возврат', restock: true }, 1);
    expect(serializeProduct(db, getProductRow(db, 1)).quantity).toBe(10);
    const sale = createSale(
      db,
      { items: [{ type: 'product', productId: 1, quantity: 1 }], discount: 0, payments: { cash: 0, card: 0, transfer: 1500, qr: 0, deposit: 0 } },
      1,
    );
    expect(serializeSale(db, getSaleRow(db, sale.id)).items[0]).toMatchObject({ variantId: 1, variantName: '1.2×8 мм', name: 'Лабрет — 1.2×8 мм' });
    const newest = sqlite.prepare('SELECT max(id) AS id FROM stock_movements').get() as { id: number };
    expect(newest.id).toBeGreaterThan(2);

    // The QR cart frozen before the migration (no variantId) is sold when the bank confirms it.
    const paid = applyBankStatus(db, 5, 'paid', t + 60_000);
    expect(paid).toMatchObject({ status: 'paid', error: null });
    expect(serializeSale(db, getSaleRow(db, paid.saleId!)).items[0]).toMatchObject({ variantId: 1, price: 1500 });
    expect(serializeProduct(db, getProductRow(db, 1)).quantity).toBe(8);
    sqlite.close();
  });
});
