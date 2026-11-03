/**
 * СММ в Telegram: кнопки под превью («Одобрить», «Поправить», «Не выкладывать», «Выложил») и личка бота —
 * замечание к посту текстом, ссылка на вышедшую публикацию. Цифры маркетолог берёт по API площадок. Работает только
 * с сотрудниками: их личные чаты с ботом (`bot_chats.employee_id`, сотрудник действующий).
 *
 * Ссылка без кнопки относится только к публикациям, которые ждут ссылку именно от этого человека: переданным в его
 * чат или назначенным на него. Площадка и @имя в ссылке отсекают чужие; осталось несколько переданных — бот
 * спрашивает кнопками, к какой; ни одной — сообщение уходит ИИ-помощнику сотрудников.
 *
 * Голосовые бот MIKAN не распознаёт: на голосовое вместо ожидаемого замечания просит написать текстом.
 */
import { and, eq, inArray, isNotNull, isNull, or, type SQL } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { smmAccounts, smmPosts } from '../db/schema.js';
import { chatEmployee, findChat } from '../domain/bot-chats.js';
import { errorMessage } from '../lib/errors.js';
import type { EmployeeRow } from '../lib/serialize.js';
import { toIso } from '../lib/time.js';
import { loadPost } from './db.js';
import { PLATFORM_LABEL } from './prompts.js';
import { getSmmSettings } from './settings.js';
import {
  SMM_ACTIONS,
  approvers,
  awaitLink,
  awaitedLinks,
  awaitedRemarkPost,
  escapeHtml,
  isReviewTag,
  pendingLink,
  reviewTag,
  sendReviewTo,
  setAwaitedRemark,
  setPendingLink,
  smmCallback,
  stopAwaitingLink,
  tell,
  whenText,
  type SmmAction,
} from './telegram.js';
import { isProfile, PROFILES, SmmError, type SmmPlatform, type SmmPost, type SmmProfile } from './types.js';
import { approvePost, canAutoPublish, markPublished, skipPost } from './workflow.js';
import { reviseInBackground } from './writer.js';

