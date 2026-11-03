import type { AppointmentOut, DepositOperationOut, QrPaymentOut, SaleOut } from '../lib/serialize.js';
import { formatRub } from '../lib/text.js';
import { diffChanges, type AuditDraft } from './audit.js';
import type { SummaryBuilder, SummaryContext } from './audit-summaries.js';
import {
  countText,
  describeChanges,
  entityOf,
  formatWhen,
  labelsSuffix,
  maybeEntity,
  personName,
  priceDetail,
  textOf,
} from './audit-text.js';
import type { serializeShift } from './cash.js';
import type { serializeReceipt } from './receipts.js';

/** Audit summaries of visits and money: appointments, prepayments, sales, open receipts, the cash register, QR codes. */

type ReceiptOut = ReturnType<typeof serializeReceipt>;
type ShiftOut = ReturnType<typeof serializeShift>;

const APPOINTMENT_LABELS: Record<string, string> = {
  client: 'клиент',
  master: 'мастер',
  services: 'услуги',
  title: 'описание',
  startsAt: 'время',
  endsAt: 'время окончания',
  price: 'цена',
  depositRequired: 'нужная предоплата',
  notes: 'заметки',
};
/** Derived fields, or ones with entries of their own (the prepayment). */
export const APPOINTMENT_IGNORE = [
  'service',
  'deposit',
  'depositStatus',
  'depositOperations',
  'depositLink',
  'cancellation',
  'receiptId',
  'saleId',
  'completedAt',
  'channel',
  'holdUntil',
];

/** «№1846 (Анна Иванова)» */
export const appointmentRef = (id: number, client: unknown): string =>
  `№${id} (${personName(client as { name?: unknown; lastName?: unknown } | null)})`;

const titleOf = (a: Pick<AppointmentOut, 'id' | 'client'>) => `Запись ${appointmentRef(a.id, a.client)}`;

function statusSummary(title: string, from: string, to: string): string {
  switch (to) {
    case 'confirmed':
      return `${title} подтверждена`;
    case 'cancelled':
      return `${title} отменена`;
    case 'no_show':
      return `${title}: клиент не пришёл`;
    case 'completed':
      return `${title} завершена`;
    case 'scheduled':
      return from === 'cancelled' || from === 'no_show' ? `${title} восстановлена` : `${title} снова ждёт подтверждения`;
    default:
      return `${title}: статус ${from} → ${to}`;
  }
}

const appointmentDraft = (a: AppointmentOut, action: string, summary: string, changes: AuditDraft['changes']): AuditDraft => ({
  action,
  entity: 'appointment',
  entityId: a.id,
  summary,
  changes,
});

function appointmentCreate(c: SummaryContext): AuditDraft {
  const a = entityOf<AppointmentOut>(c.result);
  const what = a.services.map((s) => s.name).join(', ') || a.title?.trim() || '';
  const summary = `${titleOf(a)} создана на ${formatWhen(a.startsAt, c.tz, c.now)}${what ? ` — ${what}` : ''}, мастер ${a.master.name}`;
  return appointmentDraft(a, 'appointment.create', summary, null);
}

/** A status change, a move (time or master) or another edit — in that order of importance. */
function appointmentPatch(c: SummaryContext): AuditDraft {
  const after = entityOf<AppointmentOut>(c.result);
  const before = maybeEntity<AppointmentOut>(c.before);
  const title = titleOf(after);
  const changes = diffChanges(before, after, APPOINTMENT_IGNORE);
  if (!before) return appointmentDraft(after, 'appointment.update', `${title} изменена`, changes);
  const moved = before.startsAt !== after.startsAt;
  const remastered = before.master.id !== after.master.id;
  const motion = [
    moved ? `перенесена с ${formatWhen(before.startsAt, c.tz, c.now)} на ${formatWhen(after.startsAt, c.tz, c.now)}` : null,
    remastered ? `мастер ${before.master.name} → ${after.master.name}` : null,
  ]
    .filter(Boolean)
    .join(', ');
  if (before.status !== after.status) {
    const summary = statusSummary(title, before.status, after.status);
    return appointmentDraft(after, 'appointment.status', motion ? `${summary}, ${motion}` : summary, changes);
  }
  if (motion) return appointmentDraft(after, 'appointment.move', moved ? `${title} ${motion}` : `${title}: ${motion}`, changes);
  const words = describeChanges(changes, APPOINTMENT_LABELS, { price: priceDetail });
  const summary = words.length ? `${title} изменена${labelsSuffix(words)}` : `${title} сохранена без изменений`;
  return appointmentDraft(after, 'appointment.update', summary, changes);
}

