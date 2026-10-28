// @ts-check
/**
 * The cabinet screen `/book/me`: greeting, the birthday card while the card has none, tabs «Записи» / «Бонусы» /
 * «Уход», and the sign-in screen.
 */
import { botSignInLink, bonusesText, expiringText, signInCopy, TABS } from '../lib/cabinet.js';
import { h } from '../lib/dom.js';
import { PAGE_BASE } from '../lib/query.js';
import { birthdayInput } from './birthday-field.js';
import { bonusRow, certificateCard, memoCard, pastRow, upcomingCard, waitlistCard } from './cabinet-parts.js';
import { errorPanel, loadingBlock, messagePage, stepHeading, studioContacts } from './common.js';

/**
 * @typedef {{
 *   data: any, config: any, timeZone: string, today: string, now: number, tab: string, inTelegram: boolean,
 *   motion: 'page' | 'panel' | 'none',
 *   notice: string | null, error: { title: string, message: string } | null, busyId: string | null,
 *   bonuses: { status: 'idle' | 'loading' | 'ready' | 'failed', value: any },
 *   canLogout: boolean,
 *   birthday: { draft: string, error: string | null, saving: boolean },
 *   onTab: (tab: string) => void, onReschedule: (a: any) => void, onCancel: (a: any) => void,
 *   onLeaveWaitlist: (entry: any) => void, onLogout: () => void, onRetryBonuses: () => void, onDismiss: () => void,
 *   onBirthdayInput: (value: string) => void, onSaveBirthday: () => void,
 * }} CabinetCtx
 */

function section(title, ...children) {
  return h('section', { class: 'cab-section' }, h('h2', { class: 'group-title' }, title), children);
}

function emptyPanel(title, text, action) {
  return h('div', { class: 'panel' },
    h('p', { class: 'panel-title' }, title),
    text ? h('p', { class: 'panel-text' }, text) : null,
    action ? h('div', { class: 'panel-actions' }, action) : null);
}

/** @param {CabinetCtx} ctx */
function visitsTab(ctx) {
  const { upcoming = [], past = [], waitlist = [] } = ctx.data;
  return [
    section('Предстоящие',
      upcoming.length
        ? upcoming.map((a) => upcomingCard(a, {
          timeZone: ctx.timeZone, now: ctx.now, busy: ctx.busyId === `a${a.id}`, onReschedule: ctx.onReschedule, onCancel: ctx.onCancel,
        }))
        : emptyPanel('Предстоящих записей нет', 'Выберите услугу и удобное время — это займёт пару минут.',
          h('a', { class: 'btn btn-primary', href: PAGE_BASE }, 'Записаться'))),
    waitlist.length
      ? section('Лист ожидания', waitlist.map((entry) => waitlistCard(entry, { busy: ctx.busyId === `w${entry.id}`, onLeave: ctx.onLeaveWaitlist })))
      : null,
    past.length ? section('История', h('ul', { class: 'card cab-list' }, past.map((a) => pastRow(a, ctx.timeZone, ctx.now)))) : null,
  ];
}

/** @param {CabinetCtx} ctx */
function bonusHistory(ctx) {
  const { status, value } = ctx.bonuses;
  if (status === 'failed') {
    return errorPanel({ title: 'Не получилось загрузить историю', message: 'Проверьте интернет и попробуйте ещё раз.' },
      [{ label: 'Попробовать ещё раз', onClick: ctx.onRetryBonuses, primary: true }]);
  }
  if (status !== 'ready') return loadingBlock('Загружаем историю…');
  const items = value?.items ?? [];
  if (items.length === 0) return h('p', { class: 'empty' }, 'Бонусов пока не было — они начисляются за покупки в студии.');
  return h('ul', { class: 'card cab-list' }, items.map((op) => bonusRow(op, ctx.timeZone, ctx.today)));
}

/** @param {CabinetCtx} ctx */
function bonusesTab(ctx) {
  const { loyalty, certificates = [] } = ctx.data;
  const expiring = loyalty ? expiringText(loyalty.expiring, ctx.timeZone) : null;
  return [
    loyalty
      ? h('div', { class: 'card cab-balance' },
        h('p', { class: 'muted small' }, 'На счёте'),
        h('p', { class: 'cab-balance-value' }, bonusesText(loyalty.bonusBalance)),
        h('p', { class: 'muted small' }, '1 бонус = 1 ₽ — можно оплатить часть покупки в студии'),
        expiring ? h('p', { class: 'small cab-free' }, expiring) : null)
      : emptyPanel('Бонусная программа сейчас не действует', 'Если на счёте остались бонусы, их история — ниже.'),
    certificates.length
      ? section('Подарочные сертификаты', certificates.map((c) => certificateCard(c, ctx.timeZone, ctx.today)))
      : null,
    section('История бонусов', bonusHistory(ctx)),
  ];
}

/** @param {CabinetCtx} ctx */
function careTab(ctx) {
  const memos = ctx.data.aftercare ?? [];
  if (memos.length === 0) {
    return [emptyPanel('Памяток пока нет', 'После процедуры здесь появится памятка по уходу — по дням, с сегодняшним шагом.')];
  }
  return memos.map((memo) => memoCard(memo, ctx.today));
}

/**
 * «Добавьте дату рождения — пришлём подарок» while the card has none (`birthday: null`; an older server sends nothing).
 * @param {CabinetCtx} ctx
 */
