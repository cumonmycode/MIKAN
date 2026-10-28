import { and, asc, count, eq, gt, gte } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { aiUsage, botMessages, clients } from '../db/schema.js';
import { noteAiOutcome } from '../domain/alerts.js';
import { chatEmployee, findChat, storeMessage, updateChatFlags, upsertChat } from '../domain/bot-chats.js';
import { getBotSettings, studioTimezone } from '../domain/settings.js';
import { AppError, conflict, errorMessage } from '../lib/errors.js';
import type { BotChatRow, BotMessageRow, ProductRow, ServiceRow } from '../lib/serialize.js';
import { truncate } from '../lib/text.js';
import { HOUR_MS, localDayBounds } from '../lib/time.js';
import { clientMessagePush } from '../push/staff-events.js';
import { runAi, type AiRunInput, type AiRunResult } from './ai.js';
import { jewelryPage, sendPage } from './catalog.js';
import type { PhotoSource } from './gateway.js';
import { PHONE_KEYBOARD } from './keyboards.js';
import { productCaption, sizesInStock } from './jewelry.js';
import { photoMessageText, photoSourceFor, serviceCaption, servicePhotoSource } from './media.js';
import { CONTACT_NOTE, PHONE_REQUIRED } from './onboarding.js';
import { buildClientContext, buildHistory, buildStablePrompt, buildSystem, type PendingImage } from './prompt.js';
import { clientLabel, notifyStaff } from './staff.js';
import { buildStaffContext, buildStaffStablePrompt } from './staff-prompt.js';
import { buildStaffToolHandlers, STAFF_TOOLS } from './staff-tools.js';
import { runClientAiTest } from './test-mode.js';
import { buildToolHandlers, emptySink, TOOLS } from './tools.js';

export const REPLIES = {
  unavailable: 'Спасибо за сообщение! Администратор скоро ответит вам здесь 🙌',
  limit: 'Спасибо за сообщение! Сейчас я не могу ответить сам, но администратор скоро подключится 🙌',
  error: 'Извините, сейчас не получается ответить автоматически. Я передал ваш вопрос администратору — он скоро ответит 🙏',
  refusal: 'Извините, с этим вопросом я помочь не могу. Я передал его администратору — он скоро ответит 🙏',
  media: 'Голосовые и видео я пока не понимаю 🙏 Напишите, пожалуйста, вопрос текстом — или пришлите фото.',
  booked: 'Спасибо! Я передал заявку администратору — он свяжется с вами, чтобы подтвердить время 🙌',
  handedOff: 'Я передал ваш вопрос администратору — он скоро ответит здесь 🙏',
  rescheduled: 'Готово! Запись перенесена — напоминание придёт заранее 🙌',
  onlineBooked: 'Готово! Время за вами 🙌 Студия подтвердит запись в ближайшее время.',
  onlineBookedPay: 'Готово! Время за вами 🙌 Осталось внести предоплату — кнопка в следующем сообщении.',
  waitlisted: 'Готово! Вы в листе ожидания ⏳ Как только время освободится, напишу сюда.',
  cabinet: 'Вот ваш личный кабинет: записи, бонусы и памятки по уходу 👇',
  staffUnavailable: 'ИИ-помощник сейчас недоступен (выключен в настройках бота или исчерпан лимит ответов). Данные можно посмотреть в приложении MIKAN.',
  staffError: 'Не получилось подготовить ответ — попробуйте переформулировать вопрос или посмотрите данные в приложении MIKAN.',
};

const TYPING_INTERVAL_MS = 4500;

export interface IncomingFrom {
  chatId: number;
  telegramName: string | null;
  username: string | null;
}

function recordUsage(ctx: AppContext, chatId: number | null, result: AiRunResult): void {
  ctx.db
    .insert(aiUsage)
    .values({
      chatId,
      outcome: result.outcome,
      inputTokens: result.usage.input,
      outputTokens: result.usage.output,
      cacheReadTokens: result.usage.cacheRead,
      createdAt: Date.now(),
    })
    .run();
}

