import { describe, expect, it } from 'vitest';
import { effectiveMinStats, minStatKeys } from './minStats.ts';

describe('effectiveMinStats', () => {
  it('keeps positive finite minimums only, and is undefined when none remain', () => {
    expect(effectiveMinStats({ energyRegen: 0.2, critRate: 0, critDmg: -1, atk: Number.NaN })).toEqual({ energyRegen: 0.2 });
    expect(effectiveMinStats({ critRate: 0 })).toBeUndefined();
    expect(effectiveMinStats({})).toBeUndefined();
    expect(effectiveMinStats(undefined)).toBeUndefined();
  });
});

describe('minStatKeys', () => {
  it('lists the stats that actually have a minimum', () => {
    expect(minStatKeys({ energyRegen: 0.2, critRate: 0.6, critDmg: 0 })).toEqual(['energyRegen', 'critRate']);
    expect(minStatKeys(undefined)).toEqual([]);
  });
});
