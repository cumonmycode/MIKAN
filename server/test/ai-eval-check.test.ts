import { describe, expect, it } from 'vitest';
import { loadCases, parseCases } from '../src/eval/cases.js';
import { checkCase, containsTerm, normalizeText, type CaseExpectations, type CaseOutput } from '../src/eval/check.js';

const expectations = (overrides: Partial<CaseExpectations> = {}): CaseExpectations => ({
  mustInclude: [],
  mustNotInclude: [],
  expectTools: [],
  forbidTools: [],
  ...overrides,
});

const output = (overrides: Partial<CaseOutput> = {}): CaseOutput => ({
  outcome: 'ok',
  text: 'Прокол мочки — **1 600 ₽** 🙂',
  tools: [],
  loopCapped: false,
  attachments: 0,
  ...overrides,
});

describe('AI quality check: word matching', () => {
  it('matches stems of Russian words, ignoring case and ё', () => {
    expect(containsTerm('Прокол МОЧКИ стоит 1 600 ₽', 'мочк')).toBe(true);
    expect(containsTerm('Проколем мочку завтра', 'мочк')).toBe(true);
    expect(containsTerm('Всё заживёт', 'все заживет')).toBe(true);
    expect(containsTerm('Не крутите украшение', 'не крут')).toBe(true);
    expect(containsTerm('Хеликс', 'ХЕЛИКС')).toBe(true);
  });

  it('only matches at the start of a word', () => {
    expect(containsTerm('Прокол хеликса', 'кол')).toBe(false);
    expect(containsTerm('Это нормально', 'мально')).toBe(false);
    expect(containsTerm('(нормально)', 'нормальн')).toBe(true);
  });

  it('ignores thousands separators, non-breaking spaces and the kind of dash', () => {
    expect(normalizeText('1 600 ₽ и 12 000 ₽')).toBe('1600 ₽ и 12000 ₽');
    expect(containsTerm('**1 600 ₽**', '1600')).toBe(true);
    expect(containsTerm('1600 ₽', '1 600')).toBe(true);
    expect(containsTerm('от 1 200 000 ₽', '1200000')).toBe(true);
    expect(containsTerm('плёнку — на 2–4 часа', '2-4')).toBe(true);
    expect(containsTerm('плёнку — на 2 – 4 часа', '2-4')).toBe(true);
    expect(containsTerm('от 1 600 — 2 800 ₽', '1600-2800')).toBe(true);
    expect(containsTerm('с 11:00 до 21:00', '21')).toBe(true);
  });

  it('ignores the bold and code markers of the bot', () => {
    expect(normalizeText('**Не** крутите `украшение`')).toBe('не крутите украшение');
    expect(containsTerm('**Не** крутите украшение', 'не крут')).toBe(true);
  });

  it('compares numbers whole', () => {
    expect(containsTerm('от 16 000 ₽', '1600')).toBe(false);
    expect(containsTerm('300 ₽', '30')).toBe(false);
    expect(containsTerm('130 ₽', '30')).toBe(false);
    expect(containsTerm('до 30% чека', '30%')).toBe(true);
    expect(containsTerm('с 18 лет', '18')).toBe(true);
  });

  it('matches symbols anywhere and never an empty term', () => {
    expect(containsTerm('стоит 500₽', '₽')).toBe(true);
    expect(containsTerm('любой текст', '   ')).toBe(false);
  });
});

