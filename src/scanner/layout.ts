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

export function panelRect(frameWidth: number, frameHeight: number): Rect {
  const left = Math.round(frameWidth * 0.66);
  const top = Math.round(frameHeight * 0.08);
  return { left, top, width: frameWidth - left, height: Math.round(frameHeight * 0.8) };
}

/**
 * The in-game Sonata filter's tag (a dark chip with the set's name above
 * the Filter button, bottom-left of the grid) and the grid's bottom bar
 * under it ("Sort by Level", "Batch Manage"), which tells "no filter set"
 * apart from "not in the picture" (sonata.ts). Measured 2026-10-23 on
 * the user's two recordings (62 frames with a tag): the tag's dark box is
 * 410×50 px at x 0.086–0.096 to 0.302–0.309, y 0.826–0.872 of the frame
 * (it is anchored to the grid, so x shifts with how the window is framed);
 * "Sort by Level" sits at y ≈ 0.905. The rectangle keeps a margin of at
 * least 0.026 of the frame on every side.
 */
export function filterTagRect(frameWidth: number, frameHeight: number): Rect {
  const left = Math.round(frameWidth * 0.04);
  const top = Math.round(frameHeight * 0.8);
  return { left, top, width: Math.round(frameWidth * 0.36) - left, height: Math.round(frameHeight * 0.95) - top };
}

/**
 * The grid's bottom bar inside `filterTagRect` ("Sort by Level"), read
 * when no tag is seen: present = the grid is in the picture with no
 * filter set. Measured 2026-10-23: "Sort by" read on 84/84 frames (both
 * recordings and the screenshots) in single-line mode.
 */
export function gridBarRect(frameWidth: number, frameHeight: number): Rect {
  const area = filterTagRect(frameWidth, frameHeight);
  const top = Math.round(frameHeight * 0.88);
  return { left: area.left, top, width: area.width, height: area.top + area.height - top };
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
 */
export function footerRect(pass1: readonly OcrWord[], panel: Rect): Rect {
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
  const clampedTop = Math.min(Math.round(top), bottom(panel) - 1);
  return { left: panel.left, top: clampedTop, width: panel.width, height: bottom(panel) - clampedTop };
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
