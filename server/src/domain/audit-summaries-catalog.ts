import type { ProductOut } from '../lib/serialize.js';
import { formatRub, formatServicePrice } from '../lib/text.js';
import { diffChanges, type AuditDraft } from './audit.js';
import type { SummaryBuilder, SummaryContext } from './audit-summaries.js';
import {
  countText,
  describeChanges,
  entityOf,
  labelsSuffix,
  maybeEntity,
  numberOf,
  personName,
  quote,
  rubChange,
  textOf,
  type ChangeDetail,
} from './audit-text.js';
import type { CategoryOut } from './categories.js';
import type { DeliveryOut } from './deliveries.js';
import type { serializeService } from './services.js';
import type { serializeMovements } from './stock.js';

/** Audit summaries of clients and the catalog: services, aftercare memos, products, stock and categories. */

type ServiceOut = ReturnType<typeof serializeService>;
type MovementOut = ReturnType<typeof serializeMovements>[number];
interface NamedEntity {
  id: number;
  name: string;
}

const draft = (entity: string, verb: string, entityId: number | null, summary: string, changes: AuditDraft['changes'] = null): AuditDraft => ({
  action: `${entity}.${verb}`,
  entity,
  entityId,
  summary,
  changes,
});

/** «…; также изменено: описание, фото» */
const alsoChanged = (words: string[]): string => (words.length ? `; также изменено: ${words.join(', ')}` : '');

// ---------- clients ----------

const CLIENT_LABELS: Record<string, string> = {
  name: 'имя',
  lastName: 'фамилия',
  phone: 'телефон',
  instagram: 'Instagram',
  telegramNick: 'Telegram',
  birthday: 'день рождения',
  notes: 'заметки',
  source: 'источник',
  botEnabled: 'сообщения бота',
  marketingOptOut: 'новости и предложения',
};
/** «новости и предложения отключены» rather than just the label. */
const CLIENT_DETAILS: Record<string, ChangeDetail> = {
  marketingOptOut: (_from, to) => (to === true ? 'новости и предложения отключены' : 'новости и предложения снова включены'),
};
const CLIENT_IGNORE = ['stats', 'loyalty', 'telegramLinked', 'telegramUsername'];
const clientCard = (client: unknown) => `Карточка клиента ${quote(personName(client as { name?: unknown } | null))}`;

function clientCreate(c: SummaryContext): AuditDraft {
  const client = entityOf<NamedEntity>(c.result);
  return draft('client', 'create', client.id, `${clientCard(client)} создана`);
}

function clientUpdate(c: SummaryContext): AuditDraft {
  const after = entityOf<NamedEntity & { archived: boolean }>(c.result);
  const before = maybeEntity<NamedEntity & { archived: boolean }>(c.before);
  const changes = diffChanges(before, after, CLIENT_IGNORE);
  if (before && before.archived !== after.archived) {
    const summary = `${clientCard(after)} ${after.archived ? 'перенесена в архив' : 'возвращена из архива'}`;
    return draft('client', after.archived ? 'archive' : 'restore', after.id, summary, changes);
  }
  const words = describeChanges(changes, CLIENT_LABELS, CLIENT_DETAILS);
  const summary = words.length ? `${clientCard(after)} изменена${labelsSuffix(words)}` : `${clientCard(after)} сохранена без изменений`;
  return draft('client', 'update', after.id, summary, changes);
}

function clientTelegramLink(c: SummaryContext): AuditDraft {
  const client = maybeEntity<NamedEntity>(c.before);
  const id = client?.id ?? Number(c.params.id);
  const who = client ? quote(personName(client)) : `№${id}`;
  return draft('client', 'telegram_link', id, `Для карточки клиента ${who} создана ссылка привязки Telegram`);
}

/** «Карточка «Анна» (+79991234567) объединена с «Анна Иванова»»: the source (deleted) named by its snapshot. */
function clientMerge(c: SummaryContext): AuditDraft {
  const kept = entityOf<NamedEntity>(c.result);
  const source = maybeEntity<NamedEntity & { phone?: unknown }>(c.before);
  const sourceId = source?.id ?? Number(c.params.id);
  const phone = textOf(source?.phone);
  const who = source ? `${quote(personName(source))}${phone ? ` (${phone})` : ''}` : `№${sourceId}`;
  const summary = `Карточка ${who} объединена с ${quote(personName(kept))}`;
  return draft('client', 'merge', kept.id, summary, { clientId: { from: sourceId, to: kept.id } });
}

