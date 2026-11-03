// @ts-check
/**
 * MIKAN STUDIO booking page and Telegram Mini App: loads the catalog, walks the steps (each step is a browser
 * history entry, so «Назад» on the phone works), books, and shows the booking page `/book/b/<token>`.
 */
import { createCabinet } from './cabinet-app.js';
import { createApi, describeError } from './lib/api.js';
import { isCabinetPath } from './lib/cabinet.js';
import { mount } from './lib/dom.js';
import {
  STEP_TITLES, applyPreselect, bookingPriceText, canProceed, createFlow, firstIncompleteStep, reduce, selectedLines,
  stepPosition, stepsFor, totalDuration,
} from './lib/flow.js';
import { addDays, deviceTimeZone, formatDateTime, formatDuration, plural, todayIn } from './lib/format.js';
import { toE164 } from './lib/phone.js';
import { bookingBody, bookingPagePath, bookingTokenFromPath, parsePreselect } from './lib/query.js';
import { initTelegram } from './lib/telegram.js';
import { applyWaitPreselect, parseWaitPreselect } from './lib/waitlist.js';
import { renderBooking } from './views/booking.js';
import { loadingBlock, messagePage } from './views/common.js';
import { renderConfirm } from './views/confirm.js';
import { renderContacts } from './views/contacts.js';
import { renderMaster } from './views/master.js';
import { renderServices } from './views/services.js';
import { renderTime } from './views/time.js';
import { renderWaitlist, renderWaitlistDone } from './views/waitlist.js';
import { createWorks } from './views/works.js';

const byId = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
const root = byId('app');
const bar = byId('bar');
const barSummary = byId('bar-summary');
const barButton = byId('bar-button');
const backButton = byId('back-button');
const stepLabel = byId('step-label');
const live = byId('live');

/** Taps on «Записаться» this soon after the confirmation appeared are the tail of a double tap. */
const CONFIRM_GUARD_MS = 700;

const HINTS = {
  services: 'Сначала выберите услугу',
  master: 'Выберите мастера или «Любой мастер»',
  time: 'Выберите день и время',
};

/** Everything the controller keeps; replaced field by field, the flow state itself is immutable. */
const app = {
  /** @type {any} */ tg: null,
  /** @type {any} */ api: null,
  /** @type {null | { config: any, services: any[], masters: any[], catalog: Map<number, any>, me: any, timeZone: string }} */
  data: null,
  /** @type {any} */ state: null,
  /** @type {any} */ view: null,
  /** @type {string | null} */ viewStep: null,
  submitting: false,
  /** When the current step appeared (guards the confirmation against a double tap). */
  stepShownAt: 0,
  /** A booking was made: going «back» starts a new one instead of returning to the filled-in steps. */
  completed: false,
  /** @type {null | { body: string, key: string }} The booking being sent and its `Idempotency-Key`. */
  attempt: null,
  /** @type {null | ReturnType<typeof createWorks>} Opens the galleries of masters' works. */
  works: null,
  /** @type {any} The client cabinet `/book/me` (cabinet-app.js) when the page is it. */
  cabinet: null,
};

function announce(text) {
  live.textContent = '';
  setTimeout(() => {
    live.textContent = text;
  }, 50);
}

const haptic = () => app.tg.haptic('selection');

function setView(view, { step = null, chrome = false } = {}) {
  app.view?.destroy?.();
  app.view = view;
  app.viewStep = step;
  mount(root, view.node);
  if (!chrome) hideChrome();
  window.scrollTo(0, 0);
  const heading = /** @type {HTMLElement | null} */ (view.node.querySelector('h1'));
  heading?.focus({ preventScroll: true });
  view.afterMount?.();
}

function hideChrome() {
  bar.hidden = true;
  backButton.hidden = true;
  stepLabel.textContent = '';
  app.tg.mainButton.hide();
  app.tg.backButton.hide();
}

function showMessage(options) {
  setView({ node: messagePage(options) });
}

// ---- the steps ----

function dispatch(action) {
  const next = reduce(app.state, action, app.data.catalog);
  if (next === app.state) return;
  app.state = next;
  app.view?.update?.(next);
  updateChrome();
}

