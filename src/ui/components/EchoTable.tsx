import type { CSSProperties } from 'react';
import { findEchoDef } from '../../data/index.ts';
import type { OwnedEcho, Snapshot, StatKey } from '../../data/schema.ts';
import { rollValueBlocks } from '../../domain/rollValue.ts';
import { echoDefIssues } from '../../state/inventory.ts';
import { echoDisplayName, echoScore, sonataName } from '../echoDisplay.ts';
import { formatStatValue, statLabel } from '../format.ts';
import { sonataTint } from '../sonataTint.ts';
import { GameIcon } from './GameIcon.tsx';
import { CostPips, SegmentMeter } from './ui.tsx';

/** Substats that get their own aligned column; everything else lands in "Other". */
const SUBSTAT_COLUMNS: readonly { stat: StatKey; header: string; title: string }[] = [
  { stat: 'critRate', header: 'CR', title: 'Crit Rate' },
  { stat: 'critDmg', header: 'CD', title: 'Crit DMG' },
  { stat: 'atkPct', header: 'ATK%', title: 'ATK%' },
  { stat: 'energyRegen', header: 'ER', title: 'Energy Regen' },
];
const COLUMN_STATS: ReadonlySet<StatKey> = new Set(SUBSTAT_COLUMNS.map((c) => c.stat));

function Dash() {
  return (
    <span aria-hidden="true" className="text-dim">
      –
    </span>
  );
}

interface EchoTableProps {
  echoes: OwnedEcho[];
  /** Active game-data snapshot (passed down so the table follows cache updates). */
  snapshot: Snapshot;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Usage tag per echo id (unused / safe fodder), from the unused-Echo finder. */
  usageTags?: ReadonlyMap<string, 'unused' | 'fodder'>;
}

export function EchoTable({ echoes, snapshot, selectedId, onSelect, usageTags }: EchoTableProps) {
  const defs = snapshot.echoDefs;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm max-md:block md:min-w-[800px]">
        <thead className="max-md:hidden">
          <tr className="border-b-2 border-outline text-left font-display text-sm text-fog">
            <th scope="col" className="px-3 py-2 font-semibold">
              Echo
            </th>
            <th scope="col" className="px-2 py-2 font-semibold">
              Cost
            </th>
            <th scope="col" className="px-2 py-2 text-right font-semibold">
              Lv
            </th>
            <th scope="col" className="px-2 py-2 font-semibold">
              Main
            </th>
            {SUBSTAT_COLUMNS.map((c) => (
              <th key={c.stat} scope="col" title={c.title} className="px-2 py-2 text-right font-semibold">
                {c.header}
              </th>
            ))}
            <th scope="col" className="px-3 py-2 font-semibold">
              Roll
            </th>
            <th scope="col" className="px-2 py-2 font-semibold">
              Other
            </th>
          </tr>
        </thead>
        <tbody className="max-md:block">
          {echoes.map((echo, index) => {
            const issues = echoDefIssues(echo, defs);
            const def = findEchoDef(snapshot, echo.echoDefId);
            const name = echoDisplayName(snapshot, echo);
            const selected = echo.id === selectedId;
            const score = echoScore(echo);
            const others = echo.substats.filter((s) => !COLUMN_STATS.has(s.stat));
            const usageTag = usageTags?.get(echo.id);
            return (
              <tr
                key={echo.id}
                style={{ '--i': Math.min(index, 12) } as CSSProperties}
                className={`px-stagger border-b-2 border-dashed border-line transition-terminal max-md:grid max-md:grid-cols-4 max-md:gap-x-3 max-md:gap-y-2 max-md:px-3 max-md:py-3 ${
                  selected ? 'bg-seal-wash' : 'hover:bg-panel-2'
                }`}
              >
                <td className="px-3 py-2 max-md:col-span-4 max-md:p-0">
                  <div className="flex items-center gap-2">
                    <GameIcon name={name} iconUrl={def?.iconUrl} tint={sonataTint(echo.sonataId)} />
                    <div className="min-w-0">
                      <button
                        type="button"
                        onClick={() => onSelect(echo.id)}
                        aria-pressed={selected}
                        className="block max-w-44 truncate py-2 max-md:max-w-60 text-left font-display text-base leading-tight font-semibold text-ink hover:text-accent-text"
                      >
                        {name}
                      </button>
                      <span className="text-xs text-fog">{sonataName(snapshot, echo.sonataId)}</span>
                      {usageTag === 'fodder' && <span className="px-tag ml-2 px-1.5 py-px text-xs">fodder</span>}
                      {usageTag === 'unused' && (
                        <span className="ml-2 inline-flex border-2 border-line px-1.5 text-xs text-fog">unused</span>
                      )}
                      {issues.length > 0 && (
                        <p className="text-xs text-amber">Needs re-link: {issues.map((i) => i.message).join(' ')}</p>
                      )}
                    </div>
                  </div>
                </td>
                <td data-label="Cost" className="px-2 py-2 max-md:p-0 max-md:before:block max-md:before:text-xs max-md:before:font-normal max-md:before:text-fog max-md:before:content-[attr(data-label)]">
                  <span className="inline-flex items-center gap-1.5 tnum">
                    <CostPips cost={echo.cost} />
                    <span className="text-xs text-fog">C{echo.cost}</span>
                  </span>
                </td>
                <td data-label="Lv" className="px-2 py-2 text-right tnum max-md:p-0 max-md:text-left max-md:before:block max-md:before:text-xs max-md:before:font-normal max-md:before:text-fog max-md:before:content-[attr(data-label)]">{echo.level}</td>
                <td data-label="Main" className="px-2 py-2 whitespace-nowrap max-md:col-span-2 max-md:p-0 max-md:before:block max-md:before:text-xs max-md:before:font-normal max-md:before:text-fog max-md:before:content-[attr(data-label)]">
                  <span className="text-ink">{statLabel(echo.mainStat.stat)}</span>{' '}
                  <span className="font-bold tnum">{formatStatValue(echo.mainStat.stat, echo.mainStat.value)}</span>
                </td>
                {SUBSTAT_COLUMNS.map((c) => {
                  const sub = echo.substats.find((s) => s.stat === c.stat);
                  return (
                    <td
                      key={c.stat}
                      data-label={c.header}
                      className="px-2 py-2 text-right tnum max-md:p-0 max-md:text-left max-md:before:block max-md:before:text-xs max-md:before:font-normal max-md:before:text-fog max-md:before:content-[attr(data-label)]"
                    >
                      {sub === undefined ? <Dash /> : formatStatValue(sub.stat, sub.value)}
                    </td>
                  );
                })}
                <td className="px-3 py-2 max-md:col-span-4 max-md:p-0">
                  {score === null ? (
                    <Dash />
                  ) : (
                    <SegmentMeter
                      filled={rollValueBlocks(score)}
                      total={10}
                      label={`Roll value ${Math.round(score)} of 100`}
                    />
                  )}
                </td>
                <td className="px-2 py-2 text-xs whitespace-nowrap text-fog tnum max-md:col-span-4 max-md:p-0 max-md:whitespace-normal">
                  {others.length === 0 ? (
                    <Dash />
                  ) : (
                    others.map((s) => `${statLabel(s.stat)} ${formatStatValue(s.stat, s.value)}`).join(' · ')
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