const UUID_RE = /^[0-9a-f-]{36}$/i;
const LINK_RE = /https?:\/\/(?:www\.)?(?:instagram\.com|instagr\.am|t\.me|vk\.com|vk\.ru)\/[^\s<>"]+/i;
/** Telegram показывает во всплывающем ответе на кнопку не больше 200 знаков. */
const TOAST_MAX = 190;
/** Столько публикаций на выбор в вопросе «к какой публикации эта ссылка?». */
const MAX_LINK_CHOICES = 6;
const TOPIC_IN_BUTTON = 40;
/** Первые части пути Instagram, которые не @имя: /p/…, /reel/… и т. п. */
const INSTAGRAM_PATHS = new Set(['p', 'reel', 'reels', 'tv', 'explore', 'share', 's', 'accounts', 'direct']);

/** Кнопки СММ — `smm:<действие>:<uuid>`; остальные кнопки бота разбирает bot/callback-data.ts. */
export const isSmmCallback = (data: string): boolean => data.startsWith('smm:');

const isAction = (v: string): v is SmmAction => (SMM_ACTIONS as readonly string[]).includes(v);

/** Сотрудник, чей это личный чат с ботом; null — клиент, незнакомый чат или уволенный сотрудник. */
function staffOf(ctx: AppContext, chatId: number): EmployeeRow | null {
  return chatEmployee(ctx.db, findChat(ctx.db, chatId));
}

async function canApprove(ctx: AppContext, profile: SmmProfile, employeeId: number): Promise<boolean> {
  return (await approvers(ctx, profile)).some((p) => p.id === employeeId);
}

/** Ждёт ли публикация ссылку: одобрена и ссылки ещё нет. */
const waitsForLink = (post: Pick<SmmPost, 'status' | 'publishedUrl'>): boolean => post.status === 'approved' && !post.publishedUrl;

export interface SmmCallbackInput {
  /** Личный чат, где нажали кнопку (он же Telegram-пользователь). */
  chatId: number;
  data: string;
  /** Сообщение с кнопкой; null — Telegram его уже не присылает (старое). */
  messageId: number | null;
}

/** Нажатие кнопки `smm:<действие>:<id публикации>[:<версия>]`; ответ — всплывающая подсказка. Никогда не бросает. */
export async function onSmmCallback(ctx: AppContext, query: SmmCallbackInput): Promise<{ text?: string }> {
  const [, action = '', postId = '', tag, ...rest] = query.data.split(':');
  const employee = staffOf(ctx, query.chatId);
  if (!employee) return { text: 'Только для сотрудников студии' };
  // Версия бывает только у «Одобрить»; «Одобрить» без версии (старое превью) разбирает dispatch — шлёт свежее.
  const tagOk = tag === undefined || (action === 'approve' && isReviewTag(tag));
  if (!isAction(action) || !UUID_RE.test(postId) || rest.length || !tagOk) return { text: 'Эта кнопка устарела' };
  try {
    return await dispatch(ctx, query, employee, action, postId, tag ?? null);
  } catch (error) {
    if (error instanceof SmmError) return { text: error.message.slice(0, TOAST_MAX) };
    ctx.log.warn({ err: errorMessage(error), data: query.data }, 'smm: button failed');
    return { text: 'Не получилось — попробуйте ещё раз' };
  }
}

/** «Одобрить» под старой версией превью: одобрить можно только то, что человек видел, — присылаем свежее. */
async function freshReview(ctx: AppContext, query: SmmCallbackInput, post: SmmPost): Promise<{ text: string }> {
  if (query.messageId != null) await ctx.gateway.editKeyboard(query.chatId, query.messageId, null).catch(() => undefined);
  await sendReviewTo(ctx, post, query.chatId, '🔁 Публикация изменилась — вот свежая версия');
  return { text: 'Публикация изменилась — прислал свежую версию' };
}

async function dispatch(
  ctx: AppContext,
  query: SmmCallbackInput,
  employee: EmployeeRow,
  action: SmmAction,
  postId: string,
  tag: string | null,
): Promise<{ text?: string }> {
  const { chatId, messageId } = query;
  const post = await loadPost(ctx, postId);
  if (!post) return { text: 'Публикация не найдена' };
  const closeButtons = async (note: string) => {
    if (messageId != null) await ctx.gateway.editKeyboard(chatId, messageId, null).catch(() => undefined);
    await tell(ctx, chatId, note);
  };
  if (action !== 'published' && action !== 'link' && !(await canApprove(ctx, post.profile, employee.id))) {
    return { text: 'Одобряет сотрудник, указанный в настройках СММ' };
  }
  switch (action) {
    case 'approve': {
      if (post.status !== 'published' && tag !== reviewTag(post)) return freshReview(ctx, query, post);
      const approved = await approvePost(ctx, postId, { id: employee.id, name: employee.name });
      const next = (await canAutoPublish(ctx, approved))
        ? `опубликую сам ${whenText(ctx, approved.publishAt)}`
        : `${whenText(ctx, approved.publishAt)} пришлю файлы и текст тому, кто выкладывает`;
      await closeButtons(`✅ «${escapeHtml(approved.topic)}» одобрено — ${next}.`);
      return { text: 'Одобрено' };
    }
    case 'remark':
      await setAwaitedRemark(ctx, chatId, postId);
      await tell(ctx, chatId, `✏️ Что поправить в «${escapeHtml(post.topic)}»? Напишите — текст, картинку, время.`);
      return {};
    case 'skip':
      await skipPost(ctx, postId);
      await closeButtons(`🚫 «${escapeHtml(post.topic)}» не выкладываем — осталась в плане серой. Вернуть можно в приложении → СММ.`);
      return { text: 'Не выкладываем' };
    case 'published':
      await awaitLink(ctx, chatId, postId, { chosen: true });
      await tell(ctx, chatId, `Супер! Пришлите ссылку на «${escapeHtml(post.topic)}» — скопируйте её в соцсети (⋯ → «Ссылка»).`);
      return {};
    case 'link': {
      const url = await pendingLink(ctx, chatId);
      if (!url) return { text: 'Пришлите ссылку ещё раз' };
      if (!waitsForLink(post)) return { text: 'Эта публикация уже отмечена — выберите другую' };
      if (messageId != null) await ctx.gateway.editKeyboard(chatId, messageId, null).catch(() => undefined);
      await recordLink(ctx, chatId, postId, url);
      return { text: 'Записал' };
    }
  }
}

// ─── Ссылка на вышедшую публикацию ───────────────────────────────────────────

/** Куда ведёт ссылка: площадка и аккаунт (@имя без регистра или id канала), если их видно по ссылке. */
export interface LinkTarget {
  platform: SmmPlatform | null;
  handle: string | null;
  chatId: string | null;
}

export function linkTarget(url: string): LinkTarget {
  const none: LinkTarget = { platform: null, handle: null, chatId: null };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return none;
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const [first = '', second = ''] = parsed.pathname.split('/').filter(Boolean);
  const handleOf = (value: string) => (/^[A-Za-z0-9._]{2,}$/.test(value) ? value.toLowerCase() : null);
  if (host === 'instagram.com' || host === 'instagr.am') {
    const handle = first.toLowerCase() === 'stories' ? second : INSTAGRAM_PATHS.has(first.toLowerCase()) ? '' : first;
    return { platform: 'instagram', handle: handleOf(handle), chatId: null };
  }
  if (host === 't.me') {
    if (first === 'c') return { platform: 'telegram', handle: null, chatId: /^\d+$/.test(second) ? `-100${second}` : null };
    return { platform: 'telegram', handle: handleOf(first === 's' ? second : first), chatId: null };
  }
  return none;
}

interface Waiting {
  id: string;
  profile: SmmProfile;
  platform: SmmPlatform;
  topic: string;
  publishAt: string | null;
}

/** Публикации, которые ждут ссылку (одобрены, ссылки нет), из тех, что подходят под условие. */
function waitingPosts(ctx: AppContext, where: SQL): Waiting[] {
  return ctx.db
    .select({ id: smmPosts.id, profile: smmPosts.profile, platform: smmPosts.platform, topic: smmPosts.topic, publishAt: smmPosts.publishAt })
    .from(smmPosts)
    .where(and(eq(smmPosts.status, 'approved'), isNull(smmPosts.publishedUrl), where))
    .all()
    .flatMap((r) =>
      isProfile(r.profile)
        ? [{ ...r, profile: r.profile, platform: r.platform === 'instagram' ? ('instagram' as const) : ('telegram' as const), publishAt: r.publishAt == null ? null : toIso(r.publishAt) }]
        : [],
    );
}

/** Переданные этому сотруднику: назначен он, а без назначенного — он выкладывающий профиля в настройках. */
function handedTo(employeeId: number, ctx: AppContext): SQL {
  const publisherOf = PROFILES.filter((p) => getSmmSettings(ctx.db, p).publisherId === employeeId);
  const mine = eq(smmPosts.assigneeId, employeeId);
  return and(
    isNotNull(smmPosts.handoffAt),
    publisherOf.length ? or(mine, and(isNull(smmPosts.assigneeId), inArray(smmPosts.profile, publisherOf))) : mine,
  )!;
}

/** Аккаунты профиля на площадке: @имена (без регистра) и id каналов. */
function accountsOf(ctx: AppContext, profile: SmmProfile, platform: SmmPlatform): { handles: Set<string>; chats: Set<string> } {
  const rows = ctx.db
    .select({ handle: smmAccounts.handle, tgChatId: smmAccounts.tgChatId })
    .from(smmAccounts)
    .where(and(eq(smmAccounts.profile, profile), eq(smmAccounts.platform, platform)))
    .all();
  return {
    handles: new Set(rows.flatMap((r) => (r.handle ? [r.handle.replace(/^@/, '').toLowerCase()] : []))),
    chats: new Set(rows.flatMap((r) => (r.tgChatId ? [r.tgChatId] : []))),
  };
}

/**
 * Оставить публикации, к которым ссылка может относиться: та же площадка; если в ссылке видно @имя или канал —
 * публикации профиля с этим аккаунтом, а нет таких — профилей, чей аккаунт на площадке неизвестен (чужие отпадают).
 */
function narrow(ctx: AppContext, posts: Waiting[], target: LinkTarget): Waiting[] {
  const platform = target.platform;
  if (!platform) return posts;
  const onPlatform = posts.filter((p) => p.platform === platform);
  if (!target.handle && !target.chatId) return onPlatform;
  const verdict = (p: Waiting): 'match' | 'other' | 'unknown' => {
    const { handles, chats } = accountsOf(ctx, p.profile, platform);
    const known = target.handle ? handles : chats;
    if (known.has((target.handle ?? target.chatId)!)) return 'match';
    return known.size ? 'other' : 'unknown';
  };
  const judged = onPlatform.map((p) => ({ p, v: verdict(p) }));
  const matched = judged.filter((j) => j.v === 'match');
  return (matched.length ? matched : judged.filter((j) => j.v === 'unknown')).map((j) => j.p);
}

/** Записать ссылку: публикация вышла; больше её не ждём. */
async function recordLink(ctx: AppContext, chatId: number, postId: string, url: string): Promise<void> {
  // Ссылка пришла — больше её не ждём, даже если отметить не вышло (публикацию удалили): иначе каждая следующая
  // ссылка сотрудника упиралась бы в ту же ошибку.
  await stopAwaitingLink(ctx, chatId, postId);
  await setPendingLink(ctx, chatId, null);
  const post = await markPublished(ctx, postId, url);
  await tell(ctx, chatId, `✅ Записал: «${escapeHtml(post.topic)}» вышла. Ссылка уже в приложении, цифры подтяну в аналитику.`);
}

/** Передано несколько публикаций, и по ссылке не понять какая, — спросить кнопками. */
async function askWhich(ctx: AppContext, chatId: number, url: string, posts: Waiting[]): Promise<void> {
  await setPendingLink(ctx, chatId, url);
  const keyboard = posts.slice(0, MAX_LINK_CHOICES).map((p) => {
    const topic = p.topic.length > TOPIC_IN_BUTTON ? `${p.topic.slice(0, TOPIC_IN_BUTTON - 1)}…` : p.topic;
    return [{ text: `${topic} · ${PLATFORM_LABEL[p.platform]} · ${whenText(ctx, p.publishAt)}`, data: smmCallback('link', p.id) }];
  });
  await tell(ctx, chatId, '🔗 К какой публикации эта ссылка? Нажмите нужную.', keyboard);
}

async function onLink(ctx: AppContext, employee: EmployeeRow, chatId: number, rawUrl: string): Promise<boolean> {
  const url = rawUrl.replace(/[).,!?]+$/, '');
  const target = linkTarget(url);
  // 1. Переданные в этот чат: выбранная кнопкой «Выложил», единственная подходящая или вопрос, какая из них.
  const links = await awaitedLinks(ctx, chatId);
  if (links.posts.length) {
    const live = waitingPosts(ctx, inArray(smmPosts.id, links.posts));
    for (const id of links.posts) if (!live.some((p) => p.id === id)) await stopAwaitingLink(ctx, chatId, id);
    const handed = narrow(ctx, live, target);
    const chosen = handed.find((p) => p.id === links.chosen);
    if (chosen || handed.length === 1) {
      await recordLink(ctx, chatId, (chosen ?? handed[0])!.id, url);
      return true;
    }
    if (handed.length > 1) {
      const order = new Map(links.posts.map((id, i) => [id, i]));
      await askWhich(ctx, chatId, url, [...handed].sort((a, b) => order.get(a.id)! - order.get(b.id)!));
      return true;
    }
  }
  // 2. Без переданных в чат — только если ссылку ждёт ровно одна публикация, назначенная на этого сотрудника.
  const mine = narrow(ctx, waitingPosts(ctx, handedTo(employee.id, ctx)), target);
  if (mine.length !== 1) return false;
  await recordLink(ctx, chatId, mine[0]!.id, url);
  return true;
}

