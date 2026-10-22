import { create } from 'zustand';
import type { ScanDraft } from '../scanner/draft.ts';
import { screenshotProblem } from '../scanner/imageLimits.ts';
import type { FrameReader } from '../scanner/engine.ts';
import { parsePanel, type PanelParse, type ScanBatch } from '../scanner/parse.ts';
import type { ScanItem } from '../scanner/review.ts';
import type { VideoScanOptions, VideoScanResult } from '../scanner/videoFrames.ts';
import { useSnapshotStore } from './snapshotStore.ts';

/**
 * Echo scanner session (memory only — screenshots and crops never touch
 * IndexedDB). Images are OCR'd by the lazily loaded engine
 * (scanner/engine.ts pulls in tesseract.js, so it is code-split out of the
 * main bundle and fetched on the first scan), parsed against the active
 * snapshot, and held for review. Importing goes through the inventory
 * store's normal `importEchoes` write path.
 */

export interface ScanBatchSettings extends ScanBatch {
  /** The in-game filter's count for this set, for a done/overshoot check. */
  expected: number | null;
}

export interface ScanDeps {
  /** Resolves an OCR reader; called once, on the first image. */
  createReader: () => Promise<FrameReader>;
  /** Panel-crop preview as an object URL (null = skip). */
  thumbnail: (image: Blob) => Promise<string | null>;
  /**
   * Why an image can't be scanned (size/format limits), or null when fine.
   * Runs before any decode; absent = no check (fake deps in tests).
   */
  validate?: (image: File) => Promise<string | null>;
  /** Walk a screen recording, emitting one frame per settled panel (absent = no video support). */
  scanVideo?: (video: File, options: VideoScanOptions) => Promise<VideoScanResult>;
}

const browserDeps: ScanDeps = {
  validate: screenshotProblem,
  createReader: async () => {
    const { createScanEngine } = await import('../scanner/engine.ts');
    const engine = await createScanEngine(2);
    return engine.read;
  },
  thumbnail: async (image) => {
    const { panelThumbnail } = await import('../scanner/engine.ts');
    return panelThumbnail(image);
  },
  scanVideo: async (video, options) => {
    const { scanVideo } = await import('../scanner/videoFrames.ts');
    return scanVideo(video, options);
  },
};

let deps: ScanDeps = browserDeps;
let reader: Promise<FrameReader> | null = null;

/** Test seam: swap the OCR engine/thumbnailer (resets the cached reader). */
export function setScanDeps(next: ScanDeps | null): void {
  deps = next ?? browserDeps;
  reader = null;
}

type EngineState = 'idle' | 'loading' | 'ready' | 'error';

/** A recording being walked (null when none). */
export interface VideoJob {
  fileName: string;
  /** Video time reached by the sampler, seconds. */
  t: number;
  duration: number;
  /** Panels found so far (frames handed to OCR). */
  found: number;
}

/** What the last finished (or cancelled/failed) recording produced. */
export interface VideoOutcome {
  fileName: string;
  found: number;
  /** Frames that turned out to show no Echo panel (dropped). */
  skipped: number;
  cancelled: boolean;
  error: string | null;
}

/**
 * A frame shows no Echo panel when the parser recognized none of name,
 * cost and main stat (e.g. the desktop before the game window, or another
 * menu). Such frames are dropped from a video scan; a dropped screenshot
 * still fails visibly on its own row.
 */
export function isPanelless(parse: PanelParse): boolean {
  return parse.echo.echoDefId === null && parse.echo.cost === null && parse.echo.mainStat === null;
}

let videoAbort: AbortController | null = null;

interface ScanState {
  batch: ScanBatchSettings;
  items: ScanItem[];
  engine: EngineState;
  engineError: string | null;
  video: VideoJob | null;
  lastVideo: VideoOutcome | null;
  setBatch: (patch: Partial<ScanBatchSettings>) => void;
  /**
   * Walk a screen recording under the current batch: each settled panel
   * becomes an item (read as it is found). Resolves when the video is
   * walked and every frame is read. One recording at a time.
   */
  addVideo: (video: File) => Promise<void>;
  cancelVideo: () => void;
  /** OCR + parse each image under the current batch; resolves when all are read. */
  addImages: (images: File[]) => Promise<void>;
  /** Resolve an "Equipped by" choice (Rover) or clear it. */
  setEquipped: (id: string, characterId: string | null) => void;
  setOverride: (id: string, draft: ScanDraft) => void;
  setInclude: (id: string, include: boolean) => void;
  remove: (id: string) => void;
  /** Drop items (all when `ids` is omitted), releasing their previews. */
  clear: (ids?: readonly string[]) => void;
}

function release(items: readonly ScanItem[]): void {
  for (const item of items) {
    if (item.thumbUrl !== null) URL.revokeObjectURL(item.thumbUrl);
  }
}

let nextId = 0;

