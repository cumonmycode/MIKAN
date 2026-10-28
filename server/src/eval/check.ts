import type { AiOutcome } from '../bot/ai.js';

/**
 * Checks one answer of the AI quality check (`npm run eval:ai`) against the expectations of its case.
 *
 * Words are matched as stems, so Russian word forms are tolerated: «мочк» matches «мочка», «мочки», «мочку»; a term
 * must start a word («кол» does not match «прокол»). Case, «ё»/«е», **bold** markers, dashes («2 – 4» = «2-4»),
 * non-breaking spaces and thousands separators («1 600» = «1600») do not matter. A term ending with a digit is a whole
 * number: «1600» does not match «16000».
 */

export const HANDOFF_TOOL = 'handoff_to_staff';

export interface CaseExpectations {
  /** Every group must match: at least one of its terms is in the answer. */
  mustInclude: string[][];
  /** None of these terms may be in the answer. */
  mustNotInclude: string[];
  /** Every group must match: at least one of its tools was called. */
  expectTools: string[][];
  forbidTools: string[];
  /** true — the AI must hand the chat to staff (`handoff_to_staff`); false — it must not; absent — either. */
  expectHandoff?: boolean;
  /** At most this many characters in the answer. */
  maxLength?: number;
}

/** What the AI did for one case. */
export interface CaseOutput {
  outcome: AiOutcome;
  text: string;
  /** Tool names in call order (repeats kept). */
  tools: string[];
  loopCapped: boolean;
  error?: string;
  /**
   * Pictures, photos, catalogs and actions (booking, request, handoff) that come with the text: a reply may consist
   * of them alone — the bot then sends the pictures or its standard confirmation of the action.
   */
  attachments: number;
}

export type CheckName =
  | 'outcome'
  | 'empty'
  | 'loop'
  | 'mustInclude'
  | 'mustNotInclude'
  | 'expectTools'
  | 'forbidTools'
  | 'expectHandoff'
  | 'maxLength';

export interface CheckFailure {
  check: CheckName;
  detail: string;
}

const DASHES = /[‐-―−]/g;
const NUMBER_RANGE = /(\d) ?- ?(?=\d)/g;
const THOUSANDS_SEPARATOR = /(\d) (?=\d{3}(?!\d))/g;
/** Markdown the bot may use: **bold**, `code`. */
const MARKUP = /[*`]/g;
const WORD_CHAR = /[\p{L}\p{N}]/u;
const DIGIT = /\d/;

/** Lower case, «ё» → «е», no markup, one kind of dash and space, «2 – 4» = «2-4», no thousands separators. */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(MARKUP, '')
    .replace(DASHES, '-')
    .replace(/\s+/g, ' ')
    .replace(NUMBER_RANGE, '$1-')
    .replace(THOUSANDS_SEPARATOR, '$1')
    .trim();
}

/** Whether `term` (a stem, a phrase or a number) occurs in `text` — see the module comment. */
export function containsTerm(text: string, term: string): boolean {
  const haystack = normalizeText(text);
  const needle = normalizeText(term);
  if (!needle) return false;
  const mustStartWord = WORD_CHAR.test(needle[0]!);
  const wholeNumber = DIGIT.test(needle[needle.length - 1]!);
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    const before = haystack[at - 1];
    const after = haystack[at + needle.length];
    const startsWord = !mustStartWord || before === undefined || !WORD_CHAR.test(before);
    const endsNumber = !wholeNumber || after === undefined || !DIGIT.test(after);
    if (startsWord && endsNumber) return true;
  }
  return false;
}

function textChecks(expect: CaseExpectations, text: string): CheckFailure[] {
  const failures: CheckFailure[] = [];
  for (const group of expect.mustInclude) {
    if (!group.some((term) => containsTerm(text, term))) {
      failures.push({ check: 'mustInclude', detail: `нет ни одного из: ${group.join(' | ')}` });
    }
  }
  const banned = expect.mustNotInclude.filter((term) => containsTerm(text, term));
  if (banned.length) failures.push({ check: 'mustNotInclude', detail: `лишнее в ответе: ${banned.join(', ')}` });
  if (expect.maxLength !== undefined && text.length > expect.maxLength) {
    failures.push({ check: 'maxLength', detail: `${text.length} символов при пределе ${expect.maxLength}` });
  }
  return failures;
}

function toolChecks(expect: CaseExpectations, tools: string[]): CheckFailure[] {
  const failures: CheckFailure[] = [];
  for (const group of expect.expectTools) {
    if (!group.some((tool) => tools.includes(tool))) failures.push({ check: 'expectTools', detail: `не вызван ${group.join(' или ')}` });
  }
  const forbidden = expect.forbidTools.filter((tool) => tools.includes(tool));
  if (forbidden.length) failures.push({ check: 'forbidTools', detail: `вызван ${forbidden.join(', ')}` });
  if (expect.expectHandoff !== undefined && tools.includes(HANDOFF_TOOL) !== expect.expectHandoff) {
    failures.push({
      check: 'expectHandoff',
      detail: expect.expectHandoff ? 'не передал диалог администратору' : 'передал диалог администратору без причины',
    });
  }
  return failures;
}

/** Every failed expectation of the case (empty — the case passed). A failed AI call fails the case by itself. */
export function checkCase(expect: CaseExpectations, output: CaseOutput): CheckFailure[] {
  if (output.outcome !== 'ok') {
    return [{ check: 'outcome', detail: output.error ? `${output.outcome}: ${output.error}` : output.outcome }];
  }
  const failures: CheckFailure[] = [];
  if (!output.text.trim() && output.attachments === 0) failures.push({ check: 'empty', detail: 'пустой ответ' });
  if (output.loopCapped) failures.push({ check: 'loop', detail: 'не уложился в лимит шагов с инструментами' });
  return [...failures, ...textChecks(expect, output.text), ...toolChecks(expect, output.tools)];
}
