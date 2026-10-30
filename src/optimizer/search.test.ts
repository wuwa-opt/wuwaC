import { describe, expect, it } from 'vitest';
import { loadBundledSnapshot } from '../data/index.ts';
import { MAIN_STAT_RANGES, SUB_STAT_TIERS } from '../data/echoStats.ts';
import type { OwnedEcho, RosterEntry, StatKey } from '../data/schema.ts';
import { standardMob } from '../domain/damage.ts';
import { resolveObjectiveSkill, scoreSheet } from '../domain/objectives.ts';
import { computeStats } from '../domain/stats.ts';
import { presetsForCharacter, presetToBlocks } from '../data/rotationPresets.ts';
import {
  costPatterns,
  mergeShardResults,
  searchExhaustive,
  searchReference,
  selectCandidates,
  type OptimizeRequest,
  type ProgressUpdate,
  type RankedBuild,
  type SearchData,
  type SearchResult,
} from './search.ts';

const snapshot = loadBundledSnapshot();
const jiyan = snapshot.characters.find((c) => c.id === 'jiyan')!;
const verdant = snapshot.weapons.find((w) => w.id === 'verdant-summit')!;
const sonataSets = snapshot.sonataSets.filter((s) =>
  ['sierra-gale', 'rejuvenating-glow'].includes(s.id),
);
const liberation = jiyan.skills.find((s) => s.kind === 'liberation')!;

interface EchoSpec {
  main: [StatKey, number];
  subs?: [StatKey, number][];
  cost: 1 | 3 | 4;
  sonata?: string;
  def?: string;
}

function mkEcho(id: string, spec: EchoSpec): OwnedEcho {
  return {
    id,
    label: id,
    echoDefId: spec.def ?? `${id}-def`,
    sonataId: spec.sonata ?? 'sierra-gale',
    cost: spec.cost,
    level: 25,
    rarity: 5,
    mainStat: { stat: spec.main[0], value: spec.main[1] },
    substats: (spec.subs ?? []).map(([stat, value]) => ({ stat, value })),
    equippedTo: null,
    origin: 'manual',
  };
}

// Hand-verified inventory (see plan notes for the arithmetic):
// e1 god-crit(4) / e2 flat-atk(4) / e3 aero(3) / e4 filler(3)
// e5 off-set glow(3) / e6 one-a(1) / e7 one-b(1) / e8 atk-trap(4) / e9 glow-one(1)
const echoes: OwnedEcho[] = [
  mkEcho('e1', { main: ['critRate', 0.3], subs: [['critDmg', 0.2], ['atkPct', 0.15]], cost: 4 }),
  mkEcho('e2', { main: ['atk', 500], subs: [['atk', 100], ['hp', 1000]], cost: 4 }),
  mkEcho('e3', { main: ['dmgBonus:Aero', 0.3], subs: [['atkPct', 0.1]], cost: 3 }),
  mkEcho('e4', { main: ['defPct', 0.3], subs: [['def', 100]], cost: 3 }),
  mkEcho('e5', { main: ['atkPct', 0.3], cost: 3, sonata: 'rejuvenating-glow' }),
  mkEcho('e6', { main: ['atk', 50], subs: [['critRate', 0.05]], cost: 1 }),
  mkEcho('e7', { main: ['hp', 500], subs: [['critDmg', 0.1]], cost: 1 }),
  mkEcho('e8', { main: ['atkPct', 0.4], subs: [['atkPct', 0.2]], cost: 4 }),
  mkEcho('e9', { main: ['hp', 300], cost: 1, sonata: 'rejuvenating-glow' }),
];

const roster: RosterEntry = {
  characterId: 'jiyan',
  level: 90,
  ascension: 6,
  resonanceChain: 0,
  forteLevels: { [liberation.id]: 10 },
  weaponId: 'verdant-summit',
  weaponLevel: 90,
  weaponRank: 1,
};

const data: SearchData = {
  character: jiyan,
  weapon: verdant,
  roster,
  echoes,
  sonataSets,
  enemy: standardMob(90),
};

const maxAtk: OptimizeRequest = {
  costBudget: 12,
  sonataLock: { mode: 'none' },
  objective: { kind: 'max-stat', stat: 'atk' },
  topN: 10,
  prune: false,
};

