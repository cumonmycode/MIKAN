import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import {
  BotSendError,
  type BotGateway,
  type BotMembership,
  type ChatInfo,
  type ChatRef,
  type HtmlOptions,
  type InlineKeyboard,
  type MediaFile,
  type PhotoSource,
  type ReplyKeyboard,
  type SendOptions,
  type SentMessage,
} from '../src/bot/gateway.js';
import { loadConfig, type Config } from '../src/config.js';
import { silentLogger, type AiClient, type AppContext, type ImageGenerator } from '../src/context.js';
import { openDatabase } from '../src/db/client.js';
import { seedDatabase } from '../src/db/seed.js';
import type { CreatedQr, QrBankStatus, QrProvider } from '../src/payments/qr-provider.js';
import type { ApnsTransport } from '../src/push/apns.js';

export const ADMIN = { login: 'admin', password: 'secret123', name: 'Админ' };

export interface FakeEdit {
  kind: 'photo' | 'text' | 'keyboard' | 'delete';
  chatId: number;
  messageId: number;
  photo?: PhotoSource;
  text?: string;
  keyboard?: InlineKeyboard | null;
}

export class FakeGateway implements BotGateway {
  running = true;
  usernameValue: string | null = 'mikan_test_bot';
  sent: Array<{ chatId: number; text: string; keyboard?: InlineKeyboard; replyKeyboard?: ReplyKeyboard; messageId: number }> = [];
  photos: Array<{ chatId: number; photo: PhotoSource; caption: string; keyboard?: InlineKeyboard; messageId?: number }> = [];
  edits: FakeEdit[] = [];
  typing = 0;
  /** Errors to throw on the next sendText calls (consumed in order). */
  failures: Error[] = [];
  private nextMessageId = 1000;

  isRunning(): boolean {
    return this.running;
  }
  username(): string | null {
    return this.usernameValue;
  }
  async sendText(chatId: number, text: string, options: SendOptions = {}): Promise<SentMessage> {
    const failure = this.failures.shift();
    if (failure) throw failure;
    const messageId = ++this.nextMessageId;
    this.sent.push({
      chatId,
      text,
      messageId,
      ...(options.keyboard ? { keyboard: options.keyboard } : {}),
      ...(options.replyKeyboard ? { replyKeyboard: options.replyKeyboard } : {}),
    });
    return { messageId };
  }
  async sendPhoto(chatId: number, photo: PhotoSource, caption: string, options: SendOptions = {}): Promise<SentMessage> {
    const messageId = ++this.nextMessageId;
    // `messageId` is kept off the record unless the photo has buttons, so plain photo assertions stay simple.
    this.photos.push({ chatId, photo, caption, ...(options.keyboard ? { keyboard: options.keyboard, messageId } : {}) });
    return { messageId };
  }
  async editPhoto(chatId: number, messageId: number, photo: PhotoSource, text: string, keyboard?: InlineKeyboard): Promise<void> {
    this.edits.push({ kind: 'photo', chatId, messageId, photo, text, keyboard: keyboard ?? null });
  }
  async editText(chatId: number, messageId: number, text: string, keyboard?: InlineKeyboard): Promise<void> {
    this.edits.push({ kind: 'text', chatId, messageId, text, keyboard: keyboard ?? null });
  }
  async editKeyboard(chatId: number, messageId: number, keyboard: InlineKeyboard | null): Promise<void> {
    this.edits.push({ kind: 'keyboard', chatId, messageId, keyboard });
  }
  async deleteMessage(chatId: number, messageId: number): Promise<void> {
    this.edits.push({ kind: 'delete', chatId, messageId });
  }
  async sendTyping(): Promise<void> {
    this.typing += 1;
  }
  textsTo(chatId: number): string[] {
    return this.sent.filter((s) => s.chatId === chatId).map((s) => s.text);
  }

  // SMM: HTML texts and files (channel posts, previews for approval, hand-offs) and the channels the bot sees.

