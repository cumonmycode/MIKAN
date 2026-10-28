import { and, eq, isNull } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import type { DbOrTx } from '../db/client.js';
import { clients } from '../db/schema.js';
import { formatBirthday } from '../lib/birthday.js';
import { clientFullName, type ClientRow } from '../lib/serialize.js';
import { auditSafely, writeAudit } from './audit.js';
import { quote } from './audit-text.js';

/**
 * The birthday the client gives themself (docs/API.md «Collecting birthdays»): the bot's question, the booking page
 * and the cabinet. It only fills an empty card — what staff typed is never overwritten.
 */

/** Where the client gave it: the bot's chat, or the booking page / Mini App / cabinet. */
export type BirthdayChannel = 'bot' | 'booking' | 'cabinet';

const WHERE: Record<BirthdayChannel, string> = { bot: 'в боте', booking: 'при онлайн-записи', cabinet: 'в личном кабинете' };

/** Sets the birthday of a card that has none; null when it already has one (nothing changes then). */
export function fillBirthday(db: DbOrTx, clientId: number, birthday: string, now = Date.now()): ClientRow | null {
  return (
    db
      .update(clients)
      .set({ birthday, updatedAt: now })
      .where(and(eq(clients.id, clientId), isNull(clients.birthday)))
      .returning()
      .get() ?? null
  );
}

/** The bot asked this client for the birthday (it never asks again); null — the question did not go out after all. */
export function markBirthdayAsked(db: DbOrTx, clientId: number, at: number | null): void {
  db.update(clients).set({ birthdayAskedAt: at }).where(eq(clients.id, clientId)).run();
}

/** «Клиент «Анна Иванова» указал(а) дату рождения в боте: 12 апреля» — `client.birthday`, as the client's own action. */
export function auditBirthdayGiven(ctx: AppContext, client: ClientRow, channel: BirthdayChannel): void {
  if (!client.birthday) return;
  const birthday = client.birthday;
  auditSafely(() => {
    writeAudit(
      ctx.db,
      {
        source: channel === 'bot' ? 'bot' : 'online',
        employeeId: null,
        action: 'client.birthday',
        entity: 'client',
        entityId: client.id,
        summary: `Клиент ${quote(clientFullName(client))} указал(а) дату рождения ${WHERE[channel]}: ${formatBirthday(birthday)}`,
        changes: { birthday: { from: null, to: birthday } },
      },
      ctx.log,
    );
  }, ctx.log);
}
