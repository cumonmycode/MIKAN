/**
 * Маркетолог изучает профиль:
 *  1. История соцсетей — вся лента Telegram-канала профиля (t.me/s, через шлюз) и его Instagram (API) в
 *     smm_platform_posts, потом разбор частями: голос, рубрики, события, люди, что заходило и что нет → раздел
 *     'socials' базы знаний.
 *  2. Портрет → раздел 'brand'. У студии — из данных MIKAN (настройки студии, услуги и цены, мастера, украшения),
 *     выводов из соцсетей и слов владельца. У автора — только из её собственных слов и выводов из её соцсетей:
 *     ничего из студии. Только факты из источников, без выдумок.
 * Запускается кнопкой в «Базе знаний» и раз в неделю кроном.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { smmAccounts, smmPlatformPosts } from '../db/schema.js';
import { errorMessage } from '../lib/errors.js';
import { chatJson } from './ai.js';
import { brandFacts, brandTitle, studioDate } from './context.js';
import { listAccounts, type AccountRow } from './db.js';
import { igAllMedia, instagramState } from './instagram.js';
import { claimDoc, getDoc, saveAiText, setDocProgress, type KnowledgeKey } from './knowledge.js';
import { webFetch } from './relay.js';
import { igFormat, parseChannelPage, upsertPlatformPost } from './stats.js';
import { plainText } from './telegram.js';
import { SmmError, step, type SmmProfile } from './types.js';

const TG_MAX_PAGES = 80;
/** Сколько знаков ленты в одном заходе разбора. */
const CHUNK_CHARS = 40_000;
const MAX_CHUNKS = 6;

const studySystem = (profile: SmmProfile): string =>
  profile === 'author'
    ? 'Ты — маркетолог личного блога автора. Изучаешь её прошлые публикации, чтобы продолжать в том же духе и не повторяться. Пишешь по-русски, коротко и по делу, только то, что видно в постах. Ответ — один JSON.'
    : 'Ты — маркетолог тату- и пирсинг-студии. Изучаешь прошлые публикации студии, чтобы продолжать в том же духе и не повторяться. Пишешь по-русски, коротко и по делу, только то, что видно в постах. Ответ — один JSON.';

const failText = (error: unknown) => errorMessage(error).slice(0, 300) || 'Не получилось';

// ─── 1. Вся история площадок ─────────────────────────────────────────────────

async function telegramHistory(ctx: AppContext, account: AccountRow): Promise<number> {
  if (!account.handle) return 0;
  let before: number | null = null;
  let seen = 0;
  for (let page = 0; page < TG_MAX_PAGES; page += 1) {
    const res = await webFetch(ctx, `https://t.me/s/${account.handle}${before ? `?before=${before}` : ''}`).catch(() => null);
    if (!res?.ok) break;
    const parsed = parseChannelPage(await res.text(), account.handle);
    for (const p of parsed.posts) {
      seen += 1;
      await upsertPlatformPost(ctx, account, {
        extId: String(p.id),
        format: p.format,
        publishedAt: p.at,
        caption: p.text,
        permalink: `https://t.me/${account.handle}/${p.id}`,
        thumb: p.thumb,
        views: p.views,
        reactions: p.reactions,
      });
    }
    if (!parsed.before || !parsed.posts.length) break;
    before = parsed.before;
  }
  return seen;
}

async function instagramHistory(ctx: AppContext, account: AccountRow): Promise<number> {
  if (!(await instagramState(ctx, account.profile))) return 0;
  const media = await igAllMedia(ctx, account.profile);
  for (const m of media) {
    await upsertPlatformPost(ctx, account, {
      extId: m.id,
      format: igFormat(m),
      publishedAt: m.timestamp ? new Date(m.timestamp).toISOString() : null,
      caption: plainText(m.caption ?? ''),
      permalink: m.permalink ?? null,
      thumb: m.thumbnail_url ?? m.media_url ?? null,
      likes: m.like_count ?? null,
      comments: m.comments_count ?? null,
    });
  }
  return media.length;
}

/** Выгрузить всю ленту площадок профиля. Возвращает, сколько постов увидели по площадкам. */
export async function collectHistory(ctx: AppContext, profile: SmmProfile): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const account of (await listAccounts(ctx, profile)).filter((a) => a.isActive)) {
    try {
      const n =
        account.platform === 'telegram'
          ? await telegramHistory(ctx, account)
          : account.platform === 'instagram'
            ? await instagramHistory(ctx, account)
            : 0;
      counts[account.platform] = (counts[account.platform] ?? 0) + n;
    } catch (error) {
      ctx.log.warn({ err: errorMessage(error), profile, account: account.title }, 'smm: platform history failed');
    }
  }
  return counts;
}

// ─── 2. Разбор истории ───────────────────────────────────────────────────────

