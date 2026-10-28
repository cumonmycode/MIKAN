import type Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotPipeline } from '../src/bot/pipeline.js';
import { buildStablePrompt } from '../src/bot/prompt.js';
import { buildStaffStablePrompt } from '../src/bot/staff-prompt.js';
import { servicePriceFor } from '../src/domain/service-prices.js';
import { createTestApp, FakeQrProvider, make, message, openShift, ScriptedAi, text, toolUse, type TestApp } from './helpers.js';
import { addMaster, bindStaffChat, FRIDAY_NOON, linkChat, loginAs, NOW, pub, PUBLIC_URL, type Json } from './online-booking-fixtures.js';

/** Masters' own prices of a service (docs/API.md «Service» `masterPrices`) and every channel that prices by them. */

const ADMIN_ID = 1; // the seeded owner, a master
const FRIDAY_13 = '2026-10-16T10:00:00.000Z';
const FRIDAY_15 = '2026-10-16T12:00:00.000Z';
const NIPPLE_VARIANTS = [
  { name: 'Один', price: 2500, durationMin: null },
  { name: 'Два', price: 4000, durationMin: 60 },
];

describe('servicePriceFor', () => {
  const service = {
    price: 2500,
    variantsJson: JSON.stringify(NIPPLE_VARIANTS),
    masterPricesJson: JSON.stringify([{ employeeId: 2, price: 3000, priceMax: null, variants: [{ name: 'Два', price: 5000 }] }]),
  };

  it('takes the master override, else the variant, else the master price, else the catalog', () => {
    expect(servicePriceFor(service, 'Два', 2)).toBe(5000);
    expect(servicePriceFor(service, ' два ', 2)).toBe(5000);
    expect(servicePriceFor(service, 'Один', 2)).toBe(2500); // no override: the variant's catalog price
    expect(servicePriceFor(service, null, 2)).toBe(3000);
    expect(servicePriceFor(service, 'Два', 3)).toBe(4000);
    expect(servicePriceFor(service, null, null)).toBe(2500);
    expect(servicePriceFor(service, 'Три', 2)).toBe(3000); // a variant the service no longer has
    expect(servicePriceFor({ ...service, masterPricesJson: 'not json' }, null, 2)).toBe(2500);
  });
});

