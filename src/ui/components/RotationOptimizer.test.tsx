import 'fake-indexeddb/auto';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadBundledSnapshot } from '../../data/index.ts';
import type { OwnedEcho, RosterEntry } from '../../data/schema.ts';
import type { ResonanceMode } from '../../domain/characterMods.ts';
import { standardMob } from '../../domain/damage.ts';
import type { EnemySettings } from '../../optimizer/allocateMembers.ts';
import { emptySheet } from '../../domain/stats.ts';
import type { SearchData, SearchResult } from '../../optimizer/search.ts';
import { runOptimization, type OptimizationHandle } from '../../optimizer/worker.ts';
import { db } from '../../state/db.ts';
import { useLibraryStore } from '../../state/library.ts';
import { RotationOptimizer } from './RotationOptimizer.tsx';

vi.mock('../../optimizer/worker.ts', () => ({ runOptimization: vi.fn() }));

const snapshot = loadBundledSnapshot();
const jiyan = snapshot.characters.find((c) => c.id === 'jiyan')!;
const verdant = snapshot.weapons.find((w) => w.id === 'verdant-summit')!;
const liberation = jiyan.skills.find((s) => s.kind === 'liberation')!;
const roster: RosterEntry = {
  characterId: 'jiyan',
  level: 90,
  ascension: 6,
  resonanceChain: 0,
  forteLevels: {},
  weaponId: 'verdant-summit',
  weaponLevel: 90,
  weaponRank: 1,
};

function echo(id: string, level: number, equippedTo: string | null): OwnedEcho {
  return {
    id, label: id, echoDefId: `${id}-def`, sonataId: 'sierra-gale', cost: 1, level, rarity: 5,
    mainStat: { stat: 'atkPct', value: 0.18 }, substats: [], equippedTo, origin: 'manual',
  };
}

// Seven echoes: two below level 20, two equipped on Verina, one on Jiyan.
const echoes = [
  echo('a', 25, null),
  echo('b', 25, 'jiyan'),
  echo('c', 25, 'verina'),
  echo('d', 25, 'verina'),
  echo('e', 20, null),
  echo('f', 10, null),
  echo('g', 0, null),
];

/** A controllable stand-in for the worker handle. */
function fakeHandle() {
  let resolve!: (result: SearchResult) => void;
  let progress: ((evaluated: number, total: number) => void) | null = null;
  const handle: OptimizationHandle = {
    promise: new Promise<SearchResult>((r) => {
      resolve = r;
    }),
    cancel: vi.fn(),
    onProgress: (callback) => {
      progress = callback;
    },
  };
  return { handle, resolve: (r: SearchResult) => resolve(r), progress: (e: number, t: number) => progress?.(e, t) };
}

function renderOptimizer(
  context: RosterEntry = roster,
  over: { enemySettings?: EnemySettings; resonanceMode?: ResonanceMode } = {},
) {
  return render(
    <RotationOptimizer
      character={jiyan}
      weapon={verdant}
      roster={context}
      echoes={echoes}
      sonataSets={snapshot.sonataSets}
      enemy={standardMob(90)}
      enemySettings={over.enemySettings ?? { kind: 'mob', level: 90, baseRES: 0.1 }}
      resonanceMode={over.resonanceMode}
      blocks={[{ skillId: liberation.id, motionName: liberation.motionValues[0].name, forteLevel: 10, activeBuffIds: [] }]}
      buffs={[]}
      globalBuffIds={[]}
      crit="expected"
      currentDpr={null}
      rotationTime={10}
      onApply={() => {}}
    />,
  );
}

const run = vi.mocked(runOptimization);
const searchedIds = (): string[] => (run.mock.calls[0][0] as SearchData).echoes.map((e) => e.id);

beforeEach(() => {
  run.mockReset();
});

describe('RotationOptimizer candidate filters', () => {
  it('searches the whole inventory by default', async () => {
    const user = userEvent.setup();
    run.mockReturnValue(fakeHandle().handle);
    renderOptimizer();
    expect(screen.getByText(/Searching 7 of 7 echoes/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /find best builds/i }));
    expect(searchedIds()).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  });

  it('skips echoes equipped elsewhere and below the minimum level', async () => {
    const user = userEvent.setup();
    run.mockReturnValue(fakeHandle().handle);
    renderOptimizer();
    await user.click(screen.getByRole('checkbox', { name: /equipped on other characters/i }));
    expect(screen.getByText(/Searching 5 of 7 echoes/)).toBeInTheDocument();
    const level = screen.getByLabelText(/minimum echo level/i);
    await user.clear(level);
    await user.type(level, '10');
    // a, b (equipped on Jiyan himself), e, f — c/d are Verina's, g is level 0.
    expect(screen.getByText(/Searching 4 of 7 echoes/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /find best builds/i })).toBeDisabled();
    await user.clear(level);
    await user.type(level, '0');
    await user.click(screen.getByRole('button', { name: /find best builds/i }));
    expect(searchedIds()).toEqual(['a', 'b', 'e', 'f', 'g']);
  });

  it('rejects an out-of-range minimum level', async () => {
    const user = userEvent.setup();
    renderOptimizer();
    const level = screen.getByLabelText(/minimum echo level/i);
    await user.clear(level);
    await user.type(level, '30');
    await user.click(screen.getByRole('button', { name: /find best builds/i }));
    expect(screen.getByText(/minimum level must be a whole number from 0 to 25/i)).toBeInTheDocument();
    expect(run).not.toHaveBeenCalled();
  });
});