describe('searchExhaustive', () => {
  it('finds the hand-computed optimum for max flat ATK', () => {
    // Only e2 carries flat ATK (600); e6 adds 50. Three 1-cost echoes make
    // two-4-cost combos legal (4+4+1+1+1 = 11), so the first max combo in
    // lexicographic order is {e1,e2,e6,e7,e9}, score 650.
    const result = searchExhaustive(data, maxAtk);
    expect(result.builds).not.toHaveLength(0);
    expect(result.builds[0].echoIds).toEqual(['e1', 'e2', 'e6', 'e7', 'e9']);
    expect(result.builds[0].score).toBe(650);
  });

  it('ranks descending and truncates to topN', () => {
    const result = searchExhaustive(data, { ...maxAtk, topN: 2 });
    expect(result.builds).toHaveLength(2);
    expect(result.builds[0].score).toBeGreaterThanOrEqual(result.builds[1].score);
  });

  it('counts every valid combo without pruning (C(9,5)=126 generated, 45 valid)', () => {
    const result = searchExhaustive(data, maxAtk);
    expect(result.evaluated).toBe(45);
    expect(result.prunedEchoes).toEqual([]);
  });

  it('respects the cost budget on every returned build', () => {
    const result = searchExhaustive(data, maxAtk);
    const costs = new Map(echoes.map((e) => [e.id, e.cost] as const));
    for (const build of result.builds) {
      const total = build.echoIds.reduce((sum, id) => sum + (costs.get(id) ?? 0), 0);
      expect(total).toBeLessThanOrEqual(12);
    }
  });

  it('enforces a 5-piece sonata lock (exactly the 3 valid builds)', () => {
    const result = searchExhaustive(data, {
      ...maxAtk,
      sonataLock: { mode: 'five', setId: 'sierra-gale' },
    });
    expect(result.builds).toHaveLength(3);
    for (const build of result.builds) {
      const sonatas = new Set(
        build.echoIds.map((id) => echoes.find((e) => e.id === id)!.sonataId),
      );
      expect(sonatas).toEqual(new Set(['sierra-gale']));
    }
  });

  it('enforces a 2+2 sonata lock (exactly 19 valid builds)', () => {
    const result = searchExhaustive(data, {
      ...maxAtk,
      topN: 50,
      sonataLock: { mode: 'twoPlusTwo', setIdA: 'sierra-gale', setIdB: 'rejuvenating-glow' },
    });
    expect(result.builds).toHaveLength(19);
    for (const build of result.builds) {
      const counts = new Map<string, number>();
      for (const id of build.echoIds) {
        const sonata = echoes.find((e) => e.id === id)!.sonataId;
        counts.set(sonata, (counts.get(sonata) ?? 0) + 1);
      }
      expect(counts.get('sierra-gale') ?? 0).toBeGreaterThanOrEqual(2);
      expect(counts.get('rejuvenating-glow') ?? 0).toBeGreaterThanOrEqual(2);
    }
  });

  it('filters builds below minStats minimums', () => {
    // Only combos containing e2 (600 flat ATK) clear 550.
    const result = searchExhaustive(data, { ...maxAtk, minStats: { atk: 550 } });
    expect(result.builds.length).toBeGreaterThan(0);
    for (const build of result.builds) {
      expect(build.echoIds).toContain('e2');
    }
    const impossible = searchExhaustive(data, { ...maxAtk, minStats: { atk: 9999 } });
    expect(impossible.builds).toEqual([]);
  });

  it('never prunes a set-completing echo the optimum needs (soundness)', () => {
    // max-stat Aero over: 2x stat-weak Sierra Gale + 5x off-set glow with
    // 0.04 Aero each. Sierra 2pc (+0.10 Aero, auto-applied) makes
    // s1+s2+3x off-set (0.22) beat 5x off-set (0.20) — but raw-stat
    // dominance would prune the zero-Aero Sierra pair first.
    const inv: OwnedEcho[] = [
      mkEcho('s1', { main: ['atk', 10], cost: 1, sonata: 'sierra-gale' }),
      mkEcho('s2', { main: ['atk', 10], cost: 1, sonata: 'sierra-gale' }),
      mkEcho('o1', { main: ['dmgBonus:Aero', 0.04], cost: 1, sonata: 'rejuvenating-glow' }),
      mkEcho('o2', { main: ['dmgBonus:Aero', 0.04], cost: 1, sonata: 'rejuvenating-glow' }),
      mkEcho('o3', { main: ['dmgBonus:Aero', 0.04], cost: 1, sonata: 'rejuvenating-glow' }),
      mkEcho('o4', { main: ['dmgBonus:Aero', 0.04], cost: 1, sonata: 'rejuvenating-glow' }),
      mkEcho('o5', { main: ['dmgBonus:Aero', 0.04], cost: 1, sonata: 'rejuvenating-glow' }),
    ];
    const request: OptimizeRequest = {
      costBudget: 12,
      sonataLock: { mode: 'none' },
      objective: { kind: 'max-stat', stat: 'dmgBonus:Aero' },
      topN: 1,
    };
    const unpruned = searchExhaustive({ ...data, echoes: inv }, { ...request, prune: false });
    const pruned = searchExhaustive({ ...data, echoes: inv }, request);
    // The exhaustive baseline finds the Sierra optimum; pruning must agree.
    expect(unpruned.builds[0].echoIds).toContain('s1');
    expect(unpruned.builds[0].echoIds).toContain('s2');
    expect(pruned.builds[0].echoIds).toContain('s1');
    expect(pruned.builds[0].echoIds).toContain('s2');
    expect(pruned.builds[0].score).toBe(unpruned.builds[0].score);
    expect(pruned.prunedEchoes).not.toContain('s1');
    expect(pruned.prunedEchoes).not.toContain('s2');
  });

  it('picks the best slot-1 echo and records it (Lorelei main)', () => {
    // max-stat Havoc over zero-havoc echoes: only Lorelei's transcribed
    // main-slot bonus (+12% Havoc) can score, so the winner must carry it
    // as main.
    const inv: OwnedEcho[] = [
      mkEcho('m1', { main: ['atk', 10], cost: 1, def: 'lorelei' }),
      mkEcho('f1', { main: ['atk', 10], cost: 1 }),
      mkEcho('f2', { main: ['atk', 10], cost: 1 }),
      mkEcho('f3', { main: ['atk', 10], cost: 1 }),
      mkEcho('f4', { main: ['atk', 10], cost: 1 }),
      mkEcho('f5', { main: ['atk', 10], cost: 1 }),
    ];
    const result = searchExhaustive(
      { ...data, echoes: inv },
      {
        costBudget: 12,
        sonataLock: { mode: 'none' },
        objective: { kind: 'max-stat', stat: 'dmgBonus:Havoc' },
        topN: 1,
      },
    );
    expect(result.builds).toHaveLength(1);
    expect(result.builds[0].score).toBeCloseTo(0.12, 10);
    expect(result.builds[0].echoIds).toContain('m1');
    expect(result.builds[0].mainEchoId).toBe('m1');
    expect(result.builds[0].appliedAssumptions.join(' ')).toMatch(/Lorelei/);
  });

  it('shifts rotation-dpr ranking when team buffs saturate a bucket', () => {
    // Six cost-1 echoes, pick 5: two Aero (0.30), two Crit DMG (0.40),
    // two ATK% fills (0.15). Without buffs the winner drops a fill
    // (Aero's margin ~21% beats ATK%'s ~11%); with +500% team Aero the
    // Aero margin collapses to ~5% and the winner drops an Aero piece
    // instead. This pins buff threading through the optimizer — drop
    // the buffs and both runs agree.
    const inv: OwnedEcho[] = [
      mkEcho('aero1', { main: ['dmgBonus:Aero', 0.3], cost: 1 }),
      mkEcho('aero2', { main: ['dmgBonus:Aero', 0.3], cost: 1 }),
      mkEcho('crit1', { main: ['critDmg', 0.4], cost: 1 }),
      mkEcho('crit2', { main: ['critDmg', 0.4], cost: 1 }),
      mkEcho('fill1', { main: ['atkPct', 0.15], cost: 1 }),
      mkEcho('fill2', { main: ['atkPct', 0.15], cost: 1 }),
    ];
    const blocks = [
      { id: 'b1', skillId: liberation.id, motionName: 'Lance of Qingloong Stage 1 DMG', forteLevel: 10, activeBuffIds: [] as string[] },
    ];
    const teamAero = {
      id: 'team-aero',
      label: 'Team Aero',
      source: 'Team',
      mods: [{ stat: 'dmgBonus:Aero' as const, value: 5 }],
    };
    const run = (globalBuffIds: string[]): string[] => {
      const result = searchExhaustive(
        { ...data, echoes: inv },
        {
          costBudget: 12,
          sonataLock: { mode: 'none' },
          objective: { kind: 'rotation-dpr', blocks, buffs: [teamAero], globalBuffIds, crit: 'expected' },
          topN: 1,
        },
      );
      expect(result.builds).toHaveLength(1);
      return result.builds[0].echoIds;
    };
    const plain = run([]);
    expect(plain).toContain('aero1');
    expect(plain).toContain('aero2');
    const buffed = run(['team-aero']);
    expect(buffed).toContain('fill1');
    expect(buffed).toContain('fill2');
    expect(buffed).not.toEqual(plain);
  });

  it('shifts rotation-dpr ranking when a window activates a buff (window == global)', () => {
    // Same bucket-saturation inventory as the team-buff test above: one
    // liberation block, +500% Aero buff present but inactive untimed. The
    // untimed winner keeps both Aero pieces (dropping a crit scores 10562,
    // dropping a fill 9863, dropping an Aero 9755); windowing the buff over
    // the block ([0, 10), no global flag, no toggle) activates it, the Aero
    // margin collapses, and the winner drops an Aero piece for the second
    // fill instead — the window moves the optimum through the unmodified
    // search. The windowed winner scores bit-identically to the same buff
    // applied global, pinning that a covering window resolves exactly like
    // full uptime on the optimizer path (partial-window resolution itself is
    // pinned in the domain layer by rotation.test.ts).
    const inv: OwnedEcho[] = [
      mkEcho('aero1', { main: ['dmgBonus:Aero', 0.3], cost: 1 }),
      mkEcho('aero2', { main: ['dmgBonus:Aero', 0.3], cost: 1 }),
      mkEcho('crit1', { main: ['critDmg', 0.4], cost: 1 }),
      mkEcho('crit2', { main: ['critDmg', 0.4], cost: 1 }),
      mkEcho('fill1', { main: ['atkPct', 0.15], cost: 1 }),
      mkEcho('fill2', { main: ['atkPct', 0.15], cost: 1 }),
    ];
    const plainBlock = { skillId: liberation.id, motionName: 'Lance of Qingloong Stage 1 DMG', forteLevel: 10, activeBuffIds: [] as string[] };
    const timedBlock = { ...plainBlock, durationSeconds: 2 };
    const teamAero = {
      id: 'team-aero',
      label: 'Team Aero',
      source: 'Team',
      mods: [{ stat: 'dmgBonus:Aero' as const, value: 5 }],
    };
    const run = (objective: OptimizeRequest['objective']): RankedBuild => {
      const result = searchExhaustive(
        { ...data, echoes: inv },
        { costBudget: 12, sonataLock: { mode: 'none' }, objective, topN: 1 },
      );
      expect(result.builds).toHaveLength(1);
      return result.builds[0];
    };
    const untimed = run({ kind: 'rotation-dpr', blocks: [plainBlock], buffs: [teamAero], globalBuffIds: [], crit: 'expected' });
    expect(untimed.echoIds).toContain('aero1');
    expect(untimed.echoIds).toContain('aero2');
    const windowed = run({
      kind: 'rotation-dpr',
      blocks: [timedBlock],
      buffs: [{ ...teamAero, windowStartSeconds: 0, windowDurationSeconds: 10 }],
      globalBuffIds: [],
      crit: 'expected',
    });
    expect(windowed.echoIds).toContain('fill1');
    expect(windowed.echoIds).toContain('fill2');
    expect(windowed.echoIds).not.toEqual(untimed.echoIds);
    const global = run({
      kind: 'rotation-dpr',
      blocks: [timedBlock],
      buffs: [teamAero],
      globalBuffIds: ['team-aero'],
      crit: 'expected',
    });
    expect(windowed.score).toBe(global.score);
    expect(windowed.score).toBeGreaterThan(untimed.score);
  });

  it('scores echo-skill blocks through the shared rotation path (echo bucket wins)', () => {
    // Six cost-1 echoes, pick 5, one Lorelei-style echo block: the two
    // Echo-Skill-DMG pieces must survive in the winner — dropping either
    // costs far more echo damage than any fill. This pins the optimizer
    // picking up echo-block math with no search changes.
    const inv: OwnedEcho[] = [
      mkEcho('echo1', { main: ['dmgBonus:echo', 0.3], cost: 1 }),
      mkEcho('echo2', { main: ['dmgBonus:echo', 0.3], cost: 1 }),
      mkEcho('crit1', { main: ['critDmg', 0.4], cost: 1 }),
      mkEcho('crit2', { main: ['critDmg', 0.4], cost: 1 }),
      mkEcho('fill1', { main: ['atkPct', 0.15], cost: 1 }),
      mkEcho('fill2', { main: ['atkPct', 0.15], cost: 1 }),
    ];
    const blocks = [
      {
        skillId: '', motionName: 'Lorelei', forteLevel: 1, activeBuffIds: [] as string[],
        damageKind: 'echoSkill' as const, echoName: 'Lorelei',
        echoMotionValue: 4.05, echoAttribute: 'Havoc' as const,
      },
    ];
    const result = searchExhaustive(
      { ...data, echoes: inv },
      {
        costBudget: 12,
        sonataLock: { mode: 'none' },
        objective: { kind: 'rotation-dpr', blocks, buffs: [], globalBuffIds: [], crit: 'expected' },
        topN: 1,
      },
    );
    expect(result.builds).toHaveLength(1);
    expect(result.builds[0].echoIds).toContain('echo1');
    expect(result.builds[0].echoIds).toContain('echo2');
    expect(result.builds[0].score).toBeGreaterThan(0);
  });

  it('prunes by default and reports dropped echoes', () => {
    // Relevant stat is flat atk. Budget 10 fits one 4-cost (4+3+1+1+1), so
    // a single dominator suffices for 4-costs at top-1: e2 (600) drops
    // same-set e1/e8. e6 (50) beats e7, but up to five 1-costs share a
    // combo, so e7 stays. Survivors e2-e7, e9: {e2, one 3-cost, e6,e7,e9}
    // ×3 plus {two 3-costs, e6,e7,e9} ×3 = 6 combos. Winner (first of the
    // 650 ties) {e2,e3,e6,e7,e9}: 600 + 50.
    const result = searchExhaustive(data, { ...maxAtk, costBudget: 10, topN: 1, prune: undefined });
    expect([...result.prunedEchoes].sort()).toEqual(['e1', 'e8']);
    expect(result.evaluated).toBe(6);
    expect(result.builds).toHaveLength(1);
    expect(result.builds[0].echoIds).toEqual(['e2', 'e3', 'e6', 'e7', 'e9']);
    expect(result.builds[0].score).toBe(650);
  });

  it('does not prune when a dominator could share the combo (top-10, budget 12)', () => {
    // Budget 12 fits two 4-costs and five 1-costs, and top-10 needs 9 more
    // dominators on top of that — the old one-dominator rule dropped e1/e7/e8
    // here and returned 4 builds where the full search has 10.
    const pruned = searchExhaustive(data, { ...maxAtk, prune: undefined });
    const full = searchExhaustive(data, maxAtk);
    expect(pruned.prunedEchoes).toEqual([]);
    expect(pruned.builds.map((b) => b.score)).toEqual(full.builds.map((b) => b.score));
  });

  it('picks the crit build for expected liberation damage', () => {
    // Hand-compared: best e1 combo (~2764) beats best non-e1 combo (~2657).
    const result = searchExhaustive(data, {
      costBudget: 12,
      sonataLock: { mode: 'none' },
      objective: {
        kind: 'expected-damage',
        skillId: liberation.id,
        motionName: 'Lance of Qingloong Stage 1 DMG',
        forteLevel: 10,
        crit: 'expected',
      },
      topN: 3,
    });
    expect(result.builds[0].echoIds).toContain('e1');
  });

  it('returns empty (not throw) when nothing qualifies', () => {
    const poor: SearchData = { ...data, echoes: echoes.slice(0, 4) };
    const result = searchExhaustive(poor, maxAtk);
    expect(result.builds).toEqual([]);
    expect(result.evaluated).toBe(0);
  });

  it('throws on malformed requests', () => {
    expect(() => searchExhaustive(data, { ...maxAtk, topN: 0 })).toThrow(/topN/);
    expect(() => searchExhaustive(data, { ...maxAtk, costBudget: 11 as 10 })).toThrow(/budget/);
  });

  it('ranks builds by rotation DPR', () => {    const basic = jiyan.skills.find((s) => s.kind === 'basic')!;
    const result = searchExhaustive(data, {
      costBudget: 12,
      sonataLock: { mode: 'none' },
      objective: {
        kind: 'rotation-dpr',
        blocks: [
          { skillId: basic.id, motionName: 'Stage 1 DMG', forteLevel: 10, activeBuffIds: [] },
          { skillId: liberation.id, motionName: 'Lance of Qingloong Stage 1 DMG', forteLevel: 10, activeBuffIds: ['amp'] },
        ],
        buffs: [{ id: 'amp', label: 'AMP', source: 'test', mods: [{ stat: 'amplify', value: 0.2 }] }],
        globalBuffIds: [],
        crit: 'expected',
      },
      topN: 3,
      prune: false,
    });
    // Same 45 valid combos as the max-ATK baseline, all positively scored.
    expect(result.evaluated).toBe(45);
    expect(result.builds).toHaveLength(3);
    for (const build of result.builds) expect(build.score).toBeGreaterThan(0);
    expect(result.builds[0].score).toBeGreaterThanOrEqual(result.builds[1].score);
    // The crit-loaded e1 still wins a damage race.
    expect(result.builds[0].echoIds).toContain('e1');
  });

  it('scores HP-scaling rotations without throwing (Cartethyia find-best-builds regression)', () => {
    // Reported bug: "unsupported scaling HP in v1 (ATK only)" on Cartethyia.
    const cartethyia = snapshot.characters.find((c) => c.id === 'cartethyia')!;
    const cartSkill = cartethyia.skills.find((s) =>
      s.motionValues.some((m) => !m.isHealing),
    )!;
    const cartMotion = cartSkill.motionValues.find((m) => !m.isHealing)!;
    const cartRoster: RosterEntry = {
      characterId: 'cartethyia',
      level: 90,
      ascension: 6,
      resonanceChain: 0,
      forteLevels: {},
      weaponId: 'verdant-summit',
      weaponLevel: 90,
      weaponRank: 1,
    };
    const result = searchExhaustive(
      { ...data, character: cartethyia, roster: cartRoster },
      {
        costBudget: 12,
        sonataLock: { mode: 'none' },
        objective: {
          kind: 'rotation-dpr',
          blocks: [{ skillId: cartSkill.id, motionName: cartMotion.name, forteLevel: 10, activeBuffIds: [] }],
          buffs: [],
          globalBuffIds: [],
          crit: 'expected',
        },
        topN: 3,
        prune: false,
      },
    );
    expect(result.evaluated).toBe(45);
    expect(result.builds).toHaveLength(3);
    for (const build of result.builds) expect(build.score).toBeGreaterThan(0);
  });
});