const NotesSchema = z.object({
  voice: z.string().max(1200),
  rubrics: z.array(z.string().max(240)).max(12),
  events: z.array(z.string().max(240)).max(20),
  people: z.array(z.string().max(200)).max(12),
  facts: z.array(z.string().max(240)).max(15),
  hits: z.array(z.string().max(240)).max(6),
  misses: z.array(z.string().max(240)).max(6),
});
/** Заметки по части ленты — с запасом: на большой части ответ упирался в лимит и обрывался. */
const NOTES_MAX_TOKENS = 9000;
type Notes = z.infer<typeof NotesSchema>;

const SummarySchema = z.object({ text: z.string().min(200).max(6000), facts: z.array(z.string().max(300)).max(30) });

interface HistoryRow {
  platform: string;
  format: string;
  publishedAt: number | null;
  caption: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
}

function postLine(ctx: AppContext, p: HistoryRow): string {
  const day = p.publishedAt ? studioDate(ctx, p.publishedAt) : '—';
  const nums = [p.views != null && `👁${p.views}`, p.likes != null && `❤${p.likes}`, p.comments != null && `💬${p.comments}`]
    .filter(Boolean)
    .join(' ');
  return `[${day} ${p.platform === 'telegram' ? 'TG' : 'IG'} ${p.format}${nums ? ` ${nums}` : ''}] ${p.caption.replace(/\s+/g, ' ').trim().slice(0, 900)}`;
}

function chunks(lines: string[]): string[] {
  const out: string[] = [];
  let current = '';
  for (const line of lines) {
    if (current.length + line.length > CHUNK_CHARS && current) {
      out.push(current);
      current = '';
    }
    current += `${line}\n`;
  }
  if (current) out.push(current);
  // Слишком длинная история — берём самое свежее.
  return out.slice(-MAX_CHUNKS);
}

function notesTask(profile: SmmProfile): string {
  const author = profile === 'author';
  return [
    `Выпиши из этих публикаций ${author ? 'блога автора' : 'студии'} (новые — внизу):`,
    `voice — как ${author ? 'автор пишет' : 'студия пишет'}: обращение, длина, эмодзи, шутки, типичные слова и обороты;`,
    author
      ? 'rubrics — повторяющиеся рубрики и форматы (работы и эскизы, процесс, личное, вдохновение, вопросы подписчиков и т.д.);'
      : 'rubrics — повторяющиеся рубрики и форматы (работы до и после заживления, эскизы и флеш, окна на неделю, уход, украшения, отзывы и т.д.);',
    author
      ? 'events — события и поводы с датами (поездки, конвенции, выставки, важные моменты, которые автор сама публиковала);'
      : 'events — события и инфоповоды с датами (флеш-дни, гостевые мастера, конвенции, новинки украшений, праздники, акции);',
    author
      ? 'people — люди, которых автор упоминает публично (коллеги, друзья, партнёры) и в какой роли; клиентов не выписывай;'
      : 'people — мастера и лица студии, которых упоминают публично (мастера, гостевые мастера, партнёры) и в какой роли; клиентов не выписывай;',
    author
      ? 'facts — факты об авторе (чем занимается, стиль, что любит, город и планы — если сказаны);'
      : 'facts — факты о студии (услуги, стили мастеров, материалы украшений, стерильность, традиции, адреса, цифры);',
    'hits — что набрало больше всего просмотров и реакций и почему (с цифрами); misses — что прошло слабо.',
    'Коротко: каждый пункт — одна фраза до 150 знаков; событий — до 20 самых заметных, фактов — до 15.',
    'Ответ — JSON: {"voice": "...", "rubrics": [...], "events": [...], "people": [...], "facts": [...], "hits": [...], "misses": [...]}',
  ].join('\n');
}

/** Все публикации площадок профиля с подписью — от старых к новым. */
function profileHistory(ctx: AppContext, profile: SmmProfile): HistoryRow[] {
  return ctx.db
    .select({
      platform: smmPlatformPosts.platform,
      format: smmPlatformPosts.format,
      publishedAt: smmPlatformPosts.publishedAt,
      caption: smmPlatformPosts.caption,
      views: smmPlatformPosts.views,
      likes: sql<number | null>`coalesce(${smmPlatformPosts.likes}, ${smmPlatformPosts.reactions})`,
      comments: smmPlatformPosts.comments,
    })
    .from(smmPlatformPosts)
    .innerJoin(smmAccounts, eq(smmAccounts.id, smmPlatformPosts.accountId))
    .where(and(eq(smmAccounts.profile, profile), sql`length(${smmPlatformPosts.caption}) > 15`))
    .orderBy(asc(smmPlatformPosts.publishedAt))
    .all();
}

