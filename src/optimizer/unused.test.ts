import { describe, expect, it } from 'vitest';
import { loadBundledSnapshot } from '../data/index.ts';
import type { Build, ObjectiveSpec, OwnedEcho, SharedBuild, StatKey } from '../data/schema.ts';
import { hasMainEchoBonus } from '../domain/stats.ts';
import { isReferenceBuild } from '../state/share.ts';
import { pruneInputs, relevantStatsForObjective } from './prune.ts';
import { findUnusedEchoes, type EchoUsage } from './unused.ts';

const snapshot = loadBundledSnapshot();
const characters = snapshot.characters;
const jiyan = characters.find((c) => c.id === 'jiyan')!;

function mkEcho(
  id: string,
  cost: 1 | 3 | 4,
  stats: Partial<Record<StatKey, number>>,
  extra: Partial<OwnedEcho> = {},
): OwnedEcho {
  return {
    id,
    label: id,
    echoDefId: `${id}-def`,
    sonataId: 'sierra-gale',
    cost,
    level: 25,
    rarity: 5,
    mainStat: { stat: 'atk', value: 0 },
    substats: Object.entries(stats).map(([stat, value]) => ({ stat: stat as StatKey, value: value as number })),
    equippedTo: null,
    origin: 'manual',
    ...extra,
  };
}

/** Zero-stat 1-costs: tie with each other (never dominated) and make the pool's cheapest cost 1. */
const fillers = (n: number): OwnedEcho[] => Array.from({ length: n }, (_, i) => mkEcho(`f${i}`, 1, {}));
const fillerIds = (n: number): string[] => fillers(n).map((e) => e.id);

const maxStat = (stat: StatKey): ObjectiveSpec => ({ kind: 'max-stat', stat });

function mkBuild(id: string, echoIds: string[], objective?: ObjectiveSpec, extra: Partial<Build> = {}): Build {
  return {
    id,
    name: id,
    characterId: 'jiyan',
    weaponId: 'verdant-summit',
    echoIds: echoIds as Build['echoIds'],
    objectiveId: objective?.kind ?? 'manual',
    ...(objective === undefined ? {} : { objective }),
    updatedAt: '2026-10-21T00:00:00.000Z',
    ...extra,
  };
}

const statusOf = (verdicts: Map<string, EchoUsage>): Record<string, string> =>
  Object.fromEntries([...verdicts].map(([id, v]) => [id, v.status]));

