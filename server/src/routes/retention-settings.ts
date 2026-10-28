import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { getRetentionSettings, updateRetentionSettings } from '../domain/retention-settings.js';
import { parse } from '../lib/validation.js';
import { timeOfDay } from './settings.js';

/** Retention settings (docs/API.md «Retention settings»): each group and field omitted = unchanged. */

const int = (min: number, max: number) => z.number().int().min(min).max(max);
const message = z.string().trim().min(1).max(1000);

const loyalty = z
  .object({
    enabled: z.boolean(),
    cashbackPercent: int(0, 50),
    maxPaymentPercent: int(0, 100),
    /** `null` — earned bonuses never burn. */
    expiryDays: int(1, 3650).nullable(),
    notifyClient: z.boolean(),
  })
  .partial();

const birthday = z
  .object({
    enabled: z.boolean(),
    sendAt: timeOfDay,
    text: message,
    bonusAmount: int(0, 100_000),
    bonusDays: int(1, 365),
    discountPercent: int(0, 100),
    discountDaysBefore: int(0, 31),
    discountDaysAfter: int(0, 31),
  })
  .partial();

const winback = z
  .object({
    enabled: z.boolean(),
    afterMonths: int(1, 24),
    sendAt: timeOfDay,
    text: message,
    bonusAmount: int(0, 100_000),
    bonusDays: int(1, 365),
    dailyLimit: int(1, 500),
  })
  .partial();

/** `validityMonths: null` — certificates never expire. */
const certificates = z.object({ validityMonths: int(1, 60).nullable() }).partial();

const body = z.object({
  loyalty: loyalty.optional(),
  birthday: birthday.optional(),
  winback: winback.optional(),
  certificates: certificates.optional(),
});

export function retentionSettingsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/settings/retention', async () => getRetentionSettings(ctx.db));
  app.put('/settings/retention', async (request) => updateRetentionSettings(ctx.db, parse(body, request.body)));
}
