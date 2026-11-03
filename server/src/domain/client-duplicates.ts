import { inArray } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { clients } from '../db/schema.js';
import { notFound } from '../lib/errors.js';
import { clientOut, type ClientRow } from '../lib/serialize.js';
import { searchKey } from '../lib/text.js';
import { clientStatsByIds } from './clients.js';
import { clientsByIds } from './refs.js';
import { getDismissedDuplicatePairs, setDismissedDuplicatePairs } from './settings.js';

/**
 * Likely duplicate client cards (docs/API.md «Clients» → «Duplicates»). Every card is read once (~1 000 rows, a few
 * columns), bucketed in memory by name and handles, and the pairs of a reason are joined into groups; only the cards
 * of the groups get their stats.
 */

/** Strongest first: a handle names one person, a full name may belong to namesakes, a first name is the weakest. */
export const DUPLICATE_REASONS = ['same_telegram', 'same_instagram', 'same_full_name', 'phoneless_same_name'] as const;
export type DuplicateReason = (typeof DUPLICATE_REASONS)[number];

type Candidate = Pick<ClientRow, 'id' | 'name' | 'lastName' | 'nameSort' | 'phone' | 'instagram' | 'telegramNick' | 'telegramUsername'>;

interface Keyed {
  card: Candidate;
  /** The full name: lowercase, `ё` = `е`, spaces collapsed. */
  full: string;
  first: string;
  /** Everything after the first word ('' when the card has only a first name). */
  last: string;
  handles: string[];
  instagram: string | null;
}

/** `"12:34"`, the smaller id first. */
export const pairKey = (a: number, b: number): string => (a < b ? `${a}:${b}` : `${b}:${a}`);

const handle = (value: string | null): string | null => value?.trim().replace(/^@/, '').toLowerCase() || null;

function keyed(card: Candidate): Keyed {
  // Older cards may hold the whole name in `name`: the words decide, not the field.
  const full = searchKey(card.name, card.lastName);
  const [first = '', ...rest] = full.split(' ');
  const handles = [handle(card.telegramNick), handle(card.telegramUsername)].filter((h): h is string => h !== null);
  return { card, full, first, last: rest.join(' '), handles: [...new Set(handles)], instagram: handle(card.instagram) };
}

function bucket(cards: Keyed[], keysOf: (c: Keyed) => Array<string | null>): Keyed[][] {
  const buckets = new Map<string, Keyed[]>();
  for (const card of cards) {
    for (const key of keysOf(card)) {
      if (key) buckets.set(key, [...(buckets.get(key) ?? []), card]);
    }
  }
  return [...buckets.values()].filter((list) => list.length > 1);
}

type PairRule = (a: Keyed, b: Keyed) => boolean;

/** How each reason buckets cards, and which pairs inside a bucket count. */
const RULES: Record<DuplicateReason, { keys: (c: Keyed) => Array<string | null>; pair: PairRule }> = {
  same_telegram: { keys: (c) => c.handles, pair: () => true },
  same_instagram: { keys: (c) => [c.instagram], pair: () => true },
  same_full_name: { keys: (c) => [c.last ? c.full : null], pair: () => true },
  // The same first name where a card has no phone; when both have a last name it is `same_full_name` or not a match.
  phoneless_same_name: {
    keys: (c) => [c.first || null],
    pair: (a, b) => (a.card.phone === null || b.card.phone === null) && (a.last === '' || b.last === ''),
  },
};

/** Connected cards of the pairs (union-find), groups of two or more. */
function components(pairs: Array<[number, number]>): number[][] {
  const parent = new Map<number, number>();
  const root = (id: number): number => {
    let r = id;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(id, r);
    return r;
  };
  for (const [a, b] of pairs) {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    parent.set(root(a), root(b));
  }
  const groups = new Map<number, number[]>();
  for (const id of parent.keys()) groups.set(root(id), [...(groups.get(root(id)) ?? []), id]);
  return [...groups.values()].filter((g) => g.length > 1).map((g) => g.sort((x, y) => x - y));
}

function pairsOf(reason: DuplicateReason, cards: Keyed[], dismissed: ReadonlySet<string>): Array<[number, number]> {
  const rule = RULES[reason];
  const pairs: Array<[number, number]> = [];
  for (const list of bucket(cards, rule.keys)) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!;
        const b = list[j]!;
        if (a.card.id === b.card.id || dismissed.has(pairKey(a.card.id, b.card.id)) || !rule.pair(a, b)) continue;
        pairs.push([a.card.id, b.card.id]);
      }
    }
  }
  return pairs;
}

