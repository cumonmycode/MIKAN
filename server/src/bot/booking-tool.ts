import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { DbOrTx } from '../db/client.js';
import { cancellationPolicyText } from '../domain/cancellation.js';
import { findClientByChat } from '../domain/clients.js';
import { checkOnlineBooking, createOnlineBooking, type OnlineBookingInput } from '../domain/online-booking.js';
import { MAX_BOOKING_ITEMS, resolveItems, type BookingItem } from '../domain/online-booking-items.js';
import { bookingFacts, sendPaymentRequest } from '../domain/online-booking-messages.js';
import { availableStarts } from '../domain/online-booking-slots.js';
import { employeesByIds, servicesByIds } from '../domain/refs.js';
import { getStudioSettings } from '../domain/settings.js';
import { AppError } from '../lib/errors.js';
import { formatRub } from '../lib/text.js';
import { formatTime, localDate } from '../lib/time.js';
import { parseStudioDateTime } from './client-appointments.js';
import type { ToolHandler, ToolResult, ToolScope, ToolSink } from './tools.js';

/** `book_appointment`: the AI books the chat's client online through the engine (docs/API.md «Online booking»). */

export const BOOK_APPOINTMENT_TOOL: Anthropic.Tool = {
  name: 'book_appointment',
  description:
    'Записывает клиента онлайн: услуги (с вариантом, если у услуги есть варианты), мастер или «любой мастер» и время. ' +
    'Вызывай только после того, как клиент согласился с услугами, мастером (или «любой») и конкретным временем, ' +
    'которое ты предложил из free_slots. Работает для клиента, который поделился номером. Ответ скажет, что дальше: ' +
    'ссылка на предоплату придёт клиенту кнопкой после твоего ответа (после оплаты запись подтвердится сама) или запись ' +
    'ждёт подтверждения студии — перескажи это клиенту простыми словами.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: `Услуги записи (от 1 до ${MAX_BOOKING_ITEMS})`,
        items: {
          type: 'object',
          properties: {
            serviceId: { type: 'integer', description: 'id услуги из раздела «Услуги и цены»' },
            variant: { type: 'string', description: 'Название варианта, если у услуги есть варианты' },
          },
          required: ['serviceId'],
        },
      },
      masterId: { type: 'integer', description: 'id мастера из free_slots; не передавай, если клиенту всё равно' },
      startsAt: { type: 'string', description: 'Начало по времени студии: «ГГГГ-ММ-ДД ЧЧ:ММ», как в ответе free_slots' },
      comment: { type: 'string', description: 'Пожелания клиента: зона, эскиз, выбранное украшение. Можно пустую строку.' },
    },
    required: ['items', 'startsAt'],
  },
};

const bookInput = z.object({
  items: z
    .array(z.object({ serviceId: z.number().int().positive(), variant: z.string().trim().max(100).nullish() }))
    .min(1)
    .max(MAX_BOOKING_ITEMS),
  masterId: z.number().int().positive().nullish(),
  startsAt: z.string().trim().min(10).max(40),
  comment: z.string().trim().max(1000).nullish(),
});

const error = (content: string): ToolResult => ({ content, isError: true });

const NOT_IDENTIFIED =
  'Клиент не идентифицирован, поэтому записать его онлайн нельзя. Попроси поделиться номером кнопкой «📱 Поделиться ' +
  'номером» внизу чата — после этого можно будет записать.';
const DISABLED =
  'Онлайн-запись сейчас выключена студией. Оформи заявку через create_booking_request (имя, телефон, услуга, удобное время) — ' +
  'администратор подтвердит время.';

/**
 * What the booking costs with its master: «стоимость 4 000 ₽», «стоимость от 15 000 ₽» when a service is priced per
 * appointment, «бесплатно»; null for «от 0» (the price is set at the consultation).
 */
function costText(db: DbOrTx, price: number, items: BookingItem[]): string | null {
  const perAppointment = [...servicesByIds(db, items.map((i) => i.serviceId)).values()].some((s) => s.priceFrom);
  if (perAppointment) return price > 0 ? `стоимость от ${formatRub(price)}` : null;
  return price > 0 ? `стоимость ${formatRub(price)}` : 'бесплатно';
}

const withCost = (text: string, cost: string | null): string => (cost ? `${text}, ${cost}` : text);

