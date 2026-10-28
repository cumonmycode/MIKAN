import { desc } from 'drizzle-orm';
import { serviceSections } from '../bot/catalog.js';
import type { AppContext } from '../context.js';
import type { DbOrTx } from '../db/client.js';
import { appointments } from '../db/schema.js';
import { buildIcs } from '../lib/ics.js';
import { parseMasterPrices, parsePhotos, parseVariants, type AppointmentRow, type ServiceRow } from '../lib/serialize.js';
import { formatRub, formatServicePrice } from '../lib/text.js';
import { formatTime, toIso } from '../lib/time.js';
import { cancellationPolicyText } from './cancellation.js';
import { pendingDepositCodes } from './deposits.js';
import { newPublicToken, type BookingCheck } from './online-booking.js';
import { itemMinutes } from './online-booking-items.js';
import { calendarUrl, telegramBookingLink } from './online-booking-links.js';
import { bookingFacts } from './online-booking-messages.js';
import { onlineMasters } from './online-booking-slots.js';
import { portfolioCovers, servicePortfolioCounts } from './portfolio.js';
import { employeesByIds, serviceLinesByAppointment } from './refs.js';
import { servicePriceFor } from './service-prices.js';
import { getStudioSettings } from './settings.js';

/**
 * What the booking page and the Mini App see (docs/API.md «Online booking»): `PublicService`, masters, the config and
 * `PublicBooking` — never internal fields (costs, notes, other clients, staff data).
 */

export type PublicStatus = 'awaiting_payment' | 'awaiting_confirmation' | 'confirmed' | 'cancelled' | 'completed';

/**
 * The own prices of the bookable masters (`masterIds`) that have them: every variant listed, with the master's price
 * or the catalog one.
 */
function publicMasterPrices(s: ServiceRow, masterIds: ReadonlySet<number>) {
  const variants = parseVariants(s.variantsJson);
  return parseMasterPrices(s.masterPricesJson)
    .filter((own) => masterIds.has(own.employeeId))
    .map((own) => ({
      masterId: own.employeeId,
      price: own.price,
      priceText: formatServicePrice(own.price, own.priceMax, s.priceFrom),
      variants: variants.map((v) => {
        const price = servicePriceFor(s, v.name, own.employeeId);
        return { name: v.name, price, priceText: formatRub(price) };
      }),
    }));
}

/** `masterIds` — the masters clients can book (their own prices are shown). */
export function publicService(s: ServiceRow, masterIds: ReadonlySet<number>) {
  return {
    id: s.id,
    name: s.name,
    category: s.category,
    group: s.groupName,
    description: s.description,
    priceText: formatServicePrice(s.price, s.priceMax, s.priceFrom),
    price: s.price,
    durationMin: itemMinutes(s),
    depositAmount: s.depositAmount,
    // The cover the apps show: the schematic picture, else the first photo of works.
    imageUrl: s.imageUrl ?? parsePhotos(s.photosJson)[0] ?? null,
    variants: parseVariants(s.variantsJson).map((v) => ({
      name: v.name,
      priceText: formatRub(v.price),
      price: v.price,
      durationMin: itemMinutes(s, v),
    })),
    masterPrices: publicMasterPrices(s, masterIds),
  };
}
export type PublicService = ReturnType<typeof publicService>;

/**
 * Active services in catalog order: per service category, its groups in staff order, then the ungrouped ones. Each
 * carries `portfolio` — how many photos of it working masters have (docs/API.md «Portfolio»).
 */
export function publicServices(db: DbOrTx): Array<PublicService & { portfolio: number }> {
  const works = servicePortfolioCounts(db);
  const masterIds = new Set(onlineMasters(db).map((m) => m.id));
  return serviceSections(db).flatMap((section) =>
    section.items.map((s) => ({ ...publicService(s, masterIds), portfolio: works.get(s.id) ?? 0 })),
  );
}

/** Masters clients can book, with the number of portfolio photos and the first one as the cover. */
export function publicMasters(db: DbOrTx) {
  const masters = onlineMasters(db);
  const covers = portfolioCovers(db, masters.map((m) => m.id));
  return masters.map((m) => ({ id: m.id, name: m.name, color: m.color, ...(covers.get(m.id) ?? { photos: 0, cover: null }) }));
}

export function publicConfig(ctx: AppContext) {
  const studio = getStudioSettings(ctx.db);
  const online = studio.onlineBooking;
  return {
    enabled: online.enabled,
    studio: {
      name: studio.name,
      address: studio.address,
      phone: studio.phone,
      workingHours: studio.workingHours.trim() || `${studio.workdayStart}–${studio.workdayEnd}`,
      timezone: studio.timezone,
    },
    note: online.note,
    leadMinutes: online.leadMinutes,
    horizonDays: online.horizonDays,
    holdMinutes: online.holdMinutes,
    stepMinutes: online.stepMinutes,
    cancellationText: cancellationPolicyText(studio.cancellation),
    botUsername: ctx.gateway.username(),
  };
}

