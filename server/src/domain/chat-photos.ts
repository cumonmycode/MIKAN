import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { and, count, eq, gte, isNotNull } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { botMessages } from '../db/schema.js';
import { sniffImage, type ImageExtension } from '../lib/image-type.js';
import type { BotMessageRow } from '../lib/serialize.js';
import { DAY_MS } from '../lib/time.js';
import { DISK_FREE_MIN_BYTES } from './alerts.js';

/**
 * Pictures clients send the bot, kept so staff can see them in the chat. These are photos of people's bodies, so they
 * stay out of DATA_DIR/uploads (anyone with the link can open that folder): only `GET /bot/photos/:file` reads them,
 * behind the staff login.
 */

/** Far above a real conversation: anyone can write to the bot, and a flood of pictures must not fill the disk. */
export const MAX_CHAT_PHOTOS_PER_DAY = 30;

const MEDIA_TYPES: Record<ImageExtension, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
};
const FILE_NAME = /^[0-9a-f-]{36}\.(jpg|png|webp|heic)$/;

const photosDir = (dataDir: string): string => path.join(dataDir, 'chat-photos');

export type PhotoNotKept = 'not_image' | 'over_limit' | 'no_space';

function photosKeptToday(db: DbOrTx, chatId: number): number {
  const since = Date.now() - DAY_MS;
  const conditions = and(eq(botMessages.chatId, chatId), isNotNull(botMessages.photoFile), gte(botMessages.createdAt, since));
  return db.select({ kept: count() }).from(botMessages).where(conditions).get()?.kept ?? 0;
}

/** Stores the picture and attaches it to the message: null, or why nothing was stored. */
export async function keepChatPhoto(
  db: DbOrTx,
  dataDir: string,
  message: Pick<BotMessageRow, 'id' | 'chatId'>,
  data: Buffer,
): Promise<PhotoNotKept | null> {
  const extension = sniffImage(data);
  if (!extension) return 'not_image';
  if (photosKeptToday(db, message.chatId) >= MAX_CHAT_PHOTOS_PER_DAY) return 'over_limit';
  const dir = photosDir(dataDir);
  await fs.mkdir(dir, { recursive: true });
  const { bavail, bsize } = await fs.statfs(dir);
  if (bavail * bsize < DISK_FREE_MIN_BYTES) return 'no_space'; // the database lives on this disk too
  const file = `${randomUUID()}.${extension}`;
  await fs.writeFile(path.join(dir, file), data, { mode: 0o600 });
  db.update(botMessages).set({ photoFile: file }).where(eq(botMessages.id, message.id)).run();
  return null;
}

/** The stored picture; null for a name that is not one of ours or a file that is gone. */
export async function readChatPhoto(dataDir: string, file: string): Promise<{ data: Buffer; mediaType: string } | null> {
  const match = FILE_NAME.exec(file);
  if (!match) return null;
  try {
    return { data: await fs.readFile(path.join(photosDir(dataDir), file)), mediaType: MEDIA_TYPES[match[1] as ImageExtension] };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}
