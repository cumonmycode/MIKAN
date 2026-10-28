// @ts-check
/**
 * The client cabinet `/book/me` inside the booking page app: signs in (Telegram init data, or the website link's token
 * kept in `localStorage`), shows the cabinet, moves (a history entry, so «Назад» and Telegram's BackButton return) and
 * cancels appointments, leaves the waitlist, signs out on the website.
 */
import { createCabinetApi } from './lib/cabinet-api.js';
import { BIRTHDAY_ERROR, birthdayFromInput } from './lib/birthday.js';
import { appointmentTitle, cancelNotice, describeCabinetError, readToken, saveToken, takeToken } from './lib/cabinet.js';
import { deviceTimeZone, formatDateTime, todayIn } from './lib/format.js';
import { confirmDialog, loadingBlock } from './views/common.js';
import { renderCabinet, renderLoadFailure, renderSignIn } from './views/cabinet.js';
import { renderReschedule } from './views/cabinet-reschedule.js';

const TITLE = 'Личный кабинет — MIKAN STUDIO';

function storage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * @param {{ tg: any, api: any, setView: (view: any) => void, backButton: HTMLElement, stepLabel: HTMLElement,
 *   announce: (text: string) => void }} shell  the page's shell (app.js): views go through `setView`, which resets the
 *   header and Telegram's buttons first.
 */
