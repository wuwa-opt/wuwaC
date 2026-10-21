import type { Attribute, DamageType, StatKey } from '../data/schema.ts';
import type { ResonanceMode } from '../domain/characterMods.ts';

/**
 * UI-layer number formatting. Ratios are stored as decimals but typed as
 * % numbers (6.3 means 6.3%); flats are typed as-is. Presentation only —
 * no game math lives here.
 */

const FLAT_STATS: ReadonlySet<StatKey> = new Set(['hp', 'atk', 'def', 'tuneBreakBoost']);

/** False for hp/atk/def (flat entry), true for every ratio-style stat. */
export function isPercentStat(stat: StatKey): boolean {
  return !FLAT_STATS.has(stat);
}

/** Stored value -> form text (trims float noise: 0.063 -> "6.3"). */
export function toDisplayValue(stat: StatKey, stored: number): string {
  if (!isPercentStat(stat)) return String(stored);
  return String(Math.round(stored * 100 * 1e6) / 1e6);
}

/** Display text with its unit: "9.3%" for ratio stats, "30" for flats. */
export function formatStatValue(stat: StatKey, stored: number): string {
  return `${toDisplayValue(stat, stored)}${isPercentStat(stat) ? '%' : ''}`;
}

/**
 * Stats whose sheet semantics admit negatives. Today only
 * `resistancePenetration`: RES shred is modeled as negative penetration,
 * so custom buffs must be able to enter it. Every other stat keeps the
 * non-negative guard (echo substats can never be negative).
 */
const SIGNED_STATS: ReadonlySet<StatKey> = new Set(['resistancePenetration']);

/**
 * Form text -> stored value. Throws on empty/non-numeric input, and on
 * negatives except for signed stats (see SIGNED_STATS).
 */
export function parseDisplayValue(stat: StatKey, text: string): number {
  const trimmed = text.trim();
  if (trimmed === '') throw new Error('stat value is required');
  const num = Number(trimmed);
  if (!Number.isFinite(num)) throw new Error(`not a number: ${JSON.stringify(text)}`);
  if (num < 0 && !SIGNED_STATS.has(stat)) throw new Error('stat value must be non-negative');
  return isPercentStat(stat) ? num / 100 : num;
}

const DAMAGE_TYPE_LABELS: Record<DamageType, string> = {
  basic: 'Basic Attack',
  heavy: 'Heavy Attack',
  skill: 'Resonance Skill',
  liberation: 'Resonance Liberation',
  intro: 'Intro Skill',
  outro: 'Outro Skill',
  echo: 'Echo Skill',
};

const ATTRIBUTE_LABELS: Record<Attribute, string> = {
  Glacio: 'Glacio',
  Fusion: 'Fusion',
  Electro: 'Electro',
  Aero: 'Aero',
  Spectro: 'Spectro',
  Havoc: 'Havoc',
};

/** Human label for a stat key (form selects, list rows). */
export function statLabel(stat: StatKey): string {
  switch (stat) {
    case 'hp':
      return 'HP';
    case 'hpPct':
      return 'HP%';
    case 'atk':
      return 'ATK';
    case 'atkPct':
      return 'ATK%';
    case 'def':
      return 'DEF';
    case 'defPct':
      return 'DEF%';
    case 'critRate':
      return 'Crit Rate';
    case 'critDmg':
      return 'Crit DMG';
    case 'energyRegen':
      return 'Energy Regen';
    case 'healingBonus':
      return 'Healing Bonus';
    case 'amplify':
      return 'DMG Amplify';
    case 'negativeStatusAmplify':
      return 'Negative Status DMG Amplify';
    case 'tuneBreakBoost':
      return 'Tune Break Boost';
    case 'defIgnore':
      return 'DEF Ignore';
    case 'defReduction':
      return 'DEF Reduction';
    case 'resistancePenetration':
      return 'RES Penetration';
    case 'specialBase':
      return 'Special Base';
    case 'specialBonus':
      return 'Special Bonus';
    default: {
      if (stat.startsWith('dmgBonus:')) {
        const bucket = stat.slice('dmgBonus:'.length);
        if (bucket in DAMAGE_TYPE_LABELS) {
          return `${DAMAGE_TYPE_LABELS[bucket as DamageType]} DMG`;
        }
        if (bucket === 'coordinated') return 'Coordinated Attack DMG';
        return `${ATTRIBUTE_LABELS[bucket as Attribute]} DMG`;
      }
      throw new Error(`unknown stat key: ${stat}`);
    }
  }
}

/** Display names for Resonance Modes (Calculator timeline, team allocation). */
export const RESONANCE_MODE_LABELS: Record<ResonanceMode, string> = {
  tuneRupture: 'Tune Rupture',
  fusionBurst: 'Fusion Burst',
  tuneStrain: 'Tune Strain',
};
