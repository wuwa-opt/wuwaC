/**
 * Echo-scanner Phase 0 spike (NOT a unit test, NOT shipped). OCRs the
 * Echo Management detail panel of every screenshot in the gitignored
 * `scan-fixtures/` folder with tesseract.js (the engine the app runs in a
 * Web Worker) and dumps words + bboxes to
 * `scan-fixtures/ocr/<name>.<variant>.json` for `scan-eval.ts`.
 *
 * Runs `readPanel` (src/scanner/pipeline.ts) — the exact pass plan the
 * app runs, including the filter-tag pass and the gold "Equipped by"
 * pixel check — bound to a node tesseract.js worker (pixels via
 * ImageMagick). The dump also keeps pass 1's words (`pass1`), so the
 * early stop for panel-less frames can be checked against real panels.
 *
 * `--pre red|gray` OCRs a 2× ImageMagick-preprocessed copy instead (red
 * channel or luminance, inverted to dark-on-light) — the app does the
 * same on a canvas; this measures whether it is worth it.
 *
 * Run: npx tsx scripts/scan-spike.ts [--variant name] [--pre red|gray] [file ...]
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createWorker, PSM, type Page } from 'tesseract.js';
import type { Rect } from '../src/scanner/layout.ts';
import { snapshotSchema } from '../src/data/schema.ts';
import { parsePanel, type OcrWord } from '../src/scanner/parse.ts';
import { readPanel, type OcrFn, type PixelFn } from '../src/scanner/pipeline.ts';

const FIXTURES = 'scan-fixtures';
const LANG_PATH = 'node_modules/@tesseract.js-data/eng/4.0.0_best_int';

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Width/height from a PNG IHDR chunk (avoids an image-decoding dependency). */
function pngSize(file: string): { width: number; height: number } {
  const buf = readFileSync(file);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const SCALE = 2;

function pageWords(page: Page, scale = 1): OcrWord[] {
  return (page.blocks ?? [])
    .flatMap((b) => b.paragraphs)
    .flatMap((p) => p.lines)
    .flatMap((l) => l.words)
    .map((w) => ({
      text: w.text,
      confidence: Math.round(w.confidence),
      bbox: { x0: w.bbox.x0 / scale, y0: w.bbox.y0 / scale, x1: w.bbox.x1 / scale, y1: w.bbox.y1 / scale },
    }));
}

function scaled(r: Rect, scale: number): Rect {
  return { left: r.left * scale, top: r.top * scale, width: r.width * scale, height: r.height * scale };
}

async function main(): Promise<void> {
  const pre = argValue('--pre');
  const variant = argValue('--variant') ?? (pre ? `js6-${pre}` : 'js6');
  const named = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !all[i - 1]?.startsWith('--'));
  const files = named.length > 0 ? named : readdirSync(FIXTURES).filter((f) => f.endsWith('.png')).map((f) => join(FIXTURES, f));
  mkdirSync(join(FIXTURES, 'ocr'), { recursive: true });

  const snapshot = snapshotSchema.parse(JSON.parse(readFileSync('src/data/generated/snapshot.json', 'utf8')));
  const worker = await createWorker('eng', 1, { langPath: LANG_PATH, cachePath: join(FIXTURES, '.cache') });
  let total = 0;
  for (const file of files) {
    const { width, height } = pngSize(file);
    let image = file;
    let scale = 1;
    if (pre !== undefined) {
      mkdirSync(join(FIXTURES, '.pre'), { recursive: true });
      image = join(FIXTURES, '.pre', `${basename(file, '.png')}.${pre}.png`);
      const channel = pre === 'red' ? ['-channel', 'R', '-separate', '+channel'] : ['-colorspace', 'gray'];
      execFileSync('magick', [file, ...channel, '-negate', '-resize', `${SCALE * 100}%`, image]);
      scale = SCALE;
    }
    let pass1: OcrWord[] | null = null;
    const ocr: OcrFn = async (rect, mode) => {
      await worker.setParameters({
        tessedit_pageseg_mode: mode === 'sparse' ? PSM.SPARSE_TEXT : mode === 'line' || mode === 'tag' ? PSM.SINGLE_LINE : PSM.SINGLE_BLOCK,
        tessedit_char_whitelist: mode === 'digits' ? '0123456789.%' : '',
        user_defined_dpi: mode === 'tag' ? '300' : '',
      });
      if (mode === 'tag') {
        // Like the app: a crop of just the tag (engine.ts), always from the original frame.
        const crop = execFileSync('magick', [file, '-crop', `${rect.width}x${rect.height}+${rect.left}+${rect.top}`, '+repage', 'png:-']);
        return pageWords((await worker.recognize(crop, {}, { blocks: true })).data, 1).map((w) => ({
          ...w,
          bbox: { x0: w.bbox.x0 + rect.left, y0: w.bbox.y0 + rect.top, x1: w.bbox.x1 + rect.left, y1: w.bbox.y1 + rect.top },
        }));
      }
      const words = pageWords((await worker.recognize(image, { rectangle: scaled(rect, scale) }, { blocks: true })).data, scale);
      pass1 ??= words;
      return words;
    };
    // Pixels always come from the original frame (the check never sees preprocessing).
    const pixels: PixelFn = (rect) =>
      Promise.resolve({
        width: rect.width,
        height: rect.height,
        data: new Uint8ClampedArray(
          execFileSync('magick', [file, '-crop', `${rect.width}x${rect.height}+${rect.left}+${rect.top}`, '+repage', '-depth', '8', 'rgba:-'], {
            maxBuffer: 64 << 20,
          }),
        ),
      });
    const started = performance.now();
    // The retry pass needs a parse; the batch Sonata is irrelevant to which
    // rows get re-read (a Sonata flag has no row), so a blank batch is fine.
    const { words, extras } = await readPanel(ocr, width, height, (w, x) => parsePanel(w, { sonataId: null, rarity: 5 }, snapshot, x), pixels);
    const ms = Math.round(performance.now() - started);
    total += ms;
    const name = basename(file, '.png');
    const skipped = extras?.tag === undefined;
    writeFileSync(
      join(FIXTURES, 'ocr', `${name}.${variant}.json`),
      JSON.stringify({ file: basename(file), width, height, words, tag: extras?.tag ?? null, equipLine: extras?.equipLine ?? null, pass1 }, null, 1),
    );
    console.log(`${name}  ${ms} ms${skipped ? '  (no panel in pass 1: stopped early)' : ''}`);
  }
  console.log(`\n${files.length} panels, mean ${Math.round(total / files.length)} ms/panel`);
  await worker.terminate();
}

void main();
