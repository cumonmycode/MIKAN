import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { silentLogger, type AppContext } from '../src/context.js';
import { openDatabase } from '../src/db/client.js';
import { services } from '../src/db/schema.js';
import { smmLibrary, smmLibraryFolders, smmMedia, smmPosts } from '../src/db/schema-smm.js';
import { seedDatabase } from '../src/db/seed.js';
import { writeKey } from '../src/domain/settings.js';
import { chatJson, generateImage, pollVideo, startVideo } from '../src/smm/ai.js';
import { claimPost, insertMedia, insertPost, loadPost } from '../src/smm/db.js';
import {
  albumPhotos,
  archiveCandidates,
  archiveLine,
  connectLibrary,
  cropUrl,
  describePending,
  folderIdFrom,
  libraryAlbums,
  libraryCounts,
  libraryPhotos,
  libraryState,
  searchLibrary,
  syncLibrary,
  type LibraryState,
} from '../src/smm/library.js';
import { addArchivePhoto, addUpload, generateImages, pollVideos, safePrompt } from '../src/smm/media.js';
import { saveSmmSettings } from '../src/smm/settings.js';
import { makePostVideo } from '../src/smm/video.js';
import { SmmError, type SmmProfile } from '../src/smm/types.js';
import { FakeGateway, noImageGenerator, testConfig } from './helpers.js';

vi.mock('../src/smm/ai.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/smm/ai.js')>();
  return { ...actual, chatJson: vi.fn(), generateImage: vi.fn(), startVideo: vi.fn(), pollVideo: vi.fn() };
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(64)]);
const MOV = Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypqt  '), Buffer.alloc(64)]);
const ROOT = 'rootFolder0123456789AB';
const SUB = 'subFolder0123456789';

/** Страница встраивания папки Диска — как её отдаёт Google. */
function folderHtml(title: string, entries: { id: string; title: string; mime?: string; folder?: boolean }[]): string {
  const blocks = entries.map((e) =>
    e.folder
      ? `<div class="flip-entry" id="entry-${e.id}"><a href="https://drive.google.com/drive/folders/${e.id}"><div class="flip-entry-title">${e.title}</div></a></div>`
      : `<div class="flip-entry" id="entry-${e.id}"><a href="https://drive.google.com/file/d/${e.id}/view"><img src="https://drive-thirdparty.googleusercontent.com/16/type/${e.mime ?? 'image/jpeg'}"><div class="flip-entry-title">${e.title}</div></a></div>`,
  );
  return `<html><head><title>${title}</title></head><body>${blocks.join('')}</body></html>`;
}

interface FakeNet {
  folders: Map<string, string>;
  urls: string[];
}

function fakeFetch(net: FakeNet): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    net.urls.push(url);
    if (url.startsWith('https://drive.google.com/embeddedfolderview')) {
      const id = new URL(url).searchParams.get('id') ?? '';
      const html = net.folders.get(id);
      return html ? new Response(html, { status: 200 }) : new Response('nope', { status: 404 });
    }
    if (url.startsWith('https://lh3.googleusercontent.com/')) return new Response(JPEG, { status: 200 });
    if (url.startsWith('https://polza.test/')) return new Response(url.endsWith('.mp4') ? MP4 : PNG, { status: 200 });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

let ctx: AppContext;
let net: FakeNet;

beforeEach(() => {
  const config = testConfig({ PUBLIC_URL: 'https://mikan.test' });
  const { db, sqlite } = openDatabase(':memory:');
  seedDatabase(db, config);
  net = { folders: new Map(), urls: [] };
  ctx = {
    db,
    sqlite,
    config,
    log: silentLogger,
    gateway: new FakeGateway(),
    ai: null,
    generateImage: noImageGenerator,
    qr: null,
    onBotSettingsChanged: () => undefined,
    smmFetch: fakeFetch(net),
  };
  vi.mocked(chatJson).mockReset();
  vi.mocked(generateImage).mockReset();
  vi.mocked(startVideo).mockReset();
  vi.mocked(pollVideo).mockReset();
});