describe('RotationOptimizer progress', () => {
  it('shows covered-of-total progress, then the checked and scored counts', async () => {
    const user = userEvent.setup();
    const fake = fakeHandle();
    run.mockReturnValue(fake.handle);
    renderOptimizer();
    await user.click(screen.getByRole('button', { name: /find best builds/i }));
    act(() => fake.progress(1234, 5000));
    expect(screen.getByRole('status')).toHaveTextContent('Checked 1,234 of 5,000 combos…');
    await act(async () => {
      fake.resolve({
        builds: [{ echoIds: ['a', 'b', 'e', 'f', 'g'], score: 1000, sheet: emptySheet(), warnings: [], appliedAssumptions: [] }],
        evaluated: 5000,
        scored: 120,
        total: 5000,
        prunedEchoes: [],
      });
      await fake.handle.promise;
    });
    expect(screen.getByText(/Checked 5,000 combos \(120 scored in full\)/)).toBeInTheDocument();
  });
});

describe('RotationOptimizer cancel', () => {
  const result: SearchResult = {
    builds: [{ echoIds: ['a', 'b', 'e', 'f', 'g'], score: 1000, sheet: emptySheet(), warnings: [], appliedAssumptions: [] }],
    evaluated: 5000,
    scored: 120,
    total: 5000,
    prunedEchoes: [],
  };

  it('offers Cancel only while running; it stops the worker and returns to idle with no error', async () => {
    const user = userEvent.setup();
    const fake = fakeHandle();
    run.mockReturnValue(fake.handle);
    renderOptimizer();
    expect(screen.queryByRole('button', { name: /^cancel$/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /find best builds/i }));
    act(() => fake.progress(10, 5000));
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(fake.handle.cancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^cancel$/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /find best builds/i })).toBeEnabled();
  });

  it('ignores progress, results and errors that arrive after Cancel', async () => {
    const user = userEvent.setup();
    const fake = fakeHandle();
    run.mockReturnValue(fake.handle);
    renderOptimizer();
    await user.click(screen.getByRole('button', { name: /find best builds/i }));
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));
    await act(async () => {
      fake.progress(99, 5000);
      fake.resolve(result);
      await fake.handle.promise;
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByText(/Checked 5,000 combos/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /apply to loadout/i })).not.toBeInTheDocument();
  });

  it('a late rejection after Cancel shows no error', async () => {
    const user = userEvent.setup();
    let reject!: (err: Error) => void;
    const handle: OptimizationHandle = {
      promise: new Promise<SearchResult>((_, r) => {
        reject = r;
      }),
      cancel: vi.fn(),
      onProgress: () => {},
    };
    run.mockReturnValue(handle);
    renderOptimizer();
    await user.click(screen.getByRole('button', { name: /find best builds/i }));
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));
    await act(async () => {
      reject(new Error('worker terminated'));
      await handle.promise.catch(() => {});
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a new run after Cancel works normally', async () => {
    const user = userEvent.setup();
    const first = fakeHandle();
    const second = fakeHandle();
    run.mockReturnValueOnce(first.handle).mockReturnValueOnce(second.handle);
    renderOptimizer();
    await user.click(screen.getByRole('button', { name: /find best builds/i }));
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));
    await user.click(screen.getByRole('button', { name: /find best builds/i }));
    await act(async () => {
      first.resolve({ ...result, evaluated: 1 });
      second.resolve({ ...result, evaluated: 4242 });
      await second.handle.promise;
    });
    expect(screen.getByText(/Checked 4,242 combos/)).toBeInTheDocument();
  });
});

