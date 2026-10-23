import { create } from 'zustand';
import type { ScanDraft } from '../scanner/draft.ts';
import { screenshotProblem } from '../scanner/imageLimits.ts';
import type { FrameReader } from '../scanner/engine.ts';
import { isPanelless, parsePanel, type PanelParse, type ScanBatch } from '../scanner/parse.ts';
import { parseCost } from '../scanner/pipeline.ts';
import type { ScanItem } from '../scanner/review.ts';
import type { FrameGrabber, VideoScanOptions, VideoScanResult } from '../scanner/videoFrames.ts';
import { useSnapshotStore } from './snapshotStore.ts';

/**
 * Echo scanner session (memory only — screenshots and crops never touch
 * IndexedDB). Images are OCR'd by the lazily loaded engine
 * (scanner/engine.ts pulls in tesseract.js, so it is code-split out of the
 * main bundle and fetched on the first scan), parsed against the active
 * snapshot, and held for review. Importing goes through the inventory
 * store's normal `importEchoes` write path.
 */

export interface ScanBatchSettings {
  /** The set picked in the app; '' = read it from the game (the in-game filter tag). */
  sonataId: string;
  rarity: number;
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
  /** Second frames of a recording for flagged panels (absent = none). */
  openGrabber?: (video: File) => Promise<FrameGrabber>;
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
  openGrabber: async (video) => {
    const { openFrameGrabber } = await import('../scanner/videoFrames.ts');
    return openFrameGrabber(video);
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
  /** Flagged panels re-read from a later frame, and how many of those read better. */
  reread: number;
  improved: number;
  cancelled: boolean;
  error: string | null;
}

/**
 * Frames that show no Echo panel (`isPanelless`: the in-game Filter
 * sheet, another menu, the desktop) are dropped from a video scan; a
 * dropped screenshot still fails visibly on its own row.
 */
export { isPanelless };

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

  /** Latest image whose preview an item should show (a re-read can replace the first). */
  const thumbFor = new Map<string, Blob>();
  const setThumb = (id: string, image: Blob): void => {
    thumbFor.set(id, image);
    void deps
      .thumbnail(image)
      .then((thumbUrl) => {
        if (thumbUrl === null) return;
        const item = get().items.find((it) => it.id === id);
        if (item === undefined || thumbFor.get(id) !== image) {
          URL.revokeObjectURL(thumbUrl);
          return;
        }
        if (item.thumbUrl !== null) URL.revokeObjectURL(item.thumbUrl);
        patchItem(id, { thumbUrl });
      })
      .catch(() => undefined);
  };

  /**
   * OCR + parse one image. `second` (video only) gives a later frame of
   * the same panel: when the first read is flagged, that frame is read
   * too and its parse kept only if `parseCost` strictly drops — the same
   * rule as pass 5, so it adds no trust of its own.
   */
  const readOne = async (
    id: string,
    image: File,
    batch: ScanBatch,
    second?: () => Promise<File>,
  ): Promise<'first' | 'second' | 'kept'> => {
    // A refused file fails on its own row; the rest of the batch carries on.
    try {
      const problem = (await deps.validate?.(image)) ?? null;
      if (problem !== null) {
        patchItem(id, { status: 'failed', error: problem });
        return 'first';
      }
    } catch (err) {
      patchItem(id, { status: 'failed', error: err instanceof Error ? err.message : 'Could not check this image.' });
      return 'first';
    }
    setThumb(id, image);
    try {
      const read = await ensureReader();
      const snapshot = useSnapshotStore.getState().snapshot;
      const parseFn = (words: Parameters<typeof parsePanel>[0], extras?: Parameters<typeof parsePanel>[3]) => parsePanel(words, batch, snapshot, extras);
      let parse: PanelParse = (await read(image, parseFn)).parse;
      let outcome: 'first' | 'second' | 'kept' = 'first';
      // Sonata flags come from the filter tag, not the panel: another frame cannot help them.
      if (second !== undefined && parse.flags.some((f) => f.field !== 'sonata') && !isPanelless(parse)) {
        outcome = 'kept';
        try {
          const later = await second();
          const reread = (await read(later, parseFn)).parse;
          if (parseCost(reread) < parseCost(parse)) {
            parse = reread;
            outcome = 'second';
            setThumb(id, later);
          }
        } catch {
          // No second frame: the first read stands, flags and all.
        }
      }
      patchItem(id, { status: 'done', parse });
      return outcome;
    } catch (err) {
      patchItem(id, { status: 'failed', error: err instanceof Error ? err.message : 'Could not read this image.' });
      return 'first';
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
    return { sonataId: sonataId === '' ? null : sonataId, rarity };
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
      const reads: Promise<'first' | 'second' | 'kept'>[] = [];
      const grabber = deps.openGrabber === undefined ? null : await deps.openGrabber(file).catch(() => null);
      let cancelled = false;
      let error: string | null = null;
      set({ video: { fileName: file.name, t: 0, duration: 0, found: 0 }, lastVideo: null });
      try {
        await walk(file, {
          signal: abort.signal,
          onProgress: (t, duration) => set((s) => (s.video === null ? {} : { video: { ...s.video, t, duration } })),
          onFrame: (frame, segment) => {
            const item = newItem(frame.name, batch);
            ids.push(item.id);
            set((s) => ({ items: [...s.items, item], video: s.video === null ? null : { ...s.video, found: s.video.found + 1 } }));
            const alt = segment.alt;
            reads.push(readOne(item.id, frame, batch, grabber === null || alt === null ? undefined : () => grabber.grab(alt)));
          },
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') cancelled = true;
        else error = err instanceof Error ? err.message : 'Could not scan that recording.';
      } finally {
        videoAbort = null;
      }
      const outcomes = await Promise.all(reads);
      grabber?.close();
      const reread = outcomes.filter((o) => o !== 'first').length;
      const improved = outcomes.filter((o) => o === 'second').length;
      const panelless = get().items.filter((it) => ids.includes(it.id) && it.parse !== undefined && isPanelless(it.parse));
      get().clear(panelless.map((it) => it.id));
      set({
        video: null,
        lastVideo: { fileName: file.name, found: ids.length - panelless.length, skipped: panelless.length, reread, improved, cancelled, error },
      });
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
      for (const it of drop) thumbFor.delete(it.id);
      const dropIds = new Set(drop.map((it) => it.id));
      set((s) => ({ items: s.items.filter((it) => !dropIds.has(it.id)) }));
    },
  };
});
