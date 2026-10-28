import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { smmAccounts, smmPlatformPosts } from '../src/db/schema.js';
import { readKey } from '../src/domain/settings.js';
import { decryptSecret } from '../src/lib/secrets.js';
import { studioDate } from '../src/smm/context.js';
import { insertMedia, insertPost, loadPost, updatePost } from '../src/smm/db.js';
import { saveSmmFile } from '../src/smm/files.js';
import {
  connectInstagram,
  disconnectInstagram,
  instagramCanPublish,
  instagramState,
  publishToInstagram,
  refreshInstagramToken,
  tokenNeedsRefresh,
} from '../src/smm/instagram.js';
import { accountHistory, collectStats, parseChannelPage, parseCount } from '../src/smm/stats.js';
import type { SmmPost, SmmProfile } from '../src/smm/types.js';
import { createTestApp, type TestApp } from './helpers.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-28T12:00:00.000Z');
const RELAY_ROOT = 'https://tg-proxy.example.workers.dev';
const RELAY_KEY = 'relay-key-0123456789abcdef';
const CHANNEL_ID = -1001234567890;
const TOKEN = `IGAAT${'k'.repeat(60)}`;
const IG_ID = '17841400000000001';
const FIXTURE = fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'smm-platforms-tme-channel.html'), 'utf8');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);

interface Request {
  /** What our server asked for: the relay address. */
  url: string;
  /** Where the relay goes: the real address. */
  target: URL;
  method: string;
  body: string | null;
}

let t: TestApp;
let requests: Request[];
let answer: (req: Request) => Response;

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

function addAccount(profile: SmmProfile, platform: 'telegram' | 'instagram', handle: string, tgChatId: string | null = null): string {
  const id = randomUUID();
  const now = Date.now();
  t.ctx.db
    .insert(smmAccounts)
    .values({ id, profile, platform, title: handle, handle, tgChatId, canPublish: platform === 'telegram', createdAt: now, updatedAt: now })
    .run();
  return id;
}

const account = (id: string) => t.ctx.db.select().from(smmAccounts).where(eq(smmAccounts.id, id)).get()!;
const post = async (id: string): Promise<SmmPost> => (await loadPost(t.ctx, id))!;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  t = await createTestApp({ env: { SMM_RELAY_KEY: RELAY_KEY, TELEGRAM_API_ROOT: RELAY_ROOT } });
  requests = [];
  answer = () => new Response('not found', { status: 404 });
  t.ctx.smmFetch = (async (input: string | URL | globalThis.Request, init?: RequestInit) => {
    const url = String(input);
    const prefix = `${RELAY_ROOT}/web/${RELAY_KEY}/`;
    const target = new URL(url.startsWith(prefix) ? `https://${url.slice(prefix.length)}` : url);
    const req = { url, target, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : null };
    requests.push(req);
    return answer(req);
  }) as typeof fetch;
});

afterEach(async () => {
  await t.close();
  vi.useRealTimers();
});

describe('t.me/s pages', () => {
  it('reads counts like Telegram shows them', () => {
    expect(parseCount('1.2K')).toBe(1200);
    expect(parseCount('3,4M')).toBe(3_400_000);
    expect(parseCount('850')).toBe(850);
    expect(parseCount('—')).toBeNull();
  });

  it('parses the posts of the channel from a saved page: views, reactions, time, text, album, next page', () => {
    const page = parseChannelPage(FIXTURE, 'mikan_studio');
    expect(page.before).toBe(41);
    expect(page.posts).toEqual([
      {
        id: 41,
        views: 1200,
        reactions: 15,
        at: '2026-10-20T09:00:00+00:00',
        text: 'Стерильность — это не слово, а процесс 🧤\nПоказываем, как готовим кабинет к сеансу & проколу.',
        format: 'post',
        thumb: null,
      },
      {
        id: 42,
        views: 850,
        reactions: 0,
        at: '2026-10-22T15:30:00+00:00',
        text: '«Ухо мечты» за один визит: хеликс, флэт и коньч — титан ASTM F136.',
        format: 'carousel',
        thumb: 'https://cdn4.telesco.pe/file/ear-project.jpg',
      },
    ]);
  });
});

