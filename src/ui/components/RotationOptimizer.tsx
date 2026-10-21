import { useEffect, useRef, useState } from 'react';
import type {
  CharacterData,
  OwnedEcho,
  RosterEntry,
  RotationBlockSpec,
  RotationBuffSpec,
  SonataSetData,
  WeaponData,
} from '../../data/schema.ts';
import type { ResonanceMode } from '../../domain/characterMods.ts';
import type { CritMode, EnemyProfile } from '../../domain/damage.ts';
import type { EnemySettings } from '../../optimizer/allocateMembers.ts';
import { runOptimization, type OptimizationHandle } from '../../optimizer/worker.ts';
import { selectCandidates, type OptimizeRequest, type SearchData, type SearchResult } from '../../optimizer/search.ts';
import { useLibraryStore } from '../../state/library.ts';
import { btnOutline, btnPrimary, labelClass, selectClass } from './classes.ts';
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

/**
 * Minimal rotation optimizer: budget + Top N + run, ranked by rotation DPR
 * (DPS ranks identically — time is constant). Results apply straight into
 * the Calculator loadout or save to the build library with the full spec.
 */
export function RotationOptimizer(props: RotationOptimizerProps) {
  const {
    character, weapon, roster, echoes, sonataSets, enemy, enemySettings,
    blocks, buffs, globalBuffIds, crit, resonanceMode, currentDpr, rotationTime, onApply,
  } = props;
  const saveBuild = useLibraryStore((s) => s.saveBuild);

  const [budget, setBudget] = useState<'10' | '12'>('12');
  const [topN, setTopN] = useState('5');
  const [lockMode, setLockMode] = useState<'none' | 'five' | 'twoPlusTwo'>('none');
  const [lockSetA, setLockSetA] = useState('');
  const [lockSetB, setLockSetB] = useState('');
  // Candidate filters; the defaults search the whole inventory (as before).
  const [excludeEquipped, setExcludeEquipped] = useState(false);
  const [minLevel, setMinLevel] = useState('0');
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
  const tooFew = echoes.length < 5;
  const tooFewCandidates = candidates.length < 5;
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
    const data: SearchData = { character, weapon, roster, echoes: candidates, sonataSets, enemy, resonanceMode };
    const request: OptimizeRequest = {
      costBudget: budget === '10' ? 10 : 12,
      sonataLock:
        lockMode === 'five'
          ? { mode: 'five', setId: lockSetA }
          : lockMode === 'twoPlusTwo'
            ? { mode: 'twoPlusTwo', setIdA: lockSetA, setIdB: lockSetB }
            : { mode: 'none' },
      objective: { kind: 'rotation-dpr', blocks, buffs, globalBuffIds, crit },
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
        <div className="mt-3 grid grid-cols-1 items-end gap-3 sm:grid-cols-3">
          <div>
            <label htmlFor="ropt-budget" className={labelClass}>Cost budget</label>
            <select id="ropt-budget" value={budget} onChange={(e) => setBudget(e.target.value as '10' | '12')} className={`${selectClass} mt-0.5`}>
              <option value="10">10</option>
              <option value="12">12</option>
            </select>
          </div>
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
        <p className="mt-2 text-xs text-fog tnum">
          Searching {candidates.length.toLocaleString()} of {echoes.length.toLocaleString()} echoes.
          {tooFewCandidates && ' Loosen the filters: at least 5 are needed.'}
        </p>
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

      {status.kind === 'running' && (
        <p className="mt-3 text-xs text-accent-text tnum" role="status">
          Checked {status.evaluated.toLocaleString()} of {status.total.toLocaleString()} combos…
        </p>
      )}
      {status.kind === 'error' && (
        <Alert tone="danger" className="mt-3">
          {status.message}
        </Alert>
      )}
      {status.kind === 'done' && result && (
        <div className="mt-3">
          {result.builds.length === 0 ? (
            <p className="text-xs text-fog">No valid builds — loosen the budget.</p>
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
