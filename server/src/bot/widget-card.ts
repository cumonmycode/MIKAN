import type { DbOrTx } from '../db/client.js';
import { appointmentLedger, heldAmount } from '../domain/deposit-ledger.js';
import { pendingDepositCodes } from '../domain/deposits.js';
import { employeesByIds } from '../domain/refs.js';
import { ACTIVE_APPOINTMENT_STATUSES } from '../domain/scheduling.js';
import { getStudioSettings } from '../domain/settings.js';
import type { AppointmentRow } from '../lib/serialize.js';
import { formatRub, truncate } from '../lib/text.js';
import { DAY_MS, formatHumanDateTime, formatTime } from '../lib/time.js';
import { encodeCallback } from './callback-data.js';
import { appointmentWhat } from './client-appointments.js';

/**
 * The appointment card: a Telegram widget (Bot API 10.4, https://core.telegram.org/bots/widgets) that shows one
 * appointment as it is now — its status, time, master, prepayment — with the buttons that make sense at that moment.
 * Its HTML never changes after sending; everything it shows lives in the message's `chat_data` (≤ 1024 bytes), which
 * the bot rewrites whenever the appointment changes (bot/widget-cards.ts), so the card redraws in place.
 *
 * A press sends a reminder button's payload (`encodeCallback`) to the bot, handled by `handleCallback`; a button whose
 * payload is an `https://` link opens it instead (the prepayment's SBP link, the route to the studio).
 */

/** Telegram limits (https://core.telegram.org/bots/widgets): the HTML, the per-message state, a link to open. */
export const WIDGET_MAX_HTML_BYTES = 32_768;
export const WIDGET_MAX_COMPRESSED_HTML_BYTES = 4_096;
export const WIDGET_MAX_DATA_BYTES = 1_024;
export const WIDGET_MAX_LINK_LENGTH = 256;

/** `booking`: sent with the booking or prepayment request; `reminder`: a reminder, also asks «✅ Приду». */
export type CardKind = 'booking' | 'reminder';

/** The color of the status line: p — waits, c — fine, m — being moved, x — over. */
export type CardTone = 'p' | 'c' | 'm' | 'x';

/** What the card shows; short keys keep it far below the 1024-byte state limit. */
export interface CardData {
  /** Title, e.g. «⏰ Сегодня ждём вас в MIKAN STUDIO». */
  t: string;
  /** Status line, e.g. «✅ Запись подтверждена». */
  st: string;
  s: CardTone;
  /** Label / value rows. */
  r: Array<[string, string]>;
  /** A line under the rows, or omitted. */
  n?: string;
  /** Buttons: text and the payload sent to the bot, or an `https://` link to open. */
  b: Array<[string, string]>;
}

export interface CardOptions {
  kind: CardKind;
  title: string;
  /** `m` right after «Перенести», until the appointment changes. */
  pressed: 'm' | null;
  now?: number;
}

export const CARD_BUTTONS = { confirm: '✅ Приду', move: '🔁 Перенести', route: '📍 Маршрут' } as const;

/** A visit this long past stops being redrawn. */
export const CARD_KEEP_AFTER_START_MS = DAY_MS;

const TITLE_MAX = 60;
const VALUE_MAX = 90;
const VALUE_MIN = 10;
const VALUE_STEP = 20;

const byteLength = (value: string): number => Buffer.byteLength(value, 'utf8');
const isActive = (a: AppointmentRow): boolean => (ACTIVE_APPOINTMENT_STATUSES as readonly string[]).includes(a.status);
const usableLink = (url: string): boolean => url.startsWith('https://') && url.length <= WIDGET_MAX_LINK_LENGTH;

/** The card no longer changes: the visit is over (or cancelled), or long past. */
export function cardIsFinal(a: AppointmentRow, now = Date.now()): boolean {
  return !isActive(a) || a.startsAt + CARD_KEEP_AFTER_START_MS <= now;
}

