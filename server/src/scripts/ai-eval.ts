/**
 * AI quality check: runs the reference client questions of `server/eval/cases.json` against the configured model with
 * the production prompt and tools in test mode (nothing is written or sent), on a made-up studio in an in-memory
 * database (`src/eval/fixture-data.ts`), and prints a pass/fail table. Development tool, not part of the server.
 *
 *   npm run eval:ai                                    all cases
 *   npm run eval:ai -- --case price-lobe,bonus-balance some cases
 *   npm run eval:ai -- --model google/gemini-3.1-pro   another model than AI_MODEL
 *   npm run eval:ai -- --json > eval.json              the full report as JSON (progress goes to stderr)
 *
 * Needs the AI settings (AI_API_KEY, AI_BASE_URL, AI_AUTH, AI_MODEL, AI_HTTPS_PROXY) from server/.env or the
 * environment. Costs one AI request per case, plus one per tool step. Runs from the repository: the cases file is not
 * part of the server image.
 * Exit code: 0 — every case passed, 1 — some case failed, 2 — the check did not run (wrong arguments, no AI settings,
 * a broken cases file, a crash).
 */
import { createAiClient } from '../bot/ai.js';
import { loadAiConfig, type Config } from '../config.js';
import type { Logger } from '../context.js';
import { loadCases, type EvalCase } from '../eval/cases.js';
import { buildEvalStudio } from '../eval/fixture.js';
import { formatReport } from '../eval/report.js';
import { exitCodeOf, runEval, type CaseResult } from '../eval/runner.js';
import { errorMessage } from '../lib/errors.js';
import { isEntryPoint } from './cli.js';

export const USAGE = 'Использование: npm run eval:ai -- [--case <id>[,<id>…]] [--model <id>] [--json]';
/** Wrong arguments, no AI settings, a broken cases file or a crash — the check did not run. */
const EXIT_USAGE = 2;
const EXIT_INTERRUPTED = 130;

export class UsageError extends Error {}

export interface EvalArgs {
  caseIds: string[];
  model: string | null;
  json: boolean;
  help: boolean;
}

function valueOf(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new UsageError(`После ${flag} нужно значение`);
  return value;
}

export function parseEvalArgs(argv: string[]): EvalArgs {
  const args: EvalArgs = { caseIds: [], model: null, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const [flag, inline] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, null];
    if (flag === '--json') args.json = true;
    else if (flag === '--help' || flag === '-h') args.help = true;
    else if (flag === '--case' || flag === '--model') {
      const value = (inline ?? valueOf(argv, i, flag)).trim();
      if (inline === null) i += 1;
      if (!value) throw new UsageError(`После ${flag} нужно значение`);
      if (flag === '--model') args.model = value;
      else args.caseIds.push(...value.split(',').map((id) => id.trim()).filter(Boolean));
    } else throw new UsageError(`Неизвестный аргумент: ${arg}`);
  }
  return args;
}

/** The requested cases in file order; all of them when none is named. */
export function selectCases(cases: EvalCase[], ids: string[]): EvalCase[] {
  if (ids.length === 0) return cases;
  const known = new Set(cases.map((c) => c.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length) throw new UsageError(`Нет таких кейсов: ${unknown.join(', ')}`);
  return cases.filter((c) => ids.includes(c.id));
}

/** Why the check cannot run with these AI settings, else null. */
export function aiSettingsProblem(ai: Config['ai']): string | null {
  if (ai.apiKey) return null;
  return (
    'Нет доступа к ИИ: задайте AI_API_KEY (для Polza — ещё AI_BASE_URL и AI_MODEL) в server/.env или в окружении. ' +
    'Проверка платная: один запрос к модели на кейс и ещё по одному на каждый шаг с инструментами.'
  );
}

/** Warnings and errors of the bot code (failed AI requests, tool errors) go to stderr; keys are never logged. */
const stderrLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (obj, msg) => process.stderr.write(`  [warn] ${msg ?? ''} ${JSON.stringify(obj)}\n`),
  error: (obj, msg) => process.stderr.write(`  [error] ${msg ?? ''} ${JSON.stringify(obj)}\n`),
};

function progress(result: CaseResult, done: number, total: number): void {
  const status = result.passed ? 'OK' : `FAIL (${[...new Set(result.failures.map((f) => f.check))].join(', ')})`;
  const width = String(total).length;
  process.stderr.write(`[${String(done).padStart(width)}/${total}] ${result.id} — ${status}, ${(result.ms / 1000).toFixed(1)} с\n`);
}

export async function main(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  let args: EvalArgs;
  let cases: EvalCase[];
  let aiConfig: Config['ai'];
  try {
    args = parseEvalArgs(argv);
    if (args.help) {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }
    cases = selectCases(loadCases(), args.caseIds);
    const loaded = loadAiConfig(env);
    aiConfig = args.model ? { ...loaded, model: args.model } : loaded;
  } catch (err) {
    process.stderr.write(`${errorMessage(err)}\n${err instanceof UsageError ? `${USAGE}\n` : ''}`);
    return EXIT_USAGE;
  }
  const problem = aiSettingsProblem(aiConfig);
  const ai = createAiClient(aiConfig);
  if (problem || !ai) {
    process.stderr.write(`${problem ?? 'Нет доступа к ИИ'}\n`);
    return EXIT_USAGE;
  }

  process.stderr.write(`Проверка ИИ: ${cases.length} кейсов, модель ${ai.model}${aiConfig.baseUrl ? ` через ${aiConfig.baseUrl}` : ''}\n`);
  const studio = buildEvalStudio({ ai, aiConfig, log: stderrLogger });
  // Ctrl+C mid-run: remove the temporary data dir before leaving.
  const interrupt = () => {
    studio.close();
    process.exit(EXIT_INTERRUPTED);
  };
  process.once('SIGINT', interrupt);
  try {
    const report = await runEval(studio, ai, cases, progress);
    process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : `\n${formatReport(report)}`);
    return exitCodeOf(report);
  } finally {
    process.off('SIGINT', interrupt);
    studio.close();
  }
}

if (isEntryPoint(import.meta.url)) {
  main(process.argv.slice(2), process.env)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      process.stderr.write(`Ошибка: ${errorMessage(err)}\n`);
      process.exitCode = EXIT_USAGE;
    });
}