afterEach(() => {
  ctx.sqlite.close();
  fs.rmSync(ctx.config.dataDir, { recursive: true, force: true });
});

/** Подключение запускает обход в фоне — ждём, пока он закончится. */
async function synced(profile: SmmProfile): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const state = await libraryState(ctx, profile);
    if (state?.syncedAt && !state.progress) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('library sync did not finish');
}

function connectState(profile: SmmProfile): void {
  const state: LibraryState = {
    folderId: ROOT,
    url: `https://drive.google.com/drive/folders/${ROOT}`,
    title: 'Архив',
    connectedAt: new Date().toISOString(),
    syncedAt: null,
    error: null,
    progress: null,
  };
  writeKey(ctx.db, `smm_library:${profile}`, state);
}

interface Row {
  id: string;
  folder?: string;
  path?: string;
  description: string;
  tags?: string;
  quality?: number | null;
  used?: number;
  kind?: string;
}

function addPhotos(profile: SmmProfile, rows: Row[]): void {
  const now = Date.now();
  for (const r of rows) {
    ctx.db
      .insert(smmLibrary)
      .values({
        profile,
        driveId: r.id,
        folderId: r.folder ?? 'album-a',
        path: r.path ?? 'Работы / Тату',
        name: `${r.id}.jpg`,
        mime: 'image/jpeg',
        kind: r.kind ?? 'photo',
        description: r.description,
        tags: r.tags ?? '',
        quality: r.quality === undefined ? 4 : r.quality,
        usedCount: r.used ?? 0,
        seenAt: now,
        createdAt: now,
      })
      .run();
  }
}

async function newPost(profile: SmmProfile, format: 'post' | 'carousel' | 'story' | 'reel' = 'post'): Promise<string> {
  return insertPost(ctx, {
    profile,
    platform: 'instagram',
    format,
    publishAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    topic: 'Графика на предплечье',
    brief: 'Показать свежую графику',
  });
}

describe('library links', () => {
  it('extracts the folder id from a Drive link and builds the crop link per format', () => {
    expect(folderIdFrom(`https://drive.google.com/drive/folders/${ROOT}?usp=sharing`)).toBe(ROOT);
    expect(folderIdFrom('просто текст')).toBeNull();
    expect(cropUrl('abc', '9:16')).toContain('w1080-h1920');
    expect(cropUrl('abc', '4:5')).toContain('w1080-h1350');
  });
});

