import type { RunMessage } from './protocol.ts';
import { isWorkerOut } from './protocol.ts';
import { mergeShardResults, type OptimizeRequest, type SearchData, type SearchResult } from './search.ts';

/**
 * Optimizer layer: Web Worker host.
 * Runs the search off the main thread, split into deterministic shards
 * across several workers (`searchExhaustive`'s `shard`), and merges their
 * top-N lists into the single-run result. Cancel, or a new run replacing
 * this one, terminates every worker. The worker factory is injectable so
 * the dispatch logic is unit-testable without a real Worker (jsdom has none).
 */

export interface WorkerLike {
  postMessage: (message: unknown) => void;
  terminate: () => void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: { message: string }) => void) | null;
}

export interface OptimizationHandle {
  promise: Promise<SearchResult>;
  cancel: () => void;
  onProgress: (callback: (evaluated: number, total: number) => void) => void;
}

export interface RunOptimizationDeps {
  createWorker?: () => WorkerLike;
  /** Worker count; defaults to `defaultConcurrency` for this pool and device. */
  concurrency?: number;
}

/** Pools this small finish in well under a second on one worker. */
const SMALL_POOL = 40;
const MAX_WORKERS = 8;
/**
 * Phones: their CPUs pair a few fast cores with slow ones, run hot and are
 * short on memory. Measured 2026-10-30 (240-Echo, 37-set seed inventory,
 * `npm run bench`): pinned to 4 cores, 4 workers took 13.9 s and 7 took
 * 14.9 s (oversubscribed); on 12 threads 4 took 14.6 s and 7 took 12.5 s.
 * Each worker added ~17-20 MB in Chromium.
 */
const PHONE_MAX_WORKERS = 4;
/** Under 4 GB (`navigator.deviceMemory`, Chromium only: 0.25 … 8). */
const LOW_MEMORY_MAX_WORKERS = 2;

/** What the device says about itself (`readDeviceHints`); all optional. */
export interface DeviceHints {
  /** A phone or tablet: Chromium's `userAgentData.mobile`, or touch with no fine pointer at all. */
  phone?: boolean;
  deviceMemoryGb?: number;
}

/**
 * Workers for a pool of `poolSize` echoes: one for small pools, else one per
 * logical core minus one for the page, capped at 8, at 4 on a phone and at
 * 2 under 4 GB of memory. The search is sharded deterministically, so the
 * count changes only the time, never the result.
 */
export function defaultConcurrency(
  poolSize: number,
  hardwareConcurrency: number | undefined,
  device: DeviceHints = {},
): number {
  if (poolSize < SMALL_POOL) return 1;
  let cap = MAX_WORKERS;
  if (device.phone === true) cap = Math.min(cap, PHONE_MAX_WORKERS);
  if (device.deviceMemoryGb !== undefined && device.deviceMemoryGb < 4) cap = Math.min(cap, LOW_MEMORY_MAX_WORKERS);
  return Math.min(cap, Math.max(1, (hardwareConcurrency ?? 2) - 1));
}

/**
 * Read `DeviceHints` from the browser. Touch-only means a coarse primary
 * pointer and no fine pointer anywhere, so a touch-screen laptop (it has a
 * trackpad) is not a phone.
 */
export function readDeviceHints(): DeviceHints {
  if (typeof navigator === 'undefined') return {};
  const nav = navigator as Navigator & { userAgentData?: { mobile?: boolean }; deviceMemory?: number };
  const media = (query: string): boolean =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
  const touchOnly = media('(pointer: coarse)') && !media('(any-pointer: fine)');
  return {
    phone: nav.userAgentData?.mobile === true || touchOnly,
    ...(typeof nav.deviceMemory === 'number' ? { deviceMemoryGb: nav.deviceMemory } : {}),
  };
}

/** Post a search to worker shards; resolves with the merged result, rejects on any error. */
export function runOptimization(
  data: SearchData,
  request: OptimizeRequest,
  deps: RunOptimizationDeps = {},
): OptimizationHandle {
  const createWorker = deps.createWorker ?? defaultCreateWorker;
  const cores = typeof navigator === 'undefined' ? undefined : navigator.hardwareConcurrency;
  const count = Math.max(1, Math.floor(deps.concurrency ?? defaultConcurrency(data.echoes.length, cores, readDeviceHints())));
  const id = nextId();
  const workers: WorkerLike[] = [];
  const covered = new Array<number>(count).fill(0);
  const results = new Array<SearchResult | null>(count).fill(null);
  let total = 0;
  let progressCallback: ((evaluated: number, total: number) => void) | null = null;
  let settled = false;
  let resolvePromise!: (result: SearchResult) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<SearchResult>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  const finish = (action: () => void): void => {
    if (settled) return;
    settled = true;
    for (const worker of workers) worker.terminate();
    action();
  };

  for (let index = 0; index < count; index += 1) {
    const worker = createWorker();
    workers.push(worker);
    worker.onmessage = (event) => {
      const message = event.data;
      if (settled || !isWorkerOut(message) || message.id !== id) return;
      if (message.type === 'progress') {
        covered[index] = message.evaluated;
        total = message.total;
        progressCallback?.(covered.reduce((sum, c) => sum + c, 0), total);
      } else if (message.type === 'result') {
        results[index] = message.result;
        if (results.every((r) => r !== null)) {
          const done = results as SearchResult[];
          const merged = count === 1 ? done[0] : mergeShardResults(data, request.topN, done);
          finish(() => resolvePromise(merged));
        }
      } else {
        finish(() => rejectPromise(new Error(message.message)));
      }
    };
    worker.onerror = (event) => {
      finish(() => rejectPromise(new Error(event.message)));
    };
    const runMessage: RunMessage = { type: 'run', id, data, request, shard: { index, count } };
    worker.postMessage(runMessage);
  }

  return {
    promise,
    cancel: () => {
      finish(() => undefined);
    },
    onProgress: (callback) => {
      progressCallback = callback;
    },
  };
}

function defaultCreateWorker(): WorkerLike {
  const worker = new Worker(new URL('./optimizer.worker.ts', import.meta.url), { type: 'module' });
  return worker as unknown as WorkerLike;
}

let lastId = 0;
function nextId(): number {
  lastId += 1;
  return lastId;
}
