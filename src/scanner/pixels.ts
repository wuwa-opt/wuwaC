import { designWidth, type Rect } from './layout.ts';
import type { OcrBox } from './parse.ts';

/**
 * Scanner layer: pixel checks that back up the OCR. Pure over plain RGBA
 * buffers (canvas ImageData shape), so they run in node tests.
 *
 * "Equipped by <name>" is the only gold text in the panel footer; the
 * footer background is blue-grey (R < B). OCR can miss that line — on the
 * first frame after the in-game Filter sheet closes, the sheet's text is
 * still cross-faded over it — and a missed line used to import the Echo as
 * unequipped with no flag. Seeing gold where no line was read now raises one.
 *
 * The check looks at a fixed part of the panel band (`equipCheckRect`),
 * never at a rectangle placed from OCR: at 720p, pass 1 can read a tall
 * junk word on the last stat row, and the `footerRect` strip derived from
 * it landed under the gold line, so a missed line went unflagged (a silent
 * error on a 2026-10-30 synthetic 20:9 720p recording).
 *
 * Measured 2026-10-30 on the 84 fixture panels (17 screenshots + 67 video
 * frames, two recordings), each at its own size, scaled to 720 px tall and
 * padded to 20:9: in `equipCheckRect`, unequipped 0 gold pixels (all 27 ×
 * 3); equipped at least 0.98‰ of the region (all 57 × 3, the faded frame
 * included), starting at 0.908–0.918 of the band's height.
 */

export interface RgbaImage {
  width: number;
  height: number;
  /** 4 bytes per pixel, row-major. */
  data: Uint8ClampedArray;
}

/**
 * Gold text: clearly red over blue, and bright. The footer background is
 * ~(132–140, 155–163, 171–176); the text is ~(230, 205, 150).
 */
export function isGold(r: number, g: number, b: number): boolean {
  return r > 140 && r - b > 46 && g > 100;
}

/** Share of `equipCheckRect` that must be gold to count as an "Equipped by" line (~5× below the faintest one measured). */
export const EQUIPPED_GOLD_MIN_FRACTION = 0.0002;

export interface GoldRead {
  count: number;
  /** Bounding box of the gold pixels (frame pixels), null when there are none. */
  bbox: OcrBox | null;
}

/** Gold pixels inside `rect` (frame coordinates, clipped to the image). */
export function goldPixels(image: RgbaImage, rect: Rect): GoldRead {
  const x0 = Math.max(0, Math.floor(rect.left));
  const y0 = Math.max(0, Math.floor(rect.top));
  const x1 = Math.min(image.width, Math.floor(rect.left + rect.width));
  const y1 = Math.min(image.height, Math.floor(rect.top + rect.height));
  let count = 0;
  let bx0 = Infinity;
  let by0 = Infinity;
  let bx1 = -Infinity;
  let by1 = -Infinity;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = (y * image.width + x) * 4;
      if (!isGold(image.data[p], image.data[p + 1], image.data[p + 2])) continue;
      count++;
      bx0 = Math.min(bx0, x);
      by0 = Math.min(by0, y);
      bx1 = Math.max(bx1, x + 1);
      by1 = Math.max(by1, y + 1);
    }
  }
  return { count, bbox: count === 0 ? null : { x0: bx0, y0: by0, x1: bx1, y1: by1 } };
}

/**
 * The "Equipped by" line as seen in pixels: its box when `rect` holds
 * enough gold, else null. `rect` is the check region (`equipCheckRect`).
 */
export function equipLineBox(image: RgbaImage, rect: Rect): OcrBox | null {
  const { count, bbox } = goldPixels(image, rect);
  return count >= EQUIPPED_GOLD_MIN_FRACTION * rect.width * rect.height ? bbox : null;
}

/** Luminance (BT.601, integer weights as in video.ts) under which a pixel counts as the filter tag's dark box. */
const TAG_DARK = 40;

/**
 * The in-game Sonata filter tag's dark box inside `image` (the
 * `filterTagRect` crop of a frame), in the crop's pixels; null when there
 * is none. The tag is a near-black box (luminance < 40) around white text,
 * ~21% of the 16:9 width (`designWidth`) wide and ~4.7% of the frame
 * tall; the grid tiles and bar around it are lighter. Rows count when
 * ≥ 8% of the 16:9 width is dark; the tallest run of such rows (≥ 2% of
 * the frame height) is the box, and its columns are those dark in ≥ 60%
 * of its rows, gaps of up to 25 px at 1080 px tall (the letters; scaled
 * with the frame height) bridged. Ported from the measuring script that
 * located the tag on all 84 frames of the 2026-10-23 fixtures (62 with a
 * tag, 22 without), in agreement with a by-eye read of every image.
 */
export function findTagBox(image: RgbaImage, frameWidth: number, frameHeight: number): OcrBox | null {
  const { width, height, data } = image;
  const minDarkRow = 0.08 * designWidth(frameWidth, frameHeight);
  const maxGap = Math.round((25 * frameHeight) / 1080);
  const dark = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const p = i * 4;
    dark[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8 < TAG_DARK ? 1 : 0;
  }
  let best: [number, number] | null = null;
  let start = -1;
  for (let y = 0; y <= height; y++) {
    let count = 0;
    if (y < height) for (let x = 0; x < width; x++) count += dark[y * width + x];
    const on = y < height && count >= minDarkRow;
    if (on && start < 0) start = y;
    if (!on && start >= 0) {
      if (y - 1 - start >= 0.02 * frameHeight && (best === null || y - 1 - start > best[1] - best[0])) best = [start, y - 1];
      start = -1;
    }
  }
  if (best === null) return null;
  const [y0, y1] = best;
  const rows = y1 - y0 + 1;
  let span: [number, number] | null = null;
  let widest: [number, number] | null = null;
  for (let x = 0; x <= width; x++) {
    let count = 0;
    if (x < width) for (let y = y0; y <= y1; y++) count += dark[y * width + x];
    if (x < width && count >= 0.6 * rows) {
      span = span !== null && x - span[1] <= maxGap + 1 ? [span[0], x] : [x, x];
      if (widest === null || span[1] - span[0] > widest[1] - widest[0]) widest = span;
    }
  }
  return widest === null ? null : { x0: widest[0], y0, x1: widest[1] + 1, y1: y1 + 1 };
}