/** Limit 0 means "no limit". */
export function aiLimitReached(ctx: AppContext, chatId: number | null, now = Date.now()): boolean {
  const { dailyLimit, chatHourlyLimit } = ctx.config.ai;
  const day = localDayBounds(now, studioTimezone(ctx.db));
  const daily = ctx.db.select({ n: count() }).from(aiUsage).where(gte(aiUsage.createdAt, day.start)).get()?.n ?? 0;
  if (dailyLimit > 0 && daily >= dailyLimit) return true;
  if (chatId === null || chatHourlyLimit <= 0) return false;
  const hourly =
    ctx.db
      .select({ n: count() })
      .from(aiUsage)
      .where(and(eq(aiUsage.chatId, chatId), gt(aiUsage.createdAt, now - HOUR_MS)))
      .get()?.n ?? 0;
  return hourly >= chatHourlyLimit;
}

/** `/bot/test`: the same AI pipeline as an anonymous client, no Telegram side effects. */
export async function runTest(ctx: AppContext, text: string): Promise<string> {
  if (!ctx.ai) throw conflict('ИИ не настроен: укажите AI_API_KEY в настройках сервера');
  if (aiLimitReached(ctx, null)) throw conflict('Дневной лимит ИИ-ответов исчерпан — попробуйте завтра');
  const { result, sink } = await runClientAiTest(ctx, ctx.ai, {
    messages: [{ role: 'user', content: text }],
    client: null,
    chatId: null,
    note: 'Тестовый запуск из приложения студии.',
  });
  recordUsage(ctx, null, result);
  if (result.outcome === 'error') throw new AppError('internal', 'Не удалось получить ответ ИИ — подробности в логах сервера');
  let reply = result.outcome === 'ok' && result.text ? result.text : result.outcome === 'refusal' ? REPLIES.refusal : REPLIES.error;
  if (sink.notes.length) reply += `\n\n— Тест: ${sink.notes.join('; ')}`;
  return reply;
}

/** A photo attached to a client message; may still be downloading. */
export type ImageInput = PendingImage | Promise<PendingImage | undefined>;

const MAX_PENDING_IMAGES_PER_CHAT = 3;
const MAX_PENDING_IMAGES_TOTAL = 10;

/**
 * Handles client messages: stores them, then (debounced, one run at a time per chat) asks the AI
 * and delivers the reply. Failures never escape — they become a fallback reply + staff alert.
 */
export class BotPipeline {
  private readonly runs = new Map<number, Promise<void>>();
  private readonly dirty = new Set<number>();
  /** chatId → (messageId → image). Taken (removed) at the start of every run, whatever its outcome. */
  private readonly images = new Map<number, Map<number, Promise<PendingImage | undefined>>>();
  /** chatId → id of the newest user message already handed to a run. */
  private readonly handledUpTo = new Map<number, number>();

  constructor(
    private readonly ctx: AppContext,
    private readonly debounceMs = 1200,
  ) {}

  receive(from: IncomingFrom, text: string, image?: ImageInput): BotMessageRow {
    upsertChat(this.ctx.db, from.chatId, { telegramName: from.telegramName, username: from.username });
    this.pinBaseline(from.chatId);
    const message = storeMessage(this.ctx.db, from.chatId, 'user', text, { bumpUnread: true });
    if (image) this.addImage(from.chatId, message.id, Promise.resolve(image));
    this.schedule(from.chatId);
    return message;
  }

  /** Voice / video: stored for staff, answered with a request to write text (no AI call). */
  async receiveUnsupported(from: IncomingFrom, label: string): Promise<void> {
    await this.receiveHandled(from, label, REPLIES.media);
  }

  /**
   * A message answered without the AI (catalog buttons, «✅ Приду», voice): stored for staff, then `answer` — a text
   * reply, or a function that sends the answer itself (a catalog) — is delivered.
   */
  async receiveHandled(from: IncomingFrom, text: string, answer: string | (() => Promise<unknown>)): Promise<void> {
    upsertChat(this.ctx.db, from.chatId, { telegramName: from.telegramName, username: from.username });
    this.pinBaseline(from.chatId);
    const nothingPending = this.unhandledUserMessages(from.chatId).length === 0;
    const message = storeMessage(this.ctx.db, from.chatId, 'user', text, { bumpUnread: true });
    // Answered right here, so a later AI run must not treat it as a fresh question.
    if (nothingPending) this.handledUpTo.set(from.chatId, message.id);
    if (typeof answer === 'string') await this.deliver(from.chatId, answer);
    else await answer();
  }

