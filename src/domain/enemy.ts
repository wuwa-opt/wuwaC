import type { Attribute } from '../data/schema.ts';
import { elementalBoss, standardMob, type EnemyProfile } from './damage.ts';

/**
 * Domain layer: enemy-profile builder for the Calculator page.
 * Pure function, no React. The RES slider is the source of truth —
 * `baseRES` always wins over the mob/boss preset for the matching
 * attribute, so what the user sees is what the formula gets.
 */

export type EnemyKind = 'mob' | 'boss';

/** The Calculator's enemy inputs, as saved with a build (`Build.enemy`). */
export interface EnemySettings {
  kind: EnemyKind;
  level: number;
  baseRES: number;
}

export const DEFAULT_ENEMY_LEVEL = 90;
export const DEFAULT_ENEMY_RES = 0.1;
export const MAX_ENEMY_LEVEL = 120;
export const MAX_ENEMY_RES = 0.8;

/**
 * Build an enemy profile from Calculator inputs.
 * - mob: every attribute bucket set to `baseRES`.
 * - boss: every attribute bucket set to `baseRES` except the attacker's
 *   own attribute, which is `max(baseRES, 0.4)` (elemental boss preset).
 */
export function buildEnemyProfile(
  kind: EnemyKind,
  level: number,
  baseRES: number,
  attribute: Attribute,
): EnemyProfile {
  if (!Number.isInteger(level) || level < 1 || level > MAX_ENEMY_LEVEL) {
    throw new Error(`enemy level must be a whole number from 1 to ${MAX_ENEMY_LEVEL}`);
  }
  if (!Number.isFinite(baseRES) || baseRES < 0 || baseRES > MAX_ENEMY_RES) {
    throw new Error(`enemy resistance must be between 0 and ${MAX_ENEMY_RES}`);
  }
  if (kind === 'boss') {
    const enemy = elementalBoss(level, attribute);
    // Slider wins, but never below the 40% boss preset for its element.
    enemy.baseResistance[attribute] = Math.max(baseRES, 0.4);
    for (const attr of Object.keys(enemy.baseResistance) as Attribute[]) {
      if (attr !== attribute) enemy.baseResistance[attr] = baseRES;
    }
    return enemy;
  }
  const enemy = standardMob(level);
  for (const attr of Object.keys(enemy.baseResistance) as Attribute[]) {
    enemy.baseResistance[attr] = baseRES;
  }
  return enemy;
}
