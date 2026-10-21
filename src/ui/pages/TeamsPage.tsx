import { useEffect, useState } from 'react';
import { TEAM_BUFFS } from '../../data/teamBuffs.ts';
import { teamSonataCoverage } from '../../domain/teams.ts';
import { useInventoryStore } from '../../state/inventory.ts';
import { useSnapshotStore } from '../../state/snapshotStore.ts';
import { useLibraryStore } from '../../state/library.ts';
import { useTeamStore } from '../../state/teamStore.ts';
import { GameIcon } from '../components/GameIcon.tsx';
import { statLabel, toDisplayValue } from '../format.ts';
import { btnDangerGhost, btnPrimary, inputClass, labelClass } from '../components/classes.ts';
import { Skeleton } from '../components/feedback.tsx';
import { dismissToast, INVENTORY_UNDO_SCOPE, pushToast, UNDO_TOAST_MS } from '../toasts.ts';
import { Collapsible } from '../components/Collapsible.tsx';
import type { MarkedEquipped } from '../components/MarkEquipped.tsx';
import { TeamAllocation } from '../components/TeamAllocation.tsx';
import { SuggestInput } from '../components/SuggestInput.tsx';
import { Alert, AttributeDot, EmptyState, PageHeader, Window } from '../components/ui.tsx';

