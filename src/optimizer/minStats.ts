import type { StatKey } from '../data/schema.ts';

/** `OptimizeRequest.minStats`: stored sheet values (fractions), absent = no minimum. */
export type MinStats = Partial<Record<StatKey, number>>;

/**
 * The minimums that actually filter: positive finite values only (a 0 or
 * negative minimum is no minimum). Undefined when none remain, so a request,
 * a plan key or a saved build never carries an empty object.
 */
export function effectiveMinStats(minStats: MinStats | undefined): MinStats | undefined {
  const entries = (Object.entries(minStats ?? {}) as [StatKey, number][]).filter(
    ([, value]) => Number.isFinite(value) && value > 0,
  );
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

/** The stats a build has a minimum on, for `pruneInputs`' `minStatKeys`. */
export function minStatKeys(minStats: MinStats | undefined): StatKey[] {
  return Object.keys(effectiveMinStats(minStats) ?? {}) as StatKey[];
}