describe('findUnusedEchoes', () => {
  // 4-costs at budget 12: k = 2 (8 + 3·1 = 11 ≤ 12), so a 4-cost needs 2 counted dominators.
  const strong1 = mkEcho('strong1', 4, { atk: 100 });
  const strong2 = mkEcho('strong2', 4, { atk: 90 });
  const weak = mkEcho('weak', 4, { atk: 10, critRate: 0.1 });
  const pool = [strong1, strong2, weak, ...fillers(4)];
  const atkBuild = mkBuild('atk', ['strong1', ...fillerIds(4)], maxStat('atk'));

  it('a high-Energy-Regen Echo is fodder without a minimum, and kept by a build that needs the regen', () => {
    // Same pool as above, but `weak` also carries Energy Regen the strong ones lack.
    const regen = mkEcho('regen', 4, { atk: 10, energyRegen: 0.2 });
    const echoes = [strong1, strong2, regen, ...fillers(4)];
    const members = ['strong1', ...fillerIds(4)];
    const free = findUnusedEchoes({ echoes, builds: [mkBuild('atk', members, maxStat('atk'))], characters });
    expect(statusOf(free).regen).toBe('fodder');

    const bound = findUnusedEchoes({
      echoes,
      builds: [mkBuild('atk', members, maxStat('atk'), { minStats: { energyRegen: 0.2 } })],
      characters,
    });
    expect(bound.get('regen')).toMatchObject({ status: 'unused', reason: 'kept', keptBy: 'atk' });
    // Energy Regen is now relevant, but nothing else changes for the Echoes that carry none.
    expect(statusOf(bound).strong2).toBe('unused');
  });

  it('only the build that has the minimum keeps the Echo; another build without it would drop it', () => {
    const regen = mkEcho('regen', 4, { atk: 10, energyRegen: 0.2 });
    const echoes = [strong1, strong2, regen, ...fillers(4)];
    const members = ['strong1', ...fillerIds(4)];
    const plain = mkBuild('plain', members, maxStat('atk'));
    const needsRegen = mkBuild('needs', members, maxStat('atk'), { minStats: { energyRegen: 0.2 } });
    expect(statusOf(findUnusedEchoes({ echoes, builds: [plain], characters })).regen).toBe('fodder');
    expect(findUnusedEchoes({ echoes, builds: [plain, needsRegen], characters }).get('regen')).toMatchObject({ reason: 'kept', keptBy: 'needs' });
  });

  it('a zero or empty saved minimum changes nothing', () => {
    const regen = mkEcho('regen', 4, { atk: 10, energyRegen: 0.2 });
    const echoes = [strong1, strong2, regen, ...fillers(4)];
    const members = ['strong1', ...fillerIds(4)];
    for (const minStats of [{}, { energyRegen: 0 }]) {
      const verdicts = findUnusedEchoes({ echoes, builds: [mkBuild('atk', members, maxStat('atk'), { minStats })], characters });
      expect(statusOf(verdicts).regen).toBe('fodder');
    }
  });

  it('marks build members and equipped Echoes in-use, dominated unused Echoes fodder', () => {
    const equippedWeak = mkEcho('equippedWeak', 4, { atk: 5 }, { equippedTo: 'jiyan' });
    const verdicts = findUnusedEchoes({ echoes: [...pool, equippedWeak], builds: [atkBuild], characters });
    // max-stat atk: relevant = {atk}. weak (10) has dominators strong1 (100) and strong2 (90):
    // 2 ≥ k + topN − 1 = 2 → dropped. strong2 has only strong1 → kept.
    expect(statusOf(verdicts)).toEqual({
      strong1: 'in-use',
      strong2: 'unused',
      weak: 'fodder',
      f0: 'in-use',
      f1: 'in-use',
      f2: 'in-use',
      f3: 'in-use',
      equippedWeak: 'in-use',
    });
    expect(verdicts.get('strong1')).toEqual({ status: 'in-use', reason: 'in-build', buildsChecked: 0 });
    expect(verdicts.get('equippedWeak')).toEqual({ status: 'in-use', reason: 'equipped', buildsChecked: 0 });
    expect(verdicts.get('strong2')).toEqual({ status: 'unused', reason: 'kept', buildsChecked: 1, keptBy: 'atk' });
    expect(verdicts.get('weak')).toEqual({ status: 'fodder', reason: 'dominated', buildsChecked: 1 });
  });

  it('never marks a locked Echo fodder, and leaves every other verdict unchanged', () => {
    const lockedWeak = { ...weak, locked: true as const };
    const base = findUnusedEchoes({ echoes: pool, builds: [atkBuild], characters });
    const withLock = findUnusedEchoes({
      echoes: pool.map((e) => (e.id === 'weak' ? lockedWeak : e)),
      builds: [atkBuild],
      characters,
    });
    expect(base.get('weak')?.status).toBe('fodder');
    expect(withLock.get('weak')).toEqual({ status: 'unused', reason: 'locked', buildsChecked: 1 });
    // It stays in the pool: nothing else changes (strong2 is still kept, not newly "fodder").
    for (const echo of pool) {
      if (echo.id !== 'weak') expect(withLock.get(echo.id)).toEqual(base.get(echo.id));
    }
  });

  it('keeps a locked Echo in the pruning pool so it still counts as a dominator', () => {
    // weak2 (atk 8) is dominated by strong1, strong2 and the locked strong3 (k = 2 needs 2 dominators):
    // drop strong2 from the pool and the locked strong3 is the dominator that keeps weak2 fodder.
    const strong3 = { ...mkEcho('strong3', 4, { atk: 95 }), locked: true as const };
    const weak2 = mkEcho('weak2', 4, { atk: 8 });
    const verdicts = findUnusedEchoes({
      echoes: [strong1, strong3, weak2, ...fillers(4)],
      builds: [atkBuild],
      characters,
    });
    expect(verdicts.get('weak2')?.status).toBe('fodder');
    expect(verdicts.get('strong3')).toEqual({ status: 'unused', reason: 'locked', buildsChecked: 1 });
  });

  it('skips reference builds for membership and for objectives', () => {
    const reference = mkBuild('ref', ['strong2', 'weak', ...fillerIds(3)], maxStat('critRate'), {
      reference: {} as SharedBuild,
    });
    expect(isReferenceBuild(reference)).toBe(true);
    const verdicts = findUnusedEchoes({ echoes: pool, builds: [atkBuild, reference], characters });
    // Counted, the reference would make strong2/weak in-use and keep weak (best critRate).
    expect(verdicts.get('strong2')?.status).toBe('unused');
    expect(verdicts.get('weak')).toEqual({ status: 'fodder', reason: 'dominated', buildsChecked: 1 });
  });

  it('counts a build without an objective for membership only', () => {
    const plain = mkBuild('plain', ['strong1', ...fillerIds(4)]);
    const verdicts = findUnusedEchoes({ echoes: pool, builds: [plain], characters });
    expect(verdicts.get('strong1')?.status).toBe('in-use');
    expect(verdicts.get('weak')).toEqual({ status: 'unused', reason: 'no-objective-builds', buildsChecked: 0 });
    expect(verdicts.get('strong2')?.reason).toBe('no-objective-builds');
  });

  it('is fodder only when every objective build drops it', () => {
    const critBuild = mkBuild('crit', ['strong1', ...fillerIds(4)], maxStat('critRate'));
    // max-stat critRate: weak (0.1) beats strong1/strong2 (0) → nothing dominates it there.
    const verdicts = findUnusedEchoes({ echoes: pool, builds: [atkBuild, critBuild], characters });
    expect(verdicts.get('weak')).toEqual({ status: 'unused', reason: 'kept', buildsChecked: 2, keptBy: 'crit' });
  });

  it('needs k same-cost dominators (3 for a 3-cost at budget 12)', () => {
    // 3-costs at budget 12: k = 3 (9 + 2·1 = 11 ≤ 12).
    const weak3 = mkEcho('weak3', 3, { atk: 10 });
    const doms = [mkEcho('d1', 3, { atk: 40 }), mkEcho('d2', 3, { atk: 30 }), mkEcho('d3', 3, { atk: 20 })];
    const build = mkBuild('atk', fillerIds(5), maxStat('atk'));
    const two = findUnusedEchoes({ echoes: [weak3, doms[0], doms[1], ...fillers(5)], builds: [build], characters });
    expect(two.get('weak3')?.status).toBe('unused');
    const three = findUnusedEchoes({ echoes: [weak3, ...doms, ...fillers(5)], builds: [build], characters });
    expect(three.get('weak3')?.status).toBe('fodder');
    // d3 has 2 dominators (d1, d2) < 3 → kept.
    expect(three.get('d3')?.status).toBe('unused');
  });

  it('uses budget 12: one 4-cost dominator is not enough', () => {
    // At budget 10 (k = 1) one dominator would drop weak4; at 12 (k = 2) it stays.
    const weak4 = mkEcho('weak4', 4, { atk: 10 });
    const dom = mkEcho('dom', 4, { atk: 50 });
    const build = mkBuild('atk', fillerIds(5), maxStat('atk'));
    const verdicts = findUnusedEchoes({ echoes: [weak4, dom, ...fillers(5)], builds: [build], characters });
    expect(verdicts.get('weak4')?.status).toBe('unused');
  });

  it('keeps a main-slot carrier unless its dominators share its definition', () => {
    expect(hasMainEchoBonus('jiyan', 'kerasaur')).toBe(true);
    const carrier = mkEcho('carrier', 4, { atk: 10 }, { echoDefId: 'kerasaur' });
    const build = mkBuild('atk', fillerIds(5), maxStat('atk'));
    // Two stronger 4-costs of other defs: enough for a plain Echo, not for a carrier.
    const otherDefs = [mkEcho('o1', 4, { atk: 50 }), mkEcho('o2', 4, { atk: 40 })];
    const kept = findUnusedEchoes({ echoes: [carrier, ...otherDefs, ...fillers(5)], builds: [build], characters });
    expect(kept.get('carrier')?.status).toBe('unused');
    // Two stronger kerasaurs keep the carrier bonus available → dropped.
    const sameDef = [
      mkEcho('k1', 4, { atk: 50 }, { echoDefId: 'kerasaur' }),
      mkEcho('k2', 4, { atk: 40 }, { echoDefId: 'kerasaur' }),
    ];
    const dropped = findUnusedEchoes({ echoes: [carrier, ...sameDef, ...fillers(5)], builds: [build], characters });
    expect(dropped.get('carrier')?.status).toBe('fodder');
  });

  it('is not fodder when its only dominators are equipped on another character', () => {
    // Whole pool: weak (atk 10) has 2 dominators → dropped. Without Echoes equipped
    // elsewhere (a run with "exclude equipped elsewhere") it has 0 → kept.
    const elsewhere = [
      mkEcho('strong1', 4, { atk: 100 }, { equippedTo: 'verina' }),
      mkEcho('strong2', 4, { atk: 90 }, { equippedTo: 'verina' }),
    ];
    const plainWeak = mkEcho('weak', 4, { atk: 10 });
    const build = mkBuild('atk', fillerIds(5), maxStat('atk'));
    const verdicts = findUnusedEchoes({ echoes: [...elsewhere, plainWeak, ...fillers(5)], builds: [build], characters });
    expect(verdicts.get('weak')).toEqual({ status: 'unused', reason: 'kept', buildsChecked: 1, keptBy: 'atk' });
  });

  it("is fodder when its dominators are equipped on the build's own character", () => {
    // Both pools keep strong1/strong2 (equipped on jiyan, the build's character) → dropped in both.
    const own = [
      mkEcho('strong1', 4, { atk: 100 }, { equippedTo: 'jiyan' }),
      mkEcho('strong2', 4, { atk: 90 }, { equippedTo: 'jiyan' }),
    ];
    const plainWeak = mkEcho('weak', 4, { atk: 10 });
    const build = mkBuild('atk', fillerIds(5), maxStat('atk'));
    const verdicts = findUnusedEchoes({ echoes: [...own, plainWeak, ...fillers(5)], builds: [build], characters });
    expect(verdicts.get('weak')).toEqual({ status: 'fodder', reason: 'dominated', buildsChecked: 1 });
  });

  it('marks nothing fodder while an objective build cannot be checked', () => {
    const ghost = mkBuild('ghost', fillerIds(4).concat('strong1'), maxStat('atk'), { characterId: 'no-such-character' });
    const staleSkill = mkBuild('stale', fillerIds(4).concat('strong1'), {
      kind: 'expected-damage',
      skillId: 'no-such-skill',
      motionName: 'x',
      forteLevel: 10,
      crit: 'expected',
    });
    for (const broken of [ghost, staleSkill]) {
      const verdicts = findUnusedEchoes({ echoes: pool, builds: [atkBuild, broken], characters });
      expect(verdicts.get('weak')).toEqual({ status: 'unused', reason: 'unchecked-build', buildsChecked: 1 });
      // A checked build that keeps the Echo still names itself.
      expect(verdicts.get('strong2')?.reason).toBe('kept');
    }
  });
});