// ─── Замечание ───────────────────────────────────────────────────────────────

async function onRemark(ctx: AppContext, employee: EmployeeRow, chatId: number, postId: string, text: string): Promise<void> {
  await setAwaitedRemark(ctx, chatId, null);
  const started = await reviseInBackground(
    ctx,
    postId,
    text,
    { id: employee.id, name: employee.name },
    async ({ post, reply }: { post: SmmPost; reply: string }) => {
      await tell(ctx, chatId, `✍️ ${escapeHtml(reply)}`);
      if (post.status !== 'published') await sendReviewTo(ctx, post, chatId, '🔁 Новая версия');
    },
    async (message: string) => {
      await tell(ctx, chatId, `😕 ${escapeHtml(message)}`);
    },
  );
  await tell(
    ctx,
    chatId,
    started ? 'Принял, переделываю — пришлю новую версию через минуту 👌' : 'Я ещё работаю над этой публикацией — пришлите замечание чуть позже.',
  );
}

/**
 * Личное сообщение сотрудника, которое касается СММ: ожидаемое замечание к посту или ссылка на вышедшую
 * публикацию. true — обработано здесь, дальше (ИИ-помощнику сотрудников) не передаём.
 */
export async function onSmmPrivate(ctx: AppContext, chatId: number, text: string): Promise<boolean> {
  const employee = staffOf(ctx, chatId);
  const input = text.trim();
  if (!employee || !input) return false;
  try {
    const remarkPost = await awaitedRemarkPost(ctx, chatId);
    if (remarkPost && !LINK_RE.test(input)) {
      await onRemark(ctx, employee, chatId, remarkPost, input);
      return true;
    }
    const link = LINK_RE.exec(input)?.[0];
    return !!link && (await onLink(ctx, employee, chatId, link));
  } catch (error) {
    if (!(error instanceof SmmError)) ctx.log.warn({ err: errorMessage(error), chatId }, 'smm: staff message failed');
    await tell(ctx, chatId, `😕 ${escapeHtml(error instanceof SmmError ? error.message : 'Не получилось — попробуйте ещё раз')}`);
    return true;
  }
}

/** Голосовое сотрудника, когда ждём замечание: распознавать речь бот не умеет — просим текстом. */
export async function onSmmVoice(ctx: AppContext, chatId: number): Promise<boolean> {
  if (!staffOf(ctx, chatId) || !(await awaitedRemarkPost(ctx, chatId))) return false;
  await tell(ctx, chatId, '🎙 Голосовые я пока не разбираю — напишите замечание текстом, пожалуйста.');
  return true;
}