function summaryText(state) {
  const lines = selectedLines(state, app.data.catalog);
  if (state.step === 'time') return state.slot ? formatDateTime(state.slot.startsAt, app.data.timeZone) : 'Выберите день и время';
  if (state.step === 'contacts') return '';
  if (lines.length === 0) return 'Выберите услугу';
  // The chosen master's prices; «any» — the masters' one total or their range.
  const price = bookingPriceText(state, app.data.catalog, app.data.masters);
  const parts = [`${lines.length} ${plural(lines.length, 'услуга', 'услуги', 'услуг')}`, formatDuration(totalDuration(lines)), price];
  return state.step === 'confirm' ? `Итого ${price}` : parts.join(' · ');
}

function updateChrome() {
  const { state } = app;
  const position = stepPosition(state);
  stepLabel.textContent = `Шаг ${position.index} из ${position.total} · ${STEP_TITLES[state.step]}`;
  const ready = state.step === 'contacts' || canProceed(state, app.data.catalog);
  const label = state.step === 'confirm' ? (app.submitting ? 'Записываем…' : 'Записаться') : 'Дальше';
  const summary = summaryText(state);
  barSummary.textContent = summary;
  barButton.textContent = label;
  barButton.setAttribute('aria-disabled', String(!ready || app.submitting));
  bar.hidden = app.tg.inTelegram && summary === '';
  backButton.hidden = app.tg.inTelegram || position.index <= 1;
  app.tg.mainButton.set({ text: label, enabled: ready, progress: app.submitting, onClick: goNext });
  if (position.index > 1) app.tg.backButton.show(goBack);
  else app.tg.backButton.hide();
}

function renderStep() {
  const { state, data } = app;
  const base = { state, dispatch, haptic };
  let view;
  switch (state.step) {
    case 'services':
      view = renderServices({ ...base, services: data.services, onWorks: app.works?.service });
      break;
    case 'master':
      view = renderMaster({ ...base, catalog: data.catalog, masters: data.masters, onWorks: app.works?.master });
      break;
    case 'time':
      view = renderTime({
        ...base,
        api: app.api,
        timeZone: data.timeZone,
        horizonDays: data.config.horizonDays ?? 60,
        durationMin: totalDuration(selectedLines(state, data.catalog)),
        onWaitlist: openWaitlist,
      });
      break;
    case 'contacts':
      view = renderContacts({ ...base, onSubmit: goNext, today: todayIn(data.timeZone) });
      break;
    default:
      view = renderConfirm({
        state, catalog: data.catalog, masters: data.masters, config: data.config, me: data.me, timeZone: data.timeZone,
        today: todayIn(data.timeZone), edit: editStep, dispatch,
      });
  }
  setView(view, { step: state.step, chrome: true });
  app.stepShownAt = Date.now();
  updateChrome();
}

function goNext() {
  const { state } = app;
  if (app.submitting) return;
  if (state.step === 'confirm') {
    // A double tap on «Дальше» at the contacts must not book before the client has seen the summary.
    if (Date.now() - app.stepShownAt < CONFIRM_GUARD_MS) return;
    if (app.view.validate && !app.view.validate(state)) return;
    submit();
    return;
  }
  if (state.step === 'contacts' && !app.view.validate(state)) return;
  if (!canProceed(state, app.data.catalog)) {
    announce(HINTS[state.step] ?? '');
    return;
  }
  const next = reduce(state, { type: 'next' }, app.data.catalog);
  if (next.step === state.step) return;
  app.state = next;
  history.pushState({ step: next.step }, '');
  renderStep();
}

function goBack() {
  history.back();
}

/** Jumps back to an earlier step through the history, so the entries keep matching the steps. */
function editStep(step) {
  const steps = stepsFor(app.state);
  const delta = steps.indexOf(step) - steps.indexOf(app.state.step);
  if (delta < 0) history.go(delta);
}

function showStep(step) {
  app.state = reduce(app.state, { type: 'goto', step }, app.data.catalog);
  if (app.state.step !== step) {
    // Not reachable (e.g. after a reload): show the first unfinished step instead.
    const target = firstIncompleteStep(app.state, app.data.catalog);
    app.state = { ...app.state, step: target };
    history.replaceState({ step: target }, '');
  }
  renderStep();
}

