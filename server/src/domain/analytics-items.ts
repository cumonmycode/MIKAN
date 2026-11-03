import type { DbOrTx } from '../db/client.js';
import type { ProductRow, SaleItemRow, VariantRow } from '../lib/serialize.js';
import type { PeriodSales } from './analytics-sales.js';
import { productsByIds, servicesByIds, variantsByIds } from './refs.js';
import { isCertificateLine, keptLineRevenues, keptUnits } from './sale-revenue.js';

/**
 * Item-level breakdown of the kept sales: services by category, products by kind with cost of goods sold and margin,
 * and the tops. Each line counts by its kept units (what refunds have not returned) and their revenue, net of the sale
 * discount and the bonuses paid (`keptLineRevenues`); gift certificate lines are not revenue and are left out.
 */

export const ANALYTICS_TOP_LIMIT = 20;
/** Category of service items that have no catalog service (a custom line or a deleted service). */
const FALLBACK_CATEGORY = 'other';
/** Kind of product items whose product is missing. */
const FALLBACK_KIND = 'other';

/** `part / whole` in percent with one decimal; `null` when there is nothing to divide by. */
export const percentOf = (part: number, whole: number): number | null =>
  whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;

interface MarginSums {
  quantity: number;
  revenue: number;
  /** Revenue of the units whose cost is known. */
  revenueWithCost: number;
  cogs: number;
  /** Sold units whose cost is unknown (not in `cogs`, not in `revenueWithCost`). */
  itemsWithoutCost: number;
}

const emptySums = (): MarginSums => ({ quantity: 0, revenue: 0, revenueWithCost: 0, cogs: 0, itemsWithoutCost: 0 });

function addSold(sums: MarginSums, quantity: number, revenue: number, unitCost: number | null): void {
  sums.quantity += quantity;
  sums.revenue += revenue;
  if (unitCost == null) {
    sums.itemsWithoutCost += quantity;
    return;
  }
  sums.revenueWithCost += revenue;
  sums.cogs += quantity * unitCost;
}

/** Gross profit and margin are computed over the units with a known cost only. */
export function marginStats(s: MarginSums) {
  const grossProfit = s.revenueWithCost - s.cogs;
  return {
    quantity: s.quantity,
    revenue: s.revenue,
    revenueWithCost: s.revenueWithCost,
    cogs: s.cogs,
    grossProfit,
    marginPercent: percentOf(grossProfit, s.revenueWithCost),
    itemsWithoutCost: s.itemsWithoutCost,
  };
}

export type MarginStats = ReturnType<typeof marginStats>;

interface ProductEntry {
  productId: number | null;
  name: string;
  kind: string;
  sums: MarginSums;
  sizes: Map<number, { variantId: number; name: string; sums: MarginSums }>;
}

interface ServiceEntry {
  serviceId: number | null;
  name: string;
  category: string;
  quantity: number;
  revenue: number;
}

interface Lookups {
  products: Map<number, ProductRow>;
  variants: Map<number, VariantRow>;
  serviceNames: Map<number, { name: string; category: string }>;
}

function loadLookups(db: DbOrTx, items: SaleItemRow[]): Lookups {
  const services = servicesByIds(db, items.map((i) => i.serviceId));
  return {
    products: productsByIds(db, items.map((i) => i.productId)),
    variants: variantsByIds(db, items.map((i) => i.variantId)),
    serviceNames: new Map([...services.values()].map((s) => [s.id, { name: s.name, category: s.category }])),
  };
}

/** Current cost of a sold unit: the size's own cost, else the product's; `null` when neither is set. */
function unitCostOf(item: SaleItemRow, lookups: Lookups): number | null {
  const variant = item.variantId != null ? lookups.variants.get(item.variantId) : undefined;
  const product = item.productId != null ? lookups.products.get(item.productId) : undefined;
  return variant?.cost ?? product?.cost ?? null;
}

