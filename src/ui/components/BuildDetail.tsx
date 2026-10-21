import { findEchoDef } from '../../data/index.ts';
import type { Build, OwnedEcho, Snapshot } from '../../data/schema.ts';
import { characterResonanceModes } from '../../domain/characterMods.ts';
import { echoDisplayName, sonataName } from '../echoDisplay.ts';
import { formatEnemy, formatMinStats, RESONANCE_MODE_LABELS } from '../format.ts';
import { sonataTint } from '../sonataTint.ts';
import { GameIcon } from './GameIcon.tsx';
import { StatValue } from './SharedBuildCard.tsx';
import { CostPips } from './ui.tsx';

/**
 * Expanded view of a saved own build: its five Echoes as they are in the
 * inventory now (an Echo edited since the save shows its current stats), the
 * weapon, and the run settings saved with it. Display only: every value is
 * stored data, nothing is computed here. An Echo that was deleted is marked
 * in its slot instead of being dropped from the list.
 */
export function BuildDetail({
  id,
  build,
  inventory,
  inventoryLoaded,
  snapshot,
}: {
  /** DOM id, so the toggle button can point at this region. */
  id: string;
  build: Build;
  inventory: readonly OwnedEcho[];
  /** Until the inventory is in, no Echo is judged missing. */
  inventoryLoaded: boolean;
  snapshot: Snapshot;
}) {
  const byId = new Map(inventory.map((e) => [e.id, e]));
  const weapon = snapshot.weapons.find((w) => w.id === build.weaponId);
  const mode =
    build.resonanceMode !== undefined && characterResonanceModes(build.characterId).some((m) => m === build.resonanceMode)
      ? RESONANCE_MODE_LABELS[build.resonanceMode as keyof typeof RESONANCE_MODE_LABELS]
      : undefined;
  const ctx = build.context;
  const facts: [string, string][] = [
    [
      'Weapon',
      `${weapon?.name ?? build.weaponId}${ctx ? ` Lv ${ctx.weaponLevel} R${ctx.weaponRank}` : ''}`,
    ],
    ...(ctx ? [['Character', `Lv ${ctx.level} · S${ctx.resonanceChain}`] as [string, string]] : []),
    ['Objective', build.objective ? `${build.objectiveId} (rotation saved)` : build.objectiveId],
    ...(build.enemy ? [['Enemy', formatEnemy(build.enemy)] as [string, string]] : []),
    ...(mode ? [['Resonance Mode', mode] as [string, string]] : []),
    ...(build.minStats && Object.keys(build.minStats).length > 0
      ? [['Minimum stats', formatMinStats(build.minStats)] as [string, string]]
      : []),
  ];

  return (
    <div id={id} role="region" aria-label={`Details for ${build.name}`} className="mt-3 border-t-2 border-dashed border-line pt-3">
      <dl className="grid grid-cols-1 gap-x-4 gap-y-0.5 text-xs sm:grid-cols-2">
        {facts.map(([label, value]) => (
          <div key={label} className="flex gap-2">
            <dt className="shrink-0 text-fog">{label}</dt>
            <dd className="min-w-0 font-semibold text-ink tnum">{value}</dd>
          </div>
        ))}
      </dl>
      <ol aria-label="Build Echoes" className="mt-3 space-y-1.5">
        {build.echoIds.map((echoId, slot) => {
          const echo = byId.get(echoId);
          const slotLabel = slot === 0 ? 'Slot 1 (main)' : `Slot ${slot + 1}`;
          if (!inventoryLoaded) {
            return (
              <li key={slot} className="px-card bg-panel-2 px-3 py-2 text-xs text-fog">
                {slotLabel} · Loading your inventory…
              </li>
            );
          }
          if (echo === undefined) {
            return (
              <li key={slot} className="border-2 border-dashed border-ember bg-panel-2 px-3 py-2 text-xs text-ember-ink">
                <span className="font-semibold">{slotLabel} · </span>
                Missing — this Echo was deleted from your inventory.
              </li>
            );
          }
          const name = echoDisplayName(snapshot, echo);
          return (
            <li key={slot} className="px-card bg-panel-2 px-3 py-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <GameIcon
                  name={name}
                  iconUrl={findEchoDef(snapshot, echo.echoDefId)?.iconUrl}
                  size="sm"
                  tint={sonataTint(echo.sonataId)}
                />
                <span className="font-semibold text-ink">
                  {slotLabel} · {name}
                </span>
                <CostPips cost={echo.cost} />
                <span className="text-fog tnum">
                  {echo.cost}-cost · +{echo.level} · {echo.rarity}★ · {sonataName(snapshot, echo.sonataId)}
                </span>
              </div>
              <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-fog tnum">
                <StatValue stat={echo.mainStat.stat} value={echo.mainStat.value} />
                {echo.secondMainStat && <StatValue stat={echo.secondMainStat.stat} value={echo.secondMainStat.value} />}
                {echo.substats.map((sub) => (
                  <StatValue key={sub.stat} stat={sub.stat} value={sub.value} />
                ))}
              </p>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
