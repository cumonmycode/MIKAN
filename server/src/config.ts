import path from 'node:path';
import type { S3Config } from './lib/s3.js';
import { z } from 'zod';
import { SERVICE_IMAGE_MODEL } from './lib/service-images.js';
import { apnsConfigOf, type ApnsConfig } from './push/apns-config.js';

export type { ApnsConfig } from './push/apns-config.js';

/** Treat empty env strings as "not set". */
const optionalString = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().trim().optional(),
);

const booleanFlag = (defaultValue: boolean) =>
  z.preprocess((v) => {
    if (v === undefined || v === '') return defaultValue;
    if (typeof v === 'string') return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
    return v;
  }, z.boolean());

const intWithDefault = (defaultValue: number, min: number, max: number) =>
  z.preprocess(
    (v) => (v === undefined || v === '' ? defaultValue : Number(v)),
    z.number().int().min(min).max(max),
  );

/** Polza models of the SMM marketer unless SMM_*_MODEL say otherwise (the same as in Titan HUB). */
export const SMM_MODEL_DEFAULTS = {
  text: 'google/gemini-3.8-flash',
  image: 'google/gemini-nano-banana-2.1',
  video: 'google/veo3_fast',
} as const;

/** A Polza model id: empty or missing → the default. */
const modelWithDefault = (defaultValue: string) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined), z.string().default(defaultValue));

const envSchema = z.object({
  PORT: intWithDefault(3000, 1, 65535),
  HOST: z.string().default('0.0.0.0'),
  DATA_DIR: z.string().default('./data'),
  PUBLIC_URL: optionalString,
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  ADMIN_LOGIN: z.string().trim().min(2).default('admin'),
  ADMIN_PASSWORD: z.string().min(6, 'ADMIN_PASSWORD must be at least 6 characters'),
  ADMIN_NAME: z.string().trim().min(1).default('Администратор'),
  TELEGRAM_BOT_TOKEN: optionalString,
  TELEGRAM_API_ROOT: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim().replace(/\/+$/, '') : undefined),
    z.url().default('https://api.telegram.org'),
  ),
  BOT_ENABLED: booleanFlag(false),
  AI_BASE_URL: optionalString,
  AI_API_KEY: optionalString,
  AI_AUTH: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim().toLowerCase() : undefined),
    z.enum(['bearer', 'x-api-key']).optional(),
  ),
  AI_MODEL: z.string().trim().min(1).default('claude-opus-5-5'),
  AI_IMAGE_MODEL: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined),
    z.string().default(SERVICE_IMAGE_MODEL),
  ),
  AI_HTTPS_PROXY: optionalString,
  BACKUP_S3_ENDPOINT: optionalString,
  BACKUP_S3_REGION: z.string().trim().default('ru-central1'),
  BACKUP_S3_BUCKET: optionalString,
  BACKUP_S3_ACCESS_KEY_ID: optionalString,
  BACKUP_S3_SECRET_ACCESS_KEY: optionalString,
  BACKUP_S3_PREFIX: z.string().trim().default('mikan/'),
  BACKUP_ENCRYPTION_KEY: optionalString,
  BACKUP_OFFSITE_KEEP: intWithDefault(30, 1, 3650),
  AI_MAX_TOKENS: intWithDefault(4096, 256, 64_000),
  AI_DAILY_LIMIT: intWithDefault(500, 0, 1_000_000),
  AI_CHAT_HOURLY_LIMIT: intWithDefault(20, 0, 10_000),
  TOCHKA_API_URL: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim().replace(/\/+$/, '') : undefined),
    z.url().refine((url) => url.startsWith('https://'), 'нужен https://').default('https://enter.tochka.com/uapi'),
  ),
  TOCHKA_JWT: optionalString,
  TOCHKA_MERCHANT_ID: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined),
    z.string().regex(/^[A-Z0-9]{4,32}$/, 'ожидается идентификатор ТСП, например MA0000086825').optional(),
  ),
  TOCHKA_ACCOUNT_ID: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined),
    z.string().regex(/^\d{20}\/\d{9}$/, 'ожидается «счёт/БИК», например 40702810123456789012/044525104').optional(),
  ),
  SMM_TEXT_MODEL: modelWithDefault(SMM_MODEL_DEFAULTS.text),
  SMM_IMAGE_MODEL: modelWithDefault(SMM_MODEL_DEFAULTS.image),
  SMM_VIDEO_MODEL: modelWithDefault(SMM_MODEL_DEFAULTS.video),
  SMM_IMAGE_RESOLUTION: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim().toUpperCase() : undefined),
    z.enum(['1K', '2K', '4K']).default('1K'),
  ),
  SMM_RELAY_KEY: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined),
    z
      .string()
      .regex(/^[A-Za-z0-9_-]{16,128}$/, 'ожидается секрет из 16–128 латинских букв, цифр, «_» или «-»')
      .optional(),
  ),
  APNS_KEY_ID: optionalString,
  APNS_TEAM_ID: optionalString,
  APNS_PRIVATE_KEY: optionalString,
  APNS_BUNDLE_ID: optionalString,
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  publicUrl: string | null;
  jwtSecret: string;
  admin: { login: string; password: string; name: string };
  telegram: { token: string | null; enabled: boolean; apiRoot: string };
  ai: {
    baseUrl: string | null;
    apiKey: string | null;
    auth: 'bearer' | 'x-api-key';
    model: string;
    /** Polza Media API model for service cover pictures. */
    imageModel: string;
    maxTokens: number;
    httpsProxy: string | null;
    dailyLimit: number;
    chatHourlyLimit: number;
  };
  /** SBP QR payments through Tochka Bank; enabled when the JWT, merchant and account are all set. */
  tochka: {
    apiUrl: string;
    jwt: string | null;
    /** SBP merchant (ТСП) id, e.g. `MA0000086825` — not the 15-digit acquiring id. */
    merchantId: string | null;
    /** `<20-digit account>/<BIC>` the money is credited to. */
    accountId: string | null;
  };
  /** SMM marketer (docs/SMM.md): Polza models and the Cloudflare Worker route for the outside internet. */
  smm: {
    textModel: string;
    imageModel: string;
    videoModel: string;
    imageResolution: '1K' | '2K' | '4K';
    /** Secret of the Worker's `/web/<key>/…` route (its `WEB_RELAY_KEY`); null — t.me and Instagram go direct. */
    relayKey: string | null;
  };
  /** Encrypted copies of the daily backup in S3-compatible storage; `null` when not configured. */
  offsiteBackup: OffsiteBackupConfig | null;
  /** Why the off-site copies are off although some of their settings are given (a half-done setup), else null. */
  offsiteBackupProblem: string | null;
  /** Staff push notifications (APNs); `null` when not configured. */
  apns: ApnsConfig | null;
  /** Why pushes are off although some APNS_* settings are given (partial or invalid), else null. */
  apnsProblem: string | null;
  logLevel: string;
}

