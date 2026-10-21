import { useEffect, useMemo, useRef, useState } from 'react';
import {
  exportKameraEchoes,
  KAMERA_ORIGIN,
  mapKameraEchoes,
  parseKameraEchoFile,
  type KameraImportResult,
} from '../../data/kamera.ts';
import type { OwnedEcho } from '../../data/schema.ts';
import { findUnusedEchoes } from '../../optimizer/unused.ts';
import { echoDefIssues, useInventoryStore } from '../../state/inventory.ts';
import { useLibraryStore } from '../../state/library.ts';
import { seedInventory } from '../../state/seed.ts';
import { useSnapshotStore } from '../../state/snapshotStore.ts';
import { EchoForm, type EchoFormValues } from '../components/EchoForm.tsx';
import { EchoScanner } from '../components/EchoScanner.tsx';
import { EchoStatus } from '../components/EchoStatus.tsx';
import { EchoTable } from '../components/EchoTable.tsx';
import { Mascot } from '../components/Mascot.tsx';
import { btnDangerGhost, btnGhost, btnOutline, btnPrimary, inputClass } from '../components/classes.ts';
import { AnimatedNumber, Skeleton, ToastStack } from '../components/feedback.tsx';
import { UNDO_TOAST_MS, useToasts } from '../toasts.ts';
import { usePrefersReducedMotion, useTypewriter } from '../motion.ts';
import { Alert, CostPips, EmptyState, PageHeader, Window } from '../components/ui.tsx';
import { inventorySummary } from '../echoDisplay.ts';
import { toDisplayValue } from '../format.ts';
import { filterByUsage, type UsageFilter } from '../filter.ts';
import { revokeObjectUrlLater } from '../download.ts';
import { MAX_KAMERA_BYTES, readTextFile } from '../readFile.ts';

function toFormValues(echo: OwnedEcho): EchoFormValues {
  return {
    echoDefId: echo.echoDefId,
    label: echo.label ?? '',
    sonataId: echo.sonataId,
    level: String(echo.level),
    rarity: String(echo.rarity),
    mainStat: {
      stat: echo.mainStat.stat,
      valueText: toDisplayValue(echo.mainStat.stat, echo.mainStat.value),
    },
    secondMainStat: {
      valueText: echo.secondMainStat
        ? toDisplayValue(echo.secondMainStat.stat, echo.secondMainStat.value)
        : '',
    },
    substats: echo.substats.map((s) => ({
      stat: s.stat,
      valueText: toDisplayValue(s.stat, s.value),
    })),
  };
}

/** Stable ref callback: focus the safe default of a confirm step when it appears. */
function focusOnMount(el: HTMLElement | null): void {
  el?.focus();
}

/**
 * Mascot speech bubble. The visible text types out (aria-hidden, with the
 * untyped remainder kept invisible so the bubble never resizes); the full
 * sentence is always available to assistive tech.
 */
function SpeechBubble({ text }: { text: string }) {
  const typed = useTypewriter(text);
  const done = typed.length >= text.length;
  return (
    <div className="relative min-w-0 max-w-md flex-1">
      <div className="px-frame-flat bg-panel px-4 py-3 text-sm text-ink">
        <span className="sr-only">{text}</span>
        <span aria-hidden="true">
          {typed}
          {!done && <span className="px-caret inline-block h-[1em] w-[0.5em] translate-y-[2px] bg-accent-text" />}
          <span className="invisible">{text.slice(typed.length)}</span>
        </span>
      </div>
      <span
        aria-hidden="true"
        className="absolute top-1/2 -left-[12px] h-[9px] w-[9px] -translate-y-1/2 bg-outline"
      />
    </div>
  );
}

