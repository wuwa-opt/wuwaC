import { useRef, useState, type DragEvent } from 'react';
import type { Snapshot } from '../../data/schema.ts';
import { SCAN_ORIGIN } from '../../scanner/draft.ts';
import { reviewRows, summarize, type ReviewRow } from '../../scanner/review.ts';
import { planSync } from '../../scanner/sync.ts';
import { useInventoryStore, type EchoFormDraft, type ScanApplied } from '../../state/inventory.ts';
import { useScanStore } from '../../state/scanStore.ts';
import { useSnapshotStore } from '../../state/snapshotStore.ts';
import { formatStatValue, statLabel, toDisplayValue } from '../format.ts';
import { btnGhost, btnOutline, btnPrimary, btnSm, inputClass, labelClass } from './classes.ts';
import { EchoForm, type EchoFormValues } from './EchoForm.tsx';
import { Alert, CostPips, EmptyState, Window } from './ui.tsx';

/**
 * Echo scanner window: screenshots or a screen recording of the in-game
 * Echo Management detail panel -> OCR (scanner layer, off the main
 * thread) -> review -> import. A rescan updates the inventory instead of
 * adding copies: known Echoes keep their rows, levelled-up ones are updated
 * in place, and the scan's "Equipped by" wins.
 * Rendering and input only; every decision (what a read means, whether a
 * row is importable, which owned Echo it is) comes from `scanner/review.ts`
 * and `scanner/sync.ts`.
 */

const RARITIES = [5, 4, 3, 2] as const;

const STATE_LABEL: Record<ReviewRow['state'], string> = {
  reading: 'Reading…',
  failed: 'Could not read',
  ready: 'Ready',
  review: 'Check',
  fix: 'Needs a fix',
};

const STATE_CLASS: Record<ReviewRow['state'], string> = {
  reading: 'text-fog',
  failed: 'text-ember',
  ready: 'text-tide',
  review: 'text-amber',
  fix: 'text-ember',
};

function name(snapshot: Snapshot, kind: 'echo' | 'sonata' | 'character', id: string | null): string {
  if (id === null) return '—';
  const list = kind === 'echo' ? snapshot.echoDefs : kind === 'sonata' ? snapshot.sonataSets : snapshot.characters;
  return list.find((x) => x.id === id)?.name ?? id;
}

/** Pre-fill the Echo form with whatever was read, so a fix is a small edit. */
function formValues(row: ReviewRow): EchoFormValues {
  const echo = row.item.parse?.echo;
  const source = row.draft ?? null;
  const main = source?.mainStat ?? echo?.mainStat ?? null;
  const second = source?.secondMainStat ?? echo?.secondMainStat ?? null;
  const subs = source?.substats ?? echo?.substats.filter((s) => s !== null) ?? [];
  return {
    echoDefId: source?.echoDefId ?? echo?.echoDefId ?? '',
    label: '',
    sonataId: source?.sonataId ?? echo?.sonataId ?? '',
    level: String(source?.level ?? echo?.level ?? 25),
    rarity: String(row.item.batch.rarity),
    mainStat: main ? { stat: main.stat, valueText: toDisplayValue(main.stat, main.value) } : { stat: 'atkPct', valueText: '' },
    secondMainStat: { valueText: second ? toDisplayValue(second.stat, second.value) : '' },
    substats: subs.map((s) => ({ stat: s.stat, valueText: toDisplayValue(s.stat, s.value) })),
  };
}