export function TeamsPage() {
  const teams = useTeamStore((s) => s.teams);
  const loaded = useTeamStore((s) => s.loaded);
  const load = useTeamStore((s) => s.load);
  const createTeam = useTeamStore((s) => s.createTeam);
  const removeTeam = useTeamStore((s) => s.removeTeam);
  const removeBuilds = useLibraryStore((s) => s.removeBuilds);
  const echoes = useInventoryStore((s) => s.echoes);
  const inventoryLoaded = useInventoryStore((s) => s.loaded);
  const loadInventory = useInventoryStore((s) => s.load);
  const restoreEquipped = useInventoryStore((s) => s.restoreEquipped);
  const snapshot = useSnapshotStore((s) => s.snapshot);
  const ensureSnapshotLoaded = useSnapshotStore((s) => s.ensureLoaded);

  const [name, setName] = useState('');
  const [members, setMembers] = useState(['', '', '']);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);
  useEffect(() => {
    if (!inventoryLoaded) void loadInventory();
  }, [inventoryLoaded, loadInventory]);
  useEffect(() => {
    void ensureSnapshotLoaded();
  }, [ensureSnapshotLoaded]);

  const characterName = (id: string): string =>
    snapshot.characters.find((c) => c.id === id)?.name ?? id;
  const sonataNameOf = (id: string): string =>
    snapshot.sonataSets.find((s) => s.id === id)?.name ?? id;

  /** Toast with an Undo that deletes exactly the builds just saved (in memory only). */
  const offerUndoSave = (teamName: string, rows: readonly { id: string }[]): void => {
    const ids = rows.map((r) => r.id);
    const toastId = pushToast(`Saved ${rows.length} ${rows.length === 1 ? 'build' : 'builds'} for “${teamName}”.`, 'success', {
      timeoutMs: UNDO_TOAST_MS,
      action: {
        label: 'Undo',
        onAction: () => {
          dismissToast(toastId);
          removeBuilds(ids)
            .then((removed) => pushToast(`Removed ${removed.length} saved ${removed.length === 1 ? 'build' : 'builds'}.`))
            .catch((err: unknown) => pushToast(err instanceof Error ? err.message : 'Undo failed.', 'danger'));
        },
      },
    });
  };

  /** Toast with an Undo that puts back the `equippedTo` values just replaced (in memory only). */
  const offerUndoMark = ({ previous, applied }: MarkedEquipped): void => {
    const issuedAt = useInventoryStore.getState().generation;
    const noun = (n: number): string => `${n} ${n === 1 ? 'Echo' : 'Echoes'}`;
    const toastId = pushToast(
      `Marked ${noun(previous.length)} as equipped in WuWaOpt's record. Equip them in the game too.`,
      'success',
      {
        timeoutMs: UNDO_TOAST_MS,
        // Outlives this page; ToastHost drops it when a reload (backup restore) invalidates it.
        scope: INVENTORY_UNDO_SCOPE,
        action: {
          label: 'Undo',
          onAction: () => {
            dismissToast(toastId);
            if (useInventoryStore.getState().generation !== issuedAt) return;
            restoreEquipped(previous, applied)
              .then(({ restored, skipped }) =>
                pushToast(
                  skipped.length === 0
                    ? `Restored the record for ${noun(restored.length)}.`
                    : `Restored the record for ${noun(restored.length)}; ${noun(skipped.length)} changed since, left as is.`,
                ),
              )
              .catch((err: unknown) => pushToast(err instanceof Error ? err.message : 'Undo failed.', 'danger'));
          },
        },
      },
    );
  };

  const handleCreate = async (): Promise<void> => {
    setError(null);
    if (name.trim() === '') {
      setError('Team name is required.');
      return;
    }
    const ids = members.map((m) => m.trim());
    if (ids.some((id) => id === '')) {
      setError('All three member slots need a character id.');
      return;
    }
    try {
      await createTeam(name.trim(), [ids[0], ids[1], ids[2]]);
      setName('');
      setMembers(['', '', '']);
      pushToast(`Team “${name.trim()}” assembled.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section>
      <PageHeader
        title="Team Builder"
        description="3-character teams with Sonata coverage from equipped Echoes plus each member's transcribed Outro / team buffs — importable in the calculator."
      />

      {error && (
        <Alert tone="danger" className="mt-4">
          {error}
        </Alert>
      )}

      <Window label="Assemble a team" title="Assemble a team" className="mt-6">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <div>
          <label htmlFor="team-name" className={labelClass}>
            Team name
          </label>
          <input
            id="team-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={`${inputClass} mt-1.5`}
          />
        </div>
        {([0, 1, 2] as const).map((i) => (
          <SuggestInput
            key={i}
            id={`team-member-${i + 1}`}
            label={`Member ${i + 1}`}
            value={members[i]}
            suggestions={snapshot.characters.map((c) => ({
              value: c.id,
              label: c.name,
              hint: `${c.attribute} · ${c.id}`,
            }))}
            onChange={(next) => setMembers((prev) => prev.map((m, j) => (j === i ? next : m)))}
          />
        ))}
        <div className="flex items-end">
          <button
            type="button"
            onClick={() => void handleCreate()}
            className={`${btnPrimary} w-full sm:w-auto`}
          >
            Create team
          </button>
        </div>
      </div>
      </Window>

      <div className="mt-4">
        {!loaded ? (
          <Skeleton lines={2} />
        ) : teams.length === 0 ? (
          <EmptyState>No teams yet — assemble your first trio above.</EmptyState>
        ) : (
          <ul className="space-y-3">
            {teams.map((team) => {
              const coverage = teamSonataCoverage(echoes, team, sonataNameOf);
              return (
                <li key={team.id} className="animate-tt-fade px-card bg-panel p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="min-w-0 flex-1 basis-48 truncate font-display text-2xl leading-none font-semibold text-ink">{team.name}</h3>
                    <button
                      type="button"
                      onClick={() => void removeTeam(team.id).then(() => pushToast(`Team “${team.name}” deleted.`))}
                      className={`${btnDangerGhost} ml-auto shrink-0 px-2 py-1 text-xs`}
                    >
                      Delete {team.name}
                    </button>
                  </div>
                  <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
                    {coverage.members.map((member) => {
                      const provided = TEAM_BUFFS.filter((e) => e.characterId === member.characterId);
                      const memberCharacter = snapshot.characters.find((c) => c.id === member.characterId);
                      return (
                        <div key={member.characterId} className="border-2 border-line bg-canvas p-3">
                          <div className="flex items-center gap-1.5">
                            <GameIcon
                              name={characterName(member.characterId)}
                              iconUrl={memberCharacter?.iconUrl}
                              size="sm"
                            />
                            <p className="flex min-w-0 items-center gap-1.5 truncate text-sm font-semibold text-ink">
                              {memberCharacter && <AttributeDot attribute={memberCharacter.attribute} />}
                              <span className="truncate">{characterName(member.characterId)}</span>
                            </p>
                          </div>
                          {member.pieces.length === 0 ? (
                            <p className="mt-1.5 text-xs text-fog">No echoes equipped</p>
                          ) : (
                            <ul className="mt-1.5 flex flex-wrap gap-1">
                              {member.pieces.map((piece) => (
                                <li
                                  key={piece.sonataId}
                                  className="border-2 border-line-strong bg-panel px-1.5 py-px text-xs text-fog tnum"
                                >
                                  {piece.sonataName} ×{piece.count}
                                </li>
                              ))}
                            </ul>
                          )}
                          {provided.length === 0 ? (
                            <p className="mt-1.5 text-xs text-fog">No transcribed team buffs</p>
                          ) : (
                            <ul className="mt-1.5 space-y-1 text-xs text-fog">
                              {provided.map((entry) => (
                                <li key={`${entry.skillId}-${entry.label}`} title={entry.assumption}>
                                  <span className="text-ink">{entry.label}</span>
                                  {entry.windowSeconds !== undefined && (
                                    <span className="ml-1 bg-panel-3 px-1 text-xs text-fog tnum">{entry.windowSeconds}s</span>
                                  )}
                                  <span className="text-xs">
                                    {` (${entry.mods.map((m) => `${statLabel(m.stat)} ${toDisplayValue(m.stat, m.value)}`).join(', ')})`}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <div className="mt-4">
                    <Collapsible title="Allocate Echoes across this team">
                      <TeamAllocation
                        key={`${team.id}:${team.characterIds.join(',')}`}
                        team={team}
                        onSaved={(rows) => offerUndoSave(team.name, rows)}
                        onMarked={offerUndoMark}
                      />
                    </Collapsible>
                  </div>
                  {coverage.combined.length > 0 && (
                    <p className="mt-3 text-xs text-fog tnum">
                      Team totals:{' '}
                      <span className="text-fog">{coverage.combined.map((c) => `${c.sonataName} ×${c.count}`).join(' · ')}</span>
                    </p>
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
