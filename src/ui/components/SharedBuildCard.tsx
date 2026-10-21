import type { SharedBuild, Snapshot, StatKey } from '../../data/schema.ts';
import type { EchoValueFlag, SharedBuildView } from '../../state/share.ts';
import { sonataName } from '../echoDisplay.ts';
import { formatStatValue, statLabel } from '../format.ts';
import { sonataTint } from '../sonataTint.ts';
import { GameIcon } from './GameIcon.tsx';
import { Alert, CostPips } from './ui.tsx';

/** Ratio for display at one decimal ("67.1%"); presentation only. */
const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

export function StatValue({ stat, value, flag }: { stat: StatKey; value: number; flag?: EchoValueFlag }) {
  const text = `${statLabel(stat)} ${formatStatValue(stat, value)}`;
  if (flag === undefined) return <span>{text}</span>;
  const out = flag.severity === 'out-of-range';
  return (
    <span
      title={flag.message}
      className={out ? 'border-b-2 border-ember font-bold text-ember-ink' : 'border-b-2 border-dotted border-line-strong'}
    >
      {text}
      <span className="sr-only">{` (${out ? 'out of range' : 'unverified'}: ${flag.message})`}</span>
      <span aria-hidden="true">{out ? ' !' : ' ?'}</span>
    </span>
  );
}

/**
 * Read-only card for a shared build: everything shown is either the link's
 * own data or computed by `viewSharedBuild` (domain layer) against the
 * recipient's snapshot. Out-of-table values are marked, never corrected.
 */
export function SharedBuildCard({
  shared,
  view,
  snapshot,
}: {
  shared: SharedBuild;
  view: SharedBuildView;
  snapshot: Snapshot;
}) {
  const characterName = view.character?.name ?? shared.character.id;
  const weaponName = view.weapon?.name ?? shared.weapon.id;
  const allFlags = view.flags.flat();
  const outOfRange = allFlags.filter((f) => f.severity === 'out-of-range').length;
  const unverified = allFlags.length - outOfRange;
  const flagFor = (slot: number, part: EchoValueFlag['part'], stat: StatKey): EchoValueFlag | undefined =>
    view.flags[slot].find((f) => f.part === part && f.stat === stat);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <GameIcon name={characterName} iconUrl={view.character?.iconUrl} />
        <div className="min-w-0 flex-1 basis-52">
          <p className="truncate font-display text-xl leading-tight font-semibold text-ink">{shared.name}</p>
          <p className="mt-0.5 text-xs text-fog tnum">
            {characterName} Lv {shared.character.level} · S{shared.character.chain} · {weaponName} Lv{' '}
            {shared.weapon.level} R{shared.weapon.rank}
          </p>
          <p className="mt-1 text-xs text-fog tnum">
            {shared.summary || 'No objective summary'}
            {shared.score !== undefined && (
              <>
                {' · '}
                <span className="px-tag px-1.5 py-px text-xs">score {shared.score.toFixed(1)}</span>
              </>
            )}
            {shared.objective && ' · rotation included'}
          </p>
        </div>
      </div>

      {view.issues.length > 0 && (
        <Alert tone="warning" className="mt-3">
          <ul className="list-inside list-disc">
            {view.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </Alert>
      )}
      {outOfRange > 0 && (
        <Alert tone="danger" className="mt-3">
          {outOfRange} {outOfRange === 1 ? 'value falls' : 'values fall'} outside the Echo reference tables (marked !). Shown as
          sent — check them before trusting this build.
        </Alert>
      )}
      {unverified > 0 && (
        <p className="mt-2 text-xs text-fog">
          {unverified} value{unverified === 1 ? '' : 's'} can’t be checked: no reference table covers them (marked ?).
        </p>
      )}

      {view.stats && view.character && (
        <dl aria-label="Key stats" className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
          {(
            [
              ['HP', Math.round(view.stats.hp).toLocaleString()],
              ['ATK', Math.round(view.stats.atk).toLocaleString()],
              ['DEF', Math.round(view.stats.def).toLocaleString()],
              ['Crit Rate', pct(view.stats.critRate)],
              ['Crit DMG', pct(view.stats.critDmg)],
              ['Energy Regen', pct(view.stats.energyRegen)],
              [`${view.character.attribute} DMG`, pct(view.stats.attributeDmg)],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="flex justify-between gap-2 border-b border-line py-0.5">
              <dt className="text-fog">{label}</dt>
              <dd className="font-semibold text-ink tnum">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {view.stats && (
        <p className="mt-1 text-xs text-fog">
          Calculated with your game data; buffs from the sender’s rotation are not included.
        </p>
      )}

      <ol aria-label="Shared Echoes" className="mt-3 space-y-1.5">
        {shared.echoes.map((echo, slot) => (
          <li key={slot} className="px-card bg-panel-2 px-3 py-2 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <GameIcon
                name={view.echoNames[slot]}
                iconUrl={snapshot.echoDefs.find((d) => d.id === echo.def)?.iconUrl}
                size="sm"
                tint={sonataTint(echo.set)}
              />
              <span className="font-semibold text-ink">
                {slot === 0 ? 'Slot 1 (main) · ' : ''}
                {view.echoNames[slot]}
              </span>
              <CostPips cost={echo.cost} />
              <span className="text-fog tnum">
                {echo.cost}-cost · +{echo.level} · {echo.rarity}★ · {sonataName(snapshot, echo.set)}
              </span>
            </div>
            <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-fog tnum">
              <StatValue stat={echo.main.stat} value={echo.main.value} flag={flagFor(slot, 'main', echo.main.stat)} />
              {echo.second && (
                <StatValue stat={echo.second.stat} value={echo.second.value} flag={flagFor(slot, 'second', echo.second.stat)} />
              )}
              {echo.subs.map((sub) => (
                <StatValue key={sub.stat} stat={sub.stat} value={sub.value} flag={flagFor(slot, 'sub', sub.stat)} />
              ))}
            </p>
          </li>
        ))}
      </ol>

      {(view.appliedAssumptions.length > 0 || view.warnings.length > 0) && (
        <details className="mt-2 text-xs text-fog">
          <summary className="cursor-pointer">Assumptions and unmodeled effects</summary>
          <ul className="mt-1 list-inside list-disc">
            {view.appliedAssumptions.map((a) => (
              <li key={`a-${a}`}>{a}</li>
            ))}
            {view.warnings.map((w) => (
              <li key={`w-${w}`}>{w}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
