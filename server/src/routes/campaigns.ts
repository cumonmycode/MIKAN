import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { forGroupChat, MARKETING_BUTTONS, newsKeyboard, personalize, sendNews } from '../bot/marketing.js';
import type { AppContext } from '../context.js';
import type { DbOrTx } from '../db/client.js';
import { botChats } from '../db/schema.js';
import { previewSegment, segmentSchema } from '../domain/campaign-segment.js';
import {
  assertEditable,
  cancelCampaign,
  createCampaign,
  deleteCampaign,
  getCampaignRow,
  listCampaigns,
  mergedCampaign,
  parseButton,
  scheduleCampaign,
  serializeCampaign,
  serializeCampaigns,
  startCampaign,
  updateCampaign,
  type CampaignButton,
} from '../domain/campaigns.js';
import { getStaffChatId, studioTimezone } from '../domain/settings.js';
import { badRequest, conflict, errorMessage, upstreamError } from '../lib/errors.js';
import { formatAmount, TELEGRAM_MAX_CAPTION } from '../lib/text.js';
import { DAY_MS } from '../lib/time.js';
import { idParams, instant, nonNull, nullableText, parse, requiredText } from '../lib/validation.js';

/** Telegram campaigns (docs/API.md «Campaigns»); owner and admin only (see domain/permissions.ts). */

const MAX_CAMPAIGN_TEXT = 3500;
const MAX_BUTTON_TEXT = 64;
/** A campaign is scheduled at most this far ahead. */
const MAX_SCHEDULE_AHEAD_MS = 366 * DAY_MS;
const BOT_OFFLINE = 'Telegram-бот не запущен — проверьте настройки бота';
const HTTPS = /^https:\/\/\S+$/i;

const imageUrl = nullableText(500).refine((v) => v == null || v.startsWith('/uploads/') || HTTPS.test(v), {
  message: 'загрузите картинку или укажите ссылку https://…',
});

/** `undefined` — unchanged (PATCH), `null` — no button. */
const button = z
  .object({
    text: z.string().trim().max(MAX_BUTTON_TEXT).nullish(),
    kind: z.enum(['book', 'url']),
    url: z.string().trim().max(2000).nullish(),
  })
  .nullish()
  .transform((b, ctx): CampaignButton | null | undefined => {
    if (b == null) return b;
    if (b.kind === 'book') return { text: b.text || MARKETING_BUTTONS.book, kind: 'book', url: null };
    if (!b.text) ctx.addIssue({ code: 'custom', message: 'укажите текст кнопки' });
    if (!b.url || !HTTPS.test(b.url)) ctx.addIssue({ code: 'custom', message: 'укажите ссылку, начинающуюся с https://' });
    return { text: b.text ?? '', kind: 'url', url: b.url ?? null };
  });

const text = requiredText(MAX_CAMPAIGN_TEXT);
const title = requiredText(200);

const createBody = z.object({ title, text, imageUrl, button, segment: segmentSchema });
const patchBody = z.object({ title: nonNull(title), text: nonNull(text), imageUrl, button, segment: nonNull(segmentSchema) });
const previewBody = z.object({ segment: segmentSchema });
const sendBody = z.object({ at: instant.nullish() });

/** With a picture the text is its caption, and Telegram caps captions. */
function assertCaption(campaign: { text: string; imageUrl: string | null | undefined }): void {
  if (campaign.imageUrl && campaign.text.length > TELEGRAM_MAX_CAPTION) {
    throw badRequest(`«Текст»: с картинкой — не длиннее ${formatAmount(TELEGRAM_MAX_CAPTION)} символов (это подпись к фото)`);
  }
}

/** Where a test goes: the employee's own staff chat with the bot, else the studio's staff group. */
function testChatOf(db: DbOrTx, employeeId: number): number | null {
  const own = db.select({ chatId: botChats.chatId }).from(botChats).where(eq(botChats.employeeId, employeeId)).orderBy(desc(botChats.updatedAt)).get();
  return own?.chatId ?? getStaffChatId(db);
}

export function campaignRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  app.get('/campaigns', async () => ({ items: serializeCampaigns(db, listCampaigns(db)) }));

  app.get('/campaigns/:id', async (request) => {
    const { id } = parse(idParams, request.params);
    return serializeCampaign(db, getCampaignRow(db, id));
  });

  app.post('/campaigns', async (request) => {
    const input = parse(createBody, request.body);
    assertCaption(input);
    return serializeCampaign(db, createCampaign(db, { ...input, imageUrl: input.imageUrl ?? null, button: input.button ?? null }, request.employee.id));
  });

  app.patch('/campaigns/:id', async (request) => {
    const { id } = parse(idParams, request.params);
    const patch = parse(patchBody, request.body);
    const row = getCampaignRow(db, id);
    assertEditable(row);
    assertCaption(mergedCampaign(row, patch));
    return serializeCampaign(db, updateCampaign(db, id, patch));
  });

  app.post('/campaigns/preview', async (request) => {
    const { segment } = parse(previewBody, request.body);
    return previewSegment(db, segment, Date.now(), studioTimezone(db));
  });

  app.post('/campaigns/:id/test', async (request) => {
    const { id } = parse(idParams, request.params);
    const campaign = getCampaignRow(db, id);
    const chatId = testChatOf(db, request.employee.id);
    if (chatId === null) {
      throw conflict('Некуда отправить тест: поделитесь своим номером с ботом в Telegram или привяжите рабочий чат командой /staff');
    }
    if (!ctx.gateway.isRunning()) throw conflict(BOT_OFFLINE);
    const keyboard = newsKeyboard(ctx, parseButton(campaign.button));
    try {
      await sendNews(ctx, chatId, {
        text: personalize(campaign.text, request.employee.name),
        imageUrl: campaign.imageUrl,
        keyboard: chatId < 0 ? forGroupChat(keyboard) : keyboard,
      });
    } catch (err) {
      throw upstreamError(`Telegram не принял тестовое сообщение: ${errorMessage(err)}`);
    }
    return { sent: true };
  });

  app.post('/campaigns/:id/send', async (request) => {
    const { id } = parse(idParams, request.params);
    const { at } = parse(sendBody, request.body);
    const now = Date.now();
    if (at != null && at > now) {
      if (at > now + MAX_SCHEDULE_AHEAD_MS) throw badRequest('«Время отправки»: не дальше чем через год');
      return serializeCampaign(db, scheduleCampaign(db, id, at, now));
    }
    getCampaignRow(db, id);
    if (!ctx.gateway.isRunning()) throw conflict(BOT_OFFLINE);
    return serializeCampaign(db, startCampaign(db, id, now, studioTimezone(db), 'staff').row);
  });

  app.post('/campaigns/:id/cancel', async (request) => {
    const { id } = parse(idParams, request.params);
    return serializeCampaign(db, cancelCampaign(db, id));
  });

  app.delete('/campaigns/:id', async (request, reply) => {
    const { id } = parse(idParams, request.params);
    deleteCampaign(db, id);
    return reply.code(204).send();
  });
}
