import { groupRows, type OcrBox, type OcrRow, type OcrWord } from './parse.ts';

/**
 * Scanner layer: where to point the OCR engine on a frame. Pure geometry
 * over pixel rectangles — the engine itself lives in the worker.
 *
 * Measured on the user's 16:9 captures (2026-10-16, 17 region screenshots
 * 1891–1920 × 1068–1080): the Echo Management detail panel is anchored to
 * the right edge and spans roughly x ≥ 68% and y 12–85% of the frame. The
 * band below is deliberately generous so region captures that trim a few
 * pixels off any edge still contain the whole panel; fields are then
 * located by content (see parse.ts), not by these fractions.
 *
 * OCR passes (Phase 0 evaluation, scripts/scan-eval.ts):
 *   1. panel band, sparse-text mode — name, level, cost, and the anchors
 *      the later rectangles are derived from;
 *   2. value column, single-block mode, digit whitelist — sparse mode
 *      drops short values ("40") and leading digits ("6.3%" -> "3%");
 *   3. label column, single-block mode — sparse mode garbles the wrapped
 *      second line of long labels ("DMG Bonus" -> "Mi ni");
 *   4. footer strip, single-block mode — sparse mode drops the gold
 *      "Equipped by" line on the light background.
 * Later passes REPLACE earlier words inside their rectangle. Raw pixels
 * beat preprocessing here: red-channel and luminance+invert variants at
 * 2× both scored worse and added silent errors (tesseract's own Otsu
 * binarization copes with the gradient background).
 */

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Width of the 16:9 layout a frame's UI is measured on: the frame's own
 * width up to 16:9, and 16/9 of its height beyond (phones at 20:9,
 * ultrawide monitors), where the UI is assumed to keep its 16:9 size and
 * the detail panel stays on the right edge. Every 16:9 fraction below is
 * a fraction of this width.
 *
 * Unverified for wider frames: no real recording wider than 16:9 has been
 * measured yet. A 2026-10-30 synthetic one (recording 1 with 474 px
 * added on the left, 2400×1080) read 0/15 Echoes with the band at 34% of
 * the frame.
 */
export function designWidth(frameWidth: number, frameHeight: number): number {
  return Math.min(frameWidth, Math.round((frameHeight * 16) / 9));
}

export function panelRect(frameWidth: number, frameHeight: number): Rect {
  const width = Math.round(designWidth(frameWidth, frameHeight) * 0.34);
  const top = Math.round(frameHeight * 0.08);
  return { left: frameWidth - width, top, width, height: Math.round(frameHeight * 0.8) };
}

/**
 * The in-game Sonata filter's tag (a dark chip with the set's name above
 * the Filter button, bottom-left of the grid) and the grid's bottom bar
 * under it ("Sort by Level", "Batch Manage"), which tells "no filter set"
 * apart from "not in the picture" (sonata.ts). Measured 2026-10-23 on
 * the user's two recordings (62 frames with a tag): the tag's dark box is
 * 410×50 px at x 0.086–0.096 to 0.302–0.309, y 0.826–0.872 of the frame
 * (it is anchored to the grid, so x shifts with how the window is framed);
 * "Sort by Level" sits at y ≈ 0.905.
 *
 * It spans x from the frame's left edge to the panel band, so the tag is
 * inside wherever a wider screen puts the grid. On all 84 fixture frames
 * (2026-10-30) `findTagBox` over that span returned the same box as over
 * the earlier x 0.04–0.36.
 */
export function filterTagRect(frameWidth: number, frameHeight: number): Rect {
  const top = Math.round(frameHeight * 0.8);
  return { left: 0, top, width: panelRect(frameWidth, frameHeight).left, height: Math.round(frameHeight * 0.95) - top };
}

/**
 * Strips to read for the grid's bottom bar ("Sort by Level") inside
 * `filterTagRect`, in order, when no tag is seen: present = the grid is in
 * the picture with no filter set. Measured 2026-10-23: "Sort by" read on
 * 84/84 frames (both recordings and the screenshots) in single-line mode
 * over x 0.04–0.36 of the frame, the first strip here. Single-line mode
 * over the whole tag area read it on 0 of those 84 (2026-10-30), so a
 * wider screen gets more strips of the same width, half a strip apart,
 * the last ending at the panel band; the caller stops at the first that
 * shows the bar.
 */
export function gridBarRects(frameWidth: number, frameHeight: number): Rect[] {
  const area = filterTagRect(frameWidth, frameHeight);
  const unit = designWidth(frameWidth, frameHeight);
  const first = Math.round(unit * 0.04);
  const width = Math.round(unit * 0.36) - first;
  const top = Math.round(frameHeight * 0.88);
  const height = area.top + area.height - top;
  const right = area.left + area.width;
  const rects: Rect[] = [];
  for (let left = first; ; left += Math.round(width / 2)) {
    const clamped = Math.max(area.left, Math.min(left, right - width));
    rects.push({ left: clamped, top, width: Math.min(width, right - clamped), height });
    if (clamped + width >= right) return rects;
  }
}

function bottom(r: Rect): number {
  return r.top + r.height;
}

const VALUE_RE = /\d%?$/;

