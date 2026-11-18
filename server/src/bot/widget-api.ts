import type { Api } from 'grammy';

/**
 * Bot API 10.4 widget methods and the `widget_query` update. grammY 1.46 has no types for them, but its raw API is a
 * proxy that calls any method by name through the configured API root (the Cloudflare proxy in prod) and the
 * installed transformers, so only the typing is ours.
 */

export type WidgetMethod = 'sendWidget' | 'editMessageWidgetData' | 'answerWidgetQuery';

type UntypedRawApi = Record<string, (payload: Record<string, unknown>) => Promise<unknown>>;

export function callWidgetApi(api: Api, method: WidgetMethod, payload: Record<string, unknown>): Promise<unknown> {
  const call = (api.raw as unknown as UntypedRawApi)[method];
  if (!call) throw new Error(`Telegram API method ${method} is unavailable`);
  return call(payload);
}

/** The `message_id` of a sent message, or 0 when Telegram's answer has none. */
export function sentMessageId(result: unknown): number {
  const id = (result as { message_id?: unknown } | null)?.message_id;
  return typeof id === 'number' ? id : 0;
}

/** The fields of a `WidgetQuery` the bot uses (https://core.telegram.org/bots/api#widgetquery). */
export interface WidgetQuery {
  id: string;
  from: { id: number; firstName: string; lastName: string | null; username: string | null };
  chatId: number;
  chatType: string;
  messageId: number;
  /** `data` for a press; wallet queries carry other types and are not used here. */
  type: string;
  data: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const optionalText = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** The widget query of an update, or null: not one, from an inline message, or malformed. */
export function widgetQueryOf(update: unknown): WidgetQuery | null {
  if (!isRecord(update)) return null;
  const query = update.widget_query;
  if (!isRecord(query) || !isRecord(query.from) || !isRecord(query.chat)) return null;
  const { id, from, chat, message_id: messageId, data } = query;
  if (typeof id !== 'string' || typeof data !== 'string' || typeof messageId !== 'number') return null;
  if (typeof from.id !== 'number' || typeof chat.id !== 'number' || typeof chat.type !== 'string') return null;
  const type = isRecord(query.type) && typeof query.type.type === 'string' ? query.type.type : 'data';
  return {
    id,
    from: {
      id: from.id,
      firstName: optionalText(from.first_name) ?? '',
      lastName: optionalText(from.last_name),
      username: optionalText(from.username),
    },
    chatId: chat.id,
    chatType: chat.type,
    messageId,
    type,
    data,
  };
}