describe('pruneInputs', () => {
  // The derivation `prepare()` used inline before the extraction:
  // the motion's dmgType/scaling, else the skill's kind/scaling, else basic/ATK.
  it('expected-damage follows the motion bucket, then the skill', () => {
    const liberation = jiyan.skills.find((s) => s.kind === 'liberation')!;
    const motion = liberation.motionValues[0];
    const spec: ObjectiveSpec = {
      kind: 'expected-damage',
      skillId: liberation.id,
      motionName: motion.name,
      forteLevel: 10,
      crit: 'expected',
    };
    const inputs = pruneInputs(jiyan, spec, ['energyRegen']);
    expect(inputs.skill).toBe(liberation);
    expect(inputs.relevantStats).toEqual(
      relevantStatsForObjective(spec, 'Aero', motion.dmgType ?? 'liberation', ['energyRegen'], motion.scaling ?? 'ATK'),
    );
    expect(inputs.relevantStats).toEqual(expect.arrayContaining(['energyRegen', 'dmgBonus:Aero', 'critRate']));

    const unknownMotion = { ...spec, motionName: 'no-such-motion' };
    expect(pruneInputs(jiyan, unknownMotion).relevantStats).toEqual(
      relevantStatsForObjective(unknownMotion, 'Aero', 'liberation', [], 'ATK'),
    );
  });

  it('uses a motion bucket that differs from its parent skill kind', () => {
    const found = characters
      .flatMap((c) => c.skills.map((s) => ({ c, s })))
      .flatMap(({ c, s }) => s.motionValues.map((m) => ({ c, s, m })))
      .find(({ s, m }) => m.dmgType !== undefined && m.dmgType !== s.kind && m.dmgType !== 'forte');
    expect(found).toBeDefined();
    const { c, s, m } = found!;
    const spec: ObjectiveSpec = { kind: 'expected-damage', skillId: s.id, motionName: m.name, forteLevel: 10, crit: 'expected' };
    const stats = pruneInputs(c, spec).relevantStats;
    expect(stats).toContain(`dmgBonus:${m.dmgType}`);
    expect(stats).toEqual(relevantStatsForObjective(spec, c.attribute, m.dmgType!, [], m.scaling ?? s.scaling ?? 'ATK'));
  });

  it('max-stat is the stat plus the minimum keys', () => {
    const inputs = pruneInputs(jiyan, maxStat('atk'), ['critRate']);
    expect(inputs.skill).toBeUndefined();
    expect([...inputs.relevantStats].sort()).toEqual(['atk', 'critRate']);
  });

  it('rotation-dpr uses the basic/ATK fallback (every bucket and scaling stat)', () => {
    const spec: ObjectiveSpec = {
      kind: 'rotation-dpr',
      blocks: [{ skillId: 'x', motionName: 'y', forteLevel: 10, activeBuffIds: [] }],
      buffs: [{ id: 'b', label: 'b', source: 'test', mods: [{ stat: 'healingBonus', value: 0.1 }] }],
      globalBuffIds: [],
      crit: 'expected',
    };
    const inputs = pruneInputs(jiyan, spec);
    expect(inputs.relevantStats).toEqual(relevantStatsForObjective(spec, 'Aero', 'basic', [], 'ATK'));
    expect(inputs.relevantStats).toEqual(expect.arrayContaining(['hp', 'def', 'dmgBonus:echo', 'healingBonus']));
  });

  it('isMainCarrier is hasMainEchoBonus for the character', () => {
    const { isMainCarrier } = pruneInputs(jiyan, maxStat('atk'));
    for (const def of snapshot.echoDefs.slice(0, 50).map((d) => d.id).concat('kerasaur')) {
      expect(isMainCarrier(def)).toBe(hasMainEchoBonus('jiyan', def));
    }
  });
});