describe('AI quality check: expectations', () => {
  it('passes an answer that meets every expectation', () => {
    const expect_ = expectations({
      mustInclude: [['1600'], ['мочк', 'ухо']],
      mustNotInclude: ['штук'],
      expectTools: [['show_service', 'find_jewelry']],
      forbidTools: ['book_appointment'],
      expectHandoff: false,
      maxLength: 100,
    });
    expect(checkCase(expect_, output({ tools: ['find_jewelry'] }))).toEqual([]);
  });

  it('needs one term of every mustInclude group and none of mustNotInclude', () => {
    const failures = checkCase(
      expectations({ mustInclude: [['1600'], ['хеликс', 'трагус']], mustNotInclude: ['мочк', 'штук'] }),
      output(),
    );
    expect(failures).toEqual([
      { check: 'mustInclude', detail: 'нет ни одного из: хеликс | трагус' },
      { check: 'mustNotInclude', detail: 'лишнее в ответе: мочк' },
    ]);
  });

  it('needs one tool of every expectTools group and none of forbidTools', () => {
    const expect_ = expectations({ expectTools: [['my_appointments', 'free_slots'], ['book_appointment']], forbidTools: ['reschedule_appointment'] });
    expect(checkCase(expect_, output({ tools: ['free_slots', 'reschedule_appointment'] }))).toEqual([
      { check: 'expectTools', detail: 'не вызван book_appointment' },
      { check: 'forbidTools', detail: 'вызван reschedule_appointment' },
    ]);
    expect(checkCase(expectations({ expectTools: [['my_appointments', 'free_slots']] }), output({ tools: ['my_appointments'] }))).toEqual([]);
  });

  it('detects a handoff by the handoff_to_staff call, both ways', () => {
    const handedOff = output({ tools: ['find_jewelry', 'handoff_to_staff'] });
    expect(checkCase(expectations({ expectHandoff: true }), handedOff)).toEqual([]);
    expect(checkCase(expectations({ expectHandoff: false }), handedOff)).toEqual([
      { check: 'expectHandoff', detail: 'передал диалог администратору без причины' },
    ]);
    expect(checkCase(expectations({ expectHandoff: true }), output())).toEqual([{ check: 'expectHandoff', detail: 'не передал диалог администратору' }]);
    expect(checkCase(expectations(), handedOff)).toEqual([]);
  });

  it('limits the answer length', () => {
    expect(checkCase(expectations({ maxLength: 10 }), output({ text: 'очень длинный ответ' }))).toEqual([
      { check: 'maxLength', detail: '19 символов при пределе 10' },
    ]);
  });

  it('fails a failed AI call by itself, and an empty or unfinished answer', () => {
    const expect_ = expectations({ mustInclude: [['1600']], expectHandoff: true });
    expect(checkCase(expect_, output({ outcome: 'error', text: '', error: '401 invalid key' }))).toEqual([
      { check: 'outcome', detail: 'error: 401 invalid key' },
    ]);
    expect(checkCase(expectations(), output({ outcome: 'refusal', text: '' }))).toEqual([{ check: 'outcome', detail: 'refusal' }]);
    expect(checkCase(expectations(), output({ text: '  ' }))).toEqual([{ check: 'empty', detail: 'пустой ответ' }]);
    expect(checkCase(expectations(), output({ text: '', attachments: 1 }))).toEqual([]);
    expect(checkCase(expectations(), output({ loopCapped: true }))).toEqual([
      { check: 'loop', detail: 'не уложился в лимит шагов с инструментами' },
    ]);
  });
});

describe('AI quality check: the cases file', () => {
  it('ships at least 30 valid cases covering the tools, handoffs and topics', () => {
    const cases = loadCases();
    expect(cases.length).toBeGreaterThanOrEqual(30);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    const expected = new Set(cases.flatMap((c) => c.expectTools.flat()));
    for (const tool of ['free_slots', 'book_appointment', 'create_booking_request', 'find_jewelry', 'show_jewelry_for_service', 'certificate_balance']) {
      expect(expected, tool).toContain(tool);
    }
    expect(cases.filter((c) => c.expectHandoff === true).length).toBeGreaterThanOrEqual(5);
    expect(cases.filter((c) => c.expectHandoff === false).length).toBeGreaterThanOrEqual(5);
    expect(cases.some((c) => c.history.length > 0)).toBe(true);
    expect(new Set(cases.map((c) => c.topic)).size).toBeGreaterThanOrEqual(10);
  });

  it('turns single terms into groups and fills the defaults', () => {
    const [c] = parseCases({ cases: [{ id: 'a-1', topic: 'Цены', message: 'Сколько?', mustInclude: ['1600', ['мочк', 'ухо']], expectTools: ['free_slots'] }] });
    expect(c).toEqual({
      id: 'a-1',
      topic: 'Цены',
      message: 'Сколько?',
      history: [],
      mustInclude: [['1600'], ['мочк', 'ухо']],
      mustNotInclude: [],
      expectTools: [['free_slots']],
      forbidTools: [],
    });
  });

  it('rejects unknown tools and fields, repeated ids and a history that starts with the bot', () => {
    const base = { id: 'a', topic: 'Т', message: 'Привет' };
    expect(() => parseCases({ cases: [{ ...base, expectTools: ['free_slot'] }] })).toThrow('a: неизвестный инструмент free_slot');
    expect(() => parseCases({ cases: [{ ...base, forbidTools: ['delete_everything'] }] })).toThrow('неизвестный инструмент delete_everything');
    expect(() => parseCases({ cases: [base, base] })).toThrow('a: повторяющийся id');
    expect(() => parseCases({ cases: [{ ...base, mustIncludes: ['x'] }] })).toThrow('Некорректный файл кейсов');
    expect(() => parseCases({ cases: [{ ...base, history: [{ role: 'assistant', text: 'Здравствуйте!' }] }] })).toThrow(
      'история начинается с сообщения клиента',
    );
    expect(() => parseCases({ cases: [{ ...base, mustInclude: [[]] }] })).toThrow('Некорректный файл кейсов');
    expect(() => parseCases({ cases: [{ ...base, id: 'Цены 1' }] })).toThrow('латиница');
  });
});