  /**
   * A chat that has not shared its phone yet: the message is kept for staff and left unanswered (the AI answers it
   * once the phone is shared, see `answerPending`); the bot only asks for the phone — no AI call.
   */
  async receiveWithoutPhone(from: IncomingFrom, text: string): Promise<void> {
    upsertChat(this.ctx.db, from.chatId, { telegramName: from.telegramName, username: from.username });
    this.pinBaseline(from.chatId);
    storeMessage(this.ctx.db, from.chatId, 'user', text, { bumpUnread: true });
    try {
      await this.ctx.gateway.sendText(from.chatId, PHONE_REQUIRED, { replyKeyboard: PHONE_KEYBOARD });
      storeMessage(this.ctx.db, from.chatId, 'assistant', PHONE_REQUIRED);
    } catch (err) {
      this.ctx.log.warn({ chatId: from.chatId, err: errorMessage(err) }, 'failed to ask for the phone');
    }
  }

  /**
   * After a chat shared its phone: answers what it asked before that, if anything. Returns the run that answers it
   * (it never rejects), or null when there was nothing to answer.
   */
  answerPending(chatId: number): Promise<void> | null {
    this.pinBaseline(chatId);
    if (!this.unhandledUserMessages(chatId).some((m) => !m.text.startsWith(CONTACT_NOTE))) return null;
    this.schedule(chatId);
    return this.runs.get(chatId) ?? null;
  }

  /** Resolves when all queued work has finished (tests, graceful shutdown). */
  async idle(): Promise<void> {
    while (this.runs.size > 0) await Promise.allSettled([...this.runs.values()]);
  }

  /** Number of images currently held in memory (for tests/diagnostics). */
  pendingImageCount(): number {
    let n = 0;
    for (const perChat of this.images.values()) n += perChat.size;
    return n;
  }

  private addImage(chatId: number, messageId: number, image: Promise<PendingImage | undefined>): void {
    const perChat = this.images.get(chatId) ?? new Map<number, Promise<PendingImage | undefined>>();
    perChat.set(messageId, image);
    this.images.set(chatId, perChat);
    while (perChat.size > MAX_PENDING_IMAGES_PER_CHAT) perChat.delete(perChat.keys().next().value!);
    while (this.pendingImageCount() > MAX_PENDING_IMAGES_TOTAL) {
      const [oldestChat, oldest] = [...this.images.entries()].find(([, m]) => m.size > 0)!;
      oldest.delete(oldest.keys().next().value!);
      if (oldest.size === 0) this.images.delete(oldestChat);
    }
  }

  /** Removes and resolves the images of messages up to `upToId`. */
  private async takeImages(chatId: number, upToId: number): Promise<Map<number, PendingImage>> {
    const perChat = this.images.get(chatId);
    const taken = new Map<number, Promise<PendingImage | undefined>>();
    for (const [id, image] of perChat ?? []) {
      if (id <= upToId) {
        taken.set(id, image);
        perChat!.delete(id);
      }
    }
    if (perChat && perChat.size === 0) this.images.delete(chatId);
    const resolved = new Map<number, PendingImage>();
    for (const [id, image] of taken) {
      const value = await image.catch(() => undefined);
      if (value) resolved.set(id, value);
    }
    return resolved;
  }

  /**
   * After a restart, fixes what counts as answered before a new message arrives: a catalog the client opens with a
   * button while their text waits out the debounce must not make that text look answered.
   */
  private pinBaseline(chatId: number): void {
    if (!this.handledUpTo.has(chatId)) this.handledUpTo.set(chatId, this.answeredInDb(chatId));
  }

  /** Newest user message already answered according to the DB (used after a restart). */
  private answeredInDb(chatId: number): number {
    const row = this.ctx.sqlite
      .prepare(
        `select max(u.id) as id from bot_messages u where u.chat_id = ? and u.role = 'user'
         and exists (select 1 from bot_messages m where m.chat_id = u.chat_id and m.role <> 'user' and m.id > u.id)`,
      )
      .get(chatId) as { id: number | null } | undefined;
    return row?.id ?? 0;
  }

  private unhandledUserMessages(chatId: number): BotMessageRow[] {
    const after = this.handledUpTo.get(chatId) ?? this.answeredInDb(chatId);
    return this.ctx.db
      .select()
      .from(botMessages)
      .where(and(eq(botMessages.chatId, chatId), eq(botMessages.role, 'user'), gt(botMessages.id, after)))
      .orderBy(asc(botMessages.id))
      .all();
  }

