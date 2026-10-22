import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
import type { MarkedEquipped } from './MarkEquipped.tsx';
import { useTeamStore } from '../../state/teamStore.ts';
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
  await Promise.all([db.builds.clear(), db.roster.clear(), db.ownedEchoes.clear(), db.teams.clear()]);
  await db.teams.add(team);
  useTeamStore.setState({ teams: [team], loaded: true });
  useInventoryStore.setState({ echoes: inventory(), loaded: true });
  useLibraryStore.setState({ builds: ['jiyan', 'verina', 'yangyang'].map(build), loaded: true });
  useRosterStore.setState({ entries: ['jiyan', 'verina', 'yangyang'].map(roster), loaded: true });
  useCalculatorStore.setState({ enemyKind: 'mob', enemyLevel: 90, enemyBaseRES: 0.1 });
});

function renderAllocation(
  over: { run?: RunFn; onSaved?: (rows: Build[]) => void; onMarked?: (marked: MarkedEquipped) => void; team?: Team } = {},
) {
  return render(
    <TeamAllocation
      team={over.team ?? team}
      run={over.run ?? inlineRun}
      onSaved={over.onSaved ?? (() => undefined)}
      onMarked={over.onMarked}
    />,
  );
}

/** Wraps `inlineRun`, recording what each step was asked to search. */
function recordingRun(): { run: RunFn; calls: { characterId: string; resonanceMode: unknown; costBudget: number }[] } {
  const calls: { characterId: string; resonanceMode: unknown; costBudget: number }[] = [];
  const run: RunFn = (data, request) => {
    calls.push({ characterId: data.character.id, resonanceMode: data.resonanceMode, costBudget: request.costBudget });
    return inlineRun(data, request);
  };
  return { run, calls };
}

/** jiyan, denia (dual-mode, Rectifier), yangyang; denia's build is `deniaBuild`. */
function seedDenia(deniaBuild: Partial<Build> = {}): Team {
  const withDenia: Team = { ...team, id: 't2', characterIds: ['jiyan', 'denia', 'yangyang'] };
  useLibraryStore.setState({
    builds: [{ ...build('verina'), characterId: 'denia', id: 'b-denia', name: 'Denia ATK', ...deniaBuild }, build('jiyan'), build('yangyang')],
    loaded: true,
  });
  useRosterStore.setState({ entries: [roster('jiyan'), { ...roster('verina'), characterId: 'denia' }, roster('yangyang')], loaded: true });
  useTeamStore.setState({ teams: [withDenia], loaded: true });
  return withDenia;
}

