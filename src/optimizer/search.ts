import type {
  CharacterData,
  OwnedEcho,
  RosterEntry,
  SonataSetData,
  StatKey,
  WeaponData,
} from '../data/schema.ts';
import type { ResonanceMode } from '../domain/characterMods.ts';
import type { EnemyProfile } from '../domain/damage.ts';
import type { ObjectiveSpec } from '../domain/objectives.ts';
import type { ComputeStatsResult, StatSheet } from '../domain/stats.ts';
import { computeStats, emptySheet, hasMainEchoBonus } from '../domain/stats.ts';
import { scoreSheet } from '../domain/objectives.ts';
import { pruneDominated, pruneInputs } from './prune.ts';

/**
 * Optimizer layer: Echo-combination search (reference doc §7).
 * Pure functions over domain math; hosted off the main thread by worker.ts.
 */

export type SonataLock =
  | { mode: 'none' }
  | { mode: 'five'; setId: string }
  | { mode: 'twoPlusTwo'; setIdA: string; setIdB: string };

/** Optional kit state for expected-damage objectives (same fields as ScoreContext). */
export interface KitStateRequest {
  targetStatusStacks?: number;
  conviction?: number;
  targetHavocBaneStacks?: number;
  blazesConsumed?: number;
  nightfallBlazes?: number;
  ringsConsumed?: number;
  voiceFlux?: boolean;
  wovenMyriad?: boolean;
  sealMaster?: boolean;
  tuneStrainStacks?: number;
}

export interface OptimizeRequest {
  costBudget: 10 | 12;
  sonataLock: SonataLock;
  objective: ObjectiveSpec;
  /**
   * Sheet-level minimums (e.g. critRate >= 0.7). Empty/absent = no filter.
   * Checked per slot-1 choice: a combo qualifies with its best-scoring
   * main Echo among those whose sheet meets every minimum.
   */
  minStats?: Partial<Record<StatKey, number>>;
  topN: number;
  /** Exhaustive baseline can skip pruning (tests, debugging). Default true. */
  prune?: boolean;
  /** Kit state for expected-damage scoring. Absent = zeros = context-free. */
  kitState?: KitStateRequest;
}

export interface SearchData {
  character: CharacterData;
  weapon: WeaponData;
  roster: RosterEntry;
  /** Candidate pool (ownership pre-filtered by the caller). */
  echoes: OwnedEcho[];
  sonataSets: SonataSetData[];
  enemy: EnemyProfile;
  /** Required when the character has Resonance Modes (dual-mode kits). */
  resonanceMode?: ResonanceMode;
}

export interface RankedBuild {
  /** Exactly 5 echo ids, sorted for determinism. */
  echoIds: string[];
  score: number;
  sheet: StatSheet;
  warnings: string[];
  /** Transcribed assumptions applied to the sheet (from computeStats). */
  appliedAssumptions: string[];
  /** Winning slot-1 echo id when a main-slot bonus improved the score. */
  mainEchoId?: string;
}

export interface SearchResult {
  builds: RankedBuild[];
  /**
   * Combos covered: every cost-legal combo of the searched pool (pruned,
   * and narrowed to the locked set for a 5-piece lock), each either scored
   * or proven unable to reach the top N. Equals `total` once the search
   * completes. With no Sonata lock this is the number of legal combos.
   */
  evaluated: number;
  /** Combos whose stats were actually assembled and scored. */
  scored: number;
  /** Cost-legal combos in the searched pool (the progress denominator). */
  total: number;
  /** Candidate ids dropped by dominance pruning. */
  prunedEchoes: string[];
}

export interface ProgressUpdate {
  /** Combos covered so far (reaches `total`). */
  evaluated: number;
  total: number;
}

/** One slice of the search space, for splitting a run across workers. */
export interface SearchShard {
  index: number;
  count: number;
}

/** Which owned echoes enter the search. Defaults keep every echo. */
export interface CandidateFilter {
  /** Drop echoes equipped on a different character (`equippedTo`). */
  excludeEquippedElsewhere?: boolean;
  /** Drop echoes below this level (0–25). */
  minLevel?: number;
}

/** The candidate pool for `characterId` under `filter` (input order kept). */
export function selectCandidates(
  echoes: readonly OwnedEcho[],
  characterId: string,
  filter: CandidateFilter = {},
): OwnedEcho[] {
  const minLevel = filter.minLevel ?? 0;
  return echoes.filter(
    (e) =>
      e.level >= minLevel &&
      !(filter.excludeEquippedElsewhere === true && e.equippedTo !== null && e.equippedTo !== characterId),
  );
}

/**
 * Everything the exact scorer and both search strategies share: request
 * validation, the pruned candidate list, and per-combo exact scoring.
 */
