import { describe, expect, it } from 'vitest';
import { MAIN_STAT_RANGES, SUB_STAT_TIERS } from './echoStats.ts';

/** Spot-checks transcribed from wuwaCalcu/echostats.md — failures mean a transcription typo. */
describe('echo stat tables', () => {
  it('bounds 1-cost mains (HP% 4.5–22.8, ATK%/DEF% 3.6–18)', () => {
    expect(MAIN_STAT_RANGES[1].hpPct).toEqual({ min: 0.045, max: 0.228 });
    expect(MAIN_STAT_RANGES[1].atkPct).toEqual({ min: 0.036, max: 0.18 });
    expect(MAIN_STAT_RANGES[1].defPct).toEqual({ min: 0.036, max: 0.18 });
    // 1-cost has no crit pool in the reference.
    expect(MAIN_STAT_RANGES[1].critRate).toBeUndefined();
  });

  it('bounds 3-cost mains (30% elementals, 32% ER, 38% DEF%)', () => {
    expect(MAIN_STAT_RANGES[3].atkPct).toEqual({ min: 0.06, max: 0.3 });
    expect(MAIN_STAT_RANGES[3]['dmgBonus:Electro']).toEqual({ min: 0.06, max: 0.3 });
    expect(MAIN_STAT_RANGES[3].energyRegen).toEqual({ min: 0.064, max: 0.32 });
    expect(MAIN_STAT_RANGES[3].defPct).toEqual({ min: 0.076, max: 0.38 });
  });

  it('bounds 4-cost mains (22% CR, 44% CD, 26.4% HB)', () => {
    expect(MAIN_STAT_RANGES[4].critRate).toEqual({ min: 0.044, max: 0.22 });
    expect(MAIN_STAT_RANGES[4].critDmg).toEqual({ min: 0.088, max: 0.44 });
    expect(MAIN_STAT_RANGES[4].healingBonus).toEqual({ min: 0.052, max: 0.264 });
    // 4-cost has no energy-regen pool in the reference.
    expect(MAIN_STAT_RANGES[4].energyRegen).toBeUndefined();
  });

  it('lists discrete 8-tier substat rolls', () => {
    expect(SUB_STAT_TIERS.atkPct).toHaveLength(8);
    expect(SUB_STAT_TIERS.atkPct?.[0]).toBeCloseTo(0.064, 10);
    expect(SUB_STAT_TIERS.atkPct?.[7]).toBeCloseTo(0.116, 10);
    expect(SUB_STAT_TIERS.critRate).toEqual([0.063, 0.069, 0.075, 0.081, 0.087, 0.093, 0.099, 0.105]);
    expect(SUB_STAT_TIERS.hp).toEqual([320, 360, 390, 430, 470, 510, 540, 580]);
  });

  it('lists discrete 4-tier flat ATK/DEF rolls', () => {
    expect(SUB_STAT_TIERS.atk).toEqual([30, 40, 50, 60]);
    expect(SUB_STAT_TIERS.def).toEqual([40, 50, 60, 70]);
  });
});
