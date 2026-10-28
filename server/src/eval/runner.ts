import type Anthropic from '@anthropic-ai/sdk';
import type { AiRunResult } from '../bot/ai.js';
import { runClientAiTest } from '../bot/test-mode.js';
import type { AiClient } from '../context.js';
import { errorMessage } from '../lib/errors.js';
import type { EvalCase } from './cases.js';
import { checkCase, HANDOFF_TOOL, type CheckFailure } from './check.js';
import type { EvalStudio } from './fixture.js';

/** Runs the AI quality check cases through the client AI in test mode (nothing written or sent). */

/** The run stops after this many cases in a row end with an error (wrong key, no balance, no network…). */
export const MAX_CONSECUTIVE_ERRORS = 3;

export interface CaseResult {
  id: string;
  topic: string;
  message: string;
  passed: boolean;
  failures: CheckFailure[];
  /** Tool names in call order. */
  tools: string[];
  handedOff: boolean;
  answer: string;
  /** What the tools would have done outside test mode (a booking, a request, a handoff, pictures). */
  notes: string[];
  outcome: AiRunResult['outcome'];
  usage: AiRunResult['usage'];
  ms: number;
}

export interface EvalSummary {
  total: number;
  passed: number;
  failed: number;
  /** Cases left out after the run stopped. */
  notRun: number;
  /** Passed share of all cases, percent. */
  passRate: number;
  usage: AiRunResult['usage'];
}

export interface EvalReport {
  model: string;
  startedAt: string;
  finishedAt: string;
  results: CaseResult[];
  summary: EvalSummary;
  /** Why the run stopped early, else null. */
  aborted: string | null;
}

/** History and the message as Messages API turns, consecutive turns of one side merged. */
export function conversationOf(c: EvalCase): Anthropic.MessageParam[] {
  const turns = [...c.history, { role: 'user' as const, text: c.message }];
  return turns.reduce<Anthropic.MessageParam[]>((merged, turn) => {
    const last = merged[merged.length - 1];
    if (last?.role === turn.role) return [...merged.slice(0, -1), { role: turn.role, content: `${String(last.content)}\n\n${turn.text}` }];
    return [...merged, { role: turn.role, content: turn.text }];
  }, []);
}

export async function runCase(studio: EvalStudio, ai: AiClient, c: EvalCase): Promise<CaseResult> {
  const started = Date.now();
  const { result, sink } = await runClientAiTest(studio.ctx, ai, {
    messages: conversationOf(c),
    client: studio.client,
    chatId: studio.chatId,
  });
  const failures = checkCase(c, {
    outcome: result.outcome,
    text: result.text,
    tools: result.toolCalls,
    loopCapped: result.loopCapped,
    error: result.error,
    // Test-mode notes stand for actions the bot confirms itself when the model ends without text.
    attachments: sink.services.length + sink.products.length + sink.carousels.length + sink.notes.length,
  });
  return {
    id: c.id,
    topic: c.topic,
    message: c.message,
    passed: failures.length === 0,
    failures,
    tools: result.toolCalls,
    handedOff: result.toolCalls.includes(HANDOFF_TOOL),
    answer: result.text,
    notes: sink.notes,
    outcome: result.outcome,
    usage: result.usage,
    ms: Date.now() - started,
  };
}

/** A case whose run threw (a bug in the bot code or the fixture): failed, the run goes on. */
function crashed(c: EvalCase, err: unknown, started: number): CaseResult {
  const detail = errorMessage(err);
  return {
    id: c.id,
    topic: c.topic,
    message: c.message,
    passed: false,
    failures: [{ check: 'outcome', detail: `error: ${detail}` }],
    tools: [],
    handedOff: false,
    answer: '',
    notes: [],
    outcome: 'error',
    usage: { input: 0, output: 0, cacheRead: 0 },
    ms: Date.now() - started,
  };
}

async function runCaseSafely(studio: EvalStudio, ai: AiClient, c: EvalCase): Promise<CaseResult> {
  const started = Date.now();
  try {
    return await runCase(studio, ai, c);
  } catch (err) {
    studio.ctx.log.error({ case: c.id, err: errorMessage(err) }, 'AI quality check case crashed');
    return crashed(c, err, started);
  }
}

function summarize(results: CaseResult[], total: number): EvalSummary {
  const passed = results.filter((r) => r.passed).length;
  const usage = results.reduce(
    (sum, r) => ({ input: sum.input + r.usage.input, output: sum.output + r.usage.output, cacheRead: sum.cacheRead + r.usage.cacheRead }),
    { input: 0, output: 0, cacheRead: 0 },
  );
  return {
    total,
    passed,
    failed: results.length - passed,
    notRun: total - results.length,
    passRate: total === 0 ? 0 : Math.round((passed / total) * 100),
    usage,
  };
}

/** The reason to stop when the last MAX_CONSECUTIVE_ERRORS requests all failed, else null. */
function abortReason(results: CaseResult[]): string | null {
  const recent = results.slice(-MAX_CONSECUTIVE_ERRORS);
  if (recent.length < MAX_CONSECUTIVE_ERRORS || recent.some((r) => r.outcome !== 'error')) return null;
  const last = recent[recent.length - 1]!.failures[0]?.detail ?? 'ошибка';
  return (
    `${MAX_CONSECUTIVE_ERRORS} кейса подряд завершились ошибкой (${last}); ` +
    'если это ошибка доступа — проверьте AI_API_KEY, AI_BASE_URL, баланс и сеть'
  );
}

/** Runs the cases one by one; `onResult` reports progress. */
export async function runEval(
  studio: EvalStudio,
  ai: AiClient,
  cases: EvalCase[],
  onResult?: (result: CaseResult, done: number, total: number) => void,
): Promise<EvalReport> {
  const startedAt = new Date().toISOString();
  const results: CaseResult[] = [];
  let aborted: string | null = null;
  for (const c of cases) {
    const result = await runCaseSafely(studio, ai, c);
    results.push(result);
    onResult?.(result, results.length, cases.length);
    aborted = results.length < cases.length ? abortReason(results) : null;
    if (aborted) break;
  }
  return { model: ai.model, startedAt, finishedAt: new Date().toISOString(), results, summary: summarize(results, cases.length), aborted };
}

/** 0 — every case passed; 1 — something failed or was not run. */
export function exitCodeOf(report: EvalReport): number {
  const { failed, notRun } = report.summary;
  return failed === 0 && notRun === 0 && report.aborted === null ? 0 : 1;
}
