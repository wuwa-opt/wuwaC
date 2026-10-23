import { createWorker, PSM, type Page, type Worker } from 'tesseract.js';
import { panelRect } from './layout.ts';
import type { OcrWord } from './parse.ts';
import { readPanel, type OcrFn, type PanelRead, type ParseFn, type PixelFn } from './pipeline.ts';

/**
 * Scanner layer, browser side: binds the pure pass plan (pipeline.ts)
 * to a small pool of tesseract.js workers, plus a canvas for its pixel
 * checks (the filter tag's box, the gold "Equipped by" line). Each
 * tesseract worker is its
 * own Web Worker, so recognition never blocks the UI; this module only
 * queues frames. One frame runs start-to-finish on one worker because the
 * passes switch worker-level parameters (page-segmentation mode, digit
 * whitelist) between calls.
 *
 * All runtime files come from our own origin (`__WUWA_OCR_DIR__`, served
 * by the vite.config.ts `ocrAssets` plugin) — never a CDN. tesseract.js's
 * built-in IndexedDB cache is OFF: it writes to idb-keyval's unprefixed
 * `keyval-store` database, and this origin is shared with other Pages
 * repos. The service worker's `wuwa-ocr` cache keeps the files instead.
 */

export interface FrameRead extends PanelRead {
  width: number;
  height: number;
}

/** OCR + parse one screenshot/frame (passes 1–5). Rejects if the image cannot be decoded. */
export type FrameReader = (image: Blob, parse: ParseFn) => Promise<FrameRead>;

export interface ScanEngine {
  read: FrameReader;
  terminate: () => Promise<void>;
}

function ocrBaseUrl(): string {
  // Absolute: tesseract's worker runs from a blob: URL, where relative paths do not resolve.
  return new URL(`${import.meta.env.BASE_URL}${__WUWA_OCR_DIR__}`, window.location.href).href;
}

function pageWords(page: Page): OcrWord[] {
  return (page.blocks ?? [])
    .flatMap((b) => b.paragraphs)
    .flatMap((p) => p.lines)
    .flatMap((l) => l.words)
    .map((w) => ({ text: w.text, confidence: w.confidence, bbox: w.bbox }));
}

async function frameSize(image: Blob): Promise<{ width: number; height: number }> {
  const bitmap = await createImageBitmap(image);
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return size;
}

function bindOcr(worker: Worker, image: Blob, bitmap: ImageBitmap): OcrFn {
  return async (rect, mode) => {
    await worker.setParameters({
      tessedit_pageseg_mode: mode === 'sparse' ? PSM.SPARSE_TEXT : mode === 'line' || mode === 'tag' ? PSM.SINGLE_LINE : PSM.SINGLE_BLOCK,
      tessedit_char_whitelist: mode === 'digits' ? '0123456789.%' : '',
    });
    if (mode !== 'tag') {
      const { data } = await worker.recognize(image, { rectangle: rect }, { blocks: true });
      return pageWords(data);
    }
    // The tag: a crop of the decoded frame, so the worker decodes a few KB instead of the frame.
    const canvas = document.createElement('canvas');
    canvas.width = rect.width;
    canvas.height = rect.height;
    canvas.getContext('2d')?.drawImage(bitmap, rect.left, rect.top, rect.width, rect.height, 0, 0, rect.width, rect.height);
    const { data } = await worker.recognize(canvas, {}, { blocks: true });
    return pageWords(data).map((w) => ({
      ...w,
      bbox: { x0: w.bbox.x0 + rect.left, y0: w.bbox.y0 + rect.top, x1: w.bbox.x1 + rect.left, y1: w.bbox.y1 + rect.top },
    }));
  };
}

/** Pixels of one region of the decoded frame, via a canvas (main thread; regions are small). */
function bindPixels(bitmap: ImageBitmap): PixelFn {
  return (rect) => {
    const canvas = document.createElement('canvas');
    canvas.width = rect.width;
    canvas.height = rect.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (ctx === null) return Promise.reject(new Error('No 2D canvas available to check the image.'));
    ctx.drawImage(bitmap, rect.left, rect.top, rect.width, rect.height, 0, 0, rect.width, rect.height);
    const { data } = ctx.getImageData(0, 0, rect.width, rect.height);
    return Promise.resolve({ width: rect.width, height: rect.height, data });
  };
}

/** Start `size` OCR workers (each loads the ~3 MB core + ~3 MB model once). */
export async function createScanEngine(size = 2): Promise<ScanEngine> {
  const base = ocrBaseUrl();
  const workers = await Promise.all(
    Array.from({ length: size }, () =>
      createWorker('eng', 1, {
        workerPath: `${base}worker.min.js`,
        corePath: base,
        langPath: base.replace(/\/$/, ''),
        cacheMethod: 'none',
        gzip: true,
      }),
    ),
  );
  const idle = [...workers];
  const waiting: ((w: Worker) => void)[] = [];
  const acquire = (): Promise<Worker> => {
    const free = idle.pop();
    return free !== undefined ? Promise.resolve(free) : new Promise((resolve) => waiting.push(resolve));
  };
  const release = (w: Worker): void => {
    const next = waiting.shift();
    if (next !== undefined) next(w);
    else idle.push(w);
  };

  return {
    read: async (image, parse) => {
      // Decoded once per frame, for its size and the pixel checks (tesseract decodes the Blob itself).
      const bitmap = await createImageBitmap(image);
      const { width, height } = bitmap;
      const worker = await acquire();
      try {
        const read = await readPanel(bindOcr(worker, image, bitmap), width, height, parse, bindPixels(bitmap));
        return { ...read, width, height };
      } finally {
        release(worker);
        bitmap.close();
      }
    },
    terminate: async () => {
      await Promise.all(workers.map((w) => w.terminate()));
    },
  };
}

/**
 * Small preview of the detail-panel band (the same `panelRect` pass 1
 * reads) as an object URL, for the review list. Memory only; the caller
 * revokes it.
 */
export async function panelThumbnail(image: Blob, height = 320): Promise<string | null> {
  const { width: frameW, height: frameH } = await frameSize(image);
  const r = panelRect(frameW, frameH);
  const bitmap = await createImageBitmap(image, r.left, r.top, r.width, r.height, {
    resizeHeight: height,
    resizeQuality: 'medium',
  });
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.8));
  return blob === null ? null : URL.createObjectURL(blob);
}