describe('library sync', () => {
  beforeEach(() => {
    net.folders.set(
      ROOT,
      folderHtml('Архив студии', [
        { id: 'file-root-1', title: 'cover.jpg' },
        { id: 'file-doc', title: 'notes.pdf', mime: 'application/pdf' },
        { id: SUB, title: 'Тату', folder: true },
      ]),
    );
    net.folders.set(
      SUB,
      folderHtml('Тату', [
        { id: 'file-sub-1', title: 'IMG_1.jpg' },
        { id: 'file-sub-2', title: 'reel.mov', mime: 'video/quicktime' },
      ]),
    );
  });

  it('connects a public folder and walks albums and files into the profile only', async () => {
    const state = await connectLibrary(ctx, 'author', `https://drive.google.com/drive/folders/${ROOT}`);
    expect(state.title).toBe('Архив студии');
    await synced('author');

    const files = ctx.db.select().from(smmLibrary).all();
    expect(files.map((f) => f.driveId).sort()).toEqual(['file-root-1', 'file-sub-1', 'file-sub-2']);
    expect(files.every((f) => f.profile === 'author')).toBe(true);
    expect(files.find((f) => f.driveId === 'file-sub-2')?.kind).toBe('video');
    expect(files.find((f) => f.driveId === 'file-sub-1')?.path).toBe('Тату');
    expect((await libraryState(ctx, 'author'))?.syncedAt).not.toBeNull();
    expect(await libraryState(ctx, 'studio')).toBeNull();
    expect(await libraryCounts(ctx, 'author')).toEqual({ albums: 2, files: 3, described: 0 });
    expect(await libraryCounts(ctx, 'studio')).toEqual({ albums: 0, files: 0, described: 0 });
  });

  it('keeps descriptions of known files and drops files gone from Drive after a full walk', async () => {
    await connectLibrary(ctx, 'studio', ROOT);
    await synced('studio');
    ctx.db
      .update(smmLibrary)
      .set({ description: 'Графика на предплечье', kind: 'template' })
      .where(eq(smmLibrary.driveId, 'file-sub-1'))
      .run();
    net.folders.set(SUB, folderHtml('Тату', [{ id: 'file-sub-1', title: 'IMG_1 renamed.jpg' }]));
    await new Promise((r) => setTimeout(r, 2));
    await syncLibrary(ctx, 'studio');

    const files = ctx.db.select().from(smmLibrary).where(eq(smmLibrary.profile, 'studio')).all();
    expect(files.map((f) => f.driveId).sort()).toEqual(['file-root-1', 'file-sub-1']);
    const kept = files.find((f) => f.driveId === 'file-sub-1')!;
    expect(kept.description).toBe('Графика на предплечье');
    expect(kept.kind).toBe('template');
    expect(kept.name).toBe('IMG_1 renamed.jpg');
  });

  it('refuses a link that is not a folder', async () => {
    await expect(connectLibrary(ctx, 'studio', 'https://example.com')).rejects.toBeInstanceOf(SmmError);
  });

  it('describes new photos of every connected enabled profile through the vision model', async () => {
    saveSmmSettings(ctx.db, 'author', { enabled: true });
    connectState('studio');
    connectState('author');
    addPhotos('studio', [{ id: 'st-1', description: '' }]);
    addPhotos('author', [{ id: 'au-1', description: '' }]);
    vi.mocked(chatJson).mockImplementation(async (_ctx, _profile, opts) =>
      opts.schema.parse({ items: [{ n: 1, description: 'Эскиз розы', tags: 'эскиз', quality: 5, people: 0 }] }),
    );
    expect(await describePending(ctx)).toBe(2);
    const profiles = vi.mocked(chatJson).mock.calls.map((c) => c[1]).sort();
    expect(profiles).toEqual(['author', 'studio']);
    const rows = ctx.db.select().from(smmLibrary).all();
    expect(rows.every((r) => r.description === 'Эскиз розы' && r.quality === 5)).toBe(true);
  });

  it('does not bill a disabled profile for describing its archive (the author is off by default)', async () => {
    connectState('studio');
    connectState('author');
    addPhotos('studio', [{ id: 'st-1', description: '' }]);
    addPhotos('author', [{ id: 'au-1', description: '' }]);
    vi.mocked(chatJson).mockImplementation(async (_ctx, _profile, opts) =>
      opts.schema.parse({ items: [{ n: 1, description: 'Эскиз розы', tags: 'эскиз', quality: 5, people: 0 }] }),
    );

    expect(await describePending(ctx)).toBe(1);

    expect(vi.mocked(chatJson).mock.calls.map((c) => c[1])).toEqual(['studio']);
    const author = ctx.db.select().from(smmLibrary).where(eq(smmLibrary.profile, 'author')).get()!;
    expect(author.description).toBe('');
  });
});

