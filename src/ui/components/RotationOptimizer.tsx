import { useEffect, useRef, useState } from 'react';
import type {
  CharacterData,
  OwnedEcho,
  RosterEntry,
  RotationBlockSpec,
  RotationBuffSpec,
  SonataSetData,
  StatKey,
  WeaponData,
} from '../../data/schema.ts';
import type { ResonanceMode } from '../../domain/characterMods.ts';
import type { CritMode, EnemyProfile } from '../../domain/damage.ts';
import type { EnemySettings } from '../../domain/enemy.ts';
import { runOptimization, type OptimizationHandle } from '../../optimizer/worker.ts';
import { selectCandidates, type OptimizeRequest, type SearchData, type SearchResult } from '../../optimizer/search.ts';
import { useLibraryStore } from '../../state/library.ts';
import { MIN_STAT_FIELDS, parseMinStatTexts } from '../minStatFields.ts';
import { btnOutline, btnPrimary, labelClass, selectClass } from './classes.ts';
import { Collapsible } from './Collapsible.tsx';
import { RunClock } from './feedback.tsx';
import { Alert, Window } from './ui.tsx';

type Status =
  | { kind: 'idle' }
  | { kind: 'running'; evaluated: number; total: number }
  | { kind: 'done' }
  | { kind: 'error'; message: string };

interface RotationOptimizerProps {
  character: CharacterData;
  weapon: WeaponData;
  roster: RosterEntry;
  echoes: OwnedEcho[];
  sonataSets: SonataSetData[];
  enemy: EnemyProfile;
  /** The Calculator inputs `enemy` was built from; saved with the build. */
  enemySettings: EnemySettings;
  blocks: RotationBlockSpec[];
  buffs: RotationBuffSpec[];
  globalBuffIds: string[];
  crit: CritMode;
  resonanceMode?: ResonanceMode;
  /** DPR of the currently picked 5 echoes (null when ungated). */
  currentDpr: number | null;
  rotationTime: number;
  onApply: (echoIds: string[]) => void;
}

/** Candidate count from which the Sonata lock tip is shown. */
const LOCK_TIP_MIN_CANDIDATES = 100;

/**
 * What the user sees while a search runs. The search can sit for minutes
 * without the count moving, so the block shows proof of life that doesn't
 * depend on it (the activity blocks and the elapsed time), and says the count
 * can jump. No ETA: progress isn't linear. Mounted only while running, so the
 * elapsed timer stops with the run.
 *
 * Screen readers get one calm live region that changes only when the phase
 * changes or another quarter is checked; the ticking text is `aria-hidden`.
 */
function RunStatus({ evaluated, total }: { evaluated: number; total: number }) {
  const known = total > 0;
  const percent = known ? Math.min(100, Math.floor((evaluated / total) * 100)) : 0;
  const quarter = Math.min(75, Math.floor(percent / 25) * 25);
  return (
    <div className="mt-3 space-y-1 text-xs text-accent-text">
      <p role="status" className="sr-only">
        {known ? `Search running, ${quarter}% or more checked.` : 'Preparing the search.'}
      </p>
      <RunClock />
      <p aria-hidden="true" className="tnum">
        {known
          ? `Checked ${evaluated.toLocaleString()} of ${total.toLocaleString()} combos (${percent}%)…`
          : 'Preparing the search…'}
      </p>
      {known && (
        <p aria-hidden="true" className="text-fog">
          The count can jump: whole groups of combos are ruled out at once.
        </p>
      )}
    </div>
  );
}

/**
 * Minimal rotation optimizer: Top N + run, ranked by rotation DPR
 * (DPS ranks identically — time is constant). Results apply straight into
 * the Calculator loadout or save to the build library with the full spec.
 */
