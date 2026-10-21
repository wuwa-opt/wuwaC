import type { Attribute, CharacterData, CharacterSkill, OwnedEcho, SkillKind, StatKey } from '../data/schema.ts';
import type { ObjectiveSpec } from '../domain/objectives.ts';
import { resolveObjectiveSkill } from '../domain/objectives.ts';
import { hasMainEchoBonus } from '../domain/stats.ts';

/**
 * Optimizer layer: dominance pruning (reference doc §7, step 2).
 *
 * An echo D dominates I when both share cost and Sonata set and D
 * meets-or-beats I on every objective-relevant stat, strictly beating it on
 * at least one. Objective-relative by design: stats outside the relevant
 * set are ignored, so ties (and off-objective strengths) always survive.
 *
 * One dominator is NOT enough to drop I: a combo can hold several echoes of
 * the same cost (4-3-3-1-1 holds two 3-costs), so the dominator may already
 * sit in the very combo I belongs to. See `pruneDominated` for the counting
 * rule that keeps the top-N result identical to an unpruned search.
 * Pure functions.
 */

/**
 * Stats that can move the needle for an objective. `kind` is the motion's
 * own bonus bucket (DamageList.Type), not the parent skill kind; `scaling`
 * selects which ability-stat family matters. Unknown/`forte` buckets
 * conservatively include every action bucket — weaker pruning, never wrong.
 */
export function relevantStatsForObjective(
  spec: ObjectiveSpec,
  attribute: Attribute,
  kind: SkillKind,
  extraKeys: StatKey[],
  scaling: 'ATK' | 'HP' | 'DEF' = 'ATK',
): StatKey[] {
  const keys = new Set<StatKey>(extraKeys);
  if (spec.kind === 'max-stat') {
    keys.add(spec.stat);
    return [...keys];
  }
  const addScalingStats = (): void => {
    if (scaling === 'HP') {
      keys.add('hp');
      keys.add('hpPct');
    } else if (scaling === 'DEF') {
      keys.add('def');
      keys.add('defPct');
    } else {
      keys.add('atk');
      keys.add('atkPct');
    }
  };
  if (spec.kind === 'rotation-dpr') {
    // Blocks span unverified-at-search-time kinds/scalings, and buffs can
    // mod any stat — include every ability stat + every action bucket plus
    // every buff-modded stat. Weaker pruning, never wrong.
    keys.add('atk');
    keys.add('atkPct');
    keys.add('hp');
    keys.add('hpPct');
    keys.add('def');
    keys.add('defPct');
    keys.add('critRate');
    keys.add('critDmg');
    keys.add(`dmgBonus:${attribute}`);
    for (const bucket of ['basic', 'heavy', 'skill', 'liberation', 'intro', 'outro', 'echo'] as const) {
      keys.add(`dmgBonus:${bucket}`);
    }
    keys.add('defIgnore');
    keys.add('resistancePenetration');
    keys.add('amplify');
    keys.add('negativeStatusAmplify');
    keys.add('specialBase');
    keys.add('specialBonus');
    for (const buff of spec.buffs) {
      for (const mod of buff.mods) keys.add(mod.stat);
    }
    return [...keys];
  }
  addScalingStats();
  keys.add('critRate');
  keys.add('critDmg');
  keys.add(`dmgBonus:${attribute}`);
  if (kind === 'forte' || kind === 'tunebreak') {
    // Tune Break skills carry no bonus bucket — fall back to the same
    // conservative attribute-only set as unknown (`forte`) buckets.
    for (const bucket of ['basic', 'heavy', 'skill', 'liberation', 'intro'] as const) {
      keys.add(`dmgBonus:${bucket}`);
    }
  } else {
    keys.add(`dmgBonus:${kind}`);
  }
  keys.add('defIgnore');
  keys.add('resistancePenetration');
  keys.add('amplify');
  keys.add('specialBase');
  keys.add('specialBonus');
  return [...keys];
}

/** What one objective needs from the character to prune (see `pruneInputs`). */
export interface PruneInputs {
  /** The resolved skill of an `expected-damage` objective; undefined for other kinds. */
  skill: CharacterSkill | undefined;
  relevantStats: StatKey[];
  /** Whether an echo definition carries a main-slot bonus for this character. */
  isMainCarrier: (echoDefId: string) => boolean;
}