describe('library search', () => {
  it('ranks by match, quality and usage, ignores word endings and the case of Cyrillic', async () => {
    addPhotos('studio', [
      { id: 'best', description: 'Графическая татуировка на предплечье, чёткие линии', quality: 5, folder: 'a1' },
      { id: 'used', description: 'Графическая татуировка на предплечье, крупно', quality: 5, used: 6, folder: 'a2' },
      { id: 'weak', description: 'Татуировки мастера на выставке', quality: 3, folder: 'a3' },
      { id: 'other', description: 'Прокол хеликса, титановое кольцо', quality: 5, folder: 'a4' },
      { id: 'bad', description: 'Татуировка, смазанный кадр', quality: 1, folder: 'a5' },
      { id: 'empty', description: '', folder: 'a6' },
    ]);
    const found = await searchLibrary(ctx, 'studio', 'татуировку на предплечье графика');
    const ids = found.map((p) => p.id);
    expect(ids[0]).toBe('best');
    expect(ids.indexOf('best')).toBeLessThan(ids.indexOf('used'));
    expect(ids).toContain('weak');
    expect(ids).not.toContain('other');
    expect(ids).not.toContain('bad');
    expect(ids).not.toContain('empty');
    expect(found[0]?.source).toBe('drive');
    expect(found[0]?.thumb).toContain('lh3.googleusercontent.com');
  });

  it('matches album names written with a capital letter', async () => {
    addPhotos('studio', [{ id: 'album-hit', description: 'Свежая работа крупным планом', path: 'Работы / Пирсинг' }]);
    expect((await searchLibrary(ctx, 'studio', 'пирсинг')).map((p) => p.id)).toEqual(['album-hit']);
  });

  it('limits photos per album and shows one photo of a series', async () => {
    addPhotos('studio', [
      { id: 's1', description: 'Тату розы на плече', folder: 'one' },
      { id: 's2', description: 'Тату розы на плече', folder: 'one' },
      { id: 's3', description: 'Тату розы на плече, другой ракурс', folder: 'one' },
      { id: 's4', description: 'Тату розы на плече, деталь', folder: 'one' },
      { id: 's5', description: 'Тату розы на плече, свет', folder: 'one' },
    ]);
    const found = await searchLibrary(ctx, 'studio', 'тату розы', { perAlbum: 3 });
    expect(found).toHaveLength(3);
    expect(found.map((p) => p.id)).not.toEqual(expect.arrayContaining(['s1', 's2']));
  });

  it('never returns photos of the other profile', async () => {
    addPhotos('author', [{ id: 'author-only', description: 'Эскиз дракона в блокноте' }]);
    addPhotos('studio', [{ id: 'studio-only', description: 'Эскиз дракона на стене студии' }]);
    expect((await searchLibrary(ctx, 'studio', 'эскиз дракона')).map((p) => p.id)).toEqual(['studio-only']);
    expect((await searchLibrary(ctx, 'author', 'эскиз дракона')).map((p) => p.id)).toEqual(['author-only']);
    expect(await libraryPhotos(ctx, 'studio', ['author-only'])).toEqual([]);
    expect((await albumPhotos(ctx, 'author', 'album-a')).map((p) => p.id)).toEqual(['author-only']);
  });

  it('lists albums with covers and described counts per profile', async () => {
    const now = Date.now();
    ctx.db
      .insert(smmLibraryFolders)
      .values([
        { profile: 'studio', driveId: 'album-a', path: 'Работы', title: 'Работы', files: 2, seenAt: now },
        { profile: 'author', driveId: 'album-a', path: 'Личное', title: 'Личное', files: 1, seenAt: now },
      ])
      .run();
    addPhotos('studio', [
      { id: 'c1', description: 'Работа', quality: 2 },
      { id: 'c2', description: '', quality: 5 },
    ]);
    const albums = await libraryAlbums(ctx, 'studio');
    expect(albums).toHaveLength(1);
    expect(albums[0]).toMatchObject({ title: 'Работы', files: 2, described: 1 });
    expect(albums[0]?.cover).toContain('c2');
  });
});