export interface OffsiteBackupConfig {
  s3: S3Config;
  prefix: string;
  /** AES-256 key (32 bytes). */
  key: Buffer;
  keep: number;
}

const OFFSITE_KEYS = ['BACKUP_S3_ENDPOINT', 'BACKUP_S3_BUCKET', 'BACKUP_S3_ACCESS_KEY_ID', 'BACKUP_S3_SECRET_ACCESS_KEY', 'BACKUP_ENCRYPTION_KEY'] as const;

/** Off-site backups need all five settings; a partial set is reported, never half-used (no unencrypted copies). */
function offsiteOf(e: z.infer<typeof envSchema>): { config: OffsiteBackupConfig | null; problem: string | null } {
  const missing = OFFSITE_KEYS.filter((k) => !e[k]);
  if (missing.length === OFFSITE_KEYS.length) return { config: null, problem: null };
  if (missing.length > 0) return { config: null, problem: `не заданы ${missing.join(', ')}` };
  const key = Buffer.from(e.BACKUP_ENCRYPTION_KEY!, 'base64');
  if (key.length !== 32) return { config: null, problem: 'BACKUP_ENCRYPTION_KEY должен быть 32 байтами в base64 (openssl rand -base64 32)' };
  return {
    config: {
      s3: {
        endpoint: e.BACKUP_S3_ENDPOINT!,
        region: e.BACKUP_S3_REGION,
        bucket: e.BACKUP_S3_BUCKET!,
        accessKeyId: e.BACKUP_S3_ACCESS_KEY_ID!,
        secretAccessKey: e.BACKUP_S3_SECRET_ACCESS_KEY!,
      },
      prefix: e.BACKUP_S3_PREFIX,
      key,
      keep: e.BACKUP_OFFSITE_KEEP,
    },
    problem: null,
  };
}