/**
 * The one derivation of pruning inputs for (character, objective), shared
 * by the search (`prepare`) and the unused-Echo finder so they can never
 * disagree. Pruning follows the motion's own bonus bucket (DamageList.Type)
 * and scaling, not the parent skill's — with a skill-level fallback for
 * legacy specs whose motion no longer resolves. `minStatKeys` are always
 * relevant. Throws (via `resolveObjectiveSkill`) on an unknown skill id.
 */
export function pruneInputs(
  character: CharacterData,
  objective: ObjectiveSpec,
  minStatKeys: readonly StatKey[] = [],
): PruneInputs {
  const skill =
    objective.kind === 'expected-damage' ? resolveObjectiveSkill(character.skills, objective) : undefined;
  let motion: CharacterSkill['motionValues'][number] | undefined;
  if (objective.kind === 'expected-damage' && skill !== undefined) {
    const wantedMotion = objective.motionName;
    motion = skill.motionValues.find((m) => m.name === wantedMotion);
  }
  const relevantStats = relevantStatsForObjective(
    objective,
    character.attribute,
    motion?.dmgType ?? skill?.kind ?? 'basic',
    [...minStatKeys],
    motion?.scaling ?? skill?.scaling ?? 'ATK',
  );
  return {
    skill,
    relevantStats,
    isMainCarrier: (echoDefId) => hasMainEchoBonus(character.id, echoDefId),
  };
}

export interface PruneResult {
  kept: OwnedEcho[];
  /** Ids dropped as dominated. */
  pruned: string[];
}

export interface PruneOptions {
  /** The request's cost budget; bounds how many same-cost echoes share a combo. */
  costBudget: number;
  /** Ranked results requested; each extra rank needs one extra dominator. */
  topN: number;
  /** Whether this echo definition carries a main-slot bonus for the character. */
  isMainCarrier?: (echoDefId: string) => boolean;
}

/**
 * Most echoes of `cost` that one legal 5-echo combo can hold: the largest m
 * with m·cost + (5 − m)·cheapest ≤ budget, where `cheapest` is the lowest
 * cost in the pool (every combo needs 5 echoes, so the others cost at least
 * that). With costs {1, 3, 4}: budget 12 -> 4-cost 2, 3-cost 3, 1-cost 5;
 * budget 10 -> 4-cost 1, 3-cost 2, 1-cost 5. 0 when no legal combo holds it.
 */
export function maxSameCostInCombo(cost: number, costBudget: number, poolCosts: readonly number[]): number {
  if (poolCosts.length === 0) return 0;
  const cheapest = Math.min(...poolCosts);
  for (let m = 5; m >= 1; m -= 1) {
    if (m * cost + (5 - m) * cheapest <= costBudget) return m;
  }
  return 0;
}

/**
 * Drop dominated echoes without changing the top-N result.
 *
 * Soundness argument. Let k = `maxSameCostInCombo(cost)`. Echo I (def dI,
 * set s) is dropped only when it has at least k + topN − 1 *counted*
 * dominators among echoes already kept. Counted dominators are:
 *   (a) every kept dominator with def dI, and
 *   (b) one per distinct def d ≠ dI among kept dominators, but only when
 *       every pool echo of set s with def d has I's cost,
 * and, when dI carries a main-slot bonus, only (a).
 *
 * Swap step: take any combo C containing I and a counted dominator D not
 * in C, and let C' = C − I + D. Same cost, so the budget holds. Relevant
 * stats only go up. Set s's distinct-def count can't drop: either dD = dI,
 * or dD is new to C − I (set s) and replaces at most the lost dI; other
 * sets are untouched, so every piece threshold and lock still holds.
 * Main-slot carriers in C' include those of C: a carrier I is only ever
 * replaced by its own def, and bonuses are non-negative. So
 * score(C') ≥ score(C).
 *
 * Availability: an echo E in C − I blocks at most one counted dominator.
 * (a) members are blocked only by membership. A (b) slot for def d is
 * blocked by membership or by any set-s echo of def d in C − I. So E blocks
 * itself if counted, plus the (b) slot of its own def; when E is counted
 * those are the same slot (E has def dI and blocks no (b) slot, or E is
 * the (b) slot of its def). Only echoes of I's cost block anything: a
 * different-cost echo is never a dominator and never matches a (b) def,
 * because each such def appears in set s at I's cost only. C holds at most
 * k echoes of I's cost, I included. So at most k − 1 counted dominators
 * are blocked, and at least topN stay available.
 *
 * Top-N: counted dominators are already kept, so a combo with m dropped
 * echoes reaches a combo of kept echoes in m swaps, and the last swap
 * alone has ≥ topN available choices. Those choices are distinct kept
 * combos, each scoring ≥ the original. So every combo that pruning
 * removes is matched by topN kept combos that score at least as well,
 * and the i-th best score (i ≤ topN) is unchanged.
 *
 * Chains: echoes are decided in descending relevant-stat sum, so a
 * dominator is usually decided before what it dominates. Only kept
 * dominators count, so a pruned dominator is never relied on. Its own
 * dominators also dominate I (dominance is transitive) and count
 * directly. Float ties in the sum only make the rule more conservative.
 */