export function RotationOptimizer(props: RotationOptimizerProps) {
  const {
    character, weapon, roster, echoes, sonataSets, enemy, enemySettings,
    blocks, buffs, globalBuffIds, crit, resonanceMode, currentDpr, rotationTime, onApply,
  } = props;
  const saveBuild = useLibraryStore((s) => s.saveBuild);

  const [topN, setTopN] = useState('5');
  const [lockMode, setLockMode] = useState<'none' | 'five' | 'twoPlusTwo'>('none');
  const [lockSetA, setLockSetA] = useState('');
  const [lockSetB, setLockSetB] = useState('');
  // Candidate filters; the defaults search the whole inventory (as before).
  const [excludeEquipped, setExcludeEquipped] = useState(false);
  const [minLevel, setMinLevel] = useState('0');
  // Empty = no minimum for that stat.
  const [minTexts, setMinTexts] = useState<Partial<Record<StatKey, string>>>({});
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [result, setResult] = useState<SearchResult | null>(null);
  const [lastRun, setLastRun] = useState<{ data: SearchData; request: OptimizeRequest; enemy: EnemySettings } | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [saveName, setSaveName] = useState('');

  const runRef = useRef<OptimizationHandle | null>(null);
  const runCounter = useRef(0);
  useEffect(() => () => runRef.current?.cancel(), []);

  const echoLabels = new Map(echoes.map((e) => [e.id, e.label ?? e.echoDefId]));
  const parsedMinLevel = Number(minLevel.trim());
  const minLevelValid = Number.isInteger(parsedMinLevel) && parsedMinLevel >= 0 && parsedMinLevel <= 25;
  const candidates = selectCandidates(echoes, character.id, {
    excludeEquippedElsewhere: excludeEquipped,
    minLevel: minLevelValid ? parsedMinLevel : 0,
  });
  const activeMins = MIN_STAT_FIELDS.filter(({ stat }) => (minTexts[stat]?.trim() ?? '') !== '').length;
  const tooFew = echoes.length < 5;
  const tooFewCandidates = candidates.length < 5;
  // Measured on realistic inventories (scripts/bench-optimizer.ts generators):
  // the 5-piece lock is 10-25x faster, 2+2 only ~1.4-1.7x. Smaller pools finish
  // in about a second unlocked, so the tip only appears where it can matter.
  const showLockTip = lockMode !== 'five' && candidates.length >= LOCK_TIP_MIN_CANDIDATES;
  const canRun = blocks.length > 0 && !tooFew && !tooFewCandidates;

  const handleRun = (): void => {
    const parsedTopN = Number(topN.trim());
    if (!Number.isInteger(parsedTopN) || parsedTopN < 1 || parsedTopN > 50) {
      setStatus({ kind: 'error', message: 'Top N must be a whole number from 1 to 50.' });
      return;
    }
    if (!minLevelValid) {
      setStatus({ kind: 'error', message: 'Minimum level must be a whole number from 0 to 25.' });
      return;
    }
    if (lockMode === 'five' && lockSetA === '') {
      setStatus({ kind: 'error', message: 'Pick a Sonata set for the 5-piece lock.' });
      return;
    }
    if (lockMode === 'twoPlusTwo' && (lockSetA === '' || lockSetB === '' || lockSetA === lockSetB)) {
      setStatus({ kind: 'error', message: 'Pick two different Sonata sets for the 2+2 lock.' });
      return;
    }
    const parsedMins = parseMinStatTexts(minTexts);
    if (!parsedMins.ok) {
      setStatus({ kind: 'error', message: parsedMins.message });
      return;
    }
    const { minStats } = parsedMins;
    const data: SearchData = { character, weapon, roster, echoes: candidates, sonataSets, enemy, resonanceMode };
    const request: OptimizeRequest = {
      costBudget: 12,
      sonataLock:
        lockMode === 'five'
          ? { mode: 'five', setId: lockSetA }
          : lockMode === 'twoPlusTwo'
            ? { mode: 'twoPlusTwo', setIdA: lockSetA, setIdB: lockSetB }
            : { mode: 'none' },
      objective: { kind: 'rotation-dpr', blocks, buffs, globalBuffIds, crit },
      ...(minStats === undefined ? {} : { minStats }),
      topN: parsedTopN,
    };
    const usedEnemy = { ...enemySettings };
    runRef.current?.cancel();
    const runId = (runCounter.current += 1);
    const handle = runOptimization(data, request);
    runRef.current = handle;
    setResult(null);
    setStatus({ kind: 'running', evaluated: 0, total: 0 });
    handle.onProgress((evaluated, total) => {
      if (runCounter.current === runId) setStatus({ kind: 'running', evaluated, total });
    });
    void handle.promise.then(
      (searchResult) => {
        if (runCounter.current !== runId) return;
        setResult(searchResult);
        setLastRun({ data, request, enemy: usedEnemy });
        setStatus({ kind: 'done' });
      },
      (err: unknown) => {
        if (runCounter.current !== runId) return;
        setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      },
    );
  };

  /**
   * `handle.cancel()` never settles its promise, so bumping `runCounter` is
   * what makes the run's late progress/result/error callbacks no-ops.
   */
  const handleCancel = (): void => {
    runRef.current?.cancel();
    runRef.current = null;
    runCounter.current += 1;
    setStatus({ kind: 'idle' });
  };

  /** Slot order for apply/save: winning main echo first (slot 1), rest sorted. */
  const slotOrder = (echoIds: string[], mainEchoId: string | undefined): [string, string, string, string, string] => {
    const rest = echoIds.filter((id) => id !== mainEchoId).sort();
    return (mainEchoId === undefined ? rest : [mainEchoId, ...rest]) as [string, string, string, string, string];
  };

  const handleSave = async (echoIds: string[], mainEchoId: string | undefined): Promise<void> => {
    if (!lastRun || saveName.trim() === '') return;
    const key = echoIds.join('+');
    // The context this run actually used (Roster prefill, manual input or a
    // shared-build draft), so share links stay faithful to the saved build.
    const { forteUnlockedIds, weaponAscension, ...used } = lastRun.data.roster;
    await saveBuild({
      name: saveName.trim(),
      characterId: lastRun.data.character.id,
      weaponId: lastRun.data.weapon.id,
      echoIds: slotOrder(echoIds, mainEchoId),
      objectiveId: 'Rotation DPR',
      objective: lastRun.request.objective,
      score: result?.builds.find((b) => b.echoIds.join('+') === key)?.score,
      context: {
        ...used,
        forteLevels: { ...used.forteLevels },
        ...(forteUnlockedIds === undefined ? {} : { forteUnlockedIds: [...forteUnlockedIds] }),
        ...(weaponAscension === undefined ? {} : { weaponAscension }),
      },
      // The run's enemy and mode, so team allocation re-runs it as scored here.
      enemy: { ...lastRun.enemy },
      ...(lastRun.request.minStats === undefined ? {} : { minStats: { ...lastRun.request.minStats } }),
      ...(lastRun.data.resonanceMode === undefined ? {} : { resonanceMode: lastRun.data.resonanceMode }),
    });
    setSavingKey(null);
    setSaveName('');
  };

  return (
    <Window title="Optimize for This Rotation" label="Optimize for this rotation" bodyClassName="">
      <div className="p-4">
      {currentDpr !== null && (
        <p className="text-xs text-fog tnum">
          Current picks: {Math.round(currentDpr).toLocaleString()} DPR ·{' '}
          {Math.round(currentDpr / rotationTime).toLocaleString()} DPS
        </p>
      )}
      {tooFew ? (
        <p className="mt-2 text-xs text-fog">
          You need at least 5 echoes in your inventory to run the optimizer.
        </p>
      ) : (
        <>
        <div className="mt-3 grid grid-cols-1 items-end gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="ropt-topn" className={labelClass}>Top N</label>
            <input id="ropt-topn" value={topN} onChange={(e) => setTopN(e.target.value)} inputMode="numeric" className={`${selectClass} mt-0.5`} />
          </div>
          <div>
            <label htmlFor="ropt-lock" className={labelClass}>Sonata lock</label>
            <select id="ropt-lock" value={lockMode} onChange={(e) => setLockMode(e.target.value as 'none' | 'five' | 'twoPlusTwo')} className={`${selectClass} mt-0.5`}>
              <option value="none">None</option>
              <option value="five">5-piece</option>
              <option value="twoPlusTwo">2+2</option>
            </select>
          </div>
        </div>
        {lockMode !== 'none' && (
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div>
              <label htmlFor="ropt-lock-a" className={labelClass}>
                {lockMode === 'five' ? 'Locked set' : 'Set A (2pc)'}
              </label>
              <select id="ropt-lock-a" value={lockSetA} onChange={(e) => setLockSetA(e.target.value)} className={`${selectClass} mt-0.5`}>
                <option value="">Pick a set…</option>
                {sonataSets.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
            {lockMode === 'twoPlusTwo' && (
              <div>
                <label htmlFor="ropt-lock-b" className={labelClass}>Set B (2pc)</label>
                <select id="ropt-lock-b" value={lockSetB} onChange={(e) => setLockSetB(e.target.value)} className={`${selectClass} mt-0.5`}>
                  <option value="">Pick a set…</option>
                  {sonataSets.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
            )}
          </div>
        )}
        <div className="mt-3 grid grid-cols-1 items-end gap-3 sm:grid-cols-3">
          <div>
            <label htmlFor="ropt-min-level" className={labelClass}>Minimum echo level</label>
            <input id="ropt-min-level" value={minLevel} onChange={(e) => setMinLevel(e.target.value)} inputMode="numeric" className={`${selectClass} mt-0.5`} />
          </div>
          <label className="flex min-h-10 items-center gap-2 text-xs text-fog sm:col-span-2">
            <input type="checkbox" checked={excludeEquipped} onChange={() => setExcludeEquipped((v) => !v)} />
            <span>Skip echoes equipped on other characters</span>
          </label>
        </div>
        <div className="mt-3">
          <Collapsible title={<span className="text-base">{`Minimum stats${activeMins > 0 ? ` (${activeMins} set)` : ''}`}</span>}>
            <p className="mt-1 text-xs text-fog">
              Only builds whose stats meet every minimum count. Leave a box empty for no minimum.
            </p>
            <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-3">
              {MIN_STAT_FIELDS.map(({ stat, label, hint }) => (
                <div key={stat}>
                  <label htmlFor={`ropt-min-${stat}`} className={labelClass}>{`Minimum ${label}`}</label>
                  <input
                    id={`ropt-min-${stat}`}
                    value={minTexts[stat] ?? ''}
                    onChange={(e) => setMinTexts((m) => ({ ...m, [stat]: e.target.value }))}
                    inputMode="decimal"
                    className={`${selectClass} mt-0.5`}
                  />
                  {hint && <p className="mt-0.5 text-xs text-fog">{hint}</p>}
                </div>
              ))}
            </div>
          </Collapsible>
        </div>
        <p className="mt-2 text-xs text-fog tnum">
          Searching {candidates.length.toLocaleString()} of {echoes.length.toLocaleString()} echoes, in every layout
          up to 12 cost (e.g. 4-4-1-1-1 and 4-3-3-1-1).
          {tooFewCandidates && ' Loosen the filters: at least 5 are needed.'}
        </p>
        {showLockTip && (
          <p className="mt-1 text-xs text-fog">
            Tip: a 5-piece Sonata lock makes the search many times faster (a 2+2 lock helps much less). If you already
            know the set you want, pick it above.
          </p>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handleRun}
            disabled={!canRun}
            title={blocks.length === 0 ? 'Add rotation actions first' : undefined}
            className={`${btnPrimary} w-full px-5 py-2 sm:w-auto`}
          >
            Find best builds
          </button>
          {status.kind === 'running' && (
            <button type="button" onClick={handleCancel} className={`${btnOutline} px-5 py-2`}>
              Cancel
            </button>
          )}
        </div>
        </>
      )}

      {status.kind === 'running' && <RunStatus evaluated={status.evaluated} total={status.total} />}
      {status.kind === 'error' && (
        <Alert tone="danger" className="mt-3">
          {status.message}
        </Alert>
      )}
      {status.kind === 'done' && result && (
        <div className="mt-3">
          {result.builds.length === 0 ? (
            <p className="text-xs text-fog">No valid builds — try loosening the minimum stats, the Sonata lock or the Echo filters.</p>
          ) : (
            <ol className="space-y-2">
              {result.builds.map((build, i) => {
                const key = build.echoIds.join('+');
                const saving = savingKey === key;
                const uplift = currentDpr !== null && currentDpr > 0
                  ? ((build.score - currentDpr) / currentDpr) * 100
                  : null;
                const labels = build.echoIds.map((id) => {
                  const label = echoLabels.get(id) ?? id;
                  return id === build.mainEchoId ? `${label} (main)` : label;
                });
                return (
                  <li key={key} className="border-2 border-line bg-canvas px-4 py-3">
                    <p className="text-xs text-fog tnum">
                      Rank #{i + 1}
                      {uplift !== null && (
                        <span className={`ml-2 ${uplift >= 0 ? 'text-tide' : 'text-ember'}`}>
                          ({uplift >= 0 ? '+' : ''}{uplift.toFixed(1)}% vs current)
                        </span>
                      )}
                    </p>
                    <p className="mt-0.5 font-display text-2xl leading-none font-semibold text-ink tnum">
                      {Math.round(build.score).toLocaleString()} DPR{' '}
                      <span className="text-base font-medium text-fog">
                        · {Math.round(build.score / rotationTime).toLocaleString()} DPS
                      </span>
                    </p>
                    <p className="mt-1 text-xs text-fog">
                      {labels.join(' · ')}
                    </p>
                    {build.warnings.length > 0 && (
                      <p className="mt-0.5 text-xs text-amber">
                        {build.warnings.length} unmodeled effect{build.warnings.length === 1 ? '' : 's'}
                      </p>
                    )}
                    {build.appliedAssumptions.length > 0 && (
                      <p className="mt-0.5 text-xs text-fog" title={build.appliedAssumptions.join('\n')}>
                        Assumes: {build.appliedAssumptions.join('; ')}
                      </p>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => onApply(slotOrder(build.echoIds, build.mainEchoId))}
                        className={`${btnOutline} px-2.5 py-1 text-xs`}
                      >
                        Apply to loadout
                      </button>
                      {saving ? (
                        <>
                          <input
                            aria-label="Build name"
                            type="text"
                            value={saveName}
                            onChange={(e) => setSaveName(e.target.value)}
                            placeholder="Build name"
                            className={`${selectClass} !w-40 !py-1 text-xs`}
                          />
                          <button
                            type="button"
                            onClick={() => void handleSave(build.echoIds, build.mainEchoId)}
                            disabled={saveName.trim() === ''}
                            className={`${btnPrimary} px-2.5 py-1 text-xs`}
                          >
                            Confirm save
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setSavingKey(key);
                            setSaveName('');
                          }}
                          className={`${btnOutline} px-2.5 py-1 text-xs`}
                        >
                          Save
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
          <p className="mt-3 text-xs text-fog tnum">
            Checked {result.evaluated.toLocaleString()} combos ({result.scored.toLocaleString()} scored in full)
            {result.prunedEchoes.length > 0 && `, pruned ${result.prunedEchoes.length} dominated echoes`}.
          </p>
        </div>
      )}
      </div>
    </Window>
  );
}
