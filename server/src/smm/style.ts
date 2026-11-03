/**
 * Чтобы тексты маркетолога не звучали как нейросеть (по скиллам владельца ig-human и ig-caption): убираем машинные
 * следы (невидимые символы, длинные тире, «…»), безопасно меняем штампы, а остальное — штампы, приметы-конструкции,
 * нарушения правил Instagram и правил темы (обещания «не больно», превосходные степени, Instagram и Meta в
 * Telegram) — находим и отдаём модели на переписывание.
 */
import { SLOP_PHRASES, SLOP_STRUCTURES, SLOP_WORDS, type SlopEntry } from './slop-ru.js';
import type { SmmFormat, SmmPlatform } from './types.js';

const WORD = '[\\p{L}\\p{N}_]';
const BOUNDARY = `(?:(?<=${WORD})(?!${WORD})|(?<!${WORD})(?=${WORD}))`;

/**
 * Регулярка из словаря (синтаксис Python) → JS: флаги (?i)/(?m) в начале — в флаги, \b и \w — с кириллицей (в JS
 * они только латинские), \U0001F680 → \u{1F680}.
 */
export function toJsRegex(source: string, extraFlags = ''): RegExp | null {
  let flags = `gu${extraFlags}`;
  let body = source.replace(/^\(\?([a-z]+)\)/, (_, f: string) => {
    if (f.includes('i')) flags += 'i';
    if (f.includes('m')) flags += 'm';
    return '';
  });
  body = body.replace(/\\U([0-9A-Fa-f]{8})/g, (_, hex: string) => `\\u{${parseInt(hex, 16).toString(16)}}`);
  let out = '';
  let inClass = false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]!;
    if (ch === '\\' && i + 1 < body.length) {
      const next = body[i + 1]!;
      if (next === 'b' && !inClass) out += BOUNDARY;
      else if (next === 'w') out += inClass ? '\\p{L}\\p{N}_' : WORD;
      else out += ch + next;
      i += 1;
      continue;
    }
    if (ch === '[' && !inClass) inClass = true;
    else if (ch === ']' && inClass) inClass = false;
    out += ch;
  }
  try {
    return new RegExp(out, [...new Set(flags)].join(''));
  } catch {
    return null;
  }
}

interface Compiled {
  entry: SlopEntry;
  re: RegExp;
}

interface Structure {
  name: string;
  fix: string;
  re: RegExp;
}

let compiled: { words: Compiled[]; phrases: Compiled[]; structures: Structure[] } | null = null;

