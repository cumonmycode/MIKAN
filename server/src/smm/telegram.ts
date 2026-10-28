/**
 * Telegram для раздела «СММ»: канал профиля (бот MIKAN — администратор и публикует сам), превью на одобрение с
 * кнопками и передача готовых материалов человеку, который выкладывает Instagram, сторис и рилс. Всё — от бота
 * студии (@mikan_robot) через BotGateway; люди — сотрудники MIKAN с личным чатом с ботом (`bot_chats.employee_id`).
 *
 * Ожидание замечания и ссылок хранится в настройках (`smm_await_remark:<чат>`, `smm_await_link:<чат>` со сроком):
 * переживает перезапуск сервера, как redis в Titan. Ссылок чат может ждать несколько — по каждой переданной публикации.
 *
 * Файлы больше 50 МБ Telegram от бота не принимает: такие не шлём, а пишем, что файл — в приложении.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { and, asc, desc, eq, isNotNull } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { BotSendError, BotUnavailableError, type InlineKeyboard, type MediaFile, type PhotoSource } from '../bot/gateway.js';
import type { AppContext } from '../context.js';
import { botChats, employees } from '../db/schema.js';
import { deleteKey, readKey, studioTimezone, writeKey } from '../domain/settings.js';
import { errorMessage } from '../lib/errors.js';
import { DAY_MS, MINUTE_MS } from '../lib/time.js';
import { publishChannel } from './db.js';
import { smmFilePath, TELEGRAM_FILE_MAX_BYTES } from './files.js';
import { FORMAT_LABEL, PLATFORM_LABEL } from './prompts.js';
import { getSmmSettings, type SmmSettings } from './settings.js';
import { SmmError, autoPublishes, type SmmMedia, type SmmPost, type SmmProfile } from './types.js';

const CAPTION_LIMIT = 1024;
const ALBUM_LIMIT = 10;
export const LINK_WAIT_MS = 3 * DAY_MS;
export const REMARK_WAIT_MS = 30 * MINUTE_MS;
/** Ссылка, к которой спросили «к какой публикации?», ждёт ответа на кнопку столько. */
export const PENDING_LINK_MS = DAY_MS;
/** Длина версии превью в кнопке «Одобрить» (hex). */
const REVIEW_TAG_LENGTH = 8;
const REVIEW_TAG_RE = new RegExp(`^[0-9a-f]{${REVIEW_TAG_LENGTH}}$`);

// ─── Люди ────────────────────────────────────────────────────────────────────

/** Сотрудник MIKAN; `chatId` — его личный чат с ботом (null — не подключён к боту, в Telegram не написать). */
export interface SmmPerson {
  id: number;
  name: string;
  chatId: number | null;
}

/** Личный чат каждого сотрудника с ботом: самый свежий, если их несколько. */
function staffChats(ctx: AppContext): Map<number, number> {
  const rows = ctx.db
    .select({ chatId: botChats.chatId, employeeId: botChats.employeeId })
    .from(botChats)
    .where(isNotNull(botChats.employeeId))
    .orderBy(desc(botChats.updatedAt))
    .all();
  const out = new Map<number, number>();
  for (const r of rows) if (r.employeeId != null && !out.has(r.employeeId)) out.set(r.employeeId, r.chatId);
  return out;
}

function activeEmployees(ctx: AppContext): { id: number; name: string }[] {
  return ctx.db
    .select({ id: employees.id, name: employees.name })
    .from(employees)
    .where(eq(employees.active, true))
    .orderBy(asc(employees.name))
    .all();
}

/**
 * Кто одобряет публикации профиля: сотрудники из настроек (`approverIds`, только действующие). Пусто — у студии
 * все действующие сотрудники, подключённые к боту; у автора — никто (личный контент не уходит всей студии: в
 * настройках указывают себя).
 */
