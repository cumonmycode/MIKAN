import { DateTime } from 'luxon';
import { formatRub, truncate } from '../lib/text.js';
import { diffChanges, type AuditDraft } from './audit.js';
import type { SummaryBuilder, SummaryContext } from './audit-summaries.js';
import {
  dativeName,
  describeChanges,
  entityOf,
  formatDay,
  formatDayRange,
  formatWhen,
  hoursText,
  labelsSuffix,
  maybeEntity,
  numberOf,
  personName,
  quote,
  ROLE_TITLES,
  textOf,
  weeklyText,
} from './audit-text.js';

/**
 * Audit summaries of the team and the studio: employees, work schedules, payroll, settings, the knowledge base and
 * the bot. Schedules and payroll follow docs/API.md («Work schedules», «Payroll»).
 */

interface EmployeeOut {
  id: number;
  name: string;
  role?: string;
  active: boolean;
}
interface NamedRef {
  id: number;
  name: string;
}
/** The schedule and pay-rules snapshot: who, and what was there before. */
interface TeamSnapshot {
  name?: string;
  weekly?: unknown;
  rules?: Record<string, unknown> | null;
}

const draft = (entity: string, verb: string, entityId: number | null, summary: string, changes: AuditDraft['changes'] = null): AuditDraft => ({
  action: `${entity}.${verb}`,
  entity,
  entityId,
  summary,
  changes,
});

const alsoChanged = (words: string[]): string => (words.length ? `; также изменено: ${words.join(', ')}` : '');
const roleTitle = (role: string | undefined) => (role ? (ROLE_TITLES[role] ?? role) : '—');

// ---------- employees ----------

const EMPLOYEE_LABELS: Record<string, string> = {
  name: 'имя',
  login: 'логин',
  phone: 'телефон',
  color: 'цвет',
  isMaster: 'мастер',
};

function employeeCreate(c: SummaryContext): AuditDraft {
  const e = entityOf<EmployeeOut>(c.result);
  return draft('employee', 'create', e.id, `Новый сотрудник: ${e.name}${e.role ? ` (${roleTitle(e.role)})` : ''}`);
}

/** A role, then deactivation, then the profile; a password change is named, never stored. */
function employeeUpdate(c: SummaryContext): AuditDraft {
  const after = entityOf<EmployeeOut>(c.result);
  const before = maybeEntity<EmployeeOut>(c.before);
  const changes = diffChanges(before, after);
  const words = [...describeChanges(changes, EMPLOYEE_LABELS), ...(textOf(c.body.password) ? ['пароль'] : [])];
  if (before && before.role !== after.role) {
    const dative = dativeName(after.name);
    const summary = dative
      ? `${dative} назначена роль ${quote(roleTitle(after.role))}`
      : `Роль сотрудника ${quote(after.name)}: ${roleTitle(before.role)} → ${roleTitle(after.role)}`;
    return draft('employee', 'role', after.id, `${summary}${alsoChanged(words)}`, changes);
  }
  if (before && before.active !== after.active) {
    const summary = `Учётная запись ${quote(after.name)} ${after.active ? 'снова включена' : 'отключена'}`;
    return draft('employee', after.active ? 'activate' : 'deactivate', after.id, `${summary}${alsoChanged(words)}`, changes);
  }
  const summary = words.length ? `Профиль ${quote(after.name)} изменён${labelsSuffix(words)}` : `Профиль ${quote(after.name)} сохранён без изменений`;
  return draft('employee', 'update', after.id, summary, changes);
}

// ---------- work schedules (entity `schedule`, id of the employee) ----------