export const useScanStore = create<ScanState>()((set, get) => {
  const patchItem = (id: string, patch: Partial<ScanItem>): void => {
    set((s) => ({ items: s.items.map((it) => (it.id === id ? { ...it, ...patch } : it)) }));
  };

  const ensureReader = (): Promise<FrameReader> => {
    if (reader === null) {
      set({ engine: 'loading', engineError: null });
      reader = deps.createReader().then(
        (read) => {
          set({ engine: 'ready' });
          return read;
        },
        (err: unknown) => {
          reader = null;
          set({ engine: 'error', engineError: err instanceof Error ? err.message : 'The OCR engine failed to load.' });
          throw err;
        },
      );
    }
    return reader;
  };

  const readOne = async (id: string, image: File, batch: ScanBatch): Promise<void> => {
    // A refused file fails on its own row; the rest of the batch carries on.
    try {
      const problem = (await deps.validate?.(image)) ?? null;
      if (problem !== null) {
        patchItem(id, { status: 'failed', error: problem });
        return;
      }
    } catch (err) {
      patchItem(id, { status: 'failed', error: err instanceof Error ? err.message : 'Could not check this image.' });
      return;
    }
    void deps
      .thumbnail(image)
      .then((thumbUrl) => {
        if (thumbUrl === null) return;
        if (get().items.some((it) => it.id === id)) patchItem(id, { thumbUrl });
        else URL.revokeObjectURL(thumbUrl);
      })
      .catch(() => undefined);
    try {
      const read = await ensureReader();
      const snapshot = useSnapshotStore.getState().snapshot;
      const { parse } = await read(image, (words) => parsePanel(words, batch, snapshot));
      patchItem(id, { status: 'done', parse });
    } catch (err) {
      patchItem(id, { status: 'failed', error: err instanceof Error ? err.message : 'Could not read this image.' });
    }
  };

  const newItem = (fileName: string, batch: ScanBatch): ScanItem => ({
    id: `scan-${++nextId}`,
    fileName,
    thumbUrl: null,
    batch,
    status: 'reading',
  });

  const currentBatch = (): ScanBatch => {
    const { sonataId, rarity } = get().batch;
    if (sonataId === '') throw new Error('Pick the Sonata set your in-game filter shows first.');
    return { sonataId, rarity };
  };

  return {
    batch: { sonataId: '', rarity: 5, expected: null },
    items: [],
    engine: 'idle',
    engineError: null,
    video: null,
    lastVideo: null,

    setBatch: (patch) => set((s) => ({ batch: { ...s.batch, ...patch } })),

    addImages: async (images) => {
      const batch = currentBatch();
      const added = images.map((image) => newItem(image.name, batch));
      set((s) => ({ items: [...s.items, ...added] }));
      await Promise.all(added.map((item, i) => readOne(item.id, images[i], item.batch)));
    },

    addVideo: async (file) => {
      const batch = currentBatch();
      const walk = deps.scanVideo;
      if (walk === undefined) throw new Error('Video scanning is not available here.');
      if (videoAbort !== null) throw new Error('A recording is already being scanned — wait for it or cancel it.');
      const abort = new AbortController();
      videoAbort = abort;
      const ids: string[] = [];
      const reads: Promise<void>[] = [];
      let cancelled = false;
      let error: string | null = null;
      set({ video: { fileName: file.name, t: 0, duration: 0, found: 0 }, lastVideo: null });
      try {
        await walk(file, {
          signal: abort.signal,
          onProgress: (t, duration) => set((s) => (s.video === null ? {} : { video: { ...s.video, t, duration } })),
          onFrame: (frame) => {
            const item = newItem(frame.name, batch);
            ids.push(item.id);
            set((s) => ({ items: [...s.items, item], video: s.video === null ? null : { ...s.video, found: s.video.found + 1 } }));
            reads.push(readOne(item.id, frame, batch));
          },
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') cancelled = true;
        else error = err instanceof Error ? err.message : 'Could not scan that recording.';
      } finally {
        videoAbort = null;
      }
      await Promise.all(reads);
      const panelless = get().items.filter((it) => ids.includes(it.id) && it.parse !== undefined && isPanelless(it.parse));
      get().clear(panelless.map((it) => it.id));
      set({ video: null, lastVideo: { fileName: file.name, found: ids.length - panelless.length, skipped: panelless.length, cancelled, error } });
    },

    cancelVideo: () => videoAbort?.abort(),

    setEquipped: (id, characterId) => {
      const item = get().items.find((it) => it.id === id);
      if (item?.parse === undefined) return;
      const echo = { ...item.parse.echo, equippedTo: characterId };
      delete echo.equippedCandidates;
      patchItem(id, {
        parse: {
          echo,
          flags: item.parse.flags.filter((f) => f.field !== 'equipped'),
        },
      });
    },

    setOverride: (id, draft) => patchItem(id, { override: draft }),

    setInclude: (id, include) => patchItem(id, { include }),

    remove: (id) => get().clear([id]),

    clear: (ids) => {
      const drop = ids === undefined ? get().items : get().items.filter((it) => ids.includes(it.id));
      release(drop);
      const dropIds = new Set(drop.map((it) => it.id));
      set((s) => ({ items: s.items.filter((it) => !dropIds.has(it.id)) }));
    },
  };
});
