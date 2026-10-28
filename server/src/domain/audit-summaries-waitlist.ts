import type { AuditDraft } from './audit.js';
import type { SummaryBuilder, SummaryContext } from './audit-summaries.js';
import { entityOf, personName } from './audit-text.js';
import { datesLabel } from './work-schedule.js';

/** Audit summaries of the waitlist in the app (docs/API.md «Waitlist» → «Audit»): adding and cancelling an entry. */

/** «Лист ожидания №5 (Анна Иванова)» */
export const waitlistTitle = (id: number, client: unknown): string =>
  `Лист ожидания №${id} (${personName(client as { name?: unknown; lastName?: unknown } | null)})`;

interface EntryOut {
  id: number;
  client: { name: string; lastName: string | null };
  items: Array<{ name: string; variant: string | null }>;
  master: { name: string } | null;
  dateFrom: string;
  dateTo: string;
  status: string;
}

const whatOf = (e: EntryOut): string => e.items.map((i) => (i.variant ? `${i.name} — ${i.variant}` : i.name)).join(', ') || 'услуга';

const wishOf = (e: EntryOut): string => `${whatOf(e)}, ${datesLabel(e.dateFrom, e.dateTo)}${e.master ? `, мастер ${e.master.name}` : ''}`;

const draft = (verb: string, id: number, summary: string, changes: AuditDraft['changes'] = null): AuditDraft => ({
  action: `waitlist.${verb}`,
  entity: 'waitlist',
  entityId: id,
  summary,
  changes,
});

function create(c: SummaryContext): AuditDraft {
  const e = entityOf<EntryOut>(c.result);
  return draft('create', e.id, `${waitlistTitle(e.id, e.client)}: добавлена заявка — ${wishOf(e)}`);
}

function cancel(c: SummaryContext): AuditDraft {
  const e = entityOf<EntryOut>(c.result);
  const before = c.before as EntryOut | undefined;
  return draft('cancel', e.id, `${waitlistTitle(e.id, e.client)}: заявка отменена — ${wishOf(e)}`, {
    status: { from: before?.status ?? null, to: e.status },
  });
}

export const waitlistSummaries: Record<string, SummaryBuilder> = {
  'POST /waitlist': create,
  'PATCH /waitlist/:id': cancel,
};
