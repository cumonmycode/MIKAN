import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { asc, eq } from 'drizzle-orm';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { z } from 'zod';
import { uploadsDir } from '../app.js';
import type { AppContext } from '../context.js';
import type { DbOrTx } from '../db/client.js';
import { aftercareTemplates, services } from '../db/schema.js';
import { badRequest, conflict, errorMessage, notFound, upstreamError } from '../lib/errors.js';
import { parseMasterPrices, parseVariants, templateOut, type ServiceRow, type ServiceVariant } from '../lib/serialize.js';
import {
  defaultImageSubject,
  generateImage,
  ImageGenerationError,
  serviceImagePrompt,
  type GeneratedImage,
} from '../lib/service-images.js';
import { idParams, money, nonNull, nullableText, parse, queryBool, requiredText } from '../lib/validation.js';
import { resolveCategory, serviceScope } from '../domain/categories.js';
import { DEFAULT_HEALING_CHECK_DAYS, HEALING_CHECK_DAYS_MAX, JEWELRY_CHANGE_WEEKS_MAX } from '../domain/follow-ups.js';
import { masterPricesJson, pruneMasterVariants, type MasterPriceInput } from '../domain/service-prices.js';
import { serializeService, serializeServices, setCompatibleJewelry, setConsumptionNorms } from '../domain/services.js';
import { sniffImage } from './uploads.js';

const MAX_PHOTOS = 12;
const MAX_VARIANTS = 20;
const MAX_MASTER_PRICES = 20;
const MAX_DURATION_MIN = 24 * 60;
/** Generation + download limit: a bit under the apps' 4-minute timeout, so they get a real error message. */
const IMAGE_TIMEOUT_MS = 210_000;

const category = z.enum(['tattoo', 'piercing', 'other']);
const durationMin = z.number().int().min(1).max(MAX_DURATION_MIN);

const isImagePath = (v: string) => v.startsWith('/uploads/') || /^https?:\/\//.test(v);
const IMAGE_PATH_MESSAGE = 'ссылка должна начинаться с /uploads/ или http(s)://';
const imagePath = z.string().trim().max(500).refine(isImagePath, { message: IMAGE_PATH_MESSAGE });
const imageUrl = z
  .string()
  .trim()
  .max(500)
  .refine((v) => v === '' || isImagePath(v), { message: IMAGE_PATH_MESSAGE })
  .nullish()
  .transform((v) => (v === '' ? null : v));
const variant = z.object({ name: requiredText(100), price: money, durationMin: durationMin.nullish() });
const masterPrice = z.object({
  employeeId: z.number().int().positive(),
  price: money,
  priceMax: money.nullish(),
  variants: nonNull(z.array(z.object({ name: requiredText(100), price: money })).max(MAX_VARIANTS)),
});

/** Fields that are optional on create and behave the same on PATCH (absent = untouched). */
const optionalServiceFields = {
  group: nullableText(100),
  priceMax: money.nullish(),
  priceFrom: nonNull(z.boolean()),
  description: nullableText(5000),
  imageUrl,
  imagePrompt: nullableText(1000),
  photos: nonNull(z.array(imagePath).max(MAX_PHOTOS)),
  variants: nonNull(z.array(variant).max(MAX_VARIANTS)),
  masterPrices: nonNull(z.array(masterPrice).max(MAX_MASTER_PRICES)),
  depositAmount: nonNull(money),
  aftercareTemplateId: z.number().int().positive().nullish(),
  freshProcedure: nonNull(z.boolean()),
  healingCheckDays: z.number().int().min(1).max(HEALING_CHECK_DAYS_MAX).nullish(),
  jewelryChangeWeeks: z.number().int().min(1).max(JEWELRY_CHANGE_WEEKS_MAX).nullish(),
  jewelryIds: nonNull(z.array(z.number().int().positive()).max(100)),
  consumables: nonNull(
    z.array(z.object({ productId: z.number().int().positive(), quantity: z.number().int().min(1).max(1000) })).max(50),
  ),
  active: nonNull(z.boolean()),
  sort: nonNull(z.number().int().min(-100_000).max(100_000)),
};
const serviceCreate = z.object({ name: requiredText(200), category, price: money, durationMin, ...optionalServiceFields });
const servicePatch = z.object({
  name: nonNull(requiredText(200)),
  category: nonNull(category),
  price: nonNull(money),
  durationMin: nonNull(durationMin),
  ...optionalServiceFields,
});
const generateBody = z.object({ prompt: nullableText(1000) });

