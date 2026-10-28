/**
 * Видео нейросетью (8 с, 9:16) — так, чтобы оно было реалистичным и снятым в настоящем месте профиля (студия или места
 * автора), а не в выдуманном:
 *  1. Маркетолог продумывает одну сцену: где (место профиля), кто, что делает, камера, свет, звук.
 *  2. Первый кадр — фотореалистичная картинка в этом месте по его настоящим фото; если у поста уже есть живое
 *     вертикальное фото — можно начать с него.
 *  3. Видеомодель оживляет кадр (режим «первый кадр») по подробному промпту на английском — так модель понимает его
 *     лучше всего; переводчик Polza выключен.
 * Готовую работу (тату, прокол) ролик крупно не показывает — нейросеть не выдаёт себя за настоящую работу. Готовое
 * видео подхватывает крон (pollVideos).
 */
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { errorMessage } from '../lib/errors.js';
import { chatJson, generateImage, startVideo } from './ai.js';
import { brandTitle } from './context.js';
import { craftKnowledge } from './craft.js';
import { insertMedia, loadPost, nextSort, setPostProgress, updatePost } from './db.js';
import { absoluteUrl, storeRemote } from './files.js';
import { zoneRefs } from './interior.js';
import { listZones, usableZones, zoneByCode, zoneDescription, zonesText, type Zone } from './knowledge.js';
import { imageExt, safePrompt } from './media.js';
import { FORMAT_LABEL, PLATFORM_LABEL } from './prompts.js';
import { SmmError, step, type SmmPost, type SmmProfile } from './types.js';

const VIDEO_ASPECT = '9:16' as const;
/** Примерно столько видеомодель снимает 8 секунд — для шкалы. */
const VIDEO_ETA_SEC = 150;

const PlanSchema = z.object({
  scene: z.string().min(20).max(600),
  zone: z.string().max(8).nullable().optional(),
  usePostImage: z.boolean().optional(),
  keyframe: z.string().min(40).max(3000),
  prompt: z.string().min(200).max(4000),
});

/** Как писать промпт видео — главное для реализма. */
const VEO_RULES = [
  'prompt — промпт для видеомодели, СТРОГО НА АНГЛИЙСКОМ, 120–220 слов, одна непрерывная сцена 8 секунд, вертикально 9:16, начинается ровно с первого кадра (keyframe).',
  'Порядок: Shot & camera → Subject & action → Setting → Lighting & color → Sound → Style → Avoid.',
  '- Camera: одно простое движение (slow push-in, gentle handheld follow, slow orbit, static tripod), объектив (35mm/50mm), малая глубина резкости. Никаких склеек и смены планов.',
  '- Subject & action: 1–2 простых, физически правдоподобных действия на 8 секунд; люди двигаются естественно, тонкая мимика, реальные руки и предметы (чёрные нитриловые перчатки, тату-машинка, трансфер эскиза на коже, стерильные упаковки, украшения из титана, зеркало).',
  '- Setting: если сцена в месте профиля — помещение словами из опоры места (layout, colors, materials), точно как на первом кадре, ничего не добавлять; если нет — место, которого требует сюжет, конкретно и правдоподобно.',
  '- Lighting & color: реальные источники света места (у места — его свет и цвета); без «волшебного» сияния.',
  '- Sound: живой звук помещения (soft hum of a tattoo machine, quiet background music, rustle of sterile packaging). Речь — только если без неё никак: одна короткая фраза по-русски в кавычках с описанием, кто говорит; иначе «no dialogue».',
  '- Style: photorealistic, documentary realism, shot on a modern cinema camera / flagship smartphone, natural skin texture and pores, real-world physics, 24fps natural motion blur, subtle film grain. Looks like real footage, not CGI.',
  '- Avoid: on-screen text, subtitles, captions, logos, watermarks, distorted or melting faces, extra fingers, morphing objects, cartoon or 3D-render look, slow motion, sudden cuts.',
  'keyframe — промпт первого кадра ПО-РУССКИ для фотореалистичной картинки 9:16: та же сцена в первую секунду (в месте — если выбрал место), как настоящая фотография (свет, лица, кожа, фактуры), без текста и логотипов на кадре, люди — без узнаваемых лиц крупным планом.',
  'Готовую татуировку или прокол крупным планом как результат работы не показывай — ролик нейросети не должен выдавать себя за настоящую работу: процесс, руки, инструменты, украшения, атмосфера, место.',
  'Тату и пирсинг в кадре — по справке: мастер в перчатках, одноразовые стерильные расходники, прокол — полой иглой, не пистолетом. Не путай.',
  'В prompt и keyframe никогда не упоминай кровь, соски и обнажённое тело — даже со словами «без» или «no»: такие запросы нейросеть отклоняет.',
].join('\n');

