import type { ObjectiveSpec, OwnedEcho } from '../data/schema.ts';
import { effectiveMinStats, type MinStats } from './minStats.ts';
import { selectCandidates, type OptimizeRequest, type RankedBuild, type SearchData, type SearchResult } from './search.ts';
import { runOptimization, type OptimizationHandle } from './worker.ts';

/**
 * Optimizer layer: team-wide Echo allocation.
 *
 * Greedy, NOT a joint optimum. Members are searched one at a time in
 * priority order with the existing exact search; each member searches the
 * pool minus the Echoes earlier members took. Every step is exactly optimal
 * given the earlier picks, but a different priority order can give a better
 * total, and nothing here claims otherwise.
 *
 * - The pool ignores `equippedTo` (re-allocating is the point) and honours
 *   `minLevel`. Locked Echoes stay in the pool (lock protects from deletion
 *   only).
 * - Each member also gets a baseline: the best score of the Echoes marked
 *   equipped to them (exactly 5 and cost-legal), found by running the same
 *   search over a pool of just those Echoes. The search picks the main
 *   (slot-1) Echo, hence "best slot-1 order".
 * - One cost budget (`ALLOCATION_COST_BUDGET`, 12) for every step and for
 *   the baseline's legality; no Sonata lock, top 1. A member's
 *   minimum stats (the source build's `minStats`) apply to every step AND to
 *   its baseline, so both are scored under the same rules.
 * - Pure plumbing: all scoring comes from `search.ts`; `run` is injectable
 *   (defaults to `runOptimization`) so tests need no real Worker.
 */

/**
 * The cost budget every allocation step and baseline uses. 12 is a cap, not a
 * layout: the search takes every layout up to it, so a lower cap never scores
 * higher.
 */
export const ALLOCATION_COST_BUDGET = 12;

export interface AllocationMember {
  characterId: string;
  /** Everything a run needs except the pool, which is filled per step. */
  context: Omit<SearchData, 'echoes'>;
  objective: ObjectiveSpec;
  /** Sheet minimums from the source build; absent = none. Passed as `OptimizeRequest.minStats`. */
  minStats?: MinStats;
}

export interface AllocationPlan {
  /** Priority order: index 0 picks first. */
  members: readonly AllocationMember[];
  /** The whole inventory (equipped or not). */
  echoes: readonly OwnedEcho[];
  /** Drop Echoes below this level (0–25) from the allocation pools. */
  minLevel: number;
  /**
   * Identity of the game data the members were resolved from (snapshot
   * version and fetch time). Only used by `planKey`: characters, weapons and
   * sets feed every run, so a data update must invalidate a preview.
   */
  dataStamp: string;
}

export interface MemberAllocation {
  characterId: string;
  /** Echoes this member's search could choose from. */
  pool: number;
  /** Best build from the remaining pool, or null when none is legal. */
  best: RankedBuild | null;
  /** Best slot-1 order of the Echoes equipped now; null = no baseline (see `baselineNote`). */
  baseline: RankedBuild | null;
  baselineNote: string | null;
}

export interface AllocationResult {
  members: MemberAllocation[];
}

export interface AllocationProgress {
  phase: 'baseline' | 'search';
  /** 0-based member index within the phase. */
  index: number;
  count: number;
  characterId: string;
  evaluated: number;
  total: number;
}

export type RunFn = (data: SearchData, request: OptimizeRequest) => OptimizationHandle;

export interface AllocationOptions {
  signal?: AbortSignal;
  onProgress?: (progress: AllocationProgress) => void;
  run?: RunFn;
}

export class AllocationAborted extends Error {
  constructor() {
    super('allocation cancelled');
    this.name = 'AbortError';
  }
}

export function isAllocationAborted(err: unknown): boolean {
  return err instanceof AllocationAborted;
}

/** JSON with object keys sorted, so equal data keys equal however it was built. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)))
      : v,
  );
}

/**
 * Identity of everything that decides an allocation result. If it changes
 * after a run, the preview no longer matches the inputs.
 *
 * Every Echo field counts (id, def, set, cost, level, rarity, main and
 * second main stat, substats, `equippedTo`) except `locked` and `origin`,
 * which never reach a search. Members count by character, objective,
 * context, weapon, enemy, Resonance Mode and minimum stats; the game data behind them by
 * `dataStamp`; plus the minimum level.
 */
