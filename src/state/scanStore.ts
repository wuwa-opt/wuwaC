import { create } from 'zustand';
import type { ScanDraft } from '../scanner/draft.ts';
import { screenshotProblem } from '../scanner/imageLimits.ts';
import type { FrameWords } from '../scanner/engine.ts';
import { parsePanel, type ScanBatch } from '../scanner/parse.ts';
import type { ScanItem } from '../scanner/review.ts';
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
  createReader: () => Promise<(image: Blob) => Promise<FrameWords>>;
  /** Panel-crop preview as an object URL (null = skip). */
  thumbnail: (image: Blob) => Promise<string | null>;
  /**
   * Why an image can't be scanned (size/format limits), or null when fine.
   * Runs before any decode; absent = no check (fake deps in tests).
   */
  validate?: (image: File) => Promise<string | null>;
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
};

let deps: ScanDeps = browserDeps;
let reader: Promise<(image: Blob) => Promise<FrameWords>> | null = null;

/** Test seam: swap the OCR engine/thumbnailer (resets the cached reader). */
export function setScanDeps(next: ScanDeps | null): void {
  deps = next ?? browserDeps;
  reader = null;
}

type EngineState = 'idle' | 'loading' | 'ready' | 'error';

interface ScanState {
  batch: ScanBatchSettings;
  items: ScanItem[];
  engine: EngineState;
  engineError: string | null;
  setBatch: (patch: Partial<ScanBatchSettings>) => void;
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

  const ensureReader = (): Promise<(image: Blob) => Promise<FrameWords>> => {
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
      const { words } = await read(image);
      const parse = parsePanel(words, batch, useSnapshotStore.getState().snapshot);
      patchItem(id, { status: 'done', parse });
    } catch (err) {
      patchItem(id, { status: 'failed', error: err instanceof Error ? err.message : 'Could not read this image.' });
    }
  };

  return {
    batch: { sonataId: '', rarity: 5, expected: null },
    items: [],
    engine: 'idle',
    engineError: null,

    setBatch: (patch) => set((s) => ({ batch: { ...s.batch, ...patch } })),

    addImages: async (images) => {
      const { sonataId, rarity } = get().batch;
      if (sonataId === '') throw new Error('Pick the Sonata set your in-game filter shows first.');
      const added: ScanItem[] = images.map((image) => ({
        id: `scan-${++nextId}`,
        fileName: image.name,
        thumbUrl: null,
        batch: { sonataId, rarity },
        status: 'reading',
      }));
      set((s) => ({ items: [...s.items, ...added] }));
      await Promise.all(added.map((item, i) => readOne(item.id, images[i], item.batch)));
    },

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