function lexicon() {
  if (compiled) return compiled;
  const entries = (list: SlopEntry[]) =>
    list
      .map((entry) => ({
        entry,
        re: toJsRegex(entry.pattern ?? entry.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'), 'i'),
      }))
      .filter((c): c is Compiled => !!c.re);
  compiled = {
    words: entries(SLOP_WORDS),
    phrases: entries(SLOP_PHRASES),
    structures: SLOP_STRUCTURES
      // «Тройка через запятую» и капс срабатывают на нормальном тексте — их не трогаем.
      .filter((s) => !/тройк|капс/i.test(s.name))
      .map((s) => ({ name: s.name, fix: s.fix, re: toJsRegex(s.regex) }))
      .filter((s): s is Structure => !!s.re),
  };
  return compiled;
}

const INVISIBLE = /[\u200B-\u200F\u2060-\u2064\uFEFF\u00AD\u180E]|[\u{E0000}-\u{E007F}]/gu;

/** Убрать машинные следы и безопасно заменить штампы (окончание переносится как есть). */
export function humanize(text: string): string {
  let out = text
    .replace(INVISIBLE, '')
    .replace(/[\u00A0\u202F\u2007]/g, ' ')
    .replace(/\s*—\s*/g, ' - ')
    .replace(/–/g, '-')
    .replace(/…/g, '...')
    .replace(/^[ \t]*•[ \t]*/gm, '- ');
  for (const { entry, re } of lexicon().words.concat(lexicon().phrases)) {
    if (entry.replace == null) continue;
    const replacement = entry.replace.replace(/\\(\d)/g, '$$$1');
    out = out.replace(re, (match: string, ...groups: unknown[]) => {
      const swapped = replacement.replace(/\$(\d)/g, (_, n: string) => String(groups[Number(n) - 1] ?? ''));
      return match[0] && match[0] === match[0].toUpperCase() && match[0] !== match[0].toLowerCase()
        ? swapped.charAt(0).toUpperCase() + swapped.slice(1)
        : swapped;
    });
  }
  return out.replace(/[ \t]{2,}/g, ' ').replace(/ +\n/g, '\n').trim();
}

const EMOJI = /\p{Extended_Pictographic}/gu;
const HASHTAG = /(^|\s)#[\p{L}\p{N}_]+/gu;
const URL = /https?:\/\/\S+|\b[\w-]+\.(?:ru|com|me|рф)\/\S*/giu;
const DEAD_TAGS = ['рекомендации', 'втоп', 'хочуврек', 'реки', 'рек', 'тренды', 'viral', 'fyp', 'explorepage', 'foryou', 'instagood', 'like4like', 'followme'];
const GREETING = /^\s*(?:всем\s+привет|привет,?\s*(?:друзья|ребята)?|здравствуйте|дорогие|добрый\s+(?:день|вечер))/iu;

/** Правила темы: обещания о боли и заживлении, громкие превосходные степени. */
const DOMAIN_RULES: { re: RegExp; issue: string }[] = [
  {
    re: /(?:совсем|абсолютно|вообще|совершенно)\s+не\s*больно|безболезненн/iu,
    issue: 'обещание «не больно» — о боли честно: ощущения у всех разные и зависят от места',
  },
  {
    re: /зажив[её]т\s+(?:за|через)\s+(?:\d+\s*)?(?:день|дня|дней|сутки|недел)/iu,
    issue: 'обещание срока заживления — сроки только диапазоном и «у всех по-разному»',
  },
  {
    re: /лучш(?:ая|ие|ий|ее|ую|их)\s+(?:студи\p{L}*|мастер\p{L}*|тату\p{L}*|пирсинг\p{L}*)?\s*в\s+(?:городе|регионе|стране|россии)|№\s*1\b|номер\s+один\b/iu,
    issue: 'превосходная степень («лучшие в городе», «№1») — убери, говори фактами',
  },
  {
    re: /(?:100\s*%|стопроцентн\p{L}*)\s+(?:безопасн|гарант|результат)|гаранти\p{L}*\s+результат/iu,
    issue: 'гарантия безопасности или результата — так обещать нельзя',
  },
];
/** В Telegram — без призывов в Instagram и без упоминания Meta (закон РФ). */
const INSTAGRAM_OR_META = /инстаграм|instagram|facebook|фейсбук|(?<!\p{L})(?:инст[аеуы]|insta|meta|мета)(?!\p{L})/iu;

/** Что исправить по правилам темы и площадки (часть `lintText`). */
export function lintDomain(plain: string, platform: SmmPlatform): string[] {
  const issues = DOMAIN_RULES.filter((r) => r.re.test(plain)).map((r) => r.issue);
  if (platform === 'telegram' && INSTAGRAM_OR_META.test(plain)) {
    issues.push('в Telegram нельзя звать в Instagram и упоминать Meta — убери упоминание');
  }
  return issues;
}

/**
 * Что исправить в тексте: штампы, приметы нейросети, правила площадки и темы. Пустой список — текст можно
 * показывать.
 */
export function lintText(text: string, platform: SmmPlatform, format: SmmFormat): string[] {
  const issues: string[] = [];
  const { words, phrases, structures } = lexicon();
  const plain = text.replace(/<[^>]+>/g, '');
  for (const { entry, re } of words.concat(phrases)) {
    re.lastIndex = 0;
    const hit = re.exec(plain)?.[0];
    if (hit) issues.push(`штамп «${hit}»${entry.hint ? ` — ${entry.hint}` : ''}`);
  }
  for (const s of structures) {
    s.re.lastIndex = 0;
    if (s.re.test(plain)) issues.push(`конструкция ${s.name} — ${s.fix}`);
  }
  issues.push(...lintDomain(plain, platform));
  const firstLine = plain.split('\n').find((l) => l.trim())?.trim() ?? '';
  if (GREETING.test(firstLine)) issues.push('первая строка — приветствие: начни сразу с сути');
  if (format !== 'story') {
    const emoji = (plain.match(EMOJI) ?? []).length;
    if (plain.length > 100 && emoji / (plain.length / 100) > 4) issues.push(`слишком много эмодзи (${emoji}) — не больше 4 на 100 знаков`);
  }
  if (platform === 'instagram' && format !== 'story') {
    const tags = (plain.match(HASHTAG) ?? []).map((t) => t.trim().slice(1).toLowerCase());
    if (tags.length > 5) issues.push(`хэштегов ${tags.length} — Instagram принимает не больше 5: оставь самые точные`);
    const dead = tags.filter((t) => DEAD_TAGS.includes(t));
    if (dead.length) issues.push(`пустые хэштеги ${dead.map((t) => `#${t}`).join(', ')} — убери`);
    if (URL.test(plain)) issues.push('ссылка в подписи Instagram не кликается — «ссылка в шапке профиля» или «пиши в директ»');
    URL.lastIndex = 0;
    if (/^[#\p{Extended_Pictographic}]/u.test(firstLine)) issues.push('первая строка начинается с хэштега или эмодзи — начни с крючка словами');
    if (firstLine.length > 125) issues.push(`первая строка ${firstLine.length} знаков — до «ещё» видно только 125: сократи крючок`);
  }
  return [...new Set(issues)].slice(0, 12);
}
