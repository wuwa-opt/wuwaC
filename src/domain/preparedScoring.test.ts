import { describe, expect, it } from 'vitest';
import type { CharacterSkill, RotationBuffSpec } from '../data/schema.ts';
import { standardMob } from './damage.ts';
import { prepareObjective } from './objectives.ts';
import { applyStatMods, buffModList, prepareDamage, prepareRotationDpr } from './preparedScoring.ts';
import { emptySheet, type StatSheet } from './stats.ts';

// Hand-computed values. Toy kit: ATK 1000 (no weapon base), standard Lv90
// mob (10% RES -> 0.9) at attacker Lv90: DEF multiplier 1520 / 3032.
const bases = {
  baseAtk: { character: 1000, weapon: 0 },
  baseHp: { character: 10000 },
  baseDef: { character: 1000 },
};
const DEF = 1520 / 3032;

const hit: CharacterSkill = {
  id: 'toy',
  kind: 'skill',
  label: 'Toy (Resonance Skill)',
  attribute: 'Fusion',
  scaling: 'ATK',
  motionValues: [
    { name: 'Hit', values: [0.5, 0.6], hits: 1, dmgType: 'skill', scaling: 'ATK', isHealing: false },
    { name: 'Healing', values: [1], hits: 1, dmgType: 'skill', scaling: 'ATK', isHealing: true },
  ],
};
const carrier: CharacterSkill = {
  id: 'carrier',
  kind: 'liberation',
  label: 'Buff only',
  attribute: 'Fusion',
  scaling: 'ATK',
  motionValues: [],
};

/** Fusion +20%, Skill +30% (DmgBonusPercent 1.5), Crit DMG 200%. */
function sheetWith(atkPct = 0): StatSheet {
  const sheet = emptySheet();
  sheet['dmgBonus:Fusion'] = 0.2;
  sheet['dmgBonus:skill'] = 0.3;
  sheet.critDmg = 2;
  sheet.atkPct = atkPct;
  return sheet;
}

describe('prepareDamage', () => {
  const score = prepareDamage({
    ...bases,
    attackerLevel: 90,
    skill: hit,
    motionName: 'Hit',
    forteLevel: 2,
    enemy: standardMob(90),
    crit: 'crit',
  });

  it('scores each sheet it is given (hand-computed)', () => {
    // 1000 ATK x 0.6 (forte 2) = 600; x 0.9 x DEF x 1.5 x 2 (crit).
    expect(score(sheetWith())).toBeCloseTo(600 * 0.9 * DEF * 1.5 * 2, 9);
    // +50% ATK: 1500 x 0.6 = 900.
    expect(score(sheetWith(0.5))).toBeCloseTo(900 * 0.9 * DEF * 1.5 * 2, 9);
  });

  it('scores healing motions as 0', () => {
    const healing = prepareDamage({ ...bases, attackerLevel: 90, skill: hit, motionName: 'Healing', forteLevel: 1, enemy: standardMob(90), crit: 'crit' });
    expect(healing(sheetWith())).toBe(0);
  });

  it('throws at prepare time for a missing motion', () => {
    expect(() =>
      prepareDamage({ ...bases, attackerLevel: 90, skill: hit, motionName: 'Nope', forteLevel: 1, enemy: standardMob(90), crit: 'crit' }),
    ).toThrow(/no motion component "Nope"/);
  });
});

describe('buffModList', () => {
  it('lists known buffs\' mods in id order, repeats included, unknown ids skipped', () => {
    const byId = new Map<string, RotationBuffSpec>([
      ['a', { id: 'a', label: 'A', source: 't', mods: [{ stat: 'atkPct', value: 0.1 }, { stat: 'critRate', value: 0.05 }] }],
      ['b', { id: 'b', label: 'B', source: 't', mods: [{ stat: 'amplify', value: 0.2 }] }],
    ]);
    expect(buffModList(byId, ['b', 'nope', 'a', 'b'])).toEqual([
      { stat: 'amplify', value: 0.2 },
      { stat: 'atkPct', value: 0.1 },
      { stat: 'critRate', value: 0.05 },
      { stat: 'amplify', value: 0.2 },
    ]);
  });
});