/** «Карточки №12 и №34 отмечены как разные люди». */
function clientDismissDuplicates(c: SummaryContext): AuditDraft {
  const ids = Array.isArray(c.body.clientIds) ? c.body.clientIds.filter((id): id is number => typeof id === 'number') : [];
  const refs = ids.map((id) => `№${id}`);
  const list = refs.length > 1 ? `${refs.slice(0, -1).join(', ')} и ${refs.at(-1)}` : refs.join('');
  return draft('client', 'dismiss_duplicates', null, `Карточки ${list} отмечены как разные люди`);
}

// ---------- services and aftercare memos ----------

const SERVICE_LABELS: Record<string, string> = {
  name: 'название',
  category: 'раздел',
  group: 'категория',
  durationMin: 'длительность',
  description: 'описание',
  imageUrl: 'обложка',
  imagePrompt: 'описание обложки',
  photos: 'фото',
  variants: 'варианты',
  masterPrices: 'цены у мастеров',
  depositAmount: 'предоплата',
  aftercareTemplateId: 'памятка',
  freshProcedure: 'свежая процедура',
  healingCheckDays: 'вопрос о заживлении',
  jewelryChangeWeeks: 'замена украшения',
  jewelryIds: 'украшения',
  consumables: 'расходники',
  sort: 'порядок',
};
const PRICE_FIELDS = ['price', 'priceMax', 'priceFrom'];

const servicePrice = (s: ServiceOut) => formatServicePrice(s.price, s.priceMax, s.priceFrom);

function serviceCreate(c: SummaryContext): AuditDraft {
  const s = entityOf<ServiceOut>(c.result);
  return draft('service', 'create', s.id, `Услуга ${quote(s.name)} добавлена: ${servicePrice(s)}`);
}

function servicePriceText(before: ServiceOut, after: ServiceOut): string {
  const plain = (s: ServiceOut) => s.priceMax == null && !s.priceFrom;
  return plain(before) && plain(after) ? rubChange(before.price, after.price) : `${servicePrice(before)} → ${servicePrice(after)}`;
}

/** Shown or hidden, a new price (as in «Цена «Мочка»: 1 600 → 1 800 ₽»), else the changed fields. */
function serviceUpdate(c: SummaryContext): AuditDraft {
  const after = entityOf<ServiceOut>(c.result);
  const before = maybeEntity<ServiceOut>(c.before);
  const changes = diffChanges(before, after);
  const words = describeChanges(changes, SERVICE_LABELS);
  const name = quote(after.name);
  if (before && before.active !== after.active) {
    const summary = after.active ? `Услуга ${name} снова в каталоге` : `Услуга ${name} скрыта из каталога`;
    return draft('service', after.active ? 'show' : 'hide', after.id, `${summary}${alsoChanged(words)}`, changes);
  }
  if (before && PRICE_FIELDS.some((field) => changes && field in changes)) {
    return draft('service', 'price', after.id, `Цена ${name}: ${servicePriceText(before, after)}${alsoChanged(words)}`, changes);
  }
  const summary = words.length ? `Услуга ${name} изменена${labelsSuffix(words)}` : `Услуга ${name} сохранена без изменений`;
  return draft('service', 'update', after.id, summary, changes);
}

function serviceImage(c: SummaryContext): AuditDraft {
  const s = entityOf<ServiceOut>(c.result);
  return draft('service', 'image', s.id, `Обложка услуги ${quote(s.name)} сгенерирована`, null);
}

function memo(verb: 'create' | 'update' | 'delete', word: string): SummaryBuilder {
  return (c) => {
    const memoOut = entityOf<NamedEntity>(verb === 'delete' ? c.before : c.result);
    const changes = verb === 'update' ? diffChanges(c.before, memoOut) : null;
    const steps = changes && 'steps' in changes ? ': шаги' : '';
    return draft('aftercare', verb, memoOut.id, `Памятка ${quote(memoOut.name)} ${word}${verb === 'update' ? steps : ''}`, changes);
  };
}

// ---------- products and stock ----------

/** Nouns of the warehouse sections with the participles that agree with them. */
const KIND_WORDS: Record<string, { noun: string; added: string; changed: string; deleted: string; hidden: string; shown: string }> = {
  jewelry: { noun: 'Украшение', added: 'добавлено', changed: 'изменено', deleted: 'удалено', hidden: 'скрыто', shown: 'снова показано' },
  goods: { noun: 'Товар', added: 'добавлен', changed: 'изменён', deleted: 'удалён', hidden: 'скрыт', shown: 'снова показан' },
  consumable: { noun: 'Расходник', added: 'добавлен', changed: 'изменён', deleted: 'удалён', hidden: 'скрыт', shown: 'снова показан' },
};
const kindWords = (kind: string) => KIND_WORDS[kind] ?? KIND_WORDS.goods!;