describe('TeamAllocation', () => {
  it('says plainly that the result is greedy, and where the enemy comes from', () => {
    renderAllocation();
    expect(screen.getByText(/greedy, not optimal for the whole team/i)).toBeInTheDocument();
    expect(screen.getByText(/different order can give a better total/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing is saved or changed until you save builds or mark them as equipped/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Builds saved with an enemy use it\. The rest use the Calculator's current settings \(mob, Lv 90, 10% base RES\).*reset to the defaults/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/cost budget of 12, the same budget your equipped Echoes are checked against/)).toBeInTheDocument();
  });

  it('follows the Calculator enemy settings for builds that saved none', () => {
    useCalculatorStore.setState({ enemyKind: 'boss', enemyLevel: 100, enemyBaseRES: 0.2 });
    renderAllocation();
    expect(screen.getByText(/current settings \(boss, Lv 100, 20% base RES\)/)).toBeInTheDocument();
    const rows = within(screen.getByRole('list', { name: 'Priority order' })).getAllByRole('listitem');
    for (const row of rows) {
      expect(row).toHaveTextContent("Enemy: boss, Lv 100, 20% base RES (the Calculator's current settings; this build saved none).");
    }
  });

  it("says per member when it uses the build's saved enemy instead", () => {
    useLibraryStore.setState({
      builds: [{ ...build('jiyan'), enemy: { kind: 'boss', level: 110, baseRES: 0.3 } }, build('verina'), build('yangyang')],
      loaded: true,
    });
    renderAllocation();
    const rows = within(screen.getByRole('list', { name: 'Priority order' })).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Enemy: boss, Lv 110, 30% base RES (saved with the build).');
    expect(rows[1]).toHaveTextContent("Enemy: mob, Lv 90, 10% base RES (the Calculator's current settings; this build saved none).");
  });

  it("says per member which minimum stats the build saved, and that they apply", () => {
    useLibraryStore.setState({
      builds: [{ ...build('jiyan'), minStats: { energyRegen: 0.2, critRate: 0.6 } }, build('verina'), build('yangyang')],
      loaded: true,
    });
    renderAllocation();
    const rows = within(screen.getByRole('list', { name: 'Priority order' })).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Minimum stats: Energy Regen ≥ 20%, Crit Rate ≥ 60% (saved with the build).');
    expect(rows[1]).not.toHaveTextContent('Minimum stats');
    expect(screen.getByText(/Builds saved with minimum stats keep them/i)).toBeInTheDocument();
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

  it('asks for the Resonance Mode of a dual-mode member whose build saved none, and blocks Run until set', async () => {
    const user = userEvent.setup();
    const withDenia = seedDenia();
    const { run, calls } = recordingRun();
    renderAllocation({ team: withDenia, run });

    const picker = screen.getByLabelText('Resonance Mode for Denia');
    expect(picker).toHaveValue('');
    expect(picker).toBeRequired();
    expect(within(picker).getAllByRole('option').map((o) => o.textContent)).toEqual(['Pick a mode…', 'Fusion Burst', 'Tune Strain']);
    expect(screen.getByText(/saved no Resonance Mode\. Pick the mode Denia runs in/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Allocate Echoes' })).toBeDisabled();

    await user.selectOptions(picker, 'tuneStrain');
    expect(screen.getByRole('button', { name: 'Allocate Echoes' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Allocate Echoes' }));
    await screen.findByRole('region', { name: 'Allocation preview' });

    // Exactly as the Calculator does: the mode reaches SearchData, only for Denia.
    expect(calls.filter((c) => c.characterId === 'denia').map((c) => c.resonanceMode)).toEqual(['tuneStrain']);
    expect(calls.filter((c) => c.characterId !== 'denia').every((c) => c.resonanceMode === undefined)).toBe(true);
  });

  it("uses the build's saved Resonance Mode without asking", async () => {
    const user = userEvent.setup();
    const withDenia = seedDenia({ resonanceMode: 'fusionBurst' });
    const { run, calls } = recordingRun();
    renderAllocation({ team: withDenia, run });

    expect(screen.queryByLabelText('Resonance Mode for Denia')).not.toBeInTheDocument();
    expect(screen.getByText('Resonance Mode: Fusion Burst (saved with the build).')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Allocate Echoes' }));
    await screen.findByRole('region', { name: 'Allocation preview' });
    expect(calls.filter((c) => c.characterId === 'denia').map((c) => c.resonanceMode)).toEqual(['fusionBurst']);
  });

  it('saves the picked mode and the enemy each member ran against with the builds', async () => {
    const user = userEvent.setup();
    const withDenia = seedDenia({ enemy: { kind: 'boss', level: 100, baseRES: 0.2 } });
    const onSaved = vi.fn();
    renderAllocation({ team: withDenia, onSaved });
    await user.selectOptions(screen.getByLabelText('Resonance Mode for Denia'), 'fusionBurst');
    await user.click(screen.getByRole('button', { name: 'Allocate Echoes' }));
    await user.click(await screen.findByRole('button', { name: 'Save as 3 builds' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));

    const saved = (await db.builds.toArray()).filter((b) => b.name.startsWith('Main ·'));
    const denia = saved.find((b) => b.characterId === 'denia')!;
    expect(denia).toMatchObject({ resonanceMode: 'fusionBurst', enemy: { kind: 'boss', level: 100, baseRES: 0.2 } });
    const jiyan = saved.find((b) => b.characterId === 'jiyan')!;
    expect(jiyan.enemy).toEqual({ kind: 'mob', level: 90, baseRES: 0.1 });
    expect(jiyan).not.toHaveProperty('resonanceMode');
  });

  it('goes stale when the picked Resonance Mode changes after the run', async () => {
    const user = userEvent.setup();
    const withDenia = seedDenia();
    renderAllocation({ team: withDenia });
    await user.selectOptions(screen.getByLabelText('Resonance Mode for Denia'), 'tuneStrain');
    await user.click(screen.getByRole('button', { name: 'Allocate Echoes' }));
    await screen.findByRole('region', { name: 'Allocation preview' });
    expect(screen.getByRole('button', { name: 'Save as 3 builds' })).toBeEnabled();

    await user.selectOptions(screen.getByLabelText('Resonance Mode for Denia'), 'fusionBurst');
    expect(await screen.findByText(/your inputs changed since this preview/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save as 3 builds' })).toBeDisabled();
  });

  it('offers no cost budget and runs every step under 12', async () => {
    const user = userEvent.setup();
    const { run, calls } = recordingRun();
    renderAllocation({ run });
    expect(screen.queryByLabelText('Cost budget')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Allocate Echoes' }));
    await screen.findByRole('region', { name: 'Allocation preview' });
    // jiyan's baseline, then the three searches.
    expect(calls.map((c) => c.costBudget)).toEqual([12, 12, 12, 12]);
    expect(screen.getByRole('button', { name: 'Save as 3 builds' })).toBeEnabled();
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

  it('saves the order on the team on each reorder, so it survives a remount', async () => {
    const user = userEvent.setup();
    const first = renderAllocation();
    await user.click(screen.getByRole('button', { name: 'Move Yangyang up' }));
    await waitFor(() => expect(useTeamStore.getState().teams[0].priority).toEqual(['jiyan', 'yangyang', 'verina']));
    await user.click(screen.getByRole('button', { name: 'Move Yangyang up' }));
    await waitFor(() => expect(useTeamStore.getState().teams[0].priority).toEqual(['yangyang', 'jiyan', 'verina']));
    expect((await db.teams.get('t1'))?.priority).toEqual(['yangyang', 'jiyan', 'verina']);
    first.unmount();

    renderAllocation({ team: useTeamStore.getState().teams[0] });
    const order = within(screen.getByRole('list', { name: 'Priority order' })).getAllByRole('listitem');
    expect(order.map((li) => li.textContent?.match(/^\d\.(\w+)/)?.[1])).toEqual(['Yangyang', 'Jiyan', 'Verina']);
  });

  it('ignores a saved priority that is not an order of the members', () => {
    renderAllocation({ team: { ...team, priority: ['jiyan', 'rover', 'verina'] } });
    const order = within(screen.getByRole('list', { name: 'Priority order' })).getAllByRole('listitem');
    expect(order.map((li) => li.textContent?.match(/^\d\.(\w+)/)?.[1])).toEqual(['Jiyan', 'Verina', 'Yangyang']);
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

  it('shows elapsed time and activity while running, and stops the timer on Cancel', async () => {
    vi.useFakeTimers();
    try {
      let report: ((evaluated: number, total: number) => void) | null = null;
      const run: RunFn = () => ({
        promise: new Promise(() => undefined),
        cancel: () => undefined,
        onProgress: (cb) => (report = cb),
      });
      renderAllocation({ run });
      fireEvent.click(screen.getByRole('button', { name: 'Allocate Echoes' }));
      await act(async () => {
        for (let i = 0; i < 5; i += 1) await Promise.resolve();
      });
      expect(report).not.toBeNull();
      expect(screen.getByText('Running for 0:00')).toBeInTheDocument();
      act(() => report!(0, 100));
      act(() => {
        vi.advanceTimersByTime(65_000);
      });
      expect(screen.getByText('Running for 1:05')).toBeInTheDocument();
      // The live region names the step but not the ticking percent.
      expect(screen.getByText('Scoring equipped Echoes: Jiyan (1 of 3).')).toHaveAttribute('role', 'status');
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByText(/Running for/)).not.toBeInTheDocument();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
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

  describe('Mark as equipped', () => {
    /** x6 is worn by an outside character and x16 (weakest) is a sixth Echo marked on jiyan. */
    const gear = (): OwnedEcho[] => [
      ...inventory().map((e) => (e.id === 'x6' ? { ...e, equippedTo: 'calcharo' } : e)),
      echo(16, { equippedTo: 'jiyan', substats: [{ stat: 'atk' as StatKey, value: 1 }] }),
    ];
    const worn = (id: string): string | null => useInventoryStore.getState().echoes.find((e) => e.id === id)!.equippedTo;

    async function preview(user: ReturnType<typeof userEvent.setup>) {
      useInventoryStore.setState({ echoes: gear(), loaded: true });
      await db.ownedEchoes.bulkAdd(gear());
      const onMarked = vi.fn();
      renderAllocation({ onMarked });
      await user.click(screen.getByRole('button', { name: 'Allocate Echoes' }));
      await screen.findByRole('region', { name: 'Allocation preview' });
      return onMarked;
    }

    it('says it only records, and confirms exactly what changes, with Cancel focused', async () => {
      const user = userEvent.setup();
      await preview(user);
      expect(screen.getByText(/updates WuWaOpt.s record only\. Equip these in the game too/i)).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Mark as equipped' }));

      const confirm = screen.getByRole('group', { name: 'Confirm mark as equipped' });
      expect(within(confirm).getByText('15 Echoes assigned: Jiyan ×5, Verina ×5, Yangyang ×5.')).toBeInTheDocument();
      expect(within(confirm).getByText('6 Echoes taken from other characters: Calcharo ×1, Jiyan ×5.')).toBeInTheDocument();
      expect(within(confirm).getByText('1 Echo unequipped, back to the bag.')).toBeInTheDocument();
      expect(within(confirm).getByRole('button', { name: 'Cancel' })).toHaveFocus();
      expect(within(confirm).getByRole('button', { name: 'Mark 16 Echoes' })).toBeEnabled();
      expect(worn('x1')).toBe('jiyan'); // nothing written yet
    });

    it('Cancel writes nothing', async () => {
      const user = userEvent.setup();
      const onMarked = await preview(user);
      await user.click(screen.getByRole('button', { name: 'Mark as equipped' }));
      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('group', { name: 'Confirm mark as equipped' })).not.toBeInTheDocument();
      expect(onMarked).not.toHaveBeenCalled();
      expect(worn('x11')).toBeNull();
    });

    it('records the allocation, hands the previous values to onMarked, and the preview goes stale', async () => {
      const user = userEvent.setup();
      const onMarked = await preview(user);
      await user.click(screen.getByRole('button', { name: 'Mark as equipped' }));
      await user.click(screen.getByRole('button', { name: 'Mark 16 Echoes' }));

      await waitFor(() => expect(onMarked).toHaveBeenCalledTimes(1));
      const { previous, applied } = onMarked.mock.calls[0][0] as {
        previous: { id: string; equippedTo: string | null }[];
        applied: { id: string; equippedTo: string | null }[];
      };
      expect(previous).toHaveLength(16);
      expect(previous.find((p) => p.id === 'x6')).toEqual({ id: 'x6', equippedTo: 'calcharo' });
      expect(applied.find((a) => a.id === 'x16')).toEqual({ id: 'x16', equippedTo: null });
      for (const n of [11, 12, 13, 14, 15]) expect(worn(`x${n}`)).toBe('jiyan');
      for (const n of [6, 7, 8, 9, 10]) expect(worn(`x${n}`)).toBe('verina');
      for (const n of [1, 2, 3, 4, 5]) expect(worn(`x${n}`)).toBe('yangyang');
      expect(worn('x16')).toBeNull();
      expect((await db.ownedEchoes.get('x16'))?.equippedTo).toBeNull();

      expect(await screen.findByText(/your inputs changed since this preview/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Mark as equipped' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Save as 3 builds' })).toBeDisabled();
      expect(screen.getByText(/already recorded as equipped this way\. Run again to compare against the new gear/i)).toBeInTheDocument();
    });

    it('is disabled for a stale preview', async () => {
      const user = userEvent.setup();
      await preview(user);
      expect(screen.getByRole('button', { name: 'Mark as equipped' })).toBeEnabled();
      act(() => useInventoryStore.setState((s) => ({ echoes: s.echoes.filter((e) => e.id !== 'x15') })));
      expect(await screen.findByText(/your inputs changed since this preview/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Mark as equipped' })).toBeDisabled();
    });

    it('closes an open confirm when the records change under it, and writes nothing', async () => {
      const user = userEvent.setup();
      const onMarked = await preview(user);
      await user.click(screen.getByRole('button', { name: 'Mark as equipped' }));
      expect(screen.getByRole('group', { name: 'Confirm mark as equipped' })).toBeInTheDocument();

      act(() =>
        useInventoryStore.setState((s) => ({ echoes: s.echoes.map((e) => (e.id === 'x16' ? { ...e, equippedTo: 'verina' } : e)) })),
      );

      expect(screen.queryByRole('group', { name: 'Confirm mark as equipped' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Mark as equipped' })).toBeDisabled();
      expect(onMarked).not.toHaveBeenCalled();
      expect(worn('x11')).toBeNull();
    });

    it('re-running after marking compares against the gear just marked (stubbed run)', async () => {
      const user = userEvent.setup();
      const calls: number[] = [];
      const run: RunFn = (data, request) => {
        calls.push(data.echoes.length);
        return inlineRun(data, request);
      };
      useInventoryStore.setState({ echoes: gear(), loaded: true });
      await db.ownedEchoes.bulkAdd(gear());
      renderAllocation({ run });
      await user.click(screen.getByRole('button', { name: 'Allocate Echoes' }));
      await screen.findByRole('region', { name: 'Allocation preview' });
      await user.click(screen.getByRole('button', { name: 'Mark as equipped' }));
      await user.click(screen.getByRole('button', { name: 'Mark 16 Echoes' }));
      expect(await screen.findByText(/your inputs changed since this preview/i)).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Allocate Echoes' }));

      const rerun = await screen.findByRole('region', { name: 'Allocation preview' });
      const rows = within(rerun).getAllByRole('listitem');
      for (const row of rows) expect(row).toHaveTextContent('+0.0% vs your equipped Echoes, best slot-1 order');
      expect(within(rerun).queryByText(/No comparison/)).not.toBeInTheDocument();
      expect(screen.queryByText(/your inputs changed since this preview/i)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Mark as equipped' })).toBeDisabled(); // nothing left to record
    });
  });
});