/** Место профиля — только когда сюжет действительно там. */
export const ZONE_CHOICE = [
  'Место ("zone", код З1…) — только если этого требует сюжет или тема: сеанс, прокол, примерка украшений, показ места, мастер за работой.',
  'Если сцена не про наше место (поздравление, мем, памятка, атмосфера, улица, люди вне его) — "zone": null, место придумай под сюжет.',
].join(' ');

/** Кто ставит задачу видеомодели — студия или автор. */
function directorLine(profile: SmmProfile, name: string): string {
  return profile === 'studio'
    ? `Ты — маркетолог и режиссёр коротких видео тату- и пирсинг-студии «${name}». Ставишь задачу видеомодели так, чтобы ролик выглядел как настоящая съёмка в нашей студии. Ответ — один JSON.`
    : `Ты — маркетолог и режиссёр коротких видео для личных соцсетей «${name}», мастера тату и пирсинга. Ставишь задачу видеомодели так, чтобы ролик выглядел как настоящая съёмка в её местах. Ответ — один JSON.`;
}

function noZonesLine(profile: SmmProfile): string {
  return profile === 'studio'
    ? 'Фото мест студии ещё нет: если сцена в студии — опиши светлый чистый кабинет тату-студии с кушеткой, лампой и стерильным столиком.'
    : 'Фото мест ещё нет: место придумай под сюжет, конкретно и правдоподобно.';
}

/** Живое вертикальное фото публикации (архив или своё) — с него можно начать видео. */
function postImageFrame(post: SmmPost): string | null {
  const frame = post.media.find(
    (m) =>
      m.kind === 'image' &&
      m.status === 'done' &&
      m.selected &&
      m.aspect === VIDEO_ASPECT &&
      m.url &&
      (m.source === 'archive' || m.source === 'upload'),
  );
  return frame?.url ?? null;
}

