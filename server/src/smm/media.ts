/**
 * Визуал публикаций: картинки нейросети, фото из фотоархива профиля (как есть — кадр под формат; поправить; новое по
 * мотивам), у студии — и настоящие работы из каталога услуг, видео (video.ts — задача на минуты, доводит крон) и свои
 * фото и видео с телефона. Всё хранится у нас (`/uploads/smm-…`): ссылка нейросети живёт 7 дней.
 *
 * Настоящие работы (тату, проколы, украшения на людях) — только из архива и своих загрузок: картинка нейросети за
 * работу студии или автора себя не выдаёт. Нейросеть рисует карточки, памятки, анонсы, афиши и сцены в местах
 * профиля. Сцена в настоящем месте — только когда её требует сюжет: тогда в референсы идут фото зоны.
 */
import { eq } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { smmMedia } from '../db/schema-smm.js';
import { errorMessage } from '../lib/errors.js';
import { generateImage, pollVideo } from './ai.js';
import {
  insertMedia,
  loadPost,
  nextSort,
  pendingMedia,
  releasePost,
  setPostProgress,
  touchMedia,
  unselectSlot,
  updateMedia,
  VIDEO_GIVE_UP_MS,
} from './db.js';
import { absoluteUrl, saveSmmFile, storeRemote, TELEGRAM_FILE_MAX_BYTES } from './files.js';
import { zoneRefs } from './interior.js';
import { zoneDescription, type Zone } from './knowledge.js';
import { cropUrl, libraryOfKind, libraryPhotos, markUsed, photoUrl, readCatalogPhoto, type LibraryPhoto } from './library.js';
import { aspectFor, SmmError, step, type SmmPost, type SmmProfile } from './types.js';
/** Примерно столько рисуется одна картинка — для шкалы готовности. */
const IMAGE_ETA_SEC = 25;
const MAX_REFS = 6;
/** Готовое видео нейросети — до 200 МБ (8 секунд обычно 5–20 МБ). */
const VIDEO_MAX_BYTES = 200 * 1024 * 1024;
/** Свои файлы с телефона: фото до 10 МБ, видео до 100 МБ (тот же лимит у маршрута). */
const UPLOAD_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const UPLOAD_VIDEO_MAX_BYTES = 100 * 1024 * 1024;

/** Логотип профиля из архива — опора, когда на картинке нужен логотип. */
export async function brandLogo(ctx: AppContext, profile: SmmProfile): Promise<string | null> {
  const [logo] = await libraryOfKind(ctx, profile, 'logo', 1).catch(() => []);
  return logo ? photoUrl(logo.id, 1200) : null;
}

export type ArchiveMode = 'as_is' | 'edit' | 'inspire';

export interface ImageJob {
  prompt: string;
  sort: number;
  /** Место профиля, если сцена по сюжету там: его фото — в референсы, описание — в промпт. */
  zone?: Zone;
  /** Нужен логотип на картинке. */
  logo?: boolean;
  /** Фото из архива: как есть, поправить или новое по мотивам. */
  photo?: LibraryPhoto;
  mode?: ArchiveMode;
}

type MediaPost = Pick<SmmPost, 'id' | 'format' | 'profile'>;

const EDIT_PREFIX =
  'Отредактируй настоящее фото (первое изображение). Сохрани людей, лица, позы, обстановку и саму работу — ' +
  'татуировку, прокол, украшение — точно такими, как есть, ничего не перерисовывай и не выдумывай вместо них. Правки: ';
const INSPIRE_PREFIX =
  'Новая картинка по мотивам настоящего фото (первое изображение): то же место и настроение, новая сцена и ' +
  'композиция. Татуировки, проколы и украшения на людях не рисуй заново — это не настоящая работа. ';

/**
 * Слова, на которые срабатывает фильтр нейросети картинок (соски, кровь), — даже с «без». Промпт пишет модель,
 * поэтому перед отправкой их убираем вместе с отрицанием перед ними.
 */
const FILTERED =
  'соск[а-яё]*|сосок|кров[ьиюя]|кровью|кровот[а-яё]*|окровав[а-яё]*|кровян[а-яё]*|кровав[а-яё]*|nipples?|blood[a-z]*|bleed[a-z]*';
const FILTERED_WORDS = new RegExp(`(?<![а-яёa-z])(?:(?:без|ни|никаких|no|without)\\s+)?(?:${FILTERED})(?![а-яёa-z])`, 'gi');

