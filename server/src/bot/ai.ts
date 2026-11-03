import Anthropic from '@anthropic-ai/sdk';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import type { Config } from '../config.js';
import type { AiClient, Logger } from '../context.js';
import { errorMessage } from '../lib/errors.js';
import type { ToolHandler } from './tools.js';

export const MAX_TOOL_ITERATIONS = 5;
const REQUEST_TIMEOUT_MS = 90_000;

/**
 * Builds the Messages API client. With `AI_BASE_URL` (e.g. Polza, an Anthropic-compatible gateway)
 * and `AI_AUTH=bearer` the key is sent as `Authorization: Bearer`; otherwise as `x-api-key`.
 * No beta headers / `fallbacks` are sent — gateways route to platforms without server-side fallback.
 */
export function createAiClient(config: Config['ai']): AiClient | null {
  if (!config.apiKey) return null;
  const auth =
    config.auth === 'bearer' ? { authToken: config.apiKey, apiKey: null } : { apiKey: config.apiKey, authToken: null };
  const proxy = config.httpsProxy
    ? { fetch: undiciFetch as unknown as typeof fetch, fetchOptions: { dispatcher: new ProxyAgent(config.httpsProxy) } }
    : {};
  const client = new Anthropic({
    ...auth,
    ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    ...proxy,
    maxRetries: 2,
    timeout: REQUEST_TIMEOUT_MS,
  } as ConstructorParameters<typeof Anthropic>[0]);
  return {
    model: config.model,
    maxTokens: config.maxTokens,
    createMessage: (params) => client.messages.create(params),
  };
}

export type AiOutcome = 'ok' | 'refusal' | 'max_tokens' | 'error';

export interface AiRunInput {
  system: Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
  handlers: Record<string, ToolHandler>;
}

export interface AiRunResult {
  outcome: AiOutcome;
  text: string;
  toolCalls: string[];
  usage: { input: number; output: number; cacheRead: number };
  /** True when the tool loop hit MAX_TOOL_ITERATIONS without the model finishing. */
  loopCapped: boolean;
  error?: string;
  /** The provider's HTTP status and error code of a failed request (402 / INSUFFICIENT_BALANCE = no balance). */
  errorStatus?: number;
  errorCode?: string;
}

/** Logs the useful parts of an API error (status, gateway error code, trace id) — never credentials. */
export function describeAiError(err: unknown): Record<string, unknown> {
  if (err instanceof Anthropic.APIError) {
    const body = (err.error ?? {}) as { error?: { code?: unknown; type?: unknown; message?: unknown }; trace_id?: unknown };
    return {
      status: err.status,
      type: err.type ?? body.error?.type,
      code: body.error?.code,
      traceId: body.trace_id,
      requestId: err.requestID,
      retryAfter: err.headers?.get?.('retry-after') ?? undefined,
      message: typeof body.error?.message === 'string' ? body.error.message : err.message,
    };
  }
  return { message: errorMessage(err) };
}

function textOf(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text.trim())
    .filter(Boolean)
    .join('\n\n');
}

async function runTools(
  blocks: Anthropic.ToolUseBlock[],
  handlers: Record<string, ToolHandler>,
  log: Logger,
): Promise<Anthropic.ToolResultBlockParam[]> {
  return Promise.all(
    blocks.map(async (block) => {
      const handler = handlers[block.name];
      if (!handler) {
        return { type: 'tool_result' as const, tool_use_id: block.id, content: `Неизвестный инструмент ${block.name}`, is_error: true };
      }
      try {
        const result = await handler(block.input);
        return { type: 'tool_result' as const, tool_use_id: block.id, content: result.content, is_error: result.isError ?? false };
      } catch (err) {
        log.error({ tool: block.name, err: errorMessage(err) }, 'bot tool failed');
        return { type: 'tool_result' as const, tool_use_id: block.id, content: 'Внутренняя ошибка инструмента', is_error: true };
      }
    }),
  );
}

/**
 * Manual tool loop (≤ MAX_TOOL_ITERATIONS model calls). The full `response.content` is appended
 * to the history on every turn (append-only), so thinking blocks are passed back unchanged.
 */
export async function runAi(client: AiClient, input: AiRunInput, log: Logger): Promise<AiRunResult> {
  const messages: Anthropic.MessageParam[] = [...input.messages];
  const texts: string[] = [];
  const toolCalls: string[] = [];
  const usage = { input: 0, output: 0, cacheRead: 0 };
  let loopCapped = false;
  const result = (outcome: AiOutcome, error?: string): AiRunResult => ({
    outcome,
    text: texts.join('\n\n').trim(),
    toolCalls,
    usage,
    loopCapped,
    ...(error ? { error } : {}),
  });

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    let response: Anthropic.Message;
    try {
      response = await client.createMessage({
        model: client.model,
        max_tokens: client.maxTokens,
        system: input.system,
        tools: input.tools,
        tool_choice: { type: 'auto' },
        output_config: { effort: 'low' },
        messages,
      });
    } catch (err) {
      const described = describeAiError(err);
      log.error({ ai: described }, 'AI request failed');
      return {
        ...result('error', errorMessage(err)),
        ...(typeof described.status === 'number' ? { errorStatus: described.status } : {}),
        ...(typeof described.code === 'string' ? { errorCode: described.code } : {}),
      };
    }
    usage.input += response.usage?.input_tokens ?? 0;
    usage.output += response.usage?.output_tokens ?? 0;
    usage.cacheRead += response.usage?.cache_read_input_tokens ?? 0;

    if (response.stop_reason === 'refusal') {
      log.warn({ stopDetails: (response as { stop_details?: unknown }).stop_details ?? null }, 'AI refused');
      return result('refusal');
    }
    if (response.stop_reason === 'max_tokens') {
      log.warn({ usage }, 'AI hit max_tokens');
      return result('max_tokens');
    }
    if (response.stop_reason === 'model_context_window_exceeded') return result('error', 'context window exceeded');

    const text = textOf(response.content);
    if (text) texts.push(text);

    if (response.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: response.content });
      continue;
    }
    const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (response.stop_reason !== 'tool_use' || toolUses.length === 0) return result('ok');

    toolCalls.push(...toolUses.map((b) => b.name));
    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: await runTools(toolUses, input.handlers, log) });
  }
  log.warn({ toolCalls }, 'AI tool loop hit the iteration cap');
  loopCapped = true;
  return texts.length ? result('ok') : result('error', 'tool loop limit reached');
}
