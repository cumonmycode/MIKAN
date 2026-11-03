import type Anthropic from '@anthropic-ai/sdk';
import type { BotGateway } from './bot/gateway.js';
import type { Config } from './config.js';
import type { Db, Sqlite } from './db/client.js';
import type { GeneratedImage, ImageGenConfig } from './lib/service-images.js';
import type { QrProvider } from './payments/qr-provider.js';
import type { ApnsTransport } from './push/apns.js';

export interface Logger {
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/** Minimal Claude Messages API surface the bot needs (real SDK client in prod, scripted fake in tests). */
export interface AiClient {
  model: string;
  /** Includes adaptive thinking, which counts toward max_tokens. */
  maxTokens: number;
  createMessage(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
}

/** Generates one picture from a prompt (Polza Media API in prod, a fake in tests). */
export type ImageGenerator = (config: ImageGenConfig, prompt: string) => Promise<GeneratedImage>;

export interface AppContext {
  db: Db;
  sqlite: Sqlite;
  config: Config;
  log: Logger;
  gateway: BotGateway;
  /** null when no AI key is configured. */
  ai: AiClient | null;
  /** Overrides the real image generator (tests); defaults to `generateImage` from lib/service-images. */
  generateImage?: ImageGenerator;
  /** Overrides `fetch` for the SMM marketer's outside calls — Polza, the relay, downloads (tests). */
  smmFetch?: typeof fetch;
  /** SBP QR payments (Tochka); null when the bank credentials are not configured. */
  qr: QrProvider | null;
  /** Delivers staff pushes (HTTP/2 to Apple in prod, a fake in tests); nothing is pushed without it or `config.apns`. */
  apns?: ApnsTransport;
  /** Invoked after bot settings change (start/stop polling). */
  onBotSettingsChanged: () => void;
}

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
