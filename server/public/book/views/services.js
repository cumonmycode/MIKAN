// @ts-check
/** Step 1: services by category → group, with photo, price, duration and variants; up to 5 at once. */
import { h, nextId } from '../lib/dom.js';
import { MAX_ITEMS } from '../lib/flow.js';
import { formatDuration, formatRub, plural } from '../lib/format.js';
import { safeHref } from '../lib/query.js';
import { stepHeading } from './common.js';
import { serviceWorksButton } from './works.js';

const CATEGORY_TITLES = { piercing: 'Пирсинг', tattoo: 'Тату', other: 'Другое' };

/** Categories in catalog order, each with its groups in catalog order. */
export function groupServices(services) {
  const categories = new Map();
  for (const service of services) {
    const key = service.category ?? 'other';
    if (!categories.has(key)) categories.set(key, new Map());
    const groups = categories.get(key);
    const group = service.group ?? '';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(service);
  }
  return [...categories].map(([key, groups]) => ({
    key,
    title: CATEGORY_TITLES[key] ?? 'Другое',
    groups: [...groups].map(([title, items]) => ({ title, items })),
  }));
}

function serviceMeta(service) {
  const parts = [service.priceText];
  if (service.durationMin) parts.push(formatDuration(service.durationMin));
  return parts.filter(Boolean).join(' · ');
}

function thumb(service) {
  const src = safeHref(service.imageUrl);
  if (!src) return h('span', { class: 'thumb thumb-empty', 'aria-hidden': 'true' }, service.name.slice(0, 1));
  const img = h('img', { class: 'thumb', src, alt: '', loading: 'lazy', decoding: 'async', width: '64', height: '64' });
  img.addEventListener('error', () => img.replaceWith(h('span', { class: 'thumb thumb-empty', 'aria-hidden': 'true' }, service.name.slice(0, 1))));
  return img;
}

function variantLabel(variant, service) {
  const duration = variant.durationMin ?? service.durationMin;
  return [variant.name, variant.priceText ?? formatRub(variant.price), duration ? formatDuration(duration) : null]
    .filter(Boolean).join(' · ');
}

/**
 * @param {{ state: any, services: any[], dispatch: (action: any) => void, haptic: () => void,
 *   onWorks?: (service: any) => void }} ctx
 */