export function pruneDominated(
  echoes: OwnedEcho[],
  relevantStats: StatKey[],
  options: PruneOptions,
): PruneResult {
  const contributions = new Map(echoes.map((e) => [e.id, contributionsOf(e)] as const));
  const relevantSum = (e: OwnedEcho): number => {
    const map = contributions.get(e.id)!;
    return relevantStats.reduce((sum, stat) => sum + (map.get(stat) ?? 0), 0);
  };
  const poolCosts = echoes.map((e) => e.cost);
  // Costs seen per (set, def): a (b) dominator's def must never appear at another cost.
  const costsBySetDef = new Map<string, Set<number>>();
  for (const echo of echoes) {
    const key = setDefKey(echo.sonataId, echo.echoDefId);
    let costs = costsBySetDef.get(key);
    if (!costs) {
      costs = new Set();
      costsBySetDef.set(key, costs);
    }
    costs.add(echo.cost);
  }
  const defOnlyAtCost = (sonataId: string, echoDefId: string, cost: number): boolean => {
    const costs = costsBySetDef.get(setDefKey(sonataId, echoDefId))!;
    return costs.size === 1 && costs.has(cost);
  };

  const order = echoes
    .map((echo, index) => ({ echo, index, sum: relevantSum(echo) }))
    .sort((x, y) => y.sum - x.sum || x.index - y.index);
  const kept: OwnedEcho[] = [];
  const pruned = new Set<string>();
  for (const { echo: incumbent } of order) {
    const required =
      Math.max(1, maxSameCostInCombo(incumbent.cost, options.costBudget, poolCosts)) + options.topN - 1;
    const carrier = options.isMainCarrier?.(incumbent.echoDefId) ?? false;
    let sameDef = 0;
    const otherDefs = new Set<string>();
    for (const challenger of kept) {
      if (challenger.cost !== incumbent.cost) continue;
      if (challenger.sonataId !== incumbent.sonataId) continue;
      if (
        !dominates(contributions.get(challenger.id)!, contributions.get(incumbent.id)!, relevantStats)
      ) {
        continue;
      }
      if (challenger.echoDefId === incumbent.echoDefId) sameDef += 1;
      else if (!carrier && defOnlyAtCost(challenger.sonataId, challenger.echoDefId, incumbent.cost)) {
        otherDefs.add(challenger.echoDefId);
      }
    }
    if (sameDef + otherDefs.size >= required) pruned.add(incumbent.id);
    else kept.push(incumbent);
  }
  return {
    kept: echoes.filter((e) => !pruned.has(e.id)),
    pruned: echoes.filter((e) => pruned.has(e.id)).map((e) => e.id),
  };
}

function setDefKey(sonataId: string, echoDefId: string): string {
  return `${sonataId}\u0000${echoDefId}`;
}

/** Total per-stat contribution: main + secondary + substats. */
function contributionsOf(echo: OwnedEcho): Map<StatKey, number> {
  const map = new Map<StatKey, number>();
  const add = (stat: StatKey, value: number): void => {
    map.set(stat, (map.get(stat) ?? 0) + value);
  };
  add(echo.mainStat.stat, echo.mainStat.value);
  if (echo.secondMainStat) add(echo.secondMainStat.stat, echo.secondMainStat.value);
  for (const sub of echo.substats) add(sub.stat, sub.value);
  return map;
}

/** True when `a` meets-or-beats `b` on every relevant stat and strictly beats it on one. */
function dominates(a: Map<StatKey, number>, b: Map<StatKey, number>, relevant: StatKey[]): boolean {
  let strict = false;
  for (const stat of relevant) {
    const av = a.get(stat) ?? 0;
    const bv = b.get(stat) ?? 0;
    if (av < bv) return false;
    if (av > bv) strict = true;
  }
  return strict;
}
