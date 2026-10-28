import type { AppContext } from '../context.js';
import { bonusExpiry, creditGiftBonuses } from './bonuses.js';

/**
 * Gift bonuses of the birthday greeting and the win-back message (docs/API.md «Birthday and win-back»), credited
 * through the bonus ledger (domain/bonuses.ts): a `gift` lot burning at the end of the studio day `days` days ahead.
 */

/** The last day the gift is valid (`YYYY-MM-DD`, studio time) and the moment it burns: the end of that day. */
export const giftBonusExpiry = bonusExpiry;

/** Credits `amount` gift bonuses that burn after `days` (see `giftBonusExpiry`); nothing for 0. */
export function grantGiftBonuses(ctx: Pick<AppContext, 'db'>, clientId: number, amount: number, days: number, note: string, now = Date.now()): void {
  if (amount <= 0) return;
  creditGiftBonuses(ctx.db, clientId, amount, days, note, now);
}