/** Разобрать всю историю площадок профиля и записать выводы в базу знаний. */
export async function studySocials(ctx: AppContext, profile: SmmProfile): Promise<void> {
  const author = profile === 'author';
  try {
    await setDocProgress(ctx, profile, 'socials', step('Собираю всю ленту Telegram и Instagram', 2, 30, 60));
    const counts = await collectHistory(ctx, profile);
    const history = profileHistory(ctx, profile);
    if (!history.length) {
      throw new SmmError(`В соцсетях ${author ? 'автора' : 'студии'} пока нечего изучать — подключите канал и Instagram`, 400);
    }
    const parts = chunks(history.map((p) => postLine(ctx, p)));
    const notes: Notes[] = [];
    for (let i = 0; i < parts.length; i += 1) {
      const from = 30 + Math.round((55 * i) / parts.length);
      await setDocProgress(ctx, profile, 'socials', step(`Читаю посты: часть ${i + 1} из ${parts.length}`, from, from + Math.round(55 / parts.length), 25));
      notes.push(
        await chatJson(ctx, profile, {
          system: studySystem(profile),
          note: 'изучение соцсетей',
          maxTokens: NOTES_MAX_TOKENS,
          temperature: 0.3,
          schema: NotesSchema,
          user: `${notesTask(profile)}\n\nПубликации:\n${parts[i]}`,
        }),
      );
    }
    await setDocProgress(ctx, profile, 'socials', step('Свожу выводы', 85, 99, 25));
    const summary = await chatJson(ctx, profile, {
      system: studySystem(profile),
      note: 'выводы по соцсетям',
      maxTokens: 5000,
      temperature: 0.3,
      schema: SummarySchema,
      user: [
        `Заметки по всей истории соцсетей ${author ? 'автора' : 'студии'} (${history.length} публикаций, части по порядку времени):`,
        JSON.stringify(notes),
        '',
        'Сведи в памятку для себя на будущее — по разделам, коротко, с датами и цифрами:',
        author
          ? '«Как я пишу» (голос и приёмы), «Рубрики и форматы», «События и истории» (что и когда было), «Люди рядом» (только те, кого автор называла публично), «Что заходило» и «Что не заходило», «Не повторять» (темы и заходы, которые уже были недавно).'
          : '«Как мы пишем» (голос и приёмы), «Рубрики и форматы», «События и традиции» (что и когда было), «Мастера и лица студии» (только публичные имена и роли), «Что заходило» и «Что не заходило», «Не повторять» (темы и заходы, которые уже были недавно).',
        'Имён и данных клиентов в памятке нет.',
        `Ответ — JSON: {"text": "памятка, 1500–4000 знаков, разделы с заголовками на отдельной строке", "facts": ["факты ${author ? 'об авторе' : 'о студии'} из постов, по одному"]}`,
      ].join('\n'),
    });
    await saveAiText(ctx, profile, 'socials', summary.text, {
      counts,
      posts: history.length,
      facts: summary.facts,
      studiedAt: new Date().toISOString(),
    });
  } catch (error) {
    await setDocProgress(ctx, profile, 'socials', null, failText(error));
    throw error;
  }
}

// ─── 3. Портрет ──────────────────────────────────────────────────────────────

const PortraitSchema = z.object({ text: z.string().min(200).max(7000) });

const STUDIO_SECTIONS =
  'Напиши портрет студии по разделам (заголовок — отдельной строкой): «Кто мы» (город, чем занимаемся — тату, пирсинг, украшения), «Услуги и цены» (как устроен прайс и что в нём главное, без полного списка), «Мастера и стили» (только имена мастеров и их стили, если известны), «Украшения» (материалы и ассортимент), «Безопасность и подход» (стерильность, материалы — только то, что сказано), «История и традиции» (флеш-дни, гостевые мастера, события из соцсетей), «Фишки и словарь студии», «Как о нас говорить» (что подчёркивать).';
const AUTHOR_SECTIONS =
  'Напиши портрет автора по разделам (заголовок — отдельной строкой): «Кто я» (чем занимаюсь, город — только если сказано), «О чём мой блог», «Творчество и стиль», «Голос и манера», «Моя аудитория и что ей заходит», «Темы и истории» (что уже рассказывала), «Как писать от моего лица» (что подчёркивать, чего избегать).';

/** Источники портрета: у студии — данные MIKAN, у автора — ничего из студии. */
async function portraitSources(ctx: AppContext, profile: SmmProfile): Promise<{ name: string; facts: string }> {
  const name = await brandTitle(ctx, profile);
  return { name, facts: profile === 'author' ? '' : await brandFacts(ctx, 'studio', 30) };
}

