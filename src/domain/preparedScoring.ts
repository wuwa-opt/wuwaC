import type { RotationBlockSpec, RotationBuffSpec, StatKey } from '../data/schema.ts';
import { camellyaOutroTwiningSpec } from './camellya.ts';
import { cartethyiaConvictionCritDmg, cartethyiaMotionMultiplier } from './cartethyia.ts';
import { characterResonanceModes, characterSkillMods, isCoordinatedMotion } from './characterMods.ts';
import {
  computeBaseAbilityDamage,
  computeBaseDamage,
  computeCamellyaTwiningDamage,
  computeCritMultiplier,
  computeDefMultiplier,
  computeDmgAmplifyTotal,
  computeDmgReductionTotal,
  computeEchoSkillDamage,
  computeElemReductionTotal,
  computeHsinOutroDamage,
  computeJiyanLanceDamage,
  computeNegativeStatusDamage,
  computeResMultiplier,
  computeSpecialDmgPercent,
  computeTuneBreakDamage,
  computeTuneRuptureDamage,
  computeTuneStrainMultiplier,
  computeXiangliyaoChainRuleDamage,
  isBuffImmuneMotion,
  resolveMotion,
  type DamageContext,
  type DamageResult,
} from './damage.ts';
import { hsinOutroSpec } from './hsin.ts';
import { jiyanOutroLanceSpec } from './jiyan.ts';
import { havocBaneDefReduction } from './negativeStatus.ts';
import { blockStartTimes, buffAppliesAt, type CharacterBases, type ScoreRotationInput } from './rotation.ts';
import { computeAbilityStat, emptySheet, type StatSheet } from './stats.ts';
import { xiangliyaoOutroChainRuleSpec } from './xiangliyao.ts';
import { xuanlingBaneTargetAmplify } from './xuanling.ts';

/**
 * Domain layer: prepared scorers for the optimizer's hot loop.
 *
 * `computeDamage` and `scoreRotationBlocks` re-resolve, on every call, work
 * that never depends on the stat sheet: skill and motion lookups, kit mods,
 * outro special cases, buff windows and the buff-immune key. A prepared
 * scorer does that once and then only evaluates sheets. Each evaluator
 * mirrors its source function term for term and in the same floating-point
 * operation order, so it returns exactly (`===`) what the source returns.
 * `preparedScoring.equivalence.test.ts` is the gate: any change to
 * `computeDamage`, `scoreRotationBlocks` or their kit helpers must be
 * mirrored here.
 *
 * Inputs are read once, at prepare time. Input errors (unknown skill or
 * motion, bad stacks, missing Resonance Mode) never depend on the sheet, so
 * they throw at prepare time, in the order the source functions would
 * throw them.
 */

export type SheetScorer = (sheet: StatSheet) => number;

/** `computeDamage`'s inputs without the sheet. */
export type DamageSetup = Omit<DamageContext, 'sheet'>;

/**
 * Wrap a damage function whose only sheet-dependent input is `sheet`. The
 * context object is built once and reused (the damage functions never keep
 * it). One call on an empty sheet surfaces input errors now.
 */
function withSheet<C extends { sheet: StatSheet }>(
  compute: (ctx: C) => DamageResult,
  setup: Omit<C, 'sheet'>,
): SheetScorer {
  const ctx = { ...setup, sheet: emptySheet() } as C;
  compute(ctx);
  return (sheet) => {
    ctx.sheet = sheet;
    return compute(ctx).damage;
  };
}

/**
 * Prepared `computeDamage(ctx).damage`. Outro special cases delegate to
 * their own damage functions; a kit motion resolves its motion row, kit
 * mods and sheet-free terms once.
 */
