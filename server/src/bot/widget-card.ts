import type { DbOrTx } from '../db/client.js';
import { employeesByIds } from '../domain/refs.js';
import { studioTimezone } from '../domain/settings.js';
import type { AppointmentRow } from '../lib/serialize.js';
import { truncate } from '../lib/text.js';
import { formatHumanDateTime, formatTime } from '../lib/time.js';
import { encodeCallback } from './callback-data.js';
import { appointmentWhat } from './client-appointments.js';

/**
 * The live appointment card: a Telegram widget (Bot API 10.4, https://core.telegram.org/bots/widgets) sent instead of
 * a plain reminder. Its HTML never changes after sending; everything it shows lives in the message's `chat_data`
 * (≤ 1024 bytes), which the bot rewrites when the client presses a button, so the card redraws in place.
 *
 * A press calls `TelegramWidget.request(<callback data>)`: the same payloads as the reminder's inline buttons
 * (`encodeCallback`), so the bot handles both through `handleCallback`.
 */

/** Telegram limits (https://core.telegram.org/bots/widgets): the HTML and the per-message state. */
export const WIDGET_MAX_HTML_BYTES = 32_768;
export const WIDGET_MAX_COMPRESSED_HTML_BYTES = 4_096;
export const WIDGET_MAX_DATA_BYTES = 1_024;

/** p — waits for the client's answer; c — confirmed; m — the client asked to move it; x — no longer actual. */
export type CardState = 'p' | 'c' | 'm' | 'x';

/** What the card shows; short keys keep it far below the 1024-byte state limit. */
export interface CardData {
  /** Title, e.g. «⏰ Сегодня ждём вас в MIKAN STUDIO». */
  t: string;
  /** Label / value rows. */
  r: Array<[string, string]>;
  s: CardState;
  /** The line under the rows (the outcome of a press), or omitted. */
  n?: string;
  /** Buttons: text and the payload sent to the bot. */
  b: Array<[string, string]>;
}

const TITLE_MAX = 60;
const VALUE_MAX = 90;
const VALUE_MIN = 10;
const VALUE_STEP = 20;

const NOTES: Record<CardState, string | undefined> = {
  p: undefined,
  c: 'Визит подтверждён ✅ Ждём вас!',
  m: 'Подберём другое время — ответьте в чате 🙌',
  x: 'Эта запись уже неактуальна',
};

export const CARD_BUTTONS = { confirm: '✅ Приду', move: '🔁 Перенести' } as const;

const byteLength = (value: string): number => Buffer.byteLength(value, 'utf8');

/** The card of `appointment` in `state`; the JSON always fits the widget state (values are shortened if needed). */
export function reminderCardData(db: DbOrTx, appointment: AppointmentRow, title: string, state: CardState): string {
  const tz = studioTimezone(db);
  const master = employeesByIds(db, [appointment.masterId]).get(appointment.masterId)?.name ?? '—';
  const what = appointmentWhat(db, [appointment]).get(appointment.id) ?? 'процедура';
  const buttons: Array<[string, string]> = [];
  if (state === 'p') buttons.push([CARD_BUTTONS.confirm, encodeCallback({ kind: 'reminderConfirm', appointmentId: appointment.id })]);
  if (state === 'p' || state === 'c') buttons.push([CARD_BUTTONS.move, encodeCallback({ kind: 'reminderMove', appointmentId: appointment.id })]);
  const note = NOTES[state];
  const card = (max: number): CardData => ({
    t: truncate(title.trim(), TITLE_MAX),
    r: [
      ['Когда', truncate(`${formatHumanDateTime(appointment.startsAt, tz)}–${formatTime(appointment.endsAt, tz)}`, max)],
      ['Что', truncate(what, max)],
      ['Мастер', truncate(master, max)],
    ],
    s: state,
    ...(note ? { n: note } : {}),
    b: buttons,
  });
  for (let max = VALUE_MAX; max > VALUE_MIN; max -= VALUE_STEP) {
    const json = JSON.stringify(card(max));
    if (byteLength(json) <= WIDGET_MAX_DATA_BYTES) return json;
  }
  return JSON.stringify(card(VALUE_MIN));
}

/** The reminder's first line, for the card title. */
export const cardTitle = (reminderText: string): string => reminderText.split('\n', 1)[0] ?? '';

/**
 * The one card template. Colors come from the chat theme variables, so it fits light, dark and outgoing bubbles. The
 * script draws from `chatData` with `textContent` only (no HTML from data), and redraws when the bot changes it. An
 * answer starting with «!» is an error line shown under the buttons.
 */
export const REMINDER_CARD_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font:15px/1.35 -apple-system,system-ui,sans-serif;color:var(--tg-theme-text-color)}
.c{padding:12px 14px}
.t{font-weight:600;font-size:16px;margin-bottom:8px}
.r{display:flex;gap:8px;margin:3px 0}
.l{color:var(--tg-theme-hint-color);min-width:58px}
.n{margin-top:10px;font-weight:500}
.n.c{color:var(--tg-theme-accent-text-color,var(--tg-theme-link-color))}
.n.x{color:var(--tg-theme-hint-color)}
.b{display:flex;gap:8px;margin-top:12px}
button{flex:1;padding:9px 6px;border:0;border-radius:10px;font:inherit;font-weight:600;
background:var(--tg-theme-button-color);color:var(--tg-theme-button-text-color)}
button.s{background:var(--tg-theme-secondary-bg-color);color:var(--tg-theme-text-color)}
button[disabled]{opacity:.5}
.e{margin-top:8px;font-size:13px;color:var(--tg-theme-destructive-text-color,#d33)}
</style></head><body><div class="c" id="root"></div><script>
var W=window.TelegramWidget,root=document.getElementById('root'),busy=false,err='';
function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e}
function parse(){try{return JSON.parse(W.chatData||'null')}catch(e){return null}}
function draw(){
var d=parse();root.textContent='';
if(!d){root.appendChild(el('div','n x','Карточка записи'));return}
root.appendChild(el('div','t',d.t));
(d.r||[]).forEach(function(r){var row=el('div','r');row.appendChild(el('span','l',r[0]));row.appendChild(el('span','',r[1]));root.appendChild(row)});
if(d.n)root.appendChild(el('div','n '+d.s,d.n));
var bs=d.b||[];
if(bs.length){var box=el('div','b');bs.forEach(function(b,i){
var btn=el('button',i===bs.length-1&&bs.length>1?'s':'',b[0]);if(busy)btn.disabled=true;
btn.addEventListener('click',function(){press(b[1])});box.appendChild(btn)});root.appendChild(box)}
if(err)root.appendChild(el('div','e',err));
}
function press(data){
if(busy)return;busy=true;err='';draw();
if(W.HapticFeedback)W.HapticFeedback.impactOccurred('light');
W.request(data).then(function(a){busy=false;err=a&&a.result&&a.result.charAt(0)==='!'?a.result.slice(1):'';draw()},
function(e){busy=false;err=e&&e.code==='RATE_LIMITED'?'Слишком часто — подождите пару секунд':'Не получилось — попробуйте ещё раз';
if(W.HapticFeedback)W.HapticFeedback.notificationOccurred('error');draw()});
}
W.onEvent('chatDataChanged',draw);draw();W.ready();
</script></body></html>`;