describe('archive candidates', () => {
  function addService(name: string, photos: string[]): void {
    const now = Date.now();
    ctx.db
      .insert(services)
      .values({ name, category: 'piercing', price: 3000, durationMin: 30, photosJson: JSON.stringify(photos), createdAt: now, updatedAt: now })
      .run();
  }

  it('adds real works of the studio catalog for the studio only, clearly marked', async () => {
    fs.mkdirSync(path.join(ctx.config.dataDir, 'uploads'), { recursive: true });
    fs.writeFileSync(path.join(ctx.config.dataDir, 'uploads', 'helix-1.jpg'), JPEG);
    addService('Прокол хеликса', ['/uploads/helix-1.jpg', '/uploads/helix-2.heic']);
    addService('Татуировка мини', ['/uploads/mini.jpg']);
    const post = { topic: 'Прокол хеликса: как заживает', brief: '', visual: '', direction: null, format: 'post' as const };

    const studio = await archiveCandidates(ctx, { ...post, profile: 'studio' });
    expect(studio.map((p) => p.id)).toEqual(['catalog:helix-1.jpg']);
    expect(studio[0]).toMatchObject({ source: 'catalog', url: '/uploads/helix-1.jpg' });
    expect(archiveLine(studio)).toContain('каталог услуг студии');
    expect(await archiveCandidates(ctx, { ...post, profile: 'author' })).toEqual([]);

    const postId = await newPost('studio');
    await addArchivePhoto(ctx, postId, 'catalog:helix-1.jpg');
    const media = (await loadPost(ctx, postId))!.media;
    expect(media).toHaveLength(1);
    expect(media[0]).toMatchObject({ source: 'archive', status: 'done', model: 'catalog' });
    expect(media[0]?.url).toMatch(/^\/uploads\/smm-.+\.jpg$/);
  });

  it('searches the archive only when the library of the profile is connected', async () => {
    addPhotos('studio', [{ id: 'arch-1', description: 'Графика на предплечье, свежая работа' }]);
    const post = { profile: 'studio' as const, topic: 'Графика на предплечье', brief: '', visual: '', direction: null, format: 'post' as const };
    expect((await archiveCandidates(ctx, post)).map((p) => p.id)).toEqual([]);
    connectState('studio');
    expect((await archiveCandidates(ctx, post)).map((p) => p.id)).toEqual(['arch-1']);
  });
});

describe('images', () => {
  it('keeps prompts free of words the image filter rejects', () => {
    const cleaned = safePrompt('Памятка по уходу, без крови и сосков, чистый фон. No blood, no nipples.');
    expect(cleaned).not.toMatch(/кров|соск|blood|nipple/i);
    expect(cleaned).toContain('Памятка по уходу');
    expect(safePrompt('Уютная кровать в зоне отдыха')).toBe('Уютная кровать в зоне отдыха');
  });

  it('stores generated pictures, archive photos as is and marks archive photos used', async () => {
    connectState('studio');
    addPhotos('studio', [{ id: 'arch-1', description: 'Графика на предплечье' }]);
    const postId = await newPost('studio', 'carousel');
    vi.mocked(generateImage).mockResolvedValue({ url: 'https://polza.test/out.png', cost: 4, model: 'image-model' });
    const [photo] = await libraryPhotos(ctx, 'studio', ['arch-1']);
    const post = (await loadPost(ctx, postId))!;
    await claimPost(ctx, postId, 'image');

    await generateImages(ctx, post, [
      { prompt: 'Обложка карусели: «Уход за тату», без крови', sort: 0 },
      { prompt: '', sort: 1, photo, mode: 'as_is' },
    ]);

    const media = ctx.db.select().from(smmMedia).where(eq(smmMedia.postId, postId)).all();
    const ai = media.find((m) => m.source === 'ai')!;
    const archive = media.find((m) => m.source === 'archive')!;
    expect(ai).toMatchObject({ status: 'done', model: 'image-model', costRub: 4, aspect: '4:5', sort: 0 });
    expect(ai.url).toMatch(/^\/uploads\/smm-.+\.png$/);
    expect(fs.existsSync(path.join(ctx.config.dataDir, ai.url!))).toBe(true);
    expect(vi.mocked(generateImage).mock.calls[0]?.[1]).toBe('studio');
    expect(vi.mocked(generateImage).mock.calls[0]?.[2].prompt).not.toMatch(/кров/i);
    expect(archive).toMatchObject({ status: 'done', sort: 1, model: 'google-drive' });
    expect(net.urls).toContain(cropUrl('arch-1', '4:5'));
    const used = ctx.db.select().from(smmLibrary).where(and(eq(smmLibrary.profile, 'studio'), eq(smmLibrary.driveId, 'arch-1'))).get();
    expect(used?.usedCount).toBe(1);
  });

  it('fails when no picture came out and keeps the error on the media', async () => {
    const postId = await newPost('studio');
    vi.mocked(generateImage).mockRejectedValue(new SmmError('Нейросеть отклонила запрос', 502));
    const post = (await loadPost(ctx, postId))!;
    await expect(generateImages(ctx, post, [{ prompt: 'Анонс флеш-дня, афиша', sort: 0 }])).rejects.toThrow('отклонила');
    const [media] = ctx.db.select().from(smmMedia).where(eq(smmMedia.postId, postId)).all();
    expect(media).toMatchObject({ status: 'failed', selected: false });
  });
});