function appointmentComplete(c: SummaryContext): AuditDraft {
  const result = c.result as { appointment?: unknown; consumption?: { used?: unknown } } | undefined;
  const a = entityOf<AppointmentOut>(result?.appointment);
  const used = Array.isArray(result?.consumption?.used) ? result.consumption.used.length : 0;
  const summary = `${titleOf(a)} завершена${used ? `, списано расходников: ${used}` : ''}`;
  return appointmentDraft(a, 'appointment.complete', summary, diffChanges(c.before, a, APPOINTMENT_IGNORE));
}

/** Staff settle an online booking: `…/online/confirm`, `…/online/reject` (docs/API.md «Online booking»). */
function onlineConfirm(c: SummaryContext): AuditDraft {
  const a = entityOf<AppointmentOut>(c.result);
  const summary = `Онлайн-запись ${appointmentRef(a.id, a.client)} на ${formatWhen(a.startsAt, c.tz, c.now)} подтверждена`;
  return appointmentDraft(a, 'appointment.online_confirm', summary, { onlineState: { from: 'awaiting_confirmation', to: null } });
}

function onlineReject(c: SummaryContext): AuditDraft {
  const a = entityOf<AppointmentOut>(c.result);
  const before = maybeEntity<AppointmentOut>(c.before);
  const reason = textOf(c.body.reason);
  const summary =
    `Онлайн-запись ${appointmentRef(a.id, a.client)} на ${formatWhen(a.startsAt, c.tz, c.now)} отклонена` +
    (reason ? `. Причина: ${reason}` : '');
  return appointmentDraft(a, 'appointment.online_reject', summary, before ? { status: { from: before.status, to: a.status } } : null);
}

// ---------- prepayments (entity `deposit`, id of the appointment) ----------

const METHOD_WORDS: Record<string, string> = { cash: 'наличными', card: 'картой', transfer: 'переводом', qr: 'по QR-коду' };

const lastOperation = (a: AppointmentOut, type: string): DepositOperationOut | undefined =>
  [...a.depositOperations].reverse().find((op) => op.type === type);

function depositOperation(type: 'receive' | 'refund' | 'retain', verb: string): SummaryBuilder {
  return (c) => {
    const a = entityOf<AppointmentOut>(c.result);
    const op = lastOperation(a, type);
    const amount = op ? `: ${formatRub(op.amount)}` : '';
    const method = op?.method ? `, ${METHOD_WORDS[op.method] ?? op.method}` : '';
    const reason = type !== 'receive' && op?.note ? `. Причина: ${op.note}` : '';
    return {
      action: `deposit.${type}`,
      entity: 'deposit',
      entityId: a.id,
      summary: `Предоплата по записи ${appointmentRef(a.id, a.client)} ${verb}${amount}${method}${reason}`,
      changes: null,
    };
  };
}

interface DepositLinkOut {
  appointment?: unknown;
  payment?: Pick<QrPaymentOut, 'amount'>;
  sendError?: string | null;
}

function depositLink(c: SummaryContext): AuditDraft {
  const result = c.result as DepositLinkOut | undefined;
  const a = entityOf<AppointmentOut>(result?.appointment);
  const delivery = textOf(c.body.delivery);
  const sendError = textOf(result?.sendError);
  const how =
    delivery === 'telegram'
      ? sendError
        ? `, в Telegram не отправлена: ${sendError}`
        : ', отправлена клиенту в Telegram'
      : delivery === 'screen'
        ? ', QR-код показан на экране'
        : '';
  const amount = result?.payment ? `: ${formatRub(result.payment.amount)}` : '';
  return {
    action: 'deposit.link',
    entity: 'deposit',
    entityId: a.id,
    summary: `Ссылка на предоплату по записи ${appointmentRef(a.id, a.client)}${amount}${how}`,
    changes: null,
  };
}

function depositRemind(c: SummaryContext): AuditDraft {
  const result = c.result as DepositLinkOut | undefined;
  const a = entityOf<AppointmentOut>(result?.appointment);
  const sendError = textOf(result?.sendError);
  return {
    action: 'deposit.remind',
    entity: 'deposit',
    entityId: a.id,
    summary: `Напоминание о предоплате по записи ${appointmentRef(a.id, a.client)} ${sendError ? `не отправлено: ${sendError}` : 'отправлено клиенту'}`,
    changes: null,
  };
}