/** Why the booking failed, with the free starts of that day when the time is taken. */
function failure(ctx: AppContext, err: unknown, input: OnlineBookingInput): ToolResult {
  if (!(err instanceof AppError)) throw err;
  if (err.code !== 'schedule_conflict') return error(`${err.message}. Уточни у клиента и попробуй снова.`);
  const { durationMin } = resolveItems(ctx.db, input.items); // valid: only the time was refused
  const tz = getStudioSettings(ctx.db).timezone;
  const date = localDate(input.startsAt, tz);
  const free = availableStarts(ctx.db, { date, durationMin, masterId: input.masterId, now: Date.now() })
    .slice(0, 8)
    .map((s) => formatTime(s.startsAt, tz));
  return error(
    `Это время уже занято (или не подходит по длительности — ${durationMin} мин). ` +
      (free.length ? `Свободно в этот день: ${free.join(', ')}. Предложи клиенту другое время.` : 'В этот день свободного времени нет — предложи другую дату.'),
  );
}

export function buildBookingToolHandler(ctx: AppContext, scope: ToolScope, sink: ToolSink): ToolHandler {
  const { db } = ctx;
  return async (raw) => {
    const parsed = bookInput.safeParse(raw);
    if (!parsed.success) return error('Некорректные данные: нужны items [{ serviceId, variant? }] и startsAt «ГГГГ-ММ-ДД ЧЧ:ММ».');
    const studio = getStudioSettings(db);
    if (!studio.onlineBooking.enabled) return error(DISABLED);
    const startsAt = parseStudioDateTime(parsed.data.startsAt, studio.timezone);
    if (startsAt === null) return error('Время не распознано: передай его как «ГГГГ-ММ-ДД ЧЧ:ММ» по времени студии.');
    const client = scope.chatId !== null ? findClientByChat(db, scope.chatId) : null;
    const input: OnlineBookingInput = {
      channel: 'bot',
      items: parsed.data.items,
      masterId: parsed.data.masterId ?? null,
      startsAt,
      comment: parsed.data.comment || null,
      clientId: client?.id ?? null,
    };
    try {
      const check = checkOnlineBooking(ctx, input);
      if (scope.mode === 'test') {
        sink.notes.push(`создана бы онлайн-запись: ${check.items.lines.map((l) => l.name).join(', ')}, ${parsed.data.startsAt}`);
        const master = employeesByIds(db, [check.masterId]).get(check.masterId)?.name ?? '—';
        return {
          content:
            `Тестовый режим: запись не создана, но для клиента всё выглядит так, будто она создана: ` +
            `${withCost(`мастер ${master}`, costText(db, check.items.price, input.items))}. ` +
            (check.prepayment ? `Клиенту пришла бы ссылка на предоплату ${formatRub(check.items.depositRequired)}.` : 'Она ждала бы подтверждения студии.'),
        };
      }
      if (!client) return { content: NOT_IDENTIFIED };
      const { appointment, payment } = await createOnlineBooking(ctx, input);
      sink.done.add('online_booking');
      const f = bookingFacts(db, appointment);
      // The price of the master the booking went to (their own prices, see «Service» `masterPrices`).
      const booked = `Запись №${appointment.id} создана: ${withCost(`${f.when}, ${f.what}, мастер ${f.master}`, costText(db, appointment.price, input.items))}.`;
      if (payment) {
        sink.after.push(() => sendPaymentRequest(ctx, appointment, payment));
        return {
          content:
            `${booked} Время за клиентом до ${formatTime(appointment.holdUntil ?? payment.expiresAt, studio.timezone)}: сразу после твоего ` +
            `ответа клиенту придёт сообщение с кнопкой «💳 Оплатить предоплату» (${formatRub(payment.amount)}, через СБП). ` +
            'После оплаты запись подтвердится сама, а если не оплатить вовремя — время освободится. Скажи это клиенту простыми ' +
            `словами и коротко напомни правило отмены: «${cancellationPolicyText(studio.cancellation)}».`,
        };
      }
      const prepayment =
        appointment.depositRequired > 0 ? ` Предоплату ${formatRub(appointment.depositRequired)} администратор попросит после подтверждения.` : '';
      return {
        content:
          `${booked} Время за клиентом, запись ждёт подтверждения студии — администратор подтвердит её в ближайшее время, ` +
          `и клиенту придёт сообщение.${prepayment} Скажи это клиенту простыми словами.`,
      };
    } catch (err) {
      return failure(ctx, err, input);
    }
  };
}