  htmlSent: Array<{ chat: ChatRef; text: string; html: boolean; keyboard?: InlineKeyboard; messageId: number }> = [];
  mediaSent: Array<{ chat: ChatRef; files: MediaFile[]; caption: string; html: boolean; messageId: number }> = [];
  /** Errors to throw on the next sendHtml / sendMedia calls (consumed in order). */
  smmFailures: Error[] = [];
  /** Channels the bot can see: getChat, the bot's membership and the subscriber count. */
  channels: Array<{ info: ChatInfo; membership: BotMembership | null; members: number | null }> = [];

  async sendHtml(chat: ChatRef, text: string, options: HtmlOptions = {}): Promise<SentMessage> {
    const failure = this.smmFailures.shift();
    if (failure) throw failure;
    const messageId = ++this.nextMessageId;
    this.htmlSent.push({ chat, text, html: options.html !== false, messageId, ...(options.keyboard ? { keyboard: options.keyboard } : {}) });
    return { messageId };
  }
  async sendMedia(chat: ChatRef, files: MediaFile[], caption: string, options: HtmlOptions = {}): Promise<SentMessage> {
    const failure = this.smmFailures.shift();
    if (failure) throw failure;
    const messageId = ++this.nextMessageId;
    this.mediaSent.push({ chat, files, caption, html: options.html !== false, messageId });
    // An album takes one message id per file; the first one is returned.
    this.nextMessageId += Math.max(0, files.length - 1);
    return { messageId };
  }
  private channel(chat: ChatRef) {
    const ref = String(chat);
    return this.channels.find((c) => String(c.info.id) === ref || (c.info.username !== null && `@${c.info.username}` === ref)) ?? null;
  }
  async getChat(chat: ChatRef): Promise<ChatInfo | null> {
    return this.channel(chat)?.info ?? null;
  }
  async getBotMembership(chat: ChatRef): Promise<BotMembership | null> {
    return this.channel(chat)?.membership ?? null;
  }
  async getChatMemberCount(chat: ChatRef): Promise<number | null> {
    return this.channel(chat)?.members ?? null;
  }
  /** Everything SMM sent to a chat, in order: texts and file captions. */
  smmTo(chat: ChatRef): string[] {
    const ref = String(chat);
    return [
      ...this.htmlSent.filter((s) => String(s.chat) === ref).map((s) => ({ id: s.messageId, text: s.text })),
      ...this.mediaSent.filter((s) => String(s.chat) === ref).map((s) => ({ id: s.messageId, text: s.caption })),
    ]
      .sort((a, b) => a.id - b.id)
      .map((s) => s.text);
  }
}

export const blocked = () => new BotSendError('Telegram: Forbidden: bot was blocked by the user', true);

/** Scripted bank: hands out sequential QR ids and answers status checks from `statuses` (default `pending`). */
export class FakeQrProvider implements QrProvider {
  readonly name = 'fake';
  created: Array<{ amount: number; purpose: string; ttlMinutes: number }> = [];
  statuses = new Map<string, QrBankStatus>();
  statusChecks = 0;
  /** Thrown by the next createQr / paymentStatus call. */
  createFailure: Error | null = null;
  statusFailure: Error | null = null;
  /** Delay of each status answer, to overlap requests. */
  statusDelayMs = 0;

  async createQr(input: { amount: number; purpose: string; ttlMinutes: number }): Promise<CreatedQr> {
    if (this.createFailure) throw this.createFailure;
    this.created.push(input);
    const externalId = `QR${this.created.length}`;
    return { externalId, payload: `https://qr.nspk.ru/${externalId}?type=02&sum=${input.amount * 100}` };
  }
  async paymentStatus(externalId: string): Promise<QrBankStatus> {
    this.statusChecks += 1;
    if (this.statusDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.statusDelayMs));
    if (this.statusFailure) throw this.statusFailure;
    return this.statuses.get(externalId) ?? 'pending';
  }
}

