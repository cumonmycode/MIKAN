import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { smmAccounts } from '../db/schema.js';
import { errorMessage } from '../lib/errors.js';
import type { EmployeeRow } from '../lib/serialize.js';
import { parse } from '../lib/validation.js';
import { monthSpend, polzaBalance, smmModels } from '../smm/ai.js';
import { listAccounts } from '../smm/db.js';
import { connectInstagram, disconnectInstagram, instagramState } from '../smm/instagram.js';
import {
  albumPhotos,
  connectLibrary,
  disconnectLibrary,
  libraryAlbums,
  libraryCounts,
  libraryState,
  searchLibrary,
  syncLibrary,
} from '../smm/library.js';
import { getSmmSettings, saveSmmSettings, SettingsSchema, type SmmSettings } from '../smm/settings.js';
import { collectStats } from '../smm/stats.js';
import { checkChannel } from '../smm/telegram.js';
import { ACCOUNT_PLATFORMS, SmmError, type SmmProfile } from '../smm/types.js';
import { assertEmployees, param, people, profileOf, SMM_BASE } from './smm.js';

/**
 * SMM settings of a profile (ported from Titan HUB `smm.router.ts`, where they were owner-only; in MIKAN any
 * signed-in employee may change them): voice, cadence, approvers and the publisher, the AI budget; the profile's
 * platforms (its own Telegram channel and Instagram), the Instagram API connection and the photo archive.
 */

const LIBRARY_SEARCH_LIMIT = 60;

const SettingsPatchSchema = SettingsSchema.partial().extend({ cadence: SettingsSchema.shape.cadence.partial().optional() });
const AccountSchema = z.object({
  platform: z.enum(ACCOUNT_PLATFORMS),
  input: z.string().trim().min(2).max(300),
  title: z.string().trim().max(80).optional(),
});
const AccountPatchSchema = z.object({
  isActive: z.boolean().optional(),
  title: z.string().trim().min(1).max(80).optional(),
});
const TokenSchema = z.object({ token: z.string().trim().min(20).max(1000) });
const LibraryLinkSchema = z.object({ link: z.string().trim().min(10).max(500) });

/** @name from a profile link: instagram.com/mikan.studio → mikan.studio. */
function handleFrom(input: string): string | null {
  const raw = input.trim();
  const fromUrl = /(?:instagram\.com|vk\.com|vk\.ru|t\.me)\/([A-Za-z0-9._-]{2,})/i.exec(raw)?.[1];
  const plain = /^@?([A-Za-z0-9._-]{2,})$/.exec(raw)?.[1];
  return fromUrl ?? plain ?? null;
}