export function InventoryPage() {
  const echoes = useInventoryStore((s) => s.echoes);
  const loaded = useInventoryStore((s) => s.loaded);
  const load = useInventoryStore((s) => s.load);
  const addEcho = useInventoryStore((s) => s.addEcho);
  const updateEcho = useInventoryStore((s) => s.updateEcho);
  const removeEcho = useInventoryStore((s) => s.removeEcho);
  const removeEchoes = useInventoryStore((s) => s.removeEchoes);
  const setLocked = useInventoryStore((s) => s.setLocked);
  const restoreEchoes = useInventoryStore((s) => s.restoreEchoes);
  const generation = useInventoryStore((s) => s.generation);
  const importEchoes = useInventoryStore((s) => s.importEchoes);
  const [adding, setAdding] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [editing, setEditing] = useState<OwnedEcho | null>(null);
  const [sonataFilter, setSonataFilter] = useState('');
  const [costFilter, setCostFilter] = useState<1 | 3 | 4 | null>(null);
  const [usageFilter, setUsageFilter] = useState<UsageFilter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [seedSonata, setSeedSonata] = useState('');
  const [preview, setPreview] = useState<(KameraImportResult & { fileName: string }) | null>(null);
  const [transferError, setTransferError] = useState<string | null>(null);
  // Bulk-delete confirmation: the ids shown, valid only for the filters they were shown under.
  const [fodderConfirm, setFodderConfirm] = useState<{ ids: string[]; filterKey: string } | null>(null);
  const { toasts, push: pushToast, dismiss: dismissToast, hold: holdToast } = useToasts();
  const fileRef = useRef<HTMLInputElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  // Undo toasts and the inventory generation they were issued under (undo is in memory only).
  const undoToasts = useRef(new Set<number>());
  const reducedMotion = usePrefersReducedMotion();

  const snapshot = useSnapshotStore((s) => s.snapshot);
  const ensureSnapshotLoaded = useSnapshotStore((s) => s.ensureLoaded);
  const builds = useLibraryStore((s) => s.builds);
  const buildsLoaded = useLibraryStore((s) => s.loaded);
  const loadBuilds = useLibraryStore((s) => s.load);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);
  useEffect(() => {
    void ensureSnapshotLoaded();
  }, [ensureSnapshotLoaded]);
  useEffect(() => {
    if (!buildsLoaded) void loadBuilds();
  }, [buildsLoaded, loadBuilds]);

  // A reload (backup restore, first load) invalidates every pending undo offer.
  useEffect(() => {
    for (const id of undoToasts.current) dismissToast(id);
    undoToasts.current.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire on generation change only
  }, [generation]);

  // Derived, never stored. Until the library loads every unequipped Echo would read as unused.
  const usage = useMemo(
    () => (buildsLoaded ? findUnusedEchoes({ echoes, builds, characters: snapshot.characters }) : null),
    [buildsLoaded, echoes, builds, snapshot.characters],
  );
  const usageCounts = useMemo(() => {
    let unused = 0;
    let fodder = 0;
    let checked = 0;
    let noObjective = false;
    let unchecked = false;
    for (const verdict of usage?.values() ?? []) {
      if (verdict.status !== 'in-use') unused += 1;
      if (verdict.status === 'fodder') fodder += 1;
      checked = Math.max(checked, verdict.buildsChecked);
      if (verdict.reason === 'no-objective-builds') noObjective = true;
      if (verdict.reason === 'unchecked-build') unchecked = true;
    }
    return { unused, fodder, checked, noObjective, unchecked };
  }, [usage]);
  const usageTags = useMemo(() => {
    const tags = new Map<string, 'unused' | 'fodder'>();
    for (const [id, verdict] of usage ?? []) {
      // Fodder is always tagged; plain "unused" only while the usage filter is on.
      if (verdict.status === 'fodder') tags.set(id, 'fodder');
      else if (verdict.status === 'unused' && usageFilter !== 'all') tags.set(id, 'unused');
    }
    return tags;
  }, [usage, usageFilter]);

  const defName = (echoDefId: string): string =>
    snapshot.echoDefs.find((d) => d.id === echoDefId)?.name ?? echoDefId;
  const setName = (sonataId: string): string =>
    snapshot.sonataSets.find((s) => s.id === sonataId)?.name ?? sonataId;

  const handleFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    try {
      const text = await readTextFile(file, MAX_KAMERA_BYTES, 'an Echo import');
      const rows = parseKameraEchoFile(text);
      setPreview({ fileName: file.name, ...mapKameraEchoes(rows, snapshot) });
      setTransferError(null);
    } catch (err) {
      setPreview(null);
      setTransferError(err instanceof Error ? err.message : 'Could not read that file.');
    }
  };

  const handleExport = (): void => {
    try {
      const json = JSON.stringify(exportKameraEchoes(echoes, snapshot), null, 2);
      const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'echoes_wuwainventorykamera.json';
      anchor.click();
      revokeObjectUrlLater(url);
      setTransferError(null);
      pushToast(`Exported ${echoes.length} ${echoes.length === 1 ? 'echo' : 'echoes'}.`);
    } catch (err) {
      setTransferError(err instanceof Error ? err.message : 'Could not export the inventory.');
    }
  };

  /** Toast with an Undo that puts exactly `rows` back (in memory only; gone on reload). */
  const pushUndoToast = (message: string, rows: readonly OwnedEcho[]): void => {
    const issuedAt = useInventoryStore.getState().generation;
    const id = pushToast(message, 'success', {
      timeoutMs: UNDO_TOAST_MS,
      action: {
        label: 'Undo',
        onAction: () => {
          dismissToast(id);
          undoToasts.current.delete(id);
          if (useInventoryStore.getState().generation !== issuedAt) return;
          restoreEchoes(rows)
            .then(({ restored, skipped }) => {
              const noun = (n: number): string => `${n} ${n === 1 ? 'echo' : 'echoes'}`;
              pushToast(
                skipped.length === 0
                  ? `Restored ${noun(restored.length)}.`
                  : `Restored ${noun(restored.length)}; ${noun(skipped.length)} already back, left as is.`,
              );
            })
            .catch((err: unknown) => setTransferError(err instanceof Error ? err.message : 'Undo failed.'));
        },
      },
    });
    undoToasts.current.add(id);
  };

  const deleteSafeFodder = (shownIds: readonly string[]): void => {
    setFodderConfirm(null);
    // Recompute now: the render the user confirmed on may be stale.
    const fresh = findUnusedEchoes({
      echoes: useInventoryStore.getState().echoes,
      builds: useLibraryStore.getState().builds,
      characters: useSnapshotStore.getState().snapshot.characters,
    });
    const safe = shownIds.filter((id) => fresh.get(id)?.status === 'fodder');
    if (safe.length !== shownIds.length) {
      setTransferError('The safe-fodder list changed since you opened it. Nothing was deleted — review it and try again.');
      return;
    }
    removeEchoes(safe)
      .then((removed) => {
        setTransferError(null);
        setSelectedId((cur) => (cur !== null && removed.some((r) => r.id === cur) ? null : cur));
        if (removed.length > 0) {
          pushUndoToast(
            `Deleted ${removed.length} safe-fodder ${removed.length === 1 ? 'Echo' : 'Echoes'}.`,
            removed,
          );
        }
      })
      .catch((err: unknown) => setTransferError(err instanceof Error ? err.message : 'Delete failed.'));
  };

  const lockedCount = echoes.filter((e) => e.locked === true).length;
  const flagged = echoes.filter((e) => echoDefIssues(e, snapshot.echoDefs).length > 0);
  const activeUsageFilter: UsageFilter = usage === null ? 'all' : usageFilter;
  const filtering = sonataFilter !== '' || costFilter !== null || activeUsageFilter !== 'all';
  const visible = filterByUsage(
    echoes.filter(
      (e) => (sonataFilter === '' || e.sonataId === sonataFilter) && (costFilter === null || e.cost === costFilter),
    ),
    usage ?? new Map(),
    activeUsageFilter,
  );
  const filterKey = `${sonataFilter}|${costFilter ?? ''}|${activeUsageFilter}`;
  const fodderShown = activeUsageFilter === 'fodder' ? visible.map((e) => e.id) : [];
  const confirming = fodderConfirm !== null && fodderConfirm.filterKey === filterKey ? fodderConfirm : null;
  const selected = visible.find((e) => e.id === selectedId) ?? null;
  const countByCost = new Map<number, number>();
  for (const echo of echoes) countByCost.set(echo.cost, (countByCost.get(echo.cost) ?? 0) + 1);
  const countBySonata = new Map<string, number>();
  for (const echo of echoes) {
    countBySonata.set(echo.sonataId, (countBySonata.get(echo.sonataId) ?? 0) + 1);
  }

  return (
    <section>
      <PageHeader
        title={
          <>
            Echo Inventory
            {loaded && echoes.length > 0 && !filtering && (
              <span className="text-accent-text"> ({echoes.length})</span>
            )}
            {loaded && echoes.length > 0 && filtering && (
              <span className="text-accent-text"> ({visible.length}/{echoes.length})</span>
            )}
          </>
        }
        description="Your Echo box — every piece the Calculator scores and the optimizer searches."
        actions={
          adding || editing !== null ? undefined : (
            <>
              {import.meta.env.DEV && (
                <>
                  <select
                    aria-label="Seed echo set"
                    value={seedSonata}
                    onChange={(e) => setSeedSonata(e.target.value)}
                    title="Restrict seeded echoes to one Sonata set"
                    className="border-2 border-dashed border-fog bg-panel px-2 py-1.5 text-xs text-fog"
                  >
                    <option value="">Any set</option>
                    {snapshot.sonataSets.map((set) => (
                      <option key={set.id} value={set.id}>
                        {set.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => void seedInventory(30, seedSonata === '' ? undefined : seedSonata)}
                    title="Adds 30 random echoes from synced defs for optimizer testing"
                    className="border-2 border-dashed border-fog px-3 py-1.5 text-sm text-fog hover:bg-panel-2"
                  >
                    Seed 30 random
                  </button>
                </>
              )}
              <button type="button" onClick={() => setAdding(true)} className={btnPrimary}>
                Add Echo
              </button>
              <button
                type="button"
                onClick={() => setScanning(true)}
                disabled={scanning}
                title="Read Echoes from screenshots of the in-game Echo Management panel"
                className={btnOutline}
              >
                Scan screenshots
              </button>
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                title="Import echoes from a WuWa Inventory Kamera JSON file"
                className={btnOutline}
              >
                Import
              </button>
              <button
                type="button"
                onClick={handleExport}
                disabled={echoes.length === 0}
                title={
                  echoes.length === 0
                    ? 'Nothing to export yet'
                    : 'Download the inventory as a Kamera-shaped JSON file'
                }
                className={btnOutline}
              >
                Export
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".json,application/json"
                aria-label="Import echoes file"
                className="sr-only"
                onChange={(e) => {
                  void handleFile(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
            </>
          )
        }
      />

      {transferError !== null && (
        <Alert tone="danger" className="mt-4">
          {transferError}
        </Alert>
      )}

      {scanning && (
        <EchoScanner
          onClose={() => setScanning(false)}
          onImported={(count) => pushToast(`Added ${count} scanned ${count === 1 ? 'echo' : 'echoes'}.`)}
        />
      )}

      {preview !== null && (
        <Window title={`Import ${preview.fileName}`} className="animate-tt-rise mt-6">
          <p className="text-sm text-fog">
            {`${preview.drafts.length} ${preview.drafts.length === 1 ? 'echo' : 'echoes'} ready to add, ${preview.issues.length} skipped. Adding is additive — existing rows are untouched.`}
          </p>
          {preview.drafts.length > 0 && (
            <ul className="mt-2 max-h-40 space-y-0.5 overflow-y-auto text-xs text-fog">
              {preview.drafts.slice(0, 20).map((d, i) => (
                <li key={i}>{`${defName(d.echoDefId)} · ${setName(d.sonataId)} · Lv${d.level}`}</li>
              ))}
              {preview.drafts.length > 20 && <li>{`…and ${preview.drafts.length - 20} more`}</li>}
            </ul>
          )}
          {preview.issues.length > 0 && (
            <ul className="mt-2 max-h-40 space-y-0.5 overflow-y-auto text-xs text-amber">
              {preview.issues.map((issue, i) => (
                <li key={i}>{`Row ${issue.row} (${issue.key}): ${issue.message}`}</li>
              ))}
            </ul>
          )}
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={preview.drafts.length === 0}
              onClick={() => {
                const count = preview.drafts.length;
                void importEchoes(preview.drafts, KAMERA_ORIGIN)
                  .then(() => {
                    setPreview(null);
                    setTransferError(null);
                    pushToast(`Added ${count} ${count === 1 ? 'echo' : 'echoes'} from ${preview.fileName}.`);
                  })
                  .catch((err: unknown) =>
                    setTransferError(err instanceof Error ? err.message : 'Import failed.'),
                  );
              }}
              className={btnPrimary}
            >
              {`Add ${preview.drafts.length} ${preview.drafts.length === 1 ? 'echo' : 'echoes'}`}
            </button>
            <button
              type="button"
              onClick={() => setPreview(null)}
              className={btnGhost}
            >
              Cancel
            </button>
          </div>
        </Window>
      )}

      {flagged.length > 0 && (
        <Alert tone="warning" className="mt-4">
          {`${flagged.length} ${flagged.length === 1 ? 'echo needs' : 'echoes need'} re-linking — press Edit on each flagged row and pick the real Echo. Saving stays blocked until it matches game data.`}
        </Alert>
      )}

      {adding && (
        <Window title="Add Echo" label="Add an echo" className="animate-tt-rise mt-6">
          <EchoForm
            submitLabel="Add Echo"
            onSubmit={async (draft) => {
              await addEcho(draft);
              setAdding(false);
              pushToast('Echo added to the inventory.');
            }}
          />
          <button
            type="button"
            onClick={() => setAdding(false)}
            className={`${btnGhost} mt-2`}
          >
            Cancel
          </button>
        </Window>
      )}

      {editing !== null && (
        <Window title="Edit Echo" bar="b" label="Edit an echo" className="animate-tt-rise mt-6">
          <EchoForm
            key={editing.id}
            initial={toFormValues(editing)}
            submitLabel="Save"
            onSubmit={async (draft) => {
              await updateEcho(editing.id, draft);
              setEditing(null);
              pushToast('Echo saved.');
            }}
          />
          <button
            type="button"
            onClick={() => setEditing(null)}
            className={`${btnGhost} mt-2`}
          >
            Cancel
          </button>
        </Window>
      )}

      {loaded && (
        <div className="mt-6 flex flex-col gap-6 sm:mt-8 lg:flex-row lg:items-center">
          <div className="flex min-w-0 flex-1 items-center gap-4 sm:gap-6">
            <Mascot />
            <SpeechBubble text={inventorySummary({ loaded, echoes, flagged: flagged.length })} />
          </div>
          <div className="grid grid-cols-3 gap-4 sm:flex sm:flex-wrap" role="group" aria-label="Filter by cost">
            {([1, 3, 4] as const).map((cost) => {
              const active = costFilter === cost;
              return (
                <button
                  key={cost}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setCostFilter(active ? null : cost)}
                  className={`px-card px-lift min-h-16 px-3 py-2 text-left sm:min-w-24 ${
                    active ? 'bg-seal-wash' : 'bg-panel hover:bg-panel-2'
                  }`}
                >
                  <span className="flex items-center gap-2 text-xs font-bold text-fog">
                    <CostPips cost={cost} />
                    {cost}-cost
                  </span>
                  <AnimatedNumber
                    value={countByCost.get(cost) ?? 0}
                    className="block font-display text-3xl leading-none font-bold text-ink"
                  />
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="mt-8 grid grid-cols-1 items-start gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Window
          title="Echo Box"
          label="Echo box"
          bodyClassName=""
          actions={
            loaded && echoes.length > 0 ? (
              <div className="flex flex-wrap items-center gap-2">
                <label htmlFor="inventory-usage-filter" className="text-sm font-bold whitespace-nowrap">
                  Usage
                </label>
                <select
                  id="inventory-usage-filter"
                  value={activeUsageFilter}
                  disabled={usage === null}
                  onChange={(e) => setUsageFilter(e.target.value as UsageFilter)}
                  className={`${inputClass} w-auto text-ink`}
                >
                  <option value="all">All echoes</option>
                  <option value="unused">{`Unused (${usageCounts.unused})`}</option>
                  <option value="fodder">{`Safe fodder (${usageCounts.fodder})`}</option>
                </select>
                <label htmlFor="inventory-sonata-filter" className="text-sm font-bold whitespace-nowrap">
                  Sonata set
                </label>
                <select
                  id="inventory-sonata-filter"
                  value={sonataFilter}
                  onChange={(e) => setSonataFilter(e.target.value)}
                  className={`${inputClass} w-auto min-w-44 text-ink`}
                >
                  <option value="">All sets</option>
                  {snapshot.sonataSets.map((set) => (
                    <option key={set.id} value={set.id}>
                      {`${set.name} (${countBySonata.get(set.id) ?? 0})`}
                    </option>
                  ))}
                </select>
              </div>
            ) : undefined
          }
        >
          {loaded && echoes.length > 0 && usage !== null && (
            <p className="border-b-2 border-dashed border-line px-3 py-2 text-xs text-fog">
              <span className="font-bold text-ink">{`${usageCounts.unused} unused`}</span>
              {' — not equipped and in no saved build. '}
              {lockedCount > 0 && (
                <>
                  <span className="font-bold text-ink">{`${lockedCount} locked`}</span>
                  {' — never fodder, can\'t be deleted until unlocked. '}
                </>
              )}
              <span className="font-bold text-accent-text">{`${usageCounts.fodder} safe fodder`}</span>
              {usageCounts.noObjective
                ? ' — needs a saved build with an objective to check against; save one from the optimizer.'
                : usageCounts.unchecked
                  ? ' — a saved build no longer matches current game data, so nothing is marked fodder.'
                  : ` — for every saved build with an objective (${usageCounts.checked}), the optimizer finds an equally good best result without them, even with Echoes equipped elsewhere excluded. Top result at minimum level 0 only; other objectives may still want them.`}
            </p>
          )}
          {fodderShown.length > 0 && (
            <div className="border-b-2 border-dashed border-line px-3 py-2">
              {confirming === null ? (
                <button
                  type="button"
                  onClick={() => setFodderConfirm({ ids: fodderShown, filterKey })}
                  className={btnDangerGhost}
                >
                  {`Delete ${fodderShown.length} safe-fodder ${fodderShown.length === 1 ? 'Echo' : 'Echoes'}`}
                </button>
              ) : (
                <div role="group" aria-label="Confirm bulk delete" className="space-y-2">
                  <p className="text-sm">
                    {`Delete ${confirming.ids.length} safe-fodder ${confirming.ids.length === 1 ? 'Echo' : 'Echoes'}? `}
                    <span className="text-fog">
                      An Undo button appears right after, for a few seconds. It is kept in memory only and is lost if you leave this page or reload.
                    </span>
                  </p>
                  <div className="flex flex-wrap gap-3">
                    <button type="button" onClick={() => deleteSafeFodder(confirming.ids)} className={btnDangerGhost}>
                      {`Delete ${confirming.ids.length} ${confirming.ids.length === 1 ? 'Echo' : 'Echoes'}`}
                    </button>
                    <button
                      type="button"
                      ref={focusOnMount}
                      onClick={() => setFodderConfirm(null)}
                      className={btnGhost}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
          {!loaded ? (
            <div className="p-4">
              <Skeleton lines={4} />
            </div>
          ) : echoes.length === 0 ? (
            <div className="p-4">
              <EmptyState>No echoes yet — add your first Echo above to start building your gear box.</EmptyState>
            </div>
          ) : visible.length === 0 ? (
            <div className="p-4">
              <EmptyState>
                {activeUsageFilter !== 'all'
                  ? 'No echoes match this usage filter — pick All echoes to see the full inventory.'
                  : sonataFilter !== ''
                  ? 'No echoes with this Sonata set — pick All sets to see the full inventory.'
                  : 'No echoes at this cost — tap the cost tile again to clear it.'}
              </EmptyState>
            </div>
          ) : (
            <EchoTable
              echoes={visible}
              snapshot={snapshot}
              usageTags={usageTags}
              selectedId={selected?.id ?? null}
              onSelect={(id) => {
                setSelectedId(id);
                // Below lg the Status window sits under the whole list — bring it into view.
                if (typeof window !== 'undefined' && window.matchMedia?.('(max-width: 1023px)').matches) {
                  requestAnimationFrame(() =>
                    statusRef.current?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' }),
                  );
                }
              }}
            />
          )}
        </Window>
        <div ref={statusRef} className="scroll-mt-4 lg:sticky lg:top-4">
        <EchoStatus
          echo={selected}
          snapshot={snapshot}
          onEdit={setEditing}
          onToggleLock={(echo) => {
            setLocked([echo.id], echo.locked !== true)
              .then(() => pushToast(echo.locked ? 'Echo unlocked.' : 'Echo locked.'))
              .catch((err: unknown) => setTransferError(err instanceof Error ? err.message : 'Could not change the lock.'));
          }}
          onDelete={(id) => {
            removeEcho(id)
              .then((row) => {
                setSelectedId((cur) => (cur === id ? null : cur));
                pushUndoToast('Echo deleted.', [row]);
              })
              .catch((err: unknown) => setTransferError(err instanceof Error ? err.message : 'Delete failed.'));
          }}
        />
        </div>
      </div>
      <ToastStack toasts={toasts} onDismiss={dismissToast} onHold={holdToast} />
    </section>
  );
}
