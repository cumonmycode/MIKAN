import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error — plain JS Cloudflare Worker without type declarations.
import worker from '../../cloudflare/telegram-proxy/worker.js';

const KEY = 'relay-key-0123456789abcdef';
const ENV = { ALLOWED_BOT_IDS: '8960400388', WEB_RELAY_KEY: KEY, ORIGIN_HOST: 'mikan.example' };
const FILE = 'smm-0b5a4c7e-1f2d-4e3a-9b8c-7d6e5f4a3b2c.jpg';

type Handler = { fetch(request: Request, env: Record<string, string>): Promise<Response> };
const relay = worker as Handler;

/** What the worker asked upstream (a Worker may stream a request body without Node's `duplex`, so no Request here). */
let upstream: Array<{ url: string; method: string; headers: Headers }>;

beforeEach(() => {
  upstream = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: Request | string, init?: RequestInit) => {
      upstream.push(
        input instanceof Request
          ? { url: input.url, method: input.method, headers: input.headers }
          : { url: input, method: init?.method ?? 'GET', headers: new Headers(init?.headers) },
      );
      return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain', 'content-length': '2' } });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const call = (path: string, init: RequestInit = {}, env: Record<string, string> = ENV) =>
  relay.fetch(new Request(`https://tg-proxy.example.workers.dev${path}`, init), env);

describe('Cloudflare worker', () => {
  it('still proxies the Bot API of the allowed bot only', async () => {
    expect((await call('/bot8960400388:AAH-token_x/getMe')).status).toBe(200);
    expect(upstream[0]!.url).toBe('https://api.telegram.org/bot8960400388:AAH-token_x/getMe');
    expect((await call('/file/bot8960400388:AAH-token_x/photos/a.jpg')).status).toBe(200);
    expect((await call('/bot111:other/getMe')).status).toBe(404);
    expect(upstream).toHaveLength(2);
  });

  it('/web/<key>/: GET to t.me and Instagram, POST only to the Instagram API, safe headers only', async () => {
    const res = await call(`/web/${KEY}/t.me/s/mikan_studio?before=41`, {
      headers: { 'user-agent': 'UA', cookie: 'secret=1', authorization: 'Bearer x', 'accept-language': 'ru' },
    });
    expect(res.status).toBe(200);
    const page = upstream[0]!;
    expect(page.url).toBe('https://t.me/s/mikan_studio?before=41');
    expect([...page.headers.keys()].sort()).toEqual(['accept-language', 'user-agent']);

    expect((await call(`/web/${KEY}/graph.instagram.com/v25.0/123/media`, { method: 'POST', body: 'caption=x' })).status).toBe(200);
    expect(upstream[1]).toMatchObject({ url: 'https://graph.instagram.com/v25.0/123/media', method: 'POST' });

    expect((await call(`/web/${KEY}/t.me/s/mikan_studio`, { method: 'POST', body: 'x' })).status).toBe(404);
    expect((await call(`/web/${KEY}/example.com/`)).status).toBe(404);
    expect((await call('/web/wrong-key-0123456789abcd/t.me/s/mikan_studio')).status).toBe(404);
    expect((await call(`/web/${KEY}/t.me/s/mikan_studio`, {}, { ...ENV, WEB_RELAY_KEY: '' })).status).toBe(404);
    expect(upstream).toHaveLength(2);
  });

  it('/media/smm-<file>: only our SMM files, from /uploads of the origin', async () => {
    const res = await call(`/media/${FILE}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain');
    expect(upstream[0]!.url).toBe(`https://mikan.example/uploads/${FILE}`);
    expect((await call(`/media/${FILE}`, { method: 'HEAD' })).status).toBe(200);

    expect((await call('/media/photo.jpg')).status).toBe(404);
    expect((await call('/media/smm-x/../../mikan.db')).status).toBe(404);
    expect((await call(`/media/${FILE}`, { method: 'POST' })).status).toBe(404);
    expect((await call(`/media/${FILE}`, {}, { ...ENV, ORIGIN_HOST: '' })).status).toBe(404);
    expect(upstream).toHaveLength(2);
  });
});
