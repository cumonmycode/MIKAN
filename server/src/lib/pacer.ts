/** Time source of background senders: the real clock in production, a fake one in tests. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Spaces out sends so that at most `perSecond` go out in any second (one every `1000 / perSecond` ms). A slot is
 * reserved the moment `wait` is called, so several senders sharing one pacer never go out together.
 */
export class Pacer {
  private readonly intervalMs: number;
  private nextAt = 0;
  private heldUntil = 0;

  constructor(
    private readonly clock: Clock,
    perSecond: number,
  ) {
    this.intervalMs = 1000 / perSecond;
  }

  /** Resolves when the caller's send may go out. */
  async wait(): Promise<void> {
    const now = this.clock.now();
    const slot = Math.max(now, this.nextAt);
    this.nextAt = slot + this.intervalMs;
    if (slot > now) await this.clock.sleep(slot - now);
  }

  /** Telegram asked to slow down (flood limit): nothing goes out for `ms` from now. */
  holdFor(ms: number): void {
    const until = this.clock.now() + ms;
    this.heldUntil = Math.max(this.heldUntil, until);
    this.nextAt = Math.max(this.nextAt, until);
  }

  isHeld(): boolean {
    return this.clock.now() < this.heldUntil;
  }
}

/** Bulk Telegram messages (campaigns, birthday, win-back) together, well below Telegram's limit of ~30 a second. */
export const BULK_MESSAGES_PER_SECOND = 20;

const bulkPacers = new WeakMap<Clock, Pacer>();

/** The one pacer every bulk sender of this clock shares, so their rates add up to at most the limit. */
export function bulkPacer(clock: Clock): Pacer {
  let pacer = bulkPacers.get(clock);
  if (!pacer) {
    pacer = new Pacer(clock, BULK_MESSAGES_PER_SECOND);
    bulkPacers.set(clock, pacer);
  }
  return pacer;
}