describe('findUnusedEchoes at inventory scale', () => {
  // Measured 2026-10-21: 60–71 ms test time for this case (one cold run under
  // vitest, two prune passes per build: whole pool and equipped-elsewhere
  // excluded), so the finder stays on the main thread, memoised by the
  // Inventory page.
  it('handles 300 Echoes × 10 objective builds', () => {
    let seed = 7;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const subPool: StatKey[] = ['atk', 'atkPct', 'critRate', 'critDmg', 'hp', 'hpPct', 'def', 'energyRegen', 'dmgBonus:basic'];
    const sets = snapshot.sonataSets.slice(0, 6).map((s) => s.id);
    const echoes = Array.from({ length: 300 }, (_, i) => {
      const cost = ([1, 1, 3, 3, 4] as const)[i % 5];
      const subs = Object.fromEntries(
        subPool.filter(() => rand() < 0.5).slice(0, 5).map((stat) => [stat, Math.round(rand() * 100) / 1000]),
      );
      return mkEcho(`e${i}`, cost, subs, { sonataId: sets[i % sets.length], echoDefId: `def${i % 40}` });
    });
    const liberation = jiyan.skills.find((s) => s.kind === 'liberation')!;
    const objectives: ObjectiveSpec[] = [
      maxStat('atk'),
      maxStat('critRate'),
      maxStat('hp'),
      maxStat('energyRegen'),
      { kind: 'expected-damage', skillId: liberation.id, motionName: liberation.motionValues[0].name, forteLevel: 10, crit: 'expected' },
    ];
    const builds = Array.from({ length: 10 }, (_, i) =>
      mkBuild(`b${i}`, [0, 1, 2, 3, 4].map((j) => `e${i * 5 + j}`), objectives[i % objectives.length]),
    );
    const verdicts = findUnusedEchoes({ echoes, builds, characters });
    expect(verdicts.size).toBe(300);
    expect([...verdicts.values()].filter((v) => v.status === 'in-use')).toHaveLength(50);
  });
});