interface Prepared {
  kept: OwnedEcho[];
  pruned: string[];
  minEntries: [StatKey, number][];
  /** Score a sheet with the request's objective and fixed context. */
  score: (sheet: StatSheet) => number;
  /**
   * Exact per-combo scoring through `computeStats` (the definition every
   * strategy must reproduce). `combo` must be in kept order.
   */
  scoreCombo: (combo: OwnedEcho[]) => { build: RankedBuild | null; baseline: StatSheet };
  /** computeStats with explicit echoes/main (used to derive the decomposition). */
  stats: (echoes: OwnedEcho[], mainEcho?: OwnedEcho) => ComputeStatsResult;
}

function prepare(data: SearchData, request: OptimizeRequest): Prepared {
  if (!Number.isInteger(request.topN) || request.topN < 1) {
    throw new Error(`topN must be a positive integer, got ${request.topN}`);
  }
  if (request.costBudget !== 10 && request.costBudget !== 12) {
    throw new Error(`cost budget must be 10 or 12, got ${request.costBudget}`);
  }
  const { character, weapon, roster, enemy } = data;
  const minEntries = Object.entries(request.minStats ?? {}) as [StatKey, number][];
  const { skill, relevantStats, isMainCarrier } = pruneInputs(
    character,
    request.objective,
    minEntries.map(([stat]) => stat),
  );

  const { kept, pruned } = request.prune ?? true
    ? pruneDominated(data.echoes, relevantStats, {
        costBudget: request.costBudget,
        topN: request.topN,
        isMainCarrier,
      })
    : { kept: data.echoes, pruned: [] as string[] };

  const stats = (echoes: OwnedEcho[], mainEcho?: OwnedEcho): ComputeStatsResult =>
    computeStats({ character, weapon, roster, echoes, sonataSets: data.sonataSets, mainEcho });
  // Base ATK/HP/DEF depend only on the roster, never on the echoes.
  const bases = stats([]);
  const scoreContext = {
    skill,
    skills: character.skills,
    characterId: character.id,
    attribute: character.attribute,
    resonanceChain: roster.resonanceChain,
    attackerLevel: roster.level,
    enemy,
    resonanceMode: data.resonanceMode,
    ...request.kitState,
    baseAtk: bases.baseAtk,
    baseHp: bases.baseHp,
    baseDef: bases.baseDef,
  };
  const score = (sheet: StatSheet): number => scoreSheet(request.objective, sheet, scoreContext);
  const meetsMinimums = (sheet: StatSheet): boolean =>
    minEntries.every(([stat, minimum]) => sheet[stat] >= minimum);

  const scoreCombo = (combo: OwnedEcho[]): { build: RankedBuild | null; baseline: StatSheet } => {
    // Best-main selection: the baseline plus one rescore per distinct
    // carrier definition (transcribed main-slot bonus for this character).
    // Ties keep the earlier option (baseline first). Minimums are checked
    // per option, so a carrier that wins on score but misses a minimum
    // never hides one that meets it.
    const baselineResult = stats(combo);
    let best: { result: ComputeStatsResult; score: number } | null = null;
    let mainEchoId: string | undefined;
    if (meetsMinimums(baselineResult.sheet)) {
      best = { result: baselineResult, score: score(baselineResult.sheet) };
    }
    const seenDefs = new Set<string>();
    for (const candidate of combo) {
      if (seenDefs.has(candidate.echoDefId)) continue;
      seenDefs.add(candidate.echoDefId);
      if (!hasMainEchoBonus(character.id, candidate.echoDefId)) continue;
      const result = stats(combo, candidate);
      if (!meetsMinimums(result.sheet)) continue;
      const rescored = score(result.sheet);
      if (best === null || rescored > best.score) {
        best = { result, score: rescored };
        mainEchoId = candidate.id;
      }
    }
    if (best === null) return { build: null, baseline: baselineResult.sheet };
    return {
      baseline: baselineResult.sheet,
      build: {
        echoIds: combo.map((e) => e.id).sort(),
        score: best.score,
        sheet: best.result.sheet,
        warnings: best.result.warnings,
        appliedAssumptions: best.result.appliedAssumptions,
        ...(mainEchoId === undefined ? {} : { mainEchoId }),
      },
    };
  };

  return { kept, pruned, minEntries, score, scoreCombo, stats };
}

/**
 * Reference search: the plain brute force over every unordered 5-combo of
 * the pruned pool, in lexicographic index order, with the incumbent kept
 * on score ties. Slow (it assembles every legal combo); kept as the oracle
 * that `searchExhaustive` must reproduce exactly (equivalence tests, bench).
 */
