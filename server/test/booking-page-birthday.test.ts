import { describe, expect, it } from 'vitest';
import {
  applyBirthdayInput,
  BIRTHDAY_ERROR,
  birthdayFromInput,
  birthdayLabel,
  formatBirthdayDigits,
} from '../public/book/lib/birthday.js';
import { canProceed, contactErrors, createFlow, reduce } from '../public/book/lib/flow.js';
import { bookingBody } from '../public/book/lib/query.js';

const TODAY = '2026-10-20';

/** Types `text` into an empty field one character at a time, as a keyboard would. */
function typeInto(text: string): string {
  let value = '';
  for (const ch of text) {
    const raw = value + ch;
    value = applyBirthdayInput({ previous: value, raw, caret: raw.length, inputType: 'insertText' }).value;
  }
  return value;
}

describe('booking page: the birthday field', () => {
  it('puts the dots in as digits are typed', () => {
    expect(formatBirthdayDigits('')).toBe('');
    expect(formatBirthdayDigits('1')).toBe('1');
    expect(formatBirthdayDigits('12')).toBe('12');
    expect(formatBirthdayDigits('120')).toBe('12.0');
    expect(formatBirthdayDigits('1204')).toBe('12.04');
    expect(formatBirthdayDigits('120419')).toBe('12.04.19');
    expect(formatBirthdayDigits('1204199512')).toBe('12.04.1995');
    expect(typeInto('12041995')).toBe('12.04.1995');
    expect(typeInto('12.04.1995')).toBe('12.04.1995');
    expect(applyBirthdayInput({ previous: '', raw: '12/04/1995', caret: 10, inputType: 'insertFromPaste' }).value).toBe('12.04.1995');
    // Autofill may bring the ISO form.
    expect(applyBirthdayInput({ previous: '', raw: '1995-04-12', caret: 10, inputType: 'insertReplacementText' })).toEqual({ value: '12.04.1995', caret: 10 });
  });

  it('backspace over a dot deletes the digit before it', () => {
    // «12.|04» → backspace removes the dot: the «2» goes instead.
    expect(applyBirthdayInput({ previous: '12.04', raw: '1204', caret: 2, inputType: 'deleteContentBackward' })).toEqual({ value: '10.4', caret: 1 });
    expect(applyBirthdayInput({ previous: '12.0', raw: '12.', caret: 3, inputType: 'deleteContentBackward' })).toEqual({ value: '12', caret: 2 });
  });

  it('reads a full date or day and month (the year 1900), empty as nothing', () => {
    expect(birthdayFromInput('', TODAY)).toEqual({ value: null, error: null });
    expect(birthdayFromInput('12.04.1995', TODAY)).toEqual({ value: '1995-04-12', error: null });
    expect(birthdayFromInput('12.04', TODAY)).toEqual({ value: '1900-04-12', error: null });
    expect(birthdayFromInput('29.02', TODAY)).toEqual({ value: '1900-02-29', error: null });
    expect(birthdayFromInput('29.02.2000', TODAY)).toEqual({ value: '2000-02-29', error: null });
    expect(birthdayFromInput('20.10.2026', TODAY)).toEqual({ value: '2026-10-20', error: null });
  });

  it.each(['1', '12.0', '12.04.19', '31.02', '29.02.1995', '32.01.1990', '12.13.1990', '21.10.2026', '01.01.1900', '01.01.1890'])(
    'refuses «%s»',
    (text) => {
      expect(birthdayFromInput(text, TODAY)).toEqual({ value: null, error: BIRTHDAY_ERROR });
    },
  );

  it('shows the date without the year when it is unknown', () => {
    expect(birthdayLabel('1995-04-12')).toBe('12 апреля 1995');
    expect(birthdayLabel('1900-04-12')).toBe('12 апреля');
    expect(birthdayLabel(null)).toBe('');
  });
});

describe('booking page: the birthday in the flow', () => {
  const filled = (extra: Record<string, unknown> = {}) => ({
    ...createFlow(),
    name: 'Анна',
    phone: '+7 (999) 123-45-67',
    ...extra,
  });

  it('is optional on the contacts step, but a wrong one stops it', () => {
    expect(contactErrors(filled(), TODAY)).toEqual({});
    expect(contactErrors(filled({ birthday: '12.04' }), TODAY)).toEqual({});
    expect(contactErrors(filled({ birthday: '31.02' }), TODAY)).toEqual({ birthday: BIRTHDAY_ERROR });
    expect(contactErrors(filled({ birthday: '12.04.2030' }), TODAY)).toEqual({ birthday: BIRTHDAY_ERROR });
    expect(canProceed({ ...filled({ birthday: '31.02' }), step: 'contacts' }, new Map())).toBe(false);
    // The waitlist form has no birthday.
    expect(contactErrors({ name: 'Анна', phone: '+7 (999) 123-45-67' })).toEqual({});
  });

  it('is kept as typed', () => {
    const state = reduce(createFlow(), { type: 'setField', field: 'birthday', value: '12.04' }, new Map());
    expect(state.birthday).toBe('12.04');
  });

  it('a new client and a linked chat without one are asked; a linked chat whose card has one is not', () => {
    expect(createFlow().askBirthday).toBe(true);
    expect(createFlow({ linked: true }).askBirthday).toBe(false);
    expect(createFlow({ linked: true, askBirthday: true }).askBirthday).toBe(true);
    // The linked chat's birthday is checked on the confirmation instead of the skipped contacts step.
    expect(contactErrors({ ...createFlow({ linked: true, askBirthday: true }), birthday: '31.02' }, TODAY)).toEqual({ birthday: BIRTHDAY_ERROR });
  });

  it('goes into the booking body as YYYY-MM-DD only when asked and filled', () => {
    const base = {
      items: [{ serviceId: 3, variant: null }],
      master: 5 as number | 'any',
      startsAt: '2026-10-21T12:00:00.000Z',
      name: 'Анна',
      phone: '+79991234567',
      comment: '',
      website: '',
      linked: false,
    };
    expect(bookingBody({ ...base, askBirthday: true, birthday: '12.04.1995' }).birthday).toBe('1995-04-12');
    expect(bookingBody({ ...base, askBirthday: true, birthday: '12.04' }).birthday).toBe('1900-04-12');
    expect(bookingBody({ ...base, askBirthday: true, birthday: '' })).not.toHaveProperty('birthday');
    expect(bookingBody({ ...base, askBirthday: true, birthday: '31.02' })).not.toHaveProperty('birthday');
    expect(bookingBody({ ...base, linked: true, askBirthday: false, birthday: '12.04' })).not.toHaveProperty('birthday');
    expect(bookingBody({ ...base, linked: true, askBirthday: true, birthday: '12.04' }).birthday).toBe('1900-04-12');
  });
});
