// @ts-check
/** Masters' works on the steps: the cover on a master's card, the «Работы» buttons and the gallery they open. */
import { h } from '../lib/dom.js';
import { serviceWorksLabel, worksAriaLabel, worksLabel } from '../lib/portfolio.js';
import { safeHref } from '../lib/query.js';
import { openGallery } from './gallery.js';

/**
 * What opens the galleries; `onClosed` puts the step's Telegram buttons back.
 * @param {{ api: any, tg: any, onClosed: () => void }} context
 */
export function createWorks({ api, tg, onClosed }) {
  return {
    /** @param {{ id: number, name: string }} master */
    master: (master) => openGallery({
      title: `Работы мастера ${master.name}`, load: () => api.masterPortfolio(master.id), tg, onClosed,
    }),
    /** @param {{ id: number, name: string }} service */
    service: (service) => openGallery({
      title: `Работы мастеров: ${service.name}`, load: () => api.servicePortfolio(service.id), showMaster: true, tg, onClosed,
    }),
  };
}

/** The master's cover photo in place of the initials; null without one (or when it fails to load: `fallback`). */
export function masterCover(master, fallback) {
  const src = master.photos > 0 ? safeHref(master.cover) : null;
  if (!src) return null;
  const img = h('img', { class: 'avatar avatar-photo', src, alt: '', loading: 'lazy', decoding: 'async', width: '44', height: '44' });
  img.addEventListener('error', () => img.replaceWith(fallback()));
  return img;
}

function chevron() {
  return h('span', { class: 'works-chevron', 'aria-hidden': 'true' }, '›');
}

/** «Работы (12)» under a master's card; null without works. */
export function masterWorksButton(master, onOpen) {
  const label = worksLabel(master.photos);
  if (!label || !onOpen) return null;
  return h('button', {
    type: 'button', class: 'works-btn', 'aria-label': worksAriaLabel(master.name, master.photos),
    'aria-haspopup': 'dialog', onClick: () => onOpen(master),
  }, h('span', null, label), chevron());
}

/** «Работы мастеров» under a service's card; null without works. */
export function serviceWorksButton(service, onOpen) {
  const label = serviceWorksLabel(service.portfolio);
  if (!label || !onOpen) return null;
  return h('button', {
    type: 'button', class: 'works-btn works-btn-svc', 'aria-label': `${label}: ${service.name}`,
    'aria-haspopup': 'dialog', onClick: () => onOpen(service),
  }, h('span', null, label), chevron());
}