describe('masters prices', () => {
  let t: TestApp;
  let amina: Json;
  let fatima: Json;
  let lobe: Json;
  let nipples: Json;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    t = await createTestApp({ env: { PUBLIC_URL } });
    amina = await addMaster(t, 'Амина', 'amina');
    fatima = await addMaster(t, 'Фатима', 'fatima');
    lobe = await make(t, '/api/services', {
      name: 'Мочка', category: 'piercing', price: 1600, durationMin: 30,
      masterPrices: [{ employeeId: amina.id, price: 2000 }, { employeeId: ADMIN_ID, price: 1900 }],
    });
    nipples = await make(t, '/api/services', {
      name: 'Соски', category: 'piercing', price: 2500, durationMin: 45, variants: NIPPLE_VARIANTS,
      masterPrices: [{ employeeId: amina.id, price: 3000, variants: [{ name: 'Два', price: 5000 }] }],
    });
  });
  afterEach(async () => {
    vi.useRealTimers();
    await t.close();
  });

  const patch = async (id: number, body: Json) => {
    const res = await t.api('PATCH', `/api/services/${id}`, body);
    if (res.statusCode !== 200) throw new Error(`PATCH /api/services/${id} → ${res.statusCode}: ${res.body}`);
    return res.json() as Json;
  };
  const error = async (method: 'POST' | 'PATCH', url: string, body: Json) => {
    const res = await t.api(method, url, body);
    expect(res.statusCode).toBe(400);
    return res.json().error.message as string;
  };
  const appointment = (masterId: number, extra: Json = {}) =>
    make(t, '/api/appointments', { clientId: undefined, masterId, services: [{ serviceId: lobe.id }], startsAt: FRIDAY_NOON, ...extra });

  describe('the catalog', () => {
    it('stores and serializes the masters prices, variants under their own names', async () => {
      expect(lobe.masterPrices).toEqual([
        { employeeId: amina.id, price: 2000, priceMax: null, variants: [] },
        { employeeId: ADMIN_ID, price: 1900, priceMax: null, variants: [] },
      ]);
      const created = await make(t, '/api/services', {
        name: 'Септум', category: 'piercing', price: 3000, durationMin: 30, variants: [{ name: 'Кольцо', price: 3000 }],
        masterPrices: [{ employeeId: fatima.id, price: 3500, priceMax: 5000, variants: [{ name: ' кольцо ', price: 3200 }] }],
      });
      expect(created.masterPrices).toEqual([{ employeeId: fatima.id, price: 3500, priceMax: 5000, variants: [{ name: 'Кольцо', price: 3200 }] }]);
      const listed = (await t.api('GET', '/api/services')).json().items as Json[];
      expect(listed.find((s) => s.id === nipples.id)!.masterPrices).toEqual([
        { employeeId: amina.id, price: 3000, priceMax: null, variants: [{ name: 'Два', price: 5000 }] },
      ]);
      expect((await make(t, '/api/services', { name: 'Без', category: 'other', price: 0, durationMin: 15 })).masterPrices).toEqual([]);
    });

    it('refuses unknown or repeated masters, a shrinking range, unknown or repeated variants and too many entries', async () => {
      const url = `/api/services/${nipples.id}`;
      const own = (extra: Json = {}) => ({ employeeId: amina.id, price: 3000, ...extra });
      expect(await error('PATCH', url, { masterPrices: [own(), own()] })).toBe('Цены мастеров: мастер указан дважды');
      expect(await error('PATCH', url, { masterPrices: [own({ employeeId: 999 })] })).toBe('Мастер не найден');
      const admin2 = await make(t, '/api/employees', { name: 'Админ 2', login: 'admin2', password: 'secret123', isMaster: false });
      expect(await error('PATCH', url, { masterPrices: [own({ employeeId: admin2.id })] })).toBe('Мастер не найден');
      expect(await error('PATCH', url, { masterPrices: [own({ priceMax: 3000 })] })).toBe('Максимальная цена должна быть больше минимальной');
      expect(await error('PATCH', url, { masterPrices: [own({ variants: [{ name: 'Три', price: 1 }] })] })).toBe(
        'Нет варианта «Три» у услуги «Соски»',
      );
      expect(await error('PATCH', url, { masterPrices: [own({ variants: [{ name: 'Два', price: 1 }, { name: 'два', price: 2 }] })] })).toBe(
        'Цены мастеров: вариант «Два» указан дважды',
      );
      expect(await error('PATCH', url, { masterPrices: [own({ price: -1 })] })).toBe('«Цена (№1)»: должно быть не меньше 0');
      const many = Array.from({ length: 21 }, (_, i) => own({ employeeId: i + 1 }));
      expect(await error('PATCH', url, { masterPrices: many })).toBe('«Цены мастеров»: не больше 20 элементов');
      // Variants are checked against the ones being saved, and a service without variants has none.
      expect(await error('PATCH', url, { name: 'Пирсинг сосков', variants: [{ name: 'Пара', price: 4000 }], masterPrices: [own({ variants: [{ name: 'Два', price: 1 }] })] })).toBe(
        'Нет варианта «Два» у услуги «Пирсинг сосков»',
      );
      expect(await error('POST', '/api/services', { name: 'Бровь', category: 'piercing', price: 2000, durationMin: 30, masterPrices: [own({ variants: [{ name: 'Два', price: 1 }] })] })).toBe(
        'Нет варианта «Два» у услуги «Бровь»',
      );
      expect((await t.api('GET', `/api/services?includeInactive=true`)).json().items.find((s: Json) => s.id === nipples.id).masterPrices).toEqual([
        { employeeId: amina.id, price: 3000, priceMax: null, variants: [{ name: 'Два', price: 5000 }] },
      ]);
    });

    it('keeps the prices when omitted or null, replaces them when sent, clears them with []', async () => {
      expect((await patch(lobe.id, { price: 1700 })).masterPrices).toHaveLength(2);
      expect((await patch(lobe.id, { masterPrices: null })).masterPrices).toHaveLength(2);
      expect((await patch(lobe.id, { masterPrices: [{ employeeId: fatima.id, price: 1500 }] })).masterPrices).toEqual([
        { employeeId: fatima.id, price: 1500, priceMax: null, variants: [] },
      ]);
      expect((await patch(lobe.id, { masterPrices: [] })).masterPrices).toEqual([]);
    });

    it('lets an employee who is no longer a master keep their entry, but not get a new one', async () => {
      await t.api('PATCH', `/api/employees/${amina.id}`, { isMaster: false });
      const kept = await patch(nipples.id, { masterPrices: [{ employeeId: amina.id, price: 3100 }] });
      expect(kept.masterPrices).toEqual([{ employeeId: amina.id, price: 3100, priceMax: null, variants: [] }]);
      const brow = await make(t, '/api/services', { name: 'Бровь', category: 'piercing', price: 2000, durationMin: 30 });
      expect(await error('PATCH', `/api/services/${brow.id}`, { masterPrices: [{ employeeId: ADMIN_ID, price: 1 }, { employeeId: amina.id, price: 1 }] })).toBe(
        'Мастер не найден',
      );
    });

    it('drops the overrides of variants a PATCH renamed or removed, the rest follow the new spelling', async () => {
      await patch(nipples.id, {
        masterPrices: [
          { employeeId: amina.id, price: 3000, variants: [{ name: 'Один', price: 3000 }, { name: 'Два', price: 5000 }] },
          { employeeId: fatima.id, price: 2600, variants: [{ name: 'Два', price: 4200 }] },
        ],
      });
      const renamed = await patch(nipples.id, { variants: [{ name: 'один', price: 2600 }, { name: 'Пара', price: 4000 }] });
      expect(renamed.masterPrices).toEqual([
        { employeeId: amina.id, price: 3000, priceMax: null, variants: [{ name: 'один', price: 3000 }] },
        { employeeId: fatima.id, price: 2600, priceMax: null, variants: [] },
      ]);
      // Other edits keep them; removing all variants drops every override, the masters' prices stay.
      expect((await patch(nipples.id, { description: 'Прокол' })).masterPrices).toEqual(renamed.masterPrices);
      expect((await patch(nipples.id, { variants: [] })).masterPrices.map((m: Json) => m.variants)).toEqual([[], []]);
    });

    it('words the change in the audit log', async () => {
      await patch(lobe.id, { masterPrices: [{ employeeId: amina.id, price: 2100 }] });
      const [entry] = (await t.api('GET', `/api/audit?entity=service&entityId=${lobe.id}`)).json().items as Json[];
      expect(entry).toMatchObject({ action: 'service.update', summary: 'Услуга «Мочка» изменена: цены у мастеров' });
      expect(entry!.changes.masterPrices.to).toEqual([{ employeeId: amina.id, price: 2100, priceMax: null, variants: [] }]);
      await patch(lobe.id, { price: 1800, masterPrices: [] });
      const [priced] = (await t.api('GET', `/api/audit?entity=service&entityId=${lobe.id}`)).json().items as Json[];
      expect(priced!.summary).toBe('Цена «Мочка»: 1 600 → 1 800 ₽; также изменено: цены у мастеров');
    });
  });

  describe('appointments', () => {
    let client: Json;
    beforeEach(async () => {
      client = await make(t, '/api/clients', { name: 'Анна', phone: '+79991234567' });
    });
    const book = (masterId: number, extra: Json = {}) => appointment(masterId, { clientId: client.id, ...extra });

    it('prices catalog lines without a price by the appointment master', async () => {
      const own = await book(amina.id);
      expect(own.services).toMatchObject([{ serviceId: lobe.id, price: 2000 }]);
      expect(own.price).toBe(2000);
      expect((await book(fatima.id, { startsAt: FRIDAY_13 })).services[0].price).toBe(1600);
      expect((await book(amina.id, { startsAt: FRIDAY_13, services: [{ serviceId: lobe.id, price: 1800 }] })).price).toBe(1800);
      // The legacy single service of older builds too.
      const legacy = await book(amina.id, { startsAt: FRIDAY_15, services: undefined, serviceId: lobe.id });
      expect(legacy.price).toBe(2000);
    });

    it('prices lines sent with a PATCH by the master the appointment will have; kept lines never change', async () => {
      const a = await book(amina.id);
      const moved = (await t.api('PATCH', `/api/appointments/${a.id}`, { masterId: fatima.id })).json();
      expect(moved.price).toBe(2000); // prices already on the appointment stay
      const repriced = (await t.api('PATCH', `/api/appointments/${a.id}`, { services: [{ serviceId: lobe.id }] })).json();
      expect(repriced).toMatchObject({ price: 1600, services: [{ price: 1600 }] });
      const back = (await t.api('PATCH', `/api/appointments/${a.id}`, { masterId: amina.id, services: [{ serviceId: lobe.id }] })).json();
      expect(back.price).toBe(2000);
    });

    it('charges the catalog price for an employee who is not an active master any more', async () => {
      await t.api('PATCH', `/api/employees/${amina.id}`, { isMaster: false });
      expect((await book(amina.id)).price).toBe(1600);
    });
  });

  describe('online booking', () => {
    const book = (extra: Json = {}, ip = '10.0.0.1') =>
      pub(t, 'POST', '', {
        items: [{ serviceId: nipples.id, variant: 'Два' }], masterId: amina.id, startsAt: FRIDAY_NOON, name: 'Анна', phone: '8 (999) 123-45-67', ...extra,
      }, { ip });

    it('books the chosen master at their prices', async () => {
      const booking = (await book()).json();
      expect(booking).toMatchObject({ items: [{ name: 'Соски — Два', price: 5000 }], price: 5000, master: { name: 'Амина' } });
      const stored = (await t.api('GET', `/api/appointments/${booking.number}`)).json();
      expect(stored).toMatchObject({ price: 5000, services: [{ serviceId: nipples.id, name: 'Соски — Два', price: 5000 }] });
      const one = (await book({ items: [{ serviceId: nipples.id, variant: 'Один' }, { serviceId: lobe.id }], startsAt: FRIDAY_13, phone: '+79990000002' })).json();
      expect(one.items).toEqual([{ name: 'Соски — Один', price: 2500 }, { name: 'Мочка', price: 2000 }]);
      expect(one.price).toBe(4500);
      const catalog = (await book({ masterId: fatima.id, phone: '+79990000003' })).json();
      expect(catalog.price).toBe(4000);
    });

    it('prices «any master» by the master the booking went to', async () => {
      // All free and empty: the lowest id — the owner, who has an own price of the lobe only.
      const first = (await book({ masterId: null, items: [{ serviceId: lobe.id }], phone: '+79990000011' })).json();
      expect((await t.api('GET', `/api/appointments/${first.number}`)).json().master.id).toBe(ADMIN_ID);
      expect(first).toMatchObject({ master: { name: 'Админ' }, price: 1900, items: [{ name: 'Мочка', price: 1900 }] });
      // The owner is busy at noon now: Amina has the fewest that day and a lower id than Fatima.
      const second = (await book({ masterId: null, phone: '+79990000012' })).json();
      expect(second).toMatchObject({ master: { name: 'Амина' }, price: 5000 });
      const third = (await book({ masterId: null, phone: '+79990000013' })).json();
      expect(third).toMatchObject({ master: { name: 'Фатима' }, price: 4000 });
    });

    it('answers the honeypot with the price of the master it names', async () => {
      const decoy = (await book({ masterId: null, items: [{ serviceId: lobe.id }], website: 'http://spam.example' })).json();
      expect(decoy).toMatchObject({ master: { name: 'Админ' }, price: 1900, items: [{ name: 'Мочка', price: 1900 }] });
    });

    it('lists the own prices of active masters on the public services', async () => {
      const gone = await addMaster(t, 'Ушла', 'gone');
      const formerly = await addMaster(t, 'Бывшая', 'former');
      await patch(nipples.id, {
        masterPrices: [
          { employeeId: amina.id, price: 3000, variants: [{ name: 'Два', price: 5000 }] },
          { employeeId: gone.id, price: 1, variants: [{ name: 'Один', price: 1 }] },
          { employeeId: formerly.id, price: 1 },
        ],
      });
      await t.api('PATCH', `/api/employees/${gone.id}`, { active: false });
      await t.api('PATCH', `/api/employees/${formerly.id}`, { isMaster: false });
      const ranged = await make(t, '/api/services', {
        name: 'Тату', category: 'tattoo', price: 15000, priceFrom: true, durationMin: 180,
        masterPrices: [{ employeeId: fatima.id, price: 20000 }, { employeeId: amina.id, price: 10000, priceMax: 30000 }],
      });
      const items = (await pub(t, 'GET', '/services')).json().items as Json[];
      const of = (id: number) => items.find((s) => s.id === id)!;
      expect(of(nipples.id)).toMatchObject({ price: 2500, priceText: '2 500 ₽' });
      expect(of(nipples.id).masterPrices).toEqual([
        {
          masterId: amina.id, price: 3000, priceText: '3 000 ₽',
          variants: [{ name: 'Один', price: 2500, priceText: '2 500 ₽' }, { name: 'Два', price: 5000, priceText: '5 000 ₽' }],
        },
      ]);
      expect(of(lobe.id).masterPrices).toEqual([
        { masterId: amina.id, price: 2000, priceText: '2 000 ₽', variants: [] },
        { masterId: ADMIN_ID, price: 1900, priceText: '1 900 ₽', variants: [] },
      ]);
      expect(of(ranged.id).masterPrices).toEqual([
        { masterId: fatima.id, price: 20000, priceText: 'от 20 000 ₽', variants: [] },
        { masterId: amina.id, price: 10000, priceText: 'от 10 000 до 30 000 ₽', variants: [] },
      ]);
      await patch(lobe.id, { masterPrices: [] });
      expect(((await pub(t, 'GET', '/services')).json().items as Json[]).find((s) => s.id === lobe.id)!.masterPrices).toEqual([]);
    });
  });

  describe('the till', () => {
    let client: Json;
    beforeEach(async () => {
      client = await make(t, '/api/clients', { name: 'Анна', phone: '+79991234567' });
    });
    let serviceLine: Json;
    beforeEach(() => {
      serviceLine = { type: 'service', serviceId: lobe.id, quantity: 1 };
    });
    const open = async (api: TestApp['api'], body: Json) => {
      const res = await api('POST', '/api/receipts', body);
      if (res.statusCode !== 200) throw new Error(`POST /api/receipts → ${res.statusCode}: ${res.body}`);
      return res.json() as Json;
    };

    it('prices receipt service lines by the appointment master, else the master who opened it, else the catalog', async () => {
      const visit = await appointment(amina.id, { clientId: client.id });
      expect((await open(t.api, { appointmentId: visit.id, items: [serviceLine] })).items[0].price).toBe(2000);
      // Opened by the owner (a master) without an appointment: their price.
      const own = await open(t.api, { items: [serviceLine] });
      expect(own.items[0].price).toBe(1900);
      // The same receipt moved to Amina's visit takes hers; an explicit price stays.
      const other = await appointment(amina.id, { clientId: client.id, startsAt: FRIDAY_13 });
      const moved = (await t.api('PUT', `/api/receipts/${own.id}`, { appointmentId: other.id, items: [serviceLine, { ...serviceLine, price: 1234 }] })).json();
      expect(moved.items.map((i: Json) => i.price)).toEqual([2000, 1234]);
      // A master without own prices, and an admin who is not a master: the catalog.
      expect((await open(await loginAs(t, 'fatima'), { items: [serviceLine] })).items[0].price).toBe(1600);
      await make(t, '/api/employees', { name: 'Админ 2', login: 'admin2', password: 'secret123', isMaster: false, role: 'admin' });
      expect((await open(await loginAs(t, 'admin2'), { items: [serviceLine] })).items[0].price).toBe(1600);
      expect((await open(await loginAs(t, 'amina'), { items: [serviceLine] })).items[0].price).toBe(2000);
    });

    it('prices sale service lines by the appointment master, else the selling master', async () => {
      await openShift(t);
      const sell = async (api: TestApp['api'], body: Json) => {
        const res = await api('POST', '/api/sales', { clientId: client.id, discount: 0, items: [serviceLine], ...body });
        if (res.statusCode !== 200) throw new Error(`POST /api/sales → ${res.statusCode}: ${res.body}`);
        return res.json() as Json;
      };
      const visit = await appointment(amina.id, { clientId: client.id });
      const paid = await sell(t.api, { appointmentId: visit.id, payments: { cash: 2000, card: 0, transfer: 0 } });
      expect(paid).toMatchObject({ total: 2000, items: [{ price: 2000 }] });
      expect((await sell(t.api, { payments: { cash: 1900, card: 0, transfer: 0 } })).items[0].price).toBe(1900);
      expect((await sell(await loginAs(t, 'fatima'), { payments: { cash: 1600, card: 0, transfer: 0 } })).items[0].price).toBe(1600);
      const mismatch = await t.api('POST', '/api/sales', { clientId: client.id, discount: 0, items: [serviceLine], payments: { cash: 1600, card: 0, transfer: 0 } });
      expect(mismatch.json().error.message).toBe('Сумма оплат (1 600 ₽) не совпадает с итогом (1 900 ₽)');
    });
  });
});

