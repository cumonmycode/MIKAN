/**
 * Места съёмки профиля (у студии — её помещения, у автора — свои): маркетолог смотрит фото зоны с разных ракурсов,
 * читает слова владельца (автора) и дописывает описание — планировка, свет, цвета, мебель, декор, удачные ракурсы.
 * Его берут в промпты картинок и видео, а сами фото — в референсы, чтобы сцены были в настоящем месте. Плюс короткая
 * «опора» по-английски для видеомодели.
 *
 * Фото хранятся у нас относительным путём (`/uploads/smm-…`) — нейросети получают полные ссылки (`absoluteUrl`).
 */
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { errorMessage } from '../lib/errors.js';
import { chatJson, type ChatPart } from './ai.js';
import { brandTitle } from './context.js';
import { absoluteUrl } from './files.js';
import { saveZoneAiText, setZoneProgress, ZONE_STALE_MS, zoneOr404, type Zone } from './knowledge.js';
import { SmmError, step } from './types.js';

/** Сколько фото зоны маркетолог смотрит за раз и сколько берёт в референсы картинки. */
const DESCRIBE_PHOTOS = 8;
export const ZONE_REFS = 3;

const DescribeSchema = z.object({
  description: z.string().min(80).max(2500),
  angles: z.string().max(800),
  anchor: z.string().min(40).max(900),
});

const needsSource = (zone: Zone) => !zone.photos.length && !zone.ownerText.trim();
const NEEDS_SOURCE = 'Добавьте фото зоны или опишите её — маркетолог опирается на них';

function placeLine(zone: Zone, name: string): string {
  return zone.profile === 'author'
    ? `Это место съёмки для личного блога «${name}»: «${zone.title}». Фото — с разных ракурсов.`
    : `Это помещение тату- и пирсинг-студии «${name}»: зона «${zone.title}». Фото — с разных ракурсов.`;
}

export async function describeZone(ctx: AppContext, zoneId: string): Promise<void> {
  const zone = await zoneOr404(ctx, zoneId);
  if (needsSource(zone)) throw new SmmError(NEEDS_SOURCE, 400);
  try {
    await setZoneProgress(ctx, zone.id, step(`Смотрю фото: ${zone.title.toLowerCase()}`, 3, 95, 25 + zone.photos.length * 3));
    const name = await brandTitle(ctx, zone.profile);
    const who = zone.profile === 'author' ? 'Автор пишет' : 'Владелец пишет';
    const content: ChatPart[] = [
      {
        type: 'text',
        text: [
          placeLine(zone, name),
          zone.ownerText.trim() ? `${who} о месте: ${zone.ownerText.trim()}` : '',
          'Опиши место так, чтобы по описанию можно было нарисовать или снять сцену именно здесь: планировка и размер, стены и пол (цвет, материал), свет (источники, цвет, тёплый или холодный, лампы, неон, окна), мебель и рабочие места (кушетка, кресло, стол, стойка, витрина), декор (логотипы, надписи, картины, эскизы на стенах, растения), что обычно на столах и полках, окна и двери, общее настроение.',
          'Только то, что видно на фото и сказано в словах о месте, без выдумок. Слова о месте — главнее. Людей и клиентов не описывай.',
          'angles — какие ракурсы и сцены здесь удачные для фото и видео (2–4 варианта).',
          'anchor — то же коротко по-английски (2–4 предложения): визуальная опора для видеомодели — layout, colors, materials, lighting, key objects.',
          'Ответ — JSON: {"description": "4–8 предложений по-русски", "angles": "...", "anchor": "..."}',
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ];
    zone.photos.slice(0, DESCRIBE_PHOTOS).forEach((photo, i) => {
      content.push({ type: 'text', text: `Фото ${i + 1}:` }, { type: 'image_url', image_url: { url: absoluteUrl(ctx, photo.url) } });
    });
    const r = await chatJson(ctx, zone.profile, {
      kind: zone.photos.length ? 'vision' : 'text',
      note: `место съёмки: ${zone.title}`,
      maxTokens: 2500,
      temperature: 0.3,
      schema: DescribeSchema,
      system: 'Ты описываешь интерьер для дизайнера и оператора. Конкретно, без оценок и рекламы. Ответ — один JSON.',
      user: content,
    });
    await saveZoneAiText(ctx, zone.id, `${r.description.trim()}\nУдачные ракурсы: ${r.angles.trim()}`, r.anchor.trim());
  } catch (error) {
    await setZoneProgress(ctx, zone.id, null, errorMessage(error).slice(0, 300) || 'Не получилось');
    throw error;
  }
}

export async function describeZoneInBackground(ctx: AppContext, zoneId: string): Promise<boolean> {
  const zone = await zoneOr404(ctx, zoneId);
  if (zone.progress && Date.now() - Date.parse(zone.progress.at) < ZONE_STALE_MS) return false;
  if (needsSource(zone)) throw new SmmError(NEEDS_SOURCE, 400);
  await setZoneProgress(ctx, zone.id, step(`Смотрю фото: ${zone.title.toLowerCase()}`, 2, 10, 5));
  void describeZone(ctx, zoneId).catch((error: unknown) =>
    ctx.log.error({ err: errorMessage(error), zone: zone.title }, 'smm: zone description failed'),
  );
  return true;
}

/** Фото зоны для референсов картинки: первые несколько ракурсов, полными ссылками (нейросеть скачивает их сама). */
export const zoneRefs = (ctx: AppContext, zone: Zone | undefined): string[] =>
  zone ? zone.photos.slice(0, ZONE_REFS).map((p) => absoluteUrl(ctx, p.url)) : [];
