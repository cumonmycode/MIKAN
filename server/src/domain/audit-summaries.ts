import { silentLogger, type Logger } from '../context.js';
import { errorMessage } from '../lib/errors.js';
import { diffChanges, type AuditDraft } from './audit.js';
import { campaignSummaries } from './audit-summaries-campaigns.js';
import { catalogSummaries } from './audit-summaries-catalog.js';
import { loyaltySummaries } from './audit-summaries-loyalty.js';
import { portfolioSummaries } from './audit-summaries-portfolio.js';
import { teamSummaries } from './audit-summaries-team.js';
import { visitSummaries } from './audit-summaries-visits.js';
import { waitlistSummaries } from './audit-summaries-waitlist.js';

/** One successful write request, as the capture hook (routes/audit-capture.ts) saw it. */
export interface SummaryContext {
  method: string;
  /** Route pattern without the `/api` prefix, e.g. `/appointments/:id`. */
  route: string;
  /** Actual path without the prefix and the query, e.g. `/appointments/12`. */
  path: string;
  params: Record<string, string | undefined>;
  query: Record<string, unknown>;
  /** The request body as sent (validated by the route, which succeeded). Never stored. */
  body: Record<string, unknown>;
  /** The entity before the write (see the snapshot loaders), when the route has one. */
  before: unknown;
  /** The response payload. */
  result: unknown;
  /** Studio timezone and the moment of the request, for wording dates. */
  tz: string;
  now: number;
}

/** Builds the entry of one route; may leave `changes` undefined to get the diff of `before` and `result`. */
export type SummaryBuilder = (c: SummaryContext) => AuditDraft;

/** Specific Russian summaries keyed by `METHOD /route`. */
export const SUMMARY_BUILDERS: Record<string, SummaryBuilder> = {
  ...visitSummaries,
  ...catalogSummaries,
  ...teamSummaries,
  ...loyaltySummaries,
  ...campaignSummaries,
  ...waitlistSummaries,
  ...portfolioSummaries,
};

/** First path segment → entity, for routes without a specific summary. */
const PATH_ENTITIES: Record<string, string> = {
  appointments: 'appointment',
  clients: 'client',
  services: 'service',
  'aftercare-templates': 'aftercare',
  products: 'product',
  stock: 'stock',
  catalog: 'category',
  sales: 'sale',
  'qr-payments': 'sale',
  certificates: 'certificate',
  receipts: 'receipt',
  cash: 'cash',
  employees: 'employee',
  schedules: 'schedule',
  payroll: 'payroll',
  settings: 'settings',
  knowledge: 'knowledge',
  bot: 'bot',
  'booking-requests': 'bot',
  campaigns: 'campaign',
  waitlist: 'waitlist',
};

const VERBS: Record<string, string> = { POST: 'create', PUT: 'update', PATCH: 'update', DELETE: 'delete' };

/** «Изменение: PUT /employees/3/schedule» with the entity taken from the path. */
export function defaultDraft(c: SummaryContext): AuditDraft {
  const segment = c.path.split('/').find(Boolean) ?? 'other';
  const entity = PATH_ENTITIES[segment] ?? segment.replace(/s$/, '');
  const id = Number(c.params.id);
  return {
    action: `${entity}.${VERBS[c.method] ?? c.method.toLowerCase()}`,
    entity,
    entityId: Number.isSafeInteger(id) && id > 0 ? id : null,
    summary: `Изменение: ${c.method} ${c.path}`,
  };
}

/** The entry for a write: its specific summary, else (also when building it fails) the default one. */
export function buildDraft(c: SummaryContext, log: Logger = silentLogger): AuditDraft {
  const key = `${c.method} ${c.route}`;
  const builder = SUMMARY_BUILDERS[key];
  let draft: AuditDraft;
  try {
    draft = builder ? builder(c) : defaultDraft(c);
  } catch (err) {
    log.warn({ err: errorMessage(err), route: key }, 'audit summary failed, default entry used');
    draft = defaultDraft(c);
  }
  return draft.changes === undefined ? { ...draft, changes: diffChanges(c.before, c.result) } : draft;
}