const steps = z
  .array(z.object({ dayOffset: z.number().int().min(0).max(3650), text: requiredText(4000) }))
  .min(1)
  .max(50)
  .transform((list) => [...list].sort((a, b) => a.dayOffset - b.dayOffset));
const templateCreate = z.object({ name: requiredText(200), category, steps });
const templatePatch = z.object({ name: nonNull(requiredText(200)), category: nonNull(category), steps: nonNull(steps) });

function assertTemplate(db: DbOrTx, id: number | null | undefined) {
  if (id == null) return;
  if (!db.select({ id: aftercareTemplates.id }).from(aftercareTemplates).where(eq(aftercareTemplates.id, id)).get()) {
    throw badRequest('Памятка по уходу не найдена');
  }
}

/** `undefined` = keep the current value; anything else (incl. `null`) replaces it. */
const keep = <T>(next: T | undefined, current: T): T => (next === undefined ? current : next);

/** A price range must grow, and it always means the final price is set per appointment. */
function resolvePricing(price: number, priceMax: number | null, priceFrom: boolean) {
  if (priceMax != null && priceMax <= price) throw badRequest('Максимальная цена должна быть больше минимальной');
  return { price, priceMax, priceFrom: priceMax != null || priceFrom };
}

function variantsJson(list: Array<{ name: string; price: number; durationMin?: number | null }>): string {
  const names = list.map((v) => v.name.toLowerCase());
  if (new Set(names).size !== names.length) throw badRequest('Варианты: названия не должны повторяться');
  const clean: ServiceVariant[] = list.map((v) => ({ name: v.name, price: v.price, durationMin: v.durationMin ?? null }));
  return JSON.stringify(clean);
}

/**
 * The masters' prices to store: sent ones are validated against the name and variants being saved; new variants alone
 * drop the overrides of names that no longer exist; otherwise they stay.
 */
function masterPricesFor(
  db: DbOrTx,
  input: { masterPrices?: MasterPriceInput[]; variants?: unknown },
  current: ServiceRow | null,
  service: { name: string; variantsJson: string },
): string {
  const variants = parseVariants(service.variantsJson);
  if (input.masterPrices) {
    const stored = current ? parseMasterPrices(current.masterPricesJson) : [];
    return masterPricesJson(db, input.masterPrices, { name: service.name, variants }, stored);
  }
  if (!current) return '[]';
  return input.variants ? pruneMasterVariants(current.masterPricesJson, variants) : current.masterPricesJson;
}

function getService(db: DbOrTx, id: number): ServiceRow {
  const row = db.select().from(services).where(eq(services.id, id)).get();
  if (!row) throw notFound('Услуга не найдена');
  return row;
}

/** Runs the AI generator, mapping every failure to a 502 with a Russian message. */
async function runGenerator(ctx: AppContext, log: FastifyBaseLogger, prompt: string): Promise<GeneratedImage> {
  const { apiKey, baseUrl, imageModel } = ctx.config.ai;
  if (!apiKey || !baseUrl) throw conflict('Генерация картинок недоступна: не настроен ключ Polza AI');
  const generate = ctx.generateImage ?? generateImage;
  try {
    return await generate({ apiKey, baseUrl, model: imageModel, timeoutMs: IMAGE_TIMEOUT_MS }, prompt);
  } catch (err) {
    if (err instanceof ImageGenerationError) {
      log.warn({ err: err.message }, 'service image generation failed');
      throw upstreamError(err.message);
    }
    log.error({ err: errorMessage(err) }, 'service image generation crashed');
    throw upstreamError('Сервис генерации картинок недоступен, попробуйте позже');
  }
}