describe('costPatterns', () => {
  it('derives every legal 5-cost multiset for budget 12 (hand-listed)', () => {
    // Counts of [4, 3, 1]-costs: 4-4-1-1-1 (11), 4-3-3-1-1 (12), 4-3-1-1-1
    // (10), 4-1-1-1-1 (8), 3-3-3-1-1 (11), 3-3-1-1-1 (9), 3-1-1-1-1 (7),
    // 1-1-1-1-1 (5). 4-4-3-x and 4-3-3-3-x overflow.
    expect(costPatterns([4, 3, 1], 12)).toEqual([
      [2, 0, 3], [1, 2, 2], [1, 1, 3], [1, 0, 4], [0, 3, 2], [0, 2, 3], [0, 1, 4], [0, 0, 5],
    ]);
  });

  it('drops the two-4-cost and 4-3-3 patterns at budget 10', () => {
    expect(costPatterns([4, 3, 1], 10)).toEqual([[1, 1, 3], [1, 0, 4], [0, 2, 3], [0, 1, 4], [0, 0, 5]]);
  });

  it('handles pools missing a cost', () => {
    expect(costPatterns([3, 1], 12)).toEqual([[3, 2], [2, 3], [1, 4], [0, 5]]);
    expect(costPatterns([4], 12)).toEqual([]);
    expect(costPatterns([], 12)).toEqual([]);
  });
});

