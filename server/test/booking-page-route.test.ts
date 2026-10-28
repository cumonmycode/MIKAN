import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { silentLogger, type AppContext } from '../src/context.js';
import { BOOKING_PAGE_DIR, bookingPageRoutes, etagMatches, loadBookingPage, renderBookingPage } from '../src/routes/booking-page.js';
import { createTestApp, type TestApp } from './helpers.js';

const PUBLIC_URL = 'https://studio.example';

describe('booking page: served by the server', () => {
  let t: TestApp;
  let version: string;

  beforeAll(async () => {
    t = await createTestApp({ env: { PUBLIC_URL } });
    version = loadBookingPage(BOOKING_PAGE_DIR).version;
  });
  afterAll(async () => {
    await t.close();
  });

  const get = (url: string, headers: Record<string, string> = {}) => t.app.inject({ method: 'GET', url, headers });

  it('serves the page at /book, /book/ and /book?service=', async () => {
    for (const url of ['/book', '/book/', '/book?service=3&master=5']) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(res.headers['cache-control']).toBe('no-cache');
      expect(res.body).toContain('<title>Запись в MIKAN STUDIO</title>');
    }
  });

  it('serves the page for client routes such as /book/b/<token>, not indexed', async () => {
    const res = await get('/book/b/abc');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['x-robots-tag']).toBe('noindex');
    expect(res.body).toContain('id="app"');
    expect((await get('/book')).headers['x-robots-tag']).toBeUndefined();
  });

  it('fills in the asset version, module preloads and the link-preview origin', async () => {
    const html = (await get('/book')).body;
    expect(html).not.toContain('{{');
    expect(html).toContain(`<script type="module" src="/book/v/${version}/app.js"></script>`);
    expect(html).toContain(`<link rel="stylesheet" href="/book/v/${version}/styles.css">`);
    expect(html).toContain(`<link rel="modulepreload" href="/book/v/${version}/lib/flow.js">`);
    expect(html).not.toContain(`modulepreload" href="/book/v/${version}/app.js"`);
    expect(html).toContain(`<meta property="og:title" content="Запись в MIKAN STUDIO">`);
    expect(html).toContain(`<meta property="og:image" content="${PUBLIC_URL}/book/og.png">`);
  });

  it('sends a content security policy that allows only Telegram\'s script from outside', async () => {
    const csp = (await get('/book')).headers['content-security-policy'];
    expect(csp).toContain("script-src 'self' https://telegram.org");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain('frame-ancestors');
  });

  it('serves versioned assets with their content types, immutable', async () => {
    const js = await get(`/book/v/${version}/app.js`);
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(js.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(js.body).toContain("from './lib/flow.js'");

    const nested = await get(`/book/v/${version}/lib/qr.js`);
    expect(nested.statusCode).toBe(200);
    expect(nested.headers['content-type']).toBe('text/javascript; charset=utf-8');

    const css = await get(`/book/v/${version}/styles.css`);
    expect(css.headers['content-type']).toBe('text/css; charset=utf-8');
  });

  it('serves an asset of an older version without pinning it', async () => {
    const res = await get('/book/v/0123456789ab/app.js');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('serves plain files (icons, preview picture) cached for an hour', async () => {
    const png = await get('/book/og.png');
    expect(png.statusCode).toBe(200);
    expect(png.headers['content-type']).toBe('image/png');
    expect(png.headers['cache-control']).toBe('public, max-age=3600');
    expect(png.rawPayload.subarray(1, 4).toString('ascii')).toBe('PNG');
    expect((await get('/book/styles.css')).headers['content-type']).toBe('text/css; charset=utf-8');
  });

  it('answers 304 to a matching ETag', async () => {
    const first = await get(`/book/v/${version}/lib/format.js`);
    const etag = String(first.headers.etag);
    expect(etag).toMatch(/^".+"$/);
    const again = await get(`/book/v/${version}/lib/format.js`, { 'if-none-match': etag });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');

    const page = await get('/book');
    const pageAgain = await get('/book', { 'if-none-match': String(page.headers.etag) });
    expect(pageAgain.statusCode).toBe(304);
  });

  it('answers 404 for a missing asset instead of the page', async () => {
    for (const url of ['/book/missing.js', `/book/v/${version}/missing.css`, '/book/v/abc/nothing.png']) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(404);
      expect(res.json()).toEqual({ error: { code: 'not_found', message: 'Ресурс не найден' } });
    }
  });

  it('serves /book/index.html as the rendered page', async () => {
    const res = await get('/book/index.html');
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('{{ASSETS}}');
  });

  it('answers HEAD for the page', async () => {
    const res = await t.app.inject({ method: 'HEAD', url: '/book' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
  });

  it('leaves the API alone', async () => {
    const res = await get('/api/health');
    expect(res.statusCode).toBe(200);
  });
});

describe('booking page: rendering and a missing directory', () => {
  it('matches ETags the way browsers and the proxy send them back', () => {
    expect(etagMatches('"abc"', '"abc"')).toBe(true);
    expect(etagMatches('W/"abc"', '"abc"')).toBe(true);
    expect(etagMatches('"abc-zstd"', '"abc"')).toBe(true);
    expect(etagMatches('"x", "abc-gzip"', '"abc"')).toBe(true);
    expect(etagMatches('*', '"abc"')).toBe(true);
    expect(etagMatches('"abd"', '"abc"')).toBe(false);
    expect(etagMatches(undefined, '"abc"')).toBe(false);
  });

  it('uses the request origin when PUBLIC_URL is not set and escapes it', () => {
    const bundle = loadBookingPage(BOOKING_PAGE_DIR);
    const html = renderBookingPage(bundle, 'https://a.example/"><script>/');
    expect(html).toContain('content="https://a.example/&quot;&gt;&lt;script&gt;/book/og.png"');
  });

  it('changes the version when a file changes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mikan-book-'));
    try {
      fs.writeFileSync(path.join(dir, 'index.html'), '<script src="{{ASSETS}}/app.js"></script>{{PRELOAD}}');
      fs.writeFileSync(path.join(dir, 'app.js'), 'console.log(1)');
      const before = loadBookingPage(dir).version;
      fs.writeFileSync(path.join(dir, 'app.js'), 'console.log(2)');
      expect(loadBookingPage(dir).version).not.toBe(before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('registers nothing (and logs) when the page files are missing', async () => {
    const warnings: unknown[] = [];
    const app = Fastify();
    const ctx = { config: { publicUrl: null }, log: { ...silentLogger, warn: (obj: unknown) => warnings.push(obj) } } as unknown as AppContext;
    bookingPageRoutes(app, ctx, path.join(os.tmpdir(), 'mikan-no-such-dir'));
    const res = await app.inject({ method: 'GET', url: '/book' });
    expect(res.statusCode).toBe(404);
    expect(warnings).toHaveLength(1);
    await app.close();
  });
});