function sceneTask(post: SmmPost, zones: Zone[], ownFrame: string | null, wish?: string): string {
  return [
    `Публикация: ${PLATFORM_LABEL[post.platform]}, ${FORMAT_LABEL[post.format]}. Тема: ${post.topic}.`,
    post.brief ? `Идея: ${post.brief}` : '',
    post.visual ? `Визуал: ${post.visual}` : '',
    post.script
      ? `Сценарий: зацепка «${post.script.hook}»; кадры: ${post.script.shots.map((s, i) => `${i + 1}) ${s.text}`).join(' ')}`
      : '',
    wish ? `Пожелание к видео: ${wish}` : '',
    zonesText(zones),
    usableZones(zones).length ? ZONE_CHOICE : noZonesLine(post.profile),
    ownFrame
      ? 'У публикации есть живое вертикальное фото — "usePostImage": true, если сцену можно начать с него (тогда keyframe опиши по этому фото).'
      : '',
    `Справка по тату и пирсингу (для правдоподобия сцены):\n${craftKnowledge('brief')}`,
    '',
    VEO_RULES,
    '',
    'Ответ — JSON: {"scene": "одной-двумя фразами по-русски, что в ролике", "zone": "З2" | null, "usePostImage": false, "keyframe": "...", "prompt": "..."}',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Первый кадр в месте профиля: картинка по его фото, сохранённая у нас; наружу — полная ссылка для видеомодели. */
async function makeFirstFrame(ctx: AppContext, post: SmmPost, zone: Zone | undefined, keyframe: string): Promise<string> {
  const place = post.profile === 'author' ? `настоящее место «${zone?.title}»` : `настоящее помещение студии «${zone?.title}»`;
  const where = zone
    ? `Место — ${place} (референсы — его фото с разных ракурсов): сохрани планировку, мебель, цвета и свет как на фото. ${zoneDescription(zone).slice(0, 600)}\n`
    : '';
  const prompt = safePrompt(
    `${where}${keyframe}\nФотореализм: настоящая фотография, естественный свет помещения, живые фактуры. Без текста, надписей и логотипов на кадре.`,
  );
  const frame = await generateImage(ctx, post.profile, { prompt, aspect: VIDEO_ASPECT, references: zoneRefs(ctx, zone), note: `кадр видео ${post.id}` });
  let stored: string;
  try {
    stored = await storeRemote(ctx, frame.url, imageExt(frame.url));
  } catch (error) {
    throw new SmmError(`Первый кадр не сохранился: ${errorMessage(error)}`, 502);
  }
  return absoluteUrl(ctx, stored);
}

/** Продумать сцену, сделать первый кадр и запустить видеомодель. Пост уже занят (busy = video). */
export async function makePostVideo(ctx: AppContext, postId: string, wish?: string): Promise<void> {
  const post = await loadPost(ctx, postId);
  if (!post) throw new SmmError('Публикация не найдена', 404);
  try {
    await setPostProgress(ctx, post.id, step('Продумываю сцену видео', 3, 15, 15));
    const [name, zones] = await Promise.all([brandTitle(ctx, post.profile), listZones(ctx, post.profile)]);
    const ownFrame = postImageFrame(post);
    const plan = await chatJson(ctx, post.profile, {
      system: directorLine(post.profile, name),
      note: `сцена видео ${post.id}`,
      maxTokens: 3000,
      temperature: 0.6,
      schema: PlanSchema,
      user: sceneTask(post, zones, ownFrame, wish),
    });
    const zone = zoneByCode(zones, plan.zone ?? undefined);
    let firstFrame = plan.usePostImage && ownFrame ? absoluteUrl(ctx, ownFrame) : null;
    if (!firstFrame) {
      await setPostProgress(ctx, post.id, step('Делаю первый кадр', 15, 35, 30));
      firstFrame = await makeFirstFrame(ctx, post, zone, plan.keyframe);
    }
    await setPostProgress(ctx, post.id, step('Нейросеть снимает видео', 35, 97, VIDEO_ETA_SEC));
    const setting = zone?.anchor ? `\nSetting reference (keep exactly as in the first frame): ${zone.anchor}` : '';
    const { polzaId, model } = await startVideo(ctx, post.profile, {
      prompt: safePrompt(`${plan.prompt}${setting}`),
      aspect: VIDEO_ASPECT,
      firstFrame,
      english: true,
    });
    await insertMedia(ctx, {
      postId: post.id,
      kind: 'video',
      source: 'ai',
      status: 'pending',
      aspect: VIDEO_ASPECT,
      prompt: `${plan.scene}\n\n${plan.prompt}`,
      model,
      polzaId,
      sort: await nextSort(ctx, post.id),
    });
  } catch (error) {
    const message = error instanceof Error ? `Видео не получилось: ${error.message}`.slice(0, 300) : 'Видео не получилось';
    await updatePost(ctx, post.id, { busy: null, error: message });
    throw error;
  }
}

export function makePostVideoInBackground(ctx: AppContext, postId: string, wish?: string): void {
  void makePostVideo(ctx, postId, wish).catch((error) =>
    ctx.log.error({ err: errorMessage(error), postId }, 'smm video: generation failed'),
  );
}
