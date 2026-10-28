// @ts-check
/**
 * Moving an appointment from the cabinet: the booking flow's day strip and free starts (views/time.js), fed by the
 * cabinet's own days / slots of that appointment (its master and duration, its own time free).
 */
import { appointmentTitle, describeCabinetError } from '../lib/cabinet.js';
import { h, mount } from '../lib/dom.js';
import { formatDateTime, formatTime, formatVisit } from '../lib/format.js';
import { errorPanel } from './common.js';
import { renderTime } from './time.js';

/**
 * @param {{ appointment: any, cabinetApi: any, tg: any, timeZone: string, horizonDays: number,
 *   error?: { title: string, message: string } | null, onDone: (updated: any) => void, onFailed: (error: unknown) => void }} ctx
 *   `onFailed` — a failure the screen cannot handle by itself (signed out, the appointment changed).
 */
export function renderReschedule(ctx) {
  const { appointment, tg } = ctx;
  let state = { date: null, slot: null, items: [], master: null };
  let busy = false;
  let destroyed = false;

  const errorSlot = h('div', { class: 'error-slot' });
  const summary = h('p', { class: 'bar-summary' });
  const button = /** @type {HTMLButtonElement} */ (h('button', { type: 'button', class: 'btn btn-primary bar-button', onClick: () => submit() }, 'Перенести'));
  const bar = h('div', { class: 'bar cab-bar', hidden: tg.inTelegram }, h('div', { class: 'bar-inner' }, summary, button));

  const time = renderTime({
    state,
    api: {
      days: (q) => ctx.cabinetApi.days(appointment.id, { from: q.from, to: q.to }),
      slots: (q) => ctx.cabinetApi.slots(appointment.id, { date: q.date }),
    },
    timeZone: ctx.timeZone,
    horizonDays: ctx.horizonDays,
    durationMin: Math.round((Date.parse(appointment.endsAt) - Date.parse(appointment.startsAt)) / 60_000),
    dispatch,
    haptic: () => tg.haptic('selection'),
  });
  const current = h('div', { class: 'card cab-current' },
    h('p', { class: 'muted small' }, 'Сейчас'),
    h('p', { class: 'cab-what' }, formatVisit(appointment.startsAt, appointment.endsAt, ctx.timeZone)),
    h('p', { class: 'muted small' }, [appointmentTitle(appointment), appointment.master?.name ? `мастер ${appointment.master.name}` : null].filter(Boolean).join(' · ')));
  // Under the heading, above the day strip.
  time.node.insertBefore(current, time.node.children[1] ?? null);
  time.node.insertBefore(errorSlot, current.nextSibling);
  if (ctx.error) mount(errorSlot, errorPanel(ctx.error));

  function dispatch(action) {
    if (action.type === 'setDate') state = action.date === state.date ? state : { ...state, date: action.date, slot: null };
    else if (action.type === 'setSlot') state = { ...state, slot: action.slot };
    else return;
    time.update(state);
    updateActions();
  }

  function updateActions() {
    if (destroyed) return;
    const slot = state.slot;
    summary.textContent = slot ? formatDateTime(slot.startsAt, ctx.timeZone) : 'Выберите новое время';
    button.textContent = busy ? 'Переносим…' : 'Перенести';
    button.setAttribute('aria-disabled', String(!slot || busy));
    tg.mainButton.set({
      text: slot ? `Перенести на ${formatTime(slot.startsAt, ctx.timeZone)}` : 'Выберите время',
      enabled: Boolean(slot),
      progress: busy,
      onClick: submit,
    });
  }

  async function submit() {
    if (!state.slot || busy) return;
    busy = true;
    mount(errorSlot);
    updateActions();
    try {
      const updated = await ctx.cabinetApi.reschedule(appointment.id, state.slot.startsAt);
      busy = false;
      tg.haptic('success');
      ctx.onDone(updated);
    } catch (error) {
      busy = false;
      tg.haptic('error');
      const description = describeCabinetError(error);
      if (description.action === 'signIn' || description.action === 'reload' || description.action === 'pickTime') {
        ctx.onFailed(error);
        return;
      }
      updateActions();
      mount(errorSlot, errorPanel(description, [{ label: 'Попробовать ещё раз', onClick: submit, primary: true }]));
      errorSlot.scrollIntoView?.({ block: 'nearest' });
    }
  }

  return {
    node: h('div', { class: 'cab-reschedule' }, time.node, bar),
    afterMount: updateActions,
    destroy() {
      destroyed = true;
      tg.mainButton.hide();
    },
  };
}