export function createCabinet(shell) {
  const { tg, api } = shell;
  /** @type {any} */ let cabinetApi = null;
  /** @type {any} */ let data = null;
  /** @type {any} */ let config = null;
  let tab = 'visits';
  /** @type {string | null} */ let notice = null;
  /** @type {{ title: string, message: string } | null} */ let error = null;
  /** @type {string | null} */ let busyId = null;
  /** @type {{ status: 'idle' | 'loading' | 'ready' | 'failed', value: any }} */ let bonuses = { status: 'idle', value: null };
  /** The cabinet was shown: a later 401 means stale Telegram data or a revoked link, not a stranger. */
  let signedIn = false;
  /** The birthday card: what is typed, its error, whether it is being saved. */
  let birthday = { draft: '', error: /** @type {string | null} */ (null), saving: false };

  const timeZone = () => config?.studio?.timezone || deviceTimeZone();

  function chrome({ back }) {
    shell.stepLabel.textContent = 'Личный кабинет';
    shell.backButton.hidden = !back || tg.inTelegram;
    if (back) tg.backButton.show(() => history.back());
    else tg.backButton.hide();
  }

  function showSignIn(reason) {
    data = null;
    shell.setView(renderSignIn({ inTelegram: tg.inTelegram, reason, botUsername: config?.botUsername, studio: config?.studio, onClose: () => tg.close() }));
    chrome({ back: false });
  }

  function fail(err, retry) {
    const description = describeCabinetError(err);
    if (description.action === 'signIn') {
      const stale = cabinetApi.hasToken() || (tg.inTelegram && signedIn);
      cabinetApi.forgetToken();
      saveToken(storage(), null);
      showSignIn(stale ? 'expired' : 'none');
      return;
    }
    shell.setView(renderLoadFailure({ title: description.title, message: description.message, onRetry: retry }));
    chrome({ back: false });
  }

  /** Loads the cabinet and shows the current screen; `quiet` leaves a move screen as it is (only the data changes). */
  async function load({ quiet = false } = {}) {
    if (!data) shell.setView({ node: loadingBlock('Загружаем кабинет…') });
    const [cabinet, studioConfig] = await Promise.allSettled([cabinetApi.cabinet(), config ?? api.config()]);
    if (studioConfig.status === 'fulfilled') config = studioConfig.value;
    if (cabinet.status === 'rejected') {
      fail(cabinet.reason, load);
      return;
    }
    data = cabinet.value;
    signedIn = true;
    // The history is asked again when the bonuses tab shows next (a cancellation may have returned bonuses).
    if (bonuses.status !== 'loading') bonuses = { status: 'idle', value: null };
    if (history.state?.cabinet !== 'reschedule') showMain();
    else if (!quiet) showReschedule(history.state.id);
  }

  function loadBonuses() {
    if (bonuses.status === 'loading') return;
    bonuses = { status: 'loading', value: bonuses.value };
    cabinetApi.bonuses().then(
      (value) => {
        bonuses = { status: 'ready', value };
        if (tab === 'bonuses' && data && history.state?.cabinet !== 'reschedule') showMain({ keepScroll: true });
      },
      (err) => {
        if (describeCabinetError(err).action === 'signIn') return fail(err, load);
        bonuses = { status: 'failed', value: null };
        if (tab === 'bonuses' && data) showMain({ keepScroll: true });
      },
    );
  }

  /**
   * `motion`: `page` — the cabinet appears, `panel` — another tab, `none` — the same screen refreshed.
   * @param {{ keepScroll?: boolean, motion?: 'page' | 'panel' | 'none' }} [options]
   */
  function showMain({ keepScroll = false, motion = keepScroll ? 'none' : 'page' } = {}) {
    if (!data) return;
    if (tab === 'bonuses' && bonuses.status === 'idle') loadBonuses();
    const scroll = window.scrollY;
    shell.setView(renderCabinet({
      data, config, timeZone: timeZone(), today: todayIn(timeZone()), now: Date.now() + api.clockOffset(), tab, motion,
      inTelegram: tg.inTelegram, notice, error, busyId, bonuses, canLogout: !tg.inTelegram && cabinetApi.hasToken(), birthday,
      onBirthdayInput: (value) => { birthday = { ...birthday, draft: value, error: null }; },
      onSaveBirthday: saveBirthday,
      onTab: selectTab, onReschedule: openReschedule, onCancel: cancel, onLeaveWaitlist: leaveWaitlist, onLogout: logout,
      onRetryBonuses: () => { bonuses = { status: 'idle', value: null }; showMain({ keepScroll: true }); },
      onDismiss: () => { error = null; showMain({ keepScroll: true }); },
    }));
    if (keepScroll) window.scrollTo(0, scroll);
    chrome({ back: false });
    if (tg.inTelegram) tg.mainButton.set({ text: 'Записаться', onClick: () => window.location.assign('/book') });
  }

  function selectTab(key) {
    if (key === tab) return;
    tab = key;
    notice = null;
    tg.haptic('selection');
    history.replaceState({ cabinet: 'main', tab }, '');
    showMain({ keepScroll: true, motion: 'panel' });
    document.getElementById(`tab-${key}`)?.focus();
  }

  // ---- moving ----

  function openReschedule(appointment) {
    notice = null;
    error = null;
    history.pushState({ cabinet: 'reschedule', id: appointment.id }, '');
    showReschedule(appointment.id);
  }

  function showReschedule(id, rescheduleError = null) {
    const appointment = data?.upcoming?.find((a) => a.id === id && a.canReschedule);
    if (!appointment) {
      history.replaceState({ cabinet: 'main', tab }, '');
      showMain();
      return;
    }
    shell.setView(renderReschedule({
      appointment, cabinetApi, tg, timeZone: timeZone(), horizonDays: config?.horizonDays ?? 60, error: rescheduleError,
      // The answer may come after the client has already gone back: then only the data is refreshed.
      onDone: (updated) => {
        replaceAppointment(updated);
        notice = `Запись перенесена: ${formatDateTime(updated.startsAt, timeZone())}`;
        shell.announce(notice);
        leaveReschedule(id);
      },
      onFailed: (err) => {
        const description = describeCabinetError(err);
        if (description.action === 'signIn') fail(err, load);
        else if (description.action === 'pickTime' && onRescheduleOf(id)) showReschedule(id, description);
        else {
          error = description;
          leaveReschedule(id);
        }
      },
    }));
    chrome({ back: true });
  }

  const onRescheduleOf = (id) => history.state?.cabinet === 'reschedule' && history.state.id === id;

  /** Back to the cabinet (when still on the move screen) with fresh data. */
  function leaveReschedule(id) {
    if (onRescheduleOf(id)) history.back();
    else if (history.state?.cabinet !== 'reschedule') showMain();
    load({ quiet: true });
  }

  function replaceAppointment(updated) {
    if (!data) return;
    data = { ...data, upcoming: data.upcoming.map((a) => (a.id === updated.id ? updated : a)) };
  }

  // ---- the birthday ----

  async function saveBirthday() {
    if (birthday.saving || !data) return;
    const parsed = birthdayFromInput(birthday.draft, todayIn(timeZone()));
    if (parsed.error || !parsed.value) {
      birthday = { ...birthday, error: parsed.error ?? BIRTHDAY_ERROR };
      tg.haptic('error');
      showMain({ keepScroll: true });
      document.getElementById('cab-birthday')?.focus();
      return;
    }
    birthday = { ...birthday, saving: true, error: null };
    notice = null;
    error = null;
    showMain({ keepScroll: true });
    try {
      const saved = await cabinetApi.saveBirthday(parsed.value);
      data = { ...data, client: { ...data.client, birthday: saved.birthday } };
      birthday = { draft: '', error: null, saving: false };
      tg.haptic('success');
      notice = 'Записали! В день рождения пришлём подарок 🎁';
      shell.announce(notice);
      showMain({ keepScroll: true });
    } catch (err) {
      tg.haptic('error');
      birthday = { ...birthday, saving: false };
      const description = describeCabinetError(err);
      if (description.action === 'signIn') {
        fail(err, load);
        return;
      }
      // 400 — the date is wrong; 409 — it is set already (the cabinet is loaded again and the card goes away).
      if (err?.status === 400) birthday = { ...birthday, error: description.message };
      else error = description;
      if (err?.status === 409) await load();
      else showMain({ keepScroll: true });
    }
  }

  // ---- cancelling ----

  async function ask(title, text, confirmLabel) {
    const answer = await tg.confirm(text ? `${title}\n\n${text}` : title);
    if (answer !== null) return answer;
    return confirmDialog({ title, text, confirmLabel, cancelLabel: 'Нет' });
  }

  async function act(id, run, done) {
    busyId = id;
    error = null;
    notice = null;
    showMain({ keepScroll: true });
    try {
      await run();
      tg.haptic('success');
      notice = done;
      shell.announce(done);
    } catch (err) {
      tg.haptic('error');
      const description = describeCabinetError(err);
      if (description.action === 'signIn') {
        busyId = null;
        fail(err, load);
        return;
      }
      error = description;
    }
    busyId = null;
    await load();
  }

  async function cancel(appointment) {
    if (busyId) return;
    const question = cancelNotice(appointment, Date.now() + api.clockOffset(), { cancellationText: config?.cancellationText ?? '', timeZone: timeZone() });
    if (!(await ask(question.title, question.text, 'Да, отменить'))) return;
    await act(`a${appointment.id}`, () => cabinetApi.cancel(appointment.id), `Запись отменена: ${appointmentTitle(appointment)}`);
  }

  async function leaveWaitlist(entry) {
    if (busyId) return;
    if (!(await ask('Убрать из листа ожидания?', 'Мы больше не будем писать, когда освободится время.', 'Да, убрать'))) return;
    await act(`w${entry.id}`, () => cabinetApi.leaveWaitlist(entry.id), 'Убрали из листа ожидания');
  }

  async function logout() {
    if (!(await ask('Выйти из кабинета?', 'На этом устройстве понадобится новая ссылка из Telegram-бота.', 'Выйти'))) return;
    try {
      await cabinetApi.logout();
    } catch {
      // Signed out here anyway: the link is forgotten on this device.
    }
    cabinetApi.forgetToken();
    saveToken(storage(), null);
    showSignIn('loggedOut');
  }

  // ---- start ----

  function onPopState(event) {
    if (!data) {
      load();
      return;
    }
    if (event.state?.cabinet === 'reschedule') showReschedule(event.state.id);
    else {
      tab = event.state?.tab ?? tab;
      showMain();
    }
  }

  async function start() {
    document.title = TITLE;
    const taken = takeToken(window.location.href);
    if (taken.cleanUrl !== null) history.replaceState(null, '', taken.cleanUrl);
    if (taken.token) saveToken(storage(), taken.token);
    const token = taken.token ?? readToken(storage());
    cabinetApi = createCabinetApi({ api, token });
    tab = history.state?.tab ?? 'visits';
    if (!history.state?.cabinet) history.replaceState({ cabinet: 'main', tab }, '');
    if (!cabinetApi.canSignIn()) {
      config = await api.config().catch(() => null);
      showSignIn(taken.cleanUrl !== null ? 'expired' : 'none');
      return;
    }
    await load();
  }

  return { start, onPopState };
}
