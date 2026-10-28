import { describe, expect, it } from 'vitest';
import {
  anyMasterLines,
  anyMasterPrice,
  anyMasterPriceText,
  bookingPriceText,
  createFlow,
  masterTotals,
  reduce,
  selectedLines,
} from '../public/book/lib/flow.js';
import { formatAmount, formatRub, plainPriceText, priceRangeText } from '../public/book/lib/format.js';

/** The booking page prices the chosen services by master (`PublicService.masterPrices`). */

const NBSP = ' ';
const rub = (digits: string) => `${digits.replace(/ /g, NBSP)}${NBSP}₽`;

const AMINA = 3;
const FATIMA = 5;
const OLGA = 7;

const lobe = {
  id: 1, name: 'Мочка', priceText: rub('1 600'), price: 1600, durationMin: 30, depositAmount: 0, variants: [] as unknown[],
  masterPrices: [{ masterId: AMINA, price: 2000, priceText: rub('2 000'), variants: [] }],
};
const nipples = {
  id: 9, name: 'Соски', priceText: rub('2 500'), price: 2500, durationMin: 45, depositAmount: 1000,
  variants: [
    { name: 'Один', priceText: rub('2 500'), price: 2500, durationMin: 45 },
    { name: 'Два', priceText: rub('4 000'), price: 4000, durationMin: 60 },
  ],
  masterPrices: [
    {
      masterId: AMINA, price: 3000, priceText: rub('3 000'),
      variants: [{ name: 'Один', price: 2500, priceText: rub('2 500') }, { name: 'Два', price: 5000, priceText: rub('5 000') }],
    },
  ],
};
const tattoo = {
  id: 12, name: 'Тату', priceText: `от${NBSP}${rub('15 000')}`, price: 15000, durationMin: 180, depositAmount: 0, variants: [],
  masterPrices: [{ masterId: FATIMA, price: 20000, priceText: `от${NBSP}${rub('20 000')}`, variants: [] }],
};
const plain = { id: 20, name: 'Консультация', priceText: 'Бесплатно', price: 0, durationMin: 15, depositAmount: 0, variants: [] };
const catalog = new Map<number, any>([lobe, nipples, tattoo, plain].map((s) => [s.id, s]));
const masters = [{ id: AMINA }, { id: FATIMA }, { id: OLGA }];

type State = ReturnType<typeof createFlow>;
const pick = (master: number | 'any' | null, ...items: Array<{ serviceId: number; variant?: string | null }>): State => {
  const withItems = items.reduce(
    (s, item) => reduce(s, { type: 'toggleItem', serviceId: item.serviceId, variant: item.variant ?? null } as never, catalog),
    createFlow(),
  );
  return master === null ? withItems : reduce(withItems, { type: 'setMaster', master } as never, catalog);
};

describe('booking page: amounts and ranges', () => {
  it('formats amounts and the range of the masters totals', () => {
    expect(formatAmount(3000)).toBe(`3${NBSP}000`);
    expect(formatRub(-1500)).toBe(`−1${NBSP}500${NBSP}₽`);
    const fixed = (price: number) => [{ price, priceText: plainPriceText(price) }];
    expect(priceRangeText([fixed(3000), fixed(4000), fixed(3500)])).toBe(`3${NBSP}000–${rub('4 000')}`);
    expect(priceRangeText([fixed(3000), fixed(3000)])).toBe(rub('3 000'));
    expect(priceRangeText([fixed(0), fixed(1000)])).toBe(`0–${rub('1 000')}`);
    // A line priced per appointment: «от» the cheapest.
    const from = (price: number) => [{ price, priceText: `от${NBSP}${formatRub(price)}` }];
    expect(priceRangeText([from(15000), from(20000)])).toBe(`от${NBSP}${rub('15 000')}`);
    expect(priceRangeText([from(0), fixed(0)])).toBe('Цена — на консультации');
    expect(priceRangeText([])).toBe('');
  });
});

