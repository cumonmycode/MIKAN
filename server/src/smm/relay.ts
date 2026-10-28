/**
 * Выход во внешний интернет для СММ. С сервера в РФ t.me и Instagram закрыты — запросы идут через Cloudflare Worker
 * MIKAN (тот же шлюз, что у Telegram Bot API): `${TELEGRAM_API_ROOT}/web/<SMM_RELAY_KEY>/<хост><путь>`. Без ключа
 * (локально) или без шлюза в TELEGRAM_API_ROOT — напрямую.
 */
import type { AppContext } from '../context.js';
import { absoluteUrl, smmFileName } from './files.js';

const TELEGRAM_HOST = 'api.telegram.org';
const DEFAULT_TIMEOUT_MS = 20_000;
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

/** Корень шлюза: ключ задан и TELEGRAM_API_ROOT ведёт на Worker, а не на сам Telegram. */
function relayRoot(ctx: AppContext): string | null {
  if (!ctx.config.smm.relayKey) return null;
  const root = ctx.config.telegram.apiRoot.replace(/\/+$/, '');
  try {
    return new URL(root).host === TELEGRAM_HOST ? null : root;
  } catch {
    return null;
  }
}

/** Адрес запроса через шлюз (https); без шлюза и для не-https — как есть. */
export function relayUrl(ctx: AppContext, url: string): string {
  const root = relayRoot(ctx);
  if (!root) return url;
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return url;
  }
  if (target.protocol !== 'https:') return url;
  return `${root}/web/${ctx.config.smm.relayKey}/${target.host}${target.pathname}${target.search}`;
}

export function webFetch(
  ctx: AppContext,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {},
): Promise<Response> {
  return (ctx.smmFetch ?? fetch)(relayUrl(ctx, url), {
    method: init.method ?? 'GET',
    headers: { 'user-agent': BROWSER_UA, ...(init.headers ?? {}) },
    body: init.body,
    signal: AbortSignal.timeout(init.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
}

/**
 * Публичная ссылка на наш файл для серверов Meta: через Worker (`/media/smm-…` → `/uploads/smm-…` нашего сервера),
 * чтобы не зависеть от того, пускает ли сервер в РФ запросы из-за рубежа. Без шлюза — `PUBLIC_URL` + путь; чужие
 * ссылки — как есть.
 */
export function publicMediaUrl(ctx: AppContext, path: string): string {
  const root = relayRoot(ctx);
  const name = smmFileName(ctx, path);
  return root && name ? `${root}/media/${name}` : absoluteUrl(ctx, path);
}
