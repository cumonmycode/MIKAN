import { eq } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import type { DbOrTx } from '../db/client.js';
import { employees } from '../db/schema.js';
import { chatEmployee, findChat, getChat, setChatEmployee, storeMessage, upsertChat } from '../domain/bot-chats.js';
import { createClient, findClientByChat, findClientByLinkToken, findClientByPhone, linkTelegram } from '../domain/clients.js';
import { BOOKING_START_PREFIX } from '../domain/online-booking-links.js';
import { getBotSettings, getStudioSettings } from '../domain/settings.js';
import { WAITLIST_START_PREFIX, waitlistStartText } from '../domain/waitlist-messages.js';
import { errorMessage } from '../lib/errors.js';
import { isPlausiblePhone, normalizePhone } from '../lib/phone.js';
import { clientFullName, type BotChatRow, type EmployeeRow } from '../lib/serialize.js';
import { truncate } from '../lib/text.js';
import { bookingStartText } from './booking-start.js';
import { BUTTONS, STAFF_KEYBOARD } from './keyboards.js';
import type { IncomingFrom } from './pipeline.js';
import { bindStaffChat, notifyStaff } from './staff.js';

/** Appended to the /start greeting of a chat that is neither a client's nor an employee's yet. */
export const SHARE_PHONE_HINT =
  `Чтобы начать, нажмите «${BUTTONS.contact}» внизу 👇 Так я найду вас в нашей базе или запишу как нового клиента. ` +
  'Сотрудников студии узнаю по номеру из профиля в MIKAN.';

/** Marks the shared contact in the chat history. */
export const CONTACT_NOTE = '[Контакт]';

/** The answer to anything a chat sends before it has shared its phone. */
export const PHONE_REQUIRED = `Чтобы я мог помочь, нажмите «${BUTTONS.contact}» внизу 👇 Это нужно сделать один раз.`;

/** A private chat must share its phone before the bot helps: true until it is a client's or an active employee's. */
export function needsPhone(db: DbOrTx, chatId: number): boolean {
  return findClientByChat(db, chatId) === null && chatEmployee(db, findChat(db, chatId)) === null;
}

/** Longest raw phone quoted in the note about an unreadable contact. */
const MAX_NOTE_PHONE = 40;

export interface OnboardingReply {
  text: string;
  /** Whether the chat is linked to a client (controls the "share phone" button). */
  linked: boolean;
  /** The chat belongs to a recognised employee: the staff keyboard is shown. */
  staff?: boolean;
  /** The shared phone or `/start c<token>` linked the chat to a card just now (the bot may ask for the birthday). */
  cardLinked?: boolean;
}

/** An active employee whose phone (normalized) is `phone`. */
export function findActiveEmployeeByPhone(db: DbOrTx, phone: string): EmployeeRow | null {
  return (
    db
      .select()
      .from(employees)
      .where(eq(employees.active, true))
      .all()
      .find((e) => e.phone != null && normalizePhone(e.phone) === phone) ?? null
  );
}

export const staffGreeting = (studioName: string, employee: EmployeeRow): string =>
  `Здравствуйте, ${employee.name}! Узнал вас — вы сотрудник ${studioName} ✅\n` +
  'Спрашивайте про записи, клиентов, выручку и склад — например: «Что у нас сегодня?» или «Выручка за неделю».';

export interface SharedContact {
  userId: number | undefined;
  phone: string;
  firstName: string;
  lastName: string | undefined;
}

/**
 * `/start` (optionally with a `c<token>` deep-link payload from POST /clients/:id/telegram-link, `b_<token>` from
 * an online booking's page or `w_<id>` from the booking page after joining the waitlist).
 */
export function handleStart(ctx: AppContext, from: IncomingFrom, payload: string): OnboardingReply {
  const { db } = ctx;
  const greeting = getBotSettings(db).greeting;
  upsertChat(db, from.chatId, { telegramName: from.telegramName, username: from.username });
  let text = greeting;
  let cardLinked = false;
  const token = payload.trim();
  const bookingLink = token.startsWith(BOOKING_START_PREFIX) && token.length > BOOKING_START_PREFIX.length;
  const waitlistLink = token.startsWith(WAITLIST_START_PREFIX) && token.length > WAITLIST_START_PREFIX.length;
  if (waitlistLink) {
    text = waitlistStartText(db, from.chatId, token.slice(WAITLIST_START_PREFIX.length));
  } else if (bookingLink) {
    text =
      bookingStartText(ctx, from, token.slice(BOOKING_START_PREFIX.length)) ??
      `Не нашёл эту запись — возможно, ссылка устарела.\n\n${greeting}`;
  } else if (token.startsWith('c') && token.length > 1) {
    const client = findClientByLinkToken(db, token.slice(1));
    if (client) {
      linkTelegram(db, client.id, from.chatId, from.username);
      cardLinked = true;
      text =
        `${client.name}, ваш Telegram подключён к ${getStudioSettings(db).name} ✅\n` +
        'Сюда будут приходить напоминания о записях и рекомендации по уходу после процедур. ' +
        'Если появятся вопросы — просто напишите мне.';
    } else {
      text = `Ссылка для подключения устарела или уже использована — попросите администратора прислать новую.\n\n${greeting}`;
    }
  }
  const employee = chatEmployee(db, findChat(db, from.chatId));
  if (employee && !bookingLink && !waitlistLink && !(token.startsWith('c') && token.length > 1)) {
    text = staffGreeting(getStudioSettings(db).name, employee);
  }
  const linked = findClientByChat(db, from.chatId) !== null;
  // Telegram never tells a bot the user's phone: ask for it, or employees go on chatting unrecognised, as clients.
  if (!linked && !employee) text = `${text}\n\n${SHARE_PHONE_HINT}`;
  storeMessage(db, from.chatId, 'system', text);
  return { text, linked, ...(employee ? { staff: true } : {}), ...(cardLinked ? { cardLinked: true } : {}) };
}