function statusLine(db: DbOrTx, a: AppointmentRow, opts: CardOptions, now: number): { st: string; s: CardTone } {
  if (a.status === 'cancelled') return { st: '❌ Запись отменена', s: 'x' };
  if (a.status === 'no_show') return { st: 'Визит пропущен', s: 'x' };
  if (a.status === 'completed') return { st: '🌸 Визит состоялся — спасибо, что были у нас!', s: 'c' };
  if (!isActive(a)) return { st: 'Запись неактуальна', s: 'x' };
  if (a.startsAt <= now) return { st: '🕐 Время визита наступило', s: 'c' };
  if (opts.pressed === 'm') return { st: '🔁 Подберём другое время — ответьте в чате', s: 'm' };
  if (a.onlineState === 'awaiting_payment') {
    const until = a.holdUntil ? ` до ${formatTime(a.holdUntil, getStudioSettings(db).timezone)}` : '';
    return { st: `💳 Время за вами${until} — ждём предоплату`, s: 'p' };
  }
  if (a.status === 'confirmed') return { st: '✅ Запись подтверждена', s: 'c' };
  return opts.kind === 'reminder' ? { st: '⏳ Подтвердите, пожалуйста, визит', s: 'p' } : { st: '⏳ Ждёт подтверждения студии', s: 'p' };
}

/** «1 000 ₽ · получена ✅» for an appointment that asks for a prepayment, else null. */
function depositLine(db: DbOrTx, a: AppointmentRow): { text: string; owed: number } | null {
  const held = heldAmount(appointmentLedger(db, a.id));
  if (a.depositRequired <= 0 && held <= 0) return null;
  const owed = Math.max(0, a.depositRequired - held);
  const state = owed === 0 ? 'получена ✅' : held > 0 ? `внесено ${formatRub(held)}` : 'ожидается';
  return { text: `${formatRub(Math.max(a.depositRequired, held))} · ${state}`, owed };
}

function buttons(db: DbOrTx, a: AppointmentRow, opts: CardOptions, owed: number, now: number): Array<[string, string]> {
  if (!isActive(a) || a.startsAt <= now) return [];
  const list: Array<[string, string]> = [];
  const code = owed > 0 ? pendingDepositCodes(db, a.id).find((c) => c.expiresAt > now && usableLink(c.payload)) : undefined;
  if (code) list.push([`💳 Оплатить ${formatRub(code.amount)}`, code.payload]);
  if (opts.pressed !== 'm' && a.onlineState !== 'awaiting_payment') {
    if (opts.kind === 'reminder' && a.status === 'scheduled') {
      list.push([CARD_BUTTONS.confirm, encodeCallback({ kind: 'reminderConfirm', appointmentId: a.id })]);
    }
    list.push([CARD_BUTTONS.move, encodeCallback({ kind: 'reminderMove', appointmentId: a.id })]);
  }
  const route = routeLink(getStudioSettings(db).address);
  if (route && a.status === 'confirmed') list.push([CARD_BUTTONS.route, route]);
  return list;
}

/** Yandex Maps search for the studio's address, when it fits a widget link. */
export function routeLink(address: string): string | null {
  const trimmed = address.trim();
  if (!trimmed) return null;
  const url = `https://yandex.ru/maps/?text=${encodeURIComponent(trimmed)}`;
  return usableLink(url) ? url : null;
}

/**
 * The card of `appointment` now; the JSON always fits the widget state: values are shortened, then the link buttons
 * dropped, if needed.
 */
export function appointmentCardData(db: DbOrTx, appointment: AppointmentRow, opts: CardOptions): string {
  const now = opts.now ?? Date.now();
  const tz = getStudioSettings(db).timezone;
  const master = employeesByIds(db, [appointment.masterId]).get(appointment.masterId)?.name ?? '—';
  const what = appointmentWhat(db, [appointment]).get(appointment.id) ?? 'процедура';
  const deposit = depositLine(db, appointment);
  const status = statusLine(db, appointment, opts, now);
  const allButtons = buttons(db, appointment, opts, deposit?.owed ?? 0, now);
  const card = (max: number, links: boolean): CardData => ({
    t: truncate(opts.title.trim(), TITLE_MAX),
    st: status.st,
    s: status.s,
    r: [
      ['Когда', truncate(`${formatHumanDateTime(appointment.startsAt, tz)}–${formatTime(appointment.endsAt, tz)}`, max)],
      ['Что', truncate(what, max)],
      ['Мастер', truncate(master, max)],
      ...(deposit ? ([['Предоплата', deposit.text]] as Array<[string, string]>) : []),
    ],
    b: links ? allButtons : allButtons.filter(([, payload]) => !payload.startsWith('https://')),
  });
  for (const links of [true, false]) {
    for (let max = VALUE_MAX; max > VALUE_MIN; max -= VALUE_STEP) {
      const json = JSON.stringify(card(max, links));
      if (byteLength(json) <= WIDGET_MAX_DATA_BYTES) return json;
    }
  }
  return JSON.stringify(card(VALUE_MIN, false));
}

