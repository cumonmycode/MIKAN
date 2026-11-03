import type Anthropic from '@anthropic-ai/sdk';
import { asc, desc, eq } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { DbOrTx } from '../db/client.js';
import { bookingRequests, products } from '../db/schema.js';
import { APPOINTMENT_STATUSES, listAppointments } from '../domain/appointments.js';
import { getOpenShift, serializeShift } from '../domain/cash.js';
import { clientStats, searchClients } from '../domain/clients.js';
import { historyEntries } from '../domain/history.js';
import { variantsByProduct } from '../domain/products.js';
import { REPORTS_MESSAGE, roleOf } from '../domain/permissions.js';
import { serializeAppointments } from '../domain/refs.js';
import { badges, reportSummary } from '../domain/reports.js';
import { studioTimezone } from '../domain/settings.js';
import { formatBirthday } from '../lib/birthday.js';
import { clientFullName, type AppointmentOut, type ClientRow, type EmployeeRow, type ProductRow } from '../lib/serialize.js';
import { formatRub, searchKey } from '../lib/text.js';
import { DAY_MS, formatShortDate, localDayBounds } from '../lib/time.js';
import { describeForClient, statusLabel, upcomingForClient } from './client-appointments.js';
import type { ToolHandler, ToolResult } from './tools.js';

/**
 * Staff-mode tools: everything about appointments (all masters), clients, money and stock — quantities included.
 * They exist only in staff chats (an active employee recognised by phone); client chats never get them.
 */

const MAX_APPOINTMENT_DAYS = 62;
const MAX_REPORT_DAYS = 400;
const MAX_APPOINTMENTS = 60;
const MAX_CLIENTS = 3;
const CLIENT_HISTORY = 10;
const MAX_STOCK_ROWS = 40;
const DAYS_FOR_BY_DAY = 31;

const STATUS_FILTERS = [...APPOINTMENT_STATUSES, 'active'] as const;

export const STAFF_TOOLS: Anthropic.Tool[] = [
  {
    name: 'today',
    description:
      'Сводка дня студии: записи всех мастеров на сегодня, выручка и продажи за сегодня с разбивкой по оплатам, ' +
      'кассовая смена, новые заявки на запись, чаты, ждущие ответа, товары на исходе.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'appointments',
    description:
      'Записи за период (все мастера): клиент и телефон, мастер, услуги с ценами, итог, статус, предоплата, оплата, заметки. ' +
      `Период до ${MAX_APPOINTMENT_DAYS} дней.`,
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Первый день, ГГГГ-ММ-ДД' },
        to: { type: 'string', description: 'Последний день включительно, ГГГГ-ММ-ДД (по умолчанию = from)' },
        masterId: { type: 'integer', description: 'Только записи этого мастера' },
        clientQuery: { type: 'string', description: 'Только записи клиента: имя, фамилия или телефон' },
        status: { type: 'string', enum: [...STATUS_FILTERS], description: 'Статус; active = scheduled + confirmed' },
      },
      required: ['from'],
    },
  },
  {
    name: 'client_info',
    description:
      'Карточка клиента по имени или телефону: контакты, Telegram, заметки, визиты, сумма покупок, ближайшие записи и ' +
      'последние услуги и покупки.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Имя, фамилия, телефон или ник' } },
      required: ['query'],
    },
  },
  {
    name: 'analytics',
    description:
      'Отчёт за период: выручка, число продаж, средний чек, возвраты, разбивка по способам оплаты, услуги и товары, ' +
      'топ услуг и товаров (с размерами), по мастерам, предоплаты, новые клиенты, завершённые записи и неявки. ' +
      `Период до ${MAX_REPORT_DAYS} дней.`,
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Первый день, ГГГГ-ММ-ДД' },
        to: { type: 'string', description: 'Последний день включительно, ГГГГ-ММ-ДД' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'stock',
    description:
      'Остатки на складе (украшения, товары, расходники) по размерам в штуках, с минимальными остатками и ценами. ' +
      'query — поиск по названию, категории, материалу, размеру; lowOnly — только то, что заканчивается.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Что ищем, например «лабрет 8 мм» или «перчатки»' },
        lowOnly: { type: 'boolean', description: 'Только позиции на исходе' },
      },
    },
  },
];