function onPopState(event) {
  if (app.cabinet) {
    app.cabinet.onPopState(event);
    return;
  }
  const token = bookingTokenFromPath(window.location.pathname);
  if (token) {
    openBooking(token, null);
    return;
  }
  if (!app.data) {
    startFlow();
    return;
  }
  if (event.state?.waitlist && !app.completed) {
    showWaitlist(event.state.waitlist);
    return;
  }
  if (app.completed) {
    app.completed = false;
    resetFlow(null);
    return;
  }
  const step = event.state?.step ?? stepsFor(app.state)[0];
  if (step === app.state.step && app.viewStep === step) return;
  showStep(step);
}

// ---- the waitlist (a busy day or strip on the time step) ----

/** @param {{ from: string, to: string }} range */
function openWaitlist(range) {
  history.pushState({ step: app.state.step, waitlist: range }, '');
  showWaitlist(range);
}

/** @param {{ from: string, to: string }} range */
function showWaitlist(range) {
  const data = /** @type {NonNullable<typeof app.data>} */ (app.data);
  const today = todayIn(data.timeZone);
  setView(renderWaitlist({
    state: app.state, catalog: data.catalog, masters: data.masters, preset: range, today,
    lastDate: addDays(today, Math.max(1, data.config.horizonDays ?? 60)), api: app.api, tg: app.tg,
    onJoined: showWaitlistDone, onBack: goBack,
  }));
  app.tg.backButton.show(goBack);
}

function showWaitlistDone(entry) {
  app.completed = true;
  history.replaceState({ waitlistDone: true }, '');
  setView(renderWaitlistDone({
    entry, linked: app.state.linked, tg: app.tg,
    onAgain: () => {
      app.completed = false;
      resetFlow(null);
    },
  }));
  announce('Вы в листе ожидания');
}

// ---- booking ----

function errorActions(description, error) {
  switch (description.action) {
    case 'pickTime':
      return [{ label: 'Выбрать другое время', primary: true, onClick: pickAnotherTime }];
    case 'retry':
      // Expired Telegram init data is renewed only by opening the Mini App again.
      if (error?.status === 401) return [{ label: 'Обновить', primary: true, onClick: () => window.location.reload() }];
      return [{ label: 'Попробовать ещё раз', primary: true, onClick: submit }];
    case 'back':
      return [{ label: 'Изменить запись', onClick: () => editStep(app.state.linked ? 'services' : 'contacts') }];
    default:
      return [];
  }
}

function pickAnotherTime() {
  const steps = stepsFor(app.state);
  const delta = steps.indexOf('time') - steps.indexOf(app.state.step);
  app.state = reduce(app.state, { type: 'slotTaken' }, app.data.catalog);
  renderStep();
  if (delta < 0) history.go(delta);
}

async function submit() {
  if (app.submitting) return;
  const { state } = app;
  const phone = state.linked ? null : toE164(state.phone);
  const body = bookingBody({ ...state, startsAt: state.slot.startsAt, phone: phone ?? '' });
  // One key per booking attempt: a retry after a lost answer resends it, a changed booking gets a new one.
  const attempt = JSON.stringify(body);
  if (app.attempt?.body !== attempt) app.attempt = { body: attempt, key: newIdempotencyKey() };
  app.submitting = true;
  app.view.clearError?.();
  updateChrome();
  try {
    const booking = await app.api.book(body, app.attempt.key);
    app.attempt = null;
    app.submitting = false;
    app.completed = true;
    app.tg.haptic('success');
    history.replaceState({ booking: booking.token }, '', bookingPagePath(booking.token));
    openBooking(booking.token, booking);
  } catch (error) {
    app.submitting = false;
    updateChrome();
    const description = describeError(error, { booking: true });
    app.tg.haptic('error');
    app.view.showError?.(description, errorActions(description, error));
  }
}

/** A random UUID v4 (`crypto.randomUUID` needs a secure context; the fallback covers older browsers). */
function newIdempotencyKey() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