describe('uploads', () => {
  it('stores a photo and a video from the phone as the last media', async () => {
    const postId = await newPost('author');
    await addUpload(ctx, postId, JPEG, 'image/jpeg');
    await addUpload(ctx, postId, MP4, 'video/mp4');
    await addUpload(ctx, postId, MOV, 'video/quicktime');
    const media = (await loadPost(ctx, postId))!.media;
    expect(media.map((m) => [m.kind, m.source])).toEqual([
      ['image', 'upload'],
      ['video', 'upload'],
      ['video', 'upload'],
    ]);
    expect(media[0]?.url).toMatch(/\.jpg$/);
    expect(media[1]?.url).toMatch(/\.mp4$/);
    expect(media[2]?.url).toMatch(/\.mov$/);
    expect(media.map((m) => m.sort)).toEqual([0, 1, 2]);
  });

  it('rejects HEIC (Telegram and Instagram cannot take it) and files that are not photos or videos', async () => {
    const postId = await newPost('studio');
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(32)]);
    await expect(addUpload(ctx, postId, heic, 'image/heic')).rejects.toMatchObject({ status: 400 });
    expect((await loadPost(ctx, postId))!.media).toHaveLength(0);
    await expect(addUpload(ctx, postId, Buffer.from('%PDF-1.7 fake'), 'image/jpeg')).rejects.toMatchObject({ status: 400 });
    await expect(addUpload(ctx, '00000000-0000-4000-8000-000000000000', JPEG, 'image/jpeg')).rejects.toMatchObject({ status: 404 });
  });
});