describe('search progress', () => {
  it('reports covered combos up to exactly the legal total (45 of 45)', () => {
    const updates: ProgressUpdate[] = [];
    const result = searchExhaustive(data, maxAtk, (u) => updates.push(u));
    expect(updates[0]).toEqual({ evaluated: 0, total: 45 });
    expect(updates[updates.length - 1]).toEqual({ evaluated: 45, total: 45 });
    expect(result.total).toBe(45);
    expect(result.evaluated).toBe(45);
  });

  it('rejects malformed shards', () => {
    expect(() => searchExhaustive(data, maxAtk, undefined, { index: 2, count: 2 })).toThrow(/shard/);
  });
});

describe('minStats per main-echo choice', () => {
  it('keeps a combo whose minimum is met by a lower-scoring main echo', () => {
    // Five Sierra Gale 1-costs incl. Kerasaur (+12% Aero main) and Reactor
    // Husk (+10% Energy Regen main). Max Aero alone would pick Kerasaur, but
    // ER >= base + 0.05 is met only with Reactor Husk in slot 1, so the
    // build is the Husk-main sheet: Aero = baseline (no main Aero bonus).
    const inv: OwnedEcho[] = [
      mkEcho('k1', { main: ['atk', 10], cost: 1, def: 'kerasaur' }),
      mkEcho('r1', { main: ['atk', 10], cost: 1, def: 'reactor-husk' }),
      mkEcho('f1', { main: ['atk', 10], cost: 1 }),
      mkEcho('f2', { main: ['atk', 10], cost: 1 }),
      mkEcho('f3', { main: ['atk', 10], cost: 1 }),
    ];
    const setup = { character: jiyan, weapon: verdant, roster, sonataSets };
    const baseline = computeStats({ ...setup, echoes: inv }).sheet;
    const request: OptimizeRequest = {
      costBudget: 12,
      sonataLock: { mode: 'none' },
      objective: { kind: 'max-stat', stat: 'dmgBonus:Aero' },
      minStats: { energyRegen: baseline.energyRegen + 0.05 },
      topN: 1,
    };
    const result = searchExhaustive({ ...data, echoes: inv }, request);
    expect(result.builds).toHaveLength(1);
    expect(result.builds[0].mainEchoId).toBe('r1');
    expect(result.builds[0].score).toBeCloseTo(baseline['dmgBonus:Aero'], 12);
    expect(result.builds[0].sheet.energyRegen).toBeCloseTo(baseline.energyRegen + 0.1, 12);
    // Without the minimum, Kerasaur's +0.12 Aero wins slot 1.
    const free = searchExhaustive({ ...data, echoes: inv }, { ...request, minStats: undefined });
    expect(free.builds[0].mainEchoId).toBe('k1');
    expect(free.builds[0].score).toBeCloseTo(baseline['dmgBonus:Aero'] + 0.12, 12);
  });
});

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

