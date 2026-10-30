import { useEffect, useState } from 'react';
import type { RosterEntry, Snapshot } from '../../data/schema.ts';
import { useRosterStore } from '../../state/roster.ts';
import { useSnapshotStore } from '../../state/snapshotStore.ts';
import { GameIcon } from '../components/GameIcon.tsx';
import { SliderField } from '../components/SliderField.tsx';
import { btnDangerGhost, btnPrimary, inputClass, labelClass } from '../components/classes.ts';
import { Collapsible } from '../components/Collapsible.tsx';
import { Skeleton } from '../components/feedback.tsx';
import { pushToast } from '../toasts.ts';
import { AttributeDot, EmptyState, PageHeader } from '../components/ui.tsx';

function defaultsFor(snapshot: Snapshot, characterId: string): RosterEntry {
  const character = snapshot.characters.find((c) => c.id === characterId)!;
  const weapon =
    snapshot.weapons.find((w) => w.weaponType === character.weaponType) ?? snapshot.weapons[0];
  return {
    characterId,
    level: 90,
    ascension: 6,
    resonanceChain: 0,
    forteLevels: {},
    weaponId: weapon.id,
    weaponLevel: 90,
    weaponRank: 1,
  };
}

export function RosterPage() {
  const entries = useRosterStore((s) => s.entries);
  const loaded = useRosterStore((s) => s.loaded);
  const load = useRosterStore((s) => s.load);
  const upsert = useRosterStore((s) => s.upsert);
  const remove = useRosterStore((s) => s.remove);
  const snapshot = useSnapshotStore((s) => s.snapshot);
  const ensureSnapshotLoaded = useSnapshotStore((s) => s.ensureLoaded);
  const [addingId, setAddingId] = useState('');

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);
  useEffect(() => {
    void ensureSnapshotLoaded();
  }, [ensureSnapshotLoaded]);

  const characterName = (id: string): string =>
    snapshot.characters.find((c) => c.id === id)?.name ?? id;
  const available = snapshot.characters.filter((c) => !entries.some((e) => e.characterId === c.id));

  const commit = (entry: RosterEntry, patch: Partial<RosterEntry>): void => {
    void upsert({ ...entry, ...patch }).catch(() => {
      // Out-of-range exact-value input is ignored; the last valid row
      // stays in the store and the control snaps back to it.
    });
  };

  return (
    <section>
      <PageHeader
        title="Character Roster"
        description="Who you've built — levels, weapons, and forte investment the Calculator can prefill."
        actions={
          <>
            <select
              id="roster-character"
              aria-label="Character"
              value={addingId}
              onChange={(e) => setAddingId(e.target.value)}
              className={`${inputClass} w-auto min-w-48`}
            >
              <option value="">Pick a character…</option>
              {available.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            <button
              type="button"
              disabled={addingId === ''}
              onClick={() => {
                if (addingId === '') return;
                const id = addingId;
                void upsert(defaultsFor(snapshot, id)).then(() => {
                  setAddingId('');
                  pushToast(`${characterName(id)} joined the roster.`);
                });
              }}
              className={btnPrimary}
            >
              Add character
            </button>
          </>
        }
      />

      <div className="mt-4">
        {!loaded ? (
          <Skeleton lines={3} />
        ) : entries.length === 0 ? (
          <EmptyState>No characters tracked yet — add one above.</EmptyState>
        ) : (
          <ul className="space-y-3">
            {entries.map((entry) => {
              const character = snapshot.characters.find((c) => c.id === entry.characterId);
              const scorable = character?.skills.filter((s) => s.motionValues.length > 0) ?? [];
              const name = characterName(entry.characterId);
              const usableWeapons = character
                ? snapshot.weapons.filter((w) => w.weaponType === character.weaponType)
                : snapshot.weapons;
              const storedWeapon = snapshot.weapons.find((w) => w.id === entry.weaponId);
              const mismatchedWeapon =
                character && storedWeapon && storedWeapon.weaponType !== character.weaponType
                  ? storedWeapon
                  : undefined;
              return (
                <li key={entry.characterId} className="animate-tt-fade relative px-card bg-panel p-4">
                  <span aria-hidden="true" className="px-tag absolute -top-2.5 right-4 px-2 py-0.5 text-xs">
                    S{entry.resonanceChain}
                  </span>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="flex min-w-0 flex-1 basis-48 items-center gap-2.5">
                      <GameIcon name={name} iconUrl={character?.iconUrl} />
                      <div className="min-w-0">
                        <h3 className="truncate font-display text-2xl leading-none font-semibold text-ink">{name}</h3>
                        {character && (
                          <p className="mt-1 flex items-center gap-1.5 text-xs text-fog">
                            <AttributeDot attribute={character.attribute} />
                            {character.attribute} · {character.weaponType}
                          </p>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void remove(entry.characterId).then(() => pushToast(`${name} left the roster.`))}
                      className={`${btnDangerGhost} ml-auto shrink-0 px-2 py-1 text-xs`}
                    >
                      Remove {name}
                    </button>
                  </div>
                  <div className="mt-4 grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
                    <SliderField
                      id={`roster-level-${entry.characterId}`}
                      label={`Level for ${name}`}
                      value={entry.level}
                      min={1}
                      max={90}
                      onChange={(v) => commit(entry, { level: v })}
                    />
                    <SliderField
                      id={`roster-ascension-${entry.characterId}`}
                      label={`Ascension for ${name}`}
                      value={entry.ascension}
                      min={0}
                      max={6}
                      onChange={(v) => commit(entry, { ascension: v })}
                    />
                    <SliderField
                      id={`roster-chain-${entry.characterId}`}
                      label={`Chain rank for ${name}`}
                      value={entry.resonanceChain}
                      min={0}
                      max={6}
                      onChange={(v) => commit(entry, { resonanceChain: v })}
                    />
                    <div>
                      <label className={labelClass}>
                        <span className="flex items-center gap-1.5">
                          <GameIcon name={storedWeapon?.name ?? 'Weapon'} iconUrl={storedWeapon?.iconUrl} size="sm" />
                          Weapon
                        </span>
                        <select
                          aria-label={`Weapon for ${name}`}
                          value={entry.weaponId}
                          onChange={(e) => commit(entry, { weaponId: e.target.value })}
                          className={`${inputClass} mt-0.5`}
                        >
                          {mismatchedWeapon && (
                            <option value={mismatchedWeapon.id}>
                              {`${mismatchedWeapon.name} (${mismatchedWeapon.weaponType}, wrong type)`}
                            </option>
                          )}
                          {usableWeapons.map((w) => (
                            <option key={w.id} value={w.id}>{w.name}</option>
                          ))}
                        </select>
                      </label>
                      {mismatchedWeapon && character && (
                        <p role="alert" className="mt-1 text-xs text-amber">
                          {name} needs a {character.weaponType} — pick one to fix this entry.
                        </p>
                      )}
                    </div>
                    <SliderField
                      id={`roster-weapon-level-${entry.characterId}`}
                      label={`Weapon level for ${name}`}
                      value={entry.weaponLevel}
                      min={1}
                      max={90}
                      onChange={(v) => commit(entry, { weaponLevel: v })}
                    />
                    <SliderField
                      id={`roster-weapon-rank-${entry.characterId}`}
                      label={`Weapon rank for ${name}`}
                      value={entry.weaponRank}
                      min={1}
                      max={5}
                      onChange={(v) => commit(entry, { weaponRank: v })}
                    />
                    <SliderField
                      id={`roster-weapon-ascension-${entry.characterId}`}
                      label={`Weapon ascension for ${name}`}
                      value={entry.weaponAscension ?? 0}
                      min={0}
                      max={6}
                      onChange={(v) => commit(entry, { weaponAscension: v })}
                    />
                  </div>
                  {scorable.length > 0 && (
                    <div className="mt-4">
                      <Collapsible title="Forte levels" defaultOpen>
                        <p className="mb-2 text-xs text-fog">
                          Unset shows 10 — touch to store
                        </p>
                        <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
                          {scorable.map((skill) => (
                            <SliderField
                              key={skill.id}
                              id={`roster-forte-${entry.characterId}-${skill.id}`}
                              label={`${skill.label} forte level`}
                              value={entry.forteLevels[skill.id] ?? 10}
                              min={1}
                              max={10}
                              onChange={(v) =>
                                commit(entry, { forteLevels: { ...entry.forteLevels, [skill.id]: v } })
                              }
                            />
                          ))}
                        </div>
                      </Collapsible>
                    </div>
                  )}
                  {character && character.forteNodes.length > 0 && (
                    <div className="mt-4">
                      <Collapsible title="Forte nodes unlocked" defaultOpen>
                        <p className="mb-2 text-xs text-fog">
                          Untouched = all active
                        </p>
                        <div className="grid grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-3">
                        {character.forteNodes.map((node) => {
                          const unlocked = entry.forteUnlockedIds === undefined
                            ? true
                            : entry.forteUnlockedIds.includes(node.id);
                          return (
                            <label key={node.id} className="flex items-center gap-2 text-xs text-fog pointer-coarse:min-h-11">
                              <input
                                type="checkbox"
                                aria-label={`${node.title} unlocked for ${name}`}
                                checked={unlocked}
                                onChange={() => {
                                  const current = entry.forteUnlockedIds === undefined
                                    ? character.forteNodes.map((n) => n.id)
                                    : entry.forteUnlockedIds;
                                  commit(entry, {
                                    forteUnlockedIds: unlocked
                                      ? current.filter((id) => id !== node.id)
                                      : [...current, node.id],
                                  });
                                }}
                              />
                              <span>{node.title}</span>
                            </label>
                          );
                        })}
                        </div>
                      </Collapsible>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