const date = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/);
const appointmentsInput = z.object({
  from: date,
  to: date.nullish(),
  masterId: z.number().int().positive().nullish(),
  clientQuery: z.string().trim().max(100).nullish(),
  status: z.enum(STATUS_FILTERS).nullish(),
});
const clientInput = z.object({ query: z.string().trim().min(1).max(100) });
const analyticsInput = z.object({ from: date, to: date });
const stockInput = z.object({ query: z.string().trim().max(100).nullish(), lowOnly: z.boolean().nullish() });

const error = (content: string): ToolResult => ({ content, isError: true });

/** [start, end) of the studio-local days `from`…`to` (inclusive), or an error text. */
function period(db: DbOrTx, from: string, to: string, maxDays: number): { start: number; end: number } | string {
  const tz = studioTimezone(db);
  const first = DateTime.fromISO(from, { zone: tz });
  const last = DateTime.fromISO(to, { zone: tz });
  if (!first.isValid || !last.isValid) return 'Даты нужны в формате ГГГГ-ММ-ДД.';
  const start = first.startOf('day').toMillis();
  const end = last.startOf('day').plus({ days: 1 }).toMillis();
  if (end <= start) return 'Конец периода раньше начала.';
  if (end - start > maxDays * DAY_MS + 2 * 60 * 60 * 1000) return `Период — не больше ${maxDays} дней, раздели запрос.`;
  return { start, end };
}

const DEPOSIT_LABELS: Record<string, string> = {
  waiting: 'ждём',
  paid: 'внесена',
  applied: 'зачтена в оплату',
  refunded: 'возвращена',
  retained: 'удержана',
};

const refName = (c: { name: string; lastName: string | null }) => [c.name, c.lastName].filter((x) => x && x.trim()).join(' ');

