// @ts-check
/**
 * Pure rules of the client cabinet `/book/me`: the sign-in token of the website link, what each appointment shows and
 * what cancelling it means, bonus and waitlist wording, aftercare days. No DOM here, so tests run them in Node.
 */
import { ApiError } from './api.js';
import { addDays, dateIn, formatDateTime, formatDayLong, formatRub, plural } from './format.js';

export const CABINET_PATH = '/book/me';
export const CABINET_API = '/api/public/cabinet';
/** The parameter of the bot's website link `PUBLIC_URL/book/me#t=<token>` (also read from the query). */
export const TOKEN_PARAM = 't';
export const TOKEN_STORAGE_KEY = 'mikan.cabinet.token';

/** The cabinet tabs, in order. */
export const TABS = /** @type {const} */ ([
  { key: 'visits', title: 'Записи' },
  { key: 'bonuses', title: 'Бонусы' },
  { key: 'care', title: 'Уход' },
]);

export function isCabinetPath(pathname) {
  return /^\/book\/me\/?$/.test(pathname);
}

const TOKEN_RE = /^[A-Za-z0-9_-]{32,64}$/;

/**
 * The sign-in token of the link (if any) and the same URL without it, so it leaves the address bar and the history.
 * The bot puts it in the fragment (never sent to the server); a `?t=` in the query is taken too.
 * @param {string} href
 * @returns {{ token: string | null, cleanUrl: string | null }} `cleanUrl` — null when there was no `t` to remove.
 */
export function takeToken(href) {
  const url = new URL(href);
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ''));
  if (!fragment.has(TOKEN_PARAM) && !url.searchParams.has(TOKEN_PARAM)) return { token: null, cleanUrl: null };
  const raw = fragment.get(TOKEN_PARAM) ?? url.searchParams.get(TOKEN_PARAM) ?? '';
  fragment.delete(TOKEN_PARAM);
  url.searchParams.delete(TOKEN_PARAM);
  const hash = fragment.toString();
  return { token: TOKEN_RE.test(raw) ? raw : null, cleanUrl: `${url.pathname}${url.search}${hash ? `#${hash}` : ''}` };
}