export function prepareDamage(setup: DamageSetup): SheetScorer {
  const { skill, enemy, characterId } = setup;
  const chain = setup.resonanceChain ?? 0;
  const outro = { baseAtk: setup.baseAtk, attackerLevel: setup.attackerLevel, enemy, crit: setup.crit, targetHavocBaneStacks: setup.targetHavocBaneStacks };
  const lance = jiyanOutroLanceSpec(characterId, skill, setup.motionName, chain);
  if (lance !== null) return withSheet(computeJiyanLanceDamage, { ...outro, motionValue: lance.motionValue });
  const twining = camellyaOutroTwiningSpec(characterId, skill, setup.motionName, chain);
  if (twining !== null) return withSheet(computeCamellyaTwiningDamage, { ...outro, motionValue: twining.motionValue });
  const chainRule = xiangliyaoOutroChainRuleSpec(characterId, skill, setup.motionName, chain);
  if (chainRule !== null) return withSheet(computeXiangliyaoChainRuleDamage, { ...outro, motionValue: chainRule.motionValue });
  const hsinOutro = hsinOutroSpec(characterId, skill, setup.motionName);
  if (hsinOutro !== null) return withSheet(computeHsinOutroDamage, { ...outro, motionValue: hsinOutro.motionValue });

  const motion = resolveMotion(skill, setup.motionName, setup.forteLevel);
  if (motion.isHealing) return () => 0;
  const { scaling, ratio, dmgType: kind } = motion;
  const bases = {
    atkCharacter: setup.baseAtk.character,
    atkWeapon: setup.baseAtk.weapon,
    hpCharacter: setup.baseHp.character,
    defCharacter: setup.baseDef.character,
  };
  const flatDamage = motion.flat + (setup.flatDamage ?? 0);
  const flatBonusPercent = setup.flatBonusPercent ?? 0;
  const kitMods = characterSkillMods(characterId, chain, skill, motion.name, motion.dmgType, setup.forteLevel, {
    blazesConsumed: setup.blazesConsumed,
    nightfallBlazes: setup.nightfallBlazes,
    ringsConsumed: setup.ringsConsumed,
    voiceFlux: setup.voiceFlux,
    wovenMyriad: setup.wovenMyriad,
    sealMaster: setup.sealMaster,
  });
  const { motionMultiplier, dmgBonusExtra, amplifyExtra, critRateExtra, critDmgExtra, defIgnoreExtra } = kitMods;
  const statusMultiplier = cartethyiaMotionMultiplier(characterId, chain, skill, motion.name, setup.targetStatusStacks ?? 0);
  const attribute = skill.attribute;
  const enemyRes = enemy.baseResistance[attribute];
  const { attackerLevel, crit } = setup;
  const enemyLevel = enemy.level;
  const enemyDefOverride = enemy.enemyDefOverride;
  const enemyDefPctReduction = havocBaneDefReduction(setup.targetHavocBaneStacks ?? 0);
  const dmgReduction = computeDmgReductionTotal(enemy.dmgReductionBase, enemy.dmgReductionAdditional);
  const elemReduction = computeElemReductionTotal(enemy.elemReductionBase, enemy.elemReductionAdditional);
  const buffImmune = isBuffImmuneMotion(characterId, skill.id, motion.name);
  const coordinated = !buffImmune && isCoordinatedMotion(characterId, motion.name);
  // computeDmgBonusPercent's sheet keys, built once.
  const attributeKey: StatKey = `dmgBonus:${attribute}`;
  const bucketKey: StatKey | null = kind === 'forte' ? null : `dmgBonus:${kind}`;
  const baneAmplify = characterId === 'yangyang-xuanling'
    ? xuanlingBaneTargetAmplify(setup.targetHavocBaneStacks ?? 0)
    : 0;
  const amplifyTarget = enemy.amplifyTarget;
  const strainStacks = setup.tuneStrainStacks ?? 0;
  computeTuneStrainMultiplier(0, strainStacks); // validates the stacks now
  const convictionCritDmg = cartethyiaConvictionCritDmg(characterId, chain, skill, setup.conviction ?? 0);

  return (sheet) => {
    const baseDamage =
      computeBaseDamage(
        computeBaseAbilityDamage(computeAbilityStat(scaling, bases, sheet), ratio),
        flatDamage,
        flatBonusPercent,
      ) *
      motionMultiplier *
      statusMultiplier;
    const resistances =
      computeResMultiplier(enemyRes + sheet.resistancePenetration) *
      computeDefMultiplier({
        attackerLevel,
        enemyLevel,
        enemyDefOverride,
        defIgnore: sheet.defIgnore + defIgnoreExtra,
        defReduction: sheet.defReduction,
        enemyDefPctReduction,
      }) *
      dmgReduction *
      elemReduction;
    // computeDmgBonusPercent: 1 + attribute + bucket + extra + coordinated, in that order.
    const dmgBonusTerm = buffImmune
      ? 1
      : 1 +
        sheet[attributeKey] +
        (bucketKey === null ? 0 : sheet[bucketKey]) +
        dmgBonusExtra +
        (coordinated ? sheet['dmgBonus:coordinated'] : 0);
    const bonuses =
      dmgBonusTerm *
      computeDmgAmplifyTotal(sheet.amplify + amplifyExtra + baneAmplify, amplifyTarget) *
      computeTuneStrainMultiplier(sheet.tuneBreakBoost, strainStacks) *
      computeSpecialDmgPercent(sheet.specialBase, sheet.specialBonus) *
      computeCritMultiplier(sheet.critRate + critRateExtra, sheet.critDmg + critDmgExtra + convictionCritDmg, crit);
    return baseDamage * resistances * bonuses;
  };
}

