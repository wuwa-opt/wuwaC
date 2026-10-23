import { describe, expect, it } from 'vitest';
import {
  createSegmenter,
  gapFillTimes,
  NAME_REGION,
  panelChanged,
  PANEL_MIN_LUMA,
  regionDiff,
  sampleTimes,
  showsPanel,
  STATS_REGION,
  toGray,
  type BandRegion,
  type GrayFrame,
} from './video.ts';

const W = 100;
const H = 100;

/** Uniform frame, optionally with `region` painted `value`. */
function frame(base: number, paint?: { region: BandRegion; value: number }): GrayFrame {
  const data = new Uint8Array(W * H).fill(base);
  if (paint !== undefined) {
    const { region, value } = paint;
    for (let y = Math.floor(region.y0 * H); y < Math.floor(region.y1 * H); y++) {
      for (let x = Math.floor(region.x0 * W); x < Math.floor(region.x1 * W); x++) data[y * W + x] = value;
    }
  }
  return { width: W, height: H, data };
}

describe('toGray', () => {
  it('uses integer BT.601 weights (77/150/29 of 256)', () => {
    const rgba = new Uint8ClampedArray([255, 255, 255, 255, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]);
    // White: 255*256>>8 = 255; red: 255*77>>8 = 76; green: 255*150>>8 = 149; blue: 255*29>>8 = 28.
    expect([...toGray(rgba, 4, 1).data]).toEqual([255, 76, 149, 28]);
  });
});

describe('regionDiff', () => {
  it('is the mean absolute difference inside the region only', () => {
    const a = frame(100);
    // Paint the left half of the stats region 40 brighter: half its pixels differ by 40 -> mean 20.
    const b = frame(100, { region: { ...STATS_REGION, x1: 0.5 }, value: 140 });
    expect(regionDiff(a, b, STATS_REGION)).toBe(20);
    expect(regionDiff(a, b, NAME_REGION)).toBe(0);
  });

  it('refuses frames of different sizes', () => {
    expect(() => regionDiff(frame(0), { width: 1, height: 1, data: new Uint8Array(1) }, STATS_REGION)).toThrow(/sizes differ/);
  });
});

describe('panelChanged', () => {
  it('fires on the stats block or the name line, not on the art', () => {
    const base = frame(100);
    expect(panelChanged(base, frame(100, { region: STATS_REGION, value: 110 }))).toBe(true); // diff 10
    expect(panelChanged(base, frame(100, { region: NAME_REGION, value: 103 }))).toBe(true); // diff 3 > 2.5
    // Idle noise of the real recording peaked at 0.72.
    expect(panelChanged(base, frame(100, { region: STATS_REGION, value: 102 }))).toBe(false); // diff 2
    // Art: right part of the name line and the "+25 / COST" area — ignored.
    const art = frame(100, { region: { x0: 0.6, x1: 1, y0: 0, y1: 0.45 }, value: 255 });
    expect(panelChanged(base, art)).toBe(false);
  });
});

