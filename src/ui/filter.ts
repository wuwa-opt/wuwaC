/**
 * UI-layer list filtering. Presentation only — no game math lives here.
 */

/** Case-insensitive substring filter; blank queries return everything. */
export function filterByName<T>(items: readonly T[], getName: (item: T) => string, query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [...items];
  return items.filter((item) => getName(item).toLowerCase().includes(needle));
}

/** Inventory usage filter: `unused` includes safe fodder (fodder is a subset of unused). */
export type UsageFilter = 'all' | 'unused' | 'fodder';

/** Keep items whose usage verdict matches `filter`; items without a verdict only pass `all`. */
export function filterByUsage<T extends { id: string }>(
  items: readonly T[],
  usage: ReadonlyMap<string, { status: 'in-use' | 'unused' | 'fodder' }>,
  filter: UsageFilter,
): T[] {
  if (filter === 'all') return [...items];
  return items.filter((item) => {
    const status = usage.get(item.id)?.status;
    return filter === 'fodder' ? status === 'fodder' : status === 'unused' || status === 'fodder';
  });
}
