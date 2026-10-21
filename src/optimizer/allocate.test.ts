import { describe, expect, it, vi } from 'vitest';
import { loadBundledSnapshot } from '../data/index.ts';
import type { ObjectiveSpec, OwnedEcho, RosterEntry, StatKey } from '../data/schema.ts';
import { standardMob } from '../domain/damage.ts';
import {
  ALLOCATION_COST_BUDGET,
  AllocationAborted,
  isAllocationAborted,
  planKey,
  runAllocation,
  type AllocationMember,
  type AllocationPlan,
  type AllocationProgress,
  type RunFn,
} from './allocate.ts';
import { searchExhaustive, searchReference, selectCandidates, type OptimizeRequest, type SearchData } from './search.ts';

const snapshot = loadBundledSnapshot();
const sonataSets = snapshot.sonataSets.filter((s) => s.id === 'sierra-gale');
const weapon = snapshot.weapons.find((w) => w.id === 'verdant-summit')!;

function member(characterId: string, stat: StatKey): AllocationMember {
  const character = snapshot.characters.find((c) => c.id === characterId)!;
  const roster: RosterEntry = {
    characterId,
    level: 90,
    ascension: 6,
    resonanceChain: 0,
    forteLevels: {},
    weaponId: weapon.id,
    weaponLevel: 90,
    weaponRank: 1,
  };
  return {
    characterId,
    objective: { kind: 'max-stat', stat },
    context: { character, weapon, roster, sonataSets, enemy: standardMob(90) },
  };
}

function mkEcho(id: string, subs: [StatKey, number][], extra: Partial<OwnedEcho> = {}): OwnedEcho {
  return {
    id,
    label: id,
    echoDefId: `${id}-def`,
    sonataId: 'sierra-gale',
    cost: 1,
    level: 25,
    rarity: 5,
    mainStat: { stat: 'hp', value: 0 },
    substats: subs.map(([stat, value]) => ({ stat, value })),
    equippedTo: null,
    origin: 'manual',
    ...extra,
  };
}

/** Runs the real exact search inline, like a one-worker `runOptimization`. */
const inlineRun: RunFn = (data, request) => {
  let progress: ((evaluated: number, total: number) => void) | null = null;
  const promise = Promise.resolve().then(() =>
    searchExhaustive(data, request, (u) => progress?.(u.evaluated, u.total)),
  );
  return { promise, cancel: () => undefined, onProgress: (cb) => (progress = cb) };
};

const atkRanked = Array.from({ length: 12 }, (_, i) => mkEcho(`x${i + 1}`, [['atk', 10 * (i + 1)]]));
const request = (objective: ObjectiveSpec): OptimizeRequest => ({
  costBudget: 12,
  sonataLock: { mode: 'none' },
  objective,
  topN: 1,
  prune: false,
});