/** `localStorage` may be off (private mode, Telegram on old phones): the token then lives only in memory. */
export function readToken(storage) {
  try {
    const value = storage?.getItem(TOKEN_STORAGE_KEY) ?? null;
    return value && TOKEN_RE.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function saveToken(storage, token) {
  try {
    if (token) storage?.setItem(TOKEN_STORAGE_KEY, token);
    else storage?.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Not stored: the link works for this visit only.
  }
}

export function rescheduleDaysUrl(id, { from, to }) {
  const query = new URLSearchParams({ from, to });
  return `${CABINET_API}/appointments/${encodeURIComponent(id)}/days?${query}`;
}

export function rescheduleSlotsUrl(id, { date }) {
  return `${CABINET_API}/appointments/${encodeURIComponent(id)}/slots?${new URLSearchParams({ date })}`;
}

/**
 * What the sign-in screen says. `reason`: `none` — no link yet, `expired` — the server refused the stored link (in
 * Telegram: the Mini App was open so long that its launch data went stale), `loggedOut` — the client signed out here.
 * @param {{ inTelegram: boolean, reason?: 'none' | 'expired' | 'loggedOut' }} options
 */
export function signInCopy({ inTelegram, reason = 'none' }) {
  if (inTelegram && reason === 'expired') {
    return { title: 'Откройте кабинет заново', message: 'Окно было открыто слишком долго. Закройте его и снова нажмите «👤 Мои записи и бонусы» в чате со студией.' };
  }
  if (inTelegram) {
    return {
      title: 'Нужен ваш номер',
      message: 'Чтобы открыть кабинет, поделитесь номером в чате со студией: кнопка «📱 Поделиться номером» внизу чата. '
        + 'Потом нажмите «👤 Мои записи и бонусы».',
    };
  }
  const how = 'в чате со студией в Telegram нажмите «👤 Мои записи и бонусы» или отправьте /me — бот пришлёт ссылку для входа.';
  if (reason === 'expired') return { title: 'Ссылка для входа устарела', message: `Получите новую: ${how}` };
  if (reason === 'loggedOut') return { title: 'Вы вышли из кабинета', message: `Чтобы войти снова, ${how}` };
  return { title: 'Личный кабинет', message: `Здесь ваши записи, бонусы и памятки по уходу. Чтобы войти, ${how}` };
}

/** `https://t.me/<bot>?start=me` — the bot answers with the sign-in buttons. */
export function botSignInLink(botUsername) {
  return typeof botUsername === 'string' && /^[A-Za-z0-9_]{3,64}$/.test(botUsername) ? `https://t.me/${botUsername}?start=me` : null;
}

const STATUS = {
  awaiting_payment: { label: 'Ждёт предоплату', tone: 'warning' },
  awaiting_confirmation: { label: 'Ждёт подтверждения', tone: 'warning' },
  confirmed: { label: 'Подтверждена', tone: 'success' },
  scheduled: { label: 'Вы записаны', tone: 'success' },
  completed: { label: 'Визит состоялся', tone: 'muted' },
  cancelled: { label: 'Отменена', tone: 'muted' },
  no_show: { label: 'Неявка', tone: 'muted' },
};

/**
 * { label, tone } of a `CabinetAppointment`: an unsettled online state wins over the status; an open one that has
 * ended (staff have not closed it yet) is «Визит прошёл».
 */
export function appointmentStatus(appointment, nowMs = Date.now()) {
  const open = appointment.status === 'scheduled' || appointment.status === 'confirmed';
  if (open && Date.parse(appointment.endsAt ?? '') <= nowMs) return { label: 'Визит прошёл', tone: 'muted' };
  const key = open && appointment.onlineState ? appointment.onlineState : appointment.status;
  return STATUS[key] ?? { label: 'Запись', tone: 'muted' };
}

/** «Мочка, Хеликс». */
export function appointmentTitle(appointment) {
  return (appointment.items ?? []).map((item) => item.name).filter(Boolean).join(', ') || 'Процедура';
}

/**
 * The cancellation confirmation, from what the client would lose by cancelling now.
 * @param {any} appointment `CabinetAppointment`
 * @param {number} nowMs
 * @param {{ cancellationText?: string, timeZone: string }} options
 * @returns {{ title: string, text: string, late: boolean }}
 */
export function cancelNotice(appointment, nowMs, { cancellationText = '', timeZone }) {
  const title = 'Отменить запись?';
  const what = `${formatDateTime(appointment.startsAt, timeZone)} — ${appointmentTitle(appointment)}.`;
  const deposit = Number(appointment.deposit) || 0;
  if (deposit <= 0) {
    const tail = Number(appointment.depositRequired) > 0 ? ' Предоплата не внесена — отмена ничего не стоит.' : '';
    return { title, text: `${what}${tail}`, late: false };
  }
  const until = Date.parse(appointment.freeCancellationUntil ?? '');
  if (!Number.isNaN(until) && nowMs <= until) {
    return { title, text: `${what} Сейчас отмена бесплатная: студия вернёт предоплату ${formatRub(deposit)}.`, late: false };
  }
  const was = Number.isNaN(until) ? '' : ` (была до ${formatDateTime(appointment.freeCancellationUntil, timeZone)})`;
  const rule = cancellationText.trim() ? ` ${cancellationText.trim()}` : '';
  return { title, text: `${what} Бесплатная отмена уже недоступна${was}. Предоплата ${formatRub(deposit)} — по правилам студии.${rule}`, late: true };
}

/** «Бесплатная отмена — до 20 октября, 15:00» while it is ahead, else null. */
export function freeCancellationLine(appointment, nowMs, timeZone) {
  const until = Date.parse(appointment.freeCancellationUntil ?? '');
  if (Number.isNaN(until) || nowMs > until) return null;
  return `Бесплатная отмена — до ${formatDateTime(appointment.freeCancellationUntil, timeZone).replace(/^[^,]+, /, '')}`;
}

/** «21 октября» of a calendar date. */
export function dayMonth(date) {
  return formatDayLong(date).replace(/^[^,]+, /, '');
}

/** «21 октября», with the year when it is not `todayDate`'s. */
export function shortDate(date, todayDate) {
  const text = dayMonth(date);
  return date.slice(0, 4) === String(todayDate).slice(0, 4) ? text : `${text} ${date.slice(0, 4)}`;
}

/** «20–25 октября», «30 октября – 2 ноября», «20 октября». */
export function dateRange(from, to) {
  if (!to || from === to) return dayMonth(from);
  const [fromDay, fromMonth] = dayMonth(from).split(/\s/);
  const toText = dayMonth(to);
  if (from.slice(0, 7) === to.slice(0, 7)) return `${fromDay}–${toText}`;
  return `${fromDay} ${fromMonth} – ${toText}`;
}

/** «1 200 бонусов». */
export function bonusesText(n) {
  const value = Math.round(Number(n) || 0);
  return `${formatRub(value).replace(/\s?₽$/, '')} ${plural(value, 'бонус', 'бонуса', 'бонусов')}`;
}

/**
 * The last studio-local day bonuses that burn at `atIso` are valid: they burn at the start of the next day.
 */
export function lastValidDate(atIso, timeZone) {
  return dateIn(new Date(Date.parse(atIso) - 1).toISOString(), timeZone);
}

/** «500 бонусов действуют до 2 ноября» of `loyalty.expiring`, else null. */
export function expiringText(expiring, timeZone) {
  if (!expiring || !(Number(expiring.amount) > 0)) return null;
  return `${bonusesText(expiring.amount)} действуют до ${dayMonth(lastValidDate(expiring.at, timeZone))}`;
}

/** What a bonus operation was, for people. */
export function bonusOperationLabel(op) {
  const credit = Number(op.amount) > 0;
  switch (op.type) {
    case 'earn':
      return 'Начислено за покупку';
    case 'spend':
      return 'Оплата бонусами';
    case 'gift':
      return 'Подарок';
    case 'expire':
      return 'Сгорели';
    case 'adjust':
      return credit ? 'Начислено студией' : 'Списано студией';
    case 'reverse':
      return credit ? 'Возвращены при возврате покупки' : 'Списаны при возврате покупки';
    default:
      return credit ? 'Начислено' : 'Списано';
  }
}

/** «+500» / «−300». */
export function signedAmount(amount) {
  const value = Math.round(Number(amount) || 0);
  const digits = formatRub(Math.abs(value)).replace(/\s?₽$/, '');
  return value < 0 ? `−${digits}` : `+${digits}`;
}

/** «В день процедуры», «Через 3 дня». */
export function stepDayLabel(day) {
  const n = Math.max(0, Math.round(Number(day) || 0));
  return n === 0 ? 'В день процедуры' : `Через ${n} ${plural(n, 'день', 'дня', 'дней')}`;
}

/**
 * The memo's steps with their calendar dates; `today: true` on the step of `todayDate` (else on none).
 * @param {{ date: string, steps: Array<{ day: number, text: string }> }} memo
 */
export function memoSteps(memo, todayDate) {
  return (memo.steps ?? []).map((step) => {
    const date = addDays(memo.date, Math.max(0, Math.round(Number(step.day) || 0)));
    return { ...step, date, today: date === todayDate };
  });
}

/** Title and details of a waitlist entry: «Соски — Два, Мочка» · «20–25 октября · мастер Фатима». */
export function waitlistSummary(entry) {
  const named = (entry.items ?? []).filter((item) => item.name);
  const title = named.map((item) => (item.variant ? `${item.name} — ${item.variant}` : item.name)).join(', ') || 'Запись';
  const master = entry.master?.name ? `мастер ${entry.master.name}` : 'любой мастер';
  const notice = entry.status === 'notified' ? 'Освободилось время — мы написали вам в Telegram' : null;
  return { title, details: `${dateRange(entry.dateFrom, entry.dateTo)} · ${master}`, notice };
}

/**
 * What to tell the client about a failed cabinet request, and what to offer: `signIn` (sign in again), `retry`,
 * `reload` (the data changed meanwhile), `pickTime` (the time was taken), `none`.
 * @returns {{ title: string, message: string, action: 'signIn' | 'retry' | 'reload' | 'pickTime' | 'none' }}
 */
export function describeCabinetError(error) {
  const e = error instanceof ApiError ? error : null;
  if (!e || e.network) {
    return { title: 'Нет связи', message: 'Не получилось связаться со студией. Проверьте интернет и попробуйте ещё раз.', action: 'retry' };
  }
  const serverMessage = e.message.trim();
  if (e.status === 401) return { title: 'Нужно войти снова', message: serverMessage || 'Войдите через Telegram-бота студии.', action: 'signIn' };
  if (e.code === 'schedule_conflict') {
    return { title: 'Это время уже заняли', message: 'Выберите другое время — список обновлён.', action: 'pickTime' };
  }
  switch (e.status) {
    case 400:
      return { title: 'Не получилось', message: serverMessage || 'Проверьте выбранное время.', action: 'pickTime' };
    case 403:
      return {
        title: 'Онлайн-запись временно недоступна',
        message: 'Перенести или отменить запись сейчас можно только через студию — позвоните или напишите нам.',
        action: 'none',
      };
    case 404:
      return { title: 'Запись не найдена', message: 'Похоже, она изменилась. Обновите кабинет.', action: 'reload' };
    case 409:
      return { title: 'Не получилось', message: serverMessage || 'Запись изменилась — обновите кабинет.', action: 'reload' };
    case 429:
      return { title: 'Слишком много попыток', message: 'Подождите минуту и попробуйте снова.', action: 'retry' };
    default:
      return { title: 'Что-то пошло не так', message: 'Это ошибка на нашей стороне. Попробуйте ещё раз через минуту.', action: 'retry' };
  }
}