describe('collectStats: Telegram', () => {
  it('collects the channel of the profile only: posts, our post numbers, the day snapshot and history', async () => {
    t.gateway.channels.push({
      info: { id: CHANNEL_ID, type: 'channel', title: 'MIKAN', username: 'mikan_studio' },
      membership: { status: 'administrator', canPostMessages: true },
      members: 1500,
    });
    const studio = addAccount('studio', 'telegram', 'mikan_studio', String(CHANNEL_ID));
    const author = addAccount('author', 'telegram', 'amina_art', '-1009999999999');
    const ours = await insertPost(t.ctx, { profile: 'studio', platform: 'telegram', format: 'post', publishAt: null, topic: 'Стерильность' });
    await updatePost(t.ctx, ours, { status: 'published', tgMessageId: 41, publishedAt: '2026-10-20T09:00:00.000Z', stats: { likes: 2 } });
    // The same message number in the author profile is another post.
    const authors = await insertPost(t.ctx, { profile: 'author', platform: 'telegram', format: 'post', publishAt: null, topic: 'Личное' });
    await updatePost(t.ctx, authors, { status: 'published', tgMessageId: 41, publishedAt: '2026-10-20T09:00:00.000Z' });
    answer = (req) => (req.target.search ? new Response('<html></html>') : new Response(FIXTURE, { headers: { 'content-type': 'text/html' } }));

    await collectStats(t.ctx, 'studio');

    expect(requests.map((r) => r.url)).toEqual([
      `${RELAY_ROOT}/web/${RELAY_KEY}/t.me/s/mikan_studio`,
      `${RELAY_ROOT}/web/${RELAY_KEY}/t.me/s/mikan_studio?before=41`,
    ]);
    const rows = t.ctx.db.select().from(smmPlatformPosts).all();
    expect(rows.map((r) => [r.accountId, r.extId, r.views, r.reactions, r.postId])).toEqual([
      [studio, '41', 1200, 15, ours],
      [studio, '42', 850, 0, null],
    ]);
    expect((await post(ours)).stats).toEqual({ likes: 2, views: 1200, reactions: 15, source: 'auto' });
    expect((await post(authors)).stats).toEqual({});
    const row = account(studio);
    expect(row).toMatchObject({ followers: 1500, statsError: null });
    expect(JSON.parse(row.statsJson)).toMatchObject({ views: 1025, posts: 2, engagement: 68.3, tg: { avgViews: 1025, reactions30: 15 } });
    expect(await accountHistory(t.ctx, 'studio')).toEqual([
      { accountId: studio, day: studioDate(t.ctx), followers: 1500, views: 1025, reach: null, newFollowers: null },
    ]);
    expect(await accountHistory(t.ctx, 'author')).toEqual([]);
    expect(account(author).statsAt).toBeNull();
  });

  it('says what is wrong when neither the bot nor the channel page gives numbers', async () => {
    const studio = addAccount('studio', 'telegram', 'mikan_studio', String(CHANNEL_ID));

    await collectStats(t.ctx, 'studio');

    expect(account(studio).statsError).toMatch(/администратор канала/);
  });
});

