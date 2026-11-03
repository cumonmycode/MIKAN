// @ts-check
/**
 * The public booking API client. `fetch` is injectable so tests (and local development) can run against a fake.
 * Errors come out as `ApiError`; `describeError` turns them into plain Russian for the page.
 */
import { API_BASE, bookingUrl, daysUrl, slotsUrl } from './query.js';
import { masterPortfolioUrl, servicePortfolioUrl } from './portfolio.js';

const TIMEOUT_MS = 15_000;
/** Booking waits longer: giving up early on a slow answer invites a retry of a booking that was made. */
const BOOK_TIMEOUT_MS = 40_000;
export const INIT_DATA_HEADER = 'X-Telegram-Init-Data';

export class ApiError extends Error {
  /**
   * @param {{ status: number, code: string, message: string, network?: boolean }} details
   *   `status` 0 with `network: true` — the request never got an answer.
   */
  constructor({ status, code, message, network = false }) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.network = network;
  }
}

/**
 * @param {{ fetch?: typeof fetch, initData?: string | null, timeoutMs?: number, bookTimeoutMs?: number,
 *   now?: () => number }} [options]
 *   `initData` — the Telegram Mini App init data, sent on `/me` and on booking.
 */
export function createApi(options = {}) {
  const fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const bookTimeoutMs = options.bookTimeoutMs ?? BOOK_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());
  let initData = options.initData || null;
  /** Server clock − device clock, from the latest `Date` header (for the payment countdown). */
  let clockOffsetMs = 0;

  /**
   * @param {string} url
   * @param {{ method?: string, body?: unknown, telegram?: boolean, timeout?: number, idempotencyKey?: string,
   *   headers?: Record<string, string> }} [options]
   */
  async function request(url, { method = 'GET', body, telegram = false, timeout = timeoutMs, idempotencyKey, headers: extra } = {}) {
    /** @type {Record<string, string>} */
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (telegram && initData) headers[INIT_DATA_HEADER] = initData;
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    if (extra) Object.assign(headers, extra);
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeout) : null;
    const networkError = () => new ApiError({ status: 0, code: 'network', message: 'Нет связи', network: true });
    let response;
    let payload = null;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller?.signal,
        credentials: 'same-origin',
        cache: 'no-store',
      });
      try {
        payload = await response.json();
      } catch {
        // A body that stalled until the timeout is a lost connection; anything else is just not JSON.
        if (controller?.signal.aborted) throw networkError();
        payload = null;
      }
    } catch (error) {
      throw error instanceof ApiError ? error : networkError();
    } finally {
      if (timer) clearTimeout(timer);
    }
    const serverDate = Date.parse(response.headers?.get?.('date') ?? '');
    if (!Number.isNaN(serverDate)) clockOffsetMs = serverDate - now();
    if (!response.ok) {
      const error = payload && typeof payload === 'object' ? payload.error : null;
      throw new ApiError({
        status: response.status,
        code: typeof error?.code === 'string' ? error.code : 'http_error',
        message: typeof error?.message === 'string' ? error.message : '',
      });
    }
    if (response.status === 204) return null;
    if (payload === null) throw new ApiError({ status: response.status, code: 'bad_response', message: '' });
    return payload;
  }

  return {
    config: () => request(`${API_BASE}/config`),
    services: () => request(`${API_BASE}/services`),
    masters: () => request(`${API_BASE}/masters`),
    /** A master's works (docs/API.md «Portfolio»). */
    masterPortfolio: (masterId) => request(masterPortfolioUrl(masterId)),
    /** Works of a service by every working master, newest first. */
    servicePortfolio: (serviceId) => request(servicePortfolioUrl(serviceId)),
    /** @param {{ from: string, to: string, items: Array<{ serviceId: number, variant: string | null }>, master: number | 'any' | null }} q */
    days: (q) => request(daysUrl(q)),
    /** @param {{ date: string, items: Array<{ serviceId: number, variant: string | null }>, master: number | 'any' | null }} q */
    slots: (q) => request(slotsUrl(q)),
    me: () => request(`${API_BASE}/me`, { telegram: true }),
    /** `idempotencyKey` — the same for a retry of the same booking, so a lost answer never books twice. */
    book: (body, idempotencyKey) =>
      request(API_BASE, { method: 'POST', body, telegram: true, timeout: bookTimeoutMs, idempotencyKey }),
    booking: (token) => request(bookingUrl(token)),
    cancel: (token) => request(`${bookingUrl(token)}/cancel`, { method: 'POST', body: {} }),
    /** «Встать в лист ожидания»: `WaitlistEntryPublic` + `telegramLink`. */
    joinWaitlist: (body) => request(`${API_BASE}/waitlist`, { method: 'POST', body, telegram: true }),
    /** Stops sending the init data (Telegram said it is invalid): the page then books like the website. */
    dropInitData: () => {
      initData = null;
    },
    hasInitData: () => initData !== null,
    /** Any other public call (the client cabinet, lib/cabinet-api.js) with the same errors and timeouts. */
    request,
    clockOffset: () => clockOffsetMs,
  };
}

/**
 * What to tell the client about a failed request, and what the page offers next:
 * `retry` — the same request again, `pickTime` — back to the free times, `back` — to the previous step,
 * `home` — start a new booking, `none` — nothing to do here.
 * @param {unknown} error
 * @param {{ booking?: boolean }} [context] `booking` — the failed request was the booking itself.
 * @returns {{ title: string, message: string, action: 'retry' | 'pickTime' | 'back' | 'home' | 'none' }}
 */
export function describeError(error, { booking = false } = {}) {
  const e = error instanceof ApiError ? error : null;
  if ((!e || e.network) && booking) {
    // The booking may have been made before the connection dropped: say so instead of promising a clean retry.
    return {
      title: 'Нет ответа от студии',
      message: 'Связь прервалась, и мы не знаем, успела ли создаться запись. Попробуйте ещё раз — если увидите, '
        + 'что время уже занято, позвоните нам, мы проверим.',
      action: 'retry',
    };
  }
  if (!e || e.network) {
    return {
      title: 'Нет связи',
      message: 'Не получилось связаться со студией. Проверьте интернет и попробуйте ещё раз.',
      action: 'retry',
    };
  }
  const serverMessage = e.message.trim();
  if (e.code === 'schedule_conflict') {
    return {
      title: 'Это время уже заняли',
      message: serverMessage || 'Это время только что заняли — выберите другое.',
      action: 'pickTime',
    };
  }
  switch (e.status) {
    case 400:
      return { title: 'Проверьте данные', message: serverMessage || 'Что-то заполнено не так.', action: 'back' };
    case 401:
      return {
        title: 'Не получилось войти через Telegram',
        message: 'Закройте окно записи и откройте его снова из чата со студией.',
        action: 'retry',
      };
    case 403:
      return {
        title: 'Онлайн-запись временно недоступна',
        message: 'Позвоните или напишите нам — запишем вас сами.',
        action: 'none',
      };
    case 404:
      return {
        title: 'Запись не найдена',
        message: 'Проверьте ссылку — возможно, она скопировалась не полностью.',
        action: 'home',
      };
    case 409:
      return { title: 'Не получилось записаться', message: serverMessage || 'Обновите страницу и попробуйте снова.', action: 'back' };
    case 429:
      return {
        title: 'Слишком много попыток',
        message: 'Подождите несколько минут и попробуйте снова.',
        action: 'retry',
      };
    default:
      return {
        title: 'Что-то пошло не так',
        message: 'Это ошибка на нашей стороне. Попробуйте ещё раз через минуту.',
        action: 'retry',
      };
  }
}