function birthdayCard(ctx) {
  if (ctx.data.client?.birthday !== null) return null;
  const { draft, error, saving } = ctx.birthday;
  const errorLine = h('p', { class: 'field-error', id: 'cab-birthday-error', hidden: !error }, error ?? '');
  const input = birthdayInput({
    id: 'cab-birthday',
    value: draft,
    enterKey: 'done',
    onValue: (value) => {
      errorLine.hidden = true;
      input.removeAttribute('aria-invalid');
      ctx.onBirthdayInput(value);
    },
  });
  input.setAttribute('aria-describedby', 'cab-birthday-hint cab-birthday-error');
  if (error) input.setAttribute('aria-invalid', 'true');
  return h('section', { class: 'card cab-birthday', 'aria-labelledby': 'cab-birthday-title' },
    h('h2', { class: 'cab-what', id: 'cab-birthday-title' }, 'Добавьте дату рождения — пришлём подарок 🎁'),
    h('p', { class: 'muted small cab-line', id: 'cab-birthday-hint' }, 'Например, 12.04.1995. Год можно не указывать.'),
    h('form', {
      class: 'cab-birthday-form', novalidate: true,
      onSubmit: (event) => {
        event.preventDefault();
        ctx.onSaveBirthday();
      },
    },
    h('label', { class: 'sr-only', for: 'cab-birthday' }, 'Дата рождения'),
    h('div', { class: 'field' }, input),
    h('button', { type: 'submit', class: 'btn btn-primary', disabled: saving }, saving ? 'Сохраняем…' : 'Сохранить')),
    errorLine);
}

/** @param {CabinetCtx} ctx */
function tabs(ctx) {
  return h('div', { class: 'segmented cab-tabs', role: 'tablist', 'aria-label': 'Разделы кабинета' },
    TABS.map((tab) => h('button', {
      type: 'button',
      role: 'tab',
      id: `tab-${tab.key}`,
      class: `seg${tab.key === ctx.tab ? ' selected' : ''}`,
      'aria-selected': String(tab.key === ctx.tab),
      'aria-controls': 'cab-panel',
      onClick: () => ctx.onTab(tab.key),
    }, tab.title)));
}

/**
 * The cabinet; rebuilt by the controller whenever something changes.
 * @param {CabinetCtx} ctx
 */
export function renderCabinet(ctx) {
  const { client } = ctx.data;
  const content = ctx.tab === 'bonuses' ? bonusesTab(ctx) : ctx.tab === 'care' ? careTab(ctx) : visitsTab(ctx);
  const footer = [
    ctx.inTelegram ? null : h('a', { class: 'btn btn-primary', href: PAGE_BASE }, 'Записаться'),
    ctx.canLogout ? h('button', { type: 'button', class: 'btn btn-quiet', onClick: ctx.onLogout }, 'Выйти') : null,
  ].filter(Boolean);
  // The page slides in when it appears, only the panel on a tab switch, nothing on a refresh.
  const node = h('section', { class: ctx.motion === 'page' ? 'step cab' : 'cab' },
    stepHeading(client?.name ? `Здравствуйте, ${client.name}` : 'Личный кабинет', client?.phone ?? ''),
    ctx.notice ? h('div', { class: 'panel cab-notice', role: 'status' }, h('p', { class: 'panel-text' }, ctx.notice)) : null,
    ctx.error ? errorPanel(ctx.error, [{ label: 'Закрыть', onClick: ctx.onDismiss }]) : null,
    birthdayCard(ctx),
    tabs(ctx),
    h('div', { id: 'cab-panel', role: 'tabpanel', 'aria-labelledby': `tab-${ctx.tab}`, class: ctx.motion === 'panel' ? 'cab-panel cab-panel-enter' : 'cab-panel' }, content),
    footer.length ? h('div', { class: 'stack' }, footer) : null,
    studioContacts(ctx.config?.studio));
  return { node };
}

/**
 * Who the client is could not be told: how to sign in (the bot's link or, in Telegram, sharing the phone).
 * @param {{ inTelegram: boolean, reason?: 'none' | 'expired' | 'loggedOut', botUsername?: string | null, studio?: any,
 *   onClose: () => void }} ctx
 */
export function renderSignIn(ctx) {
  const copy = signInCopy({ inTelegram: ctx.inTelegram, reason: ctx.reason });
  const link = ctx.inTelegram ? null : botSignInLink(ctx.botUsername);
  const actions = ctx.inTelegram
    ? [{ label: 'Вернуться в чат', onClick: ctx.onClose, primary: true }]
    : [
      ...(link ? [{ label: 'Получить ссылку в Telegram', href: link, primary: true }] : []),
      { label: 'Записаться онлайн', href: PAGE_BASE, primary: !link },
    ];
  const node = messagePage({ title: copy.title, message: copy.message, studio: ctx.studio ?? null, actions });
  node.querySelectorAll('a[href^="https://t.me/"]').forEach((a) => {
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  });
  return { node };
}

/** The cabinet could not be loaded. */
export function renderLoadFailure({ title, message, onRetry }) {
  return {
    node: messagePage({
      title,
      message,
      actions: [{ label: 'Попробовать ещё раз', onClick: onRetry, primary: true }, { label: 'Записаться', href: PAGE_BASE }],
    }),
  };
}