interface StatMod {
  stat: StatKey;
  value: number;
}

/** The mods `applyBuffs` (rotation.ts) adds for these ids, in its order. Unknown ids add nothing. */
export function buffModList(buffsById: ReadonlyMap<string, RotationBuffSpec>, ids: readonly string[]): StatMod[] {
  const mods: StatMod[] = [];
  for (const id of ids) {
    const buff = buffsById.get(id);
    if (buff) mods.push(...buff.mods);
  }
  return mods;
}

/** A sheet copy with the mods added in order (the sheet itself when there are none). */
export function applyStatMods(sheet: StatSheet, mods: readonly StatMod[]): StatSheet {
  if (mods.length === 0) return sheet;
  const out = { ...sheet };
  for (const mod of mods) out[mod.stat] += mod.value;
  return out;
}

/**
 * One block of `scoreRotationBlocks` as a sheet scorer, or null for a
 * buff carrier (always 0 damage, so it adds nothing to the DPR).
 */
function prepareBlock(block: RotationBlockSpec, bases: CharacterBases, input: ScoreRotationInput): SheetScorer | null {
  const { skills, characterId, attribute, resonanceChain = 0, attackerLevel, enemy, crit, resonanceMode } = input;
  if (block.damageKind === 'negativeStatus') {
    if (block.statusType === undefined) {
      throw new Error('negativeStatus block needs a statusType');
    }
    return withSheet(computeNegativeStatusDamage, {
      status: block.statusType,
      stacks: block.statusStacks ?? 1,
      attackerLevel,
      enemy,
      resonanceChain,
      characterId,
      targetStatusStacks: block.targetStatusStacks,
      targetHavocBaneStacks: block.targetHavocBaneStacks,
    });
  }

  if (block.damageKind === 'tuneBreak') {
    const multiplier = block.tuneBreakMultiplier;
    if (multiplier === undefined) {
      throw new Error('tuneBreak block needs an explicit tuneBreakMultiplier — no verified default exists (G3)');
    }
    if (attribute === undefined) {
      throw new Error('tuneBreak block needs the character attribute for its RES term');
    }
    const enemyRes = enemy.baseResistance[attribute];
    const at = (sheet: StatSheet): number =>
      computeTuneBreakDamage({
        multiplier,
        tuneBreakBoost: sheet.tuneBreakBoost,
        attackerLevel,
        enemy,
        enemyRes,
        resistancePenetration: sheet.resistancePenetration,
      }).damage;
    at(emptySheet());
    return at;
  }

  if (block.damageKind === 'echoSkill') {
    if (block.echoMotionValue === undefined || block.echoAttribute === undefined) {
      throw new Error('echoSkill block needs echoMotionValue and echoAttribute');
    }
    return withSheet(computeEchoSkillDamage, {
      baseAtk: bases.baseAtk,
      baseHp: bases.baseHp,
      baseDef: bases.baseDef,
      scaling: block.echoScaling ?? 'ATK',
      motionValue: block.echoMotionValue,
      flatDamage: block.echoFlatDamage ?? 0,
      attribute: block.echoAttribute,
      attackerLevel,
      enemy,
      crit,
      targetHavocBaneStacks: block.targetHavocBaneStacks,
      tuneStrainStacks: block.tuneStrainStacks,
    });
  }

  const skill = skills.find((s) => s.id === block.skillId);
  if (!skill) throw new Error(`unknown skill: ${JSON.stringify(block.skillId)}`);
  if (block.damageKind === 'tuneRupture') {
    return withSheet(computeTuneRuptureDamage, {
      baseAtk: bases.baseAtk,
      baseHp: bases.baseHp,
      baseDef: bases.baseDef,
      attackerLevel,
      skill,
      motionName: block.motionName,
      forteLevel: block.forteLevel,
      enemy,
      characterId,
      resonanceChain,
      tuneResponseStacks: block.tuneResponseStacks,
      resonanceMode,
    });
  }
  // Same buff-carrier test as scoreRotationBlocks (outro specs at their
  // default chain rank: only whether one exists matters here).
  if (
    skill.motionValues.length === 0 &&
    jiyanOutroLanceSpec(characterId, skill, block.motionName) === null &&
    camellyaOutroTwiningSpec(characterId, skill, block.motionName) === null &&
    xiangliyaoOutroChainRuleSpec(characterId, skill, block.motionName) === null &&
    hsinOutroSpec(characterId, skill, block.motionName) === null
  ) {
    return null;
  }
  return prepareDamage({
    baseAtk: bases.baseAtk,
    baseHp: bases.baseHp,
    baseDef: bases.baseDef,
    attackerLevel,
    skill,
    motionName: block.motionName,
    forteLevel: block.forteLevel,
    enemy,
    crit,
    characterId,
    resonanceChain,
    targetStatusStacks: block.targetStatusStacks,
    targetHavocBaneStacks: block.targetHavocBaneStacks,
    conviction: block.conviction,
    blazesConsumed: block.blazesConsumed,
    nightfallBlazes: block.nightfallBlazes,
    ringsConsumed: block.ringsConsumed,
    voiceFlux: block.voiceFlux,
    wovenMyriad: block.wovenMyriad,
    sealMaster: block.sealMaster,
    tuneStrainStacks: block.tuneStrainStacks,
  });
}

