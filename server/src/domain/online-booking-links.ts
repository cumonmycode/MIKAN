import type { Config } from '../config.js';

/** Public links of online booking: the booking page, its Mini App form, a booking's page, `.ics` and bot deep link. */

/** Start parameter of `https://t.me/<bot>?start=b_<token>`. */
export const BOOKING_START_PREFIX = 'b_';
/** Text of the bot's menu button and of the inline button that open the Mini App. */
export const BOOKING_MENU_TEXT = '📅 Записаться';
export const BOOKING_WEB_APP_BUTTON = '📅 Записаться онлайн';

const base = (config: Pick<Config, 'publicUrl'>): string | null => config.publicUrl?.trim().replace(/\/+$/, '') || null;

/** `PUBLIC_URL/book` — the booking page (for Instagram, Yandex Maps, 2GIS); null without `PUBLIC_URL`. */
export function bookingPageUrl(config: Pick<Config, 'publicUrl'>): string | null {
  const root = base(config);
  return root ? `${root}/book` : null;
}

/** The booking page as a Telegram Mini App: Telegram opens only `https://` web apps. */
export function bookingWebAppUrl(config: Pick<Config, 'publicUrl'>): string | null {
  const url = bookingPageUrl(config);
  return url?.startsWith('https://') ? url : null;
}

/** The client's page of one booking, `PUBLIC_URL/book/b/<token>`. */
export function bookingStatusUrl(config: Pick<Config, 'publicUrl'>, token: string): string | null {
  const page = bookingPageUrl(config);
  return page ? `${page}/b/${token}` : null;
}

/** «Добавить в календарь»: absolute with `PUBLIC_URL`, else the path from the site root. */
export function calendarUrl(config: Pick<Config, 'publicUrl'>, token: string): string {
  return `${base(config) ?? ''}/api/public/booking/b/${token}/calendar.ics`;
}

/** «Получать уведомления в Telegram»: links the chat to the booking's client (see bot/onboarding.ts). */
export function telegramBookingLink(botUsername: string | null, token: string): string | null {
  return botUsername ? `https://t.me/${botUsername}?start=${BOOKING_START_PREFIX}${token}` : null;
}
