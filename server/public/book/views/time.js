// @ts-check
/** Step 3: a strip of days (`/days`) and the free starts of the chosen day (`/slots`). */
import { describeError } from '../lib/api.js';
import { h, mount } from '../lib/dom.js';
import {
  addDays, dayChip, daysBetween, deviceTimeZone, formatDayLong, formatDuration, formatTime, groupSlotsByPartOfDay,
  monthTitle, timezoneHint, todayIn,
} from '../lib/format.js';
import { presetRange } from '../lib/waitlist.js';
import { errorPanel, loadingBlock, stepHeading } from './common.js';

/** The API returns at most 31 dates per request. */
const DAYS_PER_REQUEST = 31;
/** Chunks loaded automatically while no day is free yet. */
const AUTO_CHUNKS = 3;

const capitalized = (text) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * @param {{ state: any, api: any, timeZone: string, horizonDays: number, durationMin: number,
 *   dispatch: (action: any) => void, haptic: () => void, onWaitlist?: (range: { from: string, to: string }) => void }} ctx
 *   `onWaitlist` — «Встать в лист ожидания» on a busy day or a busy strip.
 */
export function renderTime(ctx) {
  const today = todayIn(ctx.timeZone);
  const lastDate = addDays(today, Math.max(1, ctx.horizonDays));
  /** @type {Array<{ date: string, available: boolean }>} */
  let days = [];
  let loadedTo = null;
  let daysRequest = 0;
  let slotsRequest = 0;
  let state = ctx.state;

  const month = h('p', { class: 'month', 'aria-hidden': 'true' });
  const strip = h('div', { class: 'day-strip', role: 'radiogroup', 'aria-label': 'День' });
  const moreButton = /** @type {HTMLButtonElement} */ (h('button', { type: 'button', class: 'day-more', hidden: true, onClick: () => loadMore() }, 'Ещё дни'));
  const stripWrap = h('div', { class: 'day-strip-wrap' }, strip, moreButton);
  const daysStatus = h('div', { class: 'days-status' });
  const slotsBox = h('div', { class: 'slots', 'aria-live': 'polite' });
  /** «Это время уже заняли» when the chosen time (e.g. from the waitlist's link) is gone. */
  const takenNotice = h('p', { class: 'panel panel-accent panel-text', role: 'status', hidden: true }, 'Это время уже заняли — выберите другое.');

  const subtitle = [`Длительность: ${formatDuration(ctx.durationMin)}`, timezoneHint(ctx.timeZone, deviceTimeZone())]
    .filter(Boolean).join(' · ');
  const node = h('section', { class: 'step' }, stepHeading('Выберите время', subtitle), month, stripWrap, daysStatus, takenNotice, slotsBox);

  /** «Встать в лист ожидания», when the page offers it. */
  function waitlistButton(date = null) {
    if (!ctx.onWaitlist) return null;
    const range = presetRange({ today, lastDate, date });
    return h('div', { class: 'panel-actions' },
      h('button', { type: 'button', class: 'btn', onClick: () => ctx.onWaitlist?.(range) }, 'Встать в лист ожидания'));
  }

  function renderDays() {
    const selected = state.date;
    mount(strip, days.map((day) => {
      const chip = dayChip(day.date);
      const radio = /** @type {HTMLInputElement} */ (h('input', {
        type: 'radio', name: 'day', value: day.date, class: 'sr-only',
        // A busy day can be chosen too: it offers the waitlist.
        checked: day.date === selected,
        'aria-label': `${formatDayLong(day.date)}${day.available ? '' : ', нет свободного времени'}`,
        onChange: () => selectDay(day.date),
      }));
      return h('label', { class: `day${day.available ? '' : ' day-off'}${chip.weekend ? ' day-weekend' : ''}${day.date === selected ? ' selected' : ''}` },
        radio,
        h('span', { class: 'day-weekday', 'aria-hidden': 'true' }, day.date === today ? 'сегодня' : chip.weekday),
        h('span', { class: 'day-num', 'aria-hidden': 'true' }, String(chip.day)),
        h('span', { class: 'day-month', 'aria-hidden': 'true' }, chip.month));
    }));
    moreButton.hidden = !loadedTo || loadedTo >= lastDate;
    markSelectedDay();
  }

  /** Moves the selection without rebuilding the strip, so keyboard focus stays on the day. */
  function markSelectedDay() {
    strip.querySelectorAll('input[name="day"]').forEach((input) => {
      const radio = /** @type {HTMLInputElement} */ (input);
      radio.checked = radio.value === state.date;
      radio.closest('label')?.classList.toggle('selected', radio.checked);
    });
    month.textContent = state.date ? monthTitle(state.date) : days[0] ? monthTitle(days[0].date) : '';
  }

  function scrollSelectedIntoView() {
    const label = strip.querySelector('.day.selected');
    if (label && typeof label.scrollIntoView === 'function') label.scrollIntoView({ block: 'nearest', inline: 'center' });
  }

  async function fetchChunk() {
    const from = loadedTo ? addDays(loadedTo, 1) : today;
    if (from > lastDate) return false;
    const to = daysBetween(from, lastDate) >= DAYS_PER_REQUEST ? addDays(from, DAYS_PER_REQUEST - 1) : lastDate;
    const request = ++daysRequest;
    const response = await ctx.api.days({ from, to, items: state.items, master: state.master });
    if (request !== daysRequest) return false;
    const known = new Set(days.map((d) => d.date));
    const fresh = (response.items ?? []).filter((d) => !known.has(d.date) && d.date >= today);
    days = [...days, ...fresh].sort((a, b) => (a.date < b.date ? -1 : 1));
    loadedTo = to;
    return true;
  }

  function showDaysError(error, retry) {
    mount(daysStatus, errorPanel(describeError(error), [{ label: 'Попробовать ещё раз', onClick: retry, primary: true }]));
  }

  async function loadInitial() {
    mount(daysStatus, loadingBlock('Ищем свободные дни…'));
    try {
      let chunks = 0;
      do {
        if (!(await fetchChunk())) break;
        chunks += 1;
      } while ((!days.some((d) => d.available) || (state.date && loadedTo < state.date)) && chunks < AUTO_CHUNKS && loadedTo < lastDate);
    } catch (error) {
      showDaysError(error, loadInitial);
      return;
    }
    mount(daysStatus);
    const keep = days.find((d) => d.date === state.date && d.available);
    const first = keep ?? days.find((d) => d.available);
    // The chosen time's day is full now.
    if (state.slot && !keep) takenNotice.hidden = false;
    renderDays();
    if (!first) {
      mount(slotsBox, h('div', { class: 'panel' },
        h('p', { class: 'panel-title' }, 'В ближайшие дни всё занято'),
        h('p', { class: 'panel-text' }, loadedTo && loadedTo < lastDate
          ? 'Посмотрите дни дальше, выберите другого мастера или встаньте в лист ожидания — напишем, если время освободится.'
          : 'Выберите другого мастера или встаньте в лист ожидания — напишем, если время освободится.'),
        waitlistButton()));
      return;
    }
    selectDay(first.date, { quiet: true });
    scrollSelectedIntoView();
  }

  async function loadMore() {
    moreButton.disabled = true;
    try {
      await fetchChunk();
      mount(daysStatus);
      renderDays();
      if (!days.some((d) => d.date === state.date && d.available)) {
        const first = days.find((d) => d.available);
        if (first) selectDay(first.date, { quiet: true });
      }
    } catch (error) {
      showDaysError(error, loadMore);
    } finally {
      moreButton.disabled = false;
    }
  }

  function selectDay(date, { quiet = false } = {}) {
    if (!quiet) ctx.haptic();
    ctx.dispatch({ type: 'setDate', date });
    markSelectedDay();
    if (days.find((d) => d.date === date)?.available === false) {
      slotsRequest += 1;
      renderSlots(date, []);
      return;
    }
    loadSlots(date);
  }

  async function loadSlots(date) {
    const request = ++slotsRequest;
    mount(slotsBox, loadingBlock('Смотрим свободное время…'));
    slotsBox.setAttribute('aria-busy', 'true');
    let response;
    try {
      response = await ctx.api.slots({ date, items: state.items, master: state.master });
    } catch (error) {
      if (request !== slotsRequest) return;
      slotsBox.removeAttribute('aria-busy');
      mount(slotsBox, errorPanel(describeError(error), [{ label: 'Попробовать ещё раз', onClick: () => loadSlots(date), primary: true }]));
      return;
    }
    if (request !== slotsRequest) return;
    slotsBox.removeAttribute('aria-busy');
    const slots = response.items ?? [];
    const chosen = state.slot ? slots.find((s) => s.startsAt === state.slot.startsAt) : undefined;
    if (state.slot && !chosen) {
      ctx.dispatch({ type: 'setSlot', slot: null });
      takenNotice.hidden = false;
    }
    renderSlots(date, slots);
  }

  /** @param {string} date @param {Array<{ startsAt: string, masterIds?: number[] }>} slots */
  function renderSlots(date, slots) {
    if (slots.length === 0) {
      mount(slotsBox, h('div', { class: 'panel' },
        h('p', { class: 'panel-title' }, `${capitalized(formatDayLong(date))} — всё занято`),
        h('p', { class: 'panel-text' }, ctx.onWaitlist
          ? 'Выберите другой день или встаньте в лист ожидания — напишем, если время освободится.'
          : 'На этот день свободного времени нет — выберите другой.'),
        waitlistButton(date)));
      return;
    }
    mount(slotsBox,
      h('h2', { class: 'group-title' }, formatDayLong(date)),
      groupSlotsByPartOfDay(slots, ctx.timeZone).map((group) => h('div', { class: 'slot-group' },
        h('p', { class: 'slot-group-title', id: `slots-${group.title}` }, group.title),
        h('div', { class: 'slot-grid', role: 'radiogroup', 'aria-labelledby': `slots-${group.title}` },
          group.slots.map((slot) => {
            const radio = h('input', {
              type: 'radio', name: 'slot', value: slot.startsAt, class: 'sr-only',
              checked: state.slot?.startsAt === slot.startsAt,
              onChange: () => {
                ctx.haptic();
                ctx.dispatch({ type: 'setSlot', slot: { startsAt: slot.startsAt, masterIds: slot.masterIds ?? [] } });
              },
            });
            return h('label', { class: `chip${state.slot?.startsAt === slot.startsAt ? ' selected' : ''}` },
              radio, h('span', null, formatTime(slot.startsAt, ctx.timeZone)));
          })))));
  }

  function update(next) {
    state = next;
    if (state.slot) takenNotice.hidden = true;
    slotsBox.querySelectorAll('input[name="slot"]').forEach((input) => {
      const radio = /** @type {HTMLInputElement} */ (input);
      radio.checked = state.slot?.startsAt === radio.value;
      radio.closest('label')?.classList.toggle('selected', radio.checked);
    });
  }

  loadInitial();
  return { node, update };
}
