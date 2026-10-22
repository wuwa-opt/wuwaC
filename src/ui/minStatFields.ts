import type { StatKey } from '../data/schema.ts';
import { effectiveMinStats, type MinStats } from '../optimizer/minStats.ts';
import { parseDisplayValue, toDisplayValue } from './format.ts';

/**
 * The optional minimum-stat inputs, in the order shown (Calculator and the
 * Builds page editor). Typed as % and stored as sheet fractions
 * (`parseDisplayValue`), which is what `minStats` expects. Crit Rate/Crit DMG
 * sheet values include the 5%/150% bases; Energy Regen is the sheet's bonus
 * only (no base is seeded), so it reads as a bonus.
 */
export const MIN_STAT_FIELDS: { stat: StatKey; label: string; hint?: string }[] = [
  { stat: 'energyRegen', label: 'Energy Regen %', hint: 'Bonus only — the base isn\'t counted' },
  { stat: 'critRate', label: 'Crit Rate %' },
  { stat: 'critDmg', label: 'Crit DMG %' },
];

export type MinStatTexts = Partial<Record<StatKey, string>>;

export type MinStatsParse = { ok: true; minStats: MinStats | undefined } | { ok: false; message: string };

/**
 * Field text -> stored minimums. An empty box is no minimum; a 0 is too
 * (`effectiveMinStats`), and none left means `undefined`, never `{}`.
 * Anything else that isn't a non-negative number fails with a message.
 */
export function parseMinStatTexts(texts: MinStatTexts): MinStatsParse {
  const parsed: MinStats = {};
  for (const { stat, label } of MIN_STAT_FIELDS) {
    const text = texts[stat]?.trim() ?? '';
    if (text === '') continue;
    try {
      parsed[stat] = parseDisplayValue(stat, text);
    } catch {
      return {
        ok: false,
        message: `Minimum ${label.replace(' %', '')} must be a non-negative number (in %), or empty for no minimum.`,
      };
    }
  }
  return { ok: true, minStats: effectiveMinStats(parsed) };
}

/** Stored minimums -> field text (float noise trimmed: 0.7 -> "70"). */
export function minStatTextsFor(minStats: MinStats | undefined): MinStatTexts {
  const texts: MinStatTexts = {};
  for (const { stat } of MIN_STAT_FIELDS) {
    const value = minStats?.[stat];
    if (value !== undefined) texts[stat] = toDisplayValue(stat, value);
  }
  return texts;
}