  private schedule(chatId: number): void {
    this.dirty.add(chatId);
    if (this.runs.has(chatId)) return;
    const run = (async () => {
      if (this.debounceMs > 0) await new Promise((r) => setTimeout(r, this.debounceMs));
      while (this.dirty.delete(chatId)) {
        try {
          await this.process(chatId);
        } catch (err) {
          this.ctx.log.error({ chatId, err: errorMessage(err) }, 'bot pipeline failed');
          await this.escalate(chatId, 'внутренняя ошибка бота').catch(() => undefined);
        }
      }
    })().finally(() => this.runs.delete(chatId));
    this.runs.set(chatId, run);
  }

  private async process(chatId: number): Promise<void> {
    const { ctx } = this;
    const chat = findChat(ctx.db, chatId);
    if (!chat) return;
    const seenUpTo = this.handledUpTo.get(chatId) ?? this.answeredInDb(chatId);
    const unseen = this.unhandledUserMessages(chatId);
    const last = unseen[unseen.length - 1];
    if (!last) return;
    // Mark before any await: messages arriving during this run are picked up by the next pass.
    this.handledUpTo.set(chatId, last.id);
    const images = await this.takeImages(chatId, last.id);
    const who = clientLabel(chat.telegramName, chat.username);
    // Staff mode only while the recognised employee is active (checked on every message).
    const employee = chatEmployee(ctx.db, chat);

    if (chat.aiPaused) {
      if (!employee) await notifyStaff(ctx, `💬 ${who} (ИИ на паузе): «${truncate(last.text, 500)}»\nОтветьте в приложении MIKAN.`);
      return;
    }
    if (!ctx.ai || !getBotSettings(ctx.db).aiEnabled) {
      if (employee) await this.deliver(chatId, REPLIES.staffUnavailable);
      else await this.fallback(chat, last, REPLIES.unavailable, 'ИИ-ответы отключены', true);
      return;
    }
    if (aiLimitReached(ctx, chatId)) {
      if (employee) await this.deliver(chatId, REPLIES.staffUnavailable);
      else await this.fallback(chat, last, REPLIES.limit, 'достигнут лимит ИИ-ответов', true);
      return;
    }

    const now = Date.now();
    const sink = emptySink();
    let setup: Pick<AiRunInput, 'system' | 'tools' | 'handlers'>;
    if (employee) {
      setup = {
        system: buildSystem(buildStaffStablePrompt(ctx.db), buildStaffContext(ctx.db, now, employee)),
        tools: STAFF_TOOLS,
        handlers: buildStaffToolHandlers(ctx, employee),
      };
    } else {
      const client = chat.clientId != null ? (ctx.db.select().from(clients).where(eq(clients.id, chat.clientId)).get() ?? null) : null;
      const scope = {
        mode: 'live' as const,
        chatId,
        clientId: client?.id ?? null,
        telegramName: chat.telegramName,
        username: chat.username,
        lastUserText: unseen.map((m) => m.text).join('\n'),
      };
      setup = {
        system: buildSystem(buildStablePrompt(ctx.db), buildClientContext(ctx.db, now, client, chat.telegramName)),
        tools: TOOLS,
        handlers: buildToolHandlers(ctx, scope, sink),
      };
    }
    const stopTyping = this.keepTyping(chatId);
    let result: AiRunResult;
    try {
      result = await runAi(ctx.ai, { ...setup, messages: buildHistory(ctx.db, chatId, images, seenUpTo) }, ctx.log);
    } finally {
      stopTyping();
    }
    recordUsage(ctx, chatId, result);
    await noteAiOutcome(ctx, result);

    // The model may finish with no text after a successful action — confirm the action instead of an error.
    const confirmation = result.outcome !== 'ok' ? '' :
      sink.done.has('online_booking') ? (sink.after.length ? REPLIES.onlineBookedPay : REPLIES.onlineBooked) :
      sink.done.has('booking') ? REPLIES.booked : sink.done.has('handoff') ? REPLIES.handedOff : sink.done.has('reschedule') ? REPLIES.rescheduled :
      sink.done.has('waitlist') ? REPLIES.waitlisted : sink.done.has('cabinet') ? REPLIES.cabinet : '';
    const text = result.text || confirmation;
    const pictures = sink.products.length + sink.services.length + sink.portfolio.length + sink.carousels.length;
    if (result.outcome === 'ok' && (text || pictures > 0)) {
      if (text && !(await this.deliver(chatId, text))) {
        if (!employee) await this.escalate(chatId, 'не удалось доставить ответ бота в Telegram', last);
        return;
      }
      for (const send of sink.after) await send();
      for (const service of sink.services) await this.sendService(chatId, service);
      for (const product of sink.products) await this.sendProduct(chatId, product);
      for (const shot of sink.portfolio) await this.sendPicture(chatId, shot.source, shot.caption, { portfolioPhotoId: shot.id });
      for (const list of sink.carousels) {
        const page = jewelryPage(ctx.db, ctx.config.dataDir, list, 0);
        if (page) await sendPage(ctx, chatId, page);
      }
      if (result.loopCapped && !employee) await this.escalate(chatId, 'бот не завершил обработку запроса (слишком много шагов)', last);
      return;
    }
    if (employee) {
      await this.deliver(chatId, REPLIES.staffError);
      return;
    }
    // A booking made before the AI failed still needs its payment request.
    for (const send of sink.after) await send();
    const reason =
      result.outcome === 'refusal'
        ? 'ИИ отказался отвечать на сообщение'
        : result.outcome === 'max_tokens'
          ? 'ответ ИИ оборвался (лимит длины)'
          : `ошибка ИИ (${truncate(result.error ?? 'пустой ответ', 200)})`;
    await this.fallback(chat, last, result.outcome === 'refusal' ? REPLIES.refusal : REPLIES.error, reason, false);
  }

