/**
 * Scanner layer: find the moments in a screen recording where the Echo
 * Management detail panel shows a new Echo. Pure — input is small
 * grayscale samples of the panel band (`panelRect`), output is segments.
 *
 * Measured on the user's 2026-10-22 recording (32.7 s, 60 fps, 1894×1062,
 * clicking through ~1 Echo/s), sampled at 10 fps as 96×128 gray:
 *   - An Echo switch changes the TEXT in one step (name, stats and values
 *     update together; the art follows ~0.1 s later): mean absolute
 *     difference 5.3–12.3 between consecutive samples.
 *   - Idle noise is ≤ 0.72. The threshold of 2.5 sits ~3× above noise and
 *     ~2× below the smallest real change.
 *   - The animated Echo art is the main false trigger (53+ on its own),
 *     and it overlaps the "+25 / COST" lines and the right part of the
 *     name line. So only two regions are compared: the left 55% of the
 *     name line and the whole stat block. Restricting the name line to
 *     x < 0.55 took the recording from 19 segments (3 art-only) to the
 *     true 16.
 * Revisiting an Echo (A → B → A) yields A twice; the review step flags
 * repeats (review.ts), this module does not try to remember panels.
 */

export interface GrayFrame {
  width: number;
  height: number;
  /** One byte of luminance per pixel, row-major. */
  data: Uint8Array;
}

/** A rectangle in fractions of the panel band. */
export interface BandRegion {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** Signature resolution: plenty for text changes, cheap to compare. */
export const SIGNATURE_WIDTH = 96;
export const SIGNATURE_HEIGHT = 128;

/** Name line, left part only (the art reaches x ≈ 0.6 there). */
export const NAME_REGION: BandRegion = { x0: 0, x1: 0.55, y0: 0.04, y1: 0.1 };
/** Main stats + substats; nothing animates behind it. */
export const STATS_REGION: BandRegion = { x0: 0, x1: 1, y0: 0.47, y1: 0.9 };

export const CHANGE_THRESHOLD = 2.5;

/** RGBA (canvas ImageData) -> luminance, integer BT.601 weights. */
export function toGray(rgba: Uint8ClampedArray, width: number, height: number): GrayFrame {
  const data = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i++) {
    const p = i * 4;
    data[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
  }
  return { width, height, data };
}

/** Mean absolute luminance difference inside `region`. */
export function regionDiff(a: GrayFrame, b: GrayFrame, region: BandRegion): number {
  if (a.width !== b.width || a.height !== b.height) throw new Error('signature sizes differ');
  const xs = Math.floor(region.x0 * a.width);
  const xe = Math.floor(region.x1 * a.width);
  const ys = Math.floor(region.y0 * a.height);
  const ye = Math.floor(region.y1 * a.height);
  let sum = 0;
  let count = 0;
  for (let y = ys; y < ye; y++) {
    for (let x = xs; x < xe; x++) {
      sum += Math.abs(a.data[y * a.width + x] - b.data[y * a.width + x]);
      count++;
    }
  }
  return count === 0 ? 0 : sum / count;
}

/** Did the panel's text change between two samples? */
export function panelChanged(a: GrayFrame, b: GrayFrame, threshold = CHANGE_THRESHOLD): boolean {
  return regionDiff(a, b, STATS_REGION) > threshold || regionDiff(a, b, NAME_REGION) > threshold;
}

export interface Segment {
  /** Time of the first and last sample showing this panel (seconds). */
  start: number;
  end: number;
  /** The sample to OCR (see `SETTLE_SECONDS`); its frame was captured by the caller. */
  pick: number;
}

/**
 * How far into a panel the OCR'd frame should be. The text switches in one
 * step, but a frame a little after the switch is clear of any transition
 * blend; 0.2 s is two samples at 10 fps. A panel shown for less than that
 * is still read, from its last sample — a fast click is never dropped.
 */
export const SETTLE_SECONDS = 0.2;

export interface SegmentStep {
  /** The segment this sample closed (the panel before it), if any. */
  closed: Segment | null;
  /**
   * True when the caller should capture this sample's full frame as its
   * segment's OCR frame (replacing any earlier capture of the same
   * segment). The segment's `pick` is the last sample flagged so.
   */
  capture: boolean;
}

export interface Segmenter {
  /** Add the next sample (strictly increasing time). */
  push: (t: number, frame: GrayFrame) => SegmentStep;
  /** Close the last open segment. */
  finish: () => Segment | null;
}

/**
 * Incremental segmenter, so frames are OCR'd while the video is still
 * being walked, and no seeking back is needed: the caller captures the
 * frames this flags as it goes. Every stable stretch becomes a segment —
 * even a single sample: dropping short ones would lose fast clicks
 * silently, while an extra segment costs only one OCR (a repeat is
 * flagged in review).
 */
export function createSegmenter(threshold = CHANGE_THRESHOLD, settle = SETTLE_SECONDS): Segmenter {
  let last: GrayFrame | null = null;
  let start = 0;
  let end = 0;
  let pick = 0;
  let open = false;
  let settled = false;
  const close = (): Segment | null => {
    if (!open) return null;
    open = false;
    return { start, end, pick };
  };
  return {
    push: (t, frame) => {
      const closed = last !== null && panelChanged(last, frame, threshold) ? close() : null;
      last = frame;
      if (!open) {
        open = true;
        settled = false;
        start = t;
      }
      end = t;
      const capture = !settled;
      if (capture) {
        pick = t;
        // Tolerance: sample times are sums of 1/fps steps (0.1 + 0.1 ≠ 0.2 exactly).
        settled = t >= start + settle - 1e-6;
      }
      return { closed, capture };
    },
    finish: close,
  };
}

/**
 * Times to seek to so a gap in playback sampling (dropped frames, a
 * throttled tab) is filled at the normal step: every `step` after `from`,
 * strictly before `to` (which the caller samples itself).
 */
export function gapFillTimes(from: number, to: number, step: number): number[] {
  const times: number[] = [];
  for (let k = 1; from + k * step < to - step / 2; k++) times.push(from + k * step);
  return times;
}

/**
 * Sample times for a video: every 1/fps seconds. Each time is strictly
 * below `duration` (i < duration·fps), so no seek lands past the last
 * frame.
 */
export function sampleTimes(duration: number, fps: number): number[] {
  if (!(duration > 0) || !(fps > 0)) return [];
  return Array.from({ length: Math.ceil(duration * fps) }, (_, i) => i / fps);
}