describe('booking page: prices by master', () => {
  it('prices the chosen lines with the chosen master, the catalog otherwise', () => {
    const forAmina = selectedLines(pick(AMINA, { serviceId: 9, variant: 'Два' }, { serviceId: 1 }), catalog);
    expect(forAmina.map((l) => [l.name, l.price, l.priceText])).toEqual([
      ['Соски — Два', 5000, rub('5 000')],
      ['Мочка', 2000, rub('2 000')],
    ]);
    // Durations and prepayments do not depend on the master.
    expect(forAmina.map((l) => [l.durationMin, l.depositAmount])).toEqual([[60, 1000], [30, 0]]);
    const forFatima = selectedLines(pick(FATIMA, { serviceId: 9, variant: 'Два' }, { serviceId: 1 }), catalog);
    expect(forFatima.map((l) => l.price)).toEqual([4000, 1600]);
    expect(selectedLines(pick('any', { serviceId: 1 }), catalog)[0]!.price).toBe(1600);
    expect(selectedLines(pick(null, { serviceId: 1 }), catalog)[0]!.price).toBe(1600);
    // Asked for another master explicitly; a service without masterPrices (older server) — the catalog.
    expect(selectedLines(pick(FATIMA, { serviceId: 1 }), catalog, AMINA)[0]!.price).toBe(2000);
    expect(selectedLines(pick(AMINA, { serviceId: 20 }), catalog)[0]!.priceText).toBe('Бесплатно');
  });

  it('shows each master total on the master step when it differs from the catalog', () => {
    const totals = masterTotals(pick(null, { serviceId: 9, variant: 'Два' }, { serviceId: 1 }), catalog, masters);
    expect([...totals]).toEqual([[AMINA, rub('7 000')]]);
    expect([...masterTotals(pick(null, { serviceId: 9, variant: 'Один' }), catalog, masters)]).toEqual([]);
    expect([...masterTotals(pick(null, { serviceId: 12 }), catalog, masters)]).toEqual([[FATIMA, `от${NBSP}${rub('20 000')}`]]);
  });

  it('gives «any master» the range of the masters totals when they differ, else the one total', () => {
    const state = pick('any', { serviceId: 9, variant: 'Два' }, { serviceId: 1 });
    const any = anyMasterPrice(state, catalog, masters);
    expect(any).toEqual({ text: `5${NBSP}600–${rub('7 000')}`, varies: true });
    expect(anyMasterPriceText(any)).toBe(`5${NBSP}600–${rub('7 000')} — зависит от мастера`);
    expect(bookingPriceText(state, catalog, masters)).toBe(`5${NBSP}600–${rub('7 000')}`);

    const same = anyMasterPrice(pick('any', { serviceId: 9, variant: 'Один' }), catalog, masters);
    expect(same).toEqual({ text: rub('2 500'), varies: false });
    expect(anyMasterPriceText(same)).toBe(rub('2 500'));
    // Every master charges their own price alike: that one total.
    expect(anyMasterPrice(pick('any', { serviceId: 1 }), catalog, [{ id: AMINA }])).toEqual({ text: rub('2 000'), varies: false });
    // No masters known: the catalog.
    expect(anyMasterPrice(pick('any', { serviceId: 1 }), catalog, [])).toEqual({ text: rub('1 600'), varies: false });
    expect(anyMasterPrice(pick('any', { serviceId: 12 }), catalog, masters)).toEqual({ text: `от${NBSP}${rub('15 000')}`, varies: true });
  });

  it('keeps a line price on the «any» confirmation only when every master charges it', () => {
    const lines = anyMasterLines(pick('any', { serviceId: 9, variant: 'Один' }, { serviceId: 1 }, { serviceId: 20 }), catalog, masters);
    expect(lines.map((l) => [l.name, l.priceText])).toEqual([
      ['Соски — Один', rub('2 500')],
      ['Мочка', null],
      ['Консультация', 'Бесплатно'],
    ]);
  });

  it('totals the booking by the chosen master for the bottom bar', () => {
    expect(bookingPriceText(pick(AMINA, { serviceId: 9, variant: 'Два' }, { serviceId: 1 }), catalog, masters)).toBe(rub('7 000'));
    expect(bookingPriceText(pick(OLGA, { serviceId: 9, variant: 'Два' }, { serviceId: 1 }), catalog, masters)).toBe(rub('5 600'));
    expect(bookingPriceText(pick(null, { serviceId: 1 }), catalog, masters)).toBe(rub('1 600'));
  });
});
