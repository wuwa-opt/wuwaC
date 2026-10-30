import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createProgressTracker,
  isWorkerOut,
  progressStep,
} from './protocol.ts';
import { defaultConcurrency, readDeviceHints, runOptimization, type WorkerLike } from './worker.ts';
import type { RunMessage } from './protocol.ts';
import type { OwnedEcho } from '../data/schema.ts';
import type { RankedBuild, SearchData, SearchResult } from './search.ts';
import { emptySheet } from '../domain/stats.ts';

describe('isWorkerOut', () => {
  it('accepts protocol messages and rejects impostors', () => {
    expect(isWorkerOut({ type: 'progress', id: 1, evaluated: 3, total: 56 })).toBe(true);
    expect(
      isWorkerOut({ type: 'result', id: 1, result: { builds: [], evaluated: 0, scored: 0, total: 0, prunedEchoes: [] } }),
    ).toBe(true);
    expect(isWorkerOut({ type: 'result', id: 1, result: { builds: [], evaluated: 0, prunedEchoes: [] } })).toBe(false);
    expect(isWorkerOut({ type: 'error', id: 1, message: 'boom' })).toBe(true);
    expect(isWorkerOut({ type: 'nope' })).toBe(false);
    expect(isWorkerOut(null)).toBe(false);
    expect(isWorkerOut('progress')).toBe(false);
    expect(isWorkerOut({ type: 'progress', id: 1 })).toBe(false);
  });
});

