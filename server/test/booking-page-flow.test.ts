import { describe, expect, it } from 'vitest';
import {
  MAX_ITEMS,
  applyPreselect,
  canProceed,
  contactErrors,
  createFlow,
  firstIncompleteStep,
  reduce,
  selectedLines,
  stepPosition,
  stepReachable,
  stepsFor,
  totalDeposit,
  totalDuration,
} from '../public/book/lib/flow.js';

const NBSP = ' ';

const service = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  name: `Услуга ${id}`,
  category: 'piercing',
  group: 'Ухо',
  description: '',
  priceText: `2${NBSP}500${NBSP}₽`,
  price: 2500,
  durationMin: 30,
  depositAmount: 0,
  imageUrl: null,
  variants: [] as unknown[],
  ...extra,
});

const nipples = service(9, {
  name: 'Соски',
  priceText: `от${NBSP}2${NBSP}500${NBSP}₽`,
  durationMin: 45,
  depositAmount: 1000,
  variants: [
    { name: 'Один', priceText: `2${NBSP}500${NBSP}₽`, price: 2500, durationMin: null },
    { name: 'Два', priceText: `4${NBSP}000${NBSP}₽`, price: 4000, durationMin: 60 },
  ],
});
const services = [service(1), service(2, { durationMin: null }), service(3), service(4), service(5), service(6), nipples];
const catalog = new Map(services.map((s) => [s.id, s]));
const masters = [{ id: 3 }, { id: 5 }];

type State = ReturnType<typeof createFlow>;
const run = (state: State, ...actions: Array<Record<string, unknown>>) =>
  actions.reduce((s, action) => reduce(s, action as never, catalog), state);
const slot = { startsAt: '2026-10-21T12:00:00.000Z', masterIds: [3] };

/** A flow filled in up to the contacts. */
function readyForContacts(): State {
  return run(
    createFlow(),
    { type: 'toggleItem', serviceId: 1, variant: null },
    { type: 'next' },
    { type: 'setMaster', master: 'any' },
    { type: 'next' },
    { type: 'setDate', date: '2026-10-21' },
    { type: 'setSlot', slot },
    { type: 'next' },
  );
}

