import type { DbOrTx } from '../db/client.js';
import { badRequest } from '../lib/errors.js';
import { parseVariants, type ServiceRow, type ServiceVariant } from '../lib/serialize.js';
import { servicesByIds } from './refs.js';
import { servicePriceFor } from './service-prices.js';

/**
 * What a client books online (docs/API.md «Online booking»): 1–5 active catalog services, each with its variant
 * when the service has variants. Duration = Σ durations (the variant's, else the service's; 60 min when none),
 * price = Σ prices of the booked master (see service-prices.ts), prepayment = Σ `depositAmount`.
 */

export const MAX_BOOKING_ITEMS = 5;
/** Duration of a service (or variant) that has none. */
export const DEFAULT_ITEM_MINUTES = 60;

export interface BookingItem {
  serviceId: number;
  /** A variant `name` of the service. */
  variant?: string | null;
}

/** One booked service line, ready for `createAppointment({ services })`. */
export interface BookedLine {
  serviceId: number;
  name: string;
  price: number;
  durationMin: number;
}

export interface ResolvedItems {
  lines: BookedLine[];
  durationMin: number;
  price: number;
  depositRequired: number;
}

const positiveOr = (value: number | null | undefined, fallback: number): number =>
  value != null && value > 0 ? value : fallback;

/** The effective duration of a service, or of its variant. */
export function itemMinutes(service: ServiceRow, variant: ServiceVariant | null = null): number {
  return positiveOr(variant?.durationMin, positiveOr(service.durationMin, DEFAULT_ITEM_MINUTES));
}

function pickVariant(service: ServiceRow, wanted: string | null | undefined): ServiceVariant | null {
  const variants = parseVariants(service.variantsJson);
  const name = wanted?.trim() ?? '';
  const names = variants.map((v) => v.name).join(', ');
  if (variants.length === 0) {
    if (name) throw badRequest(`У услуги «${service.name}» нет вариантов — выберите её без варианта`);
    return null;
  }
  if (!name) throw badRequest(`Выберите вариант услуги «${service.name}»: ${names}`);
  const found = variants.find((v) => v.name.trim().toLowerCase() === name.toLowerCase());
  if (!found) throw badRequest(`У услуги «${service.name}» нет варианта «${name}» — выберите: ${names}`);
  return found;
}

/**
 * Validates the items against the active catalog; `400` with a Russian reason otherwise. Prices are `masterId`'s own
 * (catalog prices without one).
 */
export function resolveItems(db: DbOrTx, items: BookingItem[], masterId: number | null = null): ResolvedItems {
  if (items.length === 0) throw badRequest('Выберите хотя бы одну услугу');
  if (items.length > MAX_BOOKING_ITEMS) throw badRequest(`Можно выбрать не больше ${MAX_BOOKING_ITEMS} услуг за одну запись`);
  const catalog = servicesByIds(db, items.map((i) => i.serviceId));
  let depositRequired = 0;
  const lines = items.map((item): BookedLine => {
    const service = catalog.get(item.serviceId);
    if (!service || !service.active) throw badRequest('Эта услуга сейчас недоступна для онлайн-записи — обновите список услуг');
    const variant = pickVariant(service, item.variant);
    depositRequired += service.depositAmount;
    return {
      serviceId: service.id,
      name: variant ? `${service.name} — ${variant.name}` : service.name,
      price: servicePriceFor(service, variant?.name ?? null, masterId),
      durationMin: itemMinutes(service, variant),
    };
  });
  return {
    lines,
    durationMin: lines.reduce((sum, l) => sum + l.durationMin, 0),
    price: lines.reduce((sum, l) => sum + l.price, 0),
    depositRequired,
  };
}

/**
 * `items` of the public query string: `serviceId[:variant]`, comma-separated, the variant URL-encoded
 * («5,7:%D0%94%D0%B2%D0%B0»).
 */
export function parseItemsParam(value: string | undefined): BookingItem[] {
  const parts = (value ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) throw badRequest('Выберите хотя бы одну услугу');
  return parts.map((part) => {
    const at = part.indexOf(':');
    const id = Number(at < 0 ? part : part.slice(0, at));
    if (!Number.isSafeInteger(id) || id <= 0) throw badRequest('«Позиции»: неверный номер услуги');
    if (at < 0) return { serviceId: id };
    const raw = part.slice(at + 1);
    let variant = raw;
    try {
      variant = decodeURIComponent(raw);
    } catch {
      // Already decoded (a stray «%» in the name): use it as is.
    }
    return { serviceId: id, variant };
  });
}
