import { randomUUID } from 'node:crypto';
import { and, count, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { smmAccounts, smmDates, smmPlatformPosts } from '../db/schema.js';
import { DAY_MS, isValidCalendarDate } from '../lib/time.js';
import { parse } from '../lib/validation.js';
import { studioDate } from '../smm/context.js';
import { CRAFT_SECTIONS, CRAFT_SOURCE } from '../smm/craft.js';
import { saveSmmFile } from '../smm/files.js';
import { datesBetween, listOwnDates } from '../smm/holidays.js';
import { describeZoneInBackground } from '../smm/interior.js';
import {
  addZone,
  addZonePhoto,
  getDoc,
  listZones,
  removeZone,
  removeZonePhoto,
  saveOwnerText,
  updateZone,
  zoneOr404,
} from '../smm/knowledge.js';
import { studyInBackground } from '../smm/study.js';
import { SmmError, type SmmProfile } from '../smm/types.js';
import { IMAGE_MAX_BYTES, param, profileOf, readUpload, SMM_BASE } from './smm.js';
import { sniffImage } from './uploads.js';

/**
 * The marketer's knowledge base in the app (ported from Titan HUB `knowledge.router.ts`), per profile: the portrait
 * (`brand` — the owner's words plus what the marketer gathered), what has been in the socials, the shooting places by
 * zone (photos, the owner's description, the marketer's description), the tattoo & piercing reference and the
 * calendar of holidays with the profile's own dates.
 */

/** The calendar in the app looks three months ahead. */
const DATES_AHEAD_DAYS = 92;
/** A leap year, so «02-29» is a valid yearly date. */
const LEAP_YEAR = '2024';

const OwnerTextSchema = z.object({ ownerText: z.string().max(8000) });
const TitleSchema = z.object({ title: z.string().trim().min(2).max(60) });
const ZonePatchSchema = z.object({
  title: z.string().trim().min(2).max(60).optional(),
  ownerText: z.string().max(3000).optional(),
});
const DateSchema = z.object({
  day: z.string().regex(/^(\d{4}-)?\d{2}-\d{2}$/),
  title: z.string().trim().min(2).max(120),
  note: z.string().trim().max(300).optional(),
});

/** Posts collected from the profile's platforms, by platform. */
function platformPostCounts(ctx: AppContext, profile: SmmProfile): Record<string, number> {
  const rows = ctx.db
    .select({ platform: smmPlatformPosts.platform, n: count() })
    .from(smmPlatformPosts)
    .innerJoin(smmAccounts, eq(smmAccounts.id, smmPlatformPosts.accountId))
    .where(eq(smmAccounts.profile, profile))
    .groupBy(smmPlatformPosts.platform)
    .all();
  return Object.fromEntries(rows.map((r) => [r.platform, r.n]));
}

async function zoneOfProfile(ctx: AppContext, profile: SmmProfile, id: string) {
  const zone = await zoneOr404(ctx, id);
  if (zone.profile !== profile) throw new SmmError('Место не найдено', 404);
  return zone;
}

export function smmKnowledgeRoutes(app: FastifyInstance, ctx: AppContext): void {
  const B = SMM_BASE;

  async function payload(profile: SmmProfile) {
    const today = studioDate(ctx);
    const ahead = studioDate(ctx, Date.now() + DATES_AHEAD_DAYS * DAY_MS);
    const [brand, socials, zones, upcoming, own] = await Promise.all([
      getDoc(ctx, profile, 'brand'),
      getDoc(ctx, profile, 'socials'),
      listZones(ctx, profile),
      datesBetween(ctx, profile, today, ahead),
      listOwnDates(ctx, profile),
    ]);
    return {
      brand,
      socials: { ...socials, posts: platformPostCounts(ctx, profile) },
      zones,
      craft: { source: CRAFT_SOURCE, sections: CRAFT_SECTIONS },
      dates: { upcoming, own },
    };
  }

  app.get(`${B}/knowledge`, async (request) => payload(profileOf(request)));

  /** The owner's words about the studio (or the author) — the main source of the portrait. */
  app.put(`${B}/knowledge/brand`, async (request) => {
    const profile = profileOf(request);
    const { ownerText } = parse(OwnerTextSchema, request.body);
    await saveOwnerText(ctx, profile, 'brand', ownerText.trim());
    return payload(profile);
  });

  /** The marketer re-composes the portrait or studies the socials (and then the portrait). */
  app.post(`${B}/knowledge/:key/refresh`, async (request) => {
    const profile = profileOf(request);
    const key = param(request, 'key');
    if (key !== 'brand' && key !== 'socials') throw new SmmError('Не найдено', 404);
    if (!(await studyInBackground(ctx, profile, key))) throw new SmmError('Маркетолог уже над этим работает', 409);
    return payload(profile);
  });

  // ─── Shooting places ───────────────────────────────────────────────────────

  app.post(`${B}/zones`, async (request) => {
    const profile = profileOf(request);
    await addZone(ctx, profile, parse(TitleSchema, request.body).title);
    return payload(profile);
  });

  app.patch(`${B}/zones/:zoneId`, async (request) => {
    const profile = profileOf(request);
    const zone = await zoneOfProfile(ctx, profile, param(request, 'zoneId'));
    const body = parse(ZonePatchSchema, request.body);
    await updateZone(ctx, zone.id, { title: body.title, ownerText: body.ownerText?.trim() });
    return payload(profile);
  });

  app.delete(`${B}/zones/:zoneId`, async (request) => {
    const profile = profileOf(request);
    const zone = await zoneOfProfile(ctx, profile, param(request, 'zoneId'));
    await removeZone(ctx, zone.id);
    return payload(profile);
  });

  /** A photo of the place from the phone (the app scales it down to 2048 px); images only, ≤ 10 MB. */
  app.post(`${B}/zones/:zoneId/photos`, async (request) => {
    const profile = profileOf(request);
    const zone = await zoneOfProfile(ctx, profile, param(request, 'zoneId'));
    const { data } = await readUpload(request, IMAGE_MAX_BYTES, 'Фото больше 10 МБ');
    const ext = sniffImage(data);
    if (!ext) throw new SmmError('Нужна фотография (JPEG, PNG, HEIC или WebP), не видео');
    await addZonePhoto(ctx, zone.id, await saveSmmFile(ctx, data, ext));
    return payload(profile);
  });

  app.delete(`${B}/zones/:zoneId/photos/:photoId`, async (request) => {
    const profile = profileOf(request);
    const zone = await zoneOfProfile(ctx, profile, param(request, 'zoneId'));
    const photoId = param(request, 'photoId');
    if (!zone.photos.some((p) => p.id === photoId)) throw new SmmError('Фото не найдено', 404);
    await removeZonePhoto(ctx, zone.id, photoId);
    return payload(profile);
  });

  /** The marketer looks at the photos of the place and writes its description. */
  app.post(`${B}/zones/:zoneId/describe`, async (request) => {
    const profile = profileOf(request);
    const zone = await zoneOfProfile(ctx, profile, param(request, 'zoneId'));
    if (!(await describeZoneInBackground(ctx, zone.id))) throw new SmmError('Маркетолог уже смотрит это место', 409);
    return payload(profile);
  });

  // ─── Own dates ─────────────────────────────────────────────────────────────

  app.post(`${B}/dates`, async (request) => {
    const profile = profileOf(request);
    const { day, title, note } = parse(DateSchema, request.body);
    const full = day.length === 5 ? `${LEAP_YEAR}-${day}` : day;
    if (!isValidCalendarDate(full)) throw new SmmError('Такой даты нет');
    ctx.db
      .insert(smmDates)
      .values({ id: randomUUID(), profile, day, title, note: note ?? '', createdAt: Date.now() })
      .run();
    return payload(profile);
  });

  app.delete(`${B}/dates/:dateId`, async (request) => {
    const profile = profileOf(request);
    const removed = ctx.db
      .delete(smmDates)
      .where(and(eq(smmDates.id, param(request, 'dateId')), eq(smmDates.profile, profile)))
      .run();
    if (!removed.changes) throw new SmmError('Дата не найдена', 404);
    return payload(profile);
  });
}
