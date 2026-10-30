import type { OwnedEcho, Snapshot } from '../../data/schema.ts';
import { findEchoDef } from '../../data/index.ts';
import { echoDefIssues } from '../../state/inventory.ts';
import { substatRoll, substatTierBlocks, rollValueBlocks } from '../../domain/rollValue.ts';
import { echoDisplayName, echoScore, sonataName } from '../echoDisplay.ts';
import { formatStatValue, statLabel } from '../format.ts';
import { sonataTint } from '../sonataTint.ts';
import { btnCyan, btnDangerGhost, btnOutline, btnSm } from './classes.ts';
import { AnimatedNumber } from './feedback.tsx';
import { GameIcon } from './GameIcon.tsx';
import { CostPips, SegmentMeter, Window } from './ui.tsx';

/** "Status" window: the selected echo's stats, roll tiers, and its actions. */
export function EchoStatus({
  echo,
  snapshot,
  onEdit,
  onDelete,
  onToggleLock,
  onClose,
}: {
  echo: OwnedEcho | null;
  snapshot: Snapshot;
  onEdit: (echo: OwnedEcho) => void;
  onDelete: (id: string) => void;
  onToggleLock: (echo: OwnedEcho) => void;
  /** Shown as a Close button in the title bar (the phone bottom sheet). */
  onClose?: () => void;
}) {
  if (echo === null) {
    return (
      <Window title="Status" bar="b" label="Status">
        <p className="text-sm text-fog">Pick an echo from the box to see its rolls.</p>
      </Window>
    );
  }
  const name = echoDisplayName(snapshot, echo);
  const def = findEchoDef(snapshot, echo.echoDefId);
  const issues = echoDefIssues(echo, snapshot.echoDefs);
  const score = echoScore(echo);
  return (
    <Window
      title="Status"
      bar="b"
      label="Status"
      actions={
        onClose === undefined ? undefined : (
          <button type="button" onClick={onClose} aria-label="Close Status" className={`${btnOutline} ${btnSm}`}>
            Close
          </button>
        )
      }
    >
      <div key={echo.id} className="animate-tt-rise">
      <div className="flex items-center gap-3">
        <GameIcon name={name} iconUrl={def?.iconUrl} size="lg" tint={sonataTint(echo.sonataId)} />
        <div className="min-w-0">
          <p className="font-display text-2xl leading-tight font-bold break-words text-ink">{name}</p>
          <p className="text-sm text-fog">{sonataName(snapshot, echo.sonataId)}</p>
          <p className="mt-1 flex items-center gap-2 text-sm tnum">
            <CostPips cost={echo.cost} />
            <span>
              C{echo.cost} · Lv{echo.level} · {echo.rarity}★
            </span>
          </p>
        </div>
      </div>
      {issues.length > 0 && (
        <p className="mt-2 text-xs text-amber">Needs re-link: {issues.map((i) => i.message).join(' ')}</p>
      )}

      <dl className="mt-4 space-y-1.5 text-sm">
        <div className="flex items-baseline justify-between gap-2">
          <dt className="text-fog">{statLabel(echo.mainStat.stat)}</dt>
          <dd className="font-display text-xl font-bold tnum">{formatStatValue(echo.mainStat.stat, echo.mainStat.value)}</dd>
        </div>
        {echo.secondMainStat !== undefined && (
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-fog">{statLabel(echo.secondMainStat.stat)}</dt>
            <dd className="font-bold tnum">{formatStatValue(echo.secondMainStat.stat, echo.secondMainStat.value)}</dd>
          </div>
        )}
      </dl>

      <div className="rule my-3" aria-hidden="true" />

      {echo.substats.length === 0 ? (
        <p className="text-sm text-fog">No substats rolled yet.</p>
      ) : (
        <ul className="space-y-2">
          {echo.substats.map((s) => {
            const roll = substatRoll(s.stat, s.value);
            const blocks = substatTierBlocks(s.stat, s.value);
            return (
              <li key={s.stat} className="flex items-center justify-between gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{statLabel(s.stat)}</span>
                <span className="font-bold tnum">{formatStatValue(s.stat, s.value)}</span>
                <span className="shrink-0">
                  {roll !== null && blocks !== null && (
                    <SegmentMeter
                      filled={blocks}
                      total={4}
                      size="tier"
                      label={`${statLabel(s.stat)} roll tier ${roll.tier} of ${roll.tiers}`}
                    />
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {score !== null && (
        <div className="mt-3 flex items-center justify-between gap-2 text-sm">
          <span className="text-fog">Roll value</span>
          <span className="flex items-center gap-2">
            <AnimatedNumber value={score} className="font-display text-xl font-bold" />
            <SegmentMeter filled={rollValueBlocks(score)} total={10} label={`Roll value ${Math.round(score)} of 100`} />
          </span>
        </div>
      )}

      <div className="mt-5 flex flex-wrap gap-4">
        <button type="button" onClick={() => onEdit(echo)} className={`${btnCyan} min-h-11`}>
          Edit
        </button>
        <button
          type="button"
          onClick={() => onToggleLock(echo)}
          aria-pressed={echo.locked === true}
          title={echo.locked ? 'Unlock so this Echo can be deleted again' : 'Protect this Echo from deletion and safe-fodder cleanup'}
          className={`${btnCyan} min-h-11`}
        >
          {echo.locked ? 'Unlock' : 'Lock'}
        </button>
        <button
          type="button"
          onClick={() => onDelete(echo.id)}
          disabled={echo.locked === true}
          aria-describedby={echo.locked ? 'echo-locked-note' : undefined}
          className={`${btnDangerGhost} min-h-11`}
        >
          Delete
        </button>
      </div>
      {echo.locked && (
        <p id="echo-locked-note" className="mt-2 text-xs text-fog">
          Locked — unlock this Echo to delete it. Locking does not change what the optimizer searches.
        </p>
      )}
      </div>
    </Window>
  );
}