export function catalogRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;
  /** Services whose picture is being generated (a paid call: a repeated tap must not start a second one). */
  const generating = new Set<number>();

  app.get('/services', async (request) => {
    const q = parse(z.object({ includeInactive: queryBool }), request.query);
    const rows = db
      .select()
      .from(services)
      .where(q.includeInactive ? undefined : eq(services.active, true))
      .orderBy(asc(services.sort), asc(services.name), asc(services.id))
      .all();
    return { items: serializeServices(db, rows) };
  });

  app.post('/services', async (request) => {
    const input = parse(serviceCreate, request.body);
    assertTemplate(db, input.aftercareTemplateId);
    const pricing = resolvePricing(input.price, input.priceMax ?? null, input.priceFrom ?? false);
    // Older builds do not send it: a service with its own memo template is taken as a fresh procedure.
    const freshProcedure = input.freshProcedure ?? input.aftercareTemplateId != null;
    // A fresh procedure asks «Как заживает?» a week after the visit unless staff chose otherwise.
    const healingCheckDays = input.healingCheckDays !== undefined ? input.healingCheckDays : freshProcedure ? DEFAULT_HEALING_CHECK_DAYS : null;
    const variants = variantsJson(input.variants ?? []);
    const now = Date.now();
    return db.transaction((tx) => {
      const row = tx
        .insert(services)
        .values({
          name: input.name,
          category: input.category,
          groupName: resolveCategory(tx, serviceScope(input.category), input.group),
          ...pricing,
          durationMin: input.durationMin,
          description: input.description ?? null,
          imageUrl: input.imageUrl ?? null,
          imagePrompt: input.imagePrompt ?? null,
          photosJson: JSON.stringify(input.photos ?? []),
          variantsJson: variants,
          masterPricesJson: masterPricesFor(tx, input, null, { name: input.name, variantsJson: variants }),
          depositAmount: input.depositAmount ?? 0,
          aftercareTemplateId: input.aftercareTemplateId ?? null,
          freshProcedure,
          healingCheckDays,
          jewelryChangeWeeks: input.jewelryChangeWeeks ?? null,
          active: input.active ?? true,
          sort: input.sort ?? 0,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
      if (input.jewelryIds) setCompatibleJewelry(tx, row.id, input.jewelryIds);
      if (input.consumables) setConsumptionNorms(tx, row.id, input.consumables);
      return serializeService(tx, row);
    });
  });

  app.patch('/services/:id', async (request) => {
    const { id } = parse(idParams, request.params);
    const input = parse(servicePatch, request.body);
    const current = getService(db, id);
    assertTemplate(db, input.aftercareTemplateId);
    const pricing = resolvePricing(
      input.price ?? current.price,
      keep(input.priceMax, current.priceMax),
      input.priceFrom ?? current.priceFrom,
    );
    const category = input.category ?? current.category;
    const name = input.name ?? current.name;
    const variants = input.variants ? variantsJson(input.variants) : current.variantsJson;
    return db.transaction((tx) => {
      const row = tx
        .update(services)
        .set({
          name,
          category,
          // A service moved to another category takes its group name along.
          groupName: resolveCategory(tx, serviceScope(category), keep(input.group, current.groupName)),
          ...pricing,
          durationMin: input.durationMin ?? current.durationMin,
          description: keep(input.description, current.description),
          imageUrl: keep(input.imageUrl, current.imageUrl),
          imagePrompt: keep(input.imagePrompt, current.imagePrompt),
          photosJson: input.photos ? JSON.stringify(input.photos) : current.photosJson,
          variantsJson: variants,
          masterPricesJson: masterPricesFor(tx, input, current, { name, variantsJson: variants }),
          depositAmount: input.depositAmount ?? current.depositAmount,
          aftercareTemplateId: keep(input.aftercareTemplateId, current.aftercareTemplateId),
          freshProcedure: input.freshProcedure ?? current.freshProcedure,
          healingCheckDays: keep(input.healingCheckDays, current.healingCheckDays),
          jewelryChangeWeeks: keep(input.jewelryChangeWeeks, current.jewelryChangeWeeks),
          active: input.active ?? current.active,
          sort: input.sort ?? current.sort,
          updatedAt: Date.now(),
        })
        .where(eq(services.id, id))
        .returning()
        .get();
      if (input.jewelryIds) setCompatibleJewelry(tx, id, input.jewelryIds);
      if (input.consumables) setConsumptionNorms(tx, id, input.consumables);
      return serializeService(tx, row);
    });
  });

  app.post('/services/:id/image/generate', async (request) => {
    const { id } = parse(idParams, request.params);
    const input = parse(generateBody, request.body);
    const service = getService(db, id);
    if (generating.has(id)) throw conflict('Картинка для этой услуги уже генерируется — подождите пару минут');
    // Absent prompt = reuse the saved one; "" / null = reset to the name and description.
    const saved = input.prompt === undefined ? service.imagePrompt : null;
    const subject = input.prompt ?? saved ?? defaultImageSubject(service);
    generating.add(id);
    let image: GeneratedImage;
    try {
      image = await runGenerator(ctx, request.log, serviceImagePrompt(subject));
    } finally {
      generating.delete(id);
    }
    const ext = sniffImage(image.data);
    if (!ext) throw upstreamError('Сервис генерации вернул файл, который не является картинкой');
    const name = `${randomUUID()}.${ext}`;
    await fs.writeFile(path.join(uploadsDir(ctx), name), image.data, { mode: 0o644 });
    request.log.info(
      { serviceId: id, file: name, bytes: image.data.length, costRub: image.costRub, model: ctx.config.ai.imageModel },
      'service image generated',
    );
    // Only the picture (and an explicitly sent prompt): fields edited during the generation are kept.
    const row = db
      .update(services)
      .set({
        imageUrl: `/uploads/${name}`,
        ...(input.prompt === undefined ? {} : { imagePrompt: input.prompt }),
        updatedAt: Date.now(),
      })
      .where(eq(services.id, id))
      .returning()
      .get();
    if (!row) throw notFound('Услуга не найдена');
    return serializeService(db, row);
  });

  app.get('/aftercare-templates', async () => {
    const rows = db.select().from(aftercareTemplates).orderBy(asc(aftercareTemplates.category), asc(aftercareTemplates.name)).all();
    return { items: rows.map(templateOut) };
  });

  app.post('/aftercare-templates', async (request) => {
    const input = parse(templateCreate, request.body);
    const now = Date.now();
    const row = db
      .insert(aftercareTemplates)
      .values({ name: input.name, category: input.category, stepsJson: JSON.stringify(input.steps), createdAt: now, updatedAt: now })
      .returning()
      .get();
    return templateOut(row);
  });

  app.patch('/aftercare-templates/:id', async (request) => {
    const { id } = parse(idParams, request.params);
    const input = parse(templatePatch, request.body);
    const current = db.select().from(aftercareTemplates).where(eq(aftercareTemplates.id, id)).get();
    if (!current) throw notFound('Памятка не найдена');
    const row = db
      .update(aftercareTemplates)
      .set({
        name: input.name ?? current.name,
        category: input.category ?? current.category,
        stepsJson: input.steps ? JSON.stringify(input.steps) : current.stepsJson,
        updatedAt: Date.now(),
      })
      .where(eq(aftercareTemplates.id, id))
      .returning()
      .get();
    return templateOut(row);
  });

  app.delete('/aftercare-templates/:id', async (request, reply) => {
    const { id } = parse(idParams, request.params);
    db.transaction((tx) => {
      const current = tx.select().from(aftercareTemplates).where(eq(aftercareTemplates.id, id)).get();
      if (!current) throw notFound('Памятка не найдена');
      tx.update(services).set({ aftercareTemplateId: null, updatedAt: Date.now() }).where(eq(services.aftercareTemplateId, id)).run();
      tx.delete(aftercareTemplates).where(eq(aftercareTemplates.id, id)).run();
    });
    return reply.code(204).send();
  });
}
