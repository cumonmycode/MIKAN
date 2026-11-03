import { diffChanges, type AuditDraft } from './audit.js';
import type { SummaryBuilder, SummaryContext } from './audit-summaries.js';
import { describeChanges, entityOf, labelsSuffix, maybeEntity, quote } from './audit-text.js';
import type { PortfolioPhotoOut } from './portfolio.js';

/** Audit summaries of masters' portfolio (docs/API.md «Portfolio»): entity `portfolio`, the photo's id. */

const LABELS: Record<string, string> = { caption: 'подпись', service: 'услуга' };
const IGNORE = ['sort'];

const draft = (verb: string, entityId: number | null, summary: string, changes: AuditDraft['changes'] = null): AuditDraft => ({
  action: `portfolio.${verb}`,
  entity: 'portfolio',
  entityId,
  summary,
  changes,
});

const owner = (p: Pick<PortfolioPhotoOut, 'employee'>) => quote(p.employee.name);

function photoCreate(c: SummaryContext): AuditDraft {
  const p = entityOf<PortfolioPhotoOut>(c.result);
  const service = p.service ? ` (услуга ${quote(p.service.name)})` : '';
  return draft('create', p.id, `Фото №${p.id} добавлено в портфолио ${owner(p)}${service}`);
}

function photoUpdate(c: SummaryContext): AuditDraft {
  const after = entityOf<PortfolioPhotoOut>(c.result);
  const before = maybeEntity<PortfolioPhotoOut>(c.before);
  const changes = diffChanges(before, after, IGNORE);
  const words = describeChanges(changes, LABELS);
  const what = `Фото №${after.id} в портфолио ${owner(after)}`;
  return draft('update', after.id, words.length ? `${what} изменено${labelsSuffix(words)}` : `${what} сохранено без изменений`, changes);
}

function photoOrder(c: SummaryContext): AuditDraft {
  const first = (c.result as { items?: PortfolioPhotoOut[] } | undefined)?.items?.[0];
  return draft('order', null, first ? `Порядок фото в портфолио ${owner(first)} изменён` : 'Порядок фото в портфолио изменён');
}

function photoDelete(c: SummaryContext): AuditDraft {
  const before = maybeEntity<PortfolioPhotoOut>(c.before);
  const id = before?.id ?? Number(c.params.id);
  return draft('delete', id, before ? `Фото №${id} удалено из портфолио ${owner(before)}` : `Фото №${id} удалено из портфолио`);
}

export const portfolioSummaries: Record<string, SummaryBuilder> = {
  'POST /portfolio': photoCreate,
  'PATCH /portfolio/:id': photoUpdate,
  'PUT /portfolio/order': photoOrder,
  'DELETE /portfolio/:id': photoDelete,
};
