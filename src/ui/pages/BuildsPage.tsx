import { useEffect, useMemo, useState } from 'react';
import type { Build, SharedBuild } from '../../data/schema.ts';
import { useCalculatorStore } from '../../state/calculator.ts';
import { useInventoryStore } from '../../state/inventory.ts';
import { serializeBuilds, useLibraryStore } from '../../state/library.ts';
import { useRosterStore } from '../../state/roster.ts';
import { useSnapshotStore } from '../../state/snapshotStore.ts';
import {
  decodeShareLink,
  encodeSharedBuild,
  isReferenceBuild,
  referenceBuildFrom,
  sharedBuildFromLibrary,
  sharedCalculatorDraft,
  viewSharedBuild,
} from '../../state/share.ts';
import { useAppStore } from '../../state/store.ts';
import { downloadBlob } from '../download.ts';
import { GameIcon } from '../components/GameIcon.tsx';
import { BuildDetail } from '../components/BuildDetail.tsx';
import { ReferenceBuildDetail } from '../components/ReferenceBuildDetail.tsx';
import { missingSlots } from '../echoDisplay.ts';
import { minStatTextsFor } from '../minStatFields.ts';
import { SharedBuildCard } from '../components/SharedBuildCard.tsx';
import { btnDangerGhost, btnGhost, btnOutline, btnPrimary, inputClass, labelClass } from '../components/classes.ts';
import { Skeleton } from '../components/feedback.tsx';
import { pushToast } from '../toasts.ts';
import { Alert, EmptyState, PageHeader, Window } from '../components/ui.tsx';

type SharedState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'v1'; build: Build }
  | { kind: 'v2'; shared: SharedBuild };