export function smmSettingsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const B = SMM_BASE;
  const logFailure = (err: unknown, what: string) => ctx.log.warn({ err: errorMessage(err) }, `smm: ${what} failed`);

  async function settingsPayload(profile: SmmProfile, viewer: Pick<EmployeeRow, 'id'>) {
    const settings = getSmmSettings(ctx.db, profile);
    const [accounts, spent, balance] = await Promise.all([listAccounts(ctx, profile), monthSpend(ctx, profile), polzaBalance(ctx)]);
    // photos — an empty list for Titan-era clients: photos of places live in the knowledge base by zone.
    return {
      settings,
      accounts,
      photos: [],
      staff: people(ctx, viewer),
      spend: { month: Math.round(spent), budget: settings.monthlyBudget },
      balance,
      models: smmModels(ctx),
    };
  }

  app.get(`${B}/settings`, async (request) => settingsPayload(profileOf(request), request.employee));

  app.put(`${B}/settings`, async (request) => {
    const profile = profileOf(request);
    const patch = parse(SettingsPatchSchema, request.body);
    assertEmployees(ctx, [...(patch.approverIds ?? []), ...(patch.publisherId ? [patch.publisherId] : [])]);
    saveSmmSettings(ctx.db, profile, patch as Partial<SmmSettings>);
    return settingsPayload(profile, request.employee);
  });

  async function accountOr404(profile: SmmProfile, id: string) {
    const account = (await listAccounts(ctx, profile)).find((a) => a.id === id);
    if (!account) throw new SmmError('Площадка не найдена', 404);
    return account;
  }

  app.post(`${B}/accounts`, async (request) => {
    const profile = profileOf(request);
    const body = parse(AccountSchema, request.body);
    const now = Date.now();
    const base = { id: randomUUID(), profile, platform: body.platform, createdAt: now, updatedAt: now };
    if (body.platform === 'telegram') {
      const ch = await checkChannel(ctx, body.input);
      ctx.db.transaction((tx) => {
        tx.delete(smmAccounts)
          .where(and(eq(smmAccounts.profile, profile), eq(smmAccounts.platform, 'telegram'), eq(smmAccounts.tgChatId, ch.chatId)))
          .run();
        tx.insert(smmAccounts)
          .values({
            ...base,
            title: body.title || ch.title,
            url: ch.handle ? `https://t.me/${ch.handle}` : null,
            handle: ch.handle,
            tgChatId: ch.chatId,
            canPublish: ch.canPublish,
            statsError: ch.problem,
          })
          .run();
      });
    } else {
      const handle = handleFrom(body.input);
      const url = /^https:\/\//.test(body.input)
        ? body.input
        : handle && body.platform === 'instagram'
          ? `https://www.instagram.com/${handle}/`
          : null;
      if (!handle && !url) throw new SmmError('Укажите ссылку на профиль или @имя');
      ctx.db
        .insert(smmAccounts)
        .values({ ...base, title: body.title || (handle ? `@${handle}` : body.platform), url, handle })
        .run();
    }
    await collectStats(ctx, profile).catch((err) => logFailure(err, 'stats'));
    return settingsPayload(profile, request.employee);
  });

  app.patch(`${B}/accounts/:accountId`, async (request) => {
    const profile = profileOf(request);
    const account = await accountOr404(profile, param(request, 'accountId'));
    const body = parse(AccountPatchSchema, request.body);
    const set = {
      ...(body.isActive === undefined ? {} : { isActive: body.isActive }),
      ...(body.title ? { title: body.title } : {}),
    };
    if (Object.keys(set).length) {
      ctx.db.update(smmAccounts).set({ ...set, updatedAt: Date.now() }).where(eq(smmAccounts.id, account.id)).run();
    }
    return settingsPayload(profile, request.employee);
  });

  /** Re-check a channel: the bot became an admin — it can publish now. */
  app.post(`${B}/accounts/:accountId/check`, async (request) => {
    const profile = profileOf(request);
    const account = await accountOr404(profile, param(request, 'accountId'));
    if (account.platform === 'telegram' && account.tgChatId) {
      const ch = await checkChannel(ctx, account.tgChatId);
      ctx.db
        .update(smmAccounts)
        .set({ canPublish: ch.canPublish, handle: ch.handle, statsError: ch.problem, updatedAt: Date.now() })
        .where(eq(smmAccounts.id, account.id))
        .run();
    }
    await collectStats(ctx, profile).catch((err) => logFailure(err, 'stats'));
    return settingsPayload(profile, request.employee);
  });

  app.delete(`${B}/accounts/:accountId`, async (request) => {
    const profile = profileOf(request);
    const account = await accountOr404(profile, param(request, 'accountId'));
    ctx.db.delete(smmAccounts).where(eq(smmAccounts.id, account.id)).run();
    // The connected Instagram account is gone: drop its key too, or the marketer would keep publishing there.
    if (account.platform === 'instagram') {
      const state = await instagramState(ctx, profile);
      const left = (await listAccounts(ctx, profile)).some(
        (a) => a.platform === 'instagram' && a.handle?.toLowerCase() === state?.username.toLowerCase(),
      );
      if (state && !left) await disconnectInstagram(ctx, profile);
    }
    return settingsPayload(profile, request.employee);
  });

  // ─── Instagram API ─────────────────────────────────────────────────────────

  app.get(`${B}/instagram`, async (request) => {
    const state = await instagramState(ctx, profileOf(request));
    return { connected: !!state, state };
  });

  app.put(`${B}/instagram`, async (request) => {
    const profile = profileOf(request);
    const { token } = parse(TokenSchema, request.body);
    const state = await connectInstagram(ctx, profile, token, request.employee.id);
    await collectStats(ctx, profile).catch((err) => logFailure(err, 'stats'));
    return { connected: true, state };
  });

  app.delete(`${B}/instagram`, async (request) => {
    await disconnectInstagram(ctx, profileOf(request));
    return { connected: false, state: null };
  });

  // ─── Photo archive (Google Drive) ──────────────────────────────────────────

  async function libraryPayload(profile: SmmProfile) {
    const [state, counts, albums] = await Promise.all([
      libraryState(ctx, profile),
      libraryCounts(ctx, profile),
      libraryAlbums(ctx, profile),
    ]);
    return { connected: !!state, state, counts, albums: state ? albums : [] };
  }

  app.get(`${B}/library`, async (request) => libraryPayload(profileOf(request)));

  app.put(`${B}/library`, async (request) => {
    const profile = profileOf(request);
    await connectLibrary(ctx, profile, parse(LibraryLinkSchema, request.body).link);
    return libraryPayload(profile);
  });

  app.delete(`${B}/library`, async (request) => {
    const profile = profileOf(request);
    await disconnectLibrary(ctx, profile);
    return libraryPayload(profile);
  });

  /** Re-read the archive now (new albums and photos) — in the background, the bar is in the state. */
  app.post(`${B}/library/sync`, async (request) => {
    const profile = profileOf(request);
    void syncLibrary(ctx, profile).catch((err) => logFailure(err, 'library sync'));
    return libraryPayload(profile);
  });

  app.get(`${B}/library/albums/:albumId`, async (request) => {
    const profile = profileOf(request);
    const id = param(request, 'albumId');
    if (!/^[\w-]{10,80}$/.test(id)) throw new SmmError('Альбом не найден', 404);
    return { photos: await albumPhotos(ctx, profile, id) };
  });

  /** Search by archive descriptions — the same the marketer uses. */
  app.get(`${B}/library/search`, async (request) => {
    const profile = profileOf(request);
    const q = String((request.query as { q?: unknown }).q ?? '')
      .trim()
      .slice(0, 200);
    if (q.length < 2) return { photos: [] };
    const photos = await searchLibrary(ctx, profile, q, {
      limit: LIBRARY_SEARCH_LIMIT,
      kinds: ['photo', 'template', 'logo', 'design'],
      perAlbum: LIBRARY_SEARCH_LIMIT,
      minQuality: 1,
    });
    return { photos };
  });
}