/** Pass-1 rows that end in a number below the header — the stat block. */
function statRows(rows: readonly OcrRow[], panel: Rect): OcrRow[] {
  const costIndex = rows.findIndex((r) => /cost\s*[134]/i.test(r.text));
  const afterHeader = costIndex >= 0 ? rows.slice(costIndex + 1) : rows.filter((r) => r.bbox.y0 > panel.top + panel.height * 0.4);
  const stop = afterHeader.findIndex((r) => /echo\s*s|equipped/i.test(r.text));
  return (stop >= 0 ? afterHeader.slice(0, stop) : afterHeader).filter((r) => VALUE_RE.test(r.text) && r.words.length >= 2);
}

/**
 * The right-aligned value column over the stat block: from the values'
 * right edge back 1.5× the widest value pass 1 found (values are
 * right-aligned, so a short "40" still sits inside; the slack stops well
 * short of the longest unwrapped label). Null when pass 1 found no stat
 * rows to anchor on.
 */
export function valueColumnRect(pass1: readonly OcrWord[], panel: Rect, bottomLimit = 0): Rect | null {
  const rows = statRows(groupRows(pass1), panel);
  if (rows.length === 0) return null;
  const values = rows.map((r) => r.words[r.words.length - 1].bbox);
  const panelRight = panel.left + panel.width;
  const valueRight = Math.max(...values.map((b) => b.x1));
  const widest = Math.max(...values.map((b) => b.x1 - b.x0));
  const lineHeight = Math.max(...values.map((b) => b.y1 - b.y0));
  const left = Math.max(panel.left, Math.round(valueRight - 1.5 * widest));
  const top = Math.max(panel.top, Math.round(Math.min(...rows.map((r) => r.bbox.y0)) - 2 * lineHeight));
  // Down to the footer when known: if pass 1 missed the LAST row's value,
  // two line-heights under the last row it did find can slice that row's
  // digits in half (2026-10-22 video: "Energy Regen 9.2%" lost).
  const end = Math.min(bottom(panel), Math.max(bottomLimit, Math.round(Math.max(...rows.map((r) => r.bbox.y1)) + 2 * lineHeight)));
  return { left, top, width: panelRight - left, height: end - top };
}

/**
 * Strip holding "Echo Skill" and "Equipped by". Starts just above the
 * "Echo Skill" row when pass 1 saw it; otherwise two line-heights under
 * the last stat row, so a wrapped label's second line ("DMG Bonus") stays
 * out of the strip — a strip that slices a text line through the middle
 * turns it into junk.
 *
 * `equipLine` is the gold "Equipped by" line found in pixels, if any: the
 * strip never starts below half a line above it. At 720p, pass 1 can read
 * a junk word 2–3 lines tall on the last stat row, and the strip then
 * started under the gold line (2026-10-30). Measuring the fallback on the
 * values instead lost a last substat whose value pass 1 had missed.
 */
export function footerRect(pass1: readonly OcrWord[], panel: Rect, equipLine: OcrBox | null = null): Rect {
  const rows = groupRows(pass1);
  const stats = statRows(rows, panel);
  const last = stats.at(-1);
  const echoSkill = rows.find((r) => /echo\s*s/i.test(r.text) && (last === undefined || r.bbox.y0 > last.bbox.y1));
  let top: number;
  if (echoSkill !== undefined) {
    top = echoSkill.bbox.y0 - (echoSkill.bbox.y1 - echoSkill.bbox.y0) / 2;
  } else if (last !== undefined) {
    top = last.bbox.y1 + 2 * (last.bbox.y1 - last.bbox.y0);
  } else {
    top = panel.top + panel.height * 0.75;
  }
  if (equipLine !== null) top = Math.min(top, equipLine.y0 - (equipLine.y1 - equipLine.y0) / 2);
  const clampedTop = Math.min(Math.round(top), bottom(panel) - 1);
  return { left: panel.left, top: clampedTop, width: panel.width, height: bottom(panel) - clampedTop };
}

/**
 * Where the pixel check looks for the gold "Equipped by" line
 * (pixels.ts): the band from 45% of its height down, below the Echo art
 * and the header, fixed so no OCR misread can move it. Measured
 * 2026-10-30 on the 84 fixture panels at three sizes: the gold starts at
 * 0.908–0.918 of the band, and unequipped panels have none in here.
 */
export function equipCheckRect(panel: Rect): Rect {
  const top = panel.top + Math.round(panel.height * 0.45);
  return { left: panel.left, top, width: panel.width, height: bottom(panel) - top };
}

/** Stat labels: left of the value column, from the value column's top down to the footer. */
export function labelColumnRect(valueColumn: Rect, footer: Rect, panel: Rect): Rect | null {
  const height = footer.top - valueColumn.top;
  const width = valueColumn.left - panel.left;
  return height > 0 && width > 0 ? { left: panel.left, top: valueColumn.top, width, height } : null;
}

function centerInside(b: OcrBox, r: Rect): boolean {
  const cx = (b.x0 + b.x1) / 2;
  const cy = (b.y0 + b.y1) / 2;
  return cx >= r.left && cx < r.left + r.width && cy >= r.top && cy < bottom(r);
}

/** Words from a later pass replace every earlier word centered inside its rectangle. */
export function replaceWords(base: readonly OcrWord[], pass: readonly OcrWord[], rect: Rect): OcrWord[] {
  return [...base.filter((w) => !centerInside(w.bbox, rect)), ...pass.filter((w) => centerInside(w.bbox, rect))];
}
