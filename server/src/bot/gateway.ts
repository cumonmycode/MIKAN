/**
 * The only surface through which non-bot code talks to Telegram.
 * Routes and workers depend on this interface, never on grammY directly.
 */
export type PhotoSource = { kind: 'file'; path: string } | { kind: 'url'; url: string };

/**
 * One inline button: a callback button (`data` is its payload, ≤ 64 bytes, see TELEGRAM_MAX_CALLBACK_DATA), a link
 * button (`url`, opened by Telegram itself; nothing comes back to the bot) or a Mini App button (`webApp`, an
 * `https://` page Telegram opens inside the chat; private chats only).
 */
export type InlineButton =
  | { text: string; data: string; url?: undefined; webApp?: undefined }
  | { text: string; url: string; data?: undefined; webApp?: undefined }
  | { text: string; webApp: string; data?: undefined; url?: undefined };

/** Rows of inline buttons under a message. */
export type InlineKeyboard = InlineButton[][];

/** One button of the keyboard under the input field; `requestContact` makes it share the user's own phone. */
export interface ReplyButton {
  text: string;
  requestContact?: boolean;
}

/** Rows of buttons under the input field (shown resized and persistent). */
export type ReplyKeyboard = ReplyButton[][];

export interface SendOptions {
  /** Inline buttons under the message (under the last chunk of a long text). */
  keyboard?: InlineKeyboard;
  /** Replaces the keyboard under the input field (sent with the last chunk). Ignored when `keyboard` is set. */
  replyKeyboard?: ReplyKeyboard;
}

export interface SentMessage {
  /** Telegram message id (the last chunk of a long text). */
  messageId: number;
}

/** A chat for the SMM methods: a private chat id, a channel's `@username` or its numeric `-100…` id. */
export type ChatRef = number | string;

/** One file of a channel post or a hand-off: a photo, a video, or any file sent as is (no compression). */
export interface MediaFile {
  kind: 'photo' | 'video' | 'document';
  source: PhotoSource;
}

export interface HtmlOptions {
  /** Inline buttons under the message (under the last chunk of a long text). */
  keyboard?: InlineKeyboard;
  /** false: the text goes as is, without parse_mode. Default true — Telegram HTML. */
  html?: boolean;
}

export interface ChatInfo {
  id: number;
  /** private | group | supergroup | channel */
  type: string;
  title: string | null;
  username: string | null;
}

/** The bot's own membership in a chat. */
export interface BotMembership {
  /** creator | administrator | member | restricted | left | kicked */
  status: string;
  /** Administrators of a channel: the right to post (null when Telegram does not say). */
  canPostMessages: boolean | null;
}

export interface BotGateway {
  /** True while long polling is active and messages can be delivered. */
  isRunning(): boolean;
  /** Bot username (without @) once known, else null. */
  username(): string | null;
  sendText(chatId: number, text: string, options?: SendOptions): Promise<SentMessage>;
  sendPhoto(chatId: number, photo: PhotoSource, caption: string, options?: SendOptions): Promise<SentMessage>;
  /** Replaces the photo, caption and buttons of a photo message (carousel paging). */
  editPhoto(chatId: number, messageId: number, photo: PhotoSource, caption: string, keyboard?: InlineKeyboard): Promise<void>;
  /** Replaces the text and buttons of a text message. */
  editText(chatId: number, messageId: number, text: string, keyboard?: InlineKeyboard): Promise<void>;
  /** Replaces the buttons of a message; `null` removes them. */
  editKeyboard(chatId: number, messageId: number, keyboard: InlineKeyboard | null): Promise<void>;
  deleteMessage(chatId: number, messageId: number): Promise<void>;
  sendTyping(chatId: number): Promise<void>;

  // SMM (server/src/smm/telegram.ts): channel posts, previews for approval, hand-offs.

  /**
   * Sends text that is already Telegram HTML (no Markdown conversion); a long text goes in chunks. When Telegram
   * rejects the markup, the chunk is sent again with the tags stripped.
   */
  sendHtml(chat: ChatRef, text: string, options?: HtmlOptions): Promise<SentMessage>;
  /**
   * One file with a caption, or an album of 2–10 (the caption on the first item); `messageId` is the first
   * message's. The caption follows `options.html` and falls back to plain text like `sendHtml`.
   */
  sendMedia(chat: ChatRef, files: MediaFile[], caption: string, options?: HtmlOptions): Promise<SentMessage>;
  /** null when Telegram does not know the chat or the bot has no access to it. */
  getChat(chat: ChatRef): Promise<ChatInfo | null>;
  /** The bot's own status in the chat; null when the bot has no access to it. */
  getBotMembership(chat: ChatRef): Promise<BotMembership | null>;
  /** Subscribers of a channel (members of a group); null when unavailable. */
  getChatMemberCount(chat: ChatRef): Promise<number | null>;
  /** Points the chat menu button at the booking Mini App while online booking is on, else the default menu. */
  refreshBookingMenu?(): Promise<void>;
}

export class BotUnavailableError extends Error {
  constructor(message = 'Telegram-бот не запущен') {
    super(message);
    this.name = 'BotUnavailableError';
  }
}

/**
 * Telegram delivery failure. `blocked` = the user blocked the bot / chat is unreachable (HTTP 403). `retryAfterMs` —
 * Telegram's flood limit (HTTP 429): nothing should be sent for that long.
 */
export class BotSendError extends Error {
  readonly blocked: boolean;
  readonly retryAfterMs: number | null;

  constructor(message: string, blocked: boolean, retryAfterMs: number | null = null) {
    super(message);
    this.name = 'BotSendError';
    this.blocked = blocked;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Gateway used when the bot is disabled: reports not running, refuses to send. */
export class OfflineGateway implements BotGateway {
  private readonly cachedUsername: () => string | null;

  constructor(cachedUsername: () => string | null = () => null) {
    this.cachedUsername = cachedUsername;
  }

  isRunning(): boolean {
    return false;
  }

  username(): string | null {
    return this.cachedUsername();
  }

  async sendText(): Promise<SentMessage> {
    throw new BotUnavailableError();
  }

  async sendPhoto(): Promise<SentMessage> {
    throw new BotUnavailableError();
  }

  async editPhoto(): Promise<void> {
    throw new BotUnavailableError();
  }

  async editText(): Promise<void> {
    throw new BotUnavailableError();
  }

  async editKeyboard(): Promise<void> {
    throw new BotUnavailableError();
  }

  async deleteMessage(): Promise<void> {
    throw new BotUnavailableError();
  }

  async sendTyping(): Promise<void> {
    /* nothing to do */
  }

  async sendHtml(): Promise<SentMessage> {
    throw new BotUnavailableError();
  }

  async sendMedia(): Promise<SentMessage> {
    throw new BotUnavailableError();
  }

  async getChat(): Promise<ChatInfo | null> {
    throw new BotUnavailableError();
  }

  async getBotMembership(): Promise<BotMembership | null> {
    throw new BotUnavailableError();
  }

  async getChatMemberCount(): Promise<number | null> {
    throw new BotUnavailableError();
  }
}