export function searchReference(
  data: SearchData,
  request: OptimizeRequest,
  onProgress?: (update: ProgressUpdate) => void,
): SearchResult {
  const prepared = prepare(data, request);
  const { kept } = prepared;
  const total = binomial(kept.length, 5);
  onProgress?.({ evaluated: 0, total });
  const top: RankedBuild[] = [];
  let evaluated = 0;
  let visited = 0;

  const consider = (combo: OwnedEcho[]): void => {
    visited += 1;
    onProgress?.({ evaluated: visited, total });
    if (combo.reduce((sum, e) => sum + e.cost, 0) > request.costBudget) return;
    if (!satisfiesLock(combo, request.sonataLock)) return;
    evaluated += 1;
    const { build } = prepared.scoreCombo(combo);
    if (build !== null) insertBounded(top, build, request.topN);
  };

  const n = kept.length;
  for (let a = 0; a < n - 4; a += 1) {
    for (let b = a + 1; b < n - 3; b += 1) {
      for (let c = b + 1; c < n - 2; c += 1) {
        for (let d = c + 1; d < n - 1; d += 1) {
          for (let e = d + 1; e < n; e += 1) {
            consider([kept[a], kept[b], kept[c], kept[d], kept[e]]);
          }
        }
      }
    }
  }
  return { builds: top, evaluated, scored: evaluated, total, prunedEchoes: prepared.pruned };
}

/** Bounded descending leaderboard; ties keep the incumbent (lexicographic combo order wins). */
function insertBounded(top: RankedBuild[], build: RankedBuild, topN: number): void {
  if (top.length < topN) {
    top.push(build);
    top.sort((x, y) => y.score - x.score);
    return;
  }
  if (build.score > top[top.length - 1].score) {
    top[top.length - 1] = build;
    top.sort((x, y) => y.score - x.score);
  }
}

/**
 * Exact top-N search over unordered 5-echo combos (pruned pool).
 * Throws on malformed requests; returns empty builds when no combo qualifies.
 *
 * Returns exactly what `searchReference` (the plain brute force) returns:
 * same builds, scores, sheets and tie order. Ranking is score descending,
 * then the combo's position in lexicographic order over the pruned pool
 * (the brute force's visiting order), so the enumeration order is free.
 *
 * How it stays fast:
 * - Enumerates by cost pattern (multisets of 5 pool costs within the
 *   budget, derived in `costPatterns`), so cost-illegal combos are never
 *   generated, and a 5-piece lock narrows the pool to that set.
 * - Additive decomposition: `computeStats` is the fixed character/weapon
 *   sheet plus one vector per echo, one per (set, distinct pieces) and one
 *   per main-slot def. The vectors are derived by calling `computeStats`
 *   (no stat math here) and the decomposition is verified on sample
 *   combos up front and on every exactly-scored combo; any mismatch falls
 *   back to scoring every combo exactly.
 * - Branch-and-bound: a partial combo's bound sheet adds, per stat, the
 *   largest values its remaining slots could take, the largest Sonata and
 *   main-slot gains reachable, and is scored once; the subtree is skipped
 *   when that bound (plus a float margin) is below the current N-th score
 *   or a minimum is unreachable. Valid because Sonata/main gains are
 *   checked non-negative and non-decreasing in pieces (else bounds are
 *   off), and because objective scores never decrease when a sheet stat
 *   rises — the same monotonicity the dominance pruning's swap step uses.
 * - Leaves are screened with the decomposed sheet; only combos that could
 *   enter the top N are re-scored exactly through `computeStats`.
 * - `shard` splits the work into deterministic slices (pattern × first
 *   echo) so worker.ts can run them in parallel and merge the top-Ns.
 *
 * Scaling (measured 2026-10-20, `npm run bench`, Jiyan expected
 * liberation damage, top 5, budget 12, one thread; identical top-N to the
 * reference wherever both ran). Dominance pruning (prune.ts) is sound but
 * weak — it drops 0–82 echoes here — so the speed comes from the bounds:
 *   synthetic inventory  n=50 0.2s (reference 19s), n=100 7s, n=200 30s,
 *                        n=300 90s (≈28s on 8 workers)
 *   realistic Lv25 inv.  n=50 0.13s (reference 53s), n=100 0.8s,
 *                        n=200 1.4s, n=300 2.7s
 * The synthetic generator draws any main stat for any cost, which keeps
 * per-stat maxima loose; real cost-restricted main stats bound far tighter.
 */
export function searchExhaustive(
  data: SearchData,
  request: OptimizeRequest,
  onProgress?: (update: ProgressUpdate) => void,
  shard: SearchShard = { index: 0, count: 1 },
): SearchResult {
  if (!Number.isInteger(shard.count) || shard.count < 1 || shard.index < 0 || shard.index >= shard.count) {
    throw new Error(`invalid shard ${shard.index}/${shard.count}`);
  }
  const prepared = prepare(data, request);
  try {
    return runPatternSearch(data, request, prepared, onProgress, shard, true);
  } catch (err) {
    if (!(err instanceof DecompositionMismatch)) throw err;
    return runPatternSearch(data, request, prepared, onProgress, shard, false);
  }
}

/** The decomposed sheet disagreed with `computeStats`; rerun without it. */
class DecompositionMismatch extends Error {}