type Script = Anthropic.Message | Error;

export function message(
  content: Array<Record<string, unknown>>,
  stopReason: Anthropic.Message['stop_reason'] = 'end_turn',
): Anthropic.Message {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 },
  } as unknown as Anthropic.Message;
}

export const text = (t: string) => ({ type: 'text', text: t, citations: null });
export const toolUse = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input });

export class ScriptedAi implements AiClient {
  model = 'test-model';
  maxTokens = 4096;
  calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  constructor(private readonly script: Script[] = []) {}
  push(...items: Script[]): this {
    this.script.push(...items);
    return this;
  }
  async createMessage(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
    this.calls.push(structuredClone(params));
    const next = this.script.shift();
    if (!next) throw new Error('ScriptedAi: no more responses');
    if (next instanceof Error) throw next;
    return next;
  }
}

export interface TestApp {
  app: FastifyInstance;
  ctx: AppContext;
  gateway: FakeGateway;
  token: string;
  api: (method: InjectOptions['method'], url: string, payload?: unknown) => ReturnType<FastifyInstance['inject']>;
  close: () => Promise<void>;
}

export function testConfig(overrides: Record<string, string> = {}): Config {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mikan-test-'));
  return loadConfig({
    JWT_SECRET: 'test-secret-test-secret-test-secret-42',
    ADMIN_LOGIN: ADMIN.login,
    ADMIN_PASSWORD: ADMIN.password,
    ADMIN_NAME: ADMIN.name,
    DATA_DIR: dataDir,
    ...overrides,
  });
}

/** Default image generator in tests: never touches the network. */
export const noImageGenerator: ImageGenerator = async () => {
  throw new Error('image generation is not stubbed in this test');
};

export async function createTestApp(
  opts: {
    ai?: AiClient | null;
    qr?: QrProvider | null;
    env?: Record<string, string>;
    gateway?: FakeGateway;
    generateImage?: ImageGenerator;
    apns?: ApnsTransport;
  } = {},
): Promise<TestApp> {
  const config = testConfig(opts.env);
  const { db, sqlite } = openDatabase(':memory:');
  seedDatabase(db, config);
  const gateway = opts.gateway ?? new FakeGateway();
  const ctx: AppContext = {
    db,
    sqlite,
    config,
    log: silentLogger,
    gateway,
    ai: opts.ai ?? null,
    generateImage: opts.generateImage ?? noImageGenerator,
    qr: opts.qr ?? null,
    ...(opts.apns ? { apns: opts.apns } : {}),
    onBotSettingsChanged: () => undefined,
  };
  const app = await buildApp(ctx);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: ADMIN.login, password: ADMIN.password } });
  const token = login.json<{ token: string }>().token;
  const api: TestApp['api'] = (method, url, payload) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload === undefined ? {} : { payload: payload as InjectOptions['payload'] }),
    });
  return {
    app,
    ctx,
    gateway,
    token,
    api,
    close: async () => {
      await app.close();
      sqlite.close();
      fs.rmSync(config.dataDir, { recursive: true, force: true });
    },
  };
}

/** Opens the cash shift — selling needs one (docs/API.md «Cash register»); returns its id. */
export async function openShift(t: TestApp, openingCash = 0): Promise<number> {
  const res = await t.api('POST', '/api/cash/shift/open', { openingCash });
  if (res.statusCode !== 200) throw new Error(`POST /api/cash/shift/open → ${res.statusCode}: ${res.body}`);
  return res.json<{ id: number }>().id;
}

/** Creates a service/product/client quickly through the API and returns the JSON body. */
export async function make(t: TestApp, url: string, payload: Record<string, unknown>) {
  const res = await t.api('POST', url, payload);
  if (res.statusCode !== 200) throw new Error(`POST ${url} → ${res.statusCode}: ${res.body}`);
  return res.json();
}
