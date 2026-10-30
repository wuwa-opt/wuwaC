import 'fake-indexeddb/auto';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadBundledSnapshot } from '../../data/index.ts';
import type { OwnedEcho, RosterEntry } from '../../data/schema.ts';
import type { ResonanceMode } from '../../domain/characterMods.ts';
import { standardMob } from '../../domain/damage.ts';
import type { EnemySettings } from '../../domain/enemy.ts';
import { emptySheet } from '../../domain/stats.ts';
import type { OptimizeRequest, SearchData, SearchResult } from '../../optimizer/search.ts';
import { runOptimization, type OptimizationHandle } from '../../optimizer/worker.ts';
import { db } from '../../state/db.ts';
import { useCalculatorStore } from '../../state/calculator.ts';
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
  over: { enemySettings?: EnemySettings; resonanceMode?: ResonanceMode; echoes?: OwnedEcho[] } = {},
) {
  return render(
    <RotationOptimizer
      character={jiyan}
      weapon={verdant}
      roster={context}
      echoes={over.echoes ?? echoes}
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
  useCalculatorStore.getState().setMinStatTexts({});
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

describe('RotationOptimizer Sonata lock tip', () => {
  const many = (n: number): OwnedEcho[] => Array.from({ length: n }, (_, i) => echo(`m${i}`, 25, null));
  const tip = /a 5-piece Sonata lock makes the search many times faster/i;

  it('shows for a large pool with no lock, and stays out of the way for a small one', () => {
    const small = renderOptimizer(roster, { echoes: many(99) });
    expect(screen.queryByText(tip)).not.toBeInTheDocument();
    small.unmount();
    renderOptimizer(roster, { echoes: many(100) });
    expect(screen.getByText(tip)).toBeInTheDocument();
    expect(screen.getByText(/2\+2 lock helps much less/)).toBeInTheDocument();
  });

  it('is gone once a 5-piece lock is chosen, and stays for 2+2', async () => {
    const user = userEvent.setup();
    renderOptimizer(roster, { echoes: many(150) });
    await user.selectOptions(screen.getByLabelText('Sonata lock'), 'five');
    expect(screen.queryByText(tip)).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Sonata lock'), 'twoPlusTwo');
    expect(screen.getByText(tip)).toBeInTheDocument();
  });

  it('counts the pool being searched, not the whole inventory', async () => {
    const user = userEvent.setup();
    renderOptimizer(roster, { echoes: [...many(60), ...Array.from({ length: 60 }, (_, i) => echo(`w${i}`, 25, 'verina'))] });
    expect(screen.getByText(tip)).toBeInTheDocument(); // 120 candidates
    await user.click(screen.getByLabelText(/skip echoes equipped on other characters/i));
    expect(screen.queryByText(tip)).not.toBeInTheDocument(); // 60 left
  });
});

describe('RotationOptimizer progress', () => {
  const resolved: SearchResult = {
    builds: [{ echoIds: ['a', 'b', 'e', 'f', 'g'], score: 1000, sheet: emptySheet(), warnings: [], appliedAssumptions: [] }],
    evaluated: 5000,
    scored: 120,
    total: 5000,
    prunedEchoes: [],
  };

  it('shows covered-of-total progress, then the checked and scored counts', async () => {
    const user = userEvent.setup();
    const fake = fakeHandle();
    run.mockReturnValue(fake.handle);
    renderOptimizer();
    await user.click(screen.getByRole('button', { name: /find best builds/i }));
    act(() => fake.progress(1234, 5000));
    expect(screen.getByText('Checked 1,234 of 5,000 combos (24%)…')).toBeInTheDocument();
    expect(screen.getByText(/the count can jump: whole groups of combos are ruled out at once/i)).toBeInTheDocument();
    await act(async () => {
      fake.resolve(resolved);
      await fake.handle.promise;
    });
    expect(screen.getByText(/Checked 5,000 combos \(120 scored in full\)/)).toBeInTheDocument();
    expect(screen.queryByText(/Running for/)).not.toBeInTheDocument();
  });

  describe('while running', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('says it is preparing until the first progress arrives, never "0 of 0"', async () => {
      const fake = fakeHandle();
      run.mockReturnValue(fake.handle);
      renderOptimizer();
      fireEvent.click(screen.getByRole('button', { name: /find best builds/i }));
      expect(screen.getByText('Preparing the search…')).toBeInTheDocument();
      expect(screen.queryByText(/0 of 0/)).not.toBeInTheDocument();
      expect(screen.queryByText(/the count can jump/i)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
      act(() => fake.progress(0, 9_000_000));
      expect(screen.getByText('Checked 0 of 9,000,000 combos (0%)…')).toBeInTheDocument();
      expect(screen.queryByText('Preparing the search…')).not.toBeInTheDocument();
    });

    it('counts the elapsed time up even when the count does not move', () => {
      vi.useFakeTimers();
      const fake = fakeHandle();
      run.mockReturnValue(fake.handle);
      renderOptimizer();
      fireEvent.click(screen.getByRole('button', { name: /find best builds/i }));
      expect(screen.getByText('Running for 0:00')).toBeInTheDocument();
      act(() => fake.progress(0, 9_000_000));
      act(() => {
        vi.advanceTimersByTime(83_000);
      });
      expect(screen.getByText('Running for 1:23')).toBeInTheDocument();
      expect(screen.getByText('Checked 0 of 9,000,000 combos (0%)…')).toBeInTheDocument();
    });

    it('keeps the live region calm: it changes by quarters, not on every count', () => {
      const fake = fakeHandle();
      run.mockReturnValue(fake.handle);
      renderOptimizer();
      fireEvent.click(screen.getByRole('button', { name: /find best builds/i }));
      const live = screen.getByRole('status');
      expect(live).toHaveTextContent('Preparing the search.');
      act(() => fake.progress(10, 1000));
      const started = live.textContent;
      expect(started).toBe('Search running, 0% or more checked.');
      act(() => fake.progress(240, 1000));
      expect(live.textContent).toBe(started);
      act(() => fake.progress(260, 1000));
      expect(live.textContent).toBe('Search running, 25% or more checked.');
      // The ticking text is not in the live region and is hidden from assistive tech.
      expect(screen.getByText(/Running for/).closest('[aria-hidden="true"]')).not.toBeNull();
    });

    it('keeps the screen on while the search runs, and lets it sleep after', async () => {
      const sentinel = { released: false, release: vi.fn(() => ((sentinel.released = true), Promise.resolve())) };
      const request = vi.fn(() => Promise.resolve(sentinel));
      Object.defineProperty(navigator, 'wakeLock', { value: { request }, configurable: true });
      try {
        const fake = fakeHandle();
        run.mockReturnValue(fake.handle);
        renderOptimizer();
        expect(request).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: /find best builds/i }));
        await waitFor(() => expect(request).toHaveBeenCalledWith('screen'));
        await act(async () => {
          fake.resolve(resolved);
          await fake.handle.promise;
        });
        await waitFor(() => expect(sentinel.released).toBe(true));
      } finally {
        delete (navigator as { wakeLock?: unknown }).wakeLock;
      }
    });

    it('stops the timer when the run finishes', async () => {
      vi.useFakeTimers();
      const fake = fakeHandle();
      run.mockReturnValue(fake.handle);
      renderOptimizer();
      fireEvent.click(screen.getByRole('button', { name: /find best builds/i }));
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      await act(async () => {
        fake.resolve(resolved);
        await fake.handle.promise;
      });
      expect(screen.queryByText(/Running for/)).not.toBeInTheDocument();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('stops the timer on Cancel, and on unmount', () => {
      vi.useFakeTimers();
      run.mockReturnValue(fakeHandle().handle);
      const view = renderOptimizer();
      fireEvent.click(screen.getByRole('button', { name: /find best builds/i }));
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByText(/Running for/)).not.toBeInTheDocument();
      expect(vi.getTimerCount()).toBe(0);

      fireEvent.click(screen.getByRole('button', { name: /find best builds/i }));
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      view.unmount();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('stops the timer when the run errors', async () => {
      vi.useFakeTimers();
      run.mockReturnValue({
        promise: Promise.reject(new Error('boom')),
        cancel: vi.fn(),
        onProgress: () => undefined,
      } satisfies OptimizationHandle);
      renderOptimizer();
      fireEvent.click(screen.getByRole('button', { name: /find best builds/i }));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByText('boom')).toBeInTheDocument();
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

describe('RotationOptimizer minimum stats', () => {
  const resolved: SearchResult = {
    builds: [{ echoIds: ['a', 'b', 'e', 'f', 'g'], score: 1000, sheet: emptySheet(), warnings: [], appliedAssumptions: [], mainEchoId: 'e' }],
    evaluated: 1,
    scored: 1,
    total: 1,
    prunedEchoes: [],
  };
  const requestOf = (): OptimizeRequest => run.mock.calls[0][1];

  async function open(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await user.click(screen.getByRole('button', { name: /minimum stats/i }));
  }

  it('is collapsed by default and sends no minimum when every box is empty', async () => {
    const user = userEvent.setup();
    run.mockReturnValue(fakeHandle().handle);
    renderOptimizer();
    expect(screen.getByRole('button', { name: /minimum stats/i })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText(/minimum energy regen/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /find best builds/i }));
    expect(requestOf()).not.toHaveProperty('minStats');
  });

  it('shows boxes prefilled from the store (a shared draft) and searches with them', async () => {
    const user = userEvent.setup();
    useCalculatorStore.getState().setMinStatTexts({ energyRegen: '20', critRate: '60' });
    run.mockReturnValue(fakeHandle().handle);
    renderOptimizer();
    expect(screen.getByRole('button', { name: /minimum stats \(2 set\)/i })).toBeInTheDocument();
    await open(user);
    expect(screen.getByLabelText(/minimum energy regen/i)).toHaveValue('20');
    expect(screen.getByLabelText(/minimum crit rate/i)).toHaveValue('60');
    await user.click(screen.getByRole('button', { name: /find best builds/i }));
    expect(requestOf().minStats?.energyRegen).toBeCloseTo(0.2, 10);
    expect(requestOf().minStats?.critRate).toBeCloseTo(0.6, 10);
  });

  it('sends typed percentages as sheet fractions (20 -> 0.2) and skips empty or zero boxes', async () => {
    const user = userEvent.setup();
    run.mockReturnValue(fakeHandle().handle);
    renderOptimizer();
    await open(user);
    await user.type(screen.getByLabelText(/minimum energy regen/i), '20');
    await user.type(screen.getByLabelText(/minimum crit rate/i), '0');
    await user.click(screen.getByRole('button', { name: /find best builds/i }));
    expect(requestOf().minStats).toEqual({ energyRegen: 0.2 });
  });

  it('takes all three, including decimals', async () => {
    const user = userEvent.setup();
    run.mockReturnValue(fakeHandle().handle);
    renderOptimizer();
    await open(user);
    await user.type(screen.getByLabelText(/minimum energy regen/i), '12.5');
    await user.type(screen.getByLabelText(/minimum crit rate/i), '70');
    await user.type(screen.getByLabelText(/minimum crit dmg/i), '200');
    expect(screen.getByRole('button', { name: /minimum stats \(3 set\)/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /find best builds/i }));
    expect(requestOf().minStats).toEqual({ energyRegen: 0.125, critRate: 0.7, critDmg: 2 });
  });

  it('rejects a non-number or negative minimum without running', async () => {
    const user = userEvent.setup();
    renderOptimizer();
    await open(user);
    const er = screen.getByLabelText(/minimum energy regen/i);
    await user.type(er, 'lots');
    await user.click(screen.getByRole('button', { name: /find best builds/i }));
    expect(screen.getByRole('alert')).toHaveTextContent(/minimum energy regen must be a non-negative number/i);
    await user.clear(er);
    await user.type(er, '-5');
    await user.click(screen.getByRole('button', { name: /find best builds/i }));
    expect(screen.getByRole('alert')).toHaveTextContent(/non-negative number/i);
    expect(run).not.toHaveBeenCalled();
  });

  it("saves the run's minimums on the build, not later edits to the boxes", async () => {
    await db.builds.clear();
    useLibraryStore.setState({ builds: [], loaded: true });
    const user = userEvent.setup();
    const fake = fakeHandle();
    run.mockReturnValue(fake.handle);
    renderOptimizer();
    await open(user);
    await user.type(screen.getByLabelText(/minimum energy regen/i), '20');
    await user.click(screen.getByRole('button', { name: /find best builds/i }));
    await act(async () => {
      fake.resolve(resolved);
      await fake.handle.promise;
    });
    await user.clear(screen.getByLabelText(/minimum energy regen/i));
    await user.type(screen.getByLabelText(/minimum energy regen/i), '99');
    await user.click(screen.getByRole('button', { name: /^save$/i }));
    await user.type(screen.getByRole('textbox', { name: /build name/i }), 'ER run');
    await user.click(screen.getByRole('button', { name: /confirm save/i }));
    const [row] = await db.builds.toArray();
    expect(row.minStats).toEqual({ energyRegen: 0.2 });
  });

  it('saves no minStats key for a run without minimums', async () => {
    await db.builds.clear();
    useLibraryStore.setState({ builds: [], loaded: true });
    const user = userEvent.setup();
    const fake = fakeHandle();
    run.mockReturnValue(fake.handle);
    renderOptimizer();
    await user.click(screen.getByRole('button', { name: /find best builds/i }));
    await act(async () => {
      fake.resolve(resolved);
      await fake.handle.promise;
    });
    await user.click(screen.getByRole('button', { name: /^save$/i }));
    await user.type(screen.getByRole('textbox', { name: /build name/i }), 'Plain run');
    await user.click(screen.getByRole('button', { name: /confirm save/i }));
    const [row] = await db.builds.toArray();
    expect(row).not.toHaveProperty('minStats');
  });
});

describe('RotationOptimizer cost budget', () => {
  it('offers no budget choice, says what layouts are searched, and always runs under 12', async () => {
    const user = userEvent.setup();
    run.mockReturnValue(fakeHandle().handle);
    renderOptimizer();
    expect(screen.queryByLabelText(/cost budget/i)).not.toBeInTheDocument();
    expect(screen.getByText(/in every layout up to 12 cost \(e\.g\. 4-4-1-1-1 and 4-3-3-1-1\)/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /find best builds/i }));
    expect(run.mock.calls[0][1].costBudget).toBe(12);
  });

  it('points at what the user can still loosen when nothing qualifies', async () => {
    const user = userEvent.setup();
    const fake = fakeHandle();
    run.mockReturnValue(fake.handle);
    renderOptimizer();
    await user.click(screen.getByRole('button', { name: /find best builds/i }));
    await act(async () => {
      fake.resolve({ builds: [], evaluated: 0, scored: 0, total: 0, prunedEchoes: [] });
      await fake.handle.promise;
    });
    expect(screen.getByText(/No valid builds — try loosening the minimum stats, the Sonata lock or the Echo filters\./)).toBeInTheDocument();
    expect(screen.queryByText(/loosen the budget/i)).not.toBeInTheDocument();
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
