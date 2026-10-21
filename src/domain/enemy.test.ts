import { describe, expect, it } from 'vitest';
import {
  buildEnemyProfile,
  DEFAULT_ENEMY_LEVEL,
  DEFAULT_ENEMY_RES,
  MAX_ENEMY_LEVEL,
  MAX_ENEMY_RES,
} from './enemy.ts';
import { computeResMultiplier } from './damage.ts';
import { buildSchema } from '../data/schema.ts';

describe('buildEnemyProfile', () => {
  it('exposes documented defaults (Lv90, 10% RES)', () => {
    expect(DEFAULT_ENEMY_LEVEL).toBe(90);
    expect(DEFAULT_ENEMY_RES).toBeCloseTo(0.1, 10);
    const enemy = buildEnemyProfile('mob', 90, 0.1, 'Aero');
    expect(enemy.level).toBe(90);
    expect(enemy.baseResistance.Aero).toBeCloseTo(0.1, 10);
    // Hand-computed: RES 0.10 -> multiplier 0.9.
    expect(computeResMultiplier(enemy.baseResistance.Aero)).toBeCloseTo(0.9, 10);
  });

  it('sets every bucket to the slider value for mobs', () => {
    const enemy = buildEnemyProfile('mob', 60, 0.25, 'Fusion');
    expect(enemy.baseResistance.Fusion).toBeCloseTo(0.25, 10);
    expect(enemy.baseResistance.Glacio).toBeCloseTo(0.25, 10);
    expect(enemy.baseResistance.Havoc).toBeCloseTo(0.25, 10);
    expect(computeResMultiplier(0.25)).toBeCloseTo(0.75, 10);
  });

  it('keeps the 40% boss preset when the slider is lower', () => {
    const enemy = buildEnemyProfile('boss', 90, 0.1, 'Aero');
    expect(enemy.baseResistance.Aero).toBeCloseTo(0.4, 10);
    expect(enemy.baseResistance.Fusion).toBeCloseTo(0.1, 10);
    // Hand-computed: RES 0.40 -> multiplier 0.6.
    expect(computeResMultiplier(enemy.baseResistance.Aero)).toBeCloseTo(0.6, 10);
  });

  it('lets the slider raise the boss element above the preset', () => {
    const enemy = buildEnemyProfile('boss', 90, 0.5, 'Aero');
    expect(enemy.baseResistance.Aero).toBeCloseTo(0.5, 10);
  });

  it('rejects out-of-range inputs', () => {
    expect(() => buildEnemyProfile('mob', 0, 0.1, 'Aero')).toThrow(/enemy level/);
    expect(() => buildEnemyProfile('mob', MAX_ENEMY_LEVEL + 1, 0.1, 'Aero')).toThrow(/enemy level/);
    expect(() => buildEnemyProfile('mob', 90, -0.01, 'Aero')).toThrow(/resistance/);
    expect(() => buildEnemyProfile('mob', 90, 0.81, 'Aero')).toThrow(/resistance/);
  });
});

describe('saved build enemy bounds', () => {
  // `buildSchema.enemy` can't import these (data layer); keep them in step.
  const build = (enemy: unknown) => ({
    id: 'b', name: 'B', characterId: 'jiyan', weaponId: 'w', echoIds: ['a', 'b', 'c', 'd', 'e'],
    objectiveId: 'o', updatedAt: '2026-10-21T00:00:00.000Z', enemy,
  });

  it('match the Calculator limits exactly', () => {
    expect(buildSchema.safeParse(build({ kind: 'mob', level: MAX_ENEMY_LEVEL, baseRES: MAX_ENEMY_RES })).success).toBe(true);
    expect(buildSchema.safeParse(build({ kind: 'mob', level: MAX_ENEMY_LEVEL + 1, baseRES: 0.1 })).success).toBe(false);
    expect(buildSchema.safeParse(build({ kind: 'mob', level: 90, baseRES: MAX_ENEMY_RES + 0.01 })).success).toBe(false);
    expect(buildSchema.safeParse(build({ kind: 'boss', level: 1, baseRES: 0 })).success).toBe(true);
  });
});
