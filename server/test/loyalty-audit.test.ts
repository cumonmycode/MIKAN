import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { upsertChat } from '../src/domain/bot-chats.js';
import { createTestApp, make, openShift, type TestApp } from './helpers.js';

const NOW = Date.parse('2026-10-15T09:00:00.000Z');

describe('audit log of loyalty writes', () => {
  let t: TestApp;
  let client: { id: number };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    t = await createTestApp();
    await openShift(t);
    client = await make(t, '/api/clients', { name: 'Анна', lastName: 'Иванова', phone: '+79990001122' });
  });
  afterEach(async () => {
    vi.useRealTimers();
    await t.close();
  });

  const entries = async (query: string) => (await t.api('GET', `/api/audit?${query}`)).json().items as Array<Record<string, unknown>>;

  it('logs manual bonus adjustments on the client card', async () => {
    await make(t, `/api/clients/${client.id}/bonuses`, { amount: 500, note: 'Компенсация' });
    await make(t, `/api/clients/${client.id}/bonuses`, { amount: -1, note: 'Исправление' });
    const log = await entries(`entity=client&entityId=${client.id}`);
    expect(log.slice(0, 2)).toMatchObject([
      { action: 'client.bonus_adjust', entity: 'client', entityId: client.id, summary: 'Списано 1 бонус у клиента «Анна Иванова»: Исправление' },
      { action: 'client.bonus_adjust', summary: 'Начислено 500 бонусов клиенту «Анна Иванова»: Компенсация', changes: { bonuses: { from: null, to: 500 } } },
    ]);
  });

  it('keeps the marketing opt-out on the card', async () => {
    const res = await t.api('PATCH', `/api/clients/${client.id}`, { marketingOptOut: true });
    expect(res.json()).toMatchObject({ marketingOptOut: true, loyalty: { bonusBalance: 0, expiring: null, birthdayDiscount: null } });
    expect((await t.api('GET', `/api/clients/${client.id}`)).json().marketingOptOut).toBe(true);
    const [entry] = await entries(`entity=client&entityId=${client.id}`);
    expect(entry).toMatchObject({
      action: 'client.update',
      summary: 'Карточка клиента «Анна Иванова» изменена: новости и предложения отключены',
      changes: { marketingOptOut: { from: false, to: true } },
    });
    const created = await make(t, '/api/clients', { name: 'Олег', phone: '+79990003344', marketingOptOut: true });
    expect(created.marketingOptOut).toBe(true);
  });

  it('names bonus and certificate payments in the sale entry and logs certificate management', async () => {
    await make(t, `/api/clients/${client.id}/bonuses`, { amount: 300, note: 'Старт' });
    const sold = await make(t, '/api/sales', {
      clientId: client.id,
      items: [{ type: 'certificate', price: 5000, recipientName: 'Маше' }],
      discount: 0,
      payments: { cash: 5000 },
    });
    const code = sold.items[0].name.replace('Подарочный сертификат ', '') as string;
    const id = sold.items[0].certificateId as number;
    const paid = await make(t, '/api/sales', {
      clientId: client.id,
      items: [{ type: 'service', name: 'Прокол', price: 3000, quantity: 1 }],
      discount: 0,
      payments: { cash: 700, bonus: 300, certificates: [{ code, amount: 2000 }] },
    });
    const sales = await entries('entity=sale');
    expect(sales.find((e) => e.entityId === sold.id)).toMatchObject({
      summary: `Продажа №1 (Анна Иванова) проведена: 5 000 ₽ — Подарочный сертификат ${code}`,
    });
    expect(sales.find((e) => e.entityId === paid.id)).toMatchObject({
      summary: 'Продажа №2 (Анна Иванова) проведена: 3 000 ₽ — Прокол. Оплачено бонусами 300 ₽, сертификатом 2 000 ₽',
    });

    await t.api('PATCH', `/api/certificates/${id}`, { recipientName: 'Маше Петровой', expiresAt: '2028-01-01T00:00:00.000Z' });
    upsertChat(t.ctx.db, 999_001, { telegramName: 'Маша' });
    await t.api('POST', `/api/certificates/${id}/send`, { chatId: 999_001 });
    await t.api('POST', `/api/certificates/${id}/cancel`, { reason: 'Ошибка кассира' });
    const log = await entries(`entity=certificate&entityId=${id}`);
    expect(log.map((e) => e.summary)).toEqual([
      `Сертификат ${code} аннулирован: сгорело 3 000 ₽. Причина: Ошибка кассира`,
      `Сертификат ${code} отправлен в Telegram в чат 999001`,
      `Сертификат ${code} изменён: получатель, срок действия`,
    ]);
    expect(log[2]).toMatchObject({
      action: 'certificate.update',
      changes: {
        recipientName: { from: 'Маше', to: 'Маше Петровой' },
        expiresAt: { from: '2027-10-15T09:00:00.000Z', to: '2028-01-01T00:00:00.000Z' },
      },
    });
  });
});
