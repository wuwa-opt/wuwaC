import { describe, expect, it } from 'vitest';
import { loadBundledSnapshot } from '../data/index.ts';
import {
  attributeSchema,
  statKeySchema,
  type CharacterData,
  type ObjectiveSpec,
  type RotationBlockSpec,
  type RotationBuffSpec,
  type StatKey,
} from '../data/schema.ts';
import { TEAM_BUFFS } from '../data/teamBuffs.ts';
import {
  characterResonanceModes,
  characterStatusBlocks,
  RESONANCE_MODES,
  tuneResponseStackRate,
  type ResonanceMode,
} from './characterMods.ts';
import { elementalBoss, standardMob, type CritMode, type EnemyProfile } from './damage.ts';
import { NEGATIVE_STATUSES } from './negativeStatus.ts';
import { prepareObjective, scoreSheet, type ScoreContext } from './objectives.ts';
import { emptySheet, type StatSheet } from './stats.ts';

/**
 * Gate for the prepared scorers: `prepareObjective(spec, ctx)(sheet)` must
 * return exactly (`Object.is`: same bits, −0 kept apart, NaN equal) what
 * `scoreSheet(spec, sheet, ctx)` returns, and throw the same error when it
 * throws. Seeded random sheets, enemies and kit state over every snapshot
 * character and every one of its motions, plus random rotations with team,
 * windowed, duplicate and unknown buffs, every block kind and Resonance
 * Modes (valid, missing and wrong).
 */

const snapshot = loadBundledSnapshot();
const STAT_KEYS = statKeySchema.options;
const ATTRIBUTES = attributeSchema.options;
const CRITS: CritMode[] = ['expected', 'crit', 'nonCrit'];
/** Characters with a kit module (src/domain/<id>.ts) get more draws. */
const KIT_IDS = new Set(['aemeath', 'camellya', 'cartethyia', 'chisa', 'galbrena', 'hsin', 'jiyan', 'lynae', 'suoming', 'xiangli-yao', 'yangyang-xuanling', 'zani']);

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rand = () => number;
const int = (rand: Rand, lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));
const pick = <T,>(rand: Rand, list: readonly T[]): T => list[Math.floor(rand() * list.length)];
const maybe = <T,>(rand: Rand, value: () => T, p = 0.5): T | undefined => (rand() < p ? value() : undefined);

/** Sheets from realistic (crit 5%/150% base, big flat ATK) to odd (negative, zero, > 100% crit). */
function randomSheet(rand: Rand): StatSheet {
  const sheet = emptySheet();
  const shape = rand();
  for (const key of STAT_KEYS) {
    if (shape < 0.1) sheet[key] = 0;
    else if (shape < 0.2) sheet[key] = (rand() - 0.5) * 2;
    else if (rand() < 0.8) sheet[key] = rand() * 0.8;
  }
  if (shape >= 0.1) {
    sheet.critRate += 0.05 + rand() * 0.9;
    sheet.critDmg += 1.5 + rand() * 1.5;
    sheet.atk += rand() * 400;
    sheet.hp += rand() * 3000;
    sheet.def += rand() * 200;
    sheet.tuneBreakBoost += rand() * 60;
  }
  return sheet;
}

function randomEnemy(rand: Rand): EnemyProfile {
  const level = int(rand, 1, 120);
  const enemy = rand() < 0.5 ? standardMob(level) : elementalBoss(level, pick(rand, ATTRIBUTES));
  if (rand() < 0.3) {
    for (const a of ATTRIBUTES) enemy.baseResistance[a] = (rand() - 0.3) * 1.5;
  }
  if (rand() < 0.2) enemy.enemyDefOverride = rand() * 3000;
  if (rand() < 0.3) {
    enemy.dmgReductionBase = rand() * 0.2;
    enemy.dmgReductionAdditional = rand() * 0.1;
    enemy.elemReductionBase = rand() * 0.2;
    enemy.elemReductionAdditional = rand() * 0.1;
    enemy.amplifyTarget = (rand() - 0.5) * 0.4;
  }
  return enemy;
}