export async function approvers(ctx: AppContext, profile: SmmProfile): Promise<SmmPerson[]> {
  const settings = getSmmSettings(ctx.db, profile);
  const chats = staffChats(ctx);
  const people = activeEmployees(ctx);
  const person = (e: { id: number; name: string }): SmmPerson => ({ id: e.id, name: e.name, chatId: chats.get(e.id) ?? null });
  if (settings.approverIds.length) {
    const byId = new Map(people.map((e) => [e.id, e]));
    return settings.approverIds.flatMap((id) => {
      const e = byId.get(id);
      return e ? [person(e)] : [];
    });
  }
  if (profile === 'author') return [];
  return people.filter((e) => chats.has(e.id)).map(person);
}

export async function personById(ctx: AppContext, id: number | null): Promise<SmmPerson | null> {
  if (id == null) return null;
  const e = ctx.db
    .select({ id: employees.id, name: employees.name })
    .from(employees)
    .where(and(eq(employees.id, id), eq(employees.active, true)))
    .get();
  return e ? { id: e.id, name: e.name, chatId: staffChats(ctx).get(e.id) ?? null } : null;
}

/** Кто выкладывает публикацию вручную: назначенный на пост, из настроек профиля, иначе первый из одобряющих. */
export async function publisherFor(
  ctx: AppContext,
  profile: SmmProfile,
  settings: SmmSettings,
  post: Pick<SmmPost, 'assigneeId'>,
): Promise<SmmPerson | null> {
  return (
    (await personById(ctx, post.assigneeId)) ??
    (await personById(ctx, settings.publisherId)) ??
    (await approvers(ctx, profile))[0] ??
    null
  );
}

// ─── Текст ───────────────────────────────────────────────────────────────────

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const ALLOWED_TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 's', 'code', 'pre', 'blockquote', 'tg-spoiler']);
const TAG_RE = /<\/?([a-z][a-z-]*)(\s[^<>]*)?>/gi;

