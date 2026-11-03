import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BotSendError, BotUnavailableError } from '../bot/gateway.js';
import { bindChatToEmployee } from '../bot/onboarding.js';
import { runTest } from '../bot/pipeline.js';
import { issueStaffCode } from '../bot/staff.js';
import type { AppContext } from '../context.js';
import { bookingRequests, employees, knowledgeEntries, scheduledMessages } from '../db/schema.js';
import {
  getChat,
  listBookings,
  listChats,
  listScheduled,
  pageMessages,
  serializeBookings,
  serializeChat,
  serializeMessages,
  serializeScheduled,
  setChatEmployee,
  storeMessage,
  updateChatFlags,
} from '../domain/bot-chats.js';
import { readChatPhoto } from '../domain/chat-photos.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import { knowledgeOut } from '../lib/serialize.js';
import { toIso } from '../lib/time.js';
import { idParams, nonNull, parse, requiredText } from '../lib/validation.js';

const chatParams = z.object({ chatId: z.coerce.number().int() });
const messagesQuery = z.object({
  beforeId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const knowledgeCreate = z.object({
  title: requiredText(200),
  content: requiredText(10_000),
  active: nonNull(z.boolean()),
  sort: nonNull(z.number().int().min(-100_000).max(100_000)),
});
const knowledgePatch = z.object({
  title: nonNull(requiredText(200)),
  content: nonNull(requiredText(10_000)),
  active: nonNull(z.boolean()),
  sort: nonNull(z.number().int().min(-100_000).max(100_000)),
});

export function botRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  app.get('/bot/chats', async () => ({ items: listChats(db) }));

  app.get('/bot/chats/:chatId/messages', async (request) => {
    const { chatId } = parse(chatParams, request.params);
    const q = parse(messagesQuery, request.query);
    getChat(db, chatId);
    return { items: serializeMessages(db, pageMessages(db, chatId, q.beforeId, q.limit)) };
  });

  app.get('/bot/photos/:file', async (request, reply) => {
    const { file } = parse(z.object({ file: z.string() }), request.params);
    const photo = await readChatPhoto(ctx.config.dataDir, file);
    if (!photo) throw notFound('Фото не найдено');
    // no-store: URLSession would otherwise keep a copy on the employee's phone, past sign-out.
    return reply.header('Cache-Control', 'private, no-store').type(photo.mediaType).send(photo.data);
  });

  app.post('/bot/chats/:chatId/messages', async (request) => {
    const { chatId } = parse(chatParams, request.params);
    const { text } = parse(z.object({ text: requiredText(4000) }), request.body);
    getChat(db, chatId);
    if (!ctx.gateway.isRunning()) {
      throw conflict('Telegram-бот выключен — сообщение не может быть доставлено. Включите бота в настройках.');
    }
    try {
      await ctx.gateway.sendText(chatId, text);
    } catch (err) {
      if (err instanceof BotUnavailableError) throw conflict('Telegram-бот выключен — сообщение не может быть доставлено.');
      if (err instanceof BotSendError && err.blocked) throw conflict('Клиент заблокировал бота — сообщение не доставлено');
      request.log.error({ err }, 'staff message delivery failed');
      throw new AppError('internal', 'Не удалось отправить сообщение в Telegram. Попробуйте ещё раз.');
    }
    const message = storeMessage(db, chatId, 'staff', text, { employeeId: request.employee.id });
    updateChatFlags(db, chatId, { needsAttention: false });
    return serializeMessages(db, [message])[0];
  });

  app.post('/bot/chats/:chatId/read', async (request, reply) => {
    const { chatId } = parse(chatParams, request.params);
    updateChatFlags(db, chatId, { unreadCount: 0, needsAttention: false });
    return reply.code(204).send();
  });

  app.patch('/bot/chats/:chatId', async (request) => {
    const { chatId } = parse(chatParams, request.params);
    const input = parse(z.object({ aiPaused: nonNull(z.boolean()) }), request.body);
    getChat(db, chatId);
    const row = input.aiPaused === undefined ? getChat(db, chatId) : updateChatFlags(db, chatId, { aiPaused: input.aiPaused });
    return serializeChat(db, row);
  });

  // Ordinary chat → staff chat of an active employee, for employees who never shared their phone with the bot.
  app.put('/bot/chats/:chatId/employee', async (request) => {
    const { chatId } = parse(chatParams, request.params);
    const { employeeId } = parse(z.object({ employeeId: z.number().int().positive() }), request.body);
    getChat(db, chatId);
    const employee = db.select().from(employees).where(eq(employees.id, employeeId)).get();
    if (!employee?.active) throw badRequest('Сотрудник не найден или отключён');
    return serializeChat(db, await bindChatToEmployee(ctx, chatId, employee));
  });

  // Staff chat → ordinary client chat (the employee can share their phone again to get staff mode back).
  app.delete('/bot/chats/:chatId/employee', async (request, reply) => {
    const { chatId } = parse(chatParams, request.params);
    setChatEmployee(db, chatId, null);
    return reply.code(204).send();
  });

  app.get('/bot/scheduled', async (request) => {
    const q = parse(z.object({ status: z.enum(['pending', 'sent', 'failed', 'cancelled']).optional() }), request.query);
    return { items: listScheduled(db, q.status) };
  });

  app.post('/bot/scheduled/:id/cancel', async (request) => {
    const { id } = parse(idParams, request.params);
    const row = db.select().from(scheduledMessages).where(eq(scheduledMessages.id, id)).get();
    if (!row) throw notFound('Сообщение не найдено');
    if (row.status !== 'pending') throw conflict('Отменить можно только ожидающее отправки сообщение');
    const updated = db.update(scheduledMessages).set({ status: 'cancelled' }).where(eq(scheduledMessages.id, id)).returning().get();
    return serializeScheduled(db, [updated])[0];
  });

  app.post('/bot/staff-code', async () => {
    const { code, expiresAt } = issueStaffCode(db);
    const username = ctx.gateway.username();
    return {
      code,
      expiresAt: toIso(expiresAt),
      instruction: `Добавьте бота${username ? ` @${username}` : ''} в рабочий чат и отправьте: /staff ${code}`,
    };
  });

  app.post('/bot/test', async (request) => {
    const { text } = parse(z.object({ text: requiredText(4000) }), request.body);
    return { reply: await runTest(ctx, text) };
  });

  app.get('/booking-requests', async (request) => {
    const q = parse(z.object({ status: z.enum(['new', 'processed', 'rejected']).optional() }), request.query);
    return { items: listBookings(db, q.status) };
  });

  app.patch('/booking-requests/:id', async (request) => {
    const { id } = parse(idParams, request.params);
    const input = parse(z.object({ status: z.enum(['new', 'processed', 'rejected']) }), request.body);
    const row = db
      .update(bookingRequests)
      .set({ status: input.status, updatedAt: Date.now() })
      .where(eq(bookingRequests.id, id))
      .returning()
      .get();
    if (!row) throw notFound('Заявка не найдена');
    return serializeBookings(db, [row])[0];
  });

  app.get('/knowledge', async () => ({
    items: db.select().from(knowledgeEntries).orderBy(asc(knowledgeEntries.sort), asc(knowledgeEntries.id)).all().map(knowledgeOut),
  }));

  app.post('/knowledge', async (request) => {
    const input = parse(knowledgeCreate, request.body);
    const now = Date.now();
    const row = db
      .insert(knowledgeEntries)
      .values({ title: input.title, content: input.content, active: input.active ?? true, sort: input.sort ?? 0, createdAt: now, updatedAt: now })
      .returning()
      .get();
    return knowledgeOut(row);
  });

  app.patch('/knowledge/:id', async (request) => {
    const { id } = parse(idParams, request.params);
    const input = parse(knowledgePatch, request.body);
    const current = db.select().from(knowledgeEntries).where(eq(knowledgeEntries.id, id)).get();
    if (!current) throw notFound('Запись базы знаний не найдена');
    const row = db
      .update(knowledgeEntries)
      .set({
        title: input.title ?? current.title,
        content: input.content ?? current.content,
        active: input.active ?? current.active,
        sort: input.sort ?? current.sort,
        updatedAt: Date.now(),
      })
      .where(eq(knowledgeEntries.id, id))
      .returning()
      .get();
    return knowledgeOut(row);
  });

  app.delete('/knowledge/:id', async (request, reply) => {
    const { id } = parse(idParams, request.params);
    const result = db.delete(knowledgeEntries).where(eq(knowledgeEntries.id, id)).run();
    if (result.changes === 0) throw notFound('Запись базы знаний не найдена');
    return reply.code(204).send();
  });
}