export function publicStatus(a: AppointmentRow): PublicStatus {
  if (a.status === 'completed') return 'completed';
  if (a.status !== 'scheduled' && a.status !== 'confirmed') return 'cancelled';
  if (a.onlineState === 'awaiting_payment') return 'awaiting_payment';
  if (a.onlineState === 'awaiting_confirmation') return 'awaiting_confirmation';
  return 'confirmed';
}

/** «ждёт предоплату до 14:35» / «ждёт подтверждения студии» / «подтверждена ✅» / «отменена» / «завершена». */
export function bookingStatusText(db: DbOrTx, a: AppointmentRow): string {
  switch (publicStatus(a)) {
    case 'awaiting_payment':
      return a.holdUntil != null ? `ждёт предоплату до ${formatTime(a.holdUntil, getStudioSettings(db).timezone)}` : 'ждёт предоплату';
    case 'awaiting_confirmation':
      return 'ждёт подтверждения студии';
    case 'confirmed':
      return 'подтверждена ✅';
    case 'completed':
      return 'завершена';
    default:
      return 'отменена';
  }
}

const studioOut = (db: DbOrTx) => {
  const studio = getStudioSettings(db);
  return { name: studio.name, address: studio.address, phone: studio.phone };
};

export function publicBookingOut(ctx: AppContext, a: AppointmentRow) {
  const { db } = ctx;
  const token = a.publicToken ?? '';
  const status = publicStatus(a);
  const lines = serviceLinesByAppointment(db, [a.id]).get(a.id) ?? [];
  const pending = status === 'awaiting_payment' ? (pendingDepositCodes(db, a.id)[0] ?? null) : null;
  return {
    token,
    status,
    number: a.id,
    items: lines.map((l) => ({ name: l.name, price: l.price })),
    master: { name: employeesByIds(db, [a.masterId]).get(a.masterId)?.name ?? '' },
    startsAt: toIso(a.startsAt),
    endsAt: toIso(a.endsAt),
    price: a.price,
    depositRequired: a.depositRequired,
    holdUntil: status === 'awaiting_payment' ? toIso(a.holdUntil) : null,
    payment: pending ? { payload: pending.payload, amount: pending.amount, expiresAt: toIso(pending.expiresAt) } : null,
    studio: studioOut(db),
    telegramLink: telegramBookingLink(ctx.gateway.username(), token),
    calendarUrl: calendarUrl(ctx.config, token),
  };
}
export type PublicBooking = ReturnType<typeof publicBookingOut>;

/** The honeypot's answer: looks like a booking waiting for confirmation, nothing is stored. */
export function decoyBooking(ctx: AppContext, check: BookingCheck): PublicBooking {
  const { db } = ctx;
  const token = newPublicToken();
  const last = db.select({ id: appointments.id }).from(appointments).orderBy(desc(appointments.id)).limit(1).get();
  const master = employeesByIds(db, [check.masterId]).values().next().value;
  return {
    token,
    status: 'awaiting_confirmation',
    number: (last?.id ?? 0) + 1,
    items: check.items.lines.map((l) => ({ name: l.name, price: l.price })),
    master: { name: master?.name ?? '' },
    startsAt: toIso(check.startsAt),
    endsAt: toIso(check.endsAt),
    price: check.items.price,
    depositRequired: check.items.depositRequired,
    holdUntil: null,
    payment: null,
    studio: studioOut(db),
    telegramLink: telegramBookingLink(ctx.gateway.username(), token),
    calendarUrl: calendarUrl(ctx.config, token),
  };
}

/** «Добавить в календарь». */
export function bookingIcs(ctx: AppContext, a: AppointmentRow): string {
  const studio = getStudioSettings(ctx.db);
  const facts = bookingFacts(ctx.db, a);
  const status = publicStatus(a);
  return buildIcs(
    {
      uid: `${a.publicToken ?? a.id}@mikan`,
      start: a.startsAt,
      end: a.endsAt,
      summary: `${facts.what} — ${studio.name}`,
      description: `Запись №${a.id}\nМастер: ${facts.master}${studio.phone ? `\nТелефон студии: ${studio.phone}` : ''}`,
      location: studio.address.trim() || null,
      status: status === 'cancelled' ? 'CANCELLED' : status === 'confirmed' || status === 'completed' ? 'CONFIRMED' : 'TENTATIVE',
      stamp: a.updatedAt,
    },
    '-//MIKAN//Online booking//RU',
  );
}