describe('booking page: step state machine', () => {
  it('starts on the services with nothing chosen', () => {
    const state = createFlow();
    expect(state.step).toBe('services');
    expect(canProceed(state, catalog)).toBe(false);
    expect(stepPosition(state)).toEqual({ index: 1, total: 5 });
  });

  it('walks services → master → time → contacts → confirm only when each step is filled in', () => {
    let state = createFlow();
    state = run(state, { type: 'next' });
    expect(state.step).toBe('services'); // nothing chosen yet
    state = run(state, { type: 'toggleItem', serviceId: 1, variant: null }, { type: 'next' });
    expect(state.step).toBe('master');
    state = run(state, { type: 'next' });
    expect(state.step).toBe('master');
    state = run(state, { type: 'setMaster', master: 'any' }, { type: 'next' });
    expect(state.step).toBe('time');
    state = run(state, { type: 'setDate', date: '2026-10-21' }, { type: 'next' });
    expect(state.step).toBe('time'); // a day without a start is not enough
    state = run(state, { type: 'setSlot', slot }, { type: 'next' });
    expect(state.step).toBe('contacts');
    state = run(state, { type: 'setField', field: 'name', value: 'Анна' }, { type: 'next' });
    expect(state.step).toBe('contacts'); // no phone yet
    state = run(state, { type: 'setField', field: 'phone', value: '+7 (999) 123-45-67' }, { type: 'next' });
    expect(state.step).toBe('confirm');
    expect(stepPosition(state)).toEqual({ index: 5, total: 5 });
    expect(run(state, { type: 'next' })).toBe(state); // the last step
  });

  it('never mutates the state it was given', () => {
    const state = Object.freeze(createFlow());
    const next = reduce(state, { type: 'toggleItem', serviceId: 1, variant: null }, catalog);
    expect(next).not.toBe(state);
    expect(state.items).toEqual([]);
  });

  it('goes back one step at a time and stops at the first', () => {
    const state = readyForContacts();
    expect(run(state, { type: 'back' }).step).toBe('time');
    expect(run(state, { type: 'back' }, { type: 'back' }, { type: 'back' }, { type: 'back' }).step).toBe('services');
  });

  it('skips the contacts for a linked Telegram chat', () => {
    const linked = run(createFlow({ linked: true }), { type: 'toggleItem', serviceId: 1, variant: null });
    expect(stepsFor(linked)).toEqual(['services', 'master', 'time', 'confirm']);
    const atTime = run(linked, { type: 'next' }, { type: 'setMaster', master: 3 }, { type: 'next' }, { type: 'setSlot', slot });
    expect(run(atTime, { type: 'next' }).step).toBe('confirm');
    expect(stepPosition(run(atTime, { type: 'next' }))).toEqual({ index: 4, total: 4 });
    // Learning about the link while on the contacts moves on to the confirmation.
    const contacts = readyForContacts();
    expect(run(contacts, { type: 'setLinked', linked: true }).step).toBe('confirm');
  });

  it('toggles services, keeps at most 5 and drops the chosen start when they change', () => {
    let state = readyForContacts();
    expect(state.slot).not.toBeNull();
    state = run(state, { type: 'toggleItem', serviceId: 2, variant: null });
    expect(state.items).toHaveLength(2);
    expect(state.slot).toBeNull();
    state = run(state, ...[3, 4, 5].map((id) => ({ type: 'toggleItem', serviceId: id, variant: null })));
    expect(state.items).toHaveLength(MAX_ITEMS);
    expect(run(state, { type: 'toggleItem', serviceId: 6, variant: null })).toBe(state); // a sixth is refused
    state = run(state, { type: 'toggleItem', serviceId: 1, variant: null }, { type: 'toggleItem', serviceId: 6, variant: null });
    expect(state.items.map((i) => i.serviceId)).toEqual([2, 3, 4, 5, 6]);
  });

  it('requires a valid variant for a service with variants', () => {
    let state = run(createFlow(), { type: 'toggleItem', serviceId: 9, variant: 'Один' });
    expect(canProceed(state, catalog)).toBe(true);
    state = run(state, { type: 'setVariant', serviceId: 9, variant: 'Два' });
    expect(state.items).toEqual([{ serviceId: 9, variant: 'Два' }]);
    expect(canProceed(run(state, { type: 'setVariant', serviceId: 9, variant: 'Три' }), catalog)).toBe(false);
    expect(canProceed(run(createFlow(), { type: 'toggleItem', serviceId: 9, variant: null }), catalog)).toBe(false);
    expect(canProceed(run(createFlow(), { type: 'toggleItem', serviceId: 404, variant: null }), catalog)).toBe(false);
  });

  it('keeps the start when the same master or day is chosen again, drops it on a change', () => {
    const state = readyForContacts();
    expect(run(state, { type: 'setMaster', master: 'any' })).toBe(state);
    expect(run(state, { type: 'setDate', date: '2026-10-21' })).toBe(state);
    expect(run(state, { type: 'setMaster', master: 5 }).slot).toBeNull();
    expect(run(state, { type: 'setDate', date: '2026-10-22' }).slot).toBeNull();
  });

  it('jumps back only to reachable steps', () => {
    const state = readyForContacts();
    expect(run(state, { type: 'goto', step: 'services' }).step).toBe('services');
    expect(run(state, { type: 'goto', step: 'confirm' }).step).toBe('contacts'); // contacts not filled in
    expect(stepReachable(state, 'confirm', catalog)).toBe(false);
    expect(stepReachable(state, 'nowhere', catalog)).toBe(false);
    expect(firstIncompleteStep(state, catalog)).toBe('contacts');
    expect(firstIncompleteStep(createFlow(), catalog)).toBe('services');
  });

  it('returns to the times when the chosen start was taken', () => {
    const confirm = run(
      readyForContacts(),
      { type: 'setField', field: 'name', value: 'Анна' },
      { type: 'setField', field: 'phone', value: '+7 (999) 123-45-67' },
      { type: 'next' },
    );
    expect(confirm.step).toBe('confirm');
    const back = run(confirm, { type: 'slotTaken' });
    expect(back.step).toBe('time');
    expect(back.slot).toBeNull();
    expect(back.date).toBe('2026-10-21');
  });

  it('ignores unknown fields and actions', () => {
    const state = createFlow();
    expect(run(state, { type: 'setField', field: 'linked', value: true })).toBe(state);
    expect(run(state, { type: 'explode' })).toBe(state);
  });

  it('explains what is wrong with the contacts', () => {
    const state = createFlow();
    expect(contactErrors(state)).toEqual({
      name: 'Напишите, как к вам обращаться',
      phone: 'Введите номер полностью: +7 и 10 цифр',
    });
    expect(contactErrors({ ...state, name: ' '.repeat(3), phone: '+7 (999) 123-45-67' })).toEqual({
      name: 'Напишите, как к вам обращаться',
    });
    expect(contactErrors({ ...state, name: 'А'.repeat(101), phone: '+7 (999) 123-45-67' }).name).toMatch(/не длиннее 100/);
    expect(contactErrors({ ...state, name: 'Анна', phone: '+7 (999) 123-45-67' })).toEqual({});
  });
});

describe('booking page: preselection and totals', () => {
  it('preselects a service and master and jumps to the time', () => {
    const state = applyPreselect(createFlow(), { serviceId: 1, masterId: 5 }, catalog, masters);
    expect(state.items).toEqual([{ serviceId: 1, variant: null }]);
    expect(state.master).toBe(5);
    expect(state.step).toBe('time');
  });

  it('preselects a service alone and opens the master step', () => {
    expect(applyPreselect(createFlow(), { serviceId: 1, masterId: null }, catalog, masters).step).toBe('master');
  });

  it('stays on the services for a service with variants, the first variant chosen', () => {
    const state = applyPreselect(createFlow(), { serviceId: 9, masterId: 3 }, catalog, masters);
    expect(state.step).toBe('services');
    expect(state.items).toEqual([{ serviceId: 9, variant: 'Один' }]);
    expect(state.master).toBe(3);
  });

  it('ignores unknown services and masters', () => {
    const state = applyPreselect(createFlow(), { serviceId: 404, masterId: 77 }, catalog, masters);
    expect(state).toEqual(createFlow());
  });

  it('sums prices, durations (variant, else service, else 60 min) and prepayments', () => {
    const state = run(
      createFlow(),
      { type: 'toggleItem', serviceId: 9, variant: 'Два' },
      { type: 'toggleItem', serviceId: 2, variant: null },
      { type: 'toggleItem', serviceId: 1, variant: null },
    );
    const lines = selectedLines(state, catalog);
    expect(lines.map((l) => [l.name, l.price, l.durationMin])).toEqual([
      ['Соски — Два', 4000, 60],
      ['Услуга 2', 2500, 60],
      ['Услуга 1', 2500, 30],
    ]);
    expect(totalDuration(lines)).toBe(150);
    expect(totalDeposit(lines)).toBe(1000);
    // A variant without its own duration takes the service's.
    const one = selectedLines(run(createFlow(), { type: 'toggleItem', serviceId: 9, variant: 'Один' }), catalog);
    expect(one[0]).toMatchObject({ name: 'Соски — Один', price: 2500, durationMin: 45 });
  });
});