describe('runAllocation', () => {
  it('gives each member the best set from what earlier members left (hand-computed)', async () => {
    const plan: AllocationPlan = {
      members: [member('jiyan', 'atk'), member('verina', 'atk')],
      echoes: atkRanked,
      minLevel: 0,
      dataStamp: 'test',
    };
    const { members } = await runAllocation(plan, { run: inlineRun });
    // Flat ATK is additive: A takes the five largest (x8..x12), B the next five (x3..x7).
    expect(members[0].best?.echoIds).toEqual(['x10', 'x11', 'x12', 'x8', 'x9']);
    expect(members[0].pool).toBe(12);
    expect(members[1].best?.echoIds).toEqual(['x3', 'x4', 'x5', 'x6', 'x7']);
    expect(members[1].pool).toBe(7);
    const taken = members.flatMap((m) => m.best?.echoIds ?? []);
    expect(new Set(taken).size).toBe(taken.length);
  });

  it('each step equals the brute-force reference on the pool left for it', async () => {
    const tangled = [
      mkEcho('a', [['atk', 50], ['critRate', 0.01]]),
      mkEcho('b', [['atk', 40], ['critRate', 0.03]]),
      mkEcho('c', [['atk', 30], ['critRate', 0.05]]),
      mkEcho('d', [['atk', 20], ['critRate', 0.02]]),
      mkEcho('e', [['atk', 10], ['critRate', 0.04]]),
      mkEcho('f', [['atk', 45], ['critRate', 0.00]]),
      mkEcho('g', [['atk', 5], ['critRate', 0.06]]),
      mkEcho('h', [['atk', 25], ['critRate', 0.02]]),
      mkEcho('i', [['atk', 35], ['critRate', 0.01]]),
      mkEcho('j', [['atk', 15], ['critRate', 0.03]]),
      mkEcho('k', [['atk', 1], ['critRate', 0.07]]),
    ];
    const plan: AllocationPlan = {
      members: [member('jiyan', 'atk'), member('verina', 'critRate')],
      echoes: tangled,
      minLevel: 0,
      dataStamp: 'test',
    };
    const { members } = await runAllocation(plan, { run: inlineRun });
    const first = members[0].best!;
    const refFirst = searchReference({ ...plan.members[0].context, echoes: tangled }, request(plan.members[0].objective));
    expect(first.echoIds).toEqual(refFirst.builds[0].echoIds);
    expect(first.score).toBe(refFirst.builds[0].score);

    const left = tangled.filter((e) => !first.echoIds.includes(e.id));
    const refSecond = searchReference({ ...plan.members[1].context, echoes: left }, request(plan.members[1].objective));
    expect(members[1].best!.echoIds).toEqual(refSecond.builds[0].echoIds);
    expect(members[1].best!.score).toBe(refSecond.builds[0].score);
  });

  it('is greedy: priority order changes the total, and the first pick can cost the team', async () => {
    // t: great for both; a: A only (slightly worse than t); b: B's poor fallback.
    const echoes = [
      ...Array.from({ length: 5 }, (_, i) => mkEcho(`t${i}`, [['critRate', 0.02], ['critDmg', 0.018]])),
      ...Array.from({ length: 5 }, (_, i) => mkEcho(`a${i}`, [['critRate', 0.019]])),
      ...Array.from({ length: 5 }, (_, i) => mkEcho(`b${i}`, [['critDmg', 0.001]])),
    ];
    const A = member('jiyan', 'critRate');
    const B = member('verina', 'critDmg');
    const aFirst = await runAllocation({ members: [A, B], echoes, minLevel: 0, dataStamp: 'test' }, { run: inlineRun });
    const bFirst = await runAllocation({ members: [B, A], echoes, minLevel: 0, dataStamp: 'test' }, { run: inlineRun });
    const ids = (m: { best: { echoIds: string[] } | null }): string[] => m.best!.echoIds;

    expect(ids(aFirst.members[0]).every((id) => id.startsWith('t'))).toBe(true);
    expect(ids(aFirst.members[1]).every((id) => id.startsWith('b'))).toBe(true);
    expect(ids(bFirst.members[0]).every((id) => id.startsWith('t'))).toBe(true);
    expect(ids(bFirst.members[1]).every((id) => id.startsWith('a'))).toBe(true);

    const total = (r: typeof aFirst): number => r.members.reduce((sum, m) => sum + (m.best!.score), 0);
    // Same bases either way, so compare the stat gains: A-first = 0.10 + 0.005, B-first = 0.09 + 0.095.
    expect(total(bFirst)).toBeGreaterThan(total(aFirst));
  });

  it('ignores equippedTo, keeps locked Echoes in the pool, and honours the minimum level', async () => {
    const echoes = atkRanked.map((e) => {
      if (e.id === 'x12') return { ...e, equippedTo: 'somebody-else', locked: true as const };
      if (e.id === 'x11') return { ...e, level: 5 };
      return e;
    });
    const { members } = await runAllocation(
      { members: [member('jiyan', 'atk')], echoes, minLevel: 10, dataStamp: 'test' },
      { run: inlineRun },
    );
    expect(members[0].pool).toBe(11);
    expect(members[0].best?.echoIds).toEqual(['x10', 'x12', 'x7', 'x8', 'x9']);
  });

  it('gives a member with no legal build nothing, and says how big its pool was', async () => {
    // Five 4-costs (atk 10) and five 1-costs (atk 1). The best legal combo is two 4-costs + three
    // 1-costs (4+4+1+1+1 = 11). What is left, three 4-costs + two 1-costs, costs 14 > 12: no legal build.
    const echoes = [
      ...Array.from({ length: 5 }, (_, i) => mkEcho(`big${i}`, [['atk', 10]], { cost: 4 })),
      ...Array.from({ length: 5 }, (_, i) => mkEcho(`s${i}`, [['atk', 1]])),
    ];
    const { members } = await runAllocation(
      { members: [member('jiyan', 'atk'), member('verina', 'atk')], echoes, minLevel: 0, dataStamp: 'test' },
      { run: inlineRun },
    );
    expect(members[0].best?.echoIds.filter((id) => id.startsWith('big'))).toHaveLength(2);
    expect(members[0].best?.echoIds.filter((id) => id.startsWith('s'))).toHaveLength(3);
    expect(members[1]).toMatchObject({ best: null, pool: 5 });
  });

  it('skips the search when fewer than 5 Echoes remain, and when none are legal', async () => {
    const run = vi.fn(inlineRun);
    const four = atkRanked.slice(0, 4);
    const r = await runAllocation({ members: [member('jiyan', 'atk')], echoes: four, minLevel: 0, dataStamp: 'test' }, { run });
    expect(r.members[0]).toMatchObject({ best: null, pool: 4 });
    expect(run).not.toHaveBeenCalled();

    const illegal = Array.from({ length: 5 }, (_, i) => mkEcho(`big${i}`, [['atk', 10]], { cost: 4 }));
    const r2 = await runAllocation({ members: [member('jiyan', 'atk')], echoes: illegal, minLevel: 0, dataStamp: 'test' }, { run: inlineRun });
    expect(r2.members[0]).toMatchObject({ best: null, pool: 5 });
  });

  it('is deterministic', async () => {
    const plan: AllocationPlan = {
      members: [member('jiyan', 'atk'), member('verina', 'atk')],
      echoes: atkRanked,
      minLevel: 0,
      dataStamp: 'test',
    };
    const one = await runAllocation(plan, { run: inlineRun });
    const two = await runAllocation(plan, { run: inlineRun });
    expect(two).toEqual(one);
  });

  it('reports progress per phase and member', async () => {
    const seen: AllocationProgress[] = [];
    const equipped = atkRanked.slice(0, 5).map((e) => ({ ...e, equippedTo: 'jiyan' }));
    const plan: AllocationPlan = {
      members: [member('jiyan', 'atk'), member('verina', 'atk')],
      echoes: [...equipped, ...atkRanked.slice(5)],
      minLevel: 0,
      dataStamp: 'test',
    };
    await runAllocation(plan, { run: inlineRun, onProgress: (p) => seen.push(p) });
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen.map((p) => `${p.phase}:${p.index}:${p.characterId}`))).toEqual(
      new Set(['baseline:0:jiyan', 'search:0:jiyan', 'search:1:verina']),
    );
    expect(seen.every((p) => p.count === 2 && p.total >= p.evaluated)).toBe(true);
  });

  describe('baseline (your equipped Echoes, best slot-1 order)', () => {
    it('accepts a pool of exactly the five equipped Echoes', () => {
      const m = member('jiyan', 'atk');
      const five = atkRanked.slice(0, 5);
      const result = searchExhaustive({ ...m.context, echoes: five }, request(m.objective));
      expect(result.builds).toHaveLength(1);
      expect(result.evaluated).toBe(1);
      expect(result.builds[0].echoIds).toEqual(five.map((e) => e.id).sort());
    });

    it('scores the equipped five with the same search, and competes with the allocation', async () => {
      const equipped = atkRanked.slice(0, 5).map((e) => ({ ...e, equippedTo: 'jiyan' }));
      const rest = atkRanked.slice(5);
      const plan: AllocationPlan = { members: [member('jiyan', 'atk')], echoes: [...equipped, ...rest], minLevel: 0, dataStamp: 'test' };
      const { members } = await runAllocation(plan, { run: inlineRun });
      const ref = searchReference({ ...plan.members[0].context, echoes: equipped }, request(plan.members[0].objective));
      expect(members[0].baseline?.score).toBe(ref.builds[0].score);
      expect(members[0].baseline?.echoIds).toEqual(equipped.map((e) => e.id).sort());
      expect(members[0].baselineNote).toBeNull();
      // Better Echoes exist in the box, so the allocation beats the baseline.
      expect(members[0].best!.score).toBeGreaterThan(members[0].baseline!.score);
    });

    it('has no baseline with fewer or more than 5 equipped, or when they are not cost-legal', async () => {
      const mk = (n: number, cost: 1 | 4 = 1): OwnedEcho[] =>
        Array.from({ length: n }, (_, i) => mkEcho(`q${cost}${i}`, [['atk', 1]], { cost, equippedTo: 'jiyan' }));
      const filler = atkRanked;
      const base = async (equipped: OwnedEcho[]) =>
        (await runAllocation({ members: [member('jiyan', 'atk')], echoes: [...equipped, ...filler], minLevel: 0, dataStamp: 'test' }, { run: inlineRun }))
          .members[0];
      expect(await base(mk(3))).toMatchObject({ baseline: null, baselineNote: '3 of 5 Echoes equipped' });
      expect(await base(mk(6))).toMatchObject({ baseline: null, baselineNote: expect.stringContaining('6 Echoes') });
      expect(await base(mk(5, 4))).toMatchObject({ baseline: null, baselineNote: expect.stringContaining('not a legal build') });
    });

    it('ignores the minimum level (it is what you have equipped)', async () => {
      const equipped = atkRanked.slice(0, 5).map((e) => ({ ...e, level: 0, equippedTo: 'jiyan' }));
      const { members } = await runAllocation(
        { members: [member('jiyan', 'atk')], echoes: [...equipped, ...atkRanked.slice(5)], minLevel: 25, dataStamp: 'test' },
        { run: inlineRun },
      );
      expect(members[0].baseline).not.toBeNull();
      expect(members[0].pool).toBe(7);
    });
  });

  describe('minimum stats (the source build\'s)', () => {
    // Five strong ATK Echoes with no Energy Regen; five weak ones that carry it.
    const strong = Array.from({ length: 5 }, (_, i) => mkEcho(`s${i}`, [['atk', 100]]));
    const regen = Array.from({ length: 5 }, (_, i) => mkEcho(`r${i}`, [['atk', 10], ['energyRegen', 0.05]]));
    const withMin = (): AllocationMember => ({ ...member('jiyan', 'atk'), minStats: { energyRegen: 0.2 } });
    const plan = (m: AllocationMember, equippedStrong = false): AllocationPlan => ({
      members: [m],
      echoes: [...strong.map((e) => ({ ...e, equippedTo: equippedStrong ? 'jiyan' : null })), ...regen],
      minLevel: 0,
      dataStamp: 'test',
    });

    it('searches under the minimum: it needs four regen Echoes (4 x 5% = 20%), and without it the strong ones win', async () => {
      const free = (await runAllocation(plan(member('jiyan', 'atk')), { run: inlineRun })).members[0];
      expect(free.best?.echoIds).toEqual(['s0', 's1', 's2', 's3', 's4']);
      const bound = (await runAllocation(plan(withMin()), { run: inlineRun })).members[0];
      // Four regen Echoes reach 20%; the fifth slot goes to a strong Echo (ties keep the first).
      expect(bound.best?.echoIds).toEqual(['r0', 'r1', 'r2', 'r3', 's0']);
      expect(bound.best?.sheet.energyRegen).toBeGreaterThanOrEqual(0.2);
    });

    it('sends the minimum in the baseline request and every step, and nothing when there is none', async () => {
      const seen: (OptimizeRequest['minStats'] | 'absent')[] = [];
      const run: RunFn = (data, req) => {
        seen.push('minStats' in req ? req.minStats : 'absent');
        return inlineRun(data, req);
      };
      await runAllocation(plan(withMin(), true), { run });
      expect(seen).toEqual([{ energyRegen: 0.2 }, { energyRegen: 0.2 }]); // baseline, then the search
      seen.length = 0;
      await runAllocation(plan({ ...member('jiyan', 'atk'), minStats: { energyRegen: 0, critRate: -1 } }, true), { run });
      expect(seen).toEqual(['absent', 'absent']); // zero or negative is no minimum
    });

    it('scores the baseline under the same minimum: equipped Echoes below it are no baseline', async () => {
      const free = (await runAllocation(plan(member('jiyan', 'atk'), true), { run: inlineRun })).members[0];
      expect(free.baseline).not.toBeNull();
      const bound = (await runAllocation(plan(withMin(), true), { run: inlineRun })).members[0];
      expect(bound).toMatchObject({ baseline: null, baselineNote: expect.stringContaining("below the build's minimum stats") });
      // With no minimum the note never mentions one.
      const tooCostly = (await runAllocation(
        { ...plan(member('jiyan', 'atk')), costBudget: 10, echoes: strong.map((e) => ({ ...e, cost: 4 as const, equippedTo: 'jiyan' })) },
        { run: inlineRun },
      )).members[0];
      expect(tooCostly.baselineNote).not.toContain('minimum');
    });

    it('says so when no combination can meet the minimum', async () => {
      const impossible: AllocationMember = { ...member('jiyan', 'atk'), minStats: { energyRegen: 5 } };
      const { members } = await runAllocation(plan(impossible), { run: inlineRun });
      expect(members[0].best).toBeNull();
    });
  });

  describe('cost budget', () => {
    // 4 + 3 + 3 + 1 + 1 = 12: legal under 12, over a budget of 10.
    const costs: (1 | 3 | 4)[] = [4, 3, 3, 1, 1];
    const equipped = costs.map((cost, i) => mkEcho(`c${i}`, [['atk', 100]], { cost, equippedTo: 'jiyan' }));
    const plan = (costBudget?: 10 | 12): AllocationPlan => ({
      members: [member('jiyan', 'atk'), member('verina', 'atk')],
      echoes: [...equipped, ...atkRanked],
      minLevel: 0,
      dataStamp: 'test',
      ...(costBudget === undefined ? {} : { costBudget }),
    });

    it('defaults to 12 and sends the chosen budget to every step, baseline included', async () => {
      expect(ALLOCATION_COST_BUDGET).toBe(12);
      for (const [budget, expected] of [[undefined, 12], [12, 12], [10, 10]] as const) {
        const seen: number[] = [];
        const run: RunFn = (data, req) => {
          seen.push(req.costBudget);
          return inlineRun(data, req);
        };
        await runAllocation(plan(budget), { run });
        expect(seen).toEqual([expected, expected, expected]); // jiyan's baseline, then both searches
      }
    });

    it('judges the baseline legal under 12 and over budget under 10', async () => {
      const at12 = (await runAllocation(plan(12), { run: inlineRun })).members[0];
      expect(at12.baseline?.echoIds).toEqual(['c0', 'c1', 'c2', 'c3', 'c4']);
      const at10 = (await runAllocation(plan(10), { run: inlineRun })).members[0];
      expect(at10).toMatchObject({ baseline: null, baselineNote: expect.stringContaining('over the 10 cost budget') });
    });

    it('keeps every pick within the budget', async () => {
      const { members } = await runAllocation(plan(10), { run: inlineRun });
      const byId = new Map([...equipped, ...atkRanked].map((e) => [e.id, e]));
      for (const m of members) {
        const total = m.best!.echoIds.reduce((sum, id) => sum + byId.get(id)!.cost, 0);
        expect(total).toBeLessThanOrEqual(10);
      }
    });
  });

  describe('cancellation', () => {
    function hangingRun() {
      const cancel = vi.fn();
      const run = vi.fn<RunFn>(() => ({ promise: new Promise(() => undefined), cancel, onProgress: () => undefined }));
      return { run, cancel };
    }

    it('rejects with an abort and cancels the running handle, even though cancel never settles it', async () => {
      const { run, cancel } = hangingRun();
      const controller = new AbortController();
      const promise = runAllocation(
        { members: [member('jiyan', 'atk'), member('verina', 'atk')], echoes: atkRanked, minLevel: 0, dataStamp: 'test' },
        { run, signal: controller.signal },
      );
      await Promise.resolve();
      controller.abort();
      await expect(promise).rejects.toBeInstanceOf(AllocationAborted);
      await expect(promise).rejects.toSatisfy(isAllocationAborted);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenCalledTimes(1); // the second member never started
    });

    it('does not start anything when already aborted', async () => {
      const { run } = hangingRun();
      const controller = new AbortController();
      controller.abort();
      await expect(
        runAllocation({ members: [member('jiyan', 'atk')], echoes: atkRanked, minLevel: 0, dataStamp: 'test' }, { run, signal: controller.signal }),
      ).rejects.toBeInstanceOf(AllocationAborted);
      expect(run).not.toHaveBeenCalled();
    });

    it('stops between steps', async () => {
      const controller = new AbortController();
      const run = vi.fn<RunFn>((data, req) => {
        const handle = inlineRun(data, req);
        controller.abort(); // abort while the first step is resolving
        return handle;
      });
      await expect(
        runAllocation(
          { members: [member('jiyan', 'atk'), member('verina', 'atk')], echoes: atkRanked, minLevel: 0, dataStamp: 'test' },
          { run, signal: controller.signal },
        ),
      ).rejects.toBeInstanceOf(AllocationAborted);
      expect(run).toHaveBeenCalledTimes(1);
    });
  });

  it('names the member when a step fails', async () => {
    const run: RunFn = () => ({
      promise: Promise.reject(new Error('boom')),
      cancel: () => undefined,
      onProgress: () => undefined,
    });
    await expect(
      runAllocation({ members: [member('verina', 'atk')], echoes: atkRanked, minLevel: 0, dataStamp: 'test' }, { run }),
    ).rejects.toThrow('verina: boom');
  });
});

