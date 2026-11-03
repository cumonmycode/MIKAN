import { and, gte, inArray, isNull, lt } from 'drizzle-orm';
import { DateTime } from 'luxon';
import type { AppContext } from '../context.js';
import type { DbOrTx } from '../db/client.js';
import { appointments, botChats } from '../db/schema.js';
import { certificatesIssued } from '../domain/analytics-loyalty.js';
import { loadPeriodSales, revenueSection } from '../domain/analytics-sales.js';
import { listAppointments } from '../domain/appointments.js';
import { bookableMasters } from '../domain/free-slots.js';
import { chatEmployee, storeMessage } from '../domain/bot-chats.js';
import { getOpenShift, serializeShift } from '../domain/cash.js';
import { listReceipts } from '../domain/receipts.js';
import { clientsByIds, serializeAppointments } from '../domain/refs.js';
import { badges } from '../domain/reports.js';
import { getBotSettings, getDigestsSent, setDigestsSent, studioTimezone, type DigestsSent } from '../domain/settings.js';
import { whoWorksText } from '../domain/working-time.js';
import { isBirthdayOn } from '../lib/birthday.js';
import { errorMessage } from '../lib/errors.js';
import type { AppointmentOut, EmployeeRow } from '../lib/serialize.js';
import { formatRub } from '../lib/text.js';
import { DAY_MS, localDayBounds, parseTimeOfDay } from '../lib/time.js';

/**
 * Staff digests (docs/API.md «Staff digests»): a morning summary of the day ahead and an evening summary of the day,
 * built from the data without the AI and sent to every staff chat at the times set in the bot settings.
 */

export type DigestKind = 'morning' | 'evening';

/** How long after its time a digest may still go out (e.g. after a restart); later it waits for the next day. */
export const DIGEST_GRACE_MS = 3 * 60 * 60_000;
export const DIGEST_CHECK_INTERVAL_MS = 60_000;
/** Longest list of appointments in a digest; the rest is counted. */
const MAX_LINES = 12;
/** Unpaid past visits are looked for this far back. */
const UNPAID_LOOKBACK_DAYS = 30;
const OPEN = ['scheduled', 'confirmed', 'completed'];

const fullName = (c: { name: string; lastName: string | null }) => [c.name, c.lastName].filter((x) => x?.trim()).join(' ');
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const dayTitle = (ms: number, tz: string) => capitalize(DateTime.fromMillis(ms, { zone: tz }).setLocale('ru').toFormat('cccc, d MMMM'));
const time = (iso: string, tz: string) => DateTime.fromISO(iso, { zone: tz }).toFormat('HH:mm');
const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10;
  const m100 = n % 100;
  const word = m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
  return `${n} ${word}`;
};
const visits = (n: number) => plural(n, 'запись', 'записи', 'записей');

function servicesOf(a: AppointmentOut): string {
  return a.services.length ? a.services.map((s) => s.name).join(', ') : (a.service?.name ?? a.title?.trim() ?? 'без услуг');
}

/** «• **10:00** Анна Иванова — Мочка · Фатима · 1 600 ₽», the recipient's own visits marked «вы». */
function appointmentLine(a: AppointmentOut, tz: string, employee: EmployeeRow, extra: string[] = []): string {
  const master = a.master.id === employee.id ? 'вы' : a.master.name;
  const marks = [a.saleId != null ? '✅' : null, ...extra].filter(Boolean).join(' ');
  return `• **${time(a.startsAt!, tz)}** ${fullName(a.client)} — ${servicesOf(a)} · ${master} · ${formatRub(a.price)}${marks ? ` ${marks}` : ''}`;
}

function lines(items: string[]): string[] {
  return items.length > MAX_LINES ? [...items.slice(0, MAX_LINES), `…и ещё ${items.length - MAX_LINES}`] : items;
}

function dayAppointments(db: DbOrTx, start: number, end: number, statuses = OPEN): AppointmentOut[] {
  return serializeAppointments(db, listAppointments(db, { from: start, to: end, statuses }));
}

