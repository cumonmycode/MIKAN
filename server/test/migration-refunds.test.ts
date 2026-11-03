import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../src/db/client.js';
import * as schema from '../src/db/schema.js';
import { shiftSummary } from '../src/domain/cash.js';
import { getSaleRow, serializeSale } from '../src/domain/refs.js';
import { reportSummary } from '../src/domain/reports.js';

/** A copy of the migrations folder that stops before `0021` (partial refunds). */
function migrationsBeforeRefunds(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mikan-migrations-'));
  fs.cpSync(MIGRATIONS_DIR, dir, { recursive: true });
  const journalPath = path.join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as { entries: Array<{ tag: string }> };
  journal.entries = journal.entries.filter((e) => e.tag < '0021');
  fs.writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

describe('migration 0021 (partial refunds)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('turns every sale refunded before partial refunds into one refund of everything', () => {
    const before = migrationsBeforeRefunds();
    dirs.push(before);
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: before });

    const t = 1_790_000_000_000;
    sqlite.exec(`
      INSERT INTO employees (id, name, login, password_hash, color, created_at, updated_at) VALUES (1, 'Анна', 'anna', 'x', '#FF7A1A', ${t}, ${t});
      INSERT INTO clients (id, name, name_sort, created_at, updated_at) VALUES (1, 'Иван', 'иван', ${t}, ${t});
      INSERT INTO cash_shifts (id, opened_at, opened_by_id, opening_cash) VALUES (1, ${t}, 1, 0);
      INSERT INTO products (id, kind, name, name_sort, price, created_at, updated_at) VALUES (1, 'jewelry', 'Лабрет', 'лабрет', 900, ${t}, ${t});
      INSERT INTO product_variants (id, product_id, name, quantity, created_at, updated_at) VALUES (1, 1, '8 мм', 5, ${t}, ${t});
      INSERT INTO sales (id, number, client_id, employee_id, shift_id, subtotal, discount, total, pay_cash, pay_transfer, pay_bonus, status,
                         refunded_at, refund_reason, refund_shift_id, refunded_by_id, created_at) VALUES
        (1, 1, 1, 1, 1, 3300, 300, 3000, 2000, 500, 500, 'refunded', ${t + 100}, 'Брак', 1, 1, ${t}),
        (2, 2, 1, 1, 1, 1000, 0, 1000, 1000, 0, 0, 'completed', NULL, NULL, NULL, NULL, ${t + 10}),
        (3, 3, NULL, 1, NULL, 700, 0, 700, 0, 700, 0, 'refunded', NULL, NULL, NULL, NULL, ${t + 20});
      INSERT INTO sale_items (id, sale_id, type, product_id, variant_id, name, quantity, price, total) VALUES
        (1, 1, 'product', 1, 1, 'Лабрет — 8 мм', 2, 900, 1800),
        (2, 1, 'service', NULL, NULL, 'Прокол мочки', 1, 1500, 1500),
        (3, 2, 'service', NULL, NULL, 'Консультация', 1, 1000, 1000),
        (4, 3, 'service', NULL, NULL, 'Коррекция', 1, 700, 700);
      INSERT INTO bonus_operations (client_id, type, amount, remaining, sale_id, created_at) VALUES
        (1, 'earn', 125, 0, 1, ${t}), (1, 'spend', -500, 0, 1, ${t}), (1, 'reverse', 500, 500, 1, ${t + 100}), (1, 'reverse', -125, 0, 1, ${t + 100});
      INSERT INTO stock_movements (product_id, variant_id, delta, quantity_after, type, sale_id, created_at) VALUES
        (1, 1, -2, 3, 'sale', 1, ${t}), (1, 1, 2, 5, 'return', 1, ${t + 100});
    `);

    migrate(db, { migrationsFolder: MIGRATIONS_DIR });

    expect(
      sqlite
        .prepare(
          'SELECT sale_id, amount, pay_cash, pay_transfer, pay_bonus, bonus_taken_back, restock, reason, employee_id, shift_id, created_at FROM sale_refunds ORDER BY id',
        )
        .all(),
    ).toEqual([
      { sale_id: 1, amount: 3000, pay_cash: 2000, pay_transfer: 500, pay_bonus: 500, bonus_taken_back: 125, restock: 1, reason: 'Брак', employee_id: 1, shift_id: 1, created_at: t + 100 },
      { sale_id: 3, amount: 700, pay_cash: 0, pay_transfer: 700, pay_bonus: 0, bonus_taken_back: 0, restock: 0, reason: '', employee_id: null, shift_id: null, created_at: t + 20 },
    ]);
    expect(sqlite.prepare('SELECT id, refunded_quantity FROM sale_items ORDER BY id').all()).toEqual([
      { id: 1, refunded_quantity: 2 },
      { id: 2, refunded_quantity: 1 },
      { id: 3, refunded_quantity: 0 },
      { id: 4, refunded_quantity: 1 },
    ]);
    expect(sqlite.prepare('SELECT id, refunded_total FROM sales ORDER BY id').all()).toEqual([
      { id: 1, refunded_total: 3000 },
      { id: 2, refunded_total: 0 },
      { id: 3, refunded_total: 700 },
    ]);

    // Read through the API serializer: one refund of everything, the lines at their share of the discount.
    const sale = serializeSale(db, getSaleRow(db, 1));
    expect(sale).toMatchObject({ status: 'refunded', refundedTotal: 3000, refundReason: 'Брак' });
    expect(sale.items.map((i) => i.refundedQuantity)).toEqual([2, 1]);
    expect(sale.refunds).toEqual([
      {
        id: expect.any(Number),
        saleId: 1,
        items: [
          { saleItemId: 1, name: 'Лабрет — 8 мм', quantity: 2, amount: 1636 },
          { saleItemId: 2, name: 'Прокол мочки', quantity: 1, amount: 1364 },
        ],
        amount: 3000,
        payments: { cash: 2000, card: 0, transfer: 500, qr: 0, deposit: 0, bonus: 500, certificate: 0 },
        bonusTakenBack: 125,
        restock: true,
        reason: 'Брак',
        employee: { id: 1, name: 'Анна', color: '#FF7A1A' },
        shiftId: 1,
        createdAt: new Date(t + 100).toISOString(),
      },
    ]);
    expect(serializeSale(db, getSaleRow(db, 2)).refunds).toEqual([]);

    // Money counts as it did: the shift's refunds by their money, the report's by their revenue.
    expect(shiftSummary(db, 1)).toMatchObject({ salesCount: 2, refunds: 2500, cashRefunds: 2000 });
    expect(reportSummary(db, t, t + 1000)).toMatchObject({ revenue: 1000, salesCount: 1, refunds: 2500 + 700 });
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    sqlite.close();
  });

  it('gives a certificate line its whole nominal and splits the discount over the other lines only', () => {
    const before = migrationsBeforeRefunds();
    dirs.push(before);
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: before });

    const t = 1_790_000_000_000;
    sqlite.exec(`
      INSERT INTO employees (id, name, login, password_hash, color, created_at, updated_at) VALUES (1, 'Анна', 'anna', 'x', '#FF7A1A', ${t}, ${t});
      INSERT INTO sales (id, number, employee_id, subtotal, discount, total, pay_cash, status, refunded_at, refund_reason, created_at) VALUES
        (1, 1, 1, 2000, 200, 1800, 1800, 'refunded', ${t + 100}, 'Передумал', ${t});
      INSERT INTO sale_items (id, sale_id, type, certificate_id, name, quantity, price, total) VALUES
        (1, 1, 'service', NULL, 'Прокол мочки', 1, 1000, 1000),
        (2, 1, 'certificate', 7, 'Подарочный сертификат', 1, 1000, 1000);
    `);

    migrate(db, { migrationsFolder: MIGRATIONS_DIR });

    expect(sqlite.prepare('SELECT sale_item_id, amount FROM sale_refund_items ORDER BY id').all()).toEqual([
      { sale_item_id: 1, amount: 800 },
      { sale_item_id: 2, amount: 1000 },
    ]);
    sqlite.close();
  });
});
