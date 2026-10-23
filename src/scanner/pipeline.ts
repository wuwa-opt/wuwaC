import { filterTagRect, footerRect, gridBarRect, labelColumnRect, panelRect, replaceWords, valueColumnRect, type Rect } from './layout.ts';
import { isPanelless, type OcrBox, type OcrWord, type PanelExtras, type PanelParse } from './parse.ts';
import { equipLineBox, findTagBox, type RgbaImage } from './pixels.ts';

/**
 * Scanner layer: the OCR plan for one frame (why each pass exists is
 * documented in layout.ts). The engine and the parser are injected, so
 * this is pure orchestration — the browser binds it to tesseract.js
 * (engine.ts), the Phase 0 spike binds the same function in node, and
 * tests use fakes.
 */

/**
 * sparse = PSM 11; block = PSM 6; digits = PSM 6 with a `0-9.%`
 * whitelist; line = PSM 7 (one text line — the retry pass); tag = PSM 7
 * over a crop of just `rect` (the small filter tag: tesseract decodes the
 * whole image it is given on every call, so a crop saves that work).
 */
export type PassMode = 'sparse' | 'block' | 'digits' | 'line' | 'tag';

/** Recognize `rect` of the current frame; bboxes in frame pixels. */
export type OcrFn = (rect: Rect, mode: PassMode) => Promise<OcrWord[]>;

/** Parse merged words (the caller closes over batch + snapshot). */
export type ParseFn = (words: readonly OcrWord[], extras?: PanelExtras) => PanelParse;

/** RGBA pixels of `rect` of the current frame (the tag box and the equip check); absent = neither runs. */
export type PixelFn = (rect: Rect) => Promise<RgbaImage>;

/** Passes 2–4 over a pass-1 read: value column, label column, footer. */
async function refineWords(ocr: OcrFn, pass1: OcrWord[], panel: Rect): Promise<{ words: OcrWord[]; footer: Rect }> {
  let words = pass1;
  const footer = footerRect(pass1, panel);
  const values = valueColumnRect(pass1, panel, footer.top);
  if (values !== null) words = replaceWords(words, await ocr(values, 'digits'), values);
  const labels = values === null ? null : labelColumnRect(values, footer, panel);
  if (labels !== null) words = replaceWords(words, await ocr(labels, 'block'), labels);
  return { words: replaceWords(words, await ocr(footer, 'block'), footer), footer };
}

/** Passes 1–4: whole panel, value column, label column, footer. */
export async function readPanelWords(ocr: OcrFn, frameWidth: number, frameHeight: number): Promise<OcrWord[]> {
  const panel = panelRect(frameWidth, frameHeight);
  return (await refineWords(ocr, await ocr(panel, 'sparse'), panel)).words;
}

/**
 * The filter tag (sonata.ts): its dark box is found in pixels and read as
 * one line — over the whole tag area, sparse mode split and garbled it
 * ("Pilg rimage"), while the box read as a line was exact on all 62
 * tagged fixture frames. With no box, the grid bar under it is read
 * instead, so "no filter set" can be told from "not in the picture".
 */
async function readTag(ocr: OcrFn, pixels: PixelFn, frameWidth: number, frameHeight: number): Promise<OcrWord[]> {
  const area = filterTagRect(frameWidth, frameHeight);
  const box = findTagBox(await pixels(area), frameWidth, frameHeight);
  if (box === null) return ocr(gridBarRect(frameWidth, frameHeight), 'tag');
  return ocr({ left: area.left + box.x0, top: area.top + box.y0, width: box.x1 - box.x0, height: box.y1 - box.y0 }, 'tag');
}

/** The gold "Equipped by" line inside the footer strip, in frame pixels. */
async function equipLine(pixels: PixelFn, footer: Rect): Promise<OcrBox | null> {
  const image = await pixels(footer);
  const box = equipLineBox(image, { left: 0, top: 0, width: image.width, height: image.height });
  return box === null ? null : { x0: box.x0 + footer.left, y0: box.y0 + footer.top, x1: box.x1 + footer.left, y1: box.y1 + footer.top };
}