describe('video', () => {
  it('plans a scene, makes the first frame, starts the video and stores it when ready', async () => {
    const postId = await newPost('studio', 'reel');
    await claimPost(ctx, postId, 'video');
    vi.mocked(chatJson).mockImplementation(async (_ctx, _profile, opts) =>
      opts.schema.parse({
        scene: 'Мастер в перчатках готовит стерильный столик к сеансу',
        zone: null,
        usePostImage: false,
        keyframe: 'Руки мастера в чёрных перчатках раскладывают стерильные упаковки на столике, мягкий свет лампы',
        prompt: `Slow push-in on a tattoo artist's gloved hands arranging sterile packages, no blood. ${'Calm studio light. '.repeat(15)}`,
      }),
    );
    vi.mocked(generateImage).mockResolvedValue({ url: 'https://polza.test/frame.png', cost: 3, model: 'image-model' });
    vi.mocked(startVideo).mockResolvedValue({ polzaId: 'polza-video-1', model: 'video-model' });

    await makePostVideo(ctx, postId);

    const start = vi.mocked(startVideo).mock.calls[0]!;
    expect(start[1]).toBe('studio');
    expect(start[2].firstFrame).toMatch(/^https:\/\/mikan\.test\/uploads\/smm-/);
    expect(start[2].prompt).not.toMatch(/blood/i);
    expect(start[2].english).toBe(true);
    const pending = (await loadPost(ctx, postId))!.media.find((m) => m.kind === 'video')!;
    expect(pending).toMatchObject({ status: 'pending', source: 'ai', aspect: '9:16' });

    vi.mocked(pollVideo).mockResolvedValue({ status: 'done', url: 'https://polza.test/video.mp4', cost: 45 });
    expect(await pollVideos(ctx)).toEqual([postId]);
    expect(vi.mocked(pollVideo).mock.calls[0]?.slice(1)).toEqual(['studio', 'polza-video-1']);
    const done = (await loadPost(ctx, postId))!;
    expect(done.busy).toBeNull();
    expect(done.media.find((m) => m.kind === 'video')).toMatchObject({ status: 'done', costRub: 45 });
    expect(done.media.find((m) => m.kind === 'video')?.url).toMatch(/\.mp4$/);
  });

  /** Видео в работе у нейросети: пост занят видео, медиа «pending», заказано `minutesAgo` минут назад. */
  async function pendingVideo(minutesAgo: number, polzaId = 'polza-video-1'): Promise<{ postId: string; mediaId: string }> {
    const postId = await newPost('studio', 'reel');
    await claimPost(ctx, postId, 'video');
    const mediaId = await insertMedia(ctx, { postId, kind: 'video', source: 'ai', status: 'pending', polzaId });
    const at = Date.now() - minutesAgo * 60_000;
    ctx.db.update(smmMedia).set({ createdAt: at, updatedAt: at }).where(eq(smmMedia.id, mediaId)).run();
    ctx.db.update(smmPosts).set({ busyAt: at }).where(eq(smmPosts.id, postId)).run();
    return { postId, mediaId };
  }

  const mediaRow = (id: string) => ctx.db.select().from(smmMedia).where(eq(smmMedia.id, id)).get()!;

  it('gives up after 40 minutes even when the check itself keeps failing: the post is free with a clear error', async () => {
    const old = await pendingVideo(41, 'polza-old');
    const recent = await pendingVideo(5, 'polza-new');
    vi.mocked(pollVideo).mockRejectedValue(new SmmError('Polza недоступна', 502));

    expect(await pollVideos(ctx)).toEqual([old.postId]);

    expect(mediaRow(old.mediaId)).toMatchObject({ status: 'failed', selected: false, error: 'Polza недоступна' });
    expect(await loadPost(ctx, old.postId)).toMatchObject({
      busy: null,
      error: 'Видео не получилось: нейросеть не отвечала 40 минут — попробуйте ещё раз',
    });
    expect(mediaRow(recent.mediaId).status).toBe('pending');
    expect((await loadPost(ctx, recent.postId))!.busy).toBe('video');
  });

  it('polls round-robin: ten old jobs do not starve a newer one', async () => {
    const jobs = [];
    for (let i = 0; i < 11; i += 1) jobs.push(await pendingVideo(20 - i, `polza-${i}`));
    vi.mocked(pollVideo).mockResolvedValue({ status: 'pending' });

    await pollVideos(ctx);
    const first = vi.mocked(pollVideo).mock.calls.map((c) => c[2]);
    expect(first).toHaveLength(10);
    expect(first).not.toContain('polza-10');

    vi.mocked(pollVideo).mockClear();
    await pollVideos(ctx);
    expect(vi.mocked(pollVideo).mock.calls[0]?.[2]).toBe('polza-10');
  });

  it('a finished video does not free a post another job took over meanwhile', async () => {
    const { postId } = await pendingVideo(15);
    // The video took long: a revision claimed the post (the claim treats 10+ minutes as stale).
    expect(await claimPost(ctx, postId, 'revise')).toBe(true);
    vi.mocked(pollVideo).mockResolvedValue({ status: 'failed', error: 'модель отказалась' });

    await pollVideos(ctx);

    const row = ctx.db.select().from(smmPosts).where(eq(smmPosts.id, postId)).get()!;
    expect(row).toMatchObject({ busy: 'revise', error: 'Видео не получилось: модель отказалась' });
  });

  it('frees the post with an error when the scene fails', async () => {
    const postId = await newPost('author', 'reel');
    await claimPost(ctx, postId, 'video');
    vi.mocked(chatJson).mockRejectedValue(new SmmError('маркетолог ответил не по форме', 502));
    await expect(makePostVideo(ctx, postId)).rejects.toThrow();
    const post = (await loadPost(ctx, postId))!;
    expect(post.busy).toBeNull();
    expect(post.error).toContain('Видео не получилось');
  });
});
