// @ts-check
/**
 * Telegram Mini App glue. Outside Telegram everything here is a no-op and the page works as a normal website;
 * the Telegram script is loaded only when the page was opened from Telegram, so web visitors never wait for it.
 */

export const TELEGRAM_SCRIPT = 'https://telegram.org/js/telegram-web-app.js';
const SCRIPT_TIMEOUT_MS = 5000;

/** Telegram theme parameter → the page's CSS variable. */
const THEME_VARIABLES = [
  ['bg_color', '--bg'],
  ['section_bg_color', '--surface'],
  ['secondary_bg_color', '--surface-2'],
  ['text_color', '--text'],
  ['hint_color', '--muted'],
  ['link_color', '--link'],
  ['button_color', '--accent'],
  ['button_text_color', '--on-accent'],
  ['destructive_text_color', '--danger'],
  ['section_separator_color', '--border'],
];

const COLOR_RE = /^#[0-9a-f]{3,8}$/i;

/**
 * Whether the page was launched by Telegram: the launch parameters in the URL hash, the native webview bridge,
 * or the parameters Telegram's script saved for this tab on an earlier load.
 */
export function isTelegramLaunch({ hash = '', hasWebviewProxy = false, savedParams = null } = {}) {
  if (/(^|[#&])tgWebApp(Data|Version|Platform)=/.test(hash)) return true;
  if (hasWebviewProxy) return true;
  return typeof savedParams === 'string' && savedParams.includes('tgWebApp');
}

/** CSS variables from Telegram's theme parameters (only well-formed colors). */
export function themeVariables(themeParams = {}) {
  /** @type {Record<string, string>} */
  const vars = {};
  for (const [param, variable] of THEME_VARIABLES) {
    const value = themeParams[param];
    if (typeof value === 'string' && COLOR_RE.test(value)) vars[variable] = value;
  }
  if (!vars['--surface'] && vars['--bg']) vars['--surface'] = vars['--bg'];
  return vars;
}

function loadScript(src) {
  return new Promise((resolve) => {
    const script = document.createElement('script');
    const timer = setTimeout(() => resolve(false), SCRIPT_TIMEOUT_MS);
    script.src = src;
    script.async = true;
    script.onload = () => {
      clearTimeout(timer);
      resolve(true);
    };
    script.onerror = () => {
      clearTimeout(timer);
      resolve(false);
    };
    document.head.append(script);
  });
}

function savedLaunchParams() {
  try {
    return window.sessionStorage.getItem('__telegram__initParams');
  } catch {
    return null;
  }
}

/** A Telegram bridge that does nothing (a normal web page). */
function webBridge() {
  return {
    inTelegram: false,
    initData: null,
    userFirstName: '',
    mainButton: { set: () => undefined, hide: () => undefined },
    backButton: { show: () => undefined, hide: () => undefined },
    openLink: (url) => window.open(url, '_blank', 'noopener'),
    confirm: () => Promise.resolve(null),
    haptic: () => undefined,
    close: () => undefined,
  };
}

/**
 * Loads Telegram's script when launched from Telegram and returns the bridge the page talks to.
 * `mainButton.set({ text, enabled, progress, onClick })` drives the MainButton; `backButton.show(onClick)` the
 * BackButton; `confirm(text)` resolves to true / false, or null when the page should ask by itself.
 */
export async function initTelegram() {
  const launched = isTelegramLaunch({
    hash: window.location.hash,
    hasWebviewProxy: 'TelegramWebviewProxy' in window,
    savedParams: savedLaunchParams(),
  });
  if (!launched) return webBridge();
  const loaded = await loadScript(TELEGRAM_SCRIPT);
  const webApp = loaded ? /** @type {any} */ (window).Telegram?.WebApp : undefined;
  if (!webApp || !webApp.initData) return webBridge();
  return telegramBridge(webApp);
}

function telegramBridge(webApp) {
  const atLeast = (version) => typeof webApp.isVersionAtLeast === 'function' && webApp.isVersionAtLeast(version);
  const safely = (fn) => {
    try {
      fn();
    } catch {
      // An older Telegram client without this method: the page works without it.
    }
  };

  const applyTheme = () => {
    const root = document.documentElement;
    Object.entries(themeVariables(webApp.themeParams)).forEach(([name, value]) => root.style.setProperty(name, value));
    root.dataset.theme = webApp.colorScheme === 'dark' ? 'dark' : 'light';
    if (atLeast('6.1')) {
      safely(() => webApp.setHeaderColor('bg_color'));
      safely(() => webApp.setBackgroundColor('bg_color'));
    }
  };

  document.documentElement.classList.add('in-telegram');
  applyTheme();
  safely(() => webApp.onEvent('themeChanged', applyTheme));
  safely(() => webApp.ready());
  safely(() => webApp.expand());

  let mainHandler = null;
  let mainParams = '';
  let progressShown = false;
  let backHandler = null;

  const mainButton = {
    set({ text, enabled = true, progress = false, onClick }) {
      const button = webApp.MainButton;
      if (onClick !== mainHandler) {
        if (mainHandler) safely(() => button.offClick(mainHandler));
        mainHandler = onClick;
        safely(() => button.onClick(mainHandler));
      }
      const params = JSON.stringify([text, enabled, progress]);
      if (params === mainParams) return; // called on every keystroke: touch Telegram only on a change
      mainParams = params;
      // Telegram's hideProgress() re-activates the button, so the progress goes first and the params after it.
      if (progress) safely(() => button.showProgress(false));
      else if (progressShown) safely(() => button.hideProgress());
      progressShown = progress;
      safely(() => button.setParams({ text, is_active: enabled && !progress, is_visible: true }));
    },
    hide() {
      const button = webApp.MainButton;
      if (mainHandler) safely(() => button.offClick(mainHandler));
      mainHandler = null;
      mainParams = '';
      if (progressShown) safely(() => button.hideProgress());
      progressShown = false;
      safely(() => button.hide());
    },
  };

  const backButton = {
    show(onClick) {
      if (!atLeast('6.1')) return;
      if (backHandler) safely(() => webApp.BackButton.offClick(backHandler));
      backHandler = onClick;
      safely(() => webApp.BackButton.onClick(backHandler));
      safely(() => webApp.BackButton.show());
    },
    hide() {
      if (!atLeast('6.1')) return;
      if (backHandler) safely(() => webApp.BackButton.offClick(backHandler));
      backHandler = null;
      safely(() => webApp.BackButton.hide());
    },
  };

  return {
    inTelegram: true,
    initData: webApp.initData,
    userFirstName: String(webApp.initDataUnsafe?.user?.first_name ?? ''),
    mainButton,
    backButton,
    openLink(url) {
      const absolute = new URL(url, window.location.href).href;
      if (/^https:\/\/t\.me\//.test(absolute)) safely(() => webApp.openTelegramLink(absolute));
      else safely(() => webApp.openLink(absolute));
    },
    confirm(text) {
      if (!atLeast('6.2')) return Promise.resolve(null);
      return new Promise((resolve) => {
        try {
          webApp.showConfirm(text, (ok) => resolve(Boolean(ok)));
        } catch {
          resolve(null);
        }
      });
    },
    haptic(kind = 'selection') {
      if (!atLeast('6.1')) return;
      safely(() => {
        if (kind === 'selection') webApp.HapticFeedback.selectionChanged();
        else webApp.HapticFeedback.notificationOccurred(kind);
      });
    },
    close: () => safely(() => webApp.close()),
  };
}