/** Clients of these visits whose birthday is on `date` (`YYYY-MM-DD`; day and month only — 1900 is «year unknown»). */
function birthdays(db: DbOrTx, rows: AppointmentOut[], date: string): Set<number> {
  const clients = clientsByIds(db, rows.map((a) => a.client.id));
  return new Set([...clients.values()].filter((c) => c.birthday && isBirthdayOn(c.birthday, date)).map((c) => c.id));
}

const awaitingDeposit = (a: AppointmentOut) => a.depositStatus === 'waiting' && a.depositRequired > 0;

/** «⏳ Ждём предоплату: Анна (сегодня 12:00, 2 000 ₽), Олег (завтра 15:00, 1 000 ₽)». */
function depositsLine(today: AppointmentOut[], tomorrow: AppointmentOut[], tz: string): string | null {
  const waiting = [
    ...today.filter(awaitingDeposit).map((a) => `${fullName(a.client)} (сегодня ${time(a.startsAt!, tz)}, ${formatRub(a.depositRequired)})`),
    ...tomorrow.filter(awaitingDeposit).map((a) => `${fullName(a.client)} (завтра ${time(a.startsAt!, tz)}, ${formatRub(a.depositRequired)})`),
  ];
  return waiting.length ? `• ⏳ Ждём предоплату: ${waiting.join(', ')}` : null;
}

/** Past visits (last 30 days) that are still not paid. */
function unpaidPast(db: DbOrTx, before: number, tz: string): string | null {
  const rows = db
    .select()
    .from(appointments)
    .where(
      and(
        gte(appointments.startsAt, before - UNPAID_LOOKBACK_DAYS * DAY_MS),
        lt(appointments.startsAt, before),
        isNull(appointments.saleId),
        inArray(appointments.status, OPEN),
      ),
    )
    .orderBy(appointments.startsAt)
    .all();
  if (rows.length === 0) return null;
  const shown = serializeAppointments(db, rows.slice(0, 3)).map(
    (a) => `${fullName(a.client)} (${DateTime.fromISO(a.startsAt!, { zone: tz }).toFormat('dd.MM')}, ${formatRub(a.price)})`,
  );
  const more = rows.length > 3 ? ` и ещё ${rows.length - 3}` : '';
  return `• 💳 Не оплачены прошлые визиты: ${rows.length} — ${shown.join(', ')}${more}`;
}

function tomorrowLine(rows: AppointmentOut[], tz: string): string {
  if (rows.length === 0) return '📆 **Завтра** записей пока нет';
  return `📆 **Завтра** — ${visits(rows.length)}, первая в ${time(rows[0]!.startsAt!, tz)}`;
}