/**
 * A contact shared via the keyboard button. Only the sender's own contact counts (a forwarded card has another
 * `user_id`). The phone of an active employee turns the chat into a staff chat; any other phone links the chat to the
 * client with that phone, or creates one.
 */
export async function handleContact(
  ctx: AppContext,
  from: IncomingFrom & { userId: number },
  contact: SharedContact,
): Promise<OnboardingReply> {
  const { db } = ctx;
  upsertChat(db, from.chatId, { telegramName: from.telegramName, username: from.username });
  const linkedNow = () => findClientByChat(db, from.chatId) !== null;
  const phone = normalizePhone(contact.phone);
  // Refusals leave a note in the chat history, so staff can see that the person tried.
  if (contact.userId !== from.userId) {
    storeMessage(
      db,
      from.chatId,
      'system',
      `Контакт не принят: прислана чужая карточка контакта${phone ? ` (${phone})` : ''}, а не свой номер. ` +
        `Бот попросил поделиться своим номером кнопкой «${BUTTONS.contact}».`,
    );
    return { text: `Пожалуйста, поделитесь своим номером с помощью кнопки «${BUTTONS.contact}» ниже.`, linked: linkedNow() };
  }
  if (!phone || !isPlausiblePhone(phone)) {
    storeMessage(
      db,
      from.chatId,
      'system',
      `Контакт не принят: не удалось распознать номер «${truncate(contact.phone, MAX_NOTE_PHONE)}». Бот попросил написать номер сообщением.`,
    );
    return { text: 'Не получилось распознать номер. Напишите его, пожалуйста, сообщением.', linked: linkedNow() };
  }
  storeMessage(db, from.chatId, 'user', `${CONTACT_NOTE} ${phone}`);
  const employee = findActiveEmployeeByPhone(db, phone);
  if (employee) {
    const wasStaff = findChat(db, from.chatId)?.employeeId === employee.id;
    setChatEmployee(db, from.chatId, employee.id);
    const text = staffGreeting(getStudioSettings(db).name, employee);
    storeMessage(db, from.chatId, 'system', text);
    if (!wasStaff) {
      await notifyStaff(ctx, `🔑 ${employee.name} подключил(а) Telegram к боту как сотрудник${from.username ? ` (@${from.username})` : ''}`);
    }
    return { text, linked: linkedNow(), staff: true };
  }
  // Another phone: the chat is a client's now (an employee who shares a client's number loses staff mode).
  if (findChat(db, from.chatId)?.employeeId != null) setChatEmployee(db, from.chatId, null);
  const existing = findClientByPhone(db, phone);
  let text: string;
  if (existing) {
    linkTelegram(db, existing.id, from.chatId, from.username);
    text = `Спасибо, ${existing.name}! Номер подтверждён ✅ Сюда будут приходить напоминания о записях и советы по уходу.`;
  } else {
    const firstName = contact.firstName.trim();
    const name = firstName || from.telegramName || 'Клиент из Telegram';
    const lastName = (firstName && contact.lastName?.trim()) || null;
    const created = createClient(db, { name, lastName, phone, source: 'telegram' }, { telegramUsername: from.username });
    linkTelegram(db, created.id, from.chatId, from.username);
    await notifyStaff(ctx, `👤 Новый клиент через бота: ${clientFullName(created)}, ${phone}${from.username ? ` (@${from.username})` : ''}`);
    text = `Спасибо, ${name}! Номер сохранён ✅ Чем могу помочь?`;
  }
  storeMessage(db, from.chatId, 'system', text);
  return { text, linked: true, cardLinked: true };
}

/**
 * Staff bind a chat to an employee from the app (`PUT /bot/chats/:chatId/employee`), e.g. when the employee never
 * shared their phone with the bot. The employee gets the staff greeting with the staff keyboard and the staff chat is
 * notified; a delivery failure is logged and the chat is bound anyway. Binding a chat to the employee it already
 * belongs to changes and sends nothing.
 */
export async function bindChatToEmployee(ctx: AppContext, chatId: number, employee: EmployeeRow): Promise<BotChatRow> {
  const { db } = ctx;
  const chat = getChat(db, chatId);
  if (chat.employeeId === employee.id) return chat;
  setChatEmployee(db, chatId, employee.id);
  const text = staffGreeting(getStudioSettings(db).name, employee);
  try {
    await ctx.gateway.sendText(chatId, text, { replyKeyboard: STAFF_KEYBOARD });
    storeMessage(db, chatId, 'system', text);
  } catch (err) {
    ctx.log.warn({ chatId, employeeId: employee.id, err: errorMessage(err) }, 'staff greeting not delivered');
  }
  await notifyStaff(ctx, `🔑 ${employee.name} подключён(а) к боту как сотрудник (вручную${chat.username ? `, @${chat.username}` : ''})`);
  return getChat(db, chatId);
}

export function handleStaffCommand(ctx: AppContext, chatId: number, code: string): string {
  const result = bindStaffChat(ctx.db, chatId, code);
  if (result === 'locked') {
    return '❌ Слишком много неверных попыток — код аннулирован. Получите новый код в приложении (Настройки → Бот).';
  }
  if (result === 'bound') {
    return (
      `✅ Этот чат подключён для уведомлений ${getStudioSettings(ctx.db).name}: новые заявки на запись, ` +
      'новые клиенты, вопросы, которые бот передал администратору.'
    );
  }
  return '❌ Код неверный или устарел. Получите новый код в приложении (Настройки → Бот) и отправьте: /staff <код>';
}
