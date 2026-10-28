import { describe, expect, it } from 'vitest';
import { bulkPacer, Pacer } from '../src/lib/pacer.js';
import { FakeClock } from './retention-fixtures.js';

describe('pacer', () => {
  it('concurrent senders get separate slots, one every 1000 / perSecond ms', async () => {
    const clock = new FakeClock(1_000);
    const pacer = new Pacer(clock, 20);
    const times: number[] = [];
    await Promise.all(
      [1, 2, 3, 4].map(async () => {
        await pacer.wait();
        times.push(clock.now());
      }),
    );
    expect(times.sort((a, b) => a - b)).toEqual([1_000, 1_050, 1_100, 1_150]);
  });

  it('a hold (Telegram flood limit) stops everything until it ends', async () => {
    const clock = new FakeClock(1_000);
    const pacer = new Pacer(clock, 20);
    pacer.holdFor(3_000);
    expect(pacer.isHeld()).toBe(true);
    await pacer.wait();
    expect(clock.now()).toBe(4_000);
    expect(pacer.isHeld()).toBe(false);
  });

  it('every bulk sender of one clock shares the same pacer', () => {
    const clock = new FakeClock(0);
    expect(bulkPacer(clock)).toBe(bulkPacer(clock));
    expect(bulkPacer(new FakeClock(0))).not.toBe(bulkPacer(clock));
  });
});