export const safePrompt = (prompt: string): string =>
  prompt
    .replace(FILTERED_WORDS, '')
    .replace(/[ \t]+(?:и|and)[ \t]*(?=[,.;:!?)]|$)/gim, '')
    .replace(/[ \t]+([,.;:!?])/g, '$1')
    .replace(/([,;])(?=[,;.])/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

function zonePrefix(zone: Zone): string {
  const photos = zone.photos.length
    ? ' (референсы — его фото с разных ракурсов): сохрани планировку, мебель, цвета и свет как на фото, ничего не выдумывай вместо них'
    : '';
  const place = zone.profile === 'author' ? `настоящее место «${zone.title}»` : `настоящее помещение студии «${zone.title}»`;
  return `Место — ${place}${photos}. ${zoneDescription(zone).slice(0, 600)}\nСцена: `;
}

/** Полная ссылка на фото архива — референс для нейросети. */
const photoRef = (ctx: AppContext, photo: LibraryPhoto): string =>
  photo.source === 'catalog' && photo.url ? absoluteUrl(ctx, photo.url) : photoUrl(photo.id, 1600);

/** Расширение картинки по ссылке нейросети (по умолчанию png). */
export function imageExt(url: string): string {
  const m = /\.(png|jpe?g|webp)(?:$|[?#])/i.exec(url);
  const ext = m?.[1]?.toLowerCase() ?? 'png';
  return ext === 'jpeg' ? 'jpg' : ext;
}

/** Копия фото в нашем хранилище: архив — кадр Google под формат, каталог — файл с диска как есть. */
async function storeArchivePhoto(ctx: AppContext, photo: LibraryPhoto, aspect: '4:5' | '9:16'): Promise<string> {
  if (photo.source === 'catalog') {
    const file = await readCatalogPhoto(ctx, photo);
    return saveSmmFile(ctx, file.data, file.ext);
  }
  return storeRemote(ctx, cropUrl(photo.id, aspect), 'jpg');
}

/** Положить фото архива в публикацию как есть: Google отдаёт кадр под формат. */
async function archiveInto(ctx: AppContext, post: MediaPost, photo: LibraryPhoto, sort: number): Promise<void> {
  const aspect = aspectFor(post.format);
  const mediaId = await insertMedia(ctx, {
    postId: post.id,
    kind: 'image',
    source: 'archive',
    status: 'pending',
    // Фото каталога не кадрируется — формат неизвестен.
    aspect: photo.source === 'catalog' ? null : aspect,
    prompt: photo.description || photo.name,
    model: photo.source === 'catalog' ? 'catalog' : 'google-drive',
    sort,
  });
  let url: string;
  try {
    url = await storeArchivePhoto(ctx, photo, aspect);
  } catch (error) {
    const message = errorMessage(error).slice(0, 200);
    await updateMedia(ctx, mediaId, { status: 'failed', error: message, selected: false });
    throw new SmmError(`Фото из архива не скачалось: ${message}`, 502);
  }
  await updateMedia(ctx, mediaId, { status: 'done', url, error: null });
  await unselectSlot(ctx, post.id, 'image', sort, mediaId);
}

/** Промпт картинки целиком: место, фото архива (поправить или по мотивам), логотип; без слов, которые режет фильтр. */
function jobPrompt(job: ImageJob, logo: string | null): string {
  const base = job.zone && !job.photo ? `${zonePrefix(job.zone)}${job.prompt}` : job.prompt;
  const prompt = job.photo ? `${job.mode === 'edit' ? EDIT_PREFIX : INSPIRE_PREFIX}${base}` : base;
  return safePrompt(job.logo && logo ? `${prompt}\nЛоготип — как на последнем референсе, без искажений.` : prompt);
}

/** Сгенерировать картинку в позицию sort (карусель — несколько позиций); прежний вариант позиции снимается. */
async function imageInto(ctx: AppContext, post: MediaPost, job: ImageJob, logo: string | null): Promise<void> {
  if (job.photo && job.mode === 'as_is') return archiveInto(ctx, post, job.photo, job.sort);
  const aspect = aspectFor(post.format);
  const references = [
    ...(job.photo ? [photoRef(ctx, job.photo)] : []),
    ...zoneRefs(ctx, job.zone),
    ...(job.logo && logo ? [logo] : []),
  ].slice(0, MAX_REFS);
  const prompt = jobPrompt(job, logo);
  const mediaId = await insertMedia(ctx, { postId: post.id, kind: 'image', source: 'ai', status: 'pending', aspect, prompt, sort: job.sort });
  try {
    const generated = await generateImage(ctx, post.profile, { prompt, aspect, references, note: `пост ${post.id}` });
    const url = await storeRemote(ctx, generated.url, imageExt(generated.url));
    ctx.db.update(smmMedia).set({ model: generated.model, updatedAt: Date.now() }).where(eq(smmMedia.id, mediaId)).run();
    await updateMedia(ctx, mediaId, { status: 'done', url, costRub: generated.cost, error: null });
    await unselectSlot(ctx, post.id, 'image', job.sort, mediaId);
  } catch (error) {
    await updateMedia(ctx, mediaId, { status: 'failed', error: errorMessage(error).slice(0, 200), selected: false });
    throw error;
  }
}

/** Сколько картинок генерировать одновременно (карусель — до 8 слайдов). */
const IMAGE_CONCURRENCY = 3;

/**
 * Картинки поста пачками по три; шкала готовности идёт от `from` до `to` процентов. Хоть одна получилась — успех;
 * иначе бросаем последнюю ошибку.
 */
export async function generateImages(
  ctx: AppContext,
  post: MediaPost,
  jobs: ImageJob[],
  range: { from: number; to: number } = { from: 5, to: 95 },
): Promise<void> {
  const logo = jobs.some((j) => j.logo) ? await brandLogo(ctx, post.profile) : null;
  let lastError: unknown = null;
  let done = 0;
  let finished = 0;
  const label = (n: number) => (jobs.length > 1 ? `Рисую картинки: ${n} из ${jobs.length}` : 'Рисую картинку');
  const span = range.to - range.from;
  for (let i = 0; i < jobs.length; i += IMAGE_CONCURRENCY) {
    const chunk = jobs.slice(i, i + IMAGE_CONCURRENCY);
    const at = range.from + Math.round((span * finished) / jobs.length);
    const next = range.from + Math.round((span * (finished + chunk.length)) / jobs.length);
    await setPostProgress(ctx, post.id, step(label(finished), at, next, IMAGE_ETA_SEC));
    const results = await Promise.allSettled(chunk.map((job) => imageInto(ctx, post, job, logo)));
    for (const r of results) {
      finished += 1;
      if (r.status === 'fulfilled') done += 1;
      else lastError = r.reason;
    }
    if (lastError instanceof SmmError && lastError.status === 402) break;
  }
  const used = jobs.map((j) => j.photo?.id).filter((id): id is string => !!id);
  await markUsed(ctx, post.profile, used).catch(() => undefined);
  if (!done && lastError) throw lastError;
}

/** Новый вариант одной картинки (по умолчанию — первой) по её же или новому промпту. */
export async function regenerateImage(ctx: AppContext, postId: string, opts: { mediaId?: string; prompt?: string }): Promise<void> {
  const post = await loadPost(ctx, postId, true);
  if (!post) throw new SmmError('Публикация не найдена', 404);
  const images = post.media.filter((m) => m.kind === 'image');
  const target = opts.mediaId ? images.find((m) => m.id === opts.mediaId) : (images.find((m) => m.selected) ?? images[0]);
  const prompt = opts.prompt?.trim() || (target?.source === 'ai' ? target.prompt : null) || post.visual;
  if (!prompt) throw new SmmError('Нечего рисовать — опишите картинку', 400);
  await generateImages(ctx, post, [{ prompt, sort: target?.sort ?? 0 }]);
}

/** Фото из архива — в публикацию вручную: встаёт последним (или заменяет позицию). */
export async function addArchivePhoto(ctx: AppContext, postId: string, photoId: string, sort?: number): Promise<void> {
  const post = await loadPost(ctx, postId);
  if (!post) throw new SmmError('Публикация не найдена', 404);
  const [photo] = await libraryPhotos(ctx, post.profile, [photoId]);
  if (!photo) throw new SmmError('Фото нет в архиве', 404);
  await archiveInto(ctx, post, photo, sort ?? (await nextSort(ctx, postId)));
  await markUsed(ctx, post.profile, [photo.id]);
}

type VideoJob = Awaited<ReturnType<typeof pendingMedia>>[number];

const overdue = (job: VideoJob): boolean => Date.now() - Date.parse(job.createdAt) > VIDEO_GIVE_UP_MS;

/** Видео не получилось: медиа — в ошибку, пост свободен, понятная причина — в публикацию. */
async function giveUpVideo(ctx: AppContext, job: VideoJob, mediaError: string, postError: string): Promise<void> {
  await updateMedia(ctx, job.id, { status: 'failed', error: mediaError.slice(0, 200), selected: false });
  await releasePost(ctx, job.postId, 'video', postError.slice(0, 300));
}

/**
 * Довести видео, которые делает нейросеть: готовое — к себе, зависшее — в ошибку. Через 40 минут сдаёмся и тогда,
 * когда сама проверка падает (Polza недоступна, задача пропала): иначе пост навсегда «занят видео».
 */
export async function pollVideos(ctx: AppContext): Promise<string[]> {
  const finished: string[] = [];
  for (const job of await pendingMedia(ctx)) {
    try {
      const state = await pollVideo(ctx, job.profile, job.polzaId);
      if (state.status === 'pending') {
        if (overdue(job)) {
          await giveUpVideo(ctx, job, 'нейросеть не успела за 40 минут', 'Видео не получилось: нейросеть не успела за 40 минут');
          finished.push(job.postId);
        } else await touchMedia(ctx, job.id);
        continue;
      }
      if (state.status === 'failed') {
        await giveUpVideo(ctx, job, state.error, `Видео не получилось: ${state.error}`);
      } else {
        try {
          const url = await storeRemote(ctx, state.url, 'mp4', VIDEO_MAX_BYTES);
          await updateMedia(ctx, job.id, { status: 'done', url, costRub: state.cost, error: null });
        } catch (error) {
          await updateMedia(ctx, job.id, { status: 'failed', error: errorMessage(error).slice(0, 200), selected: false });
        }
        await releasePost(ctx, job.postId, 'video');
      }
      finished.push(job.postId);
    } catch (error) {
      ctx.log.warn({ err: errorMessage(error), polzaId: job.polzaId }, 'smm media: video poll failed');
      if (overdue(job)) {
        await giveUpVideo(
          ctx,
          job,
          errorMessage(error),
          'Видео не получилось: нейросеть не отвечала 40 минут — попробуйте ещё раз',
        ).catch((err) => ctx.log.warn({ err: errorMessage(err), polzaId: job.polzaId }, 'smm media: video give-up failed'));
        finished.push(job.postId);
      } else await touchMedia(ctx, job.id).catch(() => undefined);
    }
  }
  return finished;
}

type UploadKind = { kind: 'image' | 'video'; ext: string };

const HEIC_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'heim', 'heis'];
const MOV_BOXES = ['moov', 'mdat', 'wide', 'free', 'skip'];

/** Что за файл — по подписи (переименованный не пройдёт), заявленный тип — только подсказка для MOV/MP4. */
function sniffUpload(buf: Buffer, mime: string): UploadKind | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { kind: 'image', ext: 'jpg' };
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { kind: 'image', ext: 'png' };
  }
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return { kind: 'image', ext: 'webp' };
  }
  if (buf.length < 12) return null;
  const box = buf.toString('ascii', 4, 8);
  if (box === 'ftyp') {
    const brand = buf.toString('ascii', 8, 12);
    if (HEIC_BRANDS.includes(brand)) return { kind: 'image', ext: 'heic' };
    return { kind: 'video', ext: brand === 'qt  ' || mime === 'video/quicktime' ? 'mov' : 'mp4' };
  }
  if (MOV_BOXES.includes(box)) return { kind: 'video', ext: 'mov' };
  return null;
}

