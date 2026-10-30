import { describe, expect, it } from 'vitest';
import { equipLineBox, findTagBox, goldPixels, isGold, type RgbaImage } from './pixels.ts';

const BACKGROUND = [136, 159, 175]; // measured footer background
const GOLD = [230, 205, 150]; // measured "Equipped by" text

/** A width×height image of footer background with `paint` pixels set to gold. */
function image(width: number, height: number, paint: [number, number][] = []): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([...BACKGROUND, 255], i * 4);
  for (const [x, y] of paint) data.set([...GOLD, 255], (y * width + x) * 4);
  return { width, height, data };
}

describe('isGold', () => {
  it('accepts the gold text and rejects the blue-grey background, white and pink', () => {
    expect(isGold(230, 205, 150)).toBe(true);
    expect(isGold(136, 159, 175)).toBe(false);
    expect(isGold(250, 250, 250)).toBe(false);
    // A pink avatar (r − b = 40) is not gold.
    expect(isGold(240, 170, 200)).toBe(false);
  });
});

describe('goldPixels', () => {
  it('counts gold pixels inside the rect and boxes them (end-exclusive)', () => {
    const img = image(10, 6, [
      [2, 1],
      [5, 3],
      [9, 5], // outside the rect below
    ]);
    expect(goldPixels(img, { left: 0, top: 0, width: 8, height: 5 })).toEqual({ count: 2, bbox: { x0: 2, y0: 1, x1: 6, y1: 4 } });
  });

  it('clips the rect to the image and reports no box without gold', () => {
    expect(goldPixels(image(4, 4), { left: -5, top: 2, width: 100, height: 100 })).toEqual({ count: 0, bbox: null });
  });
});

describe('equipLineBox', () => {
  const rect = { left: 0, top: 0, width: 250, height: 100 }; // 25 000 px -> threshold 5

  it('needs gold on at least 0.02% of the region', () => {
    const four: [number, number][] = [10, 11, 12, 13].map((x) => [x, 20]);
    expect(equipLineBox(image(250, 100, four), rect)).toBeNull();
    expect(equipLineBox(image(250, 100, [...four, [14, 20]]), rect)).toEqual({ x0: 10, y0: 20, x1: 15, y1: 21 });
  });
});

describe('findTagBox', () => {
  /**
   * A crop (300×80 unless given): grey, with an optional near-black box.
   * With `letterGap`, white text strokes `letterGap` columns wide run down
   * the box (clear of its top and bottom edges) every 2·gap + 10 columns.
   */
  function crop(box: { x0: number; y0: number; x1: number; y1: number } | null, letterGap = 0, width = 300, height = 80): RgbaImage {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) data.set([90, 95, 105, 255], i * 4);
    if (box !== null) {
      const period = 2 * letterGap + 10;
      for (let y = box.y0; y < box.y1; y++) {
        for (let x = box.x0; x < box.x1; x++) {
          const at = (x - box.x0) % period;
          const light = letterGap > 0 && at >= 10 && at < 10 + letterGap && y > box.y0 + 3 && y < box.y1 - 3;
          data.set(light ? [240, 240, 240, 255] : [18, 18, 22, 255], (y * width + x) * 4);
        }
      }
    }
    return { width, height, data };
  }

  it('finds the dark box: rows ≥ 8% of the 16:9 width dark, ≥ 2% of the frame height tall', () => {
    // 1600×900 frame: rows need ≥ 128 dark pixels, the run ≥ 18 rows.
    expect(findTagBox(crop({ x0: 40, y0: 20, x1: 250, y1: 45 }, 1), 1600, 900)).toEqual({ x0: 40, y0: 20, x1: 250, y1: 45 });
  });

  it('finds nothing when the dark area is too short or too narrow', () => {
    expect(findTagBox(crop(null), 1600, 900)).toBeNull();
    expect(findTagBox(crop({ x0: 40, y0: 20, x1: 250, y1: 36 }), 1600, 900)).toBeNull(); // 16 rows
    expect(findTagBox(crop({ x0: 40, y0: 20, x1: 160, y1: 45 }), 1600, 900)).toBeNull(); // 120 px wide
  });

  it('measures width against the 16:9 width, so a wider frame needs no wider tag', () => {
    // 2400×1080 is 1920 wide at 16:9: 153.6 dark pixels a row, not 192; the run ≥ 21.6 rows.
    expect(findTagBox(crop({ x0: 40, y0: 20, x1: 200, y1: 45 }), 2400, 1080)).toEqual({ x0: 40, y0: 20, x1: 200, y1: 45 });
  });

  it('bridges letter gaps of up to 25 px at 1080 px tall, scaled with the frame height', () => {
    // 280×50 box with 25-wide strokes every 60 columns; the last column (offset 279 % 60 = 39) is dark.
    expect(findTagBox(crop({ x0: 10, y0: 20, x1: 290, y1: 70 }, 25), 1920, 1080)).toEqual({ x0: 10, y0: 20, x1: 290, y1: 70 });
    // 26-wide gaps split it: the widest piece is one 36-column run between two strokes (offsets 36–71).
    expect(findTagBox(crop({ x0: 10, y0: 20, x1: 290, y1: 70 }, 26), 1920, 1080)).toEqual({ x0: 46, y0: 20, x1: 82, y1: 70 });
    // 2160 tall (4K): rows need ≥ 307.2 dark pixels, and 50-wide gaps are bridged
    // (670×70 box, strokes every 110 columns; the last column, offset 669 % 110 = 9, is dark).
    expect(findTagBox(crop({ x0: 10, y0: 5, x1: 680, y1: 75 }, 50, 700, 80), 3840, 2160)).toEqual({ x0: 10, y0: 5, x1: 680, y1: 75 });
  });
});
