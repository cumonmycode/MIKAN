import type Anthropic from '@anthropic-ai/sdk';
import type { AiClient, AppContext } from '../context.js';
import type { ClientRow } from '../lib/serialize.js';
import { runAi, type AiRunResult } from './ai.js';
import { buildClientContext, buildStablePrompt, buildSystem } from './prompt.js';
import { buildToolHandlers, emptySink, TOOLS, type ToolSink } from './tools.js';

/**
 * The client AI in test mode: the production prompt, client context and tools, but nothing is written or sent — the
 * tools only describe what would have happened (`sink.notes`). Used by `/bot/test` and `npm run eval:ai`.
 */
export interface TestConversation {
  /** The conversation so far, ending with the client's message. */
  messages: Anthropic.MessageParam[];
  /** The client the AI talks to; `chatId` is the chat linked to their card. Null — an anonymous client. */
  client: ClientRow | null;
  chatId: number | null;
  /** Appended to the client context («Тестовый запуск из приложения студии.»). */
  note?: string;
  now?: number;
}

export interface TestRun {
  result: AiRunResult;
  sink: ToolSink;
}

/** Text of the last client message (what a handoff would quote to staff). */
function lastUserText(messages: Anthropic.MessageParam[]): string {
  const last = [...messages].reverse().find((m) => m.role === 'user');
  if (!last) return '';
  if (typeof last.content === 'string') return last.content;
  return last.content
    .filter((b): b is Anthropic.TextBlockParam => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

export async function runClientAiTest(ctx: AppContext, ai: AiClient, conversation: TestConversation): Promise<TestRun> {
  const { client, chatId, note } = conversation;
  const now = conversation.now ?? Date.now();
  const sink = emptySink();
  const scope = {
    mode: 'test' as const,
    chatId,
    clientId: client?.id ?? null,
    telegramName: null,
    username: null,
    lastUserText: lastUserText(conversation.messages),
  };
  const context = buildClientContext(ctx.db, now, client, null);
  const result = await runAi(
    ai,
    {
      system: buildSystem(buildStablePrompt(ctx.db), note ? `${context}\n${note}` : context),
      messages: conversation.messages,
      tools: TOOLS,
      handlers: buildToolHandlers(ctx, scope, sink),
    },
    ctx.log,
  );
  return { result, sink };
}