export function renderServices(ctx) {
  const categories = groupServices(ctx.services);
  const firstSelected = ctx.state.items[0] ? ctx.services.find((s) => s.id === ctx.state.items[0].serviceId) : null;
  let activeCategory = firstSelected?.category ?? categories[0]?.key ?? 'other';
  /** @type {Map<number, { card: HTMLElement, checkbox: HTMLInputElement, variants: HTMLElement | null, radios: HTMLInputElement[] }>} */
  const controls = new Map();
  const panels = new Map();
  const tabCounts = new Map();

  const hint = h('p', { class: 'step-sub', 'aria-live': 'polite' });

  function serviceCard(service) {
    const id = nextId('svc');
    const variants = service.variants ?? [];
    const checkbox = /** @type {HTMLInputElement} */ (h('input', {
      type: 'checkbox', id, class: 'sr-only', 'aria-describedby': `${id}-meta`,
      onChange: () => {
        ctx.haptic();
        ctx.dispatch({ type: 'toggleItem', serviceId: service.id, variant: variants[0]?.name ?? null });
      },
    }));
    const radios = [];
    let variantsBox = null;
    if (variants.length > 0) {
      const name = `${id}-variant`;
      variantsBox = h('fieldset', { class: 'variants', hidden: true },
        h('legend', { class: 'variants-title' }, 'Вариант'),
        h('div', { class: 'chips' }, variants.map((variant) => {
          const radio = /** @type {HTMLInputElement} */ (h('input', {
            type: 'radio', name, value: variant.name, class: 'sr-only',
            onChange: () => {
              ctx.haptic();
              ctx.dispatch({ type: 'setVariant', serviceId: service.id, variant: variant.name });
            },
          }));
          radios.push(radio);
          return h('label', { class: 'chip' }, radio, h('span', null, variantLabel(variant, service)));
        })));
    }
    const card = h('div', { class: 'card svc' },
      h('label', { class: 'svc-main', for: id },
        checkbox,
        thumb(service),
        h('span', { class: 'svc-text' },
          h('span', { class: 'svc-name' }, service.name),
          h('span', { class: 'svc-meta', id: `${id}-meta` }, serviceMeta(service)),
          service.description ? h('span', { class: 'svc-desc' }, service.description) : null),
        h('span', { class: 'tick', 'aria-hidden': 'true' })),
      variantsBox,
      serviceWorksButton(service, ctx.onWorks));
    controls.set(service.id, { card, checkbox, variants: variantsBox, radios });
    return card;
  }

  const panelNodes = categories.map((category) => {
    const panel = h('div', { class: 'svc-panel' },
      category.groups.map((group) => h('section', { class: 'svc-group' },
        group.title ? h('h2', { class: 'group-title' }, group.title) : null,
        group.items.map(serviceCard))));
    panels.set(category.key, panel);
    return panel;
  });

  let tabs = null;
  if (categories.length > 1) {
    tabs = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Категория' },
      categories.map((category) => {
        const count = h('span', { class: 'seg-count', 'aria-hidden': 'true' });
        tabCounts.set(category.key, count);
        const radio = h('input', {
          type: 'radio', name: 'category', value: category.key, class: 'sr-only',
          checked: category.key === activeCategory,
          onChange: () => {
            activeCategory = category.key;
            showActive();
          },
        });
        return h('label', { class: 'seg', dataset: { category: category.key } }, radio, h('span', null, category.title), count);
      }));
  }

  function showActive() {
    panels.forEach((panel, key) => {
      panel.hidden = categories.length > 1 && key !== activeCategory;
    });
    tabs?.querySelectorAll('.seg').forEach((seg) => {
      seg.classList.toggle('selected', /** @type {HTMLElement} */ (seg).dataset.category === activeCategory);
    });
  }

  const node = h('section', { class: 'step' },
    stepHeading('Выберите услугу'),
    hint,
    tabs,
    panelNodes.length ? panelNodes : h('p', { class: 'lead' }, 'Сейчас нет услуг для онлайн-записи. Позвоните или напишите нам.'));

  function update(state) {
    const full = state.items.length >= MAX_ITEMS;
    controls.forEach((c, serviceId) => {
      const item = state.items.find((it) => it.serviceId === serviceId);
      c.checkbox.checked = Boolean(item);
      c.checkbox.disabled = !item && full;
      c.card.classList.toggle('selected', Boolean(item));
      c.card.classList.toggle('disabled', !item && full);
      if (c.variants) c.variants.hidden = !item;
      c.radios.forEach((radio) => {
        radio.checked = Boolean(item) && radio.value === item?.variant;
        radio.closest('label')?.classList.toggle('selected', radio.checked);
      });
    });
    tabCounts.forEach((count, key) => {
      const n = state.items.filter((item) => ctx.services.find((s) => s.id === item.serviceId)?.category === key).length;
      count.textContent = n > 0 ? String(n) : '';
      count.hidden = n === 0;
    });
    const n = state.items.length;
    hint.textContent = full
      ? `Выбрано ${MAX_ITEMS} из ${MAX_ITEMS} — больше за одну запись не получится`
      : n > 0
        ? `Выбрано ${n} ${plural(n, 'услуга', 'услуги', 'услуг')} — можно добавить ещё`
        : `Можно выбрать несколько — до ${MAX_ITEMS}`;
  }

  /** A service preselected by a link may be far down the list: bring it into view. */
  function afterMount() {
    const first = ctx.state.items[0] ? controls.get(ctx.state.items[0].serviceId)?.card : null;
    if (first && first.getBoundingClientRect().bottom > window.innerHeight - 96) {
      first.scrollIntoView({ block: 'center' });
    }
  }

  showActive();
  update(ctx.state);
  return { node, update, afterMount };
}