  private async fallback(chat: BotChatRow, last: BotMessageRow, text: string, reason: string, once: boolean): Promise<void> {
    if (once && chat.needsAttention) return;
    await this.deliver(chat.chatId, text);
    await this.escalate(chat.chatId, reason, last);
  }

  /** Flags the chat for staff and sends an alert to the staff chat. */
  private async escalate(chatId: number, reason: string, last?: BotMessageRow): Promise<void> {
    const chat = findChat(this.ctx.db, chatId);
    if (!chat || chatEmployee(this.ctx.db, chat)) return; // staff chats are not handed to staff
    const flagged = updateChatFlags(this.ctx.db, chatId, { needsAttention: true });
    await notifyStaff(
      this.ctx,
      `⚠️ Бот не ответил клиенту ${clientLabel(chat.telegramName, chat.username)}: ${reason}.\n` +
        (last ? `Последнее сообщение: «${truncate(last.text, 500)}»\n` : '') +
        'Ответьте в приложении MIKAN.',
      () => clientMessagePush(this.ctx.db, flagged, last?.text ?? reason),
    );
  }

  /** Sends text to the client and stores it as an assistant message. Returns false if not delivered. */
  private async deliver(chatId: number, text: string): Promise<boolean> {
    try {
      await this.ctx.gateway.sendText(chatId, text);
      storeMessage(this.ctx.db, chatId, 'assistant', text);
      return true;
    } catch (err) {
      this.ctx.log.warn({ chatId, err: errorMessage(err) }, 'failed to deliver bot reply');
      return false;
    }
  }

  private async sendProduct(chatId: number, product: ProductRow): Promise<void> {
    const source = photoSourceFor(this.ctx.config.dataDir, product.photoUrl);
    await this.sendPicture(chatId, source, productCaption(product, sizesInStock(this.ctx.db, product.id)), { productId: product.id });
  }

  private async sendService(chatId: number, service: ServiceRow): Promise<void> {
    const source = servicePhotoSource(this.ctx.config.dataDir, service);
    await this.sendPicture(chatId, source, serviceCaption(service), { serviceId: service.id });
  }

  /** Sends a captioned picture (or just the caption when there is none / it fails) and stores it in the chat. */
  private async sendPicture(chatId: number, source: PhotoSource | null, caption: string, ref: Record<string, number>): Promise<void> {
    try {
      if (source) await this.ctx.gateway.sendPhoto(chatId, source, caption);
      else await this.ctx.gateway.sendText(chatId, caption);
      storeMessage(this.ctx.db, chatId, 'assistant', source ? photoMessageText(caption) : caption);
    } catch (err) {
      this.ctx.log.warn({ chatId, ...ref, err: errorMessage(err) }, 'failed to send photo');
      await this.deliver(chatId, caption);
    }
  }

  private keepTyping(chatId: number): () => void {
    const tick = () => void this.ctx.gateway.sendTyping(chatId).catch(() => undefined);
    tick();
    const timer = setInterval(tick, TYPING_INTERVAL_MS);
    return () => clearInterval(timer);
  }
}
