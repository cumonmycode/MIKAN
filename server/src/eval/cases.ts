import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { TOOLS } from '../bot/tools.js';
import type { CaseExpectations } from './check.js';

/** The reference client questions of the AI quality check: `server/eval/cases.json` (see the «about» field there). */

export const DEFAULT_CASES_FILE = fileURLToPath(new URL('../../eval/cases.json', import.meta.url));

export interface HistoryTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface EvalCase extends CaseExpectations {
  id: string;
  /** Group of the case in the summary («Цены», «Уход», …). */
  topic: string;
  /** Earlier turns of the conversation, oldest first; the first one is the client's. */
  history: HistoryTurn[];
  /** The client's message the AI answers. */
  message: string;
}

const term = z.string().trim().min(1);
/** A single term, or several of which any one will do. */
const anyOf = z.union([term, z.array(term).min(1)]).transform((v) => (typeof v === 'string' ? [v] : v));

const caseSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'латиница в нижнем регистре, цифры и дефисы'),
    topic: z.string().trim().min(1).max(40),
    history: z
      .array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().trim().min(1).max(4000) }).strict())
      .default([])
      .refine((turns) => turns.length === 0 || turns[0]!.role === 'user', 'история начинается с сообщения клиента'),
    message: z.string().trim().min(1).max(4000),
    mustInclude: z.array(anyOf).default([]),
    mustNotInclude: z.array(term).default([]),
    expectTools: z.array(anyOf).default([]),
    forbidTools: z.array(term).default([]),
    expectHandoff: z.boolean().optional(),
    maxLength: z.number().int().positive().optional(),
  })
  .strict();

const fileSchema = z.object({ about: z.array(z.string()).optional(), cases: z.array(caseSchema).min(1) }).strict();

/** Tool names a case may mention: the client tools of the production prompt. */
const KNOWN_TOOLS = new Set(TOOLS.map((t) => t.name));

function crossChecks(cases: EvalCase[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const c of cases) {
    if (seen.has(c.id)) problems.push(`${c.id}: повторяющийся id`);
    seen.add(c.id);
    const tools = [...c.expectTools.flat(), ...c.forbidTools];
    for (const tool of tools.filter((t) => !KNOWN_TOOLS.has(t))) problems.push(`${c.id}: неизвестный инструмент ${tool}`);
  }
  return problems;
}

/** Validates the cases file content; throws with every problem found. */
export function parseCases(raw: unknown): EvalCase[] {
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.') || '(файл)'}: ${i.message}`);
    throw new Error(`Некорректный файл кейсов:\n${details.join('\n')}`);
  }
  const cases: EvalCase[] = parsed.data.cases;
  const problems = crossChecks(cases);
  if (problems.length) throw new Error(`Некорректный файл кейсов:\n${problems.join('\n')}`);
  return cases;
}

export function loadCases(file = DEFAULT_CASES_FILE): EvalCase[] {
  return parseCases(JSON.parse(fs.readFileSync(file, 'utf8')));
}