describe('masters prices: QR prepayment and the bot', () => {
  const CHAT = 750_001;
  let t: TestApp;
  let ai: ScriptedAi;
  let bank: FakeQrProvider;
  let amina: Json;
  let nipples: Json;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    ai = new ScriptedAi();
    bank = new FakeQrProvider();
    t = await createTestApp({ ai, qr: bank, env: { PUBLIC_URL } });
    bindStaffChat(t);
    amina = await addMaster(t, 'Амина', 'amina');
    await addMaster(t, 'Lena', 'lena');
    nipples = await make(t, '/api/services', {
      name: 'Соски', category: 'piercing', price: 2500, durationMin: 45, depositAmount: 1000, variants: NIPPLE_VARIANTS,
      masterPrices: [{ employeeId: amina.id, price: 3000, variants: [{ name: 'Два', price: 5000 }, { name: 'Один', price: 2500 }] }],
    });
  });
  afterEach(async () => {
    vi.useRealTimers();
    await t.close();
  });

  it('keeps the prepayment at depositRequired whatever the master charges', async () => {
    const res = await pub(t, 'POST', '', {
      items: [{ serviceId: nipples.id, variant: 'Два' }], masterId: amina.id, startsAt: FRIDAY_NOON, name: 'Анна', phone: '+79991234567',
    });
    expect(res.json()).toMatchObject({ status: 'awaiting_payment', price: 5000, depositRequired: 1000, payment: { amount: 1000 } });
    expect(bank.created.map((c) => c.amount)).toEqual([1000]);
  });

  it('names the active masters own prices in the client and staff prompts, stable between builds', async () => {
    const lobe = await make(t, '/api/services', { name: 'Мочка', category: 'piercing', price: 1600, durationMin: 30 });
    const lena = (await t.api('GET', '/api/employees')).json().items.find((e: Json) => e.name === 'Lena');
    const gone = await addMaster(t, 'Ушла', 'gone');
    await t.api('PATCH', `/api/services/${lobe.id}`, {
      masterPrices: [{ employeeId: amina.id, price: 2000 }, { employeeId: lena.id, price: 1800 }, { employeeId: gone.id, price: 900 }, { employeeId: ADMIN_ID, price: 1600 }],
    });
    await t.api('PATCH', `/api/employees/${gone.id}`, { active: false });
    const prompt = buildStablePrompt(t.ctx.db);
    expect(prompt).toContain(
      `• [id ${lobe.id}] Мочка · 1 600 ₽ · около 30 мин · свои цены мастеров: у Амины — 2 000 ₽; мастер Lena — 1 800 ₽`,
    );
    // A variant service names only the variants a master prices differently.
    expect(prompt).toContain('варианты: Один — 2 500 ₽; Два — 4 000 ₽ (60 мин) · свои цены мастеров: у Амины: Два — 5 000 ₽ · предоплата 1 000 ₽');
    expect(prompt).toContain('«Свои цены мастеров» — у этих мастеров услуга стоит иначе, чем в прайсе.');
    expect(prompt).not.toContain('Ушл'); // an inactive master's prices are not offered
    expect(buildStablePrompt(t.ctx.db)).toBe(prompt);
    expect(buildStaffStablePrompt(t.ctx.db)).toContain('свои цены мастеров: у Амины — 2 000 ₽; мастер Lena — 1 800 ₽');

    // Without own prices the price list reads as before.
    await t.api('PATCH', `/api/services/${lobe.id}`, { masterPrices: [] });
    await t.api('PATCH', `/api/services/${nipples.id}`, { masterPrices: [] });
    const plain = buildStablePrompt(t.ctx.db);
    expect(plain).toContain(`• [id ${lobe.id}] Мочка · 1 600 ₽ · около 30 мин\n`);
    expect(plain).not.toContain('свои цены мастеров');
  });

  it('quotes the booked master price in the book_appointment reply', async () => {
    const pipeline = new BotPipeline(t.ctx, 0);
    const anna = await make(t, '/api/clients', { name: 'Анна', phone: '+79991234567' });
    await linkChat(t, anna.id, CHAT);
    ai.push(
      message([toolUse('a', 'book_appointment', { items: [{ serviceId: nipples.id, variant: 'Два' }], masterId: amina.id, startsAt: '2026-10-16 12:00' })], 'tool_use'),
      message([text('Записала!')]),
    );
    pipeline.receive({ chatId: CHAT, telegramName: 'Анна', username: null }, 'Записывайте к Амине');
    await pipeline.idle();
    const [result] = ai.calls[1]!.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[];
    expect(String(result!.content)).toMatch(/^Запись №\d+ создана: 16 октября, 12:00, Соски — Два, мастер Амина, стоимость 5 000 ₽\. /);
  });

  it('/bot/test names the master «any» would get and their price', async () => {
    ai.push(
      message([toolUse('a', 'book_appointment', { items: [{ serviceId: nipples.id, variant: 'Два' }], startsAt: '2026-10-16 12:00' })], 'tool_use'),
      message([text('Записала!')]),
    );
    expect((await t.api('POST', '/api/bot/test', { text: 'Запишите на соски' })).statusCode).toBe(200);
    const [result] = ai.calls[1]!.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[];
    expect(String(result!.content)).toBe(
      'Тестовый режим: запись не создана, но для клиента всё выглядит так, будто она создана: мастер Админ, стоимость 4 000 ₽. ' +
        'Клиенту пришла бы ссылка на предоплату 1 000 ₽.',
    );
  });
});