export interface DuplicateIds {
  reason: DuplicateReason;
  /** Ascending. */
  clientIds: number[];
}

/**
 * The groups of every reason, strongest first; a group whose cards all sit in a stronger group already is left out,
 * so a pair with the same Telegram and the same name shows once.
 */
export function findDuplicateIds(cards: Candidate[], dismissed: ReadonlySet<string>): DuplicateIds[] {
  const prepared = cards.map(keyed);
  const order = new Map(cards.map((c) => [c.id, c.nameSort]));
  const shown: Array<Set<number>> = [];
  const result: DuplicateIds[] = [];
  for (const reason of DUPLICATE_REASONS) {
    const groups = components(pairsOf(reason, prepared, dismissed))
      .filter((ids) => !shown.some((set) => ids.every((id) => set.has(id))))
      .sort((a, b) => nameOrder(a, order).localeCompare(nameOrder(b, order)) || a[0]! - b[0]!);
    for (const clientIds of groups) {
      shown.push(new Set(clientIds));
      result.push({ reason, clientIds });
    }
  }
  return result;
}

/** Groups of a reason go alphabetically, by the first name sort key among their cards. */
const nameOrder = (ids: number[], order: Map<number, string>): string =>
  ids.map((id) => order.get(id) ?? '').sort()[0] ?? '';

const CANDIDATE_COLUMNS = {
  id: clients.id,
  name: clients.name,
  lastName: clients.lastName,
  nameSort: clients.nameSort,
  phone: clients.phone,
  instagram: clients.instagram,
  telegramNick: clients.telegramNick,
  telegramUsername: clients.telegramUsername,
};

/** `GET /clients/duplicates`: groups with the cards and their stats, the card with most visits first. */
export function listDuplicates(db: DbOrTx) {
  const cards = db.select(CANDIDATE_COLUMNS).from(clients).all();
  const groups = findDuplicateIds(cards, new Set(getDismissedDuplicatePairs(db)));
  const ids = groups.flatMap((g) => g.clientIds);
  const rows = clientsByIds(db, ids);
  const stats = clientStatsByIds(db, ids);
  return groups.map((g) => ({
    reason: g.reason,
    clients: g.clientIds
      .map((id) => ({ row: rows.get(id)!, stats: stats.get(id)! }))
      .sort((a, b) => b.stats.visits - a.stats.visits || b.stats.totalSpent - a.stats.totalSpent || a.row.id - b.row.id)
      .map(({ row, stats: s }) => clientOut(row, s)),
  }));
}

/**
 * «Это разные люди»: the pairs among `clientIds` that would be offered are not offered again. Only matching pairs are
 * stored, so dismissing a large first-name group keeps the list small.
 */
export function dismissDuplicates(db: DbOrTx, clientIds: readonly number[]): void {
  db.transaction((tx) => {
    const cards = tx.select(CANDIDATE_COLUMNS).from(clients).where(inArray(clients.id, [...clientIds])).all();
    if (cards.length !== new Set(clientIds).size) throw notFound('Клиент не найден');
    const prepared = cards.map(keyed);
    const matching = DUPLICATE_REASONS.flatMap((reason) => pairsOf(reason, prepared, new Set()));
    const pairs = new Set([...getDismissedDuplicatePairs(tx), ...matching.map(([a, b]) => pairKey(a, b))]);
    setDismissedDuplicatePairs(tx, [...pairs]);
  });
}

/**
 * After a merge the source's dismissed pairs belong to the kept card (the staff said those people differ from it);
 * a pair of the two merged cards disappears.
 */
export function moveDismissedPairs(db: DbOrTx, sourceId: number, keptId: number): void {
  const pairs = getDismissedDuplicatePairs(db);
  const next = new Set<string>();
  for (const pair of pairs) {
    const [a, b] = pair.split(':').map(Number) as [number, number];
    const x = a === sourceId ? keptId : a;
    const y = b === sourceId ? keptId : b;
    if (x !== y) next.add(pairKey(x, y));
  }
  if (next.size !== pairs.length || pairs.some((p) => !next.has(p))) setDismissedDuplicatePairs(db, [...next]);
}