const EQ_SETS = ['sierra-gale', 'lingering-tunes', 'rejuvenating-glow', 'dream-of-the-lost'];
// Aero main-slot carriers for Jiyan plus plain defs; few defs per set so
// duplicate copies (which don't add Sonata pieces) come up often.
const EQ_DEFS = ['kerasaur', 'reactor-husk', 'nameless-explorer', 'plain-a', 'plain-b', 'plain-c', 'plain-d'];
const EQ_MAINS: StatKey[] = ['atk', 'atkPct', 'critRate', 'critDmg', 'dmgBonus:Aero', 'energyRegen', 'hp'];
const EQ_SUBS: StatKey[] = ['atk', 'atkPct', 'critRate', 'critDmg', 'energyRegen', 'dmgBonus:liberation', 'defPct'];

function randomInventory(rand: () => number, n: number): OwnedEcho[] {
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(rand() * list.length)];
  return Array.from({ length: n }, (_, i) => {
    const subs: [StatKey, number][] = [];
    for (const stat of EQ_SUBS) if (rand() < 0.4) subs.push([stat, stat === 'atk' ? 30 + Math.floor(rand() * 30) : 0.02 + rand() * 0.1]);
    const main = pick(EQ_MAINS);
    return mkEcho(`r${i}`, {
      main: [main, main === 'atk' || main === 'hp' ? 100 + Math.floor(rand() * 300) : 0.1 + rand() * 0.3],
      subs,
      cost: pick([1, 1, 3, 3, 4] as const),
      sonata: pick(EQ_SETS),
      def: pick(EQ_DEFS),
    });
  });
}