const PRODUCT_LABELS: Record<string, string> = {
  kind: 'раздел',
  name: 'название',
  sku: 'артикул',
  category: 'категория',
  material: 'материал',
  threadType: 'резьба',
  thicknessMm: 'толщина',
  color: 'цвет',
  stone: 'камень',
  supplier: 'поставщик',
  description: 'описание',
  cost: 'себестоимость',
  unit: 'единица',
  photos: 'фото',
  serviceIds: 'услуги',
  stockMode: 'учёт остатка',
  presenceStatus: 'наличие',
  variants: 'размеры',
};
const PRODUCT_IGNORE = ['photoUrl', 'quantity', 'minQuantity', 'lowStock', 'size', 'archived'];

function productCreate(c: SummaryContext): AuditDraft {
  const p = entityOf<ProductOut>(c.result);
  const words = kindWords(p.kind);
  const price = p.price > 0 ? `: ${formatRub(p.price)}` : '';
  return draft('product', 'create', p.id, `${words.noun} ${quote(p.name)} ${words.added}${price}`);
}

function productUpdate(c: SummaryContext): AuditDraft {
  const after = entityOf<ProductOut>(c.result);
  const before = maybeEntity<ProductOut>(c.before);
  const changes = diffChanges(before, after, PRODUCT_IGNORE);
  const words = describeChanges(changes, PRODUCT_LABELS);
  const kind = kindWords(after.kind);
  const name = quote(after.name);
  if (before && before.active !== after.active) {
    const summary = `${kind.noun} ${name} ${after.active ? kind.shown : kind.hidden}`;
    return draft('product', after.active ? 'show' : 'hide', after.id, `${summary}${alsoChanged(words)}`, changes);
  }
  if (before && changes && 'price' in changes) {
    return draft('product', 'price', after.id, `Цена ${name}: ${rubChange(before.price, after.price)}${alsoChanged(words)}`, changes);
  }
  const summary = words.length ? `${kind.noun} ${name} ${kind.changed}${labelsSuffix(words)}` : `${kind.noun} ${name} сохранено без изменений`;
  return draft('product', 'update', after.id, summary, changes);
}

function productDelete(c: SummaryContext): AuditDraft {
  const before = maybeEntity<ProductOut>(c.before);
  const id = before?.id ?? Number(c.params.id);
  const writtenOff = numberOf((c.result as { writtenOff?: unknown } | undefined)?.writtenOff) ?? 0;
  const kind = kindWords(before?.kind ?? 'goods');
  const name = before ? quote(before.name) : `№${id}`;
  const rest = writtenOff > 0 ? `, остаток ${writtenOff} ${before?.unit ?? 'шт'} списан` : '';
  return draft('product', 'delete', id, `${kind.noun} ${name} ${kind.deleted}${rest}`);
}

const MOVEMENT_WORDS: Record<string, string> = { receipt: 'Приход', writeoff: 'Списание', usage: 'Расход', adjustment: 'Корректировка' };

