import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { findClientByChat } from '../domain/clients.js';
import { MAX_BOOKING_ITEMS } from '../domain/online-booking-items.js';
import { getStudioSettings } from '../domain/settings.js';
import { checkWish, MAX_RANGE_DAYS, NOTE_MAX } from '../domain/waitlist.js';
import { joinWaitlist } from '../domain/waitlist-join.js';
import { wishDates, wishWhat } from '../domain/waitlist-messages.js';
import { parseWaitlistItems } from '../domain/waitlist-store.js';
import { AppError } from '../lib/errors.js';
import type { ToolHandler, ToolResult, ToolScope, ToolSink } from './tools.js';

/** `join_waitlist`: the AI puts the chat's client on the waitlist (docs/API.md «Waitlist»). */

export const JOIN_WAITLIST_TOOL: Anthropic.Tool = {
  name: 'join_waitlist',
  description:
    'Ставит клиента в лист ожидания: услуги (с вариантом, если у услуги есть варианты), мастер или «любой мастер» и ' +
    `период дат (не больше ${MAX_RANGE_DAYS} дней). Вызывай, когда в нужные клиенту дни нет подходящего свободного ` +
    'времени (по free_slots) и клиент согласен подождать. Как только время освободится, бот сам напишет клиенту в этот ' +
    'чат с кнопкой записи — кто запишется первым, тому и время. Работает для клиента, который поделился номером.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: `Услуги (от 1 до ${MAX_BOOKING_ITEMS})`,
        items: {
          type: 'object',
          properties: {
            serviceId: { type: 'integer', description: 'id услуги из раздела «Услуги и цены»' },
            variant: { type: 'string', description: 'Название варианта, если у услуги есть варианты' },
          },
          required: ['serviceId'],
        },
      },
      masterId: { type: 'integer', description: 'id мастера; не передавай, если клиенту всё равно' },
      dateFrom: { type: 'string', description: 'Первый подходящий день, ГГГГ-ММ-ДД (по времени студии)' },
      dateTo: { type: 'string', description: 'Последний подходящий день, ГГГГ-ММ-ДД (не дальше 30 дней от первого)' },
      note: { type: 'string', description: 'Пожелания клиента: «после 18:00», «только выходные». Можно пустую строку.' },
    },
    required: ['items', 'dateFrom', 'dateTo'],
  },
};

const joinInput = z.object({
  items: z
    .array(z.object({ serviceId: z.number().int().positive(), variant: z.string().trim().max(100).nullish() }))
    .min(1)
    .max(MAX_BOOKING_ITEMS),
  masterId: z.number().int().positive().nullish(),
  dateFrom: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/),
  dateTo: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/),
  note: z.string().trim().max(NOTE_MAX).nullish(),
});

const error = (content: string): ToolResult => ({ content, isError: true });

const NOT_IDENTIFIED =
  'Клиент не идентифицирован, поэтому поставить его в лист ожидания нельзя. Попроси поделиться номером кнопкой ' +
  '«📱 Поделиться номером» внизу чата — после этого можно будет.';
const DISABLED =
  'Онлайн-запись сейчас выключена студией, лист ожидания недоступен. Оформи заявку через create_booking_request — ' +
  'администратор подберёт время.';

export function buildWaitlistToolHandler(ctx: AppContext, scope: ToolScope, sink: ToolSink): ToolHandler {
  const { db } = ctx;
  return async (raw) => {
    const parsed = joinInput.safeParse(raw);
    if (!parsed.success) return error('Некорректные данные: нужны items [{ serviceId, variant? }], dateFrom и dateTo «ГГГГ-ММ-ДД».');
    if (!getStudioSettings(db).onlineBooking.enabled) return error(DISABLED);
    const client = scope.chatId !== null ? findClientByChat(db, scope.chatId) : null;
    const input = { channel: 'bot' as const, ...parsed.data, masterId: parsed.data.masterId ?? null, note: parsed.data.note || null };
    try {
      if (scope.mode === 'test') {
        const wish = checkWish(db, input, Date.now());
        sink.notes.push(`клиент встал бы в лист ожидания: ${wishWhat(db, wish.items)}, ${wishDates(wish)}`);
        return { content: 'Тестовый режим: в лист ожидания не записано, но для клиента всё выглядит так, будто записано.' };
      }
      if (!client) return { content: NOT_IDENTIFIED };
      const { row, created } = await joinWaitlist(ctx, { ...input, clientId: client.id });
      sink.done.add('waitlist');
      const wish = `${wishWhat(db, parseWaitlistItems(row.items))}, ${wishDates(row)}`;
      return {
        content:
          `${created ? 'Клиент в листе ожидания' : 'Клиент уже был в листе ожидания с этим пожеланием'} (№${row.id}): ${wish}. ` +
          'Как только освободится подходящее время, бот сам напишет клиенту в этот чат с кнопкой записи — кто запишется ' +
          'первым, тому и время. Скажи это клиенту простыми словами.',
      };
    } catch (err) {
      if (err instanceof AppError) return error(`${err.message}. Уточни у клиента и попробуй снова.`);
      throw err;
    }
  };
}