export function BuildsPage() {
  const builds = useLibraryStore((s) => s.builds);
  const loaded = useLibraryStore((s) => s.loaded);
  const load = useLibraryStore((s) => s.load);
  const removeBuild = useLibraryStore((s) => s.removeBuild);
  const importBuilds = useLibraryStore((s) => s.importBuilds);
  const snapshot = useSnapshotStore((s) => s.snapshot);
  const ensureSnapshotLoaded = useSnapshotStore((s) => s.ensureLoaded);
  const inventory = useInventoryStore((s) => s.echoes);
  const inventoryLoaded = useInventoryStore((s) => s.loaded);
  const loadInventory = useInventoryStore((s) => s.load);
  const rosterEntries = useRosterStore((s) => s.entries);
  const rosterLoaded = useRosterStore((s) => s.loaded);
  const loadRoster = useRosterStore((s) => s.load);
  const loadSharedDraft = useCalculatorStore((s) => s.loadSharedDraft);
  const setMinStatTexts = useCalculatorStore((s) => s.setMinStatTexts);
  const setActiveSection = useAppStore((s) => s.setActiveSection);

  const shareLink = useAppStore((s) => s.shareLink);
  const resolveShareLink = useAppStore((s) => s.resolveShareLink);

  const [paste, setPaste] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Per-build "include rotation" toggle for Copy link (default off: it's large). */
  const [withRotation, setWithRotation] = useState<Record<string, boolean>>({});
  /** Builds whose detail (Echoes, weapon, run settings) is open. */
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);
  useEffect(() => {
    void ensureSnapshotLoaded();
  }, [ensureSnapshotLoaded]);
  // Copy link reads the sender's own Echoes and roster context.
  useEffect(() => {
    if (!inventoryLoaded) void loadInventory();
  }, [inventoryLoaded, loadInventory]);
  useEffect(() => {
    if (!rosterLoaded) void loadRoster();
  }, [rosterLoaded, loadRoster]);

  // A `#b=` link only previews; nothing is written until the user acts on it.
  const [decoded, setDecoded] = useState<{ link: string; state: SharedState } | null>(null);
  useEffect(() => {
    if (shareLink === null) return;
    let live = true;
    decodeShareLink(shareLink).then(
      (result) => {
        if (!live) return;
        setDecoded({
          link: shareLink,
          state: result.version === 1 ? { kind: 'v1', build: result.build } : { kind: 'v2', shared: result.shared },
        });
      },
      (err: unknown) => {
        if (!live) return;
        setDecoded({
          link: shareLink,
          state: {
            kind: 'error',
            message: `Could not open the shared build: ${err instanceof Error ? err.message : String(err)}`,
          },
        });
      },
    );
    return () => {
      live = false;
    };
  }, [shareLink]);
  const shared: SharedState | null =
    shareLink === null ? null : decoded?.link === shareLink ? decoded.state : { kind: 'loading' };
  const sharedPayload = shared?.kind === 'v2' ? shared.shared : null;
  const sharedView = useMemo(
    () => (sharedPayload === null ? null : viewSharedBuild(sharedPayload, snapshot)),
    [sharedPayload, snapshot],
  );

  const handleImportShared = async (build: Build): Promise<void> => {
    setError(null);
    try {
      const { added, skipped } = await importBuilds([build]);
      setNotice(
        added === 1
          ? `Imported shared build “${build.name}”.`
          : `Build already in the library (skipped ${skipped}).`,
      );
      resolveShareLink();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // The payload is stored on the build itself — nothing enters ownedEchoes.
  const handleSaveReference = async (payload: SharedBuild): Promise<void> => {
    setError(null);
    try {
      const { added } = await importBuilds([referenceBuildFrom(payload)]);
      setNotice(
        added === 1
          ? `Saved “${payload.name}” as a reference build.`
          : `“${payload.name}” is already saved as a reference build.`,
      );
      resolveShareLink();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // Loads an unsaved Calculator draft; the roster is never written. The link
  // stays pending, so coming back to Builds still offers Save / Dismiss.
  const handleOptimize = (payload: SharedBuild): void => {
    const character = snapshot.characters.find((c) => c.id === payload.character.id);
    if (!character) return;
    const draft = sharedCalculatorDraft(payload, character);
    loadSharedDraft(draft);
    // A v3 link states the sender's minimums, so absent means none: clear the boxes.
    // A v2 link says nothing about them, so the boxes stay as they are.
    if (payload.v === 3) setMinStatTexts(minStatTextsFor(draft.minStats));
    if (draft.skippedBlocks > 0) {
      pushToast(`Skipped ${draft.skippedBlocks} rotation step${draft.skippedBlocks === 1 ? '' : 's'} your game data doesn’t know.`);
    }
    setActiveSection('calculator');
  };

  const characterName = (id: string): string =>
    snapshot.characters.find((c) => c.id === id)?.name ?? id;

  const weaponName = (id: string): string =>
    snapshot.weapons.find((w) => w.id === id)?.name ?? id;

  const handleExport = (): void => {
    downloadBlob(new Blob([serializeBuilds(builds)], { type: 'application/json' }), 'wuwa-builds.json');
  };

  const handleImport = async (): Promise<void> => {
    setError(null);
    setNotice(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(paste);
    } catch {
      setError('Pasted text is not valid JSON.');
      return;
    }
    const list = Array.isArray(parsed) ? parsed : [parsed];
    try {
      const { added, skipped } = await importBuilds(list);
      setNotice(`Imported ${added} build${added === 1 ? '' : 's'}${skipped > 0 ? ` (${skipped} skipped as duplicates)` : ''}.`);
      setPaste('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCopyLink = async (buildId: string): Promise<void> => {
    setError(null);
    const build = builds.find((b) => b.id === buildId);
    if (!build) return;
    try {
      const payload = sharedBuildFromLibrary({
        build,
        roster: rosterEntries.find((e) => e.characterId === build.characterId),
        inventory,
        includeObjective: withRotation[build.id] === true,
      });
      const url = `${window.location.href.split('#')[0]}${await encodeSharedBuild(payload)}`;
      if (!navigator.clipboard) throw new Error('Clipboard is unavailable in this browser.');
      await navigator.clipboard.writeText(url);
      setNotice(`Copied share link for “${build.name}”.`);
    } catch (err) {
      setError(`Could not make a link for “${build.name}”: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <section>
      <PageHeader
        title="Build Library"
        description="Winning optimizer results, saved with their full rotation spec — exportable and shareable by link."
        actions={
          builds.length > 0 ? (
            <button type="button" onClick={handleExport} className={btnOutline}>
              Export all as JSON
            </button>
          ) : undefined
        }
      />

      {error && (
        <Alert tone="danger" className="mt-4">
          {error}
        </Alert>
      )}
      {notice && (
        <Alert tone="success" role="status" className="mt-4">
          {notice}
        </Alert>
      )}

      {shared?.kind === 'loading' && (
        <p role="status" className="mt-4 text-sm text-fog">
          Opening shared build…
        </p>
      )}
      {shared?.kind === 'error' && (
        <Alert tone="danger" className="mt-4">
          <span>{shared.message}</span>{' '}
          <button type="button" onClick={resolveShareLink} className={`${btnGhost} px-2 py-1 text-xs`}>
            Dismiss
          </button>
        </Alert>
      )}
      {shared?.kind === 'v2' && sharedView !== null && (
        <Window label="Shared build" title="Shared build" bar="b" className="mt-4">
          <SharedBuildCard shared={shared.shared} view={sharedView} snapshot={snapshot} />
          <p className="mt-3 text-xs text-fog">
            Opened from a share link. Nothing is saved unless you choose to: a reference build keeps these Echoes
            with the build only, never in your inventory.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={!loaded}
              onClick={() => void handleSaveReference(shared.shared)}
              className={btnPrimary}
            >
              Save as reference
            </button>
            <button
              type="button"
              disabled={sharedView.character === undefined || sharedView.weapon === undefined}
              onClick={() => handleOptimize(shared.shared)}
              className={btnOutline}
            >
              Optimize with my Echoes
            </button>
            <button type="button" onClick={resolveShareLink} className={btnOutline}>
              Dismiss
            </button>
          </div>
        </Window>
      )}
      {shared?.kind === 'v1' && (
        <Window label="Shared build" title="Shared build" bar="b" className="mt-4">
          <div className="flex flex-wrap items-center gap-3">
            <GameIcon
              name={characterName(shared.build.characterId)}
              iconUrl={snapshot.characters.find((c) => c.id === shared.build.characterId)?.iconUrl}
            />
            <dl className="min-w-0 flex-1 basis-52 text-sm">
              <dt className="sr-only">Name</dt>
              <dd className="truncate font-display text-xl leading-tight font-semibold text-ink">
                {shared.build.name}
              </dd>
              <dt className="sr-only">Character and weapon</dt>
              <dd className="mt-0.5 text-xs text-fog">
                {characterName(shared.build.characterId)} · {weaponName(shared.build.weaponId)}
              </dd>
              {shared.build.score !== undefined && (
                <>
                  <dt className="sr-only">Score</dt>
                  <dd className="mt-1 text-xs text-fog tnum">
                    <span className="px-tag px-1.5 py-px text-xs">score {shared.build.score.toFixed(1)}</span>
                  </dd>
                </>
              )}
            </dl>
          </div>
          <p className="mt-3 text-xs text-fog">
            Opened from an older share link. Its Echoes are the sender’s and won’t match your inventory.
            Nothing is saved unless you import it.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={!loaded}
              onClick={() => void handleImportShared(shared.build)}
              className={btnPrimary}
            >
              Import shared build
            </button>
            <button type="button" onClick={resolveShareLink} className={btnOutline}>
              Dismiss
            </button>
          </div>
        </Window>
      )}

      <div className="mt-4">
        {!loaded ? (
          <Skeleton lines={3} />
        ) : builds.length === 0 ? (
          <EmptyState>No saved builds yet — save one from the Calculator results.</EmptyState>
        ) : (
          <ul className="space-y-2">
            {builds.map((build) => {
              const own = !isReferenceBuild(build);
              const open = expanded[build.id] === true;
              // Only judged once the inventory is in; before that nothing is "missing".
              const missing = own && inventoryLoaded ? missingSlots(build, inventory) : [];
              return (
              <li key={build.id} className="animate-tt-fade row-sweep px-card bg-panel px-4 py-3 transition-terminal">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex min-w-0 flex-1 basis-52 items-center gap-3">
                    <GameIcon
                      name={characterName(build.characterId)}
                      iconUrl={snapshot.characters.find((c) => c.id === build.characterId)?.iconUrl}
                    />
                    <div className="min-w-0">
                      <p className="truncate font-display text-xl leading-tight font-semibold text-ink">{build.name}</p>
                      <p className="mt-0.5 text-xs text-fog tnum">
                        {characterName(build.characterId)}
                        {isReferenceBuild(build) && (
                          <>
                            {' · '}
                            <span className="px-tag px-1.5 py-px text-xs">reference</span>
                          </>
                        )}
                        {build.score !== undefined && (
                          <>
                            {' · '}
                            <span className="px-tag px-1.5 py-px text-xs">
                              score {build.score.toFixed(1)}
                            </span>
                          </>
                        )}
                        {missing.length > 0 && (
                          <>
                            {' · '}
                            <span
                              className="px-tag px-1.5 py-px text-xs text-ember-ink"
                              title={`Deleted from your inventory: ${missing.map((slot) => `slot ${slot + 1}`).join(', ')}`}
                            >
                              {missing.length} Echo{missing.length === 1 ? '' : 'es'} missing
                            </span>
                          </>
                        )}
                      </p>
                    </div>
                  </div>
                  <div className="ml-auto flex shrink-0 flex-wrap items-center gap-1">
                    <label
                      className="flex items-center gap-1 px-1 text-xs text-fog"
                      title={build.objective ? 'Adds the full rotation / objective to the link (larger link)' : 'This build has no saved rotation'}
                    >
                      <input
                        type="checkbox"
                        checked={withRotation[build.id] === true}
                        disabled={!build.objective}
                        onChange={(e) => setWithRotation((m) => ({ ...m, [build.id]: e.target.checked }))}
                        aria-label={`Include rotation in the link for ${build.name}`}
                      />
                      + rotation
                    </label>
                    <button
                      type="button"
                      aria-expanded={open}
                      aria-controls={`build-detail-${build.id}`}
                      aria-label={`${open ? 'Hide' : 'Show'} details for ${build.name}`}
                      onClick={() => setExpanded((m) => ({ ...m, [build.id]: !open }))}
                      className={`${btnGhost} px-2 py-1 text-xs`}
                    >
                      {open ? 'Hide details' : 'Details'}
                    </button>
                    <button
                      type="button"
                      disabled={!inventoryLoaded || !rosterLoaded}
                      onClick={() => void handleCopyLink(build.id)}
                      className={`${btnGhost} px-2 py-1 text-xs`}
                    >
                      Copy link
                    </button>
                    <button
                      type="button"
                      onClick={() => void removeBuild(build.id).then(() => pushToast(`Build “${build.name}” deleted.`))}
                      className={`${btnDangerGhost} px-2 py-1 text-xs`}
                    >
                      Delete {build.name}
                    </button>
                  </div>
                </div>
                {open &&
                  (build.reference !== undefined ? (
                    <ReferenceBuildDetail
                      id={`build-detail-${build.id}`}
                      build={build}
                      reference={build.reference}
                      snapshot={snapshot}
                    />
                  ) : (
                    <BuildDetail
                      id={`build-detail-${build.id}`}
                      build={build}
                      inventory={inventory}
                      inventoryLoaded={inventoryLoaded}
                      snapshot={snapshot}
                    />
                  ))}
              </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="mt-6 px-card bg-panel p-4">
        <label htmlFor="build-import" className={labelClass}>
          Paste build JSON to import (single build or array)
        </label>
        <textarea
          id="build-import"
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          rows={4}
          className={`${inputClass} mt-1.5 text-xs`}
        />
        <button
          type="button"
          onClick={() => void handleImport()}
          className={`${btnPrimary} mt-3`}
        >
          Import
        </button>
      </div>
    </section>
  );
}