const employeeIdOf = (c: SummaryContext): number | null => {
  const id = Number(c.params.id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};
const scheduleOf = (c: SummaryContext) => `График сотрудника ${quote((c.before as TeamSnapshot | undefined)?.name ?? `№${c.params.id}`)}`;

function scheduleWeekly(c: SummaryContext): AuditDraft {
  const result = c.result as { weekly?: unknown } | undefined;
  const weekly = (result && 'weekly' in result ? result.weekly : c.body.weekly) as Parameters<typeof weeklyText>[0];
  const before = (c.before as TeamSnapshot | undefined)?.weekly ?? null;
  const changes = JSON.stringify(before) === JSON.stringify(weekly ?? null) ? null : { weekly: { from: before, to: weekly ?? null } };
  return draft('schedule', 'weekly', employeeIdOf(c), `${scheduleOf(c)} изменён: ${weeklyText(weekly)}`, changes);
}

function scheduleDays(c: SummaryContext): AuditDraft {
  const from = textOf(c.body.from) ?? '';
  const days = formatDayRange(from, textOf(c.body.to) ?? from, c.now, c.tz);
  const start = textOf(c.body.start);
  const end = textOf(c.body.end);
  const breaks = Array.isArray(c.body.breaks) ? (c.body.breaks as Array<{ start: string; end: string }>) : [];
  const what = c.body.off === true || !start || !end ? 'выходной' : hoursText({ start, end, breaks });
  const note = textOf(c.body.note);
  return draft('schedule', 'days', employeeIdOf(c), `${scheduleOf(c)}: ${days} — ${what}${note ? ` (${note})` : ''}`);
}

function scheduleDaysReset(c: SummaryContext): AuditDraft {
  const from = textOf(c.query.from);
  const range = from ? ` на ${formatDayRange(from, textOf(c.query.to) ?? from, c.now, c.tz)}` : '';
  return draft('schedule', 'days_reset', employeeIdOf(c), `${scheduleOf(c)}: исключения${range} убраны`);
}

// ---------- payroll (entity `payroll`, id of the employee) ----------

const RULE_FIELDS = ['salaryMonthly', 'perDay', 'servicePercent', 'categoryPercent', 'productPercent', 'deductMaterials'];
const CATEGORY_TITLES: Record<string, string> = { tattoo: 'тату', piercing: 'пирсинг', other: 'другое' };

/** «оклад 30 000 ₽ в месяц, 1 500 ₽ за день, 40% с услуг (тату 50%), 10% с товаров, материалы вычитаются» */
export function payRulesText(rules: Record<string, unknown>): string {
  const parts: string[] = [];
  const salary = numberOf(rules.salaryMonthly) ?? 0;
  const perDay = numberOf(rules.perDay) ?? 0;
  const service = numberOf(rules.servicePercent) ?? 0;
  const product = numberOf(rules.productPercent) ?? 0;
  const categories = Object.entries((rules.categoryPercent as Record<string, unknown> | null | undefined) ?? {})
    .filter(([, percent]) => typeof percent === 'number')
    .map(([category, percent]) => `${CATEGORY_TITLES[category] ?? category} ${percent}%`);
  if (salary > 0) parts.push(`оклад ${formatRub(salary)} в месяц`);
  if (perDay > 0) parts.push(`${formatRub(perDay)} за день`);
  if (service > 0 || categories.length) parts.push(`${service}% с услуг${categories.length ? ` (${categories.join(', ')})` : ''}`);
  if (product > 0) parts.push(`${product}% с товаров`);
  if (rules.deductMaterials === true) parts.push('материалы вычитаются');
  return parts.join(', ') || 'без начислений';
}

function payRules(c: SummaryContext): AuditDraft {
  const before = c.before as TeamSnapshot | undefined;
  const rules = Object.fromEntries(RULE_FIELDS.filter((key) => key in c.body).map((key) => [key, c.body[key]]));
  const effectiveFrom = textOf(c.body.effectiveFrom) ?? DateTime.fromMillis(c.now, { zone: c.tz }).toISODate() ?? '';
  const name = before?.name ?? `№${c.params.id}`;
  const summary = `Правила зарплаты сотрудника ${quote(name)} с ${formatDay(effectiveFrom, c.now, c.tz)}: ${payRulesText(rules)}`;
  return draft('payroll', 'rules', employeeIdOf(c), summary, diffChanges(before?.rules ?? null, rules));
}

const ADJUSTMENT_TITLES: Record<string, string> = { bonus: 'Премия', penalty: 'Штраф', advance: 'Аванс', payout: 'Выплата' };

interface AdjustmentOut {
  id: number;
  employee: NamedRef;
  kind: string;
  amount: number;
  note: string | null;
  cashOperationId: number | null;
}

function adjustmentCreate(c: SummaryContext): AuditDraft {
  const a = entityOf<AdjustmentOut>(c.result);
  const title = ADJUSTMENT_TITLES[a.kind] ?? a.kind;
  const cash = a.cashOperationId != null ? ', из кассы' : '';
  const note = a.note && a.note !== title ? ` — ${a.note}` : '';
  return draft('payroll', 'adjustment', a.employee.id, `${title} сотруднику ${quote(a.employee.name)}: ${formatRub(a.amount)}${cash}${note}`);
}

function adjustmentDelete(c: SummaryContext): AuditDraft {
  const a = maybeEntity<AdjustmentOut>(c.before);
  if (!a) return draft('payroll', 'adjustment_delete', null, `Удалена запись зарплаты №${c.params.id}`);
  const title = (ADJUSTMENT_TITLES[a.kind] ?? a.kind).toLowerCase();
  return draft('payroll', 'adjustment_delete', a.employee.id, `Удалена запись зарплаты: ${title} ${formatRub(a.amount)}, сотрудник ${quote(a.employee.name)}`);
}

// ---------- settings ----------

const STUDIO_LABELS: Record<string, string> = {
  name: 'название',
  address: 'адрес',
  phone: 'телефон',
  workingHours: 'часы работы для клиентов',
  instagram: 'Instagram',
  website: 'сайт',
  about: 'о студии',
  timezone: 'часовой пояс',
  workdayStart: 'начало рабочего дня',
  workdayEnd: 'конец рабочего дня',
  cancellation: 'правила отмены',
  reviewLinks: 'ссылки на отзывы',
  pos: 'чек клиенту в Telegram',
};
const BOT_LABELS: Record<string, string> = {
  aiEnabled: 'ответы ИИ',
  greeting: 'приветствие',
  extraInstructions: 'инструкции для ИИ',
  aftercareHour: 'время памяток',
  remindersEnabled: 'напоминания',
  reminderOffsets: 'время напоминаний',
  morningDigestAt: 'утренняя сводка',
  eveningDigestAt: 'вечерняя сводка',
};
const BOT_IGNORE = ['reminderHoursBefore', 'botUsername', 'staffChatBound', 'aiConfigured'];

function studioSettings(c: SummaryContext): AuditDraft {
  const changes = diffChanges(c.before, c.result);
  const words = describeChanges(changes, STUDIO_LABELS);
  const summary = words.length ? `Настройки студии изменены${labelsSuffix(words)}` : 'Настройки студии сохранены без изменений';
  return draft('settings', 'studio', null, summary, changes);
}

function botSettings(c: SummaryContext): AuditDraft {
  const changes = diffChanges(c.before, c.result, BOT_IGNORE);
  const words = describeChanges(changes, BOT_LABELS);
  const enabled = changes?.enabled;
  if (enabled) return draft('settings', 'bot', null, `${enabled.to ? 'Бот включён' : 'Бот выключен'}${alsoChanged(words)}`, changes);
  const summary = words.length ? `Настройки бота изменены${labelsSuffix(words)}` : 'Настройки бота сохранены без изменений';
  return draft('settings', 'bot', null, summary, changes);
}

// ---------- knowledge base ----------

const KNOWLEDGE_LABELS: Record<string, string> = { title: 'заголовок', content: 'текст', active: 'показ боту', sort: 'порядок' };

function knowledge(verb: 'create' | 'update' | 'delete', word: string): SummaryBuilder {
  return (c) => {
    const entry = entityOf<{ id: number; title: string }>(verb === 'delete' ? c.before : c.result);
    const changes = verb === 'update' ? diffChanges(c.before, entry) : null;
    const words = verb === 'update' ? labelsSuffix(describeChanges(changes, KNOWLEDGE_LABELS)) : '';
    return draft('knowledge', verb, entry.id, `Запись базы знаний ${quote(entry.title)} ${word}${words}`, changes);
  };
}

// ---------- the bot: chats, scheduled messages, booking requests (entity `bot`) ----------

interface ChatOut {
  chatId: number;
  client: { name?: unknown; lastName?: unknown } | null;
  employee: NamedRef | null;
  telegramName: string | null;
  username: string | null;
  aiPaused: boolean;
}

function chatName(chat: ChatOut | undefined, chatId: number): string {
  if (!chat) return `№${chatId}`;
  if (chat.client) return quote(personName(chat.client));
  const name = [chat.telegramName, chat.username ? `@${chat.username}` : null].filter(Boolean).join(' ');
  return quote(name || String(chatId));
}

const chatOf = (value: unknown): ChatOut | undefined =>
  value !== null && typeof value === 'object' && typeof (value as ChatOut).chatId === 'number' ? (value as ChatOut) : undefined;
const chatIdOf = (c: SummaryContext) => Number(c.params.chatId);

function chatMessage(c: SummaryContext): AuditDraft {
  const text = textOf((c.result as { text?: unknown } | undefined)?.text) ?? textOf(c.body.text) ?? '';
  const summary = `Ответ в чате ${chatName(chatOf(c.before), chatIdOf(c))}: ${quote(truncate(text, 80))}`;
  return draft('bot', 'message', chatIdOf(c), summary);
}

function chatPause(c: SummaryContext): AuditDraft {
  const chat = chatOf(c.result);
  const summary = chat?.aiPaused
    ? `ИИ в чате ${chatName(chat, chatIdOf(c))} на паузе`
    : `ИИ в чате ${chatName(chat, chatIdOf(c))} снова отвечает`;
  return draft('bot', 'chat_update', chatIdOf(c), summary, diffChanges(c.before, c.result, ['lastMessage', 'unreadCount']));
}

function chatBind(c: SummaryContext): AuditDraft {
  const chat = chatOf(c.result);
  const employee = chat?.employee ? quote(chat.employee.name) : 'сотрудника';
  return draft('bot', 'chat_bind', chatIdOf(c), `Чат ${chatName(chatOf(c.before) ?? chat, chatIdOf(c))} привязан к сотруднику ${employee}`);
}

function chatUnbind(c: SummaryContext): AuditDraft {
  const chat = chatOf(c.before);
  const employee = chat?.employee ? ` ${quote(chat.employee.name)}` : '';
  return draft('bot', 'chat_unbind', chatIdOf(c), `Чат ${chatName(chat, chatIdOf(c))} отвязан от сотрудника${employee}`);
}

const SCHEDULED_TITLES: Record<string, string> = {
  aftercare: 'памятка по уходу',
  reminder: 'напоминание',
  healing_check: 'вопрос о заживлении',
  jewelry_change: 'предложение заменить украшение',
  reschedule_notice: 'сообщение о переносе',
};

function scheduledCancel(c: SummaryContext): AuditDraft {
  const m = entityOf<{ id: number; kind: string; client: unknown; sendAt: string }>(c.result);
  const what = SCHEDULED_TITLES[m.kind] ?? m.kind;
  const summary = `Отменено сообщение бота: ${what} для ${quote(personName(m.client as { name?: unknown } | null))} на ${formatWhen(m.sendAt, c.tz, c.now)}`;
  return draft('bot', 'scheduled_cancel', m.id, summary);
}

const BOOKING_STATUS: Record<string, string> = { processed: 'обработана', rejected: 'отклонена', new: 'снова в новых' };

function bookingUpdate(c: SummaryContext): AuditDraft {
  const b = entityOf<{ id: number; status: string; contactName: string | null; client: unknown }>(c.result);
  const who = b.client ? personName(b.client as { name?: unknown }) : b.contactName;
  const summary = `Заявка на запись №${b.id}${who ? ` (${who})` : ''} ${BOOKING_STATUS[b.status] ?? b.status}`;
  return draft('bot', 'booking_update', b.id, summary);
}

// ---------- sign-in sessions (entity `employee`, id of the employee) ----------

interface SessionSnapshot {
  employee: NamedRef;
  device: string | null;
}

const onDevice = (s: SessionSnapshot | undefined) => (s?.device ? ` на устройстве ${quote(s.device)}` : '');

function logout(c: SummaryContext): AuditDraft {
  const session = c.before as SessionSnapshot | undefined;
  return draft('employee', 'logout', session?.employee.id ?? null, `Выход из приложения${onDevice(session)}`);
}

function sessionEnd(c: SummaryContext): AuditDraft {
  const session = c.before as SessionSnapshot | undefined;
  const whose = session ? ` ${quote(session.employee.name)}` : ` №${c.params.id}`;
  return draft('employee', 'session_end', session?.employee.id ?? null, `Сессия${whose}${onDevice(session)} завершена`);
}

export const teamSummaries: Record<string, SummaryBuilder> = {
  'POST /employees': employeeCreate,
  'PATCH /employees/:id': employeeUpdate,
  'PUT /employees/:id/schedule': scheduleWeekly,
  'PUT /employees/:id/schedule/days': scheduleDays,
  'DELETE /employees/:id/schedule/days': scheduleDaysReset,
  'PUT /employees/:id/pay-rules': payRules,
  'POST /payroll/adjustments': adjustmentCreate,
  'DELETE /payroll/adjustments/:id': adjustmentDelete,
  'PUT /settings/studio': studioSettings,
  'PUT /settings/bot': botSettings,
  'POST /knowledge': knowledge('create', 'добавлена'),
  'PATCH /knowledge/:id': knowledge('update', 'изменена'),
  'DELETE /knowledge/:id': knowledge('delete', 'удалена'),
  'POST /bot/chats/:chatId/messages': chatMessage,
  'PATCH /bot/chats/:chatId': chatPause,
  'PUT /bot/chats/:chatId/employee': chatBind,
  'DELETE /bot/chats/:chatId/employee': chatUnbind,
  'POST /bot/scheduled/:id/cancel': scheduledCancel,
  'POST /bot/test': () => draft('bot', 'test', null, 'Бот проверен тестовым сообщением'),
  'PATCH /booking-requests/:id': bookingUpdate,
  'POST /auth/logout': logout,
  'DELETE /auth/sessions/:id': sessionEnd,
};