export function EchoScanner({ onClose, onApplied }: { onClose: () => void; onApplied: (applied: ScanApplied) => void }) {
  const snapshot = useSnapshotStore((s) => s.snapshot);
  const owned = useInventoryStore((s) => s.echoes);
  const applyScan = useInventoryStore((s) => s.applyScan);
  const {
    batch,
    items,
    engine,
    engineError,
    video,
    lastVideo,
    setBatch,
    addImages,
    addVideo,
    cancelVideo,
    setEquipped,
    setOverride,
    setInclude,
    remove,
    clear,
  } = useScanStore();
  const [fixing, setFixing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  /** "Not in this scan" rows ticked for deletion. */
  const [toDelete, setToDelete] = useState<ReadonlySet<string>>(new Set());
  const fileRef = useRef<HTMLInputElement>(null);

  const rows = reviewRows(items, owned);
  const summary = summarize(rows);
  const { plan, notSeen, bagged, overfull } = planSync(rows, owned, toDelete);
  const baggedFrom = new Map(bagged.map((b) => [b.id, b.from]));
  const deletes = plan.remove.length;
  const updates = plan.upgrade.length + plan.equip.length;
  const applyLabel =
    updates === 0 && deletes === 0
      ? `Add ${plan.add.length} ${plan.add.length === 1 ? 'echo' : 'echoes'}`
      : `Apply: ${[
          plan.add.length > 0 ? `add ${plan.add.length}` : null,
          updates > 0 ? `update ${updates}` : null,
          deletes > 0 ? `delete ${deletes}` : null,
        ]
          .filter((x) => x !== null)
          .join(' · ')}`;
  const inBatch = rows.filter((r) => (r.draft?.sonataId ?? r.item.parse?.echo.sonataId) === batch.sonataId).length;

  const add = (files: FileList | File[] | null): void => {
    const picked = Array.from(files ?? []);
    const images = picked.filter((f) => f.type.startsWith('image/'));
    const videos = picked.filter((f) => f.type.startsWith('video/'));
    if (images.length === 0 && videos.length === 0) return;
    setError(null);
    const fail = (fallback: string) => (err: unknown) => setError(err instanceof Error ? err.message : fallback);
    if (images.length > 0) addImages(images).catch(fail('Could not add those images.'));
    // One recording at a time; walk them in order.
    void videos.reduce<Promise<void>>(
      (prev, v) => prev.then(() => addVideo(v)).catch(fail('Could not scan that recording.')),
      Promise.resolve(),
    );
  };

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setDragging(false);
    add(e.dataTransfer.files);
  };

  const apply = (): void => {
    const applied = rows.filter((r) => r.included).map((r) => r.item.id);
    applyScan(plan, SCAN_ORIGIN)
      .then((result) => {
        clear(applied);
        setToDelete(new Set());
        setError(null);
        onApplied(result);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Import failed.'));
  };

  return (
    <Window
      title="Scan Echoes from screenshots"
      label="Scan echoes"
      className="animate-tt-rise mt-6"
      actions={
        <button type="button" onClick={onClose} className={`${btnGhost} ${btnSm}`}>
          Close
        </button>
      }
    >
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={dragging ? 'outline-2 outline-dashed outline-offset-4 outline-outline' : ''}
      >
        <ol className="list-decimal space-y-0.5 pl-5 text-sm text-fog">
          <li>
            In game, open Echo Management → Filter, and pick one Sonata set (and 5-Star). The panel shows the set only as
            an icon, so the set is read from the filter's tag at the bottom left of the grid. You can change the filter
            during a recording.
          </li>
          <li>
            Click through the Echoes while recording the whole game window (or screenshot each one), then drop the
            recording or the images here. Pause about half a second on each Echo.
          </li>
          <li>Only if your pictures leave out the filter tag (a crop of the right-hand panel), pick the set here.</li>
        </ol>

        <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem_10rem_auto] sm:items-end">
          <div>
            <label htmlFor="scan-sonata" className={labelClass}>
              Sonata set
            </label>
            <select
              id="scan-sonata"
              value={batch.sonataId}
              onChange={(e) => setBatch({ sonataId: e.target.value })}
              className={inputClass}
            >
              <option value="">Read from the in-game filter</option>
              {snapshot.sonataSets.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="scan-rarity" className={labelClass}>
              Rarity
            </label>
            <select
              id="scan-rarity"
              value={batch.rarity}
              onChange={(e) => setBatch({ rarity: Number(e.target.value) })}
              className={inputClass}
            >
              {RARITIES.map((r) => (
                <option key={r} value={r}>{`${r}-Star`}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="scan-expected" className={labelClass}>
              Count in filter (optional)
            </label>
            <input
              id="scan-expected"
              type="number"
              min={0}
              inputMode="numeric"
              value={batch.expected ?? ''}
              onChange={(e) => setBatch({ expected: e.target.value === '' ? null : Number(e.target.value) })}
              className={inputClass}
            />
          </div>
          <div>
            <button
              type="button"
              title="Choose screenshots or a screen recording to scan"
              onClick={() => fileRef.current?.click()}
              className={btnPrimary}
            >
              Add screenshots or video
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*,video/*"
              multiple
              aria-label="Echo screenshots or recording"
              className="sr-only"
              onChange={(e) => {
                add(e.target.files);
                e.target.value = '';
              }}
            />
          </div>
        </div>

        {video !== null && (
          <Alert tone="info" role="status" className="mt-4">
            <span className="flex flex-wrap items-center justify-between gap-2">
              <span>
                {`Scanning ${video.fileName}: ${video.t.toFixed(1)} / ${video.duration > 0 ? video.duration.toFixed(1) : '…'} s · ${video.found} ${video.found === 1 ? 'Echo' : 'Echoes'} found`}
              </span>
              <button type="button" onClick={cancelVideo} className={`${btnGhost} ${btnSm}`}>
                Cancel
              </button>
            </span>
          </Alert>
        )}
        {lastVideo !== null && video === null && (
          <Alert tone={lastVideo.error !== null ? 'danger' : 'info'} role="status" className="mt-4">
            {[
              `${lastVideo.fileName}: ${lastVideo.found} Echo ${lastVideo.found === 1 ? 'panel' : 'panels'} found`,
              lastVideo.skipped > 0 ? `${lastVideo.skipped} ${lastVideo.skipped === 1 ? 'frame' : 'frames'} without an Echo panel skipped` : null,
              lastVideo.improved > 0 ? `${lastVideo.improved} read better from a later frame` : null,
              lastVideo.cancelled ? 'cancelled' : null,
              lastVideo.error,
            ]
              .filter((x) => x !== null)
              .join(' · ')}
          </Alert>
        )}

        {engine === 'loading' && (
          <Alert tone="info" role="status" className="mt-4">
            Loading the text reader (about 6 MB, downloaded once and kept for offline use)…
          </Alert>
        )}
        {engineError !== null && (
          <Alert tone="danger" className="mt-4">{`The text reader failed to load: ${engineError}`}</Alert>
        )}
        {error !== null && (
          <Alert tone="danger" className="mt-4">
            {error}
          </Alert>
        )}

        {items.length === 0 ? (
          <div className="mt-4">
            <EmptyState>Nothing scanned yet. Screenshots and recordings are read on this device and never uploaded.</EmptyState>
          </div>
        ) : (
          <>
            <p role="status" className="mt-4 text-sm text-fog">
              {[
                `${summary.total} scanned`,
                summary.reading > 0 ? `${summary.reading} reading` : null,
                `${summary.ready} ready`,
                summary.review > 0 ? `${summary.review} to check` : null,
                summary.fix > 0 ? `${summary.fix} to fix` : null,
                summary.failed > 0 ? `${summary.failed} unreadable` : null,
                summary.known > 0 ? `${summary.known} already in your inventory` : null,
                summary.updates > 0 ? `${summary.updates} to update` : null,
                summary.repeats > 0 ? `${summary.repeats} scanned twice` : null,
              ]
                .filter((x) => x !== null)
                .join(' · ')}
            </p>
            {batch.expected !== null && batch.sonataId !== '' && (
              <p className={`text-sm font-bold ${inBatch === batch.expected ? 'text-tide' : inBatch > batch.expected ? 'text-ember' : 'text-fog'}`}>
                {`${name(snapshot, 'sonata', batch.sonataId)}: ${inBatch} / ${batch.expected}`}
                {inBatch > batch.expected && ' — more than the filter shows; is the in-game filter still on this set?'}
              </p>
            )}

            <ul className="mt-3 space-y-2">
              {rows.map((row, index) => (
                <ScanRow
                  key={row.item.id}
                  index={index}
                  row={row}
                  snapshot={snapshot}
                  fixing={fixing === row.item.id}
                  onFix={() => setFixing(fixing === row.item.id ? null : row.item.id)}
                  onFixed={(draft) => {
                    setOverride(row.item.id, { ...draft, equippedTo: row.item.parse?.echo.equippedTo ?? null });
                    setFixing(null);
                  }}
                  onInclude={(v) => setInclude(row.item.id, v)}
                  onEquip={(id) => setEquipped(row.item.id, id)}
                  onRemove={() => remove(row.item.id)}
                />
              ))}
            </ul>

            {overfull.map((o) => (
              <Alert key={o.characterId} tone="warning" className="mt-4">
                {`This scan shows ${o.count} Echoes equipped by ${name(snapshot, 'character', o.characterId)}, but a character wears 5 at most. One of the "Equipped by" lines was misread, or the gear changed during the recording. Untick the wrong rows.`}
              </Alert>
            ))}

            {notSeen.length > 0 && (
              <details className="mt-4 border-2 border-line-strong bg-panel-2 p-2 text-sm">
                <summary className="cursor-pointer font-bold text-ink">
                  {`Not in this scan: ${notSeen.length} ${notSeen.length === 1 ? 'Echo' : 'Echoes'} in your inventory`}
                  {deletes > 0 ? ` · ${deletes} to delete` : ''}
                  {bagged.length > 0 ? ` · ${bagged.length} back to the bag` : ''}
                </summary>
                <p className="mt-2 text-xs text-fog">
                  Echoes of the Sonata sets this scan covered that no row matched: gone in game, or just not clicked.
                  Nothing is deleted unless you tick it.
                </p>
                {summary.fix + summary.reading > 0 && (
                  <p className="mt-1 text-xs text-amber">
                    Some rows above are not read yet or need a fix; their Echoes may be listed here.
                  </p>
                )}
                <ul className="mt-2 space-y-1">
                  {notSeen.map((e) => {
                    const from = baggedFrom.get(e.id);
                    return (
                      <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                        <span className="font-bold text-ink">{e.label ?? name(snapshot, 'echo', e.echoDefId)}</span>
                        <span className="text-fog">{`+${e.level} · ${statLabel(e.mainStat.stat)} ${formatStatValue(e.mainStat.stat, e.mainStat.value)}`}</span>
                        {from !== undefined ? (
                          <span className="text-amber">{`back to the bag: ${name(snapshot, 'character', from)} wears 5 scanned Echoes`}</span>
                        ) : (
                          e.equippedTo != null && <span className="text-fog">{`Equipped by ${name(snapshot, 'character', e.equippedTo)}`}</span>
                        )}
                        <label className="ml-auto flex items-center gap-1 font-bold text-ink">
                          <input
                            type="checkbox"
                            checked={toDelete.has(e.id) && e.locked !== true}
                            disabled={e.locked === true}
                            onChange={(ev) =>
                              setToDelete((cur) => {
                                const next = new Set(cur);
                                if (ev.target.checked) next.add(e.id);
                                else next.delete(e.id);
                                return next;
                              })
                            }
                          />
                          {e.locked === true ? 'Locked' : 'Delete'}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </details>
            )}

            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={plan.add.length + updates + deletes === 0}
                onClick={apply}
                className={btnPrimary}
              >
                {applyLabel}
              </button>
              <button type="button" onClick={() => clear()} className={btnOutline}>
                Clear list
              </button>
            </div>
          </>
        )}
      </div>
    </Window>
  );
}

function ScanRow({
  index,
  row,
  snapshot,
  fixing,
  onFix,
  onFixed,
  onInclude,
  onEquip,
  onRemove,
}: {
  /** 0-based position in the list; shown as "#n" so repeats can point at their first copy. */
  index: number;
  row: ReviewRow;
  snapshot: Snapshot;
  fixing: boolean;
  onFix: () => void;
  onFixed: (draft: EchoFormDraft) => void;
  onInclude: (include: boolean) => void;
  onEquip: (characterId: string | null) => void;
  onRemove: () => void;
}) {
  const { item, draft, state } = row;
  const echo = item.parse?.echo;
  const shown = draft ?? null;
  const defId = shown?.echoDefId ?? echo?.echoDefId ?? null;
  const cost = shown?.cost ?? echo?.cost ?? null;
  const level = shown?.level ?? echo?.level ?? null;
  const main = shown?.mainStat ?? echo?.mainStat ?? null;
  const second = shown?.secondMainStat ?? echo?.secondMainStat ?? null;
  const subs = shown?.substats ?? echo?.substats ?? [];
  const equipped = shown?.equippedTo ?? echo?.equippedTo ?? null;
  const sonataId = shown?.sonataId ?? echo?.sonataId ?? null;
  const flags = item.override === undefined ? item.parse?.flags ?? [] : [];
  const title = defId === null ? item.fileName : name(snapshot, 'echo', defId);

  return (
    <li className="border-2 border-line-strong bg-panel-2 p-2">
      <div className="flex gap-3">
        {item.thumbUrl !== null ? (
          <img src={item.thumbUrl} alt={`Scanned panel: ${title}`} className="h-28 w-auto shrink-0 border-2 border-outline" />
        ) : (
          <div aria-hidden="true" className="h-28 w-20 shrink-0 border-2 border-line-strong bg-panel-3" />
        )}
        <div className="min-w-0 flex-1 text-sm">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-xs text-fog tnum">{`#${index + 1}`}</span>
            <span className="font-bold text-ink">{title}</span>
            {cost !== null && (
              <span className="flex items-center gap-1 text-xs text-fog">
                <CostPips cost={cost} />
                {`${cost}-cost`}
              </span>
            )}
            {level !== null && <span className="text-xs text-fog">{`+${level}`}</span>}
            {item.status === 'done' && (
              <span className="text-xs text-fog">{sonataId === null ? 'Sonata set ?' : name(snapshot, 'sonata', sonataId)}</span>
            )}
            <span className={`text-xs font-bold ${STATE_CLASS[state]}`}>{STATE_LABEL[state]}</span>
            {row.known && <span className="text-xs text-fog">already in inventory</span>}
            {row.match?.kind === 'upgrade' && row.owned !== null && (
              <span className="text-xs text-fog">{`levelled up from your +${row.owned.level} copy`}</span>
            )}
          </div>
          {row.known && row.change === 'update' && row.owned !== null && (
            <p className="mt-1 text-xs text-fog">
              {`Your inventory has it ${row.owned.equippedTo == null ? 'unequipped' : `on ${name(snapshot, 'character', row.owned.equippedTo)}`}; this scan updates that.`}
            </p>
          )}
          {row.match?.kind === 'new' && row.match.upgradeCandidates > 0 && (
            <p className="mt-1 text-xs text-amber">
              {`It may be a levelled-up copy of ${row.match.upgradeCandidates === 1 ? 'an Echo' : `one of ${row.match.upgradeCandidates} Echoes`} in your inventory, but which one is not certain, so it is added as new. The old ${row.match.upgradeCandidates === 1 ? 'one is' : 'ones are'} listed under "Not in this scan".`}
            </p>
          )}
          {row.equipConflict ? (
            <p className="mt-1 text-xs text-amber">
              Another row has the same rolls but a different “Equipped by”, so one of them was misread. Tick the right one.
            </p>
          ) : (
            row.repeatOf !== null && (
              <p className="mt-1 text-xs text-amber">
                {`Same rolls as #${row.repeatOf + 1} — probably clicked twice. Tick Add only if you own both.`}
              </p>
            )
          )}

          {item.status === 'failed' && <p className="mt-1 text-xs text-ember">{item.error}</p>}

          {item.status === 'done' && (
            <>
              <p className="mt-1 text-xs text-ink tnum">
                {[main, second]
                  .filter((s) => s !== null)
                  .map((s) => `${statLabel(s.stat)} ${formatStatValue(s.stat, s.value)}`)
                  .join(' · ')}
              </p>
              <p className="text-xs text-fog tnum">
                {subs.map((s, i) => (s === null ? `#${i + 1} ?` : `${statLabel(s.stat)} ${formatStatValue(s.stat, s.value)}`)).join(' · ')}
              </p>
              {echo?.equippedCandidates !== undefined && item.override === undefined ? (
                <label className="mt-1 flex items-center gap-2 text-xs text-amber">
                  Equipped by
                  <select
                    value=""
                    onChange={(e) => onEquip(e.target.value === '-' ? null : e.target.value)}
                    className={`${inputClass} w-auto min-h-7 py-0.5 text-xs`}
                  >
                    <option value="" disabled>
                      which one?
                    </option>
                    {echo.equippedCandidates.map((id) => (
                      <option key={id} value={id}>
                        {name(snapshot, 'character', id)}
                      </option>
                    ))}
                    <option value="-">leave unequipped</option>
                  </select>
                </label>
              ) : (
                equipped !== null && <p className="text-xs text-fog">{`Equipped by ${name(snapshot, 'character', equipped)}`}</p>
              )}
              {flags.length > 0 && (
                <ul className="mt-1 space-y-0.5 text-xs">
                  {flags.map((f, i) => (
                    <li key={i} className={f.severity === 'error' ? 'text-ember' : 'text-amber'}>
                      {`${f.severity === 'error' ? '✕' : '!'} ${f.message}`}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {row.change !== 'none' && (
            <label className="flex items-center gap-1 text-xs font-bold text-ink">
              <input
                type="checkbox"
                checked={row.included}
                disabled={draft === null}
                onChange={(e) => onInclude(e.target.checked)}
              />
              {row.change === 'update' ? 'Update' : 'Add'}
            </label>
          )}
          {item.status === 'done' && (
            <button type="button" onClick={onFix} className={`${btnGhost} ${btnSm}`}>
              {fixing ? 'Cancel' : state === 'fix' ? 'Fix' : 'Edit'}
            </button>
          )}
          <button type="button" onClick={onRemove} className={`${btnGhost} ${btnSm}`}>
            Remove
          </button>
        </div>
      </div>
      {fixing && (
        <div className="mt-3 border-t-2 border-line-strong pt-3">
          <EchoForm key={item.id} initial={formValues(row)} submitLabel="Use these values" onSubmit={(d) => onFixed(d)} />
        </div>
      )}
    </li>
  );
}