// ---------- sales and QR codes ----------

function itemsText(names: string[]): string {
  if (names.length === 0) return '';
  const shown = names.slice(0, 3).join(', ');
  return ` — ${names.length > 3 ? `${shown} и ещё ${names.length - 3}` : shown}`;
}

/** «. Бонусами 300 ₽, сертификатом 1 000 ₽» — the loyalty parts of a sale's payment, when any. */
function loyaltyPaid(s: Pick<SaleOut, 'payments'>): string {
  const parts = [
    (s.payments.bonus ?? 0) > 0 ? `бонусами ${formatRub(s.payments.bonus)}` : null,
    (s.payments.certificate ?? 0) > 0 ? `сертификатом ${formatRub(s.payments.certificate)}` : null,
  ].filter(Boolean);
  return parts.length ? `. Оплачено ${parts.join(', ')}` : '';
}

function saleCreate(c: SummaryContext): AuditDraft {
  const s = entityOf<SaleOut>(c.result);
  const client = s.client ? ` (${personName(s.client)})` : '';
  return {
    action: 'sale.create',
    entity: 'sale',
    entityId: s.id,
    summary: `Продажа №${s.number}${client} проведена: ${formatRub(s.total)}${itemsText(s.items.map((i) => i.name))}${loyaltyPaid(s)}`,
    changes: null,
  };
}

/** «Лабрет — 8 мм × 1, Серьга × 2» — the lines of a refund (the first three). */
function refundLinesText(items: SaleOut['refunds'][number]['items']): string {
  const names = items.map((i) => `${i.name} × ${i.quantity}`);
  return names.length > 3 ? `${names.slice(0, 3).join(', ')} и ещё ${names.length - 3}` : names.join(', ');
}

/**
 * A refund of the whole receipt at once reads «Продажа №17 возвращена: 3 500 ₽»; a partial one names what came back —
 * «Возврат по чеку №17: Лабрет — 8 мм × 1, 1 350 ₽» (« — чек возвращён полностью» for the one returning the rest).
 */
function saleRefund(c: SummaryContext): AuditDraft {
  const s = entityOf<SaleOut>(c.result);
  const refund = s.refunds?.at(-1);
  const reasonText = refund?.reason ?? s.refundReason;
  const reason = reasonText ? `. Причина: ${reasonText}` : '';
  const restock = c.body.restock === false ? '. Товар не возвращён на склад' : '';
  const whole = !refund || (s.refunds.length === 1 && s.status === 'refunded');
  const what = whole
    ? `Продажа №${s.number} возвращена: ${formatRub(refund?.amount ?? s.total)}`
    : `Возврат по чеку №${s.number}: ${refundLinesText(refund.items)}, ${formatRub(refund.amount)}` +
      (s.status === 'refunded' ? ' — чек возвращён полностью' : '');
  return { action: 'sale.refund', entity: 'sale', entityId: s.id, summary: `${what}${reason}${restock}`, changes: null };
}

function qrCreate(c: SummaryContext): AuditDraft {
  const q = entityOf<QrPaymentOut>(c.result);
  return { action: 'sale.qr_create', entity: 'sale', entityId: null, summary: `QR-код на оплату №${q.id} выдан: ${formatRub(q.amount)}`, changes: null };
}

function qrCancel(c: SummaryContext): AuditDraft {
  const q = entityOf<QrPaymentOut>(c.result);
  const outcome =
    q.status === 'cancelled' ? 'отменён' : q.status === 'paid' ? 'уже оплачен, отмена не понадобилась' : 'уже не действует';
  return { action: 'sale.qr_cancel', entity: 'sale', entityId: q.sale?.id ?? null, summary: `QR-код на оплату №${q.id} ${outcome}`, changes: null };
}

/** «Чек №17 отправлен клиенту в Telegram» (or «в чат …» when staff picked one). */
function saleSend(c: SummaryContext): AuditDraft {
  const s = entityOf<SaleOut>(c.result);
  const where = typeof c.body.chatId === 'number' ? `в Telegram, в чат ${c.body.chatId}` : 'клиенту в Telegram';
  return { action: 'sale.send', entity: 'sale', entityId: s.id, summary: `Чек №${s.number} отправлен ${where}`, changes: null };
}

// ---------- open receipts ----------

