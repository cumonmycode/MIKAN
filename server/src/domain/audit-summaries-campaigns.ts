import { diffChanges, type AuditDraft } from './audit.js';
import type { SummaryBuilder, SummaryContext } from './audit-summaries.js';
import { countText, describeChanges, entityOf, formatWhen, labelsSuffix, maybeEntity, quote } from './audit-text.js';

/** Audit summaries of Telegram campaigns (docs/API.md «Campaigns»). */

interface CampaignOut {
  id: number;
  title: string;
  status: string;
  scheduledAt: string | null;
  stats: { recipients: number; sent: number };
}

const CAMPAIGN_LABELS: Record<string, string> = {
  title: 'название',
  text: 'текст',
  imageUrl: 'картинка',
  button: 'кнопка',
  segment: 'получатели',
};
const IGNORED = ['stats', 'status', 'startedAt', 'finishedAt', 'createdBy'];

const draft = (verb: string, entityId: number | null, summary: string, changes: AuditDraft['changes'] = null): AuditDraft => ({
  action: `campaign.${verb}`,
  entity: 'campaign',
  entityId,
  summary,
  changes,
});

const named = (c: { title: string }) => `Рассылка ${quote(c.title)}`;
const recipients = (n: number) => countText(n, 'получатель', 'получателя', 'получателей');

function create(c: SummaryContext): AuditDraft {
  const campaign = entityOf<CampaignOut>(c.result);
  return draft('create', campaign.id, `${named(campaign)} создана (черновик)`);
}

function update(c: SummaryContext): AuditDraft {
  const after = entityOf<CampaignOut>(c.result);
  const changes = diffChanges(c.before, after, IGNORED);
  const words = describeChanges(changes, CAMPAIGN_LABELS);
  const summary = words.length ? `${named(after)} изменена${labelsSuffix(words)}` : `${named(after)} сохранена без изменений`;
  return draft('update', after.id, summary, changes);
}

function send(c: SummaryContext): AuditDraft {
  const campaign = entityOf<CampaignOut>(c.result);
  if (campaign.status === 'scheduled' && campaign.scheduledAt) {
    return draft('schedule', campaign.id, `${named(campaign)} запланирована на ${formatWhen(campaign.scheduledAt, c.tz, c.now)}`);
  }
  return draft('send', campaign.id, `${named(campaign)} запущена: ${recipients(campaign.stats.recipients)}`);
}

function cancel(c: SummaryContext): AuditDraft {
  const campaign = entityOf<CampaignOut>(c.result);
  const before = maybeEntity<CampaignOut>(c.before);
  const summary =
    before?.status === 'scheduled'
      ? `Запланированная рассылка ${quote(campaign.title)} отменена`
      : `${named(campaign)} остановлена: отправлено ${campaign.stats.sent} из ${campaign.stats.recipients}`;
  return draft('cancel', campaign.id, summary);
}

function test(c: SummaryContext): AuditDraft {
  const before = maybeEntity<CampaignOut>(c.before);
  const id = before?.id ?? Number(c.params.id);
  return draft('test', id, `${before ? named(before) : `Рассылка №${id}`}: тестовое сообщение отправлено себе`);
}

function remove(c: SummaryContext): AuditDraft {
  const before = maybeEntity<CampaignOut>(c.before);
  const id = before?.id ?? Number(c.params.id);
  return draft('delete', id, `Черновик рассылки ${before ? quote(before.title) : `№${id}`} удалён`);
}

export const campaignSummaries: Record<string, SummaryBuilder> = {
  'POST /campaigns': create,
  'PATCH /campaigns/:id': update,
  'POST /campaigns/:id/send': send,
  'POST /campaigns/:id/cancel': cancel,
  'POST /campaigns/:id/test': test,
  'DELETE /campaigns/:id': remove,
};
