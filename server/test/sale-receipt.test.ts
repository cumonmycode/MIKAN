import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saleRefundItems, saleRefunds } from '../src/db/schema.js';
import { upsertChat } from '../src/domain/bot-chats.js';
import { linkTelegram } from '../src/domain/clients.js';
import { sendRefundNotice } from '../src/domain/sale-messages.js';
import { blocked, createTestApp, FakeQrProvider, make, openShift, type TestApp } from './helpers.js';
import { staff } from './payroll-fixtures.js';

/** The receipt in the client's Telegram and the refund notice — docs/API.md «Receipt in Telegram». */

const NOW = Date.parse('2026-10-20T12:42:00.000Z'); // Tue 15:42 Moscow
const CHAT = 777_100;

type Json = Record<string, any>;

describe('receipt in Telegram', () => {
  let t: TestApp;
  let bank: FakeQrProvider;
  let client: Json;
  let labret: Json;
  let ring: Json;
  let lobe: Json;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    bank = new FakeQrProvider();
    t = await createTestApp({ qr: bank });
    await openShift(t);
    client = await make(t, '/api/clients', { name: 'Анна', lastName: 'Иванова', phone: '+79990001122' });
    labret = await make(t, '/api/products', { kind: 'jewelry', name: 'Лабрет', price: 1500, variants: [{ name: '6 мм', initialQuantity: 5 }, { name: '8 мм', initialQuantity: 5 }] });
    ring = await make(t, '/api/products', { kind: 'jewelry', name: 'Серьга', price: 800, initialQuantity: 5 });
    lobe = await make(t, '/api/services', { name: 'Прокол мочки', category: 'piercing', price: 2500, durationMin: 30, depositAmount: 2000 });
  });
  afterEach(async () => {
    vi.useRealTimers();
    await t.close();
  });

  /** The client starts the bot by their link: the chat exists and is linked to the card. */
  const link = () => {
    upsertChat(t.ctx.db, CHAT, { telegramName: 'Анна' });
    linkTelegram(t.ctx.db, client.id, CHAT, 'anna');
  };
  const texts = () => t.gateway.textsTo(CHAT);
  /** Lets the fire-and-forget sends after a response run. */
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const sale = async (id: number) => (await t.api('GET', `/api/sales/${id}`)).json();
  const sold = async (body: Json) => make(t, '/api/sales', { clientId: client.id, discount: 0, ...body });
  const simple = () => sold({ items: [{ type: 'service', serviceId: lobe.id, quantity: 1 }], payments: { cash: 2500 } });
  const settings = (patch: Json) => t.api('PUT', '/api/settings/studio', patch);

  /** The contract's example: a size, a service, two pieces, a discount, cash and the prepayment of the visit. */
  async function visitSale(startsAt = '2026-10-20T12:00:00.000Z'): Promise<Json> {
    const visit = await make(t, '/api/appointments', { clientId: client.id, masterId: 1, services: [{ serviceId: lobe.id }], startsAt });
    await make(t, `/api/appointments/${visit.id}/deposit`, { amount: 2000, method: 'transfer' });
    return sold({
      appointmentId: visit.id,
      items: [
        { type: 'product', productId: labret.id, variantId: labret.variants[1].id, quantity: 1 },
        { type: 'service', serviceId: lobe.id, quantity: 1 },
        { type: 'product', productId: ring.id, quantity: 2 },
      ],
      discount: 500,
      payments: { cash: 3100, deposit: 2000 },
    });
  }

  const RECEIPT_BODY = [
    '🧾 Чек №1 · MIKAN STUDIO',
    '20 октября, 15:42',
    '',
    'Лабрет — 8 мм — 1 500 ₽',
    'Прокол мочки — 2 500 ₽',
    'Серьга × 2 — 1 600 ₽',
    'Скидка: −500 ₽',
    '**Итого: 5 100 ₽**',
    'Оплата: наличными 3 100 ₽, предоплатой 2 000 ₽',
    '',
  ];

  describe('after a paid sale', () => {
    it('sends the receipt with the bonus line in the linked chat, keeps a copy and marks the sale', async () => {
      link();
      const paid = await visitSale();
      expect(paid.receiptSentAt).toBeNull();
      await vi.waitFor(() => expect(texts()).toHaveLength(1));
      // The loyalty notice is part of the receipt: no separate «Спасибо за покупку!».
      expect(texts()[0]).toBe([...RECEIPT_BODY, '🎁 +255 бонусов, на счёте 255', 'Спасибо, что пришли к нам! 🧡'].join('\n'));
      await vi.waitFor(async () => expect((await sale(paid.id)).receiptSentAt).toBe(new Date(NOW).toISOString()));
      const chat = (await t.api('GET', `/api/clients/${client.id}/chat`)).json().chat;
      expect(chat.lastMessage).toMatchObject({ role: 'system', text: texts()[0] });
    });

    it('leaves the bonus line out when loyalty notices are off and dates it when bonuses burn', async () => {
      link();
      await t.api('PUT', '/api/settings/retention', { loyalty: { notifyClient: false } });
      await simple();
      await vi.waitFor(() => expect(texts()).toHaveLength(1));
      expect(texts()[0]).not.toContain('🎁');
      expect(texts()[0]).toMatch(/\nОплата: наличными 2 500 ₽\n\nСпасибо, что пришли к нам! 🧡$/);

      await t.api('PUT', '/api/settings/retention', { loyalty: { notifyClient: true, expiryDays: 30 } });
      await simple();
      await vi.waitFor(() => expect(texts()).toHaveLength(2));
      expect(texts()[1]).toContain('\n🎁 +125 бонусов, на счёте 250 — начисленные действуют до 19 ноября\nСпасибо, что пришли к нам! 🧡');
    });

    it('names certificate codes, bonus and certificate payments; leaves zero parts out', async () => {
      link();
      await make(t, `/api/clients/${client.id}/bonuses`, { amount: 300, note: 'Старт' });
      const gift = await sold({ items: [{ type: 'certificate', price: 1000, recipientName: 'Маше' }], payments: { transfer: 1000 } });
      const code = gift.items[0].certificateCode as string;
      await vi.waitFor(() => expect(texts()).toHaveLength(1));
      expect(texts()[0]).toContain(`\nПодарочный сертификат ${code} — 1 000 ₽\n**Итого: 1 000 ₽**\nОплата: переводом 1 000 ₽\n`);
      await sold({
        items: [{ type: 'service', serviceId: lobe.id, quantity: 1 }],
        payments: { card: 1450, bonus: 300, certificates: [{ code, amount: 750 }] },
      });
      await vi.waitFor(() => expect(texts()).toHaveLength(2));
      expect(texts()[1]).toContain('\nОплата: картой 1 450 ₽, бонусами 300 ₽, сертификатом 750 ₽\n');
    });

    it('sends nothing to a client without a linked chat, with the bot off for them, archived, or without a client', async () => {
      upsertChat(t.ctx.db, CHAT, { clientId: client.id }); // attributed, not linked
      await simple();
      await make(t, '/api/sales', { items: [{ type: 'service', name: 'Уход', price: 100 }], discount: 0, payments: { cash: 100 } });
      link();
      await t.api('PATCH', `/api/clients/${client.id}`, { botEnabled: false });
      await simple();
      await t.api('PATCH', `/api/clients/${client.id}`, { botEnabled: true, archived: true });
      await simple();
      await t.api('PATCH', `/api/clients/${client.id}`, { archived: false });
      t.gateway.running = false;
      const offline = await simple();
      await settle();
      expect(texts()).toEqual([]);
      expect((await sale(offline.id)).receiptSentAt).toBeNull();
    });

    it('with `pos.sendReceipt` off only the bonus notice goes, as before', async () => {
      link();
      const off = (await settings({ pos: { sendReceipt: false } })).json();
      expect(off.pos).toEqual({ sendReceipt: false });
      const paid = await simple();
      await vi.waitFor(() => expect(texts()).toHaveLength(1));
      expect(texts()[0]).toBe('Спасибо за покупку! 🎁 +125 бонусов, на счёте 125');
      await settle();
      expect((await sale(paid.id)).receiptSentAt).toBeNull();
    });

    it('sends nothing on an idempotent replay and never fails the sale on a delivery problem', async () => {
      link();
      const key = randomUUID();
      const body = { clientId: client.id, items: [{ type: 'service', serviceId: lobe.id, quantity: 1 }], discount: 0, payments: { cash: 2500 } };
      const send = () => t.app.inject({ method: 'POST', url: '/api/sales', headers: { authorization: `Bearer ${t.token}`, 'idempotency-key': key }, payload: body });
      expect((await send()).statusCode).toBe(200);
      await vi.waitFor(() => expect(texts()).toHaveLength(1));
      expect((await send()).headers['idempotent-replayed']).toBe('true');
      await settle();
      expect(texts()).toHaveLength(1);

      t.gateway.failures.push(blocked());
      const res = await t.api('POST', '/api/sales', body);
      expect(res.statusCode).toBe(200);
      await settle();
      expect(texts()).toHaveLength(1);
      expect((await sale(res.json().id)).receiptSentAt).toBeNull();
    });

    it('sends the receipt of a sale the bank confirmed through QR', async () => {
      link();
      const code = await make(t, '/api/qr-payments', {
        clientId: client.id, items: [{ type: 'service', serviceId: lobe.id, quantity: 1 }], discount: 0, payments: { qr: 2500 },
      });
      bank.statuses.set('QR1', 'paid');
      const paid = (await t.api('GET', `/api/qr-payments/${code.id}`)).json();
      expect(paid.status).toBe('paid');
      await vi.waitFor(() => expect(texts()).toHaveLength(1));
      expect(texts()[0]).toContain('\nОплата: по QR 2 500 ₽\n\n🎁 +125 бонусов, на счёте 125\n');
      await vi.waitFor(async () => expect((await sale(paid.sale.id)).receiptSentAt).not.toBeNull());
    });
  });

  describe('POST /sales/:id/send', () => {
    const send = (id: number, body: Json = {}) => t.api('POST', `/api/sales/${id}/send`, body);
    const error = async (id: number, body: Json = {}) => {
      const res = await send(id, body);
      return { status: res.statusCode, ...res.json().error };
    };

    it('sends the receipt to the client’s chat without the bonus line and marks the sale', async () => {
      const paid = await visitSale(); // not linked yet: nothing went
      link();
      vi.setSystemTime(NOW + 3_600_000);
      const res = await send(paid.id);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: paid.id, receiptSentAt: new Date(NOW + 3_600_000).toISOString() });
      expect(texts()).toEqual([[...RECEIPT_BODY, 'Спасибо, что пришли к нам! 🧡'].join('\n')]);
      const chat = (await t.api('GET', `/api/clients/${client.id}/chat`)).json().chat;
      expect(chat.lastMessage).toMatchObject({ role: 'system', text: texts()[0] });
      const entry = (await t.api('GET', '/api/audit?entity=sale')).json().items[0];
      expect(entry).toMatchObject({ action: 'sale.send', entityId: paid.id, summary: 'Чек №1 отправлен клиенту в Telegram' });
    });

    it('falls back to the latest chat attributed to the client and sends to a chosen chat', async () => {
      const paid = await simple();
      upsertChat(t.ctx.db, CHAT, { clientId: client.id });
      expect((await send(paid.id)).statusCode).toBe(200);
      expect(texts()).toHaveLength(1);

      // A chosen anonymous chat becomes the sale's client's; a sale without a client can go to a chat too.
      const other = 777_200;
      upsertChat(t.ctx.db, other);
      expect((await send(paid.id, { chatId: other })).statusCode).toBe(200);
      expect(t.gateway.textsTo(other)).toHaveLength(1);
      const chats = (await t.api('GET', '/api/bot/chats')).json().items;
      expect(chats.find((c: Json) => c.chatId === other).client).toMatchObject({ id: client.id });
      const walkIn = await make(t, '/api/sales', { items: [{ type: 'service', name: 'Уход', price: 100 }], discount: 0, payments: { cash: 100 } });
      expect((await send(walkIn.id, { chatId: other })).statusCode).toBe(200);
      expect(t.gateway.textsTo(other)[1]).toContain('🧾 Чек №2 · MIKAN STUDIO');
      const entry = (await t.api('GET', '/api/audit?entity=sale')).json().items[0];
      expect(entry.summary).toBe(`Чек №2 отправлен в Telegram, в чат ${other}`);
    });

    it('says why a receipt cannot be sent', async () => {
      const paid = await simple();
      expect(await error(paid.id)).toEqual({ status: 409, code: 'conflict', message: 'У клиента нет Telegram — отправить чек некуда' });
      expect(await error(paid.id, { chatId: 5 })).toEqual({ status: 400, code: 'validation_error', message: 'Чат Telegram не найден' });
      const walkIn = await make(t, '/api/sales', { items: [{ type: 'service', name: 'Уход', price: 100 }], discount: 0, payments: { cash: 100 } });
      expect(await error(walkIn.id)).toEqual({ status: 409, code: 'conflict', message: 'В чеке нет клиента' });
      expect(await error(999)).toEqual({ status: 404, code: 'not_found', message: 'Чек не найден' });

      link();
      t.gateway.running = false;
      expect(await error(paid.id)).toEqual({ status: 409, code: 'conflict', message: 'Telegram-бот выключен — чек не отправлен' });
      t.gateway.running = true;
      t.gateway.failures.push(blocked());
      expect(await error(paid.id)).toEqual({ status: 409, code: 'conflict', message: 'Клиент заблокировал бота — сообщение не доставлено' });
      expect((await sale(paid.id)).receiptSentAt).toBeNull();
      expect((await t.api('GET', '/api/audit?entity=sale')).json().items.some((e: Json) => e.action === 'sale.send')).toBe(false);
    });

    it('is open to every role and rate-limited to 30 a minute', async () => {
      link();
      await settings({ pos: { sendReceipt: false } });
      const paid = await simple();
      const master = await staff(t, 'Фатима', 'fatima', 'master');
      expect((await master.api('POST', `/api/sales/${paid.id}/send`, {})).statusCode).toBe(200);
      const statuses: number[] = [];
      for (let i = 0; i < 30; i++) statuses.push((await send(paid.id)).statusCode);
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);
    });

    it('shows the refunds made so far', async () => {
      const paid = await visitSale();
      link();
      const labretLine = paid.items[0];
      const refund = t.ctx.db
        .insert(saleRefunds)
        .values({ saleId: paid.id, amount: 1350, payCash: 1350, restock: true, reason: 'Не подошёл размер', employeeId: 1, createdAt: NOW + 86_400_000 })
        .returning()
        .get();
      t.ctx.db.insert(saleRefundItems).values({ refundId: refund.id, saleItemId: labretLine.id, quantity: 1, amount: 1350 }).run();
      const ringLine = paid.items[2];
      const second = t.ctx.db
        .insert(saleRefunds)
        .values({ saleId: paid.id, amount: 1440, payCash: 1440, restock: true, reason: 'Брак', employeeId: 1, createdAt: NOW + 2 * 86_400_000 })
        .returning()
        .get();
      t.ctx.db.insert(saleRefundItems).values({ refundId: second.id, saleItemId: ringLine.id, quantity: 2, amount: 1440 }).run();
      expect((await send(paid.id)).statusCode).toBe(200);
      expect(texts()[0]).toContain(
        '\nОплата: наличными 3 100 ₽, предоплатой 2 000 ₽\n' +
          '↩️ Возврат 21 октября: −1 350 ₽ (Лабрет — 8 мм)\n' +
          '↩️ Возврат 22 октября: −1 440 ₽ (Серьга × 2)\n\n' +
          'Спасибо, что пришли к нам! 🧡',
      );
    });
  });

  describe('the refund notice', () => {
    async function refundOf(values: Partial<typeof saleRefunds.$inferInsert>, lines: Array<[number, number, number]>, startsAt?: string) {
      const paid = await sale((await visitSale(startsAt)).id);
      const refund = t.ctx.db
        .insert(saleRefunds)
        .values({ saleId: paid.id, amount: 0, restock: true, reason: 'Возврат', employeeId: 1, createdAt: Date.now(), ...values })
        .returning()
        .get();
      for (const [index, quantity, amount] of lines) {
        t.ctx.db.insert(saleRefundItems).values({ refundId: refund.id, saleItemId: paid.items[index].id, quantity, amount }).run();
      }
      return refund.id;
    }

    it('tells the linked client what came back and what happened to the bonuses', async () => {
      const id = await refundOf({ amount: 1350, payCash: 1350, bonusTakenBack: 67 }, [[0, 1, 1350]]);
      link();
      await sendRefundNotice(t.ctx, id);
      expect(texts()).toEqual(['↩️ Возврат по чеку №1\nЛабрет — 8 мм — 1 350 ₽\nВернули: наличными 1 350 ₽\nБонусы: −67']);
      const chat = (await t.api('GET', `/api/clients/${client.id}/chat`)).json().chat;
      expect(chat.lastMessage).toMatchObject({ role: 'system', text: texts()[0] });

      const mixed = await refundOf(
        { amount: 3700, payCard: 1000, payTransfer: 200, payQr: 100, payDeposit: 2000, payBonus: 300, payCertificate: 100 },
        [[1, 1, 2100], [2, 2, 1600]],
        '2026-10-20T14:00:00.000Z',
      );
      await sendRefundNotice(t.ctx, mixed);
      // [the first notice, the receipt of the second sale (the client is linked by now), this notice]
      expect(texts()).toHaveLength(3);
      expect(texts()[2]).toBe(
        '↩️ Возврат по чеку №2\nПрокол мочки — 2 100 ₽\nСерьга × 2 — 1 600 ₽\n' +
          'Вернули: на карту 1 000 ₽, переводом 200 ₽, по СБП 100 ₽, в предоплату записи 2 000 ₽, на сертификат 100 ₽\n' +
          'Бонусы вернули: +300',
      );
    });

    it('stays silent when the receipt is off, the client is not reachable or the refund is unknown, and never throws', async () => {
      const id = await refundOf({ amount: 1350, payCash: 1350 }, [[0, 1, 1350]]);
      await sendRefundNotice(t.ctx, id); // not linked
      link();
      await settings({ pos: { sendReceipt: false } });
      await sendRefundNotice(t.ctx, id);
      await settings({ pos: { sendReceipt: true } });
      await sendRefundNotice(t.ctx, 999);
      t.gateway.failures.push(blocked());
      await expect(sendRefundNotice(t.ctx, id)).resolves.toBeUndefined();
      expect(texts()).toEqual([]);
      await sendRefundNotice(t.ctx, id);
      expect(texts()).toHaveLength(1);
    });
  });

  describe('StudioSettings.pos', () => {
    it('defaults to sending, keeps the value when omitted and is logged', async () => {
      expect((await t.api('GET', '/api/settings/studio')).json().pos).toEqual({ sendReceipt: true });
      expect((await settings({ pos: { sendReceipt: false } })).json().pos).toEqual({ sendReceipt: false });
      expect((await settings({ name: 'MIKAN' })).json().pos).toEqual({ sendReceipt: false });
      expect((await settings({ pos: {} })).json().pos).toEqual({ sendReceipt: false });
      expect((await settings({ pos: null })).json().pos).toEqual({ sendReceipt: false });
      const bad = await settings({ pos: { sendReceipt: 'yes' } });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error.message).toBe('«Отправлять чек клиенту в Telegram»: должно быть «да» или «нет»');
      const entries = (await t.api('GET', '/api/audit?entity=settings')).json().items;
      expect(entries.at(-1)).toMatchObject({ summary: 'Настройки студии изменены: чек клиенту в Telegram' });
    });

    it('reads settings saved before the till existed with the default', async () => {
      const stored = t.ctx.sqlite.prepare("SELECT value FROM settings WHERE key = 'studio'").get() as { value: string };
      const { pos: _pos, ...rest } = JSON.parse(stored.value) as Json;
      t.ctx.sqlite.prepare("UPDATE settings SET value = ? WHERE key = 'studio'").run(JSON.stringify(rest));
      expect((await t.api('GET', '/api/settings/studio')).json().pos).toEqual({ sendReceipt: true });
    });
  });

  it('serializes `receiptSentAt` on every sale', async () => {
    const paid = await simple();
    expect(paid).toHaveProperty('receiptSentAt', null);
    expect((await t.api('GET', '/api/sales')).json().items[0]).toHaveProperty('receiptSentAt', null);
    expect(t.ctx.db.select().from(saleRefunds).where(eq(saleRefunds.saleId, paid.id)).all()).toEqual([]);
  });
});
