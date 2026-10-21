import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Build, OwnedEcho, RosterEntry, Team } from '../../data/schema.ts';
import { db } from '../../state/db.ts';
import { useInventoryStore } from '../../state/inventory.ts';
import { useLibraryStore } from '../../state/library.ts';
import { useRosterStore } from '../../state/roster.ts';
import { useSnapshotStore } from '../../state/snapshotStore.ts';
import { useTeamStore } from '../../state/teamStore.ts';

// jsdom has no Worker: run the same exact search inline, through the same entry point.
vi.mock('../../optimizer/worker.ts', async () => {
  const { searchExhaustive } = await import('../../optimizer/search.ts');
  return {
    runOptimization: (data: Parameters<typeof searchExhaustive>[0], request: Parameters<typeof searchExhaustive>[1]) => ({
      promise: Promise.resolve().then(() => searchExhaustive(data, request)),
      cancel: () => undefined,
      onProgress: () => undefined,
    }),
  };
});

const { TeamsPage } = await import('./TeamsPage.tsx');

const team: Team = { id: 't1', name: 'Main', characterIds: ['jiyan', 'verina', 'yangyang'] };
const WEAPONS: Record<string, string> = { jiyan: 'verdant-summit', verina: 'augment', yangyang: 'lumingloss' };
const roster = (characterId: string): RosterEntry => ({
  characterId,
  level: 90,
  ascension: 6,
  resonanceChain: 0,
  forteLevels: {},
  weaponId: WEAPONS[characterId],
  weaponLevel: 90,
  weaponRank: 1,
});
const build = (characterId: string): Build => ({
  id: `b-${characterId}`,
  name: `${characterId} ATK`,
  characterId,
  weaponId: WEAPONS[characterId],
  echoIds: ['p1', 'p2', 'p3', 'p4', 'p5'],
  objectiveId: 'Max ATK',
  objective: { kind: 'max-stat', stat: 'atk' },
  updatedAt: '2026-10-20T00:00:00.000Z',
});
const echo = (i: number): OwnedEcho => ({
  id: `x${i}`,
  label: `Echo ${i}`,
  echoDefId: `x${i}-def`,
  sonataId: 'sierra-gale',
  cost: 1,
  level: 25,
  rarity: 5,
  mainStat: { stat: 'hp', value: 0 },
  substats: [{ stat: 'atk', value: 10 * i }],
  equippedTo: null,
  origin: 'manual',
});

beforeEach(async () => {
  await Promise.all([db.builds.clear(), db.teams.clear(), db.roster.clear(), db.ownedEchoes.clear()]);
  await db.ownedEchoes.bulkAdd(Array.from({ length: 15 }, (_, i) => echo(i + 1)));
  await db.teams.add(team);
  await db.roster.bulkAdd(['jiyan', 'verina', 'yangyang'].map(roster));
  await db.builds.bulkAdd(['jiyan', 'verina', 'yangyang'].map(build));
  useTeamStore.setState({ teams: [], loaded: false });
  useInventoryStore.setState({ echoes: [], loaded: false });
  useLibraryStore.setState({ builds: [], loaded: false });
  useRosterStore.setState({ entries: [], loaded: false });
  await useSnapshotStore.getState().ensureLoaded();
});