describe('createProgressTracker', () => {
  it('fires when a step boundary is crossed and flushes the tail', () => {
    const onProgress = vi.fn();
    const tracker = createProgressTracker(10, onProgress, 4);
    tracker.report(1);
    tracker.report(3);
    expect(onProgress).not.toHaveBeenCalled();
    tracker.report(4);
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenLastCalledWith(4, 10);
    tracker.report(7);
    expect(onProgress).toHaveBeenCalledTimes(1);
    // A skipped subtree jumps 7 -> 9, past the boundary at 8: fires once.
    tracker.report(9);
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenLastCalledWith(9, 10);
    tracker.report(10);
    tracker.flush();
    expect(onProgress).toHaveBeenCalledTimes(3);
    expect(onProgress).toHaveBeenLastCalledWith(10, 10);
  });

  it('announces the opening report(0) once, so the page learns the total at once', () => {
    const onProgress = vi.fn();
    const tracker = createProgressTracker(10_000_000, onProgress, 50_000);
    tracker.report(0);
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenLastCalledWith(0, 10_000_000);
    tracker.report(0);
    tracker.report(49_999);
    expect(onProgress).toHaveBeenCalledTimes(1);
    tracker.report(50_000);
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenLastCalledWith(50_000, 10_000_000);
    tracker.report(0); // never repeats, and never moves the throttle
    tracker.flush();
    expect(onProgress).toHaveBeenCalledTimes(2);
  });

  it('does not announce a report that starts above zero (behaviour unchanged)', () => {
    const onProgress = vi.fn();
    createProgressTracker(10, onProgress, 4).report(1);
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('sizes steps for about 200 updates, never below 1000 combos', () => {
    expect(progressStep(45)).toBe(1000);
    expect(progressStep(200_000)).toBe(1000);
    expect(progressStep(1_000_000)).toBe(5000);
    expect(progressStep(397_843_677)).toBe(1_989_219);
  });
});

describe('defaultConcurrency', () => {
  it('uses one worker for small pools and cores-minus-one (max 8) otherwise', () => {
    expect(defaultConcurrency(39, 16)).toBe(1);
    expect(defaultConcurrency(40, 4)).toBe(3);
    expect(defaultConcurrency(200, 16)).toBe(8);
    expect(defaultConcurrency(200, 1)).toBe(1);
    expect(defaultConcurrency(200, undefined)).toBe(1);
  });

  it('caps a phone at 4 and a device under 4 GB at 2, never raising the count', () => {
    expect(defaultConcurrency(200, 8, { phone: true })).toBe(4);
    expect(defaultConcurrency(200, 8, { phone: false })).toBe(7);
    expect(defaultConcurrency(200, 4, { phone: true })).toBe(3);
    expect(defaultConcurrency(200, 8, { phone: true, deviceMemoryGb: 2 })).toBe(2);
    expect(defaultConcurrency(200, 8, { deviceMemoryGb: 4 })).toBe(7);
    expect(defaultConcurrency(200, 16, { deviceMemoryGb: 8 })).toBe(8);
    expect(defaultConcurrency(200, 2, { deviceMemoryGb: 0.5 })).toBe(1);
    expect(defaultConcurrency(39, 8, { phone: true })).toBe(1);
  });
});

describe('readDeviceHints', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const stub = (nav: object, matches: Record<string, boolean>): void => {
    vi.stubGlobal('navigator', nav);
    vi.stubGlobal('window', { matchMedia: (query: string) => ({ matches: matches[query] ?? false }) });
  };

  it('calls a touch-only device a phone, but not a touch laptop with a trackpad', () => {
    stub({}, { '(pointer: coarse)': true, '(any-pointer: fine)': false });
    expect(readDeviceHints()).toEqual({ phone: true });
    stub({}, { '(pointer: coarse)': true, '(any-pointer: fine)': true });
    expect(readDeviceHints()).toEqual({ phone: false });
    stub({}, { '(pointer: fine)': true, '(any-pointer: fine)': true });
    expect(readDeviceHints()).toEqual({ phone: false });
  });

  it("trusts Chromium's userAgentData.mobile and reads deviceMemory", () => {
    stub({ userAgentData: { mobile: true }, deviceMemory: 4 }, { '(any-pointer: fine)': true });
    expect(readDeviceHints()).toEqual({ phone: true, deviceMemoryGb: 4 });
  });

  it('runs a big pool on 4 workers on an 8-core phone', () => {
    stub({ hardwareConcurrency: 8, userAgentData: { mobile: true } }, {});
    const created: FakeWorker[] = [];
    const echoes = Array.from({ length: 200 }, (_, i) => ({ id: `e${i}` }));
    runOptimization({ echoes } as never, { topN: 5 } as never, {
      createWorker: () => {
        const worker = new FakeWorker();
        created.push(worker);
        return worker;
      },
    }).cancel();
    expect(created).toHaveLength(4);
  });
});

class FakeWorker implements WorkerLike {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  terminated = false;
  posted: unknown[] = [];

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  deliver(data: unknown): void {
    this.onmessage?.({ data });
  }
}

const canned: SearchResult = {
  builds: [{ echoIds: ['a', 'b', 'c', 'd', 'e'], score: 42, sheet: emptySheet(), warnings: [], appliedAssumptions: [] }],
  evaluated: 56,
  scored: 56,
  total: 56,
  prunedEchoes: [],
};

describe('runOptimization', () => {
  it('posts the run, forwards progress, and resolves the result', async () => {
    const fake = new FakeWorker();
    const handle = runOptimization(
      { character: 'c' } as never,
      { topN: 5 } as never,
      { createWorker: () => fake, concurrency: 1 },
    );
    expect(fake.posted).toHaveLength(1);
    expect(fake.posted[0]).toMatchObject({ type: 'run' });

    const onProgress = vi.fn();
    handle.onProgress(onProgress);
    const id = (fake.posted[0] as { id: number }).id;
    fake.deliver({ type: 'progress', id, evaluated: 3, total: 56 });
    expect(onProgress).toHaveBeenCalledWith(3, 56);

    fake.deliver({ type: 'result', id, result: canned });
    await expect(handle.promise).resolves.toBe(canned);
    expect(fake.terminated).toBe(true);
  });

  it('rejects on worker errors and ignores stale ids', async () => {
    const fake = new FakeWorker();
    const handle = runOptimization({} as never, {} as never, { createWorker: () => fake, concurrency: 1 });
    const id = (fake.posted[0] as { id: number }).id;

    fake.deliver({ type: 'progress', id: 9999, evaluated: 1, total: 2 });
    fake.deliver({ type: 'error', id, message: 'boom' });
    await expect(handle.promise).rejects.toThrow('boom');
  });

  it('cancel terminates without settling', async () => {
    const fake = new FakeWorker();
    const handle = runOptimization({} as never, {} as never, { createWorker: () => fake, concurrency: 1 });
    let settled = false;
    void handle.promise.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    handle.cancel();
    expect(fake.terminated).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
  });
});

function echo(id: string): OwnedEcho {
  return {
    id, echoDefId: `${id}-def`, sonataId: 'set', cost: 1, level: 25, rarity: 5,
    mainStat: { stat: 'atk', value: 1 }, substats: [], equippedTo: null, origin: 'manual',
  };
}

function build(ids: string[], score: number): RankedBuild {
  return { echoIds: ids, score, sheet: emptySheet(), warnings: [], appliedAssumptions: [] };
}

describe('runOptimization across worker shards', () => {
  const data = { echoes: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(echo) } as unknown as SearchData;

  it('sends each worker its shard, sums progress, and merges the top-N', async () => {
    const fakes = [new FakeWorker(), new FakeWorker()];
    let made = 0;
    const handle = runOptimization(data, { topN: 2 } as never, {
      createWorker: () => fakes[made++],
      concurrency: 2,
    });
    const runs = fakes.map((f) => f.posted[0] as RunMessage);
    expect(runs.map((r) => r.shard)).toEqual([{ index: 0, count: 2 }, { index: 1, count: 2 }]);
    const onProgress = vi.fn();
    handle.onProgress(onProgress);
    fakes[0].deliver({ type: 'progress', id: runs[0].id, evaluated: 10, total: 21 });
    fakes[1].deliver({ type: 'progress', id: runs[1].id, evaluated: 11, total: 21 });
    expect(onProgress).toHaveBeenLastCalledWith(21, 21);

    // Equal scores rank by position in data.echoes: {a,b,c,d,f} before {a,b,c,e,f}.
    const shard0: SearchResult = {
      builds: [build(['a', 'b', 'c', 'e', 'f'], 9), build(['a', 'b', 'c', 'd', 'g'], 5)],
      evaluated: 10, scored: 4, total: 21, prunedEchoes: [],
    };
    const shard1: SearchResult = {
      builds: [build(['a', 'b', 'c', 'd', 'f'], 9)],
      evaluated: 11, scored: 3, total: 21, prunedEchoes: [],
    };
    fakes[0].deliver({ type: 'result', id: runs[0].id, result: shard0 });
    expect(fakes.every((f) => !f.terminated)).toBe(true);
    fakes[1].deliver({ type: 'result', id: runs[1].id, result: shard1 });
    const merged = await handle.promise;
    expect(merged.builds.map((b) => b.echoIds)).toEqual([
      ['a', 'b', 'c', 'd', 'f'],
      ['a', 'b', 'c', 'e', 'f'],
    ]);
    expect(merged).toMatchObject({ evaluated: 21, scored: 7, total: 21 });
    expect(fakes.every((f) => f.terminated)).toBe(true);
  });

  it('one failing shard rejects the run and stops every worker', async () => {
    const fakes = [new FakeWorker(), new FakeWorker(), new FakeWorker()];
    let made = 0;
    const handle = runOptimization(data, { topN: 1 } as never, {
      createWorker: () => fakes[made++],
      concurrency: 3,
    });
    const id = (fakes[1].posted[0] as RunMessage).id;
    fakes[1].deliver({ type: 'error', id, message: 'shard boom' });
    await expect(handle.promise).rejects.toThrow('shard boom');
    expect(fakes.every((f) => f.terminated)).toBe(true);
  });

  it('cancel terminates every worker', () => {
    const fakes = [new FakeWorker(), new FakeWorker()];
    let made = 0;
    const handle = runOptimization(data, { topN: 1 } as never, {
      createWorker: () => fakes[made++],
      concurrency: 2,
    });
    handle.cancel();
    expect(fakes.every((f) => f.terminated)).toBe(true);
  });
});