function receiptLabel(r: Pick<ReceiptOut, 'id' | 'client' | 'appointment'>): string {
  const client = r.client ?? r.appointment?.client;
  return `Чек №${r.id}${client ? ` (${personName(client)})` : ''}`;
}

const receiptContent = (r: ReceiptOut) => `${formatRub(r.total)}, ${countText(r.itemCount, 'позиция', 'позиции', 'позиций')}`;

const RECEIPT_IGNORE = ['appointment', 'openedBy', 'items', 'itemCount', 'subtotal'];

const receiptDraft = (id: number, action: string, summary: string, changes: AuditDraft['changes']): AuditDraft => ({
  action,
  entity: 'receipt',
  entityId: id,
  summary,
  changes,
});

function receiptCreate(c: SummaryContext): AuditDraft {
  const r = entityOf<ReceiptOut>(c.result);
  const visit = r.appointment ? `, запись №${r.appointment.id}` : '';
  return receiptDraft(r.id, 'receipt.create', `${receiptLabel(r)} открыт: ${receiptContent(r)}${visit}`, null);
}

function receiptUpdate(c: SummaryContext): AuditDraft {
  const r = entityOf<ReceiptOut>(c.result);
  return receiptDraft(r.id, 'receipt.update', `${receiptLabel(r)} изменён: ${receiptContent(r)}`, diffChanges(c.before, r, RECEIPT_IGNORE));
}

function receiptDelete(c: SummaryContext): AuditDraft {
  const before = maybeEntity<ReceiptOut>(c.before);
  const id = before?.id ?? Number(c.params.id);
  return receiptDraft(id, 'receipt.delete', `${before ? receiptLabel(before) : `Чек №${id}`} удалён`, null);
}

// ---------- the cash register (entity `cash`, id of the shift) ----------

const signedRub = (amount: number): string => (amount > 0 ? `+${formatRub(amount)}` : `−${formatRub(-amount)}`);

function shiftOpen(c: SummaryContext): AuditDraft {
  const s = entityOf<ShiftOut>(c.result);
  return { action: 'cash.shift_open', entity: 'cash', entityId: s.id, summary: `Смена №${s.id} открыта: в кассе ${formatRub(s.openingCash)}`, changes: null };
}

function shiftClose(c: SummaryContext): AuditDraft {
  const s = entityOf<ShiftOut>(c.result);
  const difference = s.difference ? `, расхождение ${signedRub(s.difference)}` : ', без расхождений';
  return {
    action: 'cash.shift_close',
    entity: 'cash',
    entityId: s.id,
    summary: `Смена №${s.id} закрыта: в кассе ${formatRub(s.closingCash ?? 0)}${difference}`,
    changes: null,
  };
}

function cashOperation(c: SummaryContext): AuditDraft {
  const op = entityOf<{ id: number; shiftId: number; type: string; amount: number; reason: string | null }>(c.result);
  const what = op.type === 'in' ? 'Внесение в кассу' : 'Изъятие из кассы';
  return {
    action: `cash.${op.type}`,
    entity: 'cash',
    entityId: op.shiftId,
    summary: `${what}: ${formatRub(op.amount)}${op.reason ? ` — ${op.reason}` : ''}`,
    changes: null,
  };
}

export const visitSummaries: Record<string, SummaryBuilder> = {
  'POST /appointments': appointmentCreate,
  'PATCH /appointments/:id': appointmentPatch,
  'POST /appointments/:id/complete': appointmentComplete,
  'POST /appointments/:id/online/confirm': onlineConfirm,
  'POST /appointments/:id/online/reject': onlineReject,
  'POST /appointments/:id/deposit': depositOperation('receive', 'принята'),
  'POST /appointments/:id/deposit/refund': depositOperation('refund', 'возвращена'),
  'POST /appointments/:id/deposit/retain': depositOperation('retain', 'удержана'),
  'POST /appointments/:id/deposit/qr': depositLink,
  'POST /appointments/:id/deposit/remind': depositRemind,
  'POST /sales': saleCreate,
  'POST /sales/:id/refund': saleRefund,
  'POST /qr-payments': qrCreate,
  'POST /qr-payments/:id/cancel': qrCancel,
  'POST /receipts': receiptCreate,
  'PUT /receipts/:id': receiptUpdate,
  'DELETE /receipts/:id': receiptDelete,
  'POST /cash/shift/open': shiftOpen,
  'POST /cash/shift/close': shiftClose,
  'POST /cash/operations': cashOperation,
  'POST /sales/:id/send': saleSend,
};