describe('Instagram API', () => {
  const me = { user_id: IG_ID, username: 'mikan.studio', name: 'MIKAN', account_type: 'BUSINESS', followers_count: 920 };
  const graphMe = (req: Request) => (req.target.host === 'graph.instagram.com' && req.target.pathname === '/v25.0/me' ? json(me) : null);

  it('connect: checks the key through the relay, keeps it encrypted for that profile only, makes the account publishable', async () => {
    answer = (req) => graphMe(req) ?? json({ error: { message: 'unexpected' } }, 400);

    const state = await connectInstagram(t.ctx, 'studio', `Bearer ${TOKEN}`, 1);

    expect(state).toEqual({
      userId: IG_ID,
      username: 'mikan.studio',
      name: 'MIKAN',
      accountType: 'BUSINESS',
      tokenSetAt: new Date(NOW).toISOString(),
      expiresAt: new Date(NOW + 60 * DAY).toISOString(),
      error: null,
    });
    expect(requests[0]!.url.startsWith(`${RELAY_ROOT}/web/${RELAY_KEY}/graph.instagram.com/v25.0/me?`)).toBe(true);
    expect(requests[0]!.target.searchParams.get('access_token')).toBe(TOKEN);
    const stored = readKey<{ tokenEnc: string; updatedBy: number }>(t.ctx.db, 'smm_instagram:studio')!;
    expect(JSON.stringify(stored)).not.toContain(TOKEN);
    expect(decryptSecret(t.ctx, stored.tokenEnc)).toBe(TOKEN);
    expect(stored.updatedBy).toBe(1);
    expect(await instagramState(t.ctx, 'studio')).toEqual(state);
    expect(await instagramState(t.ctx, 'author')).toBeNull();

    // Connecting again updates the same account of the profile.
    await connectInstagram(t.ctx, 'studio', TOKEN, 1);
    const accounts = t.ctx.db.select().from(smmAccounts).all();
    expect(accounts.map((a) => [a.profile, a.platform, a.handle, a.title, a.canPublish, a.followers])).toEqual([
      ['studio', 'instagram', 'mikan.studio', '@mikan.studio', true, 920],
    ]);

    await disconnectInstagram(t.ctx, 'studio');
    expect(await instagramState(t.ctx, 'studio')).toBeNull();
    expect(t.ctx.db.select().from(smmAccounts).get()!.canPublish).toBe(false);
  });

  it('refuses a key that is not a key, and explains a key Meta rejects', async () => {
    await expect(connectInstagram(t.ctx, 'author', 'short token', null)).rejects.toThrow(/не похоже на ключ/);
    expect(requests).toHaveLength(0);
    answer = () => json({ error: { message: 'Invalid OAuth access token', code: 190 } }, 400);
    await expect(connectInstagram(t.ctx, 'author', TOKEN, null)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/недействителен или истёк/) });
    expect(await instagramState(t.ctx, 'author')).toBeNull();
  });

  it('refreshes the key when less than 20 days are left (and it is at least a day old)', async () => {
    expect(tokenNeedsRefresh({ tokenSetAt: new Date(NOW - 41 * DAY).toISOString(), expiresAt: new Date(NOW + 19 * DAY).toISOString() }, NOW)).toBe(true);
    expect(tokenNeedsRefresh({ tokenSetAt: new Date(NOW - 10 * DAY).toISOString(), expiresAt: new Date(NOW + 50 * DAY).toISOString() }, NOW)).toBe(false);
    expect(tokenNeedsRefresh({ tokenSetAt: new Date(NOW - 3_600_000).toISOString(), expiresAt: new Date(NOW + 5 * DAY).toISOString() }, NOW)).toBe(false);

    const fresh = `IGAAN${'n'.repeat(60)}`;
    answer = (req) =>
      graphMe(req) ??
      (req.target.pathname === '/refresh_access_token' ? json({ access_token: fresh, token_type: 'bearer', expires_in: 60 * 86_400 }) : json({}, 404));
    await connectInstagram(t.ctx, 'studio', TOKEN, null);

    vi.setSystemTime(NOW + 10 * DAY);
    await refreshInstagramToken(t.ctx, 'studio');
    await refreshInstagramToken(t.ctx, 'author');
    expect(requests.filter((r) => r.target.pathname === '/refresh_access_token')).toHaveLength(0);

    vi.setSystemTime(NOW + 41 * DAY);
    await refreshInstagramToken(t.ctx, 'studio');
    const refresh = requests.find((r) => r.target.pathname === '/refresh_access_token')!;
    expect(refresh.target.searchParams.get('grant_type')).toBe('ig_refresh_token');
    expect(refresh.target.searchParams.get('access_token')).toBe(TOKEN);
    const stored = readKey<{ tokenEnc: string }>(t.ctx.db, 'smm_instagram:studio')!;
    expect(decryptSecret(t.ctx, stored.tokenEnc)).toBe(fresh);
    expect(await instagramState(t.ctx, 'studio')).toMatchObject({
      tokenSetAt: new Date(NOW + 41 * DAY).toISOString(),
      expiresAt: new Date(NOW + 101 * DAY).toISOString(),
      error: null,
    });

    // Meta refuses: the error is shown in the settings, the key stays.
    answer = () => json({ error: { message: 'Session has expired', code: 190 } }, 400);
    vi.setSystemTime(NOW + 82 * DAY);
    await refreshInstagramToken(t.ctx, 'studio');
    expect((await instagramState(t.ctx, 'studio'))!.error).toMatch(/недействителен или истёк/);
    expect(decryptSecret(t.ctx, readKey<{ tokenEnc: string }>(t.ctx.db, 'smm_instagram:studio')!.tokenEnc)).toBe(fresh);
  });

  it('publishes a JPEG post by the public relay link of our file; a PNG is refused before Meta sees it', async () => {
    answer = (req) => {
      const p = req.target.pathname;
      if (p === '/v25.0/me') return json(me);
      if (p === `/v25.0/${IG_ID}/media` && req.method === 'POST') return json({ id: 'container-1' });
      if (p === '/v25.0/container-1') return json({ status_code: 'FINISHED' });
      if (p === `/v25.0/${IG_ID}/media_publish`) return json({ id: 'media-1' });
      if (p === '/v25.0/media-1') return json({ permalink: 'https://www.instagram.com/p/XYZ123/' });
      return json({ error: { message: `unexpected ${p}` } }, 400);
    };
    await connectInstagram(t.ctx, 'studio', TOKEN, null);
    const id = await insertPost(t.ctx, { profile: 'studio', platform: 'instagram', format: 'post', publishAt: null, topic: 'Эскиз' });
    await updatePost(t.ctx, id, { body: 'Новый **эскиз** недели' });
    const url = await saveSmmFile(t.ctx, JPEG, 'jpg');
    await insertMedia(t.ctx, { postId: id, kind: 'image', source: 'ai', status: 'done', url });
    const authors = await insertPost(t.ctx, { profile: 'author', platform: 'instagram', format: 'post', publishAt: null, topic: 'Личное' });
    await insertMedia(t.ctx, { postId: authors, kind: 'image', source: 'ai', status: 'done', url });

    expect(await instagramCanPublish(t.ctx, await post(id))).toBe(true);
    expect(await instagramCanPublish(t.ctx, await post(authors))).toBe(false);

    expect(await publishToInstagram(t.ctx, await post(id))).toEqual({ mediaId: 'media-1', url: 'https://www.instagram.com/p/XYZ123/' });
    const created = new URLSearchParams(requests.find((r) => r.target.pathname === `/v25.0/${IG_ID}/media`)!.body!);
    expect(created.get('image_url')).toBe(`${RELAY_ROOT}/media/${path.basename(url)}`);
    expect(created.get('caption')).toBe('Новый эскиз недели');
    expect(new URLSearchParams(requests.find((r) => r.target.pathname.endsWith('/media_publish'))!.body!).get('creation_id')).toBe('container-1');

    const png = await insertPost(t.ctx, { profile: 'studio', platform: 'instagram', format: 'post', publishAt: null, topic: 'PNG' });
    await insertMedia(t.ctx, { postId: png, kind: 'image', source: 'upload', status: 'done', url: await saveSmmFile(t.ctx, PNG, 'png') });
    const before = requests.length;
    await expect(publishToInstagram(t.ctx, await post(png))).rejects.toThrow(/только в JPEG/);
    expect(requests).toHaveLength(before);
  });

  it('a post with a non-JPEG picture among the ones to publish goes to a person, not to the slot', async () => {
    answer = (req) => graphMe(req) ?? json({ error: { message: 'unexpected' } }, 400);
    await connectInstagram(t.ctx, 'studio', TOKEN, null);
    const jpeg = await saveSmmFile(t.ctx, JPEG, 'jpg');
    const png = await saveSmmFile(t.ctx, PNG, 'png');
    const webp = await saveSmmFile(t.ctx, Buffer.from('RIFF\0\0\0\0WEBPVP8 '), 'webp');
    const make = async (format: string, urls: string[]) => {
      const id = await insertPost(t.ctx, { profile: 'studio', platform: 'instagram', format, publishAt: null, topic: format });
      for (const [sort, url] of urls.entries()) await insertMedia(t.ctx, { postId: id, kind: 'image', source: 'upload', status: 'done', url, sort });
      return post(id);
    };

    expect(await instagramCanPublish(t.ctx, await make('carousel', [jpeg, jpeg]))).toBe(true);
    expect(await instagramCanPublish(t.ctx, await make('carousel', [jpeg, png]))).toBe(false);
    expect(await instagramCanPublish(t.ctx, await make('story', [webp]))).toBe(false);
    // A single post publishes the first picture only.
    expect(await instagramCanPublish(t.ctx, await make('post', [jpeg, png]))).toBe(true);
    expect(await instagramCanPublish(t.ctx, await make('post', [png]))).toBe(false);
    expect(requests.filter((r) => r.method === 'POST')).toHaveLength(0);
  });

  it('a switched-off Instagram platform stops auto-publishing; deleting it disconnects the key', async () => {
    answer = (req) => graphMe(req) ?? json({ error: { message: 'unexpected' } }, 400);
    await connectInstagram(t.ctx, 'studio', TOKEN, null);
    const id = await insertPost(t.ctx, { profile: 'studio', platform: 'instagram', format: 'post', publishAt: null, topic: 'Эскиз' });
    await insertMedia(t.ctx, { postId: id, kind: 'image', source: 'ai', status: 'done', url: await saveSmmFile(t.ctx, JPEG, 'jpg') });
    const instagram = t.ctx.db.select().from(smmAccounts).where(eq(smmAccounts.platform, 'instagram')).get()!;
    expect(await instagramCanPublish(t.ctx, await post(id))).toBe(true);

    expect((await t.api('PATCH', `/api/smm/studio/accounts/${instagram.id}`, { isActive: false })).statusCode).toBe(200);
    expect(await instagramCanPublish(t.ctx, await post(id))).toBe(false);
    expect(await instagramState(t.ctx, 'studio')).not.toBeNull();
    expect((await t.api('PATCH', `/api/smm/studio/accounts/${instagram.id}`, { isActive: true })).statusCode).toBe(200);
    expect(await instagramCanPublish(t.ctx, await post(id))).toBe(true);

    // Another (manually added) Instagram row of the profile does not keep the deleted account connected.
    addAccount('studio', 'instagram', 'someone.else');
    const res = await t.api('DELETE', `/api/smm/studio/accounts/${instagram.id}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(await instagramState(t.ctx, 'studio')).toBeNull();
    expect(readKey(t.ctx.db, 'smm_instagram:studio')).toBeNull();
    expect(await instagramCanPublish(t.ctx, await post(id))).toBe(false);
  });

  it('deleting a Telegram channel leaves the Instagram key alone', async () => {
    answer = (req) => graphMe(req) ?? json({ error: { message: 'unexpected' } }, 400);
    await connectInstagram(t.ctx, 'studio', TOKEN, null);
    const channel = addAccount('studio', 'telegram', 'mikan_studio', String(CHANNEL_ID));

    expect((await t.api('DELETE', `/api/smm/studio/accounts/${channel}`)).statusCode).toBe(200);

    expect(await instagramState(t.ctx, 'studio')).not.toBeNull();
  });
});