const STAT_KEYS = Object.keys(emptySheet()) as StatKey[];
/** Most like-echo neighbours bounded together (see `chunkMax`). */
const CHUNK = 8;
const S = STAT_KEYS.length;

function toVector(sheet: StatSheet): Float64Array {
  const v = new Float64Array(S);
  for (let i = 0; i < S; i += 1) v[i] = sheet[STAT_KEYS[i]];
  return v;
}

function toSheet(v: Float64Array): StatSheet {
  const sheet = emptySheet();
  for (let i = 0; i < S; i += 1) sheet[STAT_KEYS[i]] = v[i];
  return sheet;
}

function minus(a: Float64Array, b: Float64Array): Float64Array {
  const out = new Float64Array(S);
  for (let i = 0; i < S; i += 1) out[i] = a[i] - b[i];
  return out;
}

function addInto(target: Float64Array, v: Float64Array): void {
  for (let i = 0; i < S; i += 1) target[i] += v[i];
}

/** Relative float slack for comparing decomposed sums with exact sheets/scores. */
function slack(x: number): number {
  return 1e-9 * Math.max(1, Math.abs(x));
}

function sameVector(a: Float64Array, b: Float64Array): boolean {
  for (let i = 0; i < S; i += 1) {
    if (Math.abs(a[i] - b[i]) > slack(b[i])) return false;
  }
  return true;
}

interface Entry {
  build: RankedBuild;
  /** Sorted kept indices: the brute force's visiting order. */
  key: number[];
}

