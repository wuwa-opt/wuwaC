import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Build, OwnedEcho, RosterEntry, StatKey, Team } from '../../data/schema.ts';
import type { RunFn } from '../../optimizer/allocate.ts';
import { searchExhaustive } from '../../optimizer/search.ts';
import { useCalculatorStore } from '../../state/calculator.ts';
import { db } from '../../state/db.ts';
import { useInventoryStore } from '../../state/inventory.ts';
import { useLibraryStore } from '../../state/library.ts';
import { useRosterStore } from '../../state/roster.ts';
import { useSnapshotStore } from '../../state/snapshotStore.ts';
import { TeamAllocation } from './TeamAllocation.tsx';

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
  objective: { kind: 'max-stat', stat: 'atk' as StatKey },
  updatedAt: '2026-10-20T00:00:00.000Z',
});

const echo = (i: number, extra: Partial<OwnedEcho> = {}): OwnedEcho => ({
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
  ...extra,
});

/** 15 Echoes of rising ATK; jiyan wears the five weakest. */
const inventory = (): OwnedEcho[] =>
  Array.from({ length: 15 }, (_, i) => echo(i + 1, i < 5 ? { equippedTo: 'jiyan' } : {}));

const inlineRun: RunFn = (data, request) => {
  let progress: ((evaluated: number, total: number) => void) | null = null;
  const promise = Promise.resolve().then(() => searchExhaustive(data, request, (u) => progress?.(u.evaluated, u.total)));
  return { promise, cancel: () => undefined, onProgress: (cb) => (progress = cb) };
};

beforeEach(async () => {
  await Promise.all([db.builds.clear(), db.roster.clear(), db.ownedEchoes.clear()]);
  useInventoryStore.setState({ echoes: inventory(), loaded: true });
  useLibraryStore.setState({ builds: ['jiyan', 'verina', 'yangyang'].map(build), loaded: true });
  useRosterStore.setState({ entries: ['jiyan', 'verina', 'yangyang'].map(roster), loaded: true });
  useCalculatorStore.setState({ enemyKind: 'mob', enemyLevel: 90, enemyBaseRES: 0.1 });
});

function renderAllocation(over: { run?: RunFn; onSaved?: (rows: Build[]) => void } = {}) {
  return render(<TeamAllocation team={team} run={over.run ?? inlineRun} onSaved={over.onSaved ?? (() => undefined)} />);
}