describe('RotationOptimizer save', () => {
  it('saves the context the run used, not the Roster', async () => {
    await db.builds.clear();
    useLibraryStore.setState({ builds: [], loaded: true });
    // e.g. a shared-build draft: nothing like the default roster above.
    const draft: RosterEntry = {
      characterId: 'jiyan',
      level: 70,
      ascension: 4,
      resonanceChain: 3,
      forteLevels: { [liberation.id]: 8 },
      forteUnlockedIds: [],
      weaponId: 'verdant-summit',
      weaponLevel: 60,
      weaponAscension: 3,
      weaponRank: 2,
    };
    const user = userEvent.setup();
    const fake = fakeHandle();
    run.mockReturnValue(fake.handle);
    renderOptimizer(draft);
    await user.click(screen.getByRole('button', { name: /find best builds/i }));
    await act(async () => {
      fake.resolve({
        builds: [{ echoIds: ['a', 'b', 'e', 'f', 'g'], score: 1000, sheet: emptySheet(), warnings: [], appliedAssumptions: [], mainEchoId: 'e' }],
        evaluated: 1,
        scored: 1,
        total: 1,
        prunedEchoes: [],
      });
      await fake.handle.promise;
    });
    await user.click(screen.getByRole('button', { name: /^save$/i }));
    await user.type(screen.getByRole('textbox', { name: /build name/i }), 'Draft run');
    await user.click(screen.getByRole('button', { name: /confirm save/i }));

    const rows = await db.builds.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0].context).toEqual(draft);
    expect(rows[0].echoIds).toEqual(['e', 'a', 'b', 'f', 'g']);
  });

  it('saves the enemy and Resonance Mode the run used, not later Calculator edits', async () => {
    await db.builds.clear();
    useLibraryStore.setState({ builds: [], loaded: true });
    const user = userEvent.setup();
    const fake = fakeHandle();
    run.mockReturnValue(fake.handle);
    const view = renderOptimizer(roster, { enemySettings: { kind: 'boss', level: 100, baseRES: 0.2 }, resonanceMode: 'tuneStrain' });
    await user.click(screen.getByRole('button', { name: /find best builds/i }));
    expect((run.mock.calls[0][0] as SearchData).resonanceMode).toBe('tuneStrain');
    await act(async () => {
      fake.resolve({
        builds: [{ echoIds: ['a', 'b', 'e', 'f', 'g'], score: 1000, sheet: emptySheet(), warnings: [], appliedAssumptions: [], mainEchoId: 'e' }],
        evaluated: 1,
        scored: 1,
        total: 1,
        prunedEchoes: [],
      });
      await fake.handle.promise;
    });
    // The user moves the Calculator's enemy after the run; the build keeps the run's.
    view.rerender(
      <RotationOptimizer
        character={jiyan}
        weapon={verdant}
        roster={roster}
        echoes={echoes}
        sonataSets={snapshot.sonataSets}
        enemy={standardMob(90)}
        enemySettings={{ kind: 'mob', level: 50, baseRES: 0 }}
        resonanceMode="tuneStrain"
        blocks={[{ skillId: liberation.id, motionName: liberation.motionValues[0].name, forteLevel: 10, activeBuffIds: [] }]}
        buffs={[]}
        globalBuffIds={[]}
        crit="expected"
        currentDpr={null}
        rotationTime={10}
        onApply={() => {}}
      />,
    );
    await user.click(screen.getByRole('button', { name: /^save$/i }));
    await user.type(screen.getByRole('textbox', { name: /build name/i }), 'Boss run');
    await user.click(screen.getByRole('button', { name: /confirm save/i }));

    const [row] = await db.builds.toArray();
    expect(row.enemy).toEqual({ kind: 'boss', level: 100, baseRES: 0.2 });
    expect(row.resonanceMode).toBe('tuneStrain');
  });

  it('saves no Resonance Mode for a single-mode run', async () => {
    await db.builds.clear();
    useLibraryStore.setState({ builds: [], loaded: true });
    const user = userEvent.setup();
    const fake = fakeHandle();
    run.mockReturnValue(fake.handle);
    renderOptimizer();
    await user.click(screen.getByRole('button', { name: /find best builds/i }));
    await act(async () => {
      fake.resolve({
        builds: [{ echoIds: ['a', 'b', 'e', 'f', 'g'], score: 1000, sheet: emptySheet(), warnings: [], appliedAssumptions: [] }],
        evaluated: 1,
        scored: 1,
        total: 1,
        prunedEchoes: [],
      });
      await fake.handle.promise;
    });
    await user.click(screen.getByRole('button', { name: /^save$/i }));
    await user.type(screen.getByRole('textbox', { name: /build name/i }), 'Plain');
    await user.click(screen.getByRole('button', { name: /confirm save/i }));

    const [row] = await db.builds.toArray();
    expect(row.enemy).toEqual({ kind: 'mob', level: 90, baseRES: 0.1 });
    expect(row).not.toHaveProperty('resonanceMode');
  });
});