export interface RetryTarget {
  rect: Rect;
  mode: PassMode;
}

/**
 * Pass 5 targets: every row a flag points at, as a full-panel-width strip
 * padded by 40% of a line above and below (row pitch is ~2 lines, so a
 * neighbour's words never centre inside it). One-line rows are re-read in
 * single-line mode, which fixed both real block-mode misreads in the
 * 2026-10-22 video ("DEF 60" -> "0", "Fleurdelys" -> "Fledrel=gis");
 * a wrapped two-line label falls back to block mode.
 */
export function retryTargets(parse: PanelParse, panel: Rect): RetryTarget[] {
  const seen = new Set<string>();
  const targets: RetryTarget[] = [];
  for (const flag of parse.flags) {
    if (flag.row === undefined) continue;
    const { bbox, lines } = flag.row;
    const pad = (0.4 * (bbox.y1 - bbox.y0)) / lines;
    const top = Math.max(panel.top, Math.round(bbox.y0 - pad));
    const end = Math.min(panel.top + panel.height, Math.round(bbox.y1 + pad));
    const key = `${top}:${end}`;
    if (seen.has(key) || end <= top) continue;
    seen.add(key);
    targets.push({ rect: { left: panel.left, top, width: panel.width, height: end - top }, mode: lines > 1 ? 'block' : 'line' });
  }
  return targets;
}

/**
 * Lower is better. Unread fields dominate, then errors, then reviews.
 * Unread must come first: when the name is lost, the checks that depend
 * on it (Sonata, cost) stop firing, so counting flags alone would rank
 * "name not read" as better than "name read approximately".
 */
export function parseCost({ echo, flags }: PanelParse): number {
  const unread =
    [echo.echoDefId, echo.level, echo.cost, echo.mainStat, echo.secondMainStat].filter((v) => v === null).length +
    echo.substats.filter((s) => s === null).length;
  return unread * 10_000 + flags.reduce((sum, f) => sum + (f.severity === 'error' ? 100 : 1), 0);
}

export interface PanelRead {
  words: OcrWord[];
  /** What the parse saw beyond `words` (the tag pass, the equip check); empty when the frame was skipped. */
  extras?: PanelExtras;
  parse: PanelParse;
}

/**
 * Full read:
 *   - pass 1; a frame whose pass-1 read shows no Echo panel at all (the
 *     in-game Filter sheet: ~110 of the 2026-10-23 recording's frames)
 *     stops here, since passes 2–5 cannot turn it into a panel;
 *   - passes 2–4, then, with `pixels`, the filter-tag read (`readTag`)
 *     and the gold "Equipped by" check (pixels.ts);
 *   - parse, then — only if the parse flagged rows — re-read each flagged
 *     row (pass 5) and adopt that strip's words only if the parse's
 *     `parseCost` strictly drops, one strip at a time. A re-read only
 *     replaces words inside its strip, and those words go through exactly
 *     the same validation as any other read — the retry adds no trust of
 *     its own.
 */
export async function readPanel(ocr: OcrFn, frameWidth: number, frameHeight: number, parse: ParseFn, pixels?: PixelFn): Promise<PanelRead> {
  const panel = panelRect(frameWidth, frameHeight);
  const pass1 = await ocr(panel, 'sparse');
  const first = parse(pass1);
  if (isPanelless(first)) return { words: pass1, extras: {}, parse: first };
  const refined = await refineWords(ocr, pass1, panel);
  let words = refined.words;
  const extras: PanelExtras =
    pixels === undefined
      ? {}
      : { tag: await readTag(ocr, pixels, frameWidth, frameHeight), equipLine: await equipLine(pixels, refined.footer) };
  let best = parse(words, extras);
  for (const target of retryTargets(best, panel)) {
    const candidate = replaceWords(words, await ocr(target.rect, target.mode), target.rect);
    const reparsed = parse(candidate, extras);
    if (parseCost(reparsed) < parseCost(best)) {
      words = candidate;
      best = reparsed;
    }
  }
  return { words, extras, parse: best };
}
