import type { AppContext } from '../context.js';
import { clientFullName, type ClientRow, type EmployeeRow } from '../lib/serialize.js';
import { auditSafely, writeAudit, type AuditSource } from './audit.js';
import { waitlistTitle } from './audit-summaries-waitlist.js';
import { formatWhen } from './audit-text.js';
import { CHANNEL_LABELS } from './online-booking-messages.js';
import { wishSummary } from './waitlist-messages.js';
import type { WaitlistRow } from './waitlist-store.js';

/**
 * Audit entries of the waitlist outside app requests (docs/API.md «Waitlist» → «Audit», entity `waitlist`): client
 * joins (`bot` / `online`) and the freed-time message (`system`). Staff writes are captured like any app write
 * (domain/audit-summaries-waitlist.ts); closing an entry by a booking is logged by domain/waitlist-hooks.ts.
 */

function write(ctx: AppContext, source: AuditSource, row: WaitlistRow, verb: string, summary: string): void {
  writeAudit(ctx.db, { source, employeeId: null, action: `waitlist.${verb}`, entity: 'waitlist', entityId: row.id, summary }, ctx.log);
}

/** A client joined through the bot (`bot`), the Mini App or the website (`online`). */
export function auditClientJoined(ctx: AppContext, row: WaitlistRow, client: ClientRow, master: EmployeeRow | null): void {
  auditSafely(() => {
    const channel = CHANNEL_LABELS[row.channel] ?? row.channel;
    const summary = `${waitlistTitle(row.id, client)}: заявка клиента (${channel}) — ${wishSummary(ctx.db, row, master)}`;
    write(ctx, row.channel === 'bot' ? 'bot' : 'online', row, 'create', summary);
  }, ctx.log);
}

/** The client was told about freed time. */
export function auditNotified(ctx: AppContext, row: WaitlistRow, client: ClientRow, master: EmployeeRow, start: number, tz: string): void {
  auditSafely(() => {
    const summary =
      `${waitlistTitle(row.id, { name: clientFullName(client) })}: клиенту написали о свободном времени — ` +
      `${formatWhen(start, tz)}, мастер ${master.name}`;
    write(ctx, 'system', row, 'notify', summary);
  }, ctx.log);
}
