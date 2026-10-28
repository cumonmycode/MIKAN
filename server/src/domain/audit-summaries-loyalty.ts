import { formatRub } from '../lib/text.js';
import { diffChanges, type AuditDraft } from './audit.js';
import type { SummaryBuilder, SummaryContext } from './audit-summaries.js';
import { describeChanges, entityOf, labelsSuffix, maybeEntity, personName, quote, textOf } from './audit-text.js';
import { bonusesText } from './bonuses.js';

/** Audit summaries of loyalty: manual bonus adjustments and gift certificate management. */

interface CertificateEntity {
  id: number;
  code: string;
  balance: number;
  recipientName: string | null;
}

const draft = (entity: string, verb: string, entityId: number | null, summary: string, changes: AuditDraft['changes'] = null): AuditDraft => ({
  action: `${entity}.${verb}`,
  entity,
  entityId,
  summary,
  changes,
});

/** «Начислено 500 бонусов клиенту «Анна Иванова»: Компенсация» / «Списано 300 бонусов у клиента …». */
function bonusAdjust(c: SummaryContext): AuditDraft {
  const op = entityOf<{ id: number; amount: number; note: string | null }>(c.result);
  const client = maybeEntity<{ id: number; name: string; lastName: string | null }>(c.before);
  const clientId = client?.id ?? Number(c.params.id);
  const who = client ? quote(personName(client)) : `№${clientId}`;
  const what = op.amount > 0 ? `Начислено ${bonusesText(op.amount)} клиенту ${who}` : `Списано ${bonusesText(-op.amount)} у клиента ${who}`;
  const note = textOf(op.note);
  return draft('client', 'bonus_adjust', clientId, `${what}${note ? `: ${note}` : ''}`, { bonuses: { from: null, to: op.amount } });
}

const CERTIFICATE_LABELS: Record<string, string> = { recipientName: 'получатель', note: 'комментарий', expiresAt: 'срок действия' };

function certificateUpdate(c: SummaryContext): AuditDraft {
  const after = entityOf<CertificateEntity>(c.result);
  const changes = diffChanges(maybeEntity(c.before), after, ['operations', 'buyer', 'status', 'balance']);
  const words = describeChanges(changes, CERTIFICATE_LABELS);
  const summary = words.length
    ? `Сертификат ${after.code} изменён${labelsSuffix(words)}`
    : `Сертификат ${after.code} сохранён без изменений`;
  return draft('certificate', 'update', after.id, summary, changes);
}

function certificateCancel(c: SummaryContext): AuditDraft {
  const after = entityOf<CertificateEntity>(c.result);
  const before = maybeEntity<CertificateEntity>(c.before);
  const burnt = before ? `: сгорело ${formatRub(before.balance)}` : '';
  const reason = textOf(c.body.reason);
  return draft('certificate', 'cancel', after.id, `Сертификат ${after.code} аннулирован${burnt}${reason ? `. Причина: ${reason}` : ''}`);
}

function certificateSend(c: SummaryContext): AuditDraft {
  const certificate = maybeEntity<CertificateEntity>(c.before);
  const id = certificate?.id ?? Number(c.params.id);
  const name = certificate ? certificate.code : `№${id}`;
  const where = typeof c.body.chatId === 'number' ? ` в чат ${c.body.chatId}` : ' покупателю';
  return draft('certificate', 'send', id, `Сертификат ${name} отправлен в Telegram${where}`);
}

export const loyaltySummaries: Record<string, SummaryBuilder> = {
  'POST /clients/:id/bonuses': bonusAdjust,
  'PATCH /certificates/:id': certificateUpdate,
  'POST /certificates/:id/cancel': certificateCancel,
  'POST /certificates/:id/send': certificateSend,
};