function escapeText(s: string): string {
  return s.replace(/&(?!(amp|lt|gt|quot|#\d+);)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Разметка Telegram: только разрешённые теги, ссылки — только http(s); markdown ** → <b>. */
export function telegramHtml(body: string): string {
  const text = body.replace(/<br\s*\/?>/gi, '\n').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  let out = '';
  let last = 0;
  for (const match of text.matchAll(TAG_RE)) {
    out += escapeText(text.slice(last, match.index));
    last = (match.index ?? 0) + match[0].length;
    const tag = match[1]!.toLowerCase();
    const closing = match[0].startsWith('</');
    if (ALLOWED_TAGS.has(tag)) out += closing ? `</${tag}>` : `<${tag}>`;
    else if (tag === 'a') {
      if (closing) out += '</a>';
      else {
        const href = /href\s*=\s*["']?(https?:\/\/[^"'\s>]+)/i.exec(match[2] ?? '')?.[1];
        out += href ? `<a href="${escapeHtml(href)}">` : '<a href="#">';
      }
    }
  }
  return (out + escapeText(text.slice(last))).replace(/<a href="#">([^<]*)<\/a>/g, '$1').trim();
}

/** Простой текст (Instagram, кнопки): без тегов и сущностей. */
export function plainText(body: string): string {
  return body
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<a\s[^>]*href=["']?([^"'\s>]+)[^>]*>([^<]*)<\/a>/gi, '$2')
    .replace(/<[^>]+>/g, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .trim();
}

const WEEKDAYS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

/** «пн, 3 мар, 12:00» по времени студии. */
export function whenText(ctx: AppContext, iso: string | null): string {
  if (!iso) return 'без даты';
  const d = DateTime.fromISO(iso, { zone: 'utc' }).setZone(studioTimezone(ctx.db));
  if (!d.isValid) return 'без даты';
  return `${WEEKDAYS[d.weekday - 1]}, ${d.day} ${MONTHS[d.month - 1]}, ${d.toFormat('HH:mm')}`;
}

const kindLine = (post: SmmPost) => `${PLATFORM_LABEL[post.platform]} · ${FORMAT_LABEL[post.format]}`;

// ─── Отправка медиа ──────────────────────────────────────────────────────────

const doneMedia = (post: Pick<SmmPost, 'media'>): SmmMedia[] =>
  post.media
    .filter((m) => m.status === 'done' && m.selected && m.url)
    .sort((a, b) => a.sort - b.sort)
    .slice(0, ALBUM_LIMIT);

/** Наш файл — с диска, ссылка архива — по ссылке; null — файла нет. */
function mediaSource(ctx: AppContext, media: SmmMedia): PhotoSource | null {
  const url = media.url!;
  const file = smmFilePath(ctx, url);
  if (file) return fs.existsSync(file) ? { kind: 'file', path: file } : null;
  return /^https?:\/\//i.test(url) ? { kind: 'url', url } : null;
}

/** Наш файл больше, чем Telegram примет от бота (по ссылке Telegram качает сам — такие не проверяем). */
function tooBigForTelegram(ctx: AppContext, media: SmmMedia): boolean {
  const file = smmFilePath(ctx, media.url!);
  if (!file) return false;
  try {
    return fs.statSync(file).size > TELEGRAM_FILE_MAX_BYTES;
  } catch {
    return false;
  }
}

/** Файлы, которые Telegram пропустит, и сколько не пропустит (больше 50 МБ). */
function telegramSized(ctx: AppContext, media: SmmMedia[]): { fits: SmmMedia[]; tooBig: number } {
  const fits = media.filter((m) => !tooBigForTelegram(ctx, m));
  return { fits, tooBig: media.length - fits.length };
}

const tooBigNote = (count: number): string =>
  count === 1
    ? 'Файл больше 50 МБ — Telegram такие не пропускает, он есть в приложении MIKAN (СММ → публикация).'
    : `Файлов больше 50 МБ: ${count} — Telegram такие не пропускает, они есть в приложении MIKAN (СММ → публикация).`;

type Sent = { ok: true; messageId: number } | { ok: false; error: string };

const failed = (error: unknown): Sent => ({ ok: false, error: errorMessage(error).replace(/^Telegram:\s*/, '') });

/**
 * Картинки/видео с подписью: одно — фото/видео, несколько — альбом. asDocuments — файлами без сжатия (для
 * выкладки в Instagram). Подпись с разметкой не прошла — шлюз повторяет её простым текстом.
 */
async function sendMedia(
  ctx: AppContext,
  chat: number | string,
  media: SmmMedia[],
  caption: string,
  opts: { html: boolean; asDocuments?: boolean },
): Promise<Sent> {
  const sources = media.map((m) => mediaSource(ctx, m));
  if (sources.some((s) => !s)) return { ok: false, error: 'файл не прочитался' };
  const files: MediaFile[] = media.map((m, i) => ({
    kind: opts.asDocuments ? 'document' : m.kind === 'video' ? 'video' : 'photo',
    source: sources[i]!,
  }));
  try {
    const sent = await ctx.gateway.sendMedia(chat, files, caption, { html: opts.html });
    return { ok: true, messageId: sent.messageId };
  } catch (error) {
    return failed(error);
  }
}

/** Текст отдельным сообщением (когда не влез в подпись или медиа нет). */
async function sendText(ctx: AppContext, chat: number | string, text: string, keyboard?: InlineKeyboard): Promise<Sent> {
  try {
    const sent = await ctx.gateway.sendHtml(chat, text, keyboard ? { keyboard } : {});
    return { ok: true, messageId: sent.messageId };
  } catch (error) {
    return failed(error);
  }
}

/** Имя бота для подсказок: « @mikan_robot» (с пробелом впереди) или пусто, пока имя неизвестно. */
const botHandle = (ctx: AppContext): string => {
  const name = ctx.gateway.username();
  return name ? ` @${name}` : '';
};

function requireBot(ctx: AppContext): void {
  if (!ctx.gateway.isRunning()) throw new SmmError('Telegram-бот не запущен — включите его в настройках бота', 400);
}

// ─── Канал ───────────────────────────────────────────────────────────────────

export interface ChannelCheck {
  chatId: string;
  title: string;
  handle: string | null;
  canPublish: boolean;
  problem: string | null;
}

/** Ссылка, @имя или id канала → проверка, что бот в нём администратор с правом публикации. */
export async function checkChannel(ctx: AppContext, input: string): Promise<ChannelCheck> {
  requireBot(ctx);
  const raw = input.trim();
  const handle = /(?:t\.me\/|@)([A-Za-z0-9_]{4,})/.exec(raw)?.[1] ?? (/^[A-Za-z][A-Za-z0-9_]{3,}$/.test(raw) ? raw : null);
  const id = /^-?\d{5,}$/.test(raw) ? raw : null;
  if (!handle && !id) throw new SmmError('Укажите ссылку на канал (t.me/имя) или @имя', 400);
  const bot = botHandle(ctx);
  try {
    const chat = await ctx.gateway.getChat(id ?? `@${handle}`);
    if (!chat) throw new SmmError(`Канал не найден. Сначала добавьте бота${bot} в администраторы канала`, 400);
    if (chat.type !== 'channel') throw new SmmError('Это не канал — нужен Telegram-канал профиля', 400);
    const member = await ctx.gateway.getBotMembership(chat.id);
    const isAdmin = member?.status === 'administrator' || member?.status === 'creator';
    const canPublish = member?.status === 'creator' || (isAdmin && member?.canPostMessages !== false);
    return {
      chatId: String(chat.id),
      title: chat.title ?? handle ?? 'Канал',
      handle: chat.username ?? handle,
      canPublish,
      problem: canPublish
        ? null
        : isAdmin
          ? `У бота${bot} нет права публиковать сообщения в канале`
          : `Бот${bot} не администратор канала — добавьте его в администраторы с правом публикации`,
    };
  } catch (error) {
    if (error instanceof SmmError) throw error;
    if (error instanceof BotUnavailableError) throw new SmmError('Telegram-бот не запущен — включите его в настройках бота', 400);
    throw new SmmError(`Telegram недоступен: ${errorMessage(error)}`, 502);
  }
}

export async function channelMembers(ctx: AppContext, chatId: string): Promise<number | null> {
  if (!ctx.gateway.isRunning()) return null;
  try {
    const n = await ctx.gateway.getChatMemberCount(chatId);
    return typeof n === 'number' ? n : null;
  } catch (error) {
    ctx.log.warn({ err: errorMessage(error) }, 'smm: channel member count failed');
    return null;
  }
}

/** Опубликовать в канал профиля. Текст длиннее подписи — отдельным сообщением после медиа. */
export async function publishToChannel(ctx: AppContext, post: SmmPost): Promise<{ messageId: number; url: string }> {
  const channel = await publishChannel(ctx, post.profile);
  if (!channel?.tgChatId) throw new SmmError('Канал Telegram не подключён — подключите его на площадках СММ', 400);
  requireBot(ctx);
  const html = telegramHtml(post.body);
  if (!html) throw new SmmError('Нет текста публикации', 400);
  const chat = channel.tgChatId;
  const media = doneMedia(post);
  if (telegramSized(ctx, media).tooBig) {
    throw new SmmError('Видео больше 50 МБ — Telegram его не примет: загрузите файл поменьше', 400);
  }
  let sent: Sent;
  if (!media.length) sent = await sendText(ctx, chat, html);
  else if (html.length <= CAPTION_LIMIT) sent = await sendMedia(ctx, chat, media, html, { html: true });
  else {
    sent = await sendMedia(ctx, chat, media, '', { html: false });
    if (sent.ok) {
      const text = await sendText(ctx, chat, html);
      if (!text.ok) throw new SmmError(`Картинка вышла, а текст нет: ${text.error}`, 502);
    }
  }
  if (!sent.ok) throw new SmmError(`Telegram не принял публикацию: ${sent.error}`, 502);
  const url = channel.handle
    ? `https://t.me/${channel.handle}/${sent.messageId}`
    : `https://t.me/c/${chat.replace(/^-100/, '')}/${sent.messageId}`;
  return { messageId: sent.messageId, url };
}

// ─── Превью на одобрение ─────────────────────────────────────────────────────

/**
 * Действия кнопок СММ: `smm:<действие>:<uuid публикации>` (≤ 64 байт); у «Одобрить» ещё версия превью —
 * `smm:approve:<uuid>:<версия>` (57 байт). link — ответ на «к какой публикации эта ссылка?».
 */
export const SMM_ACTIONS = ['approve', 'remark', 'skip', 'published', 'link'] as const;
export type SmmAction = (typeof SMM_ACTIONS)[number];

export const smmCallback = (action: SmmAction, postId: string, tag?: string): string =>
  tag ? `smm:${action}:${postId}:${tag}` : `smm:${action}:${postId}`;

/**
 * Версия превью — короткий отпечаток того, что видит одобряющий: тема, текст, сценарий, время, площадка и формат,
 * показанные файлы. Не `updatedAt`: его двигает и служебное (отметка об отправке превью, цифры, напоминания).
 */
export function reviewTag(post: Pick<SmmPost, 'topic' | 'body' | 'script' | 'publishAt' | 'platform' | 'format' | 'media'>): string {
  const files = doneMedia(post).map((m) => m.id);
  return createHash('sha256')
    .update(JSON.stringify([post.topic, post.body, post.script, post.publishAt, post.platform, post.format, files]))
    .digest('hex')
    .slice(0, REVIEW_TAG_LENGTH);
}

export const isReviewTag = (value: string): boolean => REVIEW_TAG_RE.test(value);

export const reviewButtons = (post: SmmPost): InlineKeyboard => [
  [
    { text: '✅ Одобрить', data: smmCallback('approve', post.id, reviewTag(post)) },
    { text: '✏️ Поправить', data: smmCallback('remark', post.id) },
  ],
  [{ text: '🚫 Не выкладывать', data: smmCallback('skip', post.id) }],
];

function reviewHeader(ctx: AppContext, post: SmmPost, intro: string): string {
  const action = (post.autoPublish ?? autoPublishes(post)) ? 'маркетолог опубликует сам' : 'выложит человек — маркетолог пришлёт файлы';
  return `${intro}\n<b>${escapeHtml(post.topic)}</b>\n${kindLine(post)} · ${whenText(ctx, post.publishAt)} · ${action}`;
}

/** Кадры сценария: что снять, текст на экране, стикер. */
function shotLines(post: SmmPost): string {
  return (post.script?.shots ?? [])
    .map(
      (s, i) =>
        `${i + 1}. ${escapeHtml(s.text)}${s.overlay ? ` — текст «${escapeHtml(s.overlay)}»` : ''}${s.sticker ? ` · стикер: ${escapeHtml(s.sticker)}` : ''}`,
    )
    .join('\n');
}

function reviewBody(post: SmmPost): string {
  const body = post.platform === 'telegram' ? telegramHtml(post.body) : escapeHtml(plainText(post.body));
  const script = post.script
    ? `\n\n🎬 <b>${post.format === 'story' ? 'Кадры' : 'Сценарий'}</b>\n${escapeHtml(post.script.hook)}\n${shotLines(post)}`
    : '';
  return body + script;
}

/** Прислать превью одному человеку (в его личный чат с ботом): медиа, затем текст с кнопками. */
export async function sendReviewTo(ctx: AppContext, post: SmmPost, chatId: number, intro = '📝 На одобрение'): Promise<boolean> {
  if (!ctx.gateway.isRunning()) return false;
  const { fits, tooBig } = telegramSized(ctx, doneMedia(post));
  if (fits.length) {
    const r = await sendMedia(ctx, chatId, fits, '', { html: false });
    if (!r.ok) ctx.log.warn({ err: r.error, postId: post.id }, 'smm: review media not sent');
  }
  const note = tooBig ? `\n\n📦 ${tooBigNote(tooBig)}` : '';
  const r = await sendText(ctx, chatId, `${reviewHeader(ctx, post, intro)}\n\n${reviewBody(post)}${note}`, reviewButtons(post));
  if (!r.ok) ctx.log.warn({ err: r.error, postId: post.id }, 'smm: review not sent');
  return r.ok;
}

// ─── Передача для выкладки (Instagram, сторис, рилс) ─────────────────────────

const doneButtons = (postId: string): InlineKeyboard => [[{ text: '✅ Выложил — пришлю ссылку', data: smmCallback('published', postId) }]];

function handoffText(ctx: AppContext, post: SmmPost, kind: 'now' | 'remind'): string {
  const where =
    post.format === 'story'
      ? `сторис в ${PLATFORM_LABEL[post.platform]}`
      : post.format === 'reel'
        ? 'рилс в Instagram'
        : `${FORMAT_LABEL[post.format]} в ${PLATFORM_LABEL[post.platform]}`;
  const head = kind === 'now' ? `📲 Пора выложить ${where}` : `⏰ Напоминаю: ${where} ещё не выложен`;
  const lines = [`${head}\n<b>${escapeHtml(post.topic)}</b> · ${whenText(ctx, post.publishAt)}`];
  if (post.format === 'story') lines.push(`Текст на сторис:\n<pre>${escapeHtml(plainText(post.body))}</pre>`);
  else lines.push(`Подпись — нажмите, чтобы скопировать:\n<pre>${escapeHtml(plainText(post.body))}</pre>`);
  if (post.script) {
    const script = post.script;
    lines.push(
      `🎬 <b>${post.format === 'story' ? 'Кадры' : 'Как снять'}</b>\n${post.format === 'story' ? '' : 'Зацепка: '}${escapeHtml(script.hook)}\n${shotLines(post)}` +
        `${script.audio ? `\nЗвук: ${escapeHtml(script.audio)}` : ''}${script.cast ? `\nКто: ${escapeHtml(script.cast)}` : ''}`,
    );
  }
  lines.push('Когда выложите — пришлите сюда ссылку на публикацию (или нажмите кнопку).');
  return lines.join('\n\n');
}

/** Отдать человеку файлы без сжатия и текст; ждать от него ссылку. */
export async function sendHandoff(ctx: AppContext, post: SmmPost, to: SmmPerson, kind: 'now' | 'remind' = 'now'): Promise<boolean> {
  if (to.chatId == null || !ctx.gateway.isRunning()) return false;
  const media = doneMedia(post);
  if (media.length && kind === 'now') {
    // Файл больше 50 МБ Telegram не пропустит — вместо него говорим, что он в приложении.
    const { fits, tooBig } = telegramSized(ctx, media);
    if (fits.length) {
      const r = await sendMedia(ctx, to.chatId, fits, '', { html: false, asDocuments: true });
      if (!r.ok) ctx.log.warn({ err: r.error, postId: post.id }, 'smm: hand-off files not sent');
    }
    if (tooBig) await tell(ctx, to.chatId, `📦 «${escapeHtml(post.topic)}»: ${tooBigNote(tooBig)}`);
  }
  const r = await sendText(ctx, to.chatId, handoffText(ctx, post, kind), doneButtons(post.id));
  if (r.ok) await awaitLink(ctx, to.chatId, post.id);
  else ctx.log.warn({ err: r.error, postId: post.id }, 'smm: hand-off not sent');
  return r.ok;
}

// ─── Чего ждём от человека: ссылки или замечание ─────────────────────────────

interface Awaited {
  postId: string;
  until: number;
}

/** Ссылки, которых ждём из чата: по публикации, переданной в него; `chosen` — на ней нажали «Выложил». */
export interface AwaitedLinks {
  posts: string[];
  chosen: string | null;
}

interface StoredLinks {
  posts: Awaited[];
  chosen: string | null;
}

const linkKey = (chatId: number) => `smm_await_link:${chatId}`;
const remarkKey = (chatId: number) => `smm_await_remark:${chatId}`;
const pendingLinkKey = (chatId: number) => `smm_pending_link:${chatId}`;

const isAwaited = (v: unknown): v is Awaited =>
  !!v && typeof (v as Awaited).postId === 'string' && typeof (v as Awaited).until === 'number';

function readAwaited(ctx: AppContext, key: string): string | null {
  const value = readKey<Awaited>(ctx.db, key);
  if (!value || typeof value.postId !== 'string') return null;
  if (!(value.until > Date.now())) {
    deleteKey(ctx.db, key);
    return null;
  }
  return value.postId;
}

function writeAwaited(ctx: AppContext, key: string, postId: string | null, ttlMs: number): void {
  if (postId) writeKey(ctx.db, key, { postId, until: Date.now() + ttlMs } satisfies Awaited);
  else deleteKey(ctx.db, key);
}

/** Живые ожидания ссылок чата; прежний формат (одна публикация `{postId, until}`) читается как список из одной. */
function readLinks(ctx: AppContext, chatId: number): StoredLinks {
  const raw = readKey<unknown>(ctx.db, linkKey(chatId));
  const list = isAwaited(raw) ? [raw] : Array.isArray((raw as StoredLinks | null)?.posts) ? (raw as StoredLinks).posts : [];
  const now = Date.now();
  const posts = list.filter((p) => isAwaited(p) && p.until > now);
  const chosen = (raw as StoredLinks | null)?.chosen;
  return { posts, chosen: typeof chosen === 'string' && posts.some((p) => p.postId === chosen) ? chosen : null };
}

function writeLinks(ctx: AppContext, chatId: number, links: StoredLinks): void {
  if (links.posts.length) writeKey(ctx.db, linkKey(chatId), links);
  else deleteKey(ctx.db, linkKey(chatId));
}

/** Каких ссылок ждём из чата: выбранная кнопкой «Выложил» — первой, остальные — от свежей передачи к старой. */
export async function awaitedLinks(ctx: AppContext, chatId: number): Promise<AwaitedLinks> {
  const { posts, chosen } = readLinks(ctx, chatId);
  const ids = posts.map((p) => p.postId).reverse();
  return { posts: chosen ? [chosen, ...ids.filter((id) => id !== chosen)] : ids, chosen };
}

/** Первая из ожидаемых ссылок чата (выбранная кнопкой или последняя переданная). */
export async function awaitedLinkPost(ctx: AppContext, chatId: number): Promise<string | null> {
  return (await awaitedLinks(ctx, chatId)).posts[0] ?? null;
}

/** Ждать из чата ссылку на публикацию (передача, напоминание); chosen — человек нажал «Выложил» именно на ней. */
export async function awaitLink(ctx: AppContext, chatId: number, postId: string, opts: { chosen?: boolean } = {}): Promise<void> {
  const links = readLinks(ctx, chatId);
  const posts = [...links.posts.filter((p) => p.postId !== postId), { postId, until: Date.now() + LINK_WAIT_MS }];
  writeLinks(ctx, chatId, { posts, chosen: opts.chosen ? postId : links.chosen });
}

/** Ссылку на публикацию больше не ждём (пришла или публикация уже не ждёт её). */
export async function stopAwaitingLink(ctx: AppContext, chatId: number, postId: string): Promise<void> {
  const links = readLinks(ctx, chatId);
  writeLinks(ctx, chatId, {
    posts: links.posts.filter((p) => p.postId !== postId),
    chosen: links.chosen === postId ? null : links.chosen,
  });
}

/** Ссылка, про которую спросили «к какой публикации?», — до ответа кнопкой. */
export async function setPendingLink(ctx: AppContext, chatId: number, url: string | null): Promise<void> {
  // Поле postId — общий формат ожиданий; здесь в нём ссылка.
  writeAwaited(ctx, pendingLinkKey(chatId), url, PENDING_LINK_MS);
}

export async function pendingLink(ctx: AppContext, chatId: number): Promise<string | null> {
  return readAwaited(ctx, pendingLinkKey(chatId));
}

export async function setAwaitedRemark(ctx: AppContext, chatId: number, postId: string | null): Promise<void> {
  writeAwaited(ctx, remarkKey(chatId), postId, REMARK_WAIT_MS);
}

export async function awaitedRemarkPost(ctx: AppContext, chatId: number): Promise<string | null> {
  return readAwaited(ctx, remarkKey(chatId));
}

/** Личное сообщение от маркетолога (кнопки — по желанию). */
export async function tell(ctx: AppContext, chatId: number | null, html: string, keyboard?: InlineKeyboard): Promise<boolean> {
  if (chatId == null || !ctx.gateway.isRunning()) return false;
  try {
    await ctx.gateway.sendHtml(chatId, html, keyboard ? { keyboard } : {});
    return true;
  } catch (error) {
    if (!(error instanceof BotSendError && error.blocked)) ctx.log.warn({ err: errorMessage(error) }, 'smm: message not sent');
    return false;
  }
}