const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`.replace('-', '−'));

function movementName(m: MovementOut): string {
  return m.variantName ? `${m.productName} — ${m.variantName}` : m.productName;
}

function stockMovement(c: SummaryContext): AuditDraft {
  const result = c.result as { product?: unknown; movement?: MovementOut } | undefined;
  const product = entityOf<ProductOut>(result?.product);
  const m = entityOf<MovementOut>(result?.movement);
  const what = MOVEMENT_WORDS[m.type] ?? m.type;
  const amount =
    m.type === 'adjustment'
      ? `${m.quantityAfter - m.delta} → ${m.quantityAfter} ${product.unit}`
      : `${signed(m.delta)} ${product.unit} (остаток ${m.quantityAfter})`;
  return draft('stock', m.type, product.id, `${what}: ${movementName(m)}, ${amount}${m.note ? ` — ${m.note}` : ''}`);
}

function stockBatch(c: SummaryContext): AuditDraft {
  const result = c.result as { product?: unknown; movements?: MovementOut[] } | undefined;
  const product = entityOf<ProductOut>(result?.product);
  const movements = result?.movements ?? [];
  const type = movements[0]?.type ?? 'receipt';
  const total = movements.reduce((sum, m) => sum + m.delta, 0);
  const sizes = countText(movements.length, 'размер', 'размера', 'размеров');
  const amount = type === 'adjustment' ? sizes : `${sizes}, ${signed(total)} ${product.unit}`;
  return draft('stock', type, product.id, `${MOVEMENT_WORDS[type] ?? type}: ${product.name}, ${amount}`);
}

function stockPurchase(c: SummaryContext): AuditDraft {
  const result = c.result as { product?: unknown; movement?: MovementOut } | undefined;
  const product = entityOf<ProductOut>(result?.product);
  const amount = numberOf(result?.movement?.amount) ?? numberOf(c.body.amount) ?? 0;
  return draft('stock', 'purchase', product.id, `Закупка ${quote(product.name)}: ${formatRub(amount)}`);
}

function stockRevision(c: SummaryContext): AuditDraft {
  const r = entityOf<{ id: number; number: number; counted: number; changed: number }>(c.result);
  const summary = `Ревизия №${r.number} проведена: посчитано ${r.counted}, расхождений ${r.changed}`;
  return draft('stock', 'revision', null, summary);
}

/** «Поставка №4 от Industrial Strength: 3 позиции, 14 шт, 12 400 ₽» (the sum when some line had a cost). */
function stockDelivery(c: SummaryContext): AuditDraft {
  const d = entityOf<DeliveryOut>(c.result);
  const from = d.supplier ? ` от ${d.supplier}` : '';
  const sum = d.lines.some((line) => line.amount != null) ? `, ${formatRub(d.total)}` : '';
  const summary = `Поставка №${d.number}${from}: ${countText(d.lineCount, 'позиция', 'позиции', 'позиций')}, ${d.itemCount} шт${sum}`;
  return draft('stock', 'delivery', null, summary);
}

// ---------- catalog categories ----------

const SECTION_TITLES: Record<string, string> = { jewelry: 'Украшения', goods: 'Товары', consumable: 'Расходники', service: 'Услуги' };

function categoryCreate(c: SummaryContext): AuditDraft {
  const category = entityOf<CategoryOut>(c.result);
  const section = SECTION_TITLES[category.section] ? ` (${SECTION_TITLES[category.section]})` : '';
  return draft('category', 'create', category.id, `Категория ${quote(category.name)}${section} добавлена`);
}

function categoryRename(c: SummaryContext): AuditDraft {
  const after = entityOf<CategoryOut>(c.result);
  const before = maybeEntity<CategoryOut>(c.before);
  const summary = before && before.name !== after.name
    ? `Категория ${quote(before.name)} переименована в ${quote(after.name)}`
    : `Категория ${quote(after.name)} сохранена без изменений`;
  return draft('category', 'rename', after.id, summary, diffChanges(before, after, ['itemCount']));
}

function categoryOrder(c: SummaryContext): AuditDraft {
  const first = (c.result as { items?: CategoryOut[] } | undefined)?.items?.[0];
  const section = first && SECTION_TITLES[first.section] ? ` (${SECTION_TITLES[first.section]})` : '';
  return draft('category', 'order', null, `Порядок категорий изменён${section}`);
}

function categoryMerge(c: SummaryContext): AuditDraft {
  const target = entityOf<CategoryOut>(c.result);
  const source = maybeEntity<CategoryOut>(c.before);
  const from = source ? quote(source.name) : `№${c.params.id}`;
  return draft('category', 'merge', target.id, `Категория ${from} объединена с ${quote(target.name)}`);
}

function categoryDelete(c: SummaryContext): AuditDraft {
  const before = maybeEntity<CategoryOut>(c.before);
  const id = before?.id ?? Number(c.params.id);
  return draft('category', 'delete', id, `Категория ${before ? quote(before.name) : `№${id}`} удалена`);
}

export const catalogSummaries: Record<string, SummaryBuilder> = {
  'POST /clients': clientCreate,
  'PATCH /clients/:id': clientUpdate,
  'POST /clients/:id/telegram-link': clientTelegramLink,
  'POST /clients/:id/merge': clientMerge,
  'POST /clients/duplicates/dismiss': clientDismissDuplicates,
  'POST /services': serviceCreate,
  'PATCH /services/:id': serviceUpdate,
  'POST /services/:id/image/generate': serviceImage,
  'POST /aftercare-templates': memo('create', 'добавлена'),
  'PATCH /aftercare-templates/:id': memo('update', 'изменена'),
  'DELETE /aftercare-templates/:id': memo('delete', 'удалена'),
  'POST /products': productCreate,
  'PATCH /products/:id': productUpdate,
  'DELETE /products/:id': productDelete,
  'POST /products/:id/movements': stockMovement,
  'POST /products/:id/movements/batch': stockBatch,
  'POST /products/:id/purchases': stockPurchase,
  'POST /stock/revisions': stockRevision,
  'POST /stock/deliveries': stockDelivery,
  'POST /catalog/categories': categoryCreate,
  'PATCH /catalog/categories/:id': categoryRename,
  'PUT /catalog/categories/order': categoryOrder,
  'POST /catalog/categories/:id/merge': categoryMerge,
  'DELETE /catalog/categories/:id': categoryDelete,
};
