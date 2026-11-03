import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { uploadsDir } from '../app.js';
import type { AppContext } from '../context.js';
import { badRequest } from '../lib/errors.js';
import { sniffImage } from '../lib/image-type.js';

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heic',
};

export function uploadRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/uploads', async (request) => {
    if (!request.isMultipart()) throw badRequest('Отправьте файл в формате multipart/form-data (поле file)');
    const file = await request.file();
    if (!file || file.fieldname !== 'file') throw badRequest('Файл не найден: используйте поле «file»');
    const declared = EXTENSION_BY_MIME[file.mimetype.toLowerCase()];
    if (!declared) throw badRequest('Поддерживаются только изображения JPEG, PNG, HEIC и WebP');
    const buffer = await file.toBuffer();
    if (file.file.truncated) throw badRequest('Файл слишком большой (максимум 10 МБ)');
    const actual = sniffImage(buffer);
    if (!actual) throw badRequest('Файл повреждён или не является изображением JPEG, PNG, HEIC или WebP');
    const name = `${randomUUID()}.${actual}`;
    await fs.writeFile(path.join(uploadsDir(ctx), name), buffer, { mode: 0o644 });
    request.log.info({ name, bytes: buffer.length }, 'upload stored');
    return { url: `/uploads/${name}` };
  });
}