describe('createSegmenter', () => {
  const a = frame(100);
  const b = frame(100, { region: STATS_REGION, value: 160 });
  const c = frame(100, { region: NAME_REGION, value: 30 });

  it('closes a segment at each text change; the OCR frame is the first sample 0.2 s in', () => {
    const seg = createSegmenter();
    const steps = [
      seg.push(0, a), // capture (segment start)
      seg.push(0.1, a), // capture (0.1 < 0.2: not settled yet)
      seg.push(0.2, a), // capture, settled
      seg.push(0.30000000000000004, a), // float sum of steps; no capture
      seg.push(0.4, b), // closes [0, 0.3] with pick 0.2; captures (new segment)
      seg.push(0.5, c), // closes [0.4, 0.4] with pick 0.4 (too short to settle)
    ];
    expect(steps.map((s) => s.capture)).toEqual([true, true, true, false, true, true]);
    expect(steps.map((s) => s.closed)).toEqual([
      null,
      null,
      null,
      null,
      // 0.1 s from pick to end: too close for a second frame.
      { start: 0, end: 0.30000000000000004, pick: 0.2, alt: null },
      { start: 0.4, end: 0.4, pick: 0.4, alt: null },
    ]);
    expect(seg.finish()).toEqual({ start: 0.5, end: 0.5, pick: 0.5, alt: null });
    expect(seg.finish()).toBeNull();
  });

  it('settles at 0.2 s even when steps add up to slightly less (0.1 + 0.1 in floats)', () => {
    const seg = createSegmenter();
    seg.push(0.1, a);
    seg.push(0.2, a);
    // 0.1 + 0.2 = 0.30000000000000004 >= 0.1 + 0.2 - 1e-6: settled at the third sample.
    expect(seg.push(0.1 + 0.2, a).capture).toBe(true);
    expect(seg.push(0.4, a).capture).toBe(false);
  });

  it('keeps a one-sample segment (a fast click is never dropped)', () => {
    const seg = createSegmenter();
    seg.push(0, frame(90));
    expect(seg.push(0.1, frame(200)).closed).toEqual({ start: 0, end: 0, pick: 0, alt: null });
    expect(seg.push(0.2, frame(90)).closed).toEqual({ start: 0.1, end: 0.1, pick: 0.1, alt: null });
  });

  it('offers the last sample as a second frame when it is 0.3 s or more after the pick', () => {
    const seg = createSegmenter();
    for (const t of [0, 0.1, 0.2, 0.3, 0.4, 0.5]) seg.push(t, a);
    // Pick 0.2, last sample 0.5: 0.3 apart (within float tolerance).
    expect(seg.push(0.6, b).closed).toEqual({ start: 0, end: 0.5, pick: 0.2, alt: 0.5 });
  });

  it('emits nothing for the dark Filter sheet: it closes the open panel and opens none', () => {
    const seg = createSegmenter();
    const sheet = frame(35);
    seg.push(0, a);
    const covered = seg.push(0.1, sheet);
    expect(covered).toEqual({ closed: { start: 0, end: 0, pick: 0, alt: null }, capture: false });
    // Hovering the sheet's list changes it a lot, but nothing is emitted or captured.
    expect(seg.push(0.2, frame(35, { region: STATS_REGION, value: 60 }))).toEqual({ closed: null, capture: false });
    expect(seg.push(0.3, sheet)).toEqual({ closed: null, capture: false });
    // The sheet closes: a new panel opens.
    expect(seg.push(0.4, b).capture).toBe(true);
    expect(seg.finish()).toEqual({ start: 0.4, end: 0.4, pick: 0.4, alt: null });
  });
});

describe('showsPanel', () => {
  it('needs a stat block at least as bright as 75 on average (panels measured ≥ 94.6, the sheet ≤ 63.2)', () => {
    expect(PANEL_MIN_LUMA).toBe(75);
    expect(showsPanel(frame(30, { region: STATS_REGION, value: 75 }))).toBe(true);
    expect(showsPanel(frame(200, { region: STATS_REGION, value: 74 }))).toBe(false);
  });
});

describe('gapFillTimes', () => {
  it('fills strictly between the samples at the normal step', () => {
    // Last sample 1.0, playback next delivered 1.5: seek 1.1 … 1.4, then the caller samples 1.5.
    expect(gapFillTimes(1, 1.5, 0.1).map((t) => Math.round(t * 10) / 10)).toEqual([1.1, 1.2, 1.3, 1.4]);
    // Nothing to fill when the gap is under 1.5 steps.
    expect(gapFillTimes(1, 1.14, 0.1)).toEqual([]);
    // Up to the end of the video: 32.4 -> 32.68 fills 32.5 and 32.6 (0.08 s from the end,
    // over half a step); 32.4 -> 32.62 stops at 32.5 (32.6 would be within 0.05 of it).
    expect(gapFillTimes(32.4, 32.68, 0.1).map((t) => Math.round(t * 10) / 10)).toEqual([32.5, 32.6]);
    expect(gapFillTimes(32.4, 32.62, 0.1).map((t) => Math.round(t * 10) / 10)).toEqual([32.5]);
  });
});

describe('sampleTimes', () => {
  it('steps by 1/fps and stays strictly below the duration', () => {
    expect(sampleTimes(1, 4)).toEqual([0, 0.25, 0.5, 0.75]);
    // 0.3 s at 4 fps -> ceil(1.2) = 2 samples.
    expect(sampleTimes(0.3, 4)).toEqual([0, 0.25]);
    expect(sampleTimes(0.25, 4)).toEqual([0]);
    expect(sampleTimes(0, 10)).toEqual([]);
    expect(sampleTimes(Number.NaN, 10)).toEqual([]);
  });
});