/** A message's first line without Markdown, for the card title. */
export const cardTitle = (text: string): string => text.split('\n', 1)[0]?.replace(/\*\*/g, '') ?? '';

/**
 * The one card template. Colors come from the chat theme variables, so it fits light, dark and outgoing bubbles. The
 * script draws from `chatData` with `textContent` only (no HTML from data), and redraws when the bot changes it. An
 * answer starting with «!» is an error line shown under the buttons.
 */
export const APPOINTMENT_CARD_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font:15px/1.35 -apple-system,system-ui,sans-serif;color:var(--tg-theme-text-color)}
.c{padding:12px 14px}
.t{font-weight:600;font-size:16px;margin-bottom:6px}
.st{font-weight:600;margin-bottom:8px}
.st.p{color:var(--tg-theme-link-color)}
.st.c{color:var(--tg-theme-accent-text-color,var(--tg-theme-link-color))}
.st.m{color:var(--tg-theme-text-color)}
.st.x{color:var(--tg-theme-hint-color)}
.r{display:flex;gap:8px;margin:3px 0}
.l{color:var(--tg-theme-hint-color);min-width:84px}
.b{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
button{flex:1 1 40%;padding:9px 6px;border:0;border-radius:10px;font:inherit;font-weight:600;
background:var(--tg-theme-secondary-bg-color);color:var(--tg-theme-text-color)}
button.a{background:var(--tg-theme-button-color);color:var(--tg-theme-button-text-color)}
button[disabled]{opacity:.5}
.e{margin-top:8px;font-size:13px;color:var(--tg-theme-destructive-text-color,#d33)}
</style></head><body><div class="c" id="root"></div><script>
var W=window.TelegramWidget,root=document.getElementById('root'),busy=false,err='';
function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e}
function parse(){try{return JSON.parse(W.chatData||'null')}catch(e){return null}}
function draw(){
var d=parse();root.textContent='';
if(!d){root.appendChild(el('div','st x','Карточка записи'));return}
root.appendChild(el('div','t',d.t));
if(d.st)root.appendChild(el('div','st '+d.s,d.st));
(d.r||[]).forEach(function(r){var row=el('div','r');row.appendChild(el('span','l',r[0]));row.appendChild(el('span','',r[1]));root.appendChild(row)});
if(d.n)root.appendChild(el('div','st x',d.n));
var bs=d.b||[];
if(bs.length){var box=el('div','b');bs.forEach(function(b,i){
var btn=el('button',i===0?'a':'',b[0]);if(busy)btn.disabled=true;
btn.addEventListener('click',function(){press(b[1])});box.appendChild(btn)});root.appendChild(box)}
if(err)root.appendChild(el('div','e',err));
}
function press(data){
if(busy)return;
if(W.HapticFeedback)W.HapticFeedback.impactOccurred('light');
if(data.indexOf('https://')===0){W.openLink(data);return}
busy=true;err='';draw();
W.request(data).then(function(a){busy=false;err=a&&a.result&&a.result.charAt(0)==='!'?a.result.slice(1):'';draw()},
function(e){busy=false;err=e&&e.code==='RATE_LIMITED'?'Слишком часто — подождите пару секунд':'Не получилось — попробуйте ещё раз';
if(W.HapticFeedback)W.HapticFeedback.notificationOccurred('error');draw()});
}
W.onEvent('chatDataChanged',draw);draw();W.ready();
</script></body></html>`;