/** `valid`: only inputs the scorers accept, so nearly every draw scores a number. */
function randomContext(rand: Rand, character: CharacterData, valid = false): ScoreContext {
  const modes = characterResonanceModes(character.id);
  return {
    skills: character.skills,
    characterId: character.id,
    attribute: character.attribute,
    resonanceChain: int(rand, 0, 6),
    baseAtk: { character: 100 + rand() * 400, weapon: 100 + rand() * 500 },
    baseHp: { character: 5000 + rand() * 10000 },
    baseDef: { character: 500 + rand() * 1000 },
    attackerLevel: int(rand, 1, 90),
    enemy: randomEnemy(rand),
    resonanceMode: (valid || rand() < 0.85) && modes.length > 0 ? pick(rand, modes) : maybe(rand, () => pick(rand, Object.values(RESONANCE_MODES).flat() as ResonanceMode[]), 0.3),
    targetStatusStacks: maybe(rand, () => int(rand, 0, 9)),
    conviction: maybe(rand, () => int(rand, 0, 120)),
    targetHavocBaneStacks: maybe(rand, () => (!valid && rand() < 0.03 ? 7 : int(rand, 0, 6))),
    blazesConsumed: maybe(rand, () => int(rand, 0, 150)),
    nightfallBlazes: maybe(rand, () => int(rand, 0, 40)),
    ringsConsumed: maybe(rand, () => int(rand, 0, 100)),
    voiceFlux: maybe(rand, () => rand() < 0.5),
    wovenMyriad: maybe(rand, () => rand() < 0.5),
    sealMaster: maybe(rand, () => rand() < 0.5),
    // Now and then invalid (unvalidated kit state): errors must match too.
    tuneStrainStacks: maybe(rand, () => (!valid && rand() < 0.05 ? pick(rand, [-1, 1.5]) : int(rand, 0, 4)), 0.3),
  };
}

type Outcome = { value: number } | { error: string };