export function morningDigest(db: DbOrTx, now: number, employee: EmployeeRow): string {
  const tz = studioTimezone(db);
  const today = localDayBounds(now, tz);
  const tomorrow = localDayBounds(today.end, tz);
  const todayRows = dayAppointments(db, today.start, today.end);
  const tomorrowRows = dayAppointments(db, tomorrow.start, tomorrow.end);
  const born = birthdays(db, todayRows, today.date);
  const expected = todayRows.reduce((sum, a) => sum + a.price, 0);
  const counts = badges(db);
  const shift = getOpenShift(db);
  const staleReceipts = listReceipts(db).filter((r) => r.createdAt < today.start).length;
  const working = whoWorksText(db, bookableMasters(db), today.date);

  const attention = [
    depositsLine(todayRows, tomorrowRows, tz),
    unpaidPast(db, today.start, tz),
    staleReceipts ? `• 🧾 Открытые чеки с прошлых дней: ${staleReceipts} — закройте или удалите` : null,
    shift && shift.openedAt < today.start
      ? `• 🏦 Кассовая смена с ${DateTime.fromMillis(shift.openedAt, { zone: tz }).toFormat('dd.MM')} не закрыта`
      : null,
    counts.newBookingRequests ? `• 📝 Новые заявки на запись: ${counts.newBookingRequests}` : null,
    counts.needsAttention ? `• 💬 Ждут ответа в чатах: ${counts.needsAttention}` : null,
    counts.lowStock ? `• 📦 Заканчивается на складе: ${plural(counts.lowStock, 'позиция', 'позиции', 'позиций')}` : null,
    ...todayRows
      .filter((a) => born.has(a.client.id))
      .map((a) => `• 🎂 Сегодня день рождения: ${fullName(a.client)} — запись в ${time(a.startsAt!, tz)}`),
  ].filter((x): x is string => x !== null);

  return [
    `☀️ **Доброе утро, ${employee.name}!**`,
    dayTitle(now, tz),
    ...(working ? ['', `👥 ${working}`] : []),
    '',
    todayRows.length
      ? [
          `📅 **Сегодня — ${visits(todayRows.length)}** · ожидается ${formatRub(expected)}`,
          ...lines(todayRows.map((a) => appointmentLine(a, tz, employee, born.has(a.client.id) ? ['🎂'] : []))),
        ].join('\n')
      : '📅 **Сегодня записей нет**',
    '',
    attention.length ? ['⚠️ **Обратить внимание**', ...attention].join('\n') : '✅ Всё спокойно — ничего срочного',
    '',
    tomorrowLine(tomorrowRows, tz),
  ].join('\n');
}

/**
 * «💰 Выручка» of the day as analytics counts it (docs/API.md «Analytics»): sales made minus refunds made that day,
 * without bonuses paid and certificates sold; the payment split of the sales made, certificates sold, refunds.
 */
function moneyBlock(db: DbOrTx, from: number, to: number): string {
  const revenue = revenueSection(loadPeriodSales(db, from, to));
  const refunds = revenue.refunds ? `• ↩️ Возвраты: ${formatRub(revenue.refunds)}` : null;
  if (revenue.salesCount === 0) return ['💰 Продаж сегодня не было', ...(refunds ? [refunds] : [])].join('\n');
  const p = revenue.payments;
  const methods = (
    [
      ['наличные', p.cash],
      ['перевод', p.transfer],
      ['QR', p.qr],
      ['карта', p.card],
      ['предоплатой', p.deposit],
      ['бонусами', p.bonus],
      ['сертификатом', p.certificate],
    ] as const
  )
    .filter(([, amount]) => amount > 0)
    .map(([label, amount]) => `${label} ${formatRub(amount)}`);
  const sold = certificatesIssued(db, from, to);
  return [
    `💰 **Выручка — ${formatRub(revenue.net)}**`,
    `• ${plural(revenue.salesCount, 'чек', 'чека', 'чеков')} · средний ${formatRub(revenue.averageCheck)}`,
    ...(methods.length ? [`• ${capitalize(methods.join(' · '))}`] : []),
    ...(sold.count ? [`• 🎁 Продано сертификатов: ${sold.count} на ${formatRub(sold.amount)}`] : []),
    ...(refunds ? [refunds] : []),
  ].join('\n');
}

