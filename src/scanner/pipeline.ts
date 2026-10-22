import { footerRect, labelColumnRect, panelRect, replaceWords, valueColumnRect, type Rect } from './layout.ts';
import type { OcrWord, PanelParse } from './parse.ts';

/**
 * Scanner layer: the OCR plan for one frame (why each pass exists is
 * documented in layout.ts). The engine and the parser are injected, so
 * this is pure orchestration — the browser binds it to tesseract.js
 * (engine.ts), the Phase 0 spike binds the same function in node, and
 * tests use fakes.
 */

/**
 * sparse = PSM 11; block = PSM 6; digits = PSM 6 with a `0-9.%`
 * whitelist; line = PSM 7 (one text line — the retry pass).
 */
export type PassMode = 'sparse' | 'block' | 'digits' | 'line';

/** Recognize `rect` of the current frame; bboxes in frame pixels. */
export type OcrFn = (rect: Rect, mode: PassMode) => Promise<OcrWord[]>;

/** Parse merged words (the caller closes over batch + snapshot). */
export type ParseFn = (words: readonly OcrWord[]) => PanelParse;

/** Passes 1–4: whole panel, value column, label column, footer. */
export async function readPanelWords(ocr: OcrFn, frameWidth: number, frameHeight: number): Promise<OcrWord[]> {
  const panel = panelRect(frameWidth, frameHeight);
  const pass1 = await ocr(panel, 'sparse');
  let words = pass1;
  const footer = footerRect(pass1, panel);
  const values = valueColumnRect(pass1, panel, footer.top);
  if (values !== null) words = replaceWords(words, await ocr(values, 'digits'), values);
  const labels = values === null ? null : labelColumnRect(values, footer, panel);
  if (labels !== null) words = replaceWords(words, await ocr(labels, 'block'), labels);
  return replaceWords(words, await ocr(footer, 'block'), footer);
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
  parse: PanelParse;
}

/**
 * Full read: passes 1–4, parse, then — only if the parse flagged rows —
 * re-read each flagged row (pass 5) and adopt that strip's words only if
 * the parse's `parseCost` strictly drops, one strip at a time. A re-read
 * only replaces words inside its strip, and those words go through
 * exactly the same validation as any other read — the retry adds no
 * trust of its own.
 */
export async function readPanel(ocr: OcrFn, frameWidth: number, frameHeight: number, parse: ParseFn): Promise<PanelRead> {
  let words = await readPanelWords(ocr, frameWidth, frameHeight);
  let best = parse(words);
  for (const target of retryTargets(best, panelRect(frameWidth, frameHeight))) {
    const candidate = replaceWords(words, await ocr(target.rect, target.mode), target.rect);
    const reparsed = parse(candidate);
    if (parseCost(reparsed) < parseCost(best)) {
      words = candidate;
      best = reparsed;
    }
  }
  return { words, parse: best };
}
