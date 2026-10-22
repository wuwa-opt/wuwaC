import { useState } from 'react';
import type { Build } from '../../data/schema.ts';
import type { MinStats } from '../../optimizer/minStats.ts';
import { useLibraryStore } from '../../state/library.ts';
import { MIN_STAT_FIELDS, minStatTextsFor, parseMinStatTexts, type MinStatTexts } from '../minStatFields.ts';
import { dismissToast, pushToast, UNDO_TOAST_MS } from '../toasts.ts';
import { btnGhost, btnOutline, btnPrimary, inputClass, labelClass } from './classes.ts';
import { Alert } from './ui.tsx';

const sameMinStats = (a: MinStats | undefined, b: MinStats | undefined): boolean =>
  JSON.stringify(Object.entries(a ?? {}).sort()) === JSON.stringify(Object.entries(b ?? {}).sort());

/**
 * "Edit minimum stats" for a saved own build (never a reference build). Same
 * fields and parsing as the Calculator (`minStatFields.ts`). Saving writes only
 * `Build.minStats`: the saved Echoes and score came from the old minimums and
 * are not recomputed. The Undo toast restores the previous value (absent
 * stays absent) and lives in memory only.
 */
export function MinStatsEditor({ build }: { build: Build }) {
  const updateBuild = useLibraryStore((s) => s.updateBuild);
  const [open, setOpen] = useState(false);
  const [texts, setTexts] = useState<MinStatTexts>({});
  const [error, setError] = useState<string | null>(null);

  if (build.reference !== undefined) return null;

  const begin = (): void => {
    setTexts(minStatTextsFor(build.minStats));
    setError(null);
    setOpen(true);
  };

  const save = (): void => {
    const parsed = parseMinStatTexts(texts);
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    const previous = build.minStats;
    updateBuild(build.id, { minStats: parsed.minStats ?? null })
      .then((row) => {
        setOpen(false);
        setError(null);
        const toastId = pushToast(`Minimum stats updated for “${build.name}”.`, 'success', {
          timeoutMs: UNDO_TOAST_MS,
          action: {
            label: 'Undo',
            onAction: () => {
              dismissToast(toastId);
              const current = useLibraryStore.getState().builds.find((b) => b.id === build.id);
              if (current !== undefined && !sameMinStats(current.minStats, row.minStats)) {
                pushToast(`“${build.name}” changed since, left as is.`, 'info');
                return;
              }
              updateBuild(build.id, { minStats: previous ?? null })
                .then(() => pushToast(`Restored the previous minimum stats for “${build.name}”.`))
                .catch((err: unknown) => pushToast(err instanceof Error ? err.message : 'Undo failed.', 'danger'));
            },
          },
        });
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not save the minimum stats.'));
  };

  if (!open) {
    return (
      <button type="button" onClick={begin} className={`${btnGhost} mt-2 px-2 py-1 text-xs`}>
        Edit minimum stats
      </button>
    );
  }

  return (
    <form
      aria-label={`Edit minimum stats for ${build.name}`}
      className="mt-3 border-2 border-dashed border-line px-3 py-2"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <p className="text-xs text-fog">
        Team allocation and the Safe fodder check use these minimums. Leave a box empty for no minimum; all empty
        removes them.
      </p>
      <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {MIN_STAT_FIELDS.map(({ stat, label, hint }) => (
          <div key={stat}>
            <label htmlFor={`build-${build.id}-min-${stat}`} className={labelClass}>{`Minimum ${label}`}</label>
            <input
              id={`build-${build.id}-min-${stat}`}
              value={texts[stat] ?? ''}
              onChange={(e) => setTexts((m) => ({ ...m, [stat]: e.target.value }))}
              inputMode="decimal"
              className={`${inputClass} mt-0.5`}
            />
            {hint && <p className="mt-0.5 text-xs text-fog">{hint}</p>}
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-fog">
        The saved Echoes and score came from the old minimums and aren't recomputed. Run the Calculator again to
        re-optimize.
      </p>
      {error !== null && (
        <Alert tone="danger" className="mt-2">
          {error}
        </Alert>
      )}
      <div className="mt-2 flex gap-2">
        <button type="submit" className={`${btnPrimary} px-2 py-1 text-xs`}>
          Save minimum stats
        </button>
        <button type="button" onClick={() => setOpen(false)} className={`${btnOutline} px-2 py-1 text-xs`}>
          Cancel
        </button>
      </div>
    </form>
  );
}
