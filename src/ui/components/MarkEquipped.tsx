import { useMemo, useState } from 'react';
import type { AllocationResult } from '../../optimizer/allocate.ts';
import { planEquip, type EquipCount } from '../../optimizer/equip.ts';
import type { OwnedEcho } from '../../data/schema.ts';
import { useInventoryStore, type EquipAssignment } from '../../state/inventory.ts';
import { btnGhost, btnOutline, btnPrimary } from './classes.ts';
import { Alert } from './ui.tsx';

/** What was written, for the page's Undo. */
export interface MarkedEquipped {
  /** Previous `equippedTo` of every row that changed. */
  previous: EquipAssignment[];
  /** What those rows were set to. */
  applied: EquipAssignment[];
}

/** Stable ref callback: focus the safe default of the confirm step when it appears. */
function focusOnMount(el: HTMLElement | null): void {
  el?.focus();
}

const noun = (n: number): string => `${n} ${n === 1 ? 'Echo' : 'Echoes'}`;

/**
 * "Mark as equipped" for a team allocation preview. `equippedTo` mirrors the
 * game and the app can't change the game, so this only RECORDS a re-gear the
 * user has done, or is about to do, in the game. A confirm step lists exactly
 * what changes first; Cancel is focused by default.
 */
export function MarkEquipped({
  allocation,
  echoes,
  stale,
  characterName,
  onMarked,
}: {
  allocation: AllocationResult;
  echoes: readonly OwnedEcho[];
  /** The preview no longer matches the inputs: marking is disabled. */
  stale: boolean;
  characterName: (id: string) => string;
  onMarked?: (marked: MarkedEquipped) => void;
}) {
  const plan = useMemo(() => planEquip(allocation, echoes), [allocation, echoes]);
  // The change list the user was shown; only valid while it is still the live plan.
  const [confirmed, setConfirmed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirming = !stale && confirmed === plan.signature && plan.changes.length > 0;

  const list = (counts: readonly EquipCount[]): string =>
    counts.map((c) => `${characterName(c.characterId)} ×${c.count}`).join(', ');

  const handleMark = (): void => {
    if (busy) return;
    // Recompute now: the render the user confirmed on may be stale.
    const fresh = planEquip(allocation, useInventoryStore.getState().echoes);
    setConfirmed(null);
    if (fresh.signature !== plan.signature) {
      setError('The Echo records changed since you opened this. Nothing was changed — review it and try again.');
      return;
    }
    setBusy(true);
    setError(null);
    useInventoryStore
      .getState()
      .reassignEquipped(fresh.changes)
      .then((previous) => onMarked?.({ previous, applied: fresh.changes }))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not update the Echo records.'))
      .finally(() => setBusy(false));
  };

  const assignedTotal = plan.assigned.reduce((sum, c) => sum + c.count, 0);
  const takenTotal = plan.takenFrom.reduce((sum, c) => sum + c.count, 0);

  return (
    <div className="space-y-2" role="group" aria-label="Mark as equipped">
      {confirming ? (
        <div role="group" aria-label="Confirm mark as equipped" className="space-y-2 border-2 border-line bg-canvas p-3">
          <p className="text-sm">
            <strong>Mark these Echoes as equipped?</strong>{' '}
            <span className="text-fog">
              This updates WuWaOpt&apos;s record only. Equip these in the game too. An Undo button appears right
              after, for a few seconds; it is kept in memory only and is lost if you leave this page or reload.
            </span>
          </p>
          <ul className="list-disc space-y-0.5 pl-5 text-sm">
            <li>{`${noun(assignedTotal)} assigned: ${list(plan.assigned)}.`}</li>
            {takenTotal > 0 && <li>{`${noun(takenTotal)} taken from other characters: ${list(plan.takenFrom)}.`}</li>}
            {plan.unequipped > 0 && <li>{`${noun(plan.unequipped)} unequipped, back to the bag.`}</li>}
            {plan.unchanged > 0 && <li className="text-fog">{`${noun(plan.unchanged)} already recorded this way.`}</li>}
          </ul>
          <div className="flex flex-wrap gap-3">
            <button type="button" onClick={handleMark} disabled={busy} className={btnPrimary}>
              {`Mark ${noun(plan.changes.length)}`}
            </button>
            <button type="button" ref={focusOnMount} onClick={() => setConfirmed(null)} className={btnGhost}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => {
            setError(null);
            setConfirmed(plan.signature);
          }}
          disabled={stale || busy || plan.changes.length === 0}
          className={btnOutline}
        >
          Mark as equipped
        </button>
      )}
      <p className="text-xs text-fog">
        {plan.changes.length === 0
          ? `These Echoes are already recorded as equipped this way.${stale ? ' Run again to compare against the new gear.' : ''}`
          : 'Records a re-gear you have done, or are about to do, in the game. This updates WuWaOpt’s record only. Equip these in the game too.'}
      </p>
      {error !== null && <Alert tone="danger">{error}</Alert>}
    </div>
  );
}