export function eveningDigest(db: DbOrTx, now: number, employee: EmployeeRow): string {
  const tz = studioTimezone(db);
  const today = localDayBounds(now, tz);
  const tomorrow = localDayBounds(today.end, tz);
  const all = dayAppointments(db, today.start, today.end, [...OPEN, 'cancelled', 'no_show']);
  const tomorrowRows = dayAppointments(db, tomorrow.start, tomorrow.end);
  const shift = getOpenShift(db);
  const receipts = listReceipts(db).length;
  const unpaid = all.filter((a) => a.saleId == null && OPEN.includes(a.status) && Date.parse(a.startsAt!) < now);

  const count = (status: string) => all.filter((a) => a.status === status).length;
  const outcome = [
    count('completed') ? `${count('completed')} прошли` : null,
    count('no_show') ? `${plural(count('no_show'), 'неявка', 'неявки', 'неявок')}` : null,
    count('cancelled') ? `${plural(count('cancelled'), 'отмена', 'отмены', 'отмен')}` : null,
  ].filter(Boolean);

  const blocks = [
    `🌙 **Итоги дня, ${employee.name}**`,
    dayTitle(now, tz),
    '',
    moneyBlock(db, today.start, today.end),
    '',
    all.length ? `📅 **Визиты:** ${outcome.length ? outcome.join(' · ') : visits(all.length)}` : '📅 Визитов сегодня не было',
  ];
  if (unpaid.length) blocks.push('', '💳 **Не оплачены сегодня**', ...lines(unpaid.map((a) => appointmentLine(a, tz, employee))));
  const reminders = [
    receipts ? `• 🧾 Открытые чеки: ${receipts} — закройте или удалите` : null,
    shift ? `• 🏦 Смена открыта — в кассе должно быть **${formatRub(serializeShift(db, shift, false).expectedCash)}**. Не забудьте закрыть` : null,
  ].filter((x): x is string => x !== null);
  if (reminders.length) blocks.push('', '⚠️ **Перед уходом**', ...reminders);
  blocks.push('', tomorrowRows.length ? `📆 **Завтра — ${visits(tomorrowRows.length)}**` : '📆 **Завтра** записей пока нет');
  if (tomorrowRows.length) {
    blocks.push(...lines(tomorrowRows.map((a) => appointmentLine(a, tz, employee, awaitingDeposit(a) ? ['⏳'] : []))));
    if (tomorrowRows.some(awaitingDeposit)) blocks.push('⏳ — ждём предоплату');
  }
  return blocks.join('\n');
}

/** The digest whose time has come today and that was not sent yet, if any. */
export function dueDigest(kind: DigestKind, at: string | null, now: number, tz: string, sent: DigestsSent): string | null {
  if (!at) return null;
  const minutes = parseTimeOfDay(at);
  if (minutes === null) return null;
  const day = localDayBounds(now, tz);
  const moment = DateTime.fromMillis(day.start, { zone: tz }).plus({ minutes }).toMillis();
  if (now < moment || now >= moment + DIGEST_GRACE_MS || sent[kind] === day.date) return null;
  return day.date;
}

/** Chats of active employees (staff mode). */
function staffChats(db: DbOrTx): Array<{ chatId: number; employee: EmployeeRow }> {
  return db
    .select()
    .from(botChats)
    .all()
    .map((chat) => ({ chatId: chat.chatId, employee: chatEmployee(db, chat) }))
    .filter((c): c is { chatId: number; employee: EmployeeRow } => c.employee !== null);
}

/** Sends the digests that are due (checked every minute). Returns how many messages went out. */
export async function sendDueDigests(ctx: AppContext, now = Date.now()): Promise<number> {
  const { db } = ctx;
  if (!ctx.gateway.isRunning()) return 0;
  const settings = getBotSettings(db);
  const tz = studioTimezone(db);
  let delivered = 0;
  for (const kind of ['morning', 'evening'] as const) {
    const sent = getDigestsSent(db);
    const date = dueDigest(kind, kind === 'morning' ? settings.morningDigestAt : settings.eveningDigestAt, now, tz, sent);
    if (!date) continue;
    // Marked first: a crash halfway must not send the digest twice.
    setDigestsSent(db, { ...sent, [kind]: date });
    for (const { chatId, employee } of staffChats(db)) {
      const text = kind === 'morning' ? morningDigest(db, now, employee) : eveningDigest(db, now, employee);
      try {
        await ctx.gateway.sendText(chatId, text);
        storeMessage(db, chatId, 'assistant', text);
        delivered += 1;
      } catch (err) {
        ctx.log.warn({ chatId, kind, err: errorMessage(err) }, 'staff digest not delivered');
      }
    }
  }
  return delivered;
}
