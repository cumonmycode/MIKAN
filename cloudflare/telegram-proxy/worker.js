// Transparent reverse proxy to the Telegram Bot API for servers where api.telegram.org is blocked.
// Handles both API calls (/bot<id>:<token>/<method>) and file downloads (/file/bot<id>:<token>/<path>).
// Only bots listed in ALLOWED_BOT_IDS are forwarded, so the worker can't be used as an open proxy.
//
// The SMM marketer (server/src/smm/relay.ts) also needs two more routes:
//
//  1) Public pages and the Instagram API for platform statistics and publishing (t.me and Instagram are closed
//     from the server in Russia). Only these hosts; GET everywhere, POST only to the Instagram API:
//       GET      /web/<WEB_RELAY_KEY>/t.me/s/<channel>                  → https://t.me/s/<channel>
//       GET      /web/<WEB_RELAY_KEY>/www.instagram.com/…, i.instagram.com/…
//       GET|POST /web/<WEB_RELAY_KEY>/graph.instagram.com/v25.0/…        → Instagram API (data and publishing)
//     WEB_RELAY_KEY is a worker secret (`npx wrangler secret put WEB_RELAY_KEY`), the same value as SMM_RELAY_KEY
//     in the server's .env. Without it the route is closed. Only a few safe request headers are forwarded.
//
//  2) SMM files for Meta's servers (Instagram takes a picture or video by URL when publishing):
//       GET|HEAD /media/smm-<file> → https://<ORIGIN_HOST>/uploads/smm-<file>. Only SMM files of our server.
//
// The cron trigger additionally checks the MIKAN server from outside (see uptime.js).

import { runUptimeCheck } from "./uptime.js";

const TELEGRAM_ORIGIN = "https://api.telegram.org";
const BOT_PATH = /^\/(?:file\/)?bot(\d+):[A-Za-z0-9_-]+\//;

const WEB_PATH = /^\/web\/([^/]+)\/(t\.me|www\.instagram\.com|i\.instagram\.com|graph\.instagram\.com)(\/[^?#]*)$/;
const WEB_HEADERS = ["user-agent", "accept", "accept-language", "x-ig-app-id", "content-type"];
/** Shorter keys are refused: the route must not become an open proxy by a guessable secret. */
const MIN_KEY_LENGTH = 16;

const MEDIA_PATH = /^\/media\/(smm-[A-Za-z0-9-]+\.[A-Za-z0-9]{1,5})$/;

const notFound = () => new Response("Not found", { status: 404 });

/** Compares secrets without leaking how many leading characters matched. */
function sameKey(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function relayWeb(request, url, web, env) {
  const [, key, host, path] = web;
  const secret = env.WEB_RELAY_KEY;
  if (!secret || secret.length < MIN_KEY_LENGTH || !sameKey(key, secret)) return notFound();
  const allowed = request.method === "GET" || (request.method === "POST" && host === "graph.instagram.com");
  if (!allowed) return notFound();
  const headers = new Headers();
  for (const name of WEB_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const res = await fetch(`https://${host}${path}${url.search}`, {
    method: request.method,
    headers,
    body: request.method === "POST" ? request.body : undefined,
    redirect: "manual",
  });
  return new Response(res.body, {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") || "text/html" },
  });
}

async function relayMedia(request, name, env) {
  if (!env.ORIGIN_HOST) return notFound();
  const res = await fetch(`https://${env.ORIGIN_HOST}/uploads/${name}`, { method: request.method });
  if (!res.ok) return notFound();
  const headers = { "content-type": res.headers.get("content-type") || "application/octet-stream" };
  const length = res.headers.get("content-length");
  if (length) headers["content-length"] = length;
  return new Response(request.method === "HEAD" ? null : res.body, { status: 200, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const web = WEB_PATH.exec(url.pathname);
    if (web) return relayWeb(request, url, web, env);

    const media = MEDIA_PATH.exec(url.pathname);
    if (media && (request.method === "GET" || request.method === "HEAD")) return relayMedia(request, media[1], env);

    const match = url.pathname.match(BOT_PATH);
    const allowedIds = (env.ALLOWED_BOT_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);

    if (!match || !allowedIds.includes(match[1])) {
      return notFound();
    }

    const target = new URL(url.pathname + url.search, TELEGRAM_ORIGIN);
    return fetch(new Request(target, request));
  },

  async scheduled(controller, env) {
    await runUptimeCheck(env, controller.scheduledTime);
  },
};