/** One appointment for staff: everything, money included. */
function staffAppointmentLine(a: AppointmentOut, tz: string): string {
  const start = DateTime.fromISO(a.startsAt!, { zone: tz }).setLocale('ru');
  const end = DateTime.fromISO(a.endsAt!, { zone: tz });
  const lines = a.services.length
    ? a.services.map((s) => `${s.name} ${formatRub(s.price)}`).join(' + ')
    : a.service?.name ?? a.title ?? 'без услуг';
  const deposit =
    a.depositRequired > 0 || a.deposit > 0
      ? `предоплата ${formatRub(a.deposit)} из ${formatRub(a.depositRequired)} (${DEPOSIT_LABELS[a.depositStatus] ?? a.depositStatus})`
      : null;
  const paid = a.saleId != null ? 'оплачена' : a.status === 'completed' ? 'не оплачена' : null;
  return [
    `№${a.id} · ${start.toFormat('ccc dd.MM HH:mm')}–${end.toFormat('HH:mm')}`,
    `${refName(a.client)}${a.client.phone ? ` (${a.client.phone})` : ''}`,
    `мастер ${a.master.name}`,
    lines,
    `итого ${formatRub(a.price)}`,
    statusLabel(a.status),
    deposit,
    paid,
    a.title && a.services.length ? `описание: ${a.title}` : null,
    a.notes?.trim() ? `заметка: ${a.notes.trim()}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

function appointmentsTool(ctx: AppContext, raw: unknown): ToolResult {
  const parsed = appointmentsInput.safeParse(raw);
  if (!parsed.success) return error('Некорректные данные: from и to — даты ГГГГ-ММ-ДД.');
  const input = parsed.data;
  const { db } = ctx;
  const range = period(db, input.from, input.to ?? input.from, MAX_APPOINTMENT_DAYS);
  if (typeof range === 'string') return error(range);
  let clientIds: number[] | undefined;
  if (input.clientQuery) {
    clientIds = searchClients(db, { search: input.clientQuery, archived: false, limit: 20, offset: 0 }).rows.map((c) => c.id);
    if (clientIds.length === 0) return { content: `Клиент «${input.clientQuery}» не найден.` };
  }
  const statuses = input.status === 'active' ? ['scheduled', 'confirmed'] : input.status ? [input.status] : undefined;
  const rows = listAppointments(db, { from: range.start, to: range.end, masterId: input.masterId ?? undefined, statuses }).filter(
    (a) => clientIds === undefined || clientIds.includes(a.clientId),
  );
  if (rows.length === 0) return { content: 'Записей за этот период нет.' };
  const tz = studioTimezone(db);
  const shown = serializeAppointments(db, rows.slice(0, MAX_APPOINTMENTS));
  const active = rows.filter((a) => a.status !== 'cancelled' && a.status !== 'no_show');
  const summary =
    `Всего записей: ${rows.length} (без отменённых и неявок: ${active.length}), сумма по ним ${formatRub(active.reduce((s, a) => s + a.price, 0))}.` +
    (rows.length > MAX_APPOINTMENTS ? ` Показаны первые ${MAX_APPOINTMENTS} — сузь период или фильтр.` : '');
  return { content: `${summary}\n${shown.map((a) => `• ${staffAppointmentLine(a, tz)}`).join('\n')}` };
}

function clientCard(db: DbOrTx, c: ClientRow): string {
  const tz = studioTimezone(db);
  const stats = clientStats(db, c.id);
  const history = historyEntries(db, { clientId: c.id }).slice(0, CLIENT_HISTORY);
  const upcoming = upcomingForClient(db, c.id);
  return [
    `Клиент [id ${c.id}] ${clientFullName(c)}${c.archived ? ' (в архиве)' : ''}`,
    `Телефон: ${c.phone ?? '—'} · Telegram: ${c.telegramNick ? `@${c.telegramNick}` : c.telegramUsername ? `@${c.telegramUsername}` : '—'}${c.telegramChatId ? ' (бот подключён)' : ''}`,
    [c.birthday ? `День рождения: ${formatBirthday(c.birthday)}` : null, c.instagram ? `Instagram: ${c.instagram}` : null, c.source ? `Источник: ${c.source}` : null]
      .filter(Boolean)
      .join(' · ') || null,
    c.notes?.trim() ? `Заметки: ${c.notes.trim()}` : null,
    `Визитов: ${stats.visits} · Покупок на ${formatRub(stats.totalSpent)} · Последний визит: ${stats.lastVisitAt ? formatShortDate(Date.parse(stats.lastVisitAt), tz) : '—'}`,
    upcoming.length ? `Ближайшие записи:\n${describeForClient(db, upcoming).map((l) => `  • ${l}`).join('\n')}` : 'Ближайших записей нет.',
    history.length
      ? `Последние услуги и покупки:\n${history
          .map(
            (h) =>
              `  • ${formatShortDate(Date.parse(h.date), tz)} ${h.name}${h.quantity > 1 ? ` ×${h.quantity}` : ''} — ${formatRub(h.total)}` +
              `${h.employee ? `, ${h.employee.name}` : ''}${h.refunded ? ' (возврат)' : ''}`,
          )
          .join('\n')}`
      : 'Истории услуг и покупок нет.',
  ]
    .filter(Boolean)
    .join('\n');
}

function clientTool(ctx: AppContext, raw: unknown): ToolResult {
  const parsed = clientInput.safeParse(raw);
  if (!parsed.success) return error('Некорректные данные: передай имя или телефон.');
  const found = [
    ...searchClients(ctx.db, { search: parsed.data.query, archived: false, limit: 10, offset: 0 }).rows,
    ...searchClients(ctx.db, { search: parsed.data.query, archived: true, limit: 5, offset: 0 }).rows,
  ];
  if (found.length === 0) return { content: `Клиент «${parsed.data.query}» не найден.` };
  const more = found.length > MAX_CLIENTS ? `\nЕщё совпадения: ${found.slice(MAX_CLIENTS).map((c) => `${clientFullName(c)} (${c.phone ?? 'без телефона'})`).join(', ')}` : '';
  return { content: found.slice(0, MAX_CLIENTS).map((c) => clientCard(ctx.db, c)).join('\n\n') + more };
}

function analyticsTool(ctx: AppContext, raw: unknown): ToolResult {
  const parsed = analyticsInput.safeParse(raw);
  if (!parsed.success) return error('Некорректные данные: from и to — даты ГГГГ-ММ-ДД.');
  const range = period(ctx.db, parsed.data.from, parsed.data.to, MAX_REPORT_DAYS);
  if (typeof range === 'string') return error(range);
  const report = reportSummary(ctx.db, range.start, range.end);
  const compact = {
    period: `${parsed.data.from} — ${parsed.data.to}`,
    revenue: report.revenue,
    salesCount: report.salesCount,
    averageCheck: report.averageCheck,
    refunds: report.refunds,
    payments: report.payments,
    servicesRevenue: report.servicesRevenue,
    productsRevenue: report.productsRevenue,
    deposits: report.deposits,
    topServices: report.topServices.slice(0, 10).map((s) => ({ name: s.name, quantity: s.quantity, revenue: s.revenue })),
    topProducts: report.topProducts.slice(0, 10).map((p) => ({
      name: p.name,
      quantity: p.quantity,
      revenue: p.revenue,
      sizes: p.variants.filter((v) => v.name).map((v) => ({ size: v.name, quantity: v.quantity, revenue: v.revenue })),
    })),
    byMaster: report.byMaster.map((m) => ({ master: m.employee.name, appointmentsCompleted: m.appointmentsCompleted, revenue: m.revenue })),
    newClients: report.newClients,
    appointmentsCompleted: report.appointmentsCompleted,
    noShows: report.noShows,
    ...(report.byDay.length <= DAYS_FOR_BY_DAY ? { byDay: report.byDay.filter((d) => d.salesCount > 0) } : {}),
  };
  return {
    content:
      'Отчёт (деньги — целые рубли; revenue — выручка без возвратов; payments — как оплачено, deposit — зачтённые предоплаты; ' +
      `deposits — движение предоплат за период, held — на конец периода; byDay — только дни с продажами):\n${JSON.stringify(compact)}`,
  };
}

const KIND_LABELS: Record<string, string> = { jewelry: 'украшение', goods: 'товар', consumable: 'расходник' };
const PRESENCE_LABELS: Record<string, string> = { ok: 'есть', low: 'заканчивается', out: 'нет' };

function stockLine(p: ProductRow, sizes: Array<{ name: string; quantity: number; minQuantity: number; price: number | null }>): string {
  const state =
    p.stockMode === 'presence'
      ? `наличие: ${PRESENCE_LABELS[p.presenceStatus] ?? p.presenceStatus}`
      : sizes
          .map((v) => `${v.name.trim() ? `${v.name.trim()}: ` : ''}${v.quantity} ${p.unit}${v.quantity <= v.minQuantity ? ` ⚠️ мин. ${v.minQuantity}` : ''}`)
          .join(', ') || 'размеров нет';
  return [`[id ${p.id}] ${p.name} (${KIND_LABELS[p.kind] ?? p.kind})`, p.category, state, p.kind !== 'consumable' ? `цена ${formatRub(p.price)}` : null]
    .filter(Boolean)
    .join(' · ');
}

function stockTool(ctx: AppContext, raw: unknown): ToolResult {
  const parsed = stockInput.safeParse(raw ?? {});
  if (!parsed.success) return error('Некорректные данные: query — текст, lowOnly — да/нет.');
  const { db } = ctx;
  let rows = db
    .select()
    .from(products)
    .where(eq(products.active, true))
    .orderBy(asc(products.kind), asc(products.categorySort), asc(products.nameSort), asc(products.id))
    .all();
  const variants = variantsByProduct(db, rows.map((p) => p.id));
  if (parsed.data.lowOnly) {
    // Low = a size at or below its minimum; a presence consumable — status «заканчивается» / «нет».
    rows = rows.filter((p) =>
      p.stockMode === 'presence' ? p.presenceStatus !== 'ok' : (variants.get(p.id) ?? []).some((v) => v.quantity <= v.minQuantity),
    );
  }
  const words = parsed.data.query ? searchKey(parsed.data.query).split(/\s+/).filter(Boolean) : [];
  if (words.length) rows = rows.filter((p) => words.every((w) => searchKey(p.searchText, p.description).includes(w.length > 5 ? w.slice(0, -2) : w)));
  if (rows.length === 0) return { content: parsed.data.lowOnly ? 'Ничего не заканчивается.' : 'Ничего не найдено.' };
  const lines = rows.slice(0, MAX_STOCK_ROWS).map((p) => `• ${stockLine(p, variants.get(p.id) ?? [])}`);
  const more = rows.length > MAX_STOCK_ROWS ? `\nПоказаны ${MAX_STOCK_ROWS} из ${rows.length} — уточни запрос.` : '';
  return { content: `Остатки (⚠️ — на минимуме или ниже):\n${lines.join('\n')}${more}` };
}

function todayTool(ctx: AppContext): ToolResult {
  const { db } = ctx;
  const tz = studioTimezone(db);
  const day = localDayBounds(Date.now(), tz);
  const rows = listAppointments(db, { from: day.start, to: day.end, statuses: ['scheduled', 'confirmed', 'completed', 'no_show'] });
  const report = reportSummary(db, day.start, day.end);
  const shift = getOpenShift(db);
  const shiftOut = shift ? serializeShift(db, shift, false) : null;
  const counts = badges(db);
  const requests = db
    .select()
    .from(bookingRequests)
    .where(eq(bookingRequests.status, 'new'))
    .orderBy(desc(bookingRequests.createdAt))
    .limit(5)
    .all();
  return {
    content: [
      `Сегодня ${day.date}.`,
      rows.length
        ? `Записи (${rows.length}):\n${serializeAppointments(db, rows).map((a) => `• ${staffAppointmentLine(a, tz)}`).join('\n')}`
        : 'Записей на сегодня нет.',
      `Продажи сегодня: ${report.salesCount} на ${formatRub(report.revenue)} (наличные ${formatRub(report.payments.cash)}, перевод ${formatRub(report.payments.transfer)}, ` +
        `QR ${formatRub(report.payments.qr)}, карта ${formatRub(report.payments.card)}, предоплатой ${formatRub(report.payments.deposit)}); возвраты ${formatRub(report.refunds)}.`,
      shiftOut
        ? `Кассовая смена открыта (${shiftOut.openedBy?.name ?? '—'}), в кассе должно быть ${formatRub(shiftOut.expectedCash)}.`
        : 'Кассовая смена не открыта.',
      `Новых заявок на запись: ${counts.newBookingRequests}${
        requests.length
          ? `\n${requests.map((r) => `  • №${r.id} ${r.contactName ?? '—'}, ${r.phone ?? '—'}: ${r.serviceName ?? '—'}, ${r.preferredTime ?? '—'}`).join('\n')}`
          : ''
      }`,
      `Чатов ждут ответа сотрудника: ${counts.needsAttention}. Непрочитанных чатов: ${counts.unreadChats}. Позиций на исходе: ${counts.lowStock}.`,
    ].join('\n'),
  };
}

/** Tools for the employee of the chat: reports follow the role (docs/API.md «Roles»), the rest are open to all. */
export function buildStaffToolHandlers(ctx: AppContext, employee: Pick<EmployeeRow, 'role'>): Record<string, ToolHandler> {
  return {
    today: async () => todayTool(ctx),
    appointments: async (raw) => appointmentsTool(ctx, raw),
    client_info: async (raw) => clientTool(ctx, raw),
    analytics: async (raw) => (roleOf(employee) === 'master' ? error(REPORTS_MESSAGE) : analyticsTool(ctx, raw)),
    stock: async (raw) => stockTool(ctx, raw),
  };
}
