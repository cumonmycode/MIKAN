// @ts-check
/**
 * The client cabinet API (`/api/public/cabinet`) on top of the booking page's client (lib/api.js): the Mini App sends
 * its init data, the website the sign-in token as `X-Client-Token`.
 */
import { CABINET_API, rescheduleDaysUrl, rescheduleSlotsUrl } from './cabinet.js';

export const CLIENT_TOKEN_HEADER = 'X-Client-Token';

/**
 * @param {{ api: any, token?: string | null }} options `api` — `createApi(...)`; `token` — the website sign-in token.
 */
export function createCabinetApi({ api, token = null }) {
  let current = token;

  /** @param {string} url @param {{ method?: string, body?: unknown }} [options] */
  function send(url, options = {}) {
    // Inside Telegram the chat says who it is; the token is the website's.
    const headers = !api.hasInitData() && current ? { [CLIENT_TOKEN_HEADER]: current } : undefined;
    return api.request(url, { ...options, telegram: true, headers });
  }

  const appointment = (id) => `${CABINET_API}/appointments/${encodeURIComponent(id)}`;

  return {
    /** Whether the page can say who the client is (Telegram, or a token). */
    canSignIn: () => api.hasInitData() || current !== null,
    hasToken: () => current !== null,
    forgetToken: () => {
      current = null;
    },
    cabinet: () => send(CABINET_API),
    bonuses: () => send(`${CABINET_API}/bonuses`),
    /** @param {number} id @param {{ from: string, to: string }} q */
    days: (id, q) => send(rescheduleDaysUrl(id, q)),
    /** @param {number} id @param {{ date: string }} q */
    slots: (id, q) => send(rescheduleSlotsUrl(id, q)),
    reschedule: (id, startsAt) => send(`${appointment(id)}/reschedule`, { method: 'POST', body: { startsAt } }),
    cancel: (id) => send(`${appointment(id)}/cancel`, { method: 'POST', body: {} }),
    leaveWaitlist: (id) => send(`${CABINET_API}/waitlist/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    /** @param {string} birthday `YYYY-MM-DD` (1900 without the year) */
    saveBirthday: (birthday) => send(`${CABINET_API}/birthday`, { method: 'POST', body: { birthday } }),
    logout: () => send(`${CABINET_API}/logout`, { method: 'POST', body: {} }),
  };
}