describe('applyStatMods', () => {
  it('adds mods in order onto a copy', () => {
    const base = sheetWith(0.1);
    const out = applyStatMods(base, [{ stat: 'atkPct', value: 0.2 }, { stat: 'amplify', value: 0.25 }, { stat: 'atkPct', value: 0.05 }]);
    expect(out.atkPct).toBeCloseTo(0.35, 12);
    expect(out.amplify).toBe(0.25);
    expect(base.atkPct).toBe(0.1);
  });

  it('returns the sheet itself when there are no mods', () => {
    const base = sheetWith();
    expect(applyStatMods(base, [])).toBe(base);
  });
});

describe('prepareRotationDpr', () => {
  it('sums blocks with global, toggled and windowed buffs; carriers and healing add 0 (hand-computed)', () => {
    const buffs: RotationBuffSpec[] = [
      { id: 'g', label: 'Global', source: 't', mods: [{ stat: 'atkPct', value: 0.1 }] },
      { id: 'amp', label: 'Toggle', source: 't', mods: [{ stat: 'amplify', value: 0.25 }] },
      // Covers [1, 2): only block 1 (blocks last 1 s each).
      { id: 'win', label: 'Window', source: 't', mods: [{ stat: 'dmgBonus:skill', value: 0.2 }], windowStartSeconds: 1, windowDurationSeconds: 1 },
    ];
    const block = (skillId: string, motionName: string, activeBuffIds: string[] = []) =>
      ({ skillId, motionName, forteLevel: 2, activeBuffIds, durationSeconds: 1 });
    const score = prepareRotationDpr(bases, {
      skills: [hit, carrier],
      attackerLevel: 90,
      enemy: standardMob(90),
      blocks: [block('toy', 'Hit'), block('toy', 'Hit', ['amp']), block('carrier', ''), block('toy', 'Healing')],
      buffs,
      globalBuffIds: ['g', 'unknown'],
      crit: 'crit',
    });
    // ATK 1100 (global +10%) -> 660 base for both hits.
    // Block 0: x 0.9 x DEF x 1.5 x 2 = 660 x 2.7 x DEF.
    // Block 1: DmgBonus 1.7 (window), Amplify 1.25 (toggle): 660 x 0.9 x 1.7 x 1.25 x 2 = 660 x 3.825 x DEF.
    expect(score(sheetWith())).toBeCloseTo((660 * 2.7 + 660 * 3.825) * DEF, 8);
  });

  it('throws at prepare time when a dual-mode character has no Resonance Mode', () => {
    expect(() =>
      prepareRotationDpr(bases, { skills: [hit], characterId: 'aemeath', attackerLevel: 90, enemy: standardMob(90), blocks: [], buffs: [], globalBuffIds: [], crit: 'crit' }),
    ).toThrow(/has Resonance Modes/);
  });
});

describe('prepareObjective', () => {
  const ctx = { ...bases, skill: hit, skills: [hit, carrier], attackerLevel: 90, enemy: standardMob(90) };

  it('reads the stat for max-stat', () => {
    const sheet = sheetWith();
    sheet.critRate = 0.62;
    expect(prepareObjective({ kind: 'max-stat', stat: 'critRate' }, ctx)(sheet)).toBe(0.62);
  });

  it('scores expected-damage and rotation-dpr (hand-computed)', () => {
    const expected = prepareObjective({ kind: 'expected-damage', skillId: 'toy', motionName: 'Hit', forteLevel: 1, crit: 'crit' }, ctx);
    // 1000 x 0.5 = 500 base.
    expect(expected(sheetWith())).toBeCloseTo(500 * 0.9 * DEF * 1.5 * 2, 9);
    const rotation = prepareObjective(
      { kind: 'rotation-dpr', blocks: [{ skillId: 'toy', motionName: 'Hit', forteLevel: 1, activeBuffIds: [] }], buffs: [], globalBuffIds: [], crit: 'nonCrit' },
      ctx,
    );
    expect(rotation(sheetWith())).toBeCloseTo(500 * 0.9 * DEF * 1.5, 9);
  });

  it('throws on the first call, not when prepared', () => {
    const bad = prepareObjective({ kind: 'expected-damage', skillId: 'other', motionName: 'Hit', forteLevel: 1, crit: 'crit' }, ctx);
    expect(() => bad(sheetWith())).toThrow(/objective\/skill mismatch/);
  });
});