export function planKey(plan: AllocationPlan): string {
  return canonical({
    minLevel: plan.minLevel,
    dataStamp: plan.dataStamp,
    echoes: plan.echoes.map((echo) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- deliberately left out of the key
      const { locked, origin, ...searched } = echo;
      return searched;
    }),
    members: plan.members.map((m) => [
      m.characterId,
      m.context.character.id,
      m.objective,
      m.context.roster,
      m.context.weapon.id,
      m.context.enemy,
      m.context.resonanceMode ?? null,
      effectiveMinStats(m.minStats) ?? null,
    ]),
  });
}

/**
 * Run one search. `handle.cancel()` never settles the handle's promise, so
 * an abort races it and rejects on its own.
 */
function runStep(
  run: RunFn,
  data: SearchData,
  request: OptimizeRequest,
  signal: AbortSignal | undefined,
  onProgress: (evaluated: number, total: number) => void,
): Promise<SearchResult> {
  if (signal?.aborted) return Promise.reject(new AllocationAborted());
  const handle = run(data, request);
  handle.onProgress(onProgress);
  return new Promise<SearchResult>((resolve, reject) => {
    const onAbort = (): void => {
      handle.cancel();
      reject(new AllocationAborted());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    handle.promise.then(
      (result) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (err: unknown) => {
        signal?.removeEventListener('abort', onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

function requestFor(member: AllocationMember, prune: boolean): OptimizeRequest {
  const minStats = effectiveMinStats(member.minStats);
  return {
    costBudget: ALLOCATION_COST_BUDGET,
    sonataLock: { mode: 'none' },
    objective: member.objective,
    ...(minStats === undefined ? {} : { minStats }),
    topN: 1,
    // The baseline pool is exactly the equipped Echoes: nothing to prune.
    ...(prune ? {} : { prune: false }),
  };
}

function failure(member: AllocationMember, err: unknown): Error {
  if (isAllocationAborted(err)) return err as Error;
  return new Error(`${member.characterId}: ${err instanceof Error ? err.message : String(err)}`);
}

export async function runAllocation(plan: AllocationPlan, options: AllocationOptions = {}): Promise<AllocationResult> {
  const run = options.run ?? runOptimization;
  const { signal } = options;
  const count = plan.members.length;
  const emit = (phase: AllocationProgress['phase'], index: number, characterId: string) =>
    (evaluated: number, total: number): void =>
      options.onProgress?.({ phase, index, count, characterId, evaluated, total });

  // Baselines first: one tiny exact search per member over its equipped Echoes.
  const baselines: Pick<MemberAllocation, 'baseline' | 'baselineNote'>[] = [];
  for (const [index, member] of plan.members.entries()) {
    const equipped = plan.echoes.filter((e) => e.equippedTo === member.characterId);
    if (equipped.length !== 5) {
      baselines.push({
        baseline: null,
        baselineNote:
          equipped.length < 5
            ? `${equipped.length} of 5 Echoes equipped`
            : `${equipped.length} Echoes are marked equipped (expected 5)`,
      });
      continue;
    }
    const hasMinimums = effectiveMinStats(member.minStats) !== undefined;
    try {
      const result = await runStep(
        run,
        { ...member.context, echoes: equipped },
        requestFor(member, false),
        signal,
        emit('baseline', index, member.characterId),
      );
      baselines.push(
        result.builds[0] === undefined
          ? { baseline: null, baselineNote: `the equipped Echoes are not a legal build (over the ${ALLOCATION_COST_BUDGET} cost budget${hasMinimums ? " or below the build's minimum stats" : ''})` }
          : { baseline: result.builds[0], baselineNote: null },
      );
    } catch (err) {
      throw failure(member, err);
    }
  }

  const taken = new Set<string>();
  const members: MemberAllocation[] = [];
  for (const [index, member] of plan.members.entries()) {
    if (signal?.aborted) throw new AllocationAborted();
    const pool = selectCandidates(plan.echoes, member.characterId, { minLevel: plan.minLevel }).filter(
      (e) => !taken.has(e.id),
    );
    let best: RankedBuild | null = null;
    if (pool.length >= 5) {
      try {
        const result = await runStep(
          run,
          { ...member.context, echoes: pool },
          requestFor(member, true),
          signal,
          emit('search', index, member.characterId),
        );
        best = result.builds[0] ?? null;
      } catch (err) {
        throw failure(member, err);
      }
    }
    if (best !== null) for (const id of best.echoIds) taken.add(id);
    members.push({ characterId: member.characterId, pool: pool.length, best, ...baselines[index] });
  }
  return { members };
}
