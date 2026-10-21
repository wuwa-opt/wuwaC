import { useEffect, useMemo, useRef, useState } from 'react';
import type { Build, OwnedEcho, Snapshot, Team } from '../../data/schema.ts';
import type { ResonanceMode } from '../../domain/characterMods.ts';
import { teamPriority } from '../../domain/teams.ts';
import {
  ALLOCATION_COST_BUDGET,
  isAllocationAborted,
  planKey,
  runAllocation,
  type AllocationCostBudget,
  type AllocationPlan,
  type AllocationProgress,
  type AllocationResult,
  type RunFn,
} from '../../optimizer/allocate.ts';
import { allocationDrafts, resolveMember, type ResolvedMember } from '../../optimizer/allocateMembers.ts';
import { useCalculatorStore } from '../../state/calculator.ts';
import { useInventoryStore } from '../../state/inventory.ts';
import { useLibraryStore } from '../../state/library.ts';
import { useRosterStore } from '../../state/roster.ts';
import { useSnapshotStore } from '../../state/snapshotStore.ts';
import { useTeamStore } from '../../state/teamStore.ts';
import { echoDisplayName } from '../echoDisplay.ts';
import { formatEnemy, formatMinStats, RESONANCE_MODE_LABELS } from '../format.ts';
import { btnGhost, btnOutline, btnPrimary, labelClass, selectClass } from './classes.ts';
import { MarkEquipped, type MarkedEquipped } from './MarkEquipped.tsx';
import { Alert } from './ui.tsx';

type Status =
  | { kind: 'idle' }
  | { kind: 'running'; progress: AllocationProgress | null }
  | { kind: 'error'; message: string };

interface Preview {
  allocation: AllocationResult;
  /** `planKey` of the inputs the run used. */
  key: string;
  resolved: ResolvedMember[];
  savedIds: string[] | null;
}

const num = (n: number): string => Math.round(n).toLocaleString();

/**
 * Team-wide Echo allocation for one saved team: each member in priority
 * order gets the best build from what higher-priority members left. Greedy,
 * not a joint optimum (said in the UI). Nothing is written until "Save as
 * builds" or "Mark as equipped" (a record of a re-gear done in the game).
 */
