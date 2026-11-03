import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saleRefunds } from '../src/db/schema.js';
import { REPLAYED_HEADER } from '../src/lib/idempotency.js';
import { createTestApp, make, openShift, type TestApp } from './helpers.js';
import { staff } from './payroll-fixtures.js';

// The client's Telegram notice is another module's job: here we only check it is asked for once per refund.
const notices = vi.hoisted(() => ({ refund: vi.fn(async (_ctx: unknown, _refundId: number) => undefined) }));
vi.mock('../src/domain/sale-messages.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/domain/sale-messages.js')>()),
  sendRefundNotice: notices.refund,
}));

type Json = Record<string, any>;

const NO_PAYMENTS = { cash: 0, card: 0, transfer: 0, qr: 0, deposit: 0, bonus: 0, certificate: 0 };

describe('partial refunds (POST /sales/:id/refund, …/refund/preview)', () => {
  let t: TestApp;
  let labret: { id: number; variants: Array<{ id: number }> };
  let lobe: { id: number };
  let client: { id: number };
  let shiftId: number;

  beforeEach(async () => {
    notices.refund.mockClear();
    t = await createTestApp();
    labret = await make(t, '/api/products', { kind: 'jewelry', name: 'Лабрет', price: 1500, variants: [{ name: '8 мм', initialQuantity: 5 }] });
    lobe = await make(t, '/api/services', { name: 'Прокол мочки', category: 'piercing', price: 2500, durationMin: 30 });
    client = await make(t, '/api/clients', { name: 'Анна', phone: '+79991234567' });
    shiftId = await openShift(t, 1000);
  });
  afterEach(async () => {
    await t.close();
  });

  const sell = (body: Json) => make(t, '/api/sales', { discount: 0, ...body });
  /** 2 × «Лабрет — 8 мм» (3 000) + «Прокол мочки» (2 500) − 550 = 4 950: cash 2 950, transfer 2 000. */
  const mixedSale = () =>
    sell({
      clientId: client.id,
      items: [
        { type: 'product', productId: labret.id, variantId: labret.variants[0]!.id, quantity: 2, price: 1500 },
        { type: 'service', serviceId: lobe.id, quantity: 1 },
      ],
      discount: 550,
      payments: { cash: 2950, transfer: 2000 },
    });
  const refund = (id: number, body: Json) => t.api('POST', `/api/sales/${id}/refund`, { restock: true, ...body });
  const preview = (id: number, body: Json = {}) => t.api('POST', `/api/sales/${id}/refund/preview`, body);
  const refunded = async (id: number, body: Json) => {
    const res = await refund(id, body);
    if (res.statusCode !== 200) throw new Error(`refund → ${res.statusCode}: ${res.body}`);
    return res.json();
  };
  const stockOf = async () => (await t.api('GET', `/api/products/${labret.id}`)).json().quantity;
  const sumOf = (refunds: Json[], part: string) => refunds.reduce((s, r) => s + r.payments[part], 0);

  it('returns units with their share of the discount, then exactly what is left', async () => {
    const sale = await mixedSale();
    expect(sale).toMatchObject({ total: 4950, bonusEarned: 247, refundedTotal: 0, refunds: [] });
    const [line, service] = sale.items;
    expect(line).toMatchObject({ name: 'Лабрет — 8 мм', quantity: 2, refundedQuantity: 0 });
    expect(await stockOf()).toBe(3);

    // Lines net of the discount: 3 000 − 300 = 2 700 (1 350 a unit) and 2 500 − 250 = 2 250.
    const one = { items: [{ saleItemId: line.id, quantity: 1 }] };
    const planned = await preview(sale.id, one);
    expect(planned.statusCode).toBe(200);
    expect(planned.json()).toEqual({
      amount: 1350,
      items: [{ saleItemId: line.id, name: 'Лабрет — 8 мм', quantity: 1, amount: 1350 }],
      // 1 350 in proportion to 2 950 / 2 000 → 804 + 545, the leftover ruble to cash.
      payments: { ...NO_PAYMENTS, cash: 805, transfer: 545 },
      // floor(247 × 1 350 / 4 950)
      bonusTakenBack: 67,
      needsShift: false,
    });
    // The preview wrote nothing.
    expect((await t.api('GET', `/api/sales/${sale.id}`)).json()).toMatchObject({ refundedTotal: 0, refunds: [] });

    const partial = await refunded(sale.id, { ...one, reason: 'Не подошёл размер' });
    expect(partial).toMatchObject({
      status: 'completed',
      refundedAt: null,
      refundReason: null,
      refundedTotal: 1350,
      items: [{ id: line.id, refundedQuantity: 1 }, { id: service.id, refundedQuantity: 0 }],
    });
    expect(partial.refunds).toEqual([
      {
        id: expect.any(Number),
        saleId: sale.id,
        items: planned.json().items,
        amount: 1350,
        payments: planned.json().payments,
        bonusTakenBack: 67,
        restock: true,
        reason: 'Не подошёл размер',
        employee: { id: 1, name: 'Админ', color: '#FF7A1A' },
        shiftId,
        createdAt: expect.any(String),
      },
    ]);
    expect(await stockOf()).toBe(4);
    const moves = (await t.api('GET', `/api/products/${labret.id}/movements`)).json().items;
    expect(moves[0]).toMatchObject({ type: 'return', delta: 1, saleId: sale.id, note: 'Не подошёл размер' });

    // Everything left (older builds send no items): the rest of each line and of each payment part.
    const restPlan = (await preview(sale.id)).json();
    expect(restPlan).toEqual({
      amount: 3600,
      items: [
        { saleItemId: line.id, name: 'Лабрет — 8 мм', quantity: 1, amount: 1350 },
        { saleItemId: service.id, name: 'Прокол мочки', quantity: 1, amount: 2250 },
      ],
      payments: { ...NO_PAYMENTS, cash: 2145, transfer: 1455 },
      bonusTakenBack: 180,
      needsShift: false,
    });
    const full = await refunded(sale.id, { reason: 'Передумала' });
    expect(full).toMatchObject({ status: 'refunded', refundReason: 'Передумала', refundedTotal: 4950 });
    expect(full.refundedAt).toBe(full.refunds[1].createdAt);
    expect(full.items.map((i: Json) => i.refundedQuantity)).toEqual([2, 1]);
    expect(full.refunds.map((r: Json) => r.amount)).toEqual([1350, 3600]);
    expect(full.refunds[1]).toMatchObject({ items: restPlan.items, payments: restPlan.payments, bonusTakenBack: 180 });
    // Σ refunds = the receipt, part by part; the earned bonuses are all taken back.
    expect(sumOf(full.refunds, 'cash')).toBe(2950);
    expect(sumOf(full.refunds, 'transfer')).toBe(2000);
    expect(full.refunds.reduce((s: number, r: Json) => s + r.bonusTakenBack, 0)).toBe(247);
    expect(await stockOf()).toBe(5);

    for (const res of [await refund(sale.id, { reason: 'Ещё раз' }), await preview(sale.id)]) {
      expect(res.statusCode).toBe(409);
      expect(res.json().error.message).toBe(`Чек №${sale.number} уже возвращён`);
    }
    expect((await t.api('GET', `/api/clients/${client.id}`)).json().stats.totalSpent).toBe(0);
  });

  it('splits every refund across what each payment part has left, leftover rubles in order', async () => {
    // 3 × 1 000 − 100 = 2 900 (966 a unit, rounded down): cash 967, transfer 967, card 966.
    const sale = await sell({
      items: [{ type: 'service', name: 'Сеанс', quantity: 3, price: 1000 }],
      discount: 100,
      payments: { cash: 967, transfer: 967, card: 966 },
    });
    const unit = { items: [{ saleItemId: sale.items[0].id, quantity: 1 }] };
    const first = (await refunded(sale.id, { ...unit, reason: 'Первый' })).refunds[0];
    // 322.1 / 322.1 / 321.8 → 322 + 322 + 321 = 965, the leftover ruble to cash.
    expect(first).toMatchObject({ amount: 966, payments: { cash: 323, transfer: 322, card: 321 } });
    const second = (await refunded(sale.id, { ...unit, reason: 'Второй' })).refunds[1];
    // Rests 644 / 645 / 645 → 321 + 322 + 322 = 965, the leftover to cash.
    expect(second).toMatchObject({ amount: 966, payments: { cash: 322, transfer: 322, card: 322 } });
    const last = await refunded(sale.id, { ...unit, reason: 'Третий' });
    // The last unit returns exactly the rest: 2 900 − 1 932, every part's rest.
    expect(last.refunds[2]).toMatchObject({ amount: 968, payments: { cash: 322, transfer: 323, card: 323 } });
    expect(last).toMatchObject({ status: 'refunded', refundedTotal: 2900 });
    for (const [part, paid] of Object.entries({ cash: 967, transfer: 967, card: 966 })) {
      expect(sumOf(last.refunds, part)).toBe(paid);
    }
  });

  it('validates the lines and units to return, like the preview', async () => {
    const sale = await mixedSale();
    const [line, service] = sale.items;
    const cases: Array<[Json, number, string | null]> = [
      [{ items: [{ saleItemId: 99_999, quantity: 1 }] }, 400, `Позиция не найдена в чеке №${sale.number}`],
      [{ items: [{ saleItemId: line.id, quantity: 1 }, { saleItemId: line.id, quantity: 1 }] }, 400, 'Позиция «Лабрет — 8 мм» указана дважды'],
      [{ items: [{ saleItemId: line.id, quantity: 3 }] }, 400, 'Можно вернуть не больше 2 шт «Лабрет — 8 мм»'],
      [{ items: [{ saleItemId: line.id, quantity: 0 }] }, 400, null],
      [{ items: [] }, 400, null],
    ];
    for (const [body, status, message] of cases) {
      for (const res of [await refund(sale.id, { ...body, reason: 'Проверка' }), await preview(sale.id, body)]) {
        expect(res.statusCode).toBe(status);
        if (message) expect(res.json().error.message).toBe(message);
      }
    }
    expect((await refund(sale.id, { reason: '' })).statusCode).toBe(400);
    expect((await refund(99_999, { reason: 'Нет такого' })).statusCode).toBe(404);
    expect((await preview(99_999)).statusCode).toBe(404);

    await refunded(sale.id, { items: [{ saleItemId: service.id, quantity: 1 }], reason: 'Не стали прокалывать' });
    const again = await refund(sale.id, { items: [{ saleItemId: service.id, quantity: 1 }], reason: 'Снова' });
    expect(again.statusCode).toBe(400);
    expect(again.json().error.message).toBe('Позиция «Прокол мочки» уже возвращена');
    const tooMany = await preview(sale.id, { items: [{ saleItemId: line.id, quantity: 2 }, { saleItemId: service.id, quantity: 1 }] });
    expect(tooMany.json().error.message).toBe('Позиция «Прокол мочки» уже возвращена');
    expect((await t.api('GET', `/api/sales/${sale.id}`)).json()).toMatchObject({ refundedTotal: 2250, status: 'completed' });
  });

  it('needs an open shift for the cash part only; the preview says so instead of refusing', async () => {
    const cash = await mixedSale();
    const byTransfer = await sell({ items: [{ type: 'service', serviceId: lobe.id, quantity: 1 }], payments: { transfer: 2500 } });
    await t.api('POST', '/api/cash/shift/close', { closingCash: 3950 });

    const one = { items: [{ saleItemId: cash.items[0].id, quantity: 1 }] };
    const blocked = await refund(cash.id, { ...one, reason: 'Нет смены' });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toEqual({ code: 'conflict', message: 'Откройте смену, чтобы вернуть наличные' });
    expect((await preview(cash.id, one)).json()).toMatchObject({ amount: 1350, needsShift: true });
    expect((await t.api('GET', `/api/sales/${cash.id}`)).json()).toMatchObject({ refundedTotal: 0, refunds: [] });
    expect(await stockOf()).toBe(3);

    expect((await preview(byTransfer.id)).json()).toMatchObject({ amount: 2500, payments: { transfer: 2500 }, needsShift: false });
    const noShift = await refunded(byTransfer.id, { reason: 'Перевод вернули' });
    expect(noShift.refunds[0]).toMatchObject({ shiftId: null, payments: { cash: 0, transfer: 2500 } });

    const reopened = await openShift(t);
    expect((await preview(cash.id, one)).json().needsShift).toBe(false);
    expect((await refunded(cash.id, { ...one, reason: 'Смена открыта' })).refunds[0].shiftId).toBe(reopened);
  });

  it('records a replayed refund once and asks for one client notice per refund', async () => {
    const sale = await mixedSale();
    const send = () =>
      t.app.inject({
        method: 'POST',
        url: `/api/sales/${sale.id}/refund`,
        headers: { authorization: `Bearer ${t.token}`, 'idempotency-key': '6f1c1b1e-7a3d-4c55-9a43-0d3f0e7b5a11' },
        payload: { reason: 'Не подошёл', restock: true, items: [{ saleItemId: sale.items[0].id, quantity: 1 }] },
      });
    const first = await send();
    const replay = await send();
    expect(first.statusCode).toBe(200);
    expect(replay.headers[REPLAYED_HEADER]).toBe('true');
    expect(replay.json()).toEqual(first.json());
    expect(t.ctx.db.select().from(saleRefunds).all()).toHaveLength(1);
    expect(await stockOf()).toBe(4);
    expect(notices.refund).toHaveBeenCalledTimes(1);
    expect(notices.refund).toHaveBeenCalledWith(t.ctx, first.json().refunds[0].id);

    await preview(sale.id);
    expect(notices.refund).toHaveBeenCalledTimes(1);
    const rest = await refunded(sale.id, { reason: 'Остальное' });
    expect(notices.refund).toHaveBeenLastCalledWith(t.ctx, rest.refunds[1].id);
  });

  it('lets every role preview and make a refund', async () => {
    const sale = await mixedSale();
    const master = await staff(t, 'Фатима', 'fatima', 'master');
    const one = { items: [{ saleItemId: sale.items[0].id, quantity: 1 }] };
    const planned = await master.api('POST', `/api/sales/${sale.id}/refund/preview`, one);
    expect(planned.statusCode).toBe(200);
    const done = await master.api('POST', `/api/sales/${sale.id}/refund`, { ...one, reason: 'Брак', restock: true });
    expect(done.statusCode).toBe(200);
    expect(done.json().refunds[0]).toMatchObject({ amount: planned.json().amount, employee: { id: master.id, name: 'Фатима' } });
  });

  it('lists sales with their refunds and logs refunds in words (never the preview)', async () => {
    const sale = await mixedSale();
    const plain = await sell({ items: [{ type: 'service', serviceId: lobe.id, quantity: 1 }], payments: { cash: 2500 }, clientId: client.id });
    const [line] = sale.items;
    await preview(sale.id);
    await refunded(sale.id, { items: [{ saleItemId: line.id, quantity: 1 }], reason: 'Не подошёл размер' });
    const latest = async () => (await t.api('GET', '/api/audit?entity=sale')).json().items[0];
    expect(await latest()).toMatchObject({
      action: 'sale.refund',
      entityId: sale.id,
      summary: `Возврат по чеку №${sale.number}: Лабрет — 8 мм × 1, 1 350 ₽. Причина: Не подошёл размер`,
    });
    await refunded(sale.id, { reason: 'Передумала', restock: false });
    expect((await latest()).summary).toBe(
      `Возврат по чеку №${sale.number}: Лабрет — 8 мм × 1, Прокол мочки × 1, 3 600 ₽ — чек возвращён полностью. Причина: Передумала. ` +
        'Товар не возвращён на склад',
    );
    await refunded(plain.id, { reason: 'Отказ' });
    expect((await latest()).summary).toBe(`Продажа №${plain.number} возвращена: 2 500 ₽. Причина: Отказ`);
    const logged = (await t.api('GET', '/api/audit?entity=sale')).json().items.map((e: Json) => e.action);
    expect(logged.filter((a: string) => a === 'sale.refund')).toHaveLength(3);

    const list = (await t.api('GET', `/api/sales?clientId=${client.id}`)).json();
    expect(list.items.map((s: Json) => [s.id, s.refundedTotal, s.refunds.map((r: Json) => r.amount)])).toEqual([
      [plain.id, 2500, [2500]],
      [sale.id, 4950, [1350, 3600]],
    ]);
    expect(list.items[1].refunds[1]).toMatchObject({ restock: false, reason: 'Передумала', employee: { id: 1 } });
  });
});