describe('TeamAllocation', () => {
  it('says plainly that the result is greedy, and where the enemy comes from', () => {
    renderAllocation();
    expect(screen.getByText(/greedy, not optimal for the whole team/i)).toBeInTheDocument();
    expect(screen.getByText(/different order can give a better total/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing is equipped or changed until you save builds/i)).toBeInTheDocument();
    expect(
      screen.getByText(/mob, Lv 90, 10% base RES, from the Calculator's current settings.*reset to the defaults/i),
    ).toBeInTheDocument();
  });

  it('follows the Calculator enemy settings', () => {
    useCalculatorStore.setState({ enemyKind: 'boss', enemyLevel: 100, enemyBaseRES: 0.2 });
    renderAllocation();
    expect(screen.getByText(/boss, Lv 100, 20% base RES/)).toBeInTheDocument();
  });

  it('previews each member in priority order with the honest baseline label', async () => {
    const user = userEvent.setup();
    renderAllocation();
    await user.click(screen.getByRole('button', { name: 'Allocate Echoes' }));

    const preview = await screen.findByRole('region', { name: 'Allocation preview' });
    const rows = within(preview).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    // Flat ATK adds up: jiyan takes x11..x15, verina x6..x10, yangyang x1..x5.
    expect(rows[0]).toHaveTextContent('Priority 1 · Jiyan');
    for (const n of [11, 12, 13, 14, 15]) expect(rows[0]).toHaveTextContent(`Echo ${n}`);
    for (const n of [6, 7, 8, 9, 10]) expect(rows[1]).toHaveTextContent(`Echo ${n}`);
    for (const n of [1, 2, 3, 4, 5]) expect(rows[2]).toHaveTextContent(`Echo ${n}`);
    // Only jiyan has five equipped Echoes, so only they get a comparison.
    expect(rows[0]).toHaveTextContent(/% vs your equipped Echoes, best slot-1 order/);
    expect(rows[1]).toHaveTextContent('No comparison: 0 of 5 Echoes equipped.');
    expect(within(preview).getByText(/Greedy result: members earlier in the order took first pick/)).toBeInTheDocument();
    expect(await db.builds.count()).toBe(0); // preview writes nothing
  });

  it('blocks a member with no usable build, with the reason, and will not run', async () => {
    useLibraryStore.setState({ builds: ['jiyan', 'verina'].map(build), loaded: true });
    renderAllocation();
    expect(screen.getByText(/no saved build with an objective/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Allocate Echoes' })).toBeDisabled();
  });

  it('blocks Resonance Mode characters and points to the Calculator', () => {
    useLibraryStore.setState({
      builds: [{ ...build('verina'), characterId: 'denia', id: 'b-denia', weaponId: 'augment' }, build('jiyan'), build('yangyang')],
      loaded: true,
    });
    useRosterStore.setState({ entries: [roster('jiyan'), { ...roster('verina'), characterId: 'denia' }, roster('yangyang')], loaded: true });
    render(
      <TeamAllocation
        team={{ ...team, characterIds: ['jiyan', 'denia', 'yangyang'] }}
        run={inlineRun}
        onSaved={() => undefined}
      />,
    );
    expect(screen.getByText(/Resonance Modes.*Calculator/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Allocate Echoes' })).toBeDisabled();
  });

  it('lets you reorder priorities with buttons', async () => {
    const user = userEvent.setup();
    renderAllocation();
    await user.click(screen.getByRole('button', { name: 'Move Verina up' }));
    const order = within(screen.getByRole('list', { name: 'Priority order' })).getAllByRole('listitem');
    expect(order[0]).toHaveTextContent('Verina');
    expect(screen.getByRole('button', { name: 'Move Verina up' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Allocate Echoes' }));
    const preview = await screen.findByRole('region', { name: 'Allocation preview' });
    expect(within(preview).getAllByRole('listitem')[0]).toHaveTextContent('Priority 1 · Verina');
  });

  it('saves one build per member atomically, then reports the rows for Undo', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    renderAllocation({ onSaved });
    await user.click(screen.getByRole('button', { name: 'Allocate Echoes' }));
    await screen.findByRole('region', { name: 'Allocation preview' });

    await user.click(screen.getByRole('button', { name: 'Save as 3 builds' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const rows = onSaved.mock.calls[0][0] as Build[];
    expect(rows).toHaveLength(3);
    const saved = (await db.builds.toArray()).filter((b) => b.name.startsWith('Main ·'));
    expect(saved).toHaveLength(3);
    const jiyan = saved.find((b) => b.characterId === 'jiyan')!;
    expect([...jiyan.echoIds].sort()).toEqual(['x11', 'x12', 'x13', 'x14', 'x15']);
    expect(jiyan).toMatchObject({ weaponId: 'verdant-summit', objectiveId: 'Max ATK', notes: expect.stringContaining('greedy') });
    expect(jiyan.context?.characterId).toBe('jiyan');
    expect(screen.getByRole('button', { name: 'Saved' })).toBeDisabled();
    // Allocation writes builds only; nothing is equipped.
    expect((await db.ownedEchoes.toArray()).every((e) => e.equippedTo === null)).toBe(true);
    expect(useInventoryStore.getState().echoes.filter((e) => e.equippedTo !== null)).toHaveLength(5);
  });

  it('disables Save when the inputs changed after the run', async () => {
    const user = userEvent.setup();
    renderAllocation();
    await user.click(screen.getByRole('button', { name: 'Allocate Echoes' }));
    await screen.findByRole('region', { name: 'Allocation preview' });
    expect(screen.getByRole('button', { name: 'Save as 3 builds' })).toBeEnabled();

    act(() => useInventoryStore.setState((s) => ({ echoes: s.echoes.filter((e) => e.id !== 'x15') })));

    expect(await screen.findByText(/your inputs changed since this preview/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save as 3 builds' })).toBeDisabled();
  });

  it('goes stale when an Echo substat is edited after the run, but not when it is locked', async () => {
    const user = userEvent.setup();
    renderAllocation();
    await user.click(screen.getByRole('button', { name: 'Allocate Echoes' }));
    await screen.findByRole('region', { name: 'Allocation preview' });

    act(() =>
      useInventoryStore.setState((s) => ({ echoes: s.echoes.map((e) => (e.id === 'x15' ? { ...e, locked: true as const } : e)) })),
    );
    expect(screen.queryByText(/your inputs changed since this preview/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save as 3 builds' })).toBeEnabled();

    act(() =>
      useInventoryStore.setState((s) => ({
        echoes: s.echoes.map((e) => (e.id === 'x15' ? { ...e, substats: [{ stat: 'atk' as StatKey, value: 1 }] } : e)),
      })),
    );
    expect(await screen.findByText(/your inputs changed since this preview/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save as 3 builds' })).toBeDisabled();
  });

  it('goes stale when the game data is replaced after the run', async () => {
    const user = userEvent.setup();
    renderAllocation();
    await user.click(screen.getByRole('button', { name: 'Allocate Echoes' }));
    await screen.findByRole('region', { name: 'Allocation preview' });

    const original = useSnapshotStore.getState().snapshot;
    try {
      act(() => useSnapshotStore.setState({ snapshot: { ...original, fetchedAt: '2099-01-01T00:00:00.000Z' } }));
      expect(await screen.findByText(/your inputs changed since this preview/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Save as 3 builds' })).toBeDisabled();
    } finally {
      useSnapshotStore.setState({ snapshot: original });
    }
  });

  it('cancels a run: workers are cancelled, nothing is previewed, and it can run again', async () => {
    const user = userEvent.setup();
    const cancel = vi.fn();
    let first = true;
    const run: RunFn = (data, request) => {
      if (first) {
        first = false;
        return { promise: new Promise(() => undefined), cancel, onProgress: () => undefined };
      }
      return inlineRun(data, request);
    };
    renderAllocation({ run });
    await user.click(screen.getByRole('button', { name: 'Allocate Echoes' }));
    expect(await screen.findByText('Starting…')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Allocation preview' })).not.toBeInTheDocument();
    expect(await db.builds.count()).toBe(0);

    await user.click(screen.getByRole('button', { name: 'Allocate Echoes' }));
    expect(await screen.findByRole('region', { name: 'Allocation preview' })).toBeInTheDocument();
  });

  it('shows per-member progress while running', async () => {
    const user = userEvent.setup();
    let report: ((evaluated: number, total: number) => void) | null = null;
    const run: RunFn = () => ({
      promise: new Promise(() => undefined),
      cancel: () => undefined,
      onProgress: (cb) => (report = cb),
    });
    // jiyan has five equipped Echoes, so the first step is their baseline.
    renderAllocation({ run });
    await user.click(screen.getByRole('button', { name: 'Allocate Echoes' }));
    await waitFor(() => expect(report).not.toBeNull());
    act(() => report!(50, 100));
    expect(await screen.findByText('Scoring equipped Echoes: Jiyan (1 of 3) — 50%')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move Jiyan down' })).toBeDisabled(); // no reordering mid-run
  });

  it('rejects a bad minimum level', async () => {
    const user = userEvent.setup();
    renderAllocation();
    await user.clear(screen.getByLabelText(/minimum echo level/i));
    await user.type(screen.getByLabelText(/minimum echo level/i), '30');
    expect(screen.getByText(/must be a whole number from 0 to 25/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Allocate Echoes' })).toBeDisabled();
  });

  it('needs at least five Echoes', () => {
    useInventoryStore.setState({ echoes: inventory().slice(0, 4), loaded: true });
    renderAllocation();
    expect(screen.getByText(/at least 5 Echoes/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Allocate Echoes' })).toBeDisabled();
  });

  it('shows the error and keeps going state clean when a step fails', async () => {
    const user = userEvent.setup();
    const run: RunFn = () => ({ promise: Promise.reject(new Error('boom')), cancel: () => undefined, onProgress: () => undefined });
    renderAllocation({ run });
    await user.click(screen.getByRole('button', { name: 'Allocate Echoes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('jiyan: boom');
    expect(screen.getByRole('button', { name: 'Allocate Echoes' })).toBeEnabled();
  });

  it('lets you pick which saved build to use', async () => {
    const user = userEvent.setup();
    useLibraryStore.setState({
      builds: [
        ...['jiyan', 'verina', 'yangyang'].map(build),
        { ...build('jiyan'), id: 'b-jiyan-2', name: 'Jiyan crit', updatedAt: '2026-10-21T00:00:00.000Z', objective: { kind: 'max-stat', stat: 'critRate' as StatKey } },
      ],
      loaded: true,
    });
    renderAllocation();
    const select = screen.getByLabelText('Build for Jiyan');
    expect(select).toHaveValue('b-jiyan-2'); // newest by default
    await user.selectOptions(select, 'b-jiyan');
    expect(select).toHaveValue('b-jiyan');
  });
});