describe('planKey', () => {
  const base: AllocationPlan = {
    members: [member('jiyan', 'atk')],
    echoes: atkRanked,
    minLevel: 0,
    dataStamp: '4@2026-10-21T00:00:00.000Z',
  };
  const key = planKey(base);
  const withFirst = (patch: Partial<OwnedEcho>): AllocationPlan => ({
    ...base,
    echoes: [{ ...atkRanked[0], ...patch }, ...atkRanked.slice(1)],
  });

  it('changes with order, pool, objective, enemy, weapon and minimum level', () => {
    const two = { ...base, members: [member('jiyan', 'atk'), member('verina', 'atk')] };
    expect(planKey({ ...two, members: [...two.members].reverse() })).not.toBe(planKey(two));
    expect(planKey({ ...base, minLevel: 3 })).not.toBe(key);
    expect(planKey({ ...base, echoes: atkRanked.slice(1) })).not.toBe(key);
    expect(planKey({ ...base, members: [member('jiyan', 'critRate')] })).not.toBe(key);
    const m = member('jiyan', 'atk');
    expect(planKey({ ...base, members: [{ ...m, context: { ...m.context, enemy: standardMob(80) } }] })).not.toBe(key);
    expect(planKey({ ...base })).toBe(key);
  });

  it("changes with a member's minimum stats (empty, zero and absent are the same)", () => {
    const m = member('jiyan', 'atk');
    const withMin = (minStats: AllocationMember['minStats']): AllocationPlan => ({ ...base, members: [{ ...m, minStats }] });
    expect(planKey(withMin({ energyRegen: 0.2 }))).not.toBe(key);
    expect(planKey(withMin({ energyRegen: 0.2 }))).not.toBe(planKey(withMin({ energyRegen: 0.25 })));
    expect(planKey(withMin({ energyRegen: 0.2, critRate: 0.6 }))).toBe(planKey(withMin({ critRate: 0.6, energyRegen: 0.2 })));
    expect(planKey(withMin({}))).toBe(key);
    expect(planKey(withMin({ energyRegen: 0 }))).toBe(key);
    expect(planKey(withMin(undefined))).toBe(key);
  });

  it('changes with the cost budget (absent means the default 12)', () => {
    expect(planKey({ ...base, costBudget: 10 })).not.toBe(key);
    expect(planKey({ ...base, costBudget: 12 })).toBe(key);
  });

  it("changes with a member's Resonance Mode", () => {
    const m = member('jiyan', 'atk');
    const withMode = (resonanceMode: 'fusionBurst' | 'tuneStrain'): AllocationPlan => ({
      ...base,
      members: [{ ...m, context: { ...m.context, resonanceMode } }],
    });
    expect(planKey(withMode('fusionBurst'))).not.toBe(key);
    expect(planKey(withMode('fusionBurst'))).not.toBe(planKey(withMode('tuneStrain')));
    expect(planKey(withMode('tuneStrain'))).toBe(planKey(withMode('tuneStrain')));
  });

  it('changes with any Echo field that a search reads', () => {
    expect(planKey(withFirst({ level: 3 }))).not.toBe(key);
    expect(planKey(withFirst({ equippedTo: 'jiyan' }))).not.toBe(key);
    expect(planKey(withFirst({ substats: [{ stat: 'atk', value: 11 }] }))).not.toBe(key);
    expect(planKey(withFirst({ substats: [...atkRanked[0].substats, { stat: 'critRate', value: 0.01 }] }))).not.toBe(key);
    expect(planKey(withFirst({ mainStat: { stat: 'hp', value: 1 } }))).not.toBe(key);
    expect(planKey(withFirst({ secondMainStat: { stat: 'atk', value: 100 } }))).not.toBe(key);
    expect(planKey(withFirst({ cost: 3 }))).not.toBe(key);
    expect(planKey(withFirst({ sonataId: 'rejuvenating-glow' }))).not.toBe(key);
    expect(planKey(withFirst({ echoDefId: 'other-def' }))).not.toBe(key);
    expect(planKey(withFirst({ rarity: 4 }))).not.toBe(key);
  });

  it('ignores locks and origin, which never reach a search', () => {
    expect(planKey(withFirst({ locked: true }))).toBe(key);
    expect(planKey(withFirst({ origin: 'import:kamera' }))).toBe(key);
  });

  it('ignores key order, so a reloaded row with the same data keeps the same key', () => {
    const { id, ...rest } = atkRanked[0];
    const reordered = { ...Object.fromEntries(Object.entries(rest).reverse()), id } as OwnedEcho;
    expect(planKey({ ...base, echoes: [reordered, ...atkRanked.slice(1)] })).toBe(key);
  });

  it('changes with the game data identity', () => {
    expect(planKey({ ...base, dataStamp: '4@2026-10-28T00:00:00.000Z' })).not.toBe(key);
  });
});

// Sanity: the helper pool selection the allocator relies on.
describe('selectCandidates (as used by the allocator)', () => {
  it('keeps equipped-elsewhere Echoes unless asked', () => {
    const data: SearchData = { ...member('jiyan', 'atk').context, echoes: [] };
    expect(data.echoes).toEqual([]);
    const e = [{ ...atkRanked[0], equippedTo: 'other' }];
    expect(selectCandidates(e, 'jiyan', { minLevel: 0 })).toHaveLength(1);
    expect(selectCandidates(e, 'jiyan', { excludeEquippedElsewhere: true })).toHaveLength(0);
  });
});
