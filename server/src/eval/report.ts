import { formatAmount } from '../lib/text.js';
import type { CaseResult, EvalReport } from './runner.js';

/** The plain-text report of the AI quality check: a table, the summary and the details of failed cases. */

const COLUMNS = { id: 30, status: 4, checks: 26, tools: 32, answer: 60 } as const;

/** One line, at most `width` characters (… when cut). */
export function oneLine(text: string, width: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= width ? flat : `${flat.slice(0, width - 1)}…`;
}

const cell = (text: string, width: number) => oneLine(text, width).padEnd(width);

/** Tool names in call order, each once. */
const toolList = (tools: string[]) => [...new Set(tools)].join(', ') || '—';

function row(r: CaseResult): string {
  const checks = [...new Set(r.failures.map((f) => f.check))].join(', ') || '—';
  return [
    cell(r.id, COLUMNS.id),
    cell(r.passed ? 'OK' : 'FAIL', COLUMNS.status),
    cell(checks, COLUMNS.checks),
    cell(toolList(r.tools), COLUMNS.tools),
    oneLine(r.answer || '(без текста)', COLUMNS.answer),
  ].join('  ');
}

export function formatTable(results: CaseResult[]): string {
  const header = [
    cell('Кейс', COLUMNS.id),
    cell('Итог', COLUMNS.status),
    cell('Не прошло', COLUMNS.checks),
    cell('Инструменты', COLUMNS.tools),
    'Ответ',
  ].join('  ');
  return [header, '-'.repeat(header.length + COLUMNS.answer - 'Ответ'.length), ...results.map(row)].join('\n');
}

function byTopic(results: CaseResult[]): string {
  const topics = new Map<string, { passed: number; total: number }>();
  for (const r of results) {
    const t = topics.get(r.topic) ?? { passed: 0, total: 0 };
    topics.set(r.topic, { passed: t.passed + (r.passed ? 1 : 0), total: t.total + 1 });
  }
  return [...topics].map(([topic, t]) => `${topic} ${t.passed}/${t.total}`).join(' · ');
}

export function formatSummary(report: EvalReport): string {
  const { summary: s, results } = report;
  const lines = [
    `Итого: прошли ${s.passed} из ${s.total} (${s.passRate}%), не прошли ${s.failed}` +
      `${s.notRun ? `, не запускались ${s.notRun}` : ''} · модель ${report.model}`,
    `По темам: ${byTopic(results)}`,
    `Токены: вход ${formatAmount(s.usage.input)} (из кэша ${formatAmount(s.usage.cacheRead)}), выход ${formatAmount(s.usage.output)}`,
  ];
  if (report.aborted) lines.push(`Прогон остановлен: ${report.aborted}`);
  return lines.join('\n');
}

function details(r: CaseResult): string {
  const indent = (text: string) => text.split('\n').map((l) => (l.trim() ? `    ${l}` : '')).join('\n');
  return [
    `✗ ${r.id} [${r.topic}]`,
    `  Клиент: ${r.message}`,
    ...r.failures.map((f) => `  • ${f.check}: ${f.detail}`),
    `  Инструменты: ${r.tools.join(', ') || '—'}`,
    ...(r.notes.length ? [`  Тест-режим: ${r.notes.join('; ')}`] : []),
    '  Ответ:',
    indent(r.answer || '(без текста)'),
  ].join('\n');
}

export function formatReport(report: EvalReport): string {
  const failed = report.results.filter((r) => !r.passed);
  const sections = [formatTable(report.results), formatSummary(report)];
  if (failed.length) sections.push(`Не прошли:\n\n${failed.map(details).join('\n\n')}`);
  return `${sections.join('\n\n')}\n`;
}