export function TeamAllocation({
  team,
  onSaved,
  onMarked,
  run,
}: {
  team: Team;
  /** Called with the rows just saved (the page offers Undo). */
  onSaved: (builds: Build[]) => void;
  /** Called after "Mark as equipped" wrote the Echo records (the page offers Undo). */
  onMarked?: (marked: MarkedEquipped) => void;
  /** Test seam; defaults to `runOptimization` workers like the Calculator. */
  run?: RunFn;
}) {
  const snapshot = useSnapshotStore((s) => s.snapshot);
  const echoes = useInventoryStore((s) => s.echoes);
  const inventoryLoaded = useInventoryStore((s) => s.loaded);
  const builds = useLibraryStore((s) => s.builds);
  const buildsLoaded = useLibraryStore((s) => s.loaded);
  const loadBuilds = useLibraryStore((s) => s.load);
  const saveBuilds = useLibraryStore((s) => s.saveBuilds);
  const roster = useRosterStore((s) => s.entries);
  const rosterLoaded = useRosterStore((s) => s.loaded);
  const loadRoster = useRosterStore((s) => s.load);
  const enemyKind = useCalculatorStore((s) => s.enemyKind);
  const enemyLevel = useCalculatorStore((s) => s.enemyLevel);
  const enemyBaseRES = useCalculatorStore((s) => s.enemyBaseRES);
  const savePriority = useTeamStore((s) => s.setPriority);

  const [order, setOrder] = useState<string[]>(() => teamPriority(team));
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [modePicks, setModePicks] = useState<Record<string, ResonanceMode>>({});
  const [minLevel, setMinLevel] = useState('0');
  const [costBudget, setCostBudget] = useState<AllocationCostBudget>(ALLOCATION_COST_BUDGET);
  const [priorityError, setPriorityError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [saving, setSaving] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!buildsLoaded) void loadBuilds();
  }, [buildsLoaded, loadBuilds]);
  useEffect(() => {
    if (!rosterLoaded) void loadRoster();
  }, [rosterLoaded, loadRoster]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const characterName = (id: string): string => snapshot.characters.find((c) => c.id === id)?.name ?? id;
  const parsedMinLevel = Number(minLevel.trim());
  const minLevelValid = Number.isInteger(parsedMinLevel) && parsedMinLevel >= 0 && parsedMinLevel <= 25;

  const resolved = useMemo(
    () =>
      order.map((characterId) =>
        resolveMember({
          characterId,
          buildId: picks[characterId],
          builds,
          roster,
          characters: snapshot.characters,
          weapons: snapshot.weapons,
          sonataSets: snapshot.sonataSets,
          enemy: { kind: enemyKind, level: enemyLevel, baseRES: enemyBaseRES },
          resonanceMode: modePicks[characterId],
        }),
      ),
    [order, picks, modePicks, builds, roster, snapshot, enemyKind, enemyLevel, enemyBaseRES],
  );
  const plan = useMemo<AllocationPlan | null>(() => {
    const members = resolved.flatMap((r) => (r.ok ? [r.member] : []));
    if (members.length !== resolved.length || !minLevelValid) return null;
    return {
      members,
      echoes,
      minLevel: parsedMinLevel,
      costBudget,
      dataStamp: `${snapshot.snapshotVersion}@${snapshot.fetchedAt}`,
    };
  }, [resolved, echoes, minLevelValid, parsedMinLevel, costBudget, snapshot.snapshotVersion, snapshot.fetchedAt]);
  const currentKey = useMemo(() => (plan === null ? null : planKey(plan)), [plan]);
  const stale = preview !== null && preview.key !== currentKey;
  const running = status.kind === 'running';
  const ready = inventoryLoaded && buildsLoaded && rosterLoaded;
  const canRun = ready && plan !== null && echoes.length >= 5 && !running;

  /** Reorder and save the new priority on the Team (one write per move). */
  const move = (index: number, delta: -1 | 1): void => {
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    const next = [...order];
    [next[index], next[target]] = [next[target], next[index]];
    setOrder(next);
    setPriorityError(null);
    savePriority(team.id, [next[0], next[1], next[2]]).catch((err: unknown) =>
      setPriorityError(err instanceof Error ? err.message : 'Could not save the order.'),
    );
  };

  const handleRun = (): void => {
    if (plan === null) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const usedKey = planKey(plan);
    const usedResolved = resolved;
    setPreview(null);
    setStatus({ kind: 'running', progress: null });
    runAllocation(plan, {
      signal: controller.signal,
      run,
      onProgress: (progress) => {
        if (abortRef.current === controller) setStatus({ kind: 'running', progress });
      },
    }).then(
      (allocation) => {
        if (abortRef.current !== controller) return;
        setPreview({ allocation, key: usedKey, resolved: usedResolved, savedIds: null });
        setStatus({ kind: 'idle' });
      },
      (err: unknown) => {
        if (abortRef.current !== controller) return;
        if (isAllocationAborted(err)) {
          setStatus({ kind: 'idle' });
          return;
        }
        setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      },
    );
  };

  const handleCancel = (): void => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStatus({ kind: 'idle' });
  };

  const drafts = useMemo(
    () =>
      preview === null
        ? []
        : allocationDrafts({ teamName: team.name, resolved: preview.resolved, allocation: preview.allocation, characterName }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [preview, team.name, snapshot],
  );

  const handleSave = (): void => {
    if (preview === null || stale || drafts.length === 0 || saving) return;
    setSaving(true);
    saveBuilds(drafts)
      .then((rows) => {
        setPreview((p) => (p === null ? p : { ...p, savedIds: rows.map((r) => r.id) }));
        setStatus({ kind: 'idle' });
        onSaved(rows);
      })
      .catch((err: unknown) =>
        setStatus({ kind: 'error', message: err instanceof Error ? err.message : 'Could not save the builds.' }),
      )
      .finally(() => setSaving(false));
  };

  const progress = status.kind === 'running' ? status.progress : null;
  const percent = progress !== null && progress.total > 0 ? Math.floor((progress.evaluated / progress.total) * 100) : 0;

  return (
    <div className="space-y-3 text-sm">
      <Alert tone="info" role="status">
        <strong>Greedy, not optimal for the whole team.</strong> Characters pick in the order below: each gets the best
        build from the Echoes the characters above left. Each step is exact, but a different order can give a better
        total, so try reordering. Echoes equipped to anyone are fair game; nothing is saved or changed until you
        save builds or mark them as equipped.
      </Alert>

      <ol className="space-y-2" aria-label="Priority order">
        {resolved.map((r, index) => {
          const name = characterName(r.characterId);
          return (
            <li key={r.characterId} className="border-2 border-line bg-canvas p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-display text-lg font-semibold text-ink tnum">{index + 1}.</span>
                <span className="min-w-0 flex-1 font-semibold text-ink">{name}</span>
                <button
                  type="button"
                  className={`${btnGhost} px-2`}
                  disabled={index === 0 || running}
                  onClick={() => move(index, -1)}
                  aria-label={`Move ${name} up`}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className={`${btnGhost} px-2`}
                  disabled={index === resolved.length - 1 || running}
                  onClick={() => move(index, 1)}
                  aria-label={`Move ${name} down`}
                >
                  ↓
                </button>
              </div>
              {r.choices.length > 1 ? (
                <div className="mt-2">
                  <label htmlFor={`alloc-build-${team.id}-${r.characterId}`} className={labelClass}>
                    {`Build for ${name}`}
                  </label>
                  <select
                    id={`alloc-build-${team.id}-${r.characterId}`}
                    value={(r.choices.find((b) => b.id === picks[r.characterId]) ?? r.choices[0]).id}
                    disabled={running}
                    onChange={(e) => setPicks((p) => ({ ...p, [r.characterId]: e.target.value }))}
                    className={`${selectClass} mt-0.5`}
                  >
                    {r.choices.map((b) => (
                      <option key={b.id} value={b.id}>{`${b.name} (${b.updatedAt.slice(0, 10)})`}</option>
                    ))}
                  </select>
                </div>
              ) : (
                r.ok && (
                  <p className="mt-1 text-xs text-fog">{`Using build “${r.build.name}” (objective and context saved with it).`}</p>
                )
              )}
              {r.modeChoices.length > 0 && (
                <div className="mt-2">
                  <label htmlFor={`alloc-mode-${team.id}-${r.characterId}`} className={labelClass}>
                    {`Resonance Mode for ${name}`}
                  </label>
                  <select
                    id={`alloc-mode-${team.id}-${r.characterId}`}
                    value={modePicks[r.characterId] ?? ''}
                    required
                    aria-invalid={!r.ok}
                    disabled={running}
                    onChange={(e) => {
                      const mode = r.modeChoices.find((m) => m === e.target.value);
                      setModePicks((p) => {
                        const next = { ...p };
                        if (mode === undefined) delete next[r.characterId];
                        else next[r.characterId] = mode;
                        return next;
                      });
                    }}
                    className={`${selectClass} mt-0.5`}
                  >
                    <option value="">Pick a mode…</option>
                    {r.modeChoices.map((mode) => (
                      <option key={mode} value={mode}>{RESONANCE_MODE_LABELS[mode]}</option>
                    ))}
                  </select>
                </div>
              )}
              {r.ok && r.modeSource === 'build' && r.member.context.resonanceMode !== undefined && (
                <p className="mt-1 text-xs text-fog">
                  {`Resonance Mode: ${RESONANCE_MODE_LABELS[r.member.context.resonanceMode]} (saved with the build).`}
                </p>
              )}
              {r.ok && r.member.minStats !== undefined && (
                <p className="mt-1 text-xs text-fog">{`Minimum stats: ${formatMinStats(r.member.minStats)} (saved with the build).`}</p>
              )}
              {r.ok ? (
                <p className="mt-1 text-xs text-fog">
                  {r.enemySource === 'build'
                    ? `Enemy: ${formatEnemy(r.enemy)} (saved with the build).`
                    : `Enemy: ${formatEnemy(r.enemy)} (the Calculator's current settings; this build saved none).`}
                </p>
              ) : (
                <p className="mt-1 text-xs text-amber">{r.reason}</p>
              )}
            </li>
          );
        })}
      </ol>

      {priorityError !== null && <p className="text-xs text-amber">{`The new order wasn't saved: ${priorityError}`}</p>}

      <p className="text-xs text-fog">
        {`Builds saved with an enemy use it. The rest use the Calculator's current settings (${formatEnemy({ kind: enemyKind, level: enemyLevel, baseRES: enemyBaseRES })}), which aren't saved and reset to the defaults (mob, Lv 90, 10% RES) when the page reloads. Builds saved with minimum stats keep them, for the search and for the comparison with your equipped Echoes. Every member searches under a cost budget of ${costBudget}, the same budget your equipped Echoes are checked against, with no Sonata lock.`}
      </p>

      <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-4">
        <div>
          <label htmlFor={`alloc-min-level-${team.id}`} className={labelClass}>Minimum echo level</label>
          <input
            id={`alloc-min-level-${team.id}`}
            value={minLevel}
            onChange={(e) => setMinLevel(e.target.value)}
            inputMode="numeric"
            aria-invalid={!minLevelValid}
            disabled={running}
            className={`${selectClass} mt-0.5`}
          />
        </div>
        <div>
          <label htmlFor={`alloc-budget-${team.id}`} className={labelClass}>Cost budget</label>
          <select
            id={`alloc-budget-${team.id}`}
            value={costBudget}
            onChange={(e) => setCostBudget(e.target.value === '10' ? 10 : 12)}
            disabled={running}
            className={`${selectClass} mt-0.5`}
          >
            <option value={12}>12</option>
            <option value={10}>10</option>
          </select>
        </div>
        <div className="flex flex-wrap gap-2 sm:col-span-2">
          <button type="button" onClick={handleRun} disabled={!canRun} className={`${btnPrimary} px-5 py-2`}>
            Allocate Echoes
          </button>
          {running && (
            <button type="button" onClick={handleCancel} className={btnOutline}>
              Cancel
            </button>
          )}
        </div>
      </div>
      {!minLevelValid && <p className="text-xs text-amber">Minimum level must be a whole number from 0 to 25.</p>}
      {ready && echoes.length < 5 && <p className="text-xs text-fog">You need at least 5 Echoes in your inventory.</p>}

      {running && (
        <p role="status" className="text-xs text-accent-text tnum">
          {progress === null
            ? 'Starting…'
            : `${progress.phase === 'baseline' ? 'Scoring equipped Echoes' : 'Searching'}: ${characterName(progress.characterId)} (${progress.index + 1} of ${progress.count}) — ${percent}%`}
        </p>
      )}
      {status.kind === 'error' && <Alert tone="danger">{status.message}</Alert>}

      {preview !== null && (
        <div className="space-y-2" aria-label="Allocation preview" role="region">
          <p className="font-display text-lg font-semibold text-ink">Preview</p>
          {stale && (
            <Alert tone="warning" role="status">
              Your inputs changed since this preview (inventory, builds, order, enemy, Resonance Mode, minimum stats, cost budget or
              minimum level). Run it again before saving.
            </Alert>
          )}
          <ol className="space-y-2">
            {preview.allocation.members.map((m, index) => {
              const name = characterName(m.characterId);
              const baselineScore = m.baseline?.score ?? null;
              const change =
                m.best !== null && baselineScore !== null && baselineScore > 0
                  ? ((m.best.score - baselineScore) / baselineScore) * 100
                  : null;
              const echoById = new Map(echoes.map((e) => [e.id, e]));
              return (
                <li key={m.characterId} className="border-2 border-line bg-canvas px-4 py-3">
                  <p className="text-xs text-fog tnum">{`Priority ${index + 1} · ${name}`}</p>
                  {m.best === null ? (
                    <p className="mt-1 text-sm text-amber">
                      {`No legal build from the Echoes left (${m.pool} available to ${name})${
                        preview.resolved.some((r) => r.ok && r.characterId === m.characterId && r.member.minStats !== undefined)
                          ? ' that meets the build\'s minimum stats'
                          : ''
                      }. They take nothing.`}
                    </p>
                  ) : (
                    <>
                      <p className="mt-0.5 font-display text-2xl leading-none font-semibold text-ink tnum">
                        {`${num(m.best.score)} score`}
                      </p>
                      <p className="mt-1 text-xs text-fog">
                        {slotNames(m.best.echoIds, m.best.mainEchoId, echoById, snapshot).join(' · ')}
                      </p>
                      {m.best.warnings.length > 0 && (
                        <p className="mt-0.5 text-xs text-amber">
                          {`${m.best.warnings.length} unmodeled effect${m.best.warnings.length === 1 ? '' : 's'}`}
                        </p>
                      )}
                      <p className="mt-1 text-xs tnum">
                        {baselineScore === null ? (
                          <span className="text-fog">{`No comparison: ${m.baselineNote ?? 'no equipped Echoes'}.`}</span>
                        ) : (
                          <span className={change !== null && change < 0 ? 'text-ember' : 'text-tide'}>
                            {change === null
                              ? `Your equipped Echoes, best slot-1 order: ${num(baselineScore)}`
                              : `${change >= 0 ? '+' : ''}${change.toFixed(1)}% vs your equipped Echoes, best slot-1 order (${num(baselineScore)})`}
                          </span>
                        )}
                      </p>
                    </>
                  )}
                </li>
              );
            })}
          </ol>
          <p className="text-xs text-fog">
            Greedy result: members earlier in the order took first pick. Reorder and run again to compare.
          </p>
          <button
            type="button"
            onClick={handleSave}
            disabled={stale || drafts.length === 0 || saving || preview.savedIds !== null}
            className={btnPrimary}
          >
            {preview.savedIds !== null ? 'Saved' : `Save as ${drafts.length} ${drafts.length === 1 ? 'build' : 'builds'}`}
          </button>
          <MarkEquipped
            allocation={preview.allocation}
            echoes={echoes}
            stale={stale}
            characterName={characterName}
            onMarked={onMarked}
          />
        </div>
      )}
    </div>
  );
}

function slotNames(
  echoIds: readonly string[],
  mainEchoId: string | undefined,
  byId: ReadonlyMap<string, OwnedEcho>,
  snapshot: Snapshot,
): string[] {
  const rest = echoIds.filter((id) => id !== mainEchoId).sort();
  const ordered = mainEchoId === undefined ? rest : [mainEchoId, ...rest];
  return ordered.map((id) => {
    const echo = byId.get(id);
    const label = echo === undefined ? id : echoDisplayName(snapshot, echo);
    return id === mainEchoId ? `${label} (main)` : label;
  });
}