function randomRequest(rand: () => number): OptimizeRequest {
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(rand() * list.length)];
  const objectives: OptimizeRequest['objective'][] = [
    { kind: 'max-stat', stat: 'atk' },
    { kind: 'max-stat', stat: 'dmgBonus:Aero' },
    {
      kind: 'expected-damage',
      skillId: liberation.id,
      motionName: 'Lance of Qingloong Stage 1 DMG',
      forteLevel: 10,
      crit: 'expected',
    },
    {
      kind: 'rotation-dpr',
      blocks: [{ skillId: liberation.id, motionName: 'Lance of Qingloong Stage 1 DMG', forteLevel: 10, activeBuffIds: [] }],
      buffs: [],
      globalBuffIds: [],
      crit: 'expected',
    },
  ];
  const lockRoll = rand();
  return {
    costBudget: pick([10, 12] as const),
    sonataLock:
      lockRoll < 0.6
        ? { mode: 'none' }
        : lockRoll < 0.8
          ? { mode: 'five', setId: pick(EQ_SETS) }
          : { mode: 'twoPlusTwo', setIdA: 'sierra-gale', setIdB: pick(EQ_SETS.slice(1)) },
    objective: pick(objectives),
    topN: pick([1, 3, 10]),
    ...(rand() < 0.3 ? { minStats: { critRate: 0.05 + rand() * 0.3 } } : {}),
    ...(rand() < 0.2 ? { prune: false } : {}),
  };
}