function lexLess(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

function ranksBefore(a: Entry, b: Entry): boolean {
  return a.build.score > b.build.score || (a.build.score === b.build.score && lexLess(a.key, b.key));
}

/** Top-N by (score desc, key asc): order-independent, equal to the brute force's. */
class Leaderboard {
  readonly entries: Entry[] = [];
  private readonly topN: number;

  constructor(topN: number) {
    this.topN = topN;
  }

  get full(): boolean {
    return this.entries.length >= this.topN;
  }

  /** Lowest kept score; -Infinity until full. */
  get threshold(): number {
    return this.full ? this.entries[this.entries.length - 1].build.score : -Infinity;
  }

  insert(entry: Entry): void {
    if (this.full && !ranksBefore(entry, this.entries[this.entries.length - 1])) return;
    let i = this.entries.length;
    while (i > 0 && ranksBefore(entry, this.entries[i - 1])) i -= 1;
    this.entries.splice(i, 0, entry);
    if (this.entries.length > this.topN) this.entries.pop();
  }
}

/**
 * Cost patterns: every multiset of 5 costs from `costs` whose sum fits the
 * budget, as per-cost counts aligned with `costs`.
 */
export function costPatterns(costs: readonly number[], budget: number): number[][] {
  const patterns: number[][] = [];
  const counts = costs.map(() => 0);
  const walk = (g: number, left: number, spent: number): void => {
    if (g === costs.length - 1) {
      if (spent + left * costs[g] <= budget) {
        counts[g] = left;
        patterns.push([...counts]);
        counts[g] = 0;
      }
      return;
    }
    for (let m = left; m >= 0; m -= 1) {
      if (spent + m * costs[g] > budget) continue;
      counts[g] = m;
      walk(g + 1, left - m, spent + m * costs[g]);
    }
    counts[g] = 0;
  };
  if (costs.length > 0) walk(0, 5, 0);
  return patterns;
}

/** Sonata piece counts use distinct Echo definitions (reference doc §3). */
function sonataCounts(combo: OwnedEcho[]): Map<string, number> {
  const defsBySonata = new Map<string, Set<string>>();
  for (const echo of combo) {
    let defs = defsBySonata.get(echo.sonataId);
    if (!defs) {
      defs = new Set();
      defsBySonata.set(echo.sonataId, defs);
    }
    defs.add(echo.echoDefId);
  }
  return new Map([...defsBySonata].map(([sonata, defs]) => [sonata, defs.size] as const));
}

function satisfiesLock(combo: OwnedEcho[], lock: SonataLock): boolean {
  if (lock.mode === 'none') return true;
  const counts = sonataCounts(combo);
  if (lock.mode === 'five') return (counts.get(lock.setId) ?? 0) >= 5;
  return (counts.get(lock.setIdA) ?? 0) >= 2 && (counts.get(lock.setIdB) ?? 0) >= 2;
}

/**
 * Distinct-def piece counts of a partial combo (at most 5 echoes), as
 * parallel arrays — allocation-light twin of `sonataCounts` for the search loop.
 */
function distinctPieces(echoes: readonly OwnedEcho[]): { sets: string[]; counts: number[] } {
  const sets: string[] = [];
  const counts: number[] = [];
  for (let i = 0; i < echoes.length; i += 1) {
    const echo = echoes[i];
    let repeat = false;
    for (let j = 0; j < i; j += 1) {
      if (echoes[j].sonataId === echo.sonataId && echoes[j].echoDefId === echo.echoDefId) {
        repeat = true;
        break;
      }
    }
    if (repeat) continue;
    const at = sets.indexOf(echo.sonataId);
    if (at === -1) {
      sets.push(echo.sonataId);
      counts.push(1);
    } else {
      counts[at] += 1;
    }
  }
  return { sets, counts };
}

/** Slots still needed by the lock given partial distinct-def counts. */
function lockNeed(pieces: { sets: string[]; counts: number[] }, lock: SonataLock): number {
  const count = (setId: string): number => {
    const at = pieces.sets.indexOf(setId);
    return at === -1 ? 0 : pieces.counts[at];
  };
  if (lock.mode === 'none') return 0;
  if (lock.mode === 'five') return Math.max(0, 5 - count(lock.setId));
  return Math.max(0, 2 - count(lock.setIdA)) + Math.max(0, 2 - count(lock.setIdB));
}

function binomial(n: number, k: number): number {
  if (k < 0 || n < k) return 0;
  let result = 1;
  for (let i = 0; i < k; i += 1) result = (result * (n - i)) / (i + 1);
  return Math.round(result);
}

function runPatternSearch(
  data: SearchData,
  request: OptimizeRequest,
  prepared: Prepared,
  onProgress: ((update: ProgressUpdate) => void) | undefined,
  shard: SearchShard,
  decompose: boolean,
): SearchResult {
  const { kept, minEntries } = prepared;
  const lock = request.sonataLock;
  const characterId = data.character.id;
  const indexOf = new Map(kept.map((e, i) => [e, i] as const));
  // A 5-piece lock needs five distinct defs of the set: only its echoes can appear.
  const pool = lock.mode === 'five' ? kept.filter((e) => e.sonataId === lock.setId) : kept;

  // --- Additive decomposition, derived from computeStats only. ---
  const fixed = toVector(prepared.stats([]).sheet);
  const virtualEcho = (sonataId: string, echoDefId: string): OwnedEcho => ({
    id: `\u0000virtual:${sonataId}:${echoDefId}`,
    echoDefId,
    sonataId,
    cost: 1,
    level: 0,
    rarity: 5,
    mainStat: { stat: 'atk', value: 0 },
    substats: [],
    equippedTo: null,
    origin: 'virtual',
  });
  /** Sonata gain by distinct piece count 0..5, per set present in the pool. */
  const sonataGain = new Map<string, Float64Array[]>();
  for (const sonataId of new Set(pool.map((e) => e.sonataId))) {
    const gains: Float64Array[] = [new Float64Array(S)];
    for (let k = 1; k <= 5; k += 1) {
      const pieces = Array.from({ length: k }, (_, j) => virtualEcho(sonataId, `\u0000piece-${j}`));
      gains.push(minus(toVector(prepared.stats(pieces).sheet), fixed));
    }
    sonataGain.set(sonataId, gains);
  }
  const gainOf = (sonataId: string, pieces: number): Float64Array | undefined =>
    sonataGain.get(sonataId)?.[Math.min(5, pieces)];
  /** Main-slot gain per carrier def present in the pool. */
  const mainGain = new Map<string, Float64Array>();
  for (const echo of pool) {
    if (mainGain.has(echo.echoDefId) || !hasMainEchoBonus(characterId, echo.echoDefId)) continue;
    mainGain.set(echo.echoDefId, minus(toVector(prepared.stats([], echo).sheet), fixed));
  }
  const contribution = new Map<OwnedEcho, Float64Array>();
  for (const echo of pool) {
    const alone = minus(toVector(prepared.stats([echo]).sheet), fixed);
    const setPiece = gainOf(echo.sonataId, 1);
    contribution.set(echo, setPiece === undefined ? alone : minus(alone, setPiece));
  }

  // Bounds need gains that never shrink as pieces grow and are never negative.
  let monotone = true;
  for (const gains of sonataGain.values()) {
    for (let k = 1; k <= 5; k += 1) {
      for (let i = 0; i < S; i += 1) {
        if (gains[k][i] - gains[k - 1][i] < -slack(gains[k][i])) monotone = false;
      }
    }
  }
  for (const gain of mainGain.values()) {
    for (let i = 0; i < S; i += 1) if (gain[i] < -slack(gain[i])) monotone = false;
  }
  const useBounds = decompose && monotone;

  /** Decomposed sheet (no main) for a full combo. */
  const decomposedSheet = (combo: OwnedEcho[]): Float64Array => {
    const v = Float64Array.from(fixed);
    for (const echo of combo) addInto(v, contribution.get(echo)!);
    for (const [sonataId, pieces] of sonataCounts(combo)) {
      const gain = gainOf(sonataId, pieces);
      if (gain) addInto(v, gain);
    }
    return v;
  };

  // --- Cost groups and patterns. ---
  const costs = [...new Set(pool.map((e) => e.cost))].sort((x, y) => y - x);
  const solo = new Map<OwnedEcho, number>();
  if (decompose) {
    for (const echo of pool) {
      const v = Float64Array.from(fixed);
      addInto(v, contribution.get(echo)!);
      solo.set(echo, prepared.score(toSheet(v)));
    }
  }
  // Each cost group is ordered into clusters of like echoes (same main
  // stat), best cluster first and best echo first within it, so the N-th
  // score (the bound threshold) rises early and a run of neighbours has a
  // tight per-stat maximum (`chunkMax`) that can rule them out together.
  const bySolo = (x: OwnedEcho, y: OwnedEcho): number =>
    (solo.get(y) ?? 0) - (solo.get(x) ?? 0) || indexOf.get(x)! - indexOf.get(y)!;
  const groups = costs.map((cost) => {
    const clusters = new Map<string, OwnedEcho[]>();
    for (const echo of pool.filter((e) => e.cost === cost).sort(bySolo)) {
      const key = echo.mainStat.stat;
      const cluster = clusters.get(key);
      if (cluster) cluster.push(echo);
      else clusters.set(key, [echo]);
    }
    return [...clusters.values()].flat();
  });
  /** Chunks: runs of at most CHUNK same-cluster neighbours, with per-stat maxima. */
  const chunkEnd: number[][] = [];
  const chunkMax: Float64Array[][] = [];
  for (const list of groups) {
    const ends: number[] = new Array<number>(list.length);
    const maxima: Float64Array[] = new Array<Float64Array>(list.length);
    let begin = 0;
    while (begin < list.length) {
      let end = begin + 1;
      while (end < list.length && end - begin < CHUNK && list[end].mainStat.stat === list[begin].mainStat.stat) {
        end += 1;
      }
      const max = Float64Array.from(contribution.get(list[begin])!);
      for (let q = begin + 1; q < end; q += 1) {
        const v = contribution.get(list[q])!;
        for (let i = 0; i < S; i += 1) if (v[i] > max[i]) max[i] = v[i];
      }
      for (let q = begin; q < end; q += 1) {
        ends[q] = end;
        maxima[q] = max;
      }
      begin = end;
    }
    chunkEnd.push(ends);
    chunkMax.push(maxima);
  }
  /** Clusters: clusterEnd[g][p] ends p's cluster; clusterRest[g][p] = per-stat max over [p, end). */
  const clusterEnd: number[][] = [];
  const clusterRest: Float64Array[][] = [];
  for (const list of groups) {
    const ends: number[] = new Array<number>(list.length);
    const rest: Float64Array[] = new Array<Float64Array>(list.length);
    for (let q = list.length - 1; q >= 0; q -= 1) {
      const v = contribution.get(list[q])!;
      const sameAsNext = q + 1 < list.length && list[q + 1].mainStat.stat === list[q].mainStat.stat;
      ends[q] = sameAsNext ? ends[q + 1] : q + 1;
      const max = Float64Array.from(v);
      if (sameAsNext) for (let i = 0; i < S; i += 1) if (rest[q + 1][i] > max[i]) max[i] = rest[q + 1][i];
      rest[q] = max;
    }
    clusterEnd.push(ends);
    clusterRest.push(rest);
  }
  const patterns = costPatterns(costs, request.costBudget).filter((counts) =>
    counts.every((m, g) => m <= groups[g].length),
  );
  const leavesOf = (counts: number[]): number =>
    counts.reduce((product, m, g) => product * binomial(groups[g].length, m), 1);
  const total = patterns.reduce((sum, counts) => sum + leavesOf(counts), 0);

  if (decompose) {
    // Verify the decomposition up front on one sample combo per pattern.
    for (const counts of patterns) {
      const sample = counts.flatMap((m, g) => groups[g].slice(0, m));
      sample.sort((x, y) => indexOf.get(x)! - indexOf.get(y)!);
      if (!sameVector(decomposedSheet(sample), toVector(prepared.stats(sample).sheet))) {
        throw new DecompositionMismatch();
      }
    }
  }

  // Suffix top-j sums per stat: topSum[g][p][j] = Σ of the j largest values
  // of each stat among groups[g][p..]. Bounds the slots still to fill.
  const maxPerGroup = costs.map((_, g) => Math.max(0, ...patterns.map((counts) => counts[g])));
  const topSum: Float64Array[][][] = [];
  if (useBounds) {
    for (let g = 0; g < groups.length; g += 1) {
      const list = groups[g];
      const width = maxPerGroup[g];
      const best = Array.from({ length: S }, () => [] as number[]);
      const table: Float64Array[][] = new Array<Float64Array[]>(list.length + 1);
      table[list.length] = Array.from({ length: width + 1 }, () => new Float64Array(S));
      for (let p = list.length - 1; p >= 0; p -= 1) {
        const v = contribution.get(list[p])!;
        const row = Array.from({ length: width + 1 }, () => new Float64Array(S));
        for (let i = 0; i < S; i += 1) {
          const top = best[i];
          top.push(v[i]);
          top.sort((x, y) => y - x);
          if (top.length > width) top.pop();
          let sum = 0;
          for (let j = 1; j <= width; j += 1) {
            if (j <= top.length) sum += top[j - 1];
            row[j][i] = sum;
          }
        }
        table[p] = row;
      }
      topSum.push(table);
    }
  }
  // NEW[r]: per stat, the most any r new pieces could add across sets.
  const newSetGain: Float64Array[] = Array.from({ length: 6 }, () => new Float64Array(S));
  if (useBounds) {
    for (let i = 0; i < S; i += 1) {
      let dp = [0, 0, 0, 0, 0, 0];
      for (const gains of sonataGain.values()) {
        const next = [...dp];
        for (let c = 1; c <= 5; c += 1) {
          for (let a = 1; a <= c; a += 1) next[c] = Math.max(next[c], dp[c - a] + gains[a][i]);
        }
        dp = next;
      }
      for (let r = 0; r <= 5; r += 1) newSetGain[r][i] = dp[r];
    }
  }
  const mainMax = new Float64Array(S);
  for (const gain of mainGain.values()) {
    for (let i = 0; i < S; i += 1) mainMax[i] = Math.max(mainMax[i], gain[i]);
  }

  // --- Search. ---
  const board = new Leaderboard(request.topN);
  let covered = 0;
  let scored = 0;
  const reportEvery = Math.max(1, Math.floor(total / 1000));
  let lastReport = 0;
  const cover = (count: number): void => {
    covered += count;
    if (onProgress && covered - lastReport >= reportEvery) {
      lastReport = covered;
      onProgress({ evaluated: covered, total });
    }
  };
  onProgress?.({ evaluated: 0, total });

  const minIndexed = minEntries.map(([stat, minimum]) => [STAT_KEYS.indexOf(stat), minimum] as const);
  // Scratch buffers: the bound/screen paths run millions of times.
  const boundSheet = emptySheet();
  const scratch = new Float64Array(S);
  const leafVector = new Float64Array(S);
  const unreachable = (v: Float64Array): boolean => {
    for (const [index, minimum] of minIndexed) {
      const value = v[index];
      if (value + slack(value) < minimum) return true;
    }
    if (!board.full) return false;
    for (let i = 0; i < S; i += 1) boundSheet[STAT_KEYS[i]] = v[i];
    const bound = prepared.score(boundSheet);
    return bound + slack(bound) < board.threshold;
  };

  const chosen: OwnedEcho[] = [];
  const acc: Float64Array[] = Array.from({ length: 6 }, () => new Float64Array(S));
  let unit = -1;

  for (const counts of patterns) {
    const slots = counts.flatMap((m, g) => Array.from({ length: m }, () => g));
    /** needFrom[depth][g]: slots of group g among slots[depth..]. */
    const needFrom = Array.from({ length: 6 }, (_, depth) =>
      groups.map((_, g) => slots.slice(depth).filter((s) => s === g).length),
    );
    /** Leaves under a node: per group, choose the remaining slots from what is left. */
    const leavesBelow = (depth: number, nextPos: number): number => {
      let product = 1;
      for (let g = 0; g < groups.length; g += 1) {
        const available = g === slots[depth] ? groups[g].length - nextPos : groups[g].length;
        product *= binomial(available, needFrom[depth][g]);
      }
      return product;
    };
    const boundAt = (depth: number, nextPos: number, pieces: { sets: string[]; counts: number[] }): Float64Array => {
      const v = scratch;
      v.set(acc[depth]);
      const remaining = 5 - depth;
      for (let g = 0; g < groups.length; g += 1) {
        const need = needFrom[depth][g];
        if (need === 0) continue;
        const from = g === slots[depth] ? nextPos : 0;
        addInto(v, topSum[g][from][need]);
      }
      for (let k = 0; k < pieces.sets.length; k += 1) {
        const gain = gainOf(pieces.sets[k], pieces.counts[k] + remaining);
        if (gain) addInto(v, gain);
      }
      addInto(v, newSetGain[remaining]);
      addInto(v, mainMax);
      return v;
    };

    /** Bound for children p.. at `depth` whose own contribution is at most `max` per stat. */
    const rangeBound = (
      depth: number,
      g: number,
      p: number,
      max: Float64Array,
      pieces: { sets: string[]; counts: number[] },
    ): Float64Array => {
      const v = scratch;
      v.set(acc[depth]);
      addInto(v, max);
      const remaining = 5 - depth;
      for (let h = 0; h < groups.length; h += 1) {
        const need = h === g ? needFrom[depth][h] - 1 : needFrom[depth][h];
        if (need === 0) continue;
        addInto(v, topSum[h][h === g ? p + 1 : 0][need]);
      }
      for (let k = 0; k < pieces.sets.length; k += 1) {
        const gain = gainOf(pieces.sets[k], pieces.counts[k] + remaining);
        if (gain) addInto(v, gain);
      }
      addInto(v, newSetGain[remaining]);
      addInto(v, mainMax);
      return v;
    };

    const leaf = (): void => {
      if (!satisfiesLock(chosen, lock)) return;
      scored += 1;
      let decomposed: Float64Array | null = null;
      if (decompose) {
        // Decomposed sheet (no main), then the screen: plus, per stat, the
        // best main-slot gain any carrier in the combo could add.
        decomposed = leafVector;
        decomposed.set(acc[5]);
        const pieces = distinctPieces(chosen);
        for (let k = 0; k < pieces.sets.length; k += 1) {
          const gain = gainOf(pieces.sets[k], pieces.counts[k]);
          if (gain) addInto(decomposed, gain);
        }
        const screen = scratch;
        screen.set(decomposed);
        for (const echo of chosen) {
          const gain = mainGain.get(echo.echoDefId);
          if (!gain) continue;
          for (let i = 0; i < S; i += 1) screen[i] = Math.max(screen[i], decomposed[i] + gain[i]);
        }
        if (unreachable(screen)) return;
      }
      const combo = [...chosen].sort((x, y) => indexOf.get(x)! - indexOf.get(y)!);
      const { build, baseline } = prepared.scoreCombo(combo);
      if (decomposed !== null && !sameVector(decomposed, toVector(baseline))) {
        throw new DecompositionMismatch();
      }
      if (build !== null) board.insert({ build, key: combo.map((e) => indexOf.get(e)!) });
    };

    const descend = (depth: number, nextPos: number): void => {
      if (depth === 5) {
        cover(1);
        leaf();
        return;
      }
      const pieces = distinctPieces(chosen);
      if (depth > 0) {
        if (lockNeed(pieces, lock) > 5 - depth) {
          cover(leavesBelow(depth, nextPos));
          return;
        }
        if (useBounds && unreachable(boundAt(depth, nextPos, pieces))) {
          cover(leavesBelow(depth, nextPos));
          return;
        }
      }
      const g = slots[depth];
      const list = groups[g];
      const laterInGroup = needFrom[depth + 1]?.[g] ?? 0;
      const end = list.length - laterInGroup;
      const start = depth > 0 && slots[depth - 1] === g ? nextPos : 0;
      const nextGroupStarts = depth + 1 < 5 && slots[depth + 1] !== g;
      const skipTo = (stop: number): void => {
        for (; p < stop; p += 1) cover(leavesBelow(depth + 1, nextGroupStarts ? 0 : p + 1));
      };
      let p = start;
      while (p < end) {
        const stop = Math.min(chunkEnd[g][p], end);
        // Depth 0 hands out shard units one echo at a time, so ranges start below it.
        if (depth > 0 && useBounds) {
          // The rest of p's cluster, then p's chunk, as one bound each.
          const clusterStop = Math.min(clusterEnd[g][p], end);
          if (clusterStop > stop && unreachable(rangeBound(depth, g, p, clusterRest[g][p], pieces))) {
            skipTo(clusterStop);
            continue;
          }
          if (stop - p > 1 && unreachable(rangeBound(depth, g, p, chunkMax[g][p], pieces))) {
            skipTo(stop);
            continue;
          }
        }
        for (; p < stop; p += 1) {
          if (depth === 0) {
            unit += 1;
            if (unit % shard.count !== shard.index) continue;
          }
          const echo = list[p];
          chosen.push(echo);
          acc[depth + 1].set(acc[depth]);
          addInto(acc[depth + 1], contribution.get(echo)!);
          descend(depth + 1, nextGroupStarts ? 0 : p + 1);
          chosen.pop();
        }
      }
    };
    acc[0].set(fixed);
    descend(0, 0);
  }

  // A shard covers only its own units; the host sums shards against `total`.
  onProgress?.({ evaluated: covered, total });
  return {
    builds: board.entries.map((e) => e.build),
    evaluated: covered,
    scored,
    total,
    prunedEchoes: prepared.pruned,
  };
}

/**
 * Merge per-shard results into the single-run result: top-N by score, ties
 * by lexicographic position in `data.echoes` (pruning keeps input order,
 * so this is the same order every shard ranked by).
 */
export function mergeShardResults(data: SearchData, topN: number, results: SearchResult[]): SearchResult {
  const position = new Map(data.echoes.map((e, i) => [e.id, i] as const));
  const board = new Leaderboard(topN);
  for (const result of results) {
    for (const build of result.builds) {
      board.insert({ build, key: build.echoIds.map((id) => position.get(id)!).sort((x, y) => x - y) });
    }
  }
  return {
    builds: board.entries.map((e) => e.build),
    evaluated: results.reduce((sum, r) => sum + r.evaluated, 0),
    scored: results.reduce((sum, r) => sum + r.scored, 0),
    total: results[0]?.total ?? 0,
    prunedEchoes: results[0]?.prunedEchoes ?? [],
  };
}
