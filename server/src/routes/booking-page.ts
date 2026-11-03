import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';

/**
 * The client booking page and Telegram Mini App (`server/public/book`, plain files, no build step) under `/book/`.
 *
 * Caching: the page is served with its assets under `/book/v/<content hash>/…` (relative module imports keep the
 * prefix), so assets are immutable for a year while the HTML is revalidated on every visit (`no-cache` + ETag).
 * Plain `/book/<file>` (icons, the link-preview picture) is cached for an hour. Any other `/book/*` path that is not
 * an asset returns the page itself — the page routes on the client (`/book/b/<token>`).
 */

export const BOOKING_PAGE_DIR = path.resolve(import.meta.dirname, '../../public/book');
const PREFIX = '/book';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const CACHE_HTML = 'no-cache';
const CACHE_VERSIONED = 'public, max-age=31536000, immutable';
const CACHE_PLAIN = 'public, max-age=3600';

/** Telegram's script is the only outside resource; Telegram Web shows the Mini App in a frame. */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' https://telegram.org",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'self' https://web.telegram.org https://*.telegram.org",
].join('; ');

interface StaticFile {
  body: Buffer;
  type: string;
  etag: string;
}

interface Bundle {
  version: string;
  files: Map<string, StaticFile>;
  template: string;
}

const etagOf = (data: Buffer | string) => `"${createHash('sha256').update(data).digest('base64url').slice(0, 27)}"`;

function listFiles(dir: string, base = ''): string[] {
  return fs
    .readdirSync(path.join(dir, base), { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.'))
    .flatMap((entry) => {
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) return listFiles(dir, rel);
      return entry.isFile() && CONTENT_TYPES[path.extname(entry.name)] ? [rel] : [];
    })
    .sort();
}

/** Reads every page file into memory (a few dozen KB) and hashes them all into the asset version. */
export function loadBookingPage(dir: string): Bundle {
  const files = new Map<string, StaticFile>();
  const version = createHash('sha256');
  for (const rel of listFiles(dir)) {
    const body = fs.readFileSync(path.join(dir, rel));
    version.update(rel).update('\0').update(body).update('\0');
    files.set(rel, { body, type: CONTENT_TYPES[path.extname(rel)] ?? 'application/octet-stream', etag: etagOf(body) });
  }
  const index = files.get('index.html');
  if (!index) throw new Error(`booking page: ${path.join(dir, 'index.html')} is missing`);
  return { version: version.digest('hex').slice(0, 12), files, template: index.body.toString('utf8') };
}

const escapeAttr = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

/** The HTML with the versioned asset prefix, module preloads (no import waterfall) and the absolute origin. */
export function renderBookingPage(bundle: Bundle, origin: string): string {
  const assets = `${PREFIX}/v/${bundle.version}`;
  const preload = [...bundle.files.keys()]
    .filter((rel) => rel.endsWith('.js') && rel !== 'app.js')
    .map((rel) => `  <link rel="modulepreload" href="${assets}/${rel}">`)
    .join('\n');
  return bundle.template
    .replaceAll('{{ASSETS}}', assets)
    .replaceAll('{{ORIGIN}}', escapeAttr(origin.replace(/\/+$/, '')))
    .replace('{{PRELOAD}}', preload);
}

/** Paths that name a file: a missing one is a 404, not the page. */
const looksLikeAsset = (rel: string) => /\.[a-z0-9]{1,12}$/i.test(rel) && path.extname(rel).toLowerCase() in CONTENT_TYPES;

function send(request: FastifyRequest, reply: FastifyReply, body: Buffer | string, type: string, etag: string, cacheControl: string) {
  reply.header('Cache-Control', cacheControl).header('ETag', etag).header('X-Content-Type-Options', 'nosniff');
  if (etagMatches(request.headers['if-none-match'], etag)) return reply.code(304).send();
  return reply.type(type).send(body);
}

/** `If-None-Match` may list several tags, weak ones, or ours with a compression suffix added by the proxy. */
export function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const core = etag.replace(/^"|"$/g, '');
  return header.split(',').some((tag) => {
    const value = tag.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
    return value === '*' || value === core || value.replace(/-(gzip|zstd|br)$/, '') === core;
  });
}

export function bookingPageRoutes(app: FastifyInstance, ctx: AppContext, dir = BOOKING_PAGE_DIR): void {
  if (!fs.existsSync(path.join(dir, 'index.html'))) {
    ctx.log.warn({ dir }, 'booking page files not found: /book is not served');
    return;
  }
  // Production reads the files once; elsewhere every page load re-reads them, so edits show up without a restart.
  const cached = process.env.NODE_ENV === 'production' ? loadBookingPage(dir) : null;
  const bundle = () => cached ?? loadBookingPage(dir);

  const serveIndex = (request: FastifyRequest, reply: FastifyReply, current: Bundle) => {
    const origin = ctx.config.publicUrl ?? `${request.protocol}://${request.host}`;
    const html = renderBookingPage(current, origin);
    reply.header('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    // A booking's page and the client cabinet are private.
    if (request.url.startsWith(`${PREFIX}/b/`) || /^\/book\/me(?:[/?]|$)/.test(request.url)) reply.header('X-Robots-Tag', 'noindex');
    return send(request, reply, html, CONTENT_TYPES['.html'] as string, etagOf(html), CACHE_HTML);
  };

  app.get(PREFIX, (request, reply) => serveIndex(request, reply, bundle()));
  app.get(`${PREFIX}/*`, (request, reply) => {
    const current = bundle();
    const rel = (request.params as { '*': string })['*'] ?? '';
    if (rel === 'index.html') return serveIndex(request, reply, current);
    const versioned = /^v\/([0-9a-z]{1,64})\/(.+)$/i.exec(rel);
    const file = current.files.get(versioned ? (versioned[2] as string) : rel);
    if (file) {
      // A page loaded just before a deploy asks for the old version: it gets the current file, not pinned for a year.
      const cache = !versioned ? CACHE_PLAIN : versioned[1] === current.version ? CACHE_VERSIONED : CACHE_HTML;
      return send(request, reply, file.body, file.type, file.etag, cache);
    }
    if (versioned || looksLikeAsset(rel)) return reply.callNotFound();
    return serveIndex(request, reply, current);
  });
}