/** Everything a caller can observe, minus the strategy-specific `scored`. */
function observable(result: SearchResult, lockFree: boolean) {
  return {
    builds: result.builds,
    prunedEchoes: result.prunedEchoes,
    ...(lockFree ? { evaluated: result.evaluated } : {}),
  };
}

describe('exact search equivalence with the brute-force reference', () => {
  const allSets = snapshot.sonataSets;

  it('matches the reference on 40 seeded random inventories and requests', () => {
    const rand = rng(20261020);
    let boundedAway = 0;
    for (let trial = 0; trial < 40; trial += 1) {
      const inventory = randomInventory(rand, 9 + Math.floor(rand() * 6));
      const request = randomRequest(rand);
      const subject: SearchData = { ...data, echoes: inventory, sonataSets: allSets };
      const fast = searchExhaustive(subject, request);
      const reference = searchReference(subject, request);
      const lockFree = request.sonataLock.mode === 'none';
      expect(observable(fast, lockFree), `trial ${trial}`).toEqual(observable(reference, lockFree));
      expect(fast.evaluated).toBe(fast.total);
      boundedAway += fast.evaluated - fast.scored;
      // Three shards merged give the single-run answer.
      const shards = [0, 1, 2].map((index) => searchExhaustive(subject, request, undefined, { index, count: 3 }));
      expect(shards.reduce((sum, r) => sum + r.evaluated, 0)).toBe(fast.total);
      expect(mergeShardResults(subject, request.topN, shards).builds, `trial ${trial} shards`).toEqual(fast.builds);
    }
    // The bounds must actually skip work somewhere, or this proves nothing.
    expect(boundedAway).toBeGreaterThan(0);
  });

  it('scores every build exactly as scoreSheet does (prepared scorer; rotation with team and windowed buffs, minStats)', () => {
    const rand = rng(20261030);
    const bases = computeStats({ character: jiyan, weapon: verdant, roster, echoes: [], sonataSets: allSets });
    const blocks = presetToBlocks(presetsForCharacter('jiyan')[0]).map((b, i) => ({
      ...b,
      durationSeconds: 0.75,
      activeBuffIds: i % 4 === 0 ? ['verina'] : [],
    }));
    const objective: OptimizeRequest['objective'] = {
      kind: 'rotation-dpr',
      blocks,
      buffs: [
        { id: 'verina', label: 'Verina', source: 'test', mods: [{ stat: 'amplify', value: 0.15 }] },
        { id: 'window', label: 'Window', source: 'test', mods: [{ stat: 'dmgBonus:heavy', value: 0.38 }, { stat: 'atkPct', value: 0.2 }], windowStartSeconds: 2, windowDurationSeconds: 4 },
        { id: 'global', label: 'Global', source: 'test', mods: [{ stat: 'critRate', value: 0.125 }] },
      ],
      globalBuffIds: ['global'],
      crit: 'expected',
    };
    let checked = 0;
    for (let trial = 0; trial < 8; trial += 1) {
      const request: OptimizeRequest = {
        ...randomRequest(rand),
        sonataLock: { mode: 'none' },
        ...(trial % 2 === 0 ? { objective } : {}),
      };
      const subject: SearchData = { ...data, echoes: randomInventory(rand, 10 + Math.floor(rand() * 5)), sonataSets: allSets };
      const ctx = {
        skill: request.objective.kind === 'expected-damage' ? resolveObjectiveSkill(jiyan.skills, request.objective) : undefined,
        skills: jiyan.skills,
        characterId: jiyan.id,
        attribute: jiyan.attribute,
        resonanceChain: roster.resonanceChain,
        attackerLevel: roster.level,
        enemy: subject.enemy,
        baseAtk: bases.baseAtk,
        baseHp: bases.baseHp,
        baseDef: bases.baseDef,
      };
      for (const build of searchExhaustive(subject, request).builds) {
        expect(build.score).toBe(scoreSheet(request.objective, build.sheet, ctx));
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(10);
  });

  it('matches the reference with real Sonata sets (1-, 2-, 3- and 5-piece bonuses)', () => {
    // Real defs from a few real sets per trial, always including Shadow of
    // Shattered Dreams (bonus at 1 piece) and Crown of Valor (at 3), so set
    // bonuses complete, defs repeat, and some sets have a single Echo —
    // the cases the per-set available-defs bound has to get right. Trials
    // with more than 8 Echoes of one cost also run the seed search.
    const rand = rng(20261022);
    const pick = <T,>(list: readonly T[]): T => list[Math.floor(rand() * list.length)];
    const yangyang = snapshot.characters.find((c) => c.id === 'yangyang')!;
    const sword = snapshot.weapons.find((w) => w.weaponType === yangyang.weaponType)!;
    const basic = yangyang.skills.find((s) => s.kind === 'basic')!;
    const forteLevels = Object.fromEntries(yangyang.skills.map((s) => [s.id, 10]));
    const subStats = Object.keys(SUB_STAT_TIERS) as StatKey[];
    let boundedAway = 0;
    for (let trial = 0; trial < 16; trial += 1) {
      const setIds = ['shadow-of-shattered-dreams', 'crown-of-valor', pick(snapshot.sonataSets).id, pick(snapshot.sonataSets).id];
      const defs = snapshot.echoDefs.filter((d) => d.sonataIds.some((id) => setIds.includes(id)));
      const inventory = Array.from({ length: 13 + Math.floor(rand() * 6) }, (_, i) => {
        const def = pick(defs);
        const main = pick(def.allowedMainStats.filter((s) => MAIN_STAT_RANGES[def.cost][s] !== undefined));
        const subs = subStats.filter(() => rand() < 0.35).map((s): [StatKey, number] => [s, pick(SUB_STAT_TIERS[s]!)]);
        return mkEcho(`s${i}`, {
          main: [main, MAIN_STAT_RANGES[def.cost][main]!.max],
          subs,
          cost: def.cost as 1 | 3 | 4,
          sonata: pick(def.sonataIds.filter((id) => setIds.includes(id))),
          def: def.id,
        });
      });
      const request: OptimizeRequest = {
        ...randomRequest(rand),
        objective: pick<OptimizeRequest['objective']>([
          { kind: 'max-stat', stat: 'dmgBonus:basic' },
          { kind: 'expected-damage', skillId: basic.id, motionName: basic.motionValues[0].name, forteLevel: 10, crit: 'expected' },
          {
            kind: 'rotation-dpr',
            blocks: [{ skillId: basic.id, motionName: basic.motionValues[0].name, forteLevel: 10, activeBuffIds: [] }],
            buffs: [],
            globalBuffIds: [],
            crit: 'expected',
          },
        ]),
        sonataLock: { mode: 'none' },
      };
      const subject: SearchData = {
        ...data,
        character: yangyang,
        weapon: sword,
        roster: { ...roster, characterId: 'yangyang', forteLevels, weaponId: sword.id },
        echoes: inventory,
        sonataSets: snapshot.sonataSets,
      };
      const fast = searchExhaustive(subject, request);
      expect(observable(fast, true), `trial ${trial}`).toEqual(observable(searchReference(subject, request), true));
      boundedAway += fast.evaluated - fast.scored;
      const shards = [0, 1, 2].map((index) => searchExhaustive(subject, request, undefined, { index, count: 3 }));
      expect(shards.reduce((sum, r) => sum + r.evaluated, 0), `trial ${trial} coverage`).toBe(fast.total);
      expect(mergeShardResults(subject, request.topN, shards).builds, `trial ${trial} shards`).toEqual(fast.builds);
    }
    expect(boundedAway).toBeGreaterThan(0);
  }, 60_000);

  it('skips most combos on a larger inventory and still matches (n = 22)', () => {
    const inventory = randomInventory(rng(7), 22);
    const request: OptimizeRequest = {
      costBudget: 12,
      sonataLock: { mode: 'none' },
      objective: {
        kind: 'expected-damage',
        skillId: liberation.id,
        motionName: 'Lance of Qingloong Stage 1 DMG',
        forteLevel: 10,
        crit: 'expected',
      },
      topN: 5,
    };
    const subject: SearchData = { ...data, echoes: inventory, sonataSets: allSets };
    const fast = searchExhaustive(subject, request);
    const reference = searchReference(subject, request);
    expect(observable(fast, true)).toEqual(observable(reference, true));
    expect(fast.scored).toBeLessThan(fast.evaluated / 4);
  });
});

describe('selectCandidates', () => {
  const pool: OwnedEcho[] = [
    { ...mkEcho('free', { main: ['atk', 1], cost: 1 }), level: 0 },
    { ...mkEcho('mine', { main: ['atk', 1], cost: 1 }), level: 25, equippedTo: 'jiyan' },
    { ...mkEcho('theirs', { main: ['atk', 1], cost: 1 }), level: 20, equippedTo: 'verina' },
  ];

  it('keeps every echo by default', () => {
    expect(selectCandidates(pool, 'jiyan').map((e) => e.id)).toEqual(['free', 'mine', 'theirs']);
  });

  it('drops echoes equipped on other characters, keeping this one\'s and unequipped', () => {
    expect(selectCandidates(pool, 'jiyan', { excludeEquippedElsewhere: true }).map((e) => e.id)).toEqual([
      'free',
      'mine',
    ]);
  });

  it('drops echoes below the minimum level (inclusive bound)', () => {
    expect(selectCandidates(pool, 'jiyan', { minLevel: 20 }).map((e) => e.id)).toEqual(['mine', 'theirs']);
  });
});