/**
 * Prepared `scoreRotationBlocks(sheet, bases, input).dpr`.
 *
 * Buff sets are resolved once per block. Blocks with the same buff ids
 * share one buffed sheet per call; each buffed sheet adds the same mods in
 * the same order as `applyBuffs`, so every stat is the same sum. Buff
 * carriers and healing motions add 0, which never changes the running sum
 * (it starts at +0 and so is never −0), so they are skipped.
 */
export function prepareRotationDpr(bases: CharacterBases, input: ScoreRotationInput): SheetScorer {
  const { characterId, blocks, buffs, globalBuffIds, resonanceMode } = input;
  const modes = characterId !== undefined ? characterResonanceModes(characterId) : [];
  if (modes.length > 0 && (resonanceMode === undefined || !modes.includes(resonanceMode))) {
    throw new Error(
      `${characterId} has Resonance Modes (${modes.join(' / ')}) — select one before scoring`,
    );
  }
  const buffsById = new Map(buffs.map((b) => [b.id, b]));
  const globalMods = buffModList(buffsById, globalBuffIds);
  const starts = blockStartTimes(blocks);

  const variantByKey = new Map<string, number>();
  const variantMods: StatMod[][] = [];
  const terms: { variant: number; score: SheetScorer }[] = [];
  blocks.forEach((block, index) => {
    if (!Number.isInteger(block.forteLevel) || block.forteLevel < 1) {
      throw new Error(`forte level must be a whole number of 1 or more, got ${block.forteLevel}`);
    }
    const manual = new Set([...globalBuffIds, ...block.activeBuffIds]);
    const windowedIds = buffs
      .filter((buff) => !manual.has(buff.id) && buffAppliesAt(buff, starts[index]))
      .map((buff) => buff.id);
    const ids = [...block.activeBuffIds, ...windowedIds].filter((id) => buffsById.has(id));
    const score = prepareBlock(block, bases, input);
    if (score === null) return;
    const key = JSON.stringify(ids);
    let variant = variantByKey.get(key);
    if (variant === undefined) {
      variant = variantMods.length;
      variantByKey.set(key, variant);
      variantMods.push(buffModList(buffsById, ids));
    }
    terms.push({ variant, score });
  });

  const sheets: StatSheet[] = new Array<StatSheet>(variantMods.length);
  return (sheet) => {
    const globalSheet = applyStatMods(sheet, globalMods);
    for (let v = 0; v < variantMods.length; v += 1) sheets[v] = applyStatMods(globalSheet, variantMods[v]);
    let dpr = 0;
    for (const term of terms) dpr += term.score(sheets[term.variant]);
    return dpr;
  };
}