/** Собрать портрет профиля из источников и слов владельца (у автора — её собственных). */
export async function composePortrait(ctx: AppContext, profile: SmmProfile): Promise<void> {
  const author = profile === 'author';
  try {
    await setDocProgress(ctx, profile, 'brand', step(author ? 'Собираю, что известно об авторе' : 'Собираю, что известно о студии', 3, 30, 15));
    const [{ name, facts }, brand, socials] = await Promise.all([
      portraitSources(ctx, profile),
      getDoc(ctx, profile, 'brand'),
      getDoc(ctx, profile, 'socials'),
    ]);
    const socialFacts = Array.isArray(socials.meta['facts']) ? (socials.meta['facts'] as unknown[]).map(String) : [];
    const owner = brand.ownerText.trim();
    if (author && !owner && !socials.aiText.trim() && !socialFacts.length) {
      throw new SmmError('Расскажите о себе в «Базе знаний» или изучите соцсети — маркетологу пока не на что опереться', 400);
    }
    await setDocProgress(ctx, profile, 'brand', step(author ? 'Пишу портрет автора' : 'Пишу портрет студии', 30, 98, 40));
    const r = await chatJson(ctx, profile, {
      system: author
        ? `Ты — маркетолог личного блога «${name}». Собираешь портрет автора для себя — чтобы писать от её лица точно. Только факты из источников ниже; чего нет — не выдумывай. Пишешь по-русски. Ответ — один JSON.`
        : `Ты — маркетолог тату- и пирсинг-студии «${name}». Собираешь портрет студии для себя — чтобы писать о ней точно. Только факты из источников ниже; чего нет — не выдумывай. Пишешь по-русски. Ответ — один JSON.`,
      note: author ? 'портрет автора' : 'портрет студии',
      maxTokens: 5000,
      temperature: 0.3,
      schema: PortraitSchema,
      user: [
        owner ? `Слова ${author ? 'автора о себе' : 'владельца'} (главный источник, важнее остальных):\n${owner}` : '',
        facts ? `Факты из системы студии (адрес, часы, услуги и цены, мастера, украшения, памятки):\n${facts}` : '',
        socialFacts.length ? `Факты из прошлых постов:\n${socialFacts.map((f) => `- ${f}`).join('\n')}` : '',
        socials.aiText ? `Памятка по соцсетям (для контекста):\n${socials.aiText.slice(0, 3000)}` : '',
        '',
        author ? AUTHOR_SECTIONS : STUDIO_SECTIONS,
        author
          ? 'Это личный блог, отдельный от работы: не добавляй сведений о студиях, услугах, ценах и записи, если их нет в словах автора. Без оценок и преувеличений.'
          : 'Без оценок и преувеличений, которых нет в источниках: никаких «лучшая студия», «№1», «самые опытные» — только то, что сказано. Имён и данных клиентов нет.',
        'Ответ — JSON: {"text": "портрет, 1500–4500 знаков"}',
      ]
        .filter(Boolean)
        .join('\n\n'),
    });
    await saveAiText(ctx, profile, 'brand', r.text, {
      sources: { facts: !!facts, socials: socialFacts.length, owner: !!owner },
      composedAt: new Date().toISOString(),
    });
  } catch (error) {
    await setDocProgress(ctx, profile, 'brand', null, failText(error));
    throw error;
  }
}

/** Изучить всё: соцсети, потом портрет (он опирается на выводы из соцсетей). Замена `studyClub` Titan. */
export async function studyBrand(ctx: AppContext, profile: SmmProfile): Promise<void> {
  await studySocials(ctx, profile).catch((error: unknown) =>
    ctx.log.warn({ err: errorMessage(error), profile }, 'smm: socials study failed'),
  );
  await composePortrait(ctx, profile);
}

/**
 * Запустить изучение в фоне: false — маркетолог уже над этим работает. `done` — когда закончил: null — успех,
 * иначе ошибка (крону — чтобы отметить день и повторить при сбое).
 */
export async function studyInBackground(
  ctx: AppContext,
  profile: SmmProfile,
  what: KnowledgeKey,
  done?: (error: unknown) => void | Promise<void>,
): Promise<boolean> {
  const label =
    what === 'socials'
      ? 'Собираю всю ленту Telegram и Instagram'
      : profile === 'author'
        ? 'Собираю, что известно об авторе'
        : 'Собираю, что известно о студии';
  if (!(await claimDoc(ctx, profile, what, step(label, 2, 10, 10)))) return false;
  const run = what === 'socials' ? () => studyBrand(ctx, profile) : () => composePortrait(ctx, profile);
  void run()
    .then(
      () => done?.(null),
      (error: unknown) => {
        ctx.log.error({ err: errorMessage(error), profile, what }, 'smm: study failed');
        return done?.(error);
      },
    )
    .catch((error: unknown) => ctx.log.error({ err: errorMessage(error), profile, what }, 'smm: study follow-up failed'));
  return true;
}
