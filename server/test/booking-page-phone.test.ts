import { describe, expect, it } from 'vitest';
import { applyPhoneInput, formatPhone, isPhoneComplete, nationalDigits, toE164 } from '../public/book/lib/phone.js';

/** Types `text` into an empty field one character at a time, as a keyboard would. */
function typeInto(text: string): string {
  let value = '';
  for (const ch of text) {
    const raw = value + ch;
    value = applyPhoneInput({ previous: value, raw, caret: raw.length, inputType: 'insertText' }).value;
  }
  return value;
}

describe('booking page: phone mask', () => {
  it('extracts the 10 national digits from anything typed or pasted', () => {
    expect(nationalDigits('+7 (999) 123-45-67')).toBe('9991234567');
    expect(nationalDigits('89991234567')).toBe('9991234567');
    expect(nationalDigits('79991234567')).toBe('9991234567');
    expect(nationalDigits('9991234567')).toBe('9991234567');
    expect(nationalDigits('+7 999 12')).toBe('99912');
    expect(nationalDigits('8')).toBe('');
    expect(nationalDigits('')).toBe('');
    expect(nationalDigits('+7 (999) 123-45-67 доб. 89')).toBe('9991234567');
  });

  it('formats progressively', () => {
    expect(formatPhone('')).toBe('');
    expect(formatPhone('', { keepPrefix: true })).toBe('+7');
    expect(formatPhone('9')).toBe('+7 (9');
    expect(formatPhone('999')).toBe('+7 (999');
    expect(formatPhone('9991')).toBe('+7 (999) 1');
    expect(formatPhone('9991234')).toBe('+7 (999) 123-4');
    expect(formatPhone('999123456')).toBe('+7 (999) 123-45-6');
    expect(formatPhone('9991234567')).toBe('+7 (999) 123-45-67');
  });

  it('masks a number typed digit by digit, with 8 or 7 or without a prefix', () => {
    expect(typeInto('89991234567')).toBe('+7 (999) 123-45-67');
    expect(typeInto('79991234567')).toBe('+7 (999) 123-45-67');
    expect(typeInto('9991234567')).toBe('+7 (999) 123-45-67');
    expect(typeInto('+79991234567')).toBe('+7 (999) 123-45-67');
    expect(typeInto('999123456789')).toBe('+7 (999) 123-45-67'); // extra digits are dropped
    expect(typeInto('8')).toBe('+7');
  });

  it('masks a pasted or autofilled number', () => {
    for (const raw of ['+7 (999) 123-45-67', '8 999 123 45 67', '+79991234567', '9991234567']) {
      expect(applyPhoneInput({ previous: '', raw, caret: raw.length, inputType: 'insertFromPaste' })).toEqual({
        value: '+7 (999) 123-45-67',
        caret: 18,
      });
    }
  });

  it('backspace at the end removes the last digit and its separator', () => {
    expect(applyPhoneInput({ previous: '+7 (999) 1', raw: '+7 (999) ', caret: 9, inputType: 'deleteContentBackward' })).toEqual({
      value: '+7 (999',
      caret: 7,
    });
    expect(applyPhoneInput({ previous: '+7 (9', raw: '+7 (', caret: 4, inputType: 'deleteContentBackward' })).toEqual({
      value: '',
      caret: 0,
    });
  });

  it('backspace over a separator deletes the digit before it instead of getting stuck', () => {
    // «+7 (999) 123-|4» → the «-» is removed by the browser; the mask removes the «3» instead.
    expect(
      applyPhoneInput({ previous: '+7 (999) 123-4', raw: '+7 (999) 1234', caret: 12, inputType: 'deleteContentBackward' }),
    ).toEqual({ value: '+7 (999) 124', caret: 11 });
  });

  it('keeps the caret after the digit typed in the middle', () => {
    // «+7 (99|9) 123» + «5»
    const result = applyPhoneInput({ previous: '+7 (999) 123', raw: '+7 (9959) 123', caret: 7, inputType: 'insertText' });
    expect(result.value).toBe('+7 (995) 912-3');
    expect(result.value.slice(0, result.caret)).toBe('+7 (995');
  });

  it('knows a complete number and its E.164 form', () => {
    expect(isPhoneComplete('+7 (999) 123-45-67')).toBe(true);
    expect(isPhoneComplete('+7 (999) 123-45-6')).toBe(false);
    expect(toE164('+7 (999) 123-45-67')).toBe('+79991234567');
    expect(toE164('+7 (999) 123')).toBeNull();
  });
});