/**
 * Свой файл с телефона: фото (JPEG, PNG) или видео (MP4, MOV), встаёт последним. HEIC не берём: его не покажет
 * Telegram и не примет Instagram, а перекодировать на сервере нечем — приложение присылает JPEG.
 */
export async function addUpload(ctx: AppContext, postId: string, data: Buffer, mime: string): Promise<void> {
  const post = await loadPost(ctx, postId);
  if (!post) throw new SmmError('Публикация не найдена', 404);
  const type = sniffUpload(data, mime.toLowerCase());
  if (!type) throw new SmmError('Загрузите фото (JPEG, PNG) или видео (MP4, MOV)', 400);
  if (type.ext === 'heic') throw new SmmError('Фото в формате HEIC не примут Telegram и Instagram — загрузите JPEG или PNG', 400);
  if (type.kind === 'image' && data.length > UPLOAD_IMAGE_MAX_BYTES) throw new SmmError('Фото больше 10 МБ', 400);
  if (type.kind === 'video' && data.length > UPLOAD_VIDEO_MAX_BYTES) throw new SmmError('Видео больше 100 МБ', 400);
  // Telegram Bot API не примет от бота файл больше 50 МБ — пост в канале с таким видео не выйдет.
  if (type.kind === 'video' && post.platform === 'telegram' && data.length > TELEGRAM_FILE_MAX_BYTES) {
    throw new SmmError('Telegram принимает видео до 50 МБ — сожмите ролик или снимите покороче', 400);
  }
  const url = await saveSmmFile(ctx, data, type.ext);
  await insertMedia(ctx, { postId, kind: type.kind, source: 'upload', status: 'done', url, sort: await nextSort(ctx, postId) });
}