function outcome(run: () => number): Outcome {
  try {
    return { value: run() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Compare both paths over several sheets; returns how many sheets scored a number. */
function expectSame(spec: ObjectiveSpec, ctx: ScoreContext, rand: Rand, sheets = 4): number {
  const prepared = prepareObjective(spec, ctx);
  let scored = 0;
  for (let i = 0; i < sheets; i += 1) {
    const sheet = randomSheet(rand);
    const want = outcome(() => scoreSheet(spec, sheet, ctx));
    const got = outcome(() => prepared(sheet));
    if ('value' in want && 'value' in got) {
      if (!Object.is(want.value, got.value)) {
        expect.fail(`${JSON.stringify(spec).slice(0, 300)}: scoreSheet ${want.value} vs prepared ${got.value}`);
      }
      scored += 1;
    } else {
      expect(got).toEqual(want);
    }
  }
  return scored;
}

/** Every (skill, motion) of a character, plus the '' motion of motionless skills (outro specials, buff carriers). */
function motionsOf(character: CharacterData): { skillId: string; motionName: string }[] {
  return character.skills.flatMap((skill) =>
    skill.motionValues.length === 0
      ? [{ skillId: skill.id, motionName: '' }]
      : skill.motionValues.map((m) => ({ skillId: skill.id, motionName: m.name })),
  );
}

const HOT_STATS = (character: CharacterData): StatKey[] => [
  'atkPct',
  'atk',
  'amplify',
  'critRate',
  'critDmg',
  'defIgnore',
  'resistancePenetration',
  `dmgBonus:${character.attribute}`,
  'dmgBonus:basic',
  'dmgBonus:heavy',
  'dmgBonus:skill',
  'dmgBonus:liberation',
];

function randomBuffs(rand: Rand, character: CharacterData): RotationBuffSpec[] {
  const count = int(rand, 0, 6);
  const buffs: RotationBuffSpec[] = [];
  for (let i = 0; i < count; i += 1) {
    const team = rand() < 0.5 ? pick(rand, TEAM_BUFFS) : null;
    const mods = team
      ? team.mods
      : Array.from({ length: int(rand, 0, 3) }, () => ({
          // Mostly stats the damage terms read, so buffs collide on a stat
          // and the order of additions matters.
          stat: rand() < 0.2 ? pick(rand, STAT_KEYS) : pick(rand, HOT_STATS(character)),
          value: (rand() - 0.2) * 0.5,
        }));
    const buff: RotationBuffSpec = {
      // Duplicate ids on purpose now and then: the later buff wins the map.
      id: rand() < 0.1 && i > 0 ? buffs[0].id : `b${i}`,
      label: team?.label ?? `Buff ${i}`,
      source: 'test',
      mods,
    };
    if (rand() < 0.5) {
      buff.windowDurationSeconds = rand() < 0.1 ? 0 : rand() * 12;
      if (rand() < 0.7) buff.windowStartSeconds = rand() * 10;
    }
    buffs.push(buff);
  }
  return buffs;
}

function randomIds(rand: Rand, buffs: RotationBuffSpec[]): string[] {
  const ids: string[] = [];
  const count = int(rand, 0, 3);
  for (let i = 0; i < count; i += 1) {
    ids.push(rand() < 0.15 || buffs.length === 0 ? 'unknown-buff' : pick(rand, buffs).id);
  }
  return ids;
}

/** `valid`: only blocks this character and mode can score (no error paths). */
function randomBlock(
  rand: Rand,
  character: CharacterData,
  buffs: RotationBuffSpec[],
  valid: boolean,
  mode: ResonanceMode | undefined,
): RotationBlockSpec {
  const motion = pick(rand, motionsOf(character));
  const own = characterStatusBlocks(character.id);
  const block: RotationBlockSpec = {
    skillId: motion.skillId,
    motionName: motion.motionName,
    forteLevel: !valid && rand() < 0.02 ? 0 : int(rand, 1, 10),
    activeBuffIds: randomIds(rand, buffs),
  };
  if (rand() < 0.6) block.durationSeconds = rand() * 3;
  const kind = rand();
  if (kind < 0.07 && (!valid || own.length > 0)) {
    block.damageKind = 'negativeStatus';
    block.statusType = valid
      ? pick(rand, own)
      : rand() < 0.1 ? undefined : own.length > 0 && rand() < 0.7 ? pick(rand, own) : pick(rand, NEGATIVE_STATUSES);
    block.statusStacks = maybe(rand, () => int(rand, 1, valid ? 3 : 10));
  } else if (kind >= 0.07 && kind < 0.12) {
    block.damageKind = 'tuneBreak';
    block.tuneBreakMultiplier = maybe(rand, () => rand() * 3, valid ? 1 : 0.9);
  } else if (kind >= 0.07 && kind < 0.2) {
    block.damageKind = 'echoSkill';
    block.echoMotionValue = maybe(rand, () => rand() * 4, valid ? 1 : 0.95);
    block.echoAttribute = maybe(rand, () => pick(rand, ATTRIBUTES), valid ? 1 : 0.95);
    block.echoScaling = maybe(rand, () => pick(rand, ['ATK', 'HP', 'DEF'] as const));
    block.echoFlatDamage = maybe(rand, () => rand() * 500);
    block.echoCooldown = maybe(rand, () => rand() * 20);
  } else if (kind >= 0.07 && kind < 0.27 && (!valid || (tuneResponseStackRate(character.id) !== null && mode === 'tuneRupture'))) {
    block.damageKind = 'tuneRupture';
    block.tuneResponseStacks = maybe(rand, () => int(rand, 0, 30));
  } else if (kind >= 0.27 && kind < 0.3) {
    block.damageKind = 'ability';
  } else if (!valid && kind >= 0.3 && kind < 0.31) {
    block.skillId = 'no-such-skill';
  }
  block.targetStatusStacks = maybe(rand, () => int(rand, 0, 9), 0.3);
  block.targetHavocBaneStacks = maybe(rand, () => int(rand, 0, 6), 0.3);
  block.conviction = maybe(rand, () => int(rand, 0, 120), 0.3);
  block.blazesConsumed = maybe(rand, () => int(rand, 0, 150), 0.3);
  block.nightfallBlazes = maybe(rand, () => int(rand, 0, 40), 0.3);
  block.ringsConsumed = maybe(rand, () => int(rand, 0, 100), 0.3);
  block.voiceFlux = maybe(rand, () => rand() < 0.5, 0.3);
  block.wovenMyriad = maybe(rand, () => rand() < 0.5, 0.3);
  block.sealMaster = maybe(rand, () => rand() < 0.5, 0.3);
  block.tuneStrainStacks = maybe(rand, () => (!valid && rand() < 0.05 ? -1 : int(rand, 0, 4)), 0.2);
  return block;
}

describe('prepareObjective matches scoreSheet exactly', () => {
  it('max-stat, every stat key', () => {
    const rand = rng(1);
    const ctx = randomContext(rand, snapshot.characters[0]);
    for (const stat of STAT_KEYS) expectSame({ kind: 'max-stat', stat }, ctx, rand, 3);
  });

  it('expected-damage, every character and motion, random kit state and enemies', () => {
    const rand = rng(2);
    let scored = 0;
    let total = 0;
    for (const character of snapshot.characters) {
      for (const motion of motionsOf(character)) {
        for (let trial = 0; trial < (KIT_IDS.has(character.id) ? 12 : 2); trial += 1) {
          const ctx = randomContext(rand, character);
          const skill = character.skills.find((s) => s.id === motion.skillId)!;
          ctx.skill = rand() < 0.03 ? character.skills[0] : skill;
          const spec: ObjectiveSpec = {
            kind: 'expected-damage',
            skillId: skill.id,
            motionName: motion.motionName === '' ? 'x' : motion.motionName,
            forteLevel: int(rand, 1, 10),
            crit: pick(rand, CRITS),
          };
          scored += expectSame(spec, ctx, rand, 3);
          total += 3;
        }
      }
    }
    // Most draws must score (the comparison is not all error-vs-error).
    expect(scored).toBeGreaterThan(total * 0.8);
  });

  it('jiyan, camellya, xiangli yao and hsin outro specials at every chain rank', () => {
    const rand = rng(3);
    for (const id of ['jiyan', 'camellya', 'xiangli-yao', 'hsin']) {
      const character = snapshot.characters.find((c) => c.id === id)!;
      const outro = character.skills.find((s) => s.kind === 'outro')!;
      for (let chain = 0; chain <= 6; chain += 1) {
        const ctx = { ...randomContext(rand, character), resonanceChain: chain, skill: outro };
        const block: RotationBlockSpec = { skillId: outro.id, motionName: '', forteLevel: 10, activeBuffIds: [] };
        const spec: ObjectiveSpec = { kind: 'rotation-dpr', blocks: [block, block], buffs: [], globalBuffIds: [], crit: pick(rand, CRITS) };
        expect(expectSame(spec, ctx, rand, 3)).toBe(3);
      }
    }
  });

  it.each([
    { valid: true, seed: 4, minScored: 0.97 },
    { valid: false, seed: 7, minScored: 0.15 },
  ])('rotation-dpr, every character: blocks of every kind, team, windowed and unknown buffs, Resonance Modes (valid only: $valid)', ({ valid, seed, minScored }) => {
    const rand = rng(seed);
    let scored = 0;
    let total = 0;
    for (const character of snapshot.characters) {
      const trials = KIT_IDS.has(character.id) ? 24 : 8;
      for (let trial = 0; trial < trials; trial += 1) {
        const ctx = randomContext(rand, character, valid);
        const buffs = randomBuffs(rand, character);
        const blocks = Array.from({ length: int(rand, 0, 14) }, () =>
          randomBlock(rand, character, buffs, valid, ctx.resonanceMode));
        const spec: ObjectiveSpec = {
          kind: 'rotation-dpr',
          blocks,
          buffs,
          globalBuffIds: randomIds(rand, buffs),
          crit: pick(rand, CRITS),
        };
        scored += expectSame(spec, ctx, rand, 3);
        total += 3;
      }
    }
    expect(scored).toBeGreaterThanOrEqual(total * minScored);
  });

  it('rotation-dpr with only kit motions and real team buffs scores (no error paths)', () => {
    const rand = rng(5);
    for (const character of snapshot.characters) {
      const modes = characterResonanceModes(character.id);
      const ctx = { ...randomContext(rand, character), resonanceMode: modes[0], targetHavocBaneStacks: undefined, tuneStrainStacks: undefined };
      const buffs = TEAM_BUFFS.slice(0, 8).map((b, i): RotationBuffSpec => ({
        id: `team-${i}`,
        label: b.label,
        source: b.characterId,
        mods: b.mods,
        ...(b.windowSeconds === undefined ? {} : { windowStartSeconds: i, windowDurationSeconds: b.windowSeconds }),
      }));
      const blocks = motionsOf(character).map((m, i): RotationBlockSpec => ({
        skillId: m.skillId,
        motionName: m.motionName,
        forteLevel: 10,
        activeBuffIds: i % 3 === 0 ? ['team-0'] : [],
        durationSeconds: 0.5,
      }));
      const spec: ObjectiveSpec = { kind: 'rotation-dpr', blocks, buffs, globalBuffIds: ['team-1'], crit: 'expected' };
      expect(expectSame(spec, ctx, rand, 3)).toBe(3);
    }
  });

  it('defers errors to the first call, like scoreSheet', () => {
    const character = snapshot.characters.find((c) => c.id === 'aemeath')!;
    const ctx = randomContext(rng(6), character);
    ctx.resonanceMode = undefined;
    const spec: ObjectiveSpec = { kind: 'rotation-dpr', blocks: [], buffs: [], globalBuffIds: [], crit: 'expected' };
    const prepared = prepareObjective(spec, ctx);
    expect(() => prepared(emptySheet())).toThrow(/has Resonance Modes/);
    expect(() => prepareObjective({ kind: 'expected-damage', skillId: 'nope', motionName: 'x', forteLevel: 1, crit: 'crit' }, ctx)).not.toThrow();
  });
});
