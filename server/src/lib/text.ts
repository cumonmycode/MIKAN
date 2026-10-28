export const TELEGRAM_MAX_MESSAGE = 4096;
export const TELEGRAM_MAX_CAPTION = 1024;

/** Lowercased, whitespace-collapsed search key built from the given parts (JS lowercasing handles Cyrillic). */
export function searchKey(...parts: Array<string | null | undefined>): string {
  return parts
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .join(' ')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeSearchTerm(term: string): string {
  return term.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

/**
 * Splits text into chunks of at most `limit` characters, preferring paragraph,
 * then line, then sentence/word boundaries.
 */
export function splitMessage(text: string, limit = TELEGRAM_MAX_MESSAGE): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  const chunks: string[] = [];
  let rest = trimmed;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const cut = findCut(window);
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

function findCut(window: string): number {
  const minCut = Math.floor(window.length * 0.5);
  for (const sep of ['\n\n', '\n', '. ', ' ']) {
    const at = window.lastIndexOf(sep);
    if (at >= minCut) return at + sep.length;
  }
  return window.length;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** 12500 → "12 500" (ru-RU digit grouping with plain spaces). */
export function formatAmount(amount: number): string {
  return amount.toLocaleString('ru-RU').replace(/\u00a0/g, ' ');
}

export function formatRub(amount: number): string {
  return `${formatAmount(amount)} ₽`;
}

/**
 * Catalog price of a service (docs/API.md → Service):
 * «от 2 000 до 5 000 ₽», «до 10 000 ₽», «от 15 000 ₽», «Бесплатно», «2 500 ₽».
 */
export function formatServicePrice(price: number, priceMax: number | null, priceFrom: boolean): string {
  if (priceMax != null) return price > 0 ? `от ${formatAmount(price)} до ${formatRub(priceMax)}` : `до ${formatRub(priceMax)}`;
  if (priceFrom) return `от ${formatRub(price)}`;
  return price === 0 ? 'Бесплатно' : formatRub(price);
}

/** The Russian word form for a count: 1 день, 3 дня, 5 дней, 11 дней, 21 день. */
export function pluralWord(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  return m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
}
