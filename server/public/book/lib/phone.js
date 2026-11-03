// @ts-check
/**
 * The «+7 (999) 123-45-67» phone mask. Pure: the input handler passes the raw value and caret and gets back the
 * formatted value and where the caret goes.
 */

const NATIONAL_LENGTH = 10;

/**
 * The (up to) 10 national digits in what the user typed or pasted: «+7 (999) 12» → «99912»,
 * «8 999 123-45-67» → «9991234567». A leading 7 / 8 is the country / trunk prefix unless exactly 10 digits were given.
 */
export function nationalDigits(raw) {
  const text = String(raw ?? '').trim();
  let digits = text.replace(/\D/g, '');
  if (text.startsWith('+7')) {
    digits = digits.slice(1);
  } else if (text.startsWith('+')) {
    // Another country code: keep what follows it, the mask is Russian only.
    digits = digits.replace(/^7/, '');
  } else if ((digits.startsWith('7') || digits.startsWith('8')) && digits.length !== NATIONAL_LENGTH) {
    digits = digits.slice(1);
  }
  return digits.slice(0, NATIONAL_LENGTH);
}

/** «9991234567» → «+7 (999) 123-45-67»; partial input is formatted as far as it goes. */
export function formatPhone(national, { keepPrefix = false } = {}) {
  const n = String(national).replace(/\D/g, '').slice(0, NATIONAL_LENGTH);
  if (n.length === 0) return keepPrefix ? '+7' : '';
  let out = `+7 (${n.slice(0, 3)}`;
  if (n.length > 3) out += `) ${n.slice(3, 6)}`;
  if (n.length > 6) out += `-${n.slice(6, 8)}`;
  if (n.length > 8) out += `-${n.slice(8, 10)}`;
  return out;
}

/** Index in `formatted` right after its `count`-th national digit (the «+7» prefix is not counted). */
function caretAfterDigits(formatted, count) {
  if (formatted === '') return 0;
  if (count <= 0) return formatted.length <= 2 ? formatted.length : 4; // after «+7» / «+7 (»
  let seen = 0;
  for (let i = 2; i < formatted.length; i += 1) {
    if (/\d/.test(formatted[i])) {
      seen += 1;
      if (seen === count) return i + 1;
    }
  }
  return formatted.length;
}

/**
 * Re-masks the field after an edit.
 * @param {{ previous: string, raw: string, caret: number, inputType?: string }} edit
 *   `previous` — the value before the edit, `raw` — the value the browser produced, `caret` — the caret in `raw`.
 * @returns {{ value: string, caret: number }}
 */
export function applyPhoneInput({ previous, raw, caret, inputType = '' }) {
  let national = nationalDigits(raw);
  let before = nationalDigits(raw.slice(0, Math.max(0, caret))).length;
  before = Math.min(before, national.length);
  const deleting = inputType.startsWith('delete');
  // Backspace over «) », «-» removes no digit and the mask would put the character right back: delete the digit
  // before it instead, as the user meant.
  if (inputType === 'deleteContentBackward' && national === nationalDigits(previous) && before > 0) {
    national = national.slice(0, before - 1) + national.slice(before);
    before -= 1;
  }
  const keepPrefix = national.length === 0 && /\d/.test(raw) && !deleting;
  const value = formatPhone(national, { keepPrefix });
  return { value, caret: caretAfterDigits(value, before) };
}

/** True when all 10 national digits are there. */
export function isPhoneComplete(value) {
  return nationalDigits(value).length === NATIONAL_LENGTH;
}

/** «+7 (999) 123-45-67» → «+79991234567», or null when incomplete. */
export function toE164(value) {
  const national = nationalDigits(value);
  return national.length === NATIONAL_LENGTH ? `+7${national}` : null;
}
