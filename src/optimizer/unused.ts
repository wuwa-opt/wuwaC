import type { Build, CharacterData, OwnedEcho } from '../data/schema.ts';
import { pruneDominated, pruneInputs, type PruneInputs } from './prune.ts';
import { selectCandidates } from './search.ts';

/**
 * Optimizer layer: which owned Echoes are unused, and which of those are
 * safe fodder. Derived on demand, never stored. Pure functions.
 *
 * - **Unused**: not equipped (`equippedTo === null`) and in no saved
 *   library build's `echoIds`. Reference builds (saved share links) hold
 *   placeholder ids and are skipped.
 * - **Safe fodder** (a subset of unused): at least one saved
 *   non-reference build carries a full `objective`, and for EVERY such
 *   build `pruneDominated` drops the Echo, with that build's character and
 *   objective, `topN: 1`, `costBudget: 12` and the character's main-slot
 *   carriers, from BOTH candidate pools that run can search at minimum
 *   level 0: the whole inventory, and the inventory without Echoes
 *   equipped on another character (`selectCandidates` with
 *   `excludeEquippedElsewhere`). Pruning isn't monotone in the pool (the
 *   counted dominators may be equipped elsewhere), so each pool is checked
 *   on its own. Budget 12 is the conservative one:
 *   it needs at least as many dominators as budget 10. So for every saved
 *   build with an objective, the optimizer finds an equally good best
 *   result without this Echo.
 *
 * A locked Echo (`locked`) is never fodder: it stays `unused` with reason
 * `locked`, but still sits in the pool, so other Echoes' verdicts don't change.
 *
 * Limits, on purpose:
 * - Top-1 only: a top-N run (N > 1) may still rank a combo holding it.
 * - Only the saved builds' objectives: any other objective, character or
 *   minimum (builds don't store `minStats`) may still want it.
 * - Minimum level 0 only: a run with `minLevel > 0` searches a smaller
 *   pool, where the dominators may be missing (below that level).
 * Builds without an `objective` count for membership only. A build whose
 * character or objective skill no longer resolves in the snapshot can't be
 * checked, so while one exists nothing is fodder.
 */

export type EchoUsageStatus = 'in-use' | 'unused' | 'fodder';

export type EchoUsageReason =
  /** in-use: `equippedTo` is set. */
  | 'equipped'
  /** in-use: listed in a saved library build. */
  | 'in-build'
  /** unused: locked by the user, so never fodder (it still counts in the pruning pool). */
  | 'locked'
  /** unused: no saved build carries an objective to check against. */
  | 'no-objective-builds'
  /** unused: a saved build's objective can't be checked against current game data. */
  | 'unchecked-build'
  /** unused: at least one objective build keeps it (see `keptBy`). */
  | 'kept'
  /** fodder: every objective build drops it. */
  | 'dominated';

export interface EchoUsage {
  status: EchoUsageStatus;
  reason: EchoUsageReason;
  /** Objective builds the Echo was checked against (0 for in-use Echoes). */
  buildsChecked: number;
  /** First objective build (id) whose pruning keeps the Echo, for reason `kept`. */
  keptBy?: string;
}

export interface UnusedEchoInput {
  echoes: readonly OwnedEcho[];
  builds: readonly Build[];
  /** Snapshot characters; looked up by each build's `characterId`. */
  characters: readonly CharacterData[];
}

/** Echo id -> usage verdict, for every Echo in `input.echoes`. */
export function findUnusedEchoes(input: UnusedEchoInput): Map<string, EchoUsage> {
  // Mirrors `isReferenceBuild` (state/share.ts), which this layer can't import.
  const ownBuilds = input.builds.filter((b) => b.reference === undefined);
  const inBuild = new Set(ownBuilds.flatMap((b) => b.echoIds));
  const objectiveBuilds = ownBuilds.filter((b) => b.objective !== undefined);

  const pool = [...input.echoes];
  const drops = objectiveBuilds.map((build) => ({ buildId: build.id, pruned: droppedBy(build, pool, input.characters) }));
  const unchecked = drops.some((d) => d.pruned === null);
  const buildsChecked = drops.filter((d) => d.pruned !== null).length;

  const verdicts = new Map<string, EchoUsage>();
  for (const echo of input.echoes) {
    if (echo.equippedTo !== null) {
      verdicts.set(echo.id, { status: 'in-use', reason: 'equipped', buildsChecked: 0 });
    } else if (inBuild.has(echo.id)) {
      verdicts.set(echo.id, { status: 'in-use', reason: 'in-build', buildsChecked: 0 });
    } else if (echo.locked) {
      verdicts.set(echo.id, { status: 'unused', reason: 'locked', buildsChecked });
    } else if (objectiveBuilds.length === 0) {
      verdicts.set(echo.id, { status: 'unused', reason: 'no-objective-builds', buildsChecked: 0 });
    } else {
      const keeper = drops.find((d) => d.pruned !== null && !d.pruned.has(echo.id));
      if (keeper !== undefined) {
        verdicts.set(echo.id, { status: 'unused', reason: 'kept', buildsChecked, keptBy: keeper.buildId });
      } else if (unchecked) {
        verdicts.set(echo.id, { status: 'unused', reason: 'unchecked-build', buildsChecked });
      } else {
        verdicts.set(echo.id, { status: 'fodder', reason: 'dominated', buildsChecked });
      }
    }
  }
  return verdicts;
}

/**
 * Ids `build`'s objective prunes from both `pool` and `pool` without Echoes
 * equipped elsewhere, or null when it can't be checked.
 */
function droppedBy(build: Build, pool: OwnedEcho[], characters: readonly CharacterData[]): Set<string> | null {
  const character = characters.find((c) => c.id === build.characterId);
  if (character === undefined || build.objective === undefined) return null;
  let inputs: PruneInputs;
  try {
    inputs = pruneInputs(character, build.objective);
  } catch {
    return null; // e.g. the objective's skill is gone from the snapshot
  }
  const options = { costBudget: 12, topN: 1, isMainCarrier: inputs.isMainCarrier };
  const whole = new Set(pruneDominated(pool, inputs.relevantStats, options).pruned);
  const own = selectCandidates(pool, build.characterId, { excludeEquippedElsewhere: true });
  return new Set(pruneDominated(own, inputs.relevantStats, options).pruned.filter((id) => whole.has(id)));
}