function parseEnv<T extends z.ZodType>(schema: T, env: NodeJS.ProcessEnv): z.infer<T> {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(env)'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid configuration: ${details}`);
  }
  return parsed.data;
}

const tochkaSchema = envSchema.pick({ TOCHKA_API_URL: true, TOCHKA_JWT: true, TOCHKA_MERCHANT_ID: true, TOCHKA_ACCOUNT_ID: true });

function tochkaOf(e: z.infer<typeof tochkaSchema>): Config['tochka'] {
  return {
    apiUrl: e.TOCHKA_API_URL,
    jwt: e.TOCHKA_JWT ?? null,
    merchantId: e.TOCHKA_MERCHANT_ID ?? null,
    accountId: e.TOCHKA_ACCOUNT_ID ?? null,
  };
}

/** Only the Tochka settings: the setup script runs without the rest of the server configuration. */
export function loadTochkaConfig(env: NodeJS.ProcessEnv = process.env): Config['tochka'] {
  return tochkaOf(parseEnv(tochkaSchema, env));
}

const aiSchema = envSchema.pick({
  AI_BASE_URL: true,
  AI_API_KEY: true,
  AI_AUTH: true,
  AI_MODEL: true,
  AI_IMAGE_MODEL: true,
  AI_HTTPS_PROXY: true,
  AI_MAX_TOKENS: true,
  AI_DAILY_LIMIT: true,
  AI_CHAT_HOURLY_LIMIT: true,
});

function aiOf(e: z.infer<typeof aiSchema>): Config['ai'] {
  const baseUrl = e.AI_BASE_URL ?? null;
  return {
    baseUrl,
    apiKey: e.AI_API_KEY ?? null,
    // A custom gateway (e.g. Polza) usually expects a Bearer token; Anthropic direct uses x-api-key.
    auth: e.AI_AUTH ?? (baseUrl ? 'bearer' : 'x-api-key'),
    model: e.AI_MODEL,
    imageModel: e.AI_IMAGE_MODEL,
    maxTokens: e.AI_MAX_TOKENS,
    httpsProxy: e.AI_HTTPS_PROXY ?? null,
    dailyLimit: e.AI_DAILY_LIMIT,
    chatHourlyLimit: e.AI_CHAT_HOURLY_LIMIT,
  };
}

/** Only the AI settings: the AI quality check (`npm run eval:ai`) runs without the rest of the server configuration. */
export function loadAiConfig(env: NodeJS.ProcessEnv = process.env): Config['ai'] {
  return aiOf(parseEnv(aiSchema, env));
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = parseEnv(envSchema, env);
  const offsite = offsiteOf(e);
  const apns = apnsConfigOf(e);
  return {
    port: e.PORT,
    host: e.HOST,
    dataDir: path.resolve(e.DATA_DIR),
    publicUrl: e.PUBLIC_URL ?? null,
    jwtSecret: e.JWT_SECRET,
    admin: { login: e.ADMIN_LOGIN, password: e.ADMIN_PASSWORD, name: e.ADMIN_NAME },
    telegram: { token: e.TELEGRAM_BOT_TOKEN ?? null, enabled: e.BOT_ENABLED, apiRoot: e.TELEGRAM_API_ROOT },
    ai: aiOf(e),
    tochka: tochkaOf(e),
    smm: {
      textModel: e.SMM_TEXT_MODEL,
      imageModel: e.SMM_IMAGE_MODEL,
      videoModel: e.SMM_VIDEO_MODEL,
      imageResolution: e.SMM_IMAGE_RESOLUTION,
      relayKey: e.SMM_RELAY_KEY ?? null,
    },
    offsiteBackup: offsite.config,
    offsiteBackupProblem: offsite.problem,
    apns: apns.config,
    apnsProblem: apns.problem,
    logLevel: e.LOG_LEVEL,
  };
}