describe('TeamsPage allocation', () => {
  it('allocates, saves as builds, and Undo removes exactly those builds', async () => {
    const user = userEvent.setup();
    render(<TeamsPage />);
    await user.click(await screen.findByRole('button', { name: /allocate echoes across this team/i }));
    const run = screen.getByRole('button', { name: 'Allocate Echoes' });
    await waitFor(() => expect(run).toBeEnabled());
    await user.click(run);
    await user.click(await screen.findByRole('button', { name: 'Save as 3 builds' }));

    expect(await screen.findByText('Saved 3 builds for “Main”.')).toBeInTheDocument();
    expect(await db.builds.count()).toBe(6);

    await user.click(screen.getByRole('button', { name: 'Undo' }));

    expect(await screen.findByText('Removed 3 saved builds.')).toBeInTheDocument();
    const left = await db.builds.toArray();
    expect(left.map((b) => b.id).sort()).toEqual(['b-jiyan', 'b-verina', 'b-yangyang']);
    expect(useLibraryStore.getState().builds).toHaveLength(3);
  });

  it('marks the allocation as equipped, and Undo puts the previous record back', async () => {
    // x1..x5 start on jiyan; the allocation hands them to yangyang.
    await db.ownedEchoes.bulkPut([1, 2, 3, 4, 5].map((i) => ({ ...echo(i), equippedTo: 'jiyan' })));
    const user = userEvent.setup();
    render(<TeamsPage />);
    await user.click(await screen.findByRole('button', { name: /allocate echoes across this team/i }));
    const run = screen.getByRole('button', { name: 'Allocate Echoes' });
    await waitFor(() => expect(run).toBeEnabled());
    await user.click(run);
    await user.click(await screen.findByRole('button', { name: 'Mark as equipped' }));
    await user.click(screen.getByRole('button', { name: 'Mark 15 Echoes' }));

    expect(await screen.findByText(/Marked 15 Echoes as equipped in WuWaOpt's record\. Equip them in the game too\./)).toBeInTheDocument();
    const wornNow = async () => Object.fromEntries((await db.ownedEchoes.toArray()).map((e) => [e.id, e.equippedTo]));
    expect(await wornNow()).toMatchObject({ x1: 'yangyang', x6: 'verina', x11: 'jiyan', x15: 'jiyan' });
    expect(useInventoryStore.getState().echoes.find((e) => e.id === 'x11')?.equippedTo).toBe('jiyan');
    expect(await db.builds.count()).toBe(3); // marking saves no builds

    await user.click(screen.getByRole('button', { name: 'Undo' }));

    expect(await screen.findByText('Restored the record for 15 Echoes.')).toBeInTheDocument();
    const restored = await wornNow();
    for (let i = 1; i <= 5; i += 1) expect(restored[`x${i}`]).toBe('jiyan');
    for (let i = 6; i <= 15; i += 1) expect(restored[`x${i}`]).toBeNull();
    expect(useInventoryStore.getState().echoes.filter((e) => e.equippedTo === 'jiyan')).toHaveLength(5);
  });

  it('Undo skips an Echo that was moved after marking', async () => {
    const user = userEvent.setup();
    render(<TeamsPage />);
    await user.click(await screen.findByRole('button', { name: /allocate echoes across this team/i }));
    const run = screen.getByRole('button', { name: 'Allocate Echoes' });
    await waitFor(() => expect(run).toBeEnabled());
    await user.click(run);
    await user.click(await screen.findByRole('button', { name: 'Mark as equipped' }));
    await user.click(screen.getByRole('button', { name: 'Mark 15 Echoes' }));
    await screen.findByText(/^Marked 15 Echoes/);
    await useInventoryStore.getState().reassignEquipped([{ id: 'x11', equippedTo: 'calcharo' }]);

    await user.click(screen.getByRole('button', { name: 'Undo' }));

    expect(await screen.findByText('Restored the record for 14 Echoes; 1 Echo changed since, left as is.')).toBeInTheDocument();
    expect((await db.ownedEchoes.get('x11'))?.equippedTo).toBe('calcharo');
    expect((await db.ownedEchoes.get('x12'))?.equippedTo).toBeNull();
  });

  it('drops the pending Undo when the inventory is reloaded', async () => {
    const user = userEvent.setup();
    render(<TeamsPage />);
    await user.click(await screen.findByRole('button', { name: /allocate echoes across this team/i }));
    const run = screen.getByRole('button', { name: 'Allocate Echoes' });
    await waitFor(() => expect(run).toBeEnabled());
    await user.click(run);
    await user.click(await screen.findByRole('button', { name: 'Mark as equipped' }));
    await user.click(screen.getByRole('button', { name: 'Mark 15 Echoes' }));
    await screen.findByText(/^Marked 15 Echoes/);

    await act(async () => useInventoryStore.getState().load()); // e.g. a backup restore

    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    expect(screen.queryByText(/^Marked 15 Echoes/)).not.toBeInTheDocument();
  });
});