async function openBooking(token, booking) {
  if (!app.data) setView({ node: loadingBlock('Загружаем запись…') });
  const config = app.data?.config ?? (await app.api.config().catch(() => null));
  const timeZone = app.data?.timeZone ?? (config?.studio?.timezone || deviceTimeZone());
  // The booking view drives the Telegram MainButton itself, so the step chrome goes before it is built.
  hideChrome();
  setView(renderBooking({ api: app.api, tg: app.tg, token, booking, timeZone, config, announce }), { chrome: true });
}

// ---- start ----

/** `wait` — the waitlist's freed-time link (`?wait=…&start=…`): the flow opens on that time. */
function resetFlow(preselect, wait = null) {
  const { catalog, masters, me, timeZone } = /** @type {NonNullable<typeof app.data>} */ (app.data);
  // A linked chat whose card already has a birthday is not asked for it.
  let state = createFlow({ linked: Boolean(me), askBirthday: !me?.hasBirthday });
  if (!state.linked && app.tg.userFirstName) state = reduce(state, { type: 'setField', field: 'name', value: app.tg.userFirstName }, catalog);
  if (wait) state = applyWaitPreselect(state, wait, catalog, masters, timeZone);
  else if (preselect) state = applyPreselect(state, preselect, catalog, masters);
  app.state = state;
  // One history entry per step up to where the flow starts, so «Назад» walks through them.
  const steps = stepsFor(state);
  history.replaceState({ step: steps[0] }, '');
  for (let i = 1; i <= steps.indexOf(state.step); i += 1) history.pushState({ step: steps[i] }, '');
  renderStep();
}

async function loadMe() {
  if (!app.api.hasInitData()) return null;
  try {
    const me = await app.api.me();
    return me?.linked ? { name: me.name ?? '', phone: me.phone ?? '', hasBirthday: Boolean(me.hasBirthday) } : null;
  } catch (error) {
    // Stale or invalid init data: book like the website (name and phone) rather than fail.
    if (error?.status === 401) app.api.dropInitData();
    return null;
  }
}

async function startFlow() {
  setView({ node: loadingBlock('Загружаем услуги…') });
  const [config, services, masters, me] = await Promise.allSettled([
    app.api.config(), app.api.services(), app.api.masters(), loadMe(),
  ]);
  if (config.status === 'fulfilled' && config.value.enabled === false) {
    showMessage({
      title: 'Онлайн-запись временно недоступна',
      message: config.value.note || (app.tg.inTelegram
        ? 'Напишите нам в этот чат — запишем вас сами.'
        : 'Позвоните или напишите нам — запишем вас сами.'),
      studio: config.value.studio,
    });
    return;
  }
  const failed = [config, services, masters].find((result) => result.status === 'rejected');
  if (failed && failed.status === 'rejected') {
    const description = describeError(failed.reason);
    showMessage({
      title: description.title,
      message: description.message,
      studio: config.status === 'fulfilled' ? config.value.studio : null,
      actions: description.action === 'none' ? [] : [{ label: 'Попробовать ещё раз', onClick: startFlow, primary: true }],
    });
    return;
  }
  const value = (result) => (result.status === 'fulfilled' ? result.value : null);
  const serviceList = value(services)?.items ?? [];
  app.data = {
    config: value(config),
    services: serviceList,
    masters: value(masters)?.items ?? [],
    catalog: new Map(serviceList.map((service) => [service.id, service])),
    me: value(me),
    timeZone: value(config)?.studio?.timezone || deviceTimeZone(),
  };
  resetFlow(parsePreselect(window.location.search), parseWaitPreselect(window.location.search));
}

async function boot() {
  app.tg = await initTelegram();
  app.api = createApi({ initData: app.tg.initData });
  app.works = createWorks({ api: app.api, tg: app.tg, onClosed: updateChrome });
  barButton.addEventListener('click', goNext);
  backButton.addEventListener('click', goBack);
  window.addEventListener('popstate', onPopState);
  if (isCabinetPath(window.location.pathname)) {
    app.cabinet = createCabinet({ tg: app.tg, api: app.api, setView: (view) => setView(view), backButton, stepLabel, announce });
    app.cabinet.start();
    return;
  }
  const token = bookingTokenFromPath(window.location.pathname);
  if (token) openBooking(token, null);
  else startFlow();
}

boot();
