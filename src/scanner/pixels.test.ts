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
  const rect = { left: 0, top: 0, width: 100, height: 50 }; // 5000 px -> threshold 5

  it('needs gold on at least 0.1% of the strip', () => {
    const four: [number, number][] = [10, 11, 12, 13].map((x) => [x, 20]);
    expect(equipLineBox(image(100, 50, four), rect)).toBeNull();
    expect(equipLineBox(image(100, 50, [...four, [14, 20]]), rect)).toEqual({ x0: 10, y0: 20, x1: 15, y1: 21 });
  });
});

describe('findTagBox', () => {
  /** A crop of a 1000×500 frame: grey, with an optional near-black box. */
  function crop(box: { x0: number; y0: number; x1: number; y1: number } | null, letters = false): RgbaImage {
    const width = 300;
    const height = 80;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) data.set([90, 95, 105, 255], i * 4);
    if (box !== null) {
      for (let y = box.y0; y < box.y1; y++) {
        for (let x = box.x0; x < box.x1; x++) {
          // White text strokes inside the box (every 10th column, clear of the box's edges); the letter gaps are bridged.
          const light = letters && x % 10 === 5 && y > box.y0 + 3 && y < box.y1 - 3;
          data.set(light ? [240, 240, 240, 255] : [18, 18, 22, 255], (y * width + x) * 4);
        }
      }
    }
    return { width, height, data };
  }

  it('finds the dark box: rows ≥ 8% of the frame width dark, ≥ 2% of its height tall', () => {
    // 1000×500 frame: rows need ≥ 80 dark pixels, the run ≥ 10 rows.
    expect(findTagBox(crop({ x0: 40, y0: 20, x1: 250, y1: 45 }, true), 1000, 500)).toEqual({ x0: 40, y0: 20, x1: 250, y1: 45 });
  });

  it('finds nothing when the dark area is too short or too narrow', () => {
    expect(findTagBox(crop(null), 1000, 500)).toBeNull();
    expect(findTagBox(crop({ x0: 40, y0: 20, x1: 250, y1: 28 }), 1000, 500)).toBeNull(); // 8 rows
    expect(findTagBox(crop({ x0: 40, y0: 20, x1: 110, y1: 45 }), 1000, 500)).toBeNull(); // 70 px wide
  });
});