const byRevenue = <T extends { revenue: number; quantity: number }>(a: T, b: T) => b.revenue - a.revenue || b.quantity - a.quantity;

export function itemBreakdown(db: DbOrTx, s: PeriodSales) {
  const allItems = [...s.itemsBySale.values()].flat();
  const lookups = loadLookups(db, allItems);
  const productTotals = emptySums();
  const kinds = new Map<string, MarginSums>();
  const productTop = new Map<string, ProductEntry>();
  const categories = new Map<string, { category: string; quantity: number; revenue: number }>();
  const serviceTop = new Map<string, ServiceEntry>();
  let servicesQuantity = 0;
  let servicesRevenue = 0;

  for (const sale of s.kept) {
    const items = s.itemsBySale.get(sale.id) ?? [];
    const net = keptLineRevenues(sale, items);
    items.forEach((item, index) => {
      const value = net[index] ?? 0;
      const quantity = keptUnits(item);
      if (isCertificateLine(item) || quantity <= 0) return;
      if (item.type === 'product') {
        const product = item.productId != null ? lookups.products.get(item.productId) : undefined;
        const kind = product?.kind ?? FALLBACK_KIND;
        const cost = unitCostOf(item, lookups);
        addSold(productTotals, quantity, value, cost);
        const kindSums = kinds.get(kind) ?? emptySums();
        kinds.set(kind, kindSums);
        addSold(kindSums, quantity, value, cost);
        const key = `p${item.productId ?? item.name}`;
        const entry = productTop.get(key) ?? { productId: item.productId, name: product?.name ?? item.name, kind, sums: emptySums(), sizes: new Map() };
        productTop.set(key, entry);
        addSold(entry.sums, quantity, value, cost);
        if (item.variantId != null) {
          const size = entry.sizes.get(item.variantId) ?? {
            variantId: item.variantId,
            name: lookups.variants.get(item.variantId)?.name ?? item.variantName ?? '',
            sums: emptySums(),
          };
          entry.sizes.set(item.variantId, size);
          addSold(size.sums, quantity, value, cost);
        }
        return;
      }
      const catalog = item.serviceId != null ? lookups.serviceNames.get(item.serviceId) : undefined;
      const category = catalog?.category ?? FALLBACK_CATEGORY;
      servicesQuantity += quantity;
      servicesRevenue += value;
      const cat = categories.get(category) ?? { category, quantity: 0, revenue: 0 };
      categories.set(category, { ...cat, quantity: cat.quantity + quantity, revenue: cat.revenue + value });
      const key = item.serviceId != null ? `s${item.serviceId}` : `n${item.name.toLowerCase()}`;
      const top = serviceTop.get(key) ?? { serviceId: item.serviceId, name: catalog?.name ?? item.name, category, quantity: 0, revenue: 0 };
      serviceTop.set(key, { ...top, quantity: top.quantity + quantity, revenue: top.revenue + value });
    });
  }

  return {
    services: {
      quantity: servicesQuantity,
      revenue: servicesRevenue,
      byCategory: [...categories.values()].sort(byRevenue),
      top: [...serviceTop.values()].sort(byRevenue).slice(0, ANALYTICS_TOP_LIMIT),
    },
    products: {
      ...marginStats(productTotals),
      byKind: [...kinds.entries()].map(([kind, sums]) => ({ kind, ...marginStats(sums) })).sort(byRevenue),
      top: [...productTop.values()]
        .map((p) => ({
          productId: p.productId,
          name: p.name,
          kind: p.kind,
          ...marginStats(p.sums),
          variants: [...p.sizes.values()].map((v) => ({ variantId: v.variantId, name: v.name, ...marginStats(v.sums) })).sort(byRevenue),
        }))
        .sort(byRevenue)
        .slice(0, ANALYTICS_TOP_LIMIT),
    },
  };
}

export type ItemBreakdown = ReturnType<typeof itemBreakdown>;
