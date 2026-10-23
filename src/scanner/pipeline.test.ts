import { describe, expect, it } from 'vitest';
import type { Rect } from './layout.ts';
import type { OcrWord, PanelExtras, PanelParse, ScannedEcho } from './parse.ts';
import { parseCost, readPanel, readPanelWords, retryTargets, type PassMode } from './pipeline.ts';

function w(text: string, x0: number, y0: number, x1: number, y1: number): OcrWord {
  return { text, bbox: { x0, y0, x1, y1 } };
}

/** Pass-1 read with the two classic sparse-mode slips: a truncated value and no footer. */
const SPARSE: OcrWord[] = [
  w('Kerasaur', 1330, 130, 1460, 155),
  w('+25', 1336, 202, 1384, 225),
  w('COST', 1338, 254, 1408, 274),
  w('3', 1425, 254, 1440, 274),
  w('Fusion', 1355, 463, 1440, 485),
  w('DMG', 1448, 463, 1510, 485),
  w('Bonus', 1518, 463, 1600, 485),
  w('30.0%', 1760, 463, 1848, 485),
  w('ATK', 1355, 508, 1410, 530),
  w('100', 1795, 508, 1848, 530),
  w('Crit.', 1355, 553, 1420, 575),
  w('Rate', 1428, 553, 1490, 575),
  w('3%', 1800, 553, 1848, 575),
];

describe('readPanelWords', () => {
  it('runs sparse -> digits -> block(labels) -> block(footer) and lets later passes win', async () => {
    const calls: { mode: PassMode; rect: Rect }[] = [];
    const ocr = (rect: Rect, mode: PassMode): Promise<OcrWord[]> => {
      calls.push({ mode, rect });
      if (mode === 'sparse') return Promise.resolve(SPARSE);
      if (mode === 'digits') return Promise.resolve([w('30.0%', 1760, 463, 1848, 485), w('100', 1795, 508, 1848, 530), w('6.3%', 1775, 553, 1848, 575)]);
      // Footer pass (the second block pass) finds the equipped line.
      if (calls.filter((c) => c.mode === 'block').length === 2) {
        return Promise.resolve([w('Equipped', 1360, 880, 1480, 902), w('by', 1488, 880, 1520, 902), w('Denia', 1528, 880, 1600, 902)]);
      }
      return Promise.resolve([]);
    };
    const words = await readPanelWords(ocr, 1920, 1080);
    expect(calls.map((c) => c.mode)).toEqual(['sparse', 'digits', 'block', 'block']);
    // The panel band for 1920×1080 (see layout.test.ts).
    expect(calls[0].rect).toEqual({ left: 1267, top: 86, width: 653, height: 864 });
    const texts = words.map((x) => x.text);
    expect(texts).toContain('6.3%');
    expect(texts).not.toContain('3%');
    expect(texts).toContain('Denia');
    // The label pass returned nothing, so the labels it covered are dropped —
    // a later pass owns its rectangle entirely (no stale mixing).
    expect(texts).not.toContain('Fusion');
    expect(texts).toContain('Kerasaur');
  });

  it('skips the column passes when sparse mode found no stat rows', async () => {
    const modes: PassMode[] = [];
    await readPanelWords(
      (_rect, mode) => {
        modes.push(mode);
        return Promise.resolve(mode === 'sparse' ? SPARSE.slice(0, 4) : []);
      },
      1920,
      1080,
    );
    expect(modes).toEqual(['sparse', 'block']);
  });
});

const ECHO: ScannedEcho = {
  echoDefId: 'kerasaur',
  cost: 3,
  level: 25,
  rarity: 5,
  sonataId: 'flaming-clawprint',
  mainStat: { stat: 'dmgBonus:Fusion', value: 0.3 },
  secondMainStat: { stat: 'atk', value: 100 },
  substats: [{ stat: 'critRate', value: 0.063 }],
  equippedTo: null,
};
const PANEL = { left: 1267, top: 86, width: 653, height: 864 };

describe('retryTargets', () => {
  it('turns each flagged row into a full-width strip padded 40% of a line', () => {
    const parse: PanelParse = {
      echo: ECHO,
      flags: [
        // One-line row 22 px tall -> pad 8.8: 730 - 8.8 = 721.2 -> 721; 752 + 8.8 = 760.8 -> 761.
        { field: 'sub5', severity: 'error', message: 'x', row: { bbox: { x0: 1355, y0: 730, x1: 1520, y1: 752 }, lines: 1 } },
        // Wrapped label (2 lines, 56 px) -> pad 0.4 * 56 / 2 = 11.2 -> 539..617, block mode.
        { field: 'sub1', severity: 'review', message: 'y', row: { bbox: { x0: 1355, y0: 550, x1: 1848, y1: 606 }, lines: 2 } },
        // Same strip again (another flag on the same row) is not re-read twice.
        { field: 'sub5', severity: 'review', message: 'z', row: { bbox: { x0: 1355, y0: 730, x1: 1520, y1: 752 }, lines: 1 } },
        // No row (a real choice, e.g. Rover): nothing to re-read.
        { field: 'equipped', severity: 'review', message: 'pick' },
      ],
    };
    expect(retryTargets(parse, PANEL)).toEqual([
      { rect: { left: 1267, top: 721, width: 653, height: 40 }, mode: 'line' },
      { rect: { left: 1267, top: 539, width: 653, height: 78 }, mode: 'block' },
    ]);
  });
});

describe('parseCost', () => {
  it('ranks unread fields above errors above reviews', () => {
    const review = { field: 'name', severity: 'review', message: '' } as const;
    const error = { field: 'sonata', severity: 'error', message: '' } as const;
    expect(parseCost({ echo: ECHO, flags: [] })).toBe(0);
    expect(parseCost({ echo: ECHO, flags: [review, review] })).toBe(2);
    expect(parseCost({ echo: ECHO, flags: [error] })).toBe(100);
    // The real trap: a lost name drops the Sonata error with it (101 -> 100),
    // but one unread field (10 000) still ranks it worse.
    expect(parseCost({ echo: { ...ECHO, echoDefId: null }, flags: [{ field: 'name', severity: 'error', message: '' }] })).toBe(10_100);
    expect(parseCost({ echo: { ...ECHO, substats: [null, null] }, flags: [] })).toBe(20_000);
  });
});

describe('readPanel (pass 5)', () => {
  const flagged = (rowY: number): PanelParse => ({
    echo: ECHO,
    flags: [{ field: 'sub1', severity: 'error', message: 'bad', row: { bbox: { x0: 1355, y0: rowY, x1: 1848, y1: rowY + 22 }, lines: 1 } }],
  });

  it('adopts a re-read strip only when the parse gets strictly better', async () => {
    const modes: PassMode[] = [];
    const ocr = (_rect: Rect, mode: PassMode): Promise<OcrWord[]> => {
      modes.push(mode);
      if (mode === 'sparse') return Promise.resolve(SPARSE);
      if (mode === 'line') return Promise.resolve([w('GOOD', 1355, 553, 1420, 575)]);
      return Promise.resolve([]);
    };
    // Parse is "bad" until the strip's words contain GOOD.
    const parse = (words: readonly OcrWord[]): PanelParse =>
      words.some((x) => x.text === 'GOOD') ? { echo: ECHO, flags: [] } : flagged(553);
    const read = await readPanel(ocr, 1920, 1080, parse);
    expect(modes.at(-1)).toBe('line');
    expect(read.parse.flags).toEqual([]);
    expect(read.words.map((x) => x.text)).toContain('GOOD');
  });

  it('keeps the first read when the re-read is no better', async () => {
    const ocr = (_rect: Rect, mode: PassMode): Promise<OcrWord[]> =>
      Promise.resolve(mode === 'sparse' ? SPARSE : mode === 'line' ? [w('WORSE', 1355, 553, 1420, 575)] : []);
    const first = flagged(553);
    const worse: PanelParse = { echo: { ...ECHO, echoDefId: null }, flags: [] };
    const read = await readPanel(ocr, 1920, 1080, (words) => (words.some((x) => x.text === 'WORSE') ? worse : first));
    expect(read.parse).toBe(first);
    expect(read.words.map((x) => x.text)).not.toContain('WORSE');
  });

  it('runs no pass 5 when nothing is flagged', async () => {
    const modes: PassMode[] = [];
    await readPanel(
      (_rect, mode) => {
        modes.push(mode);
        return Promise.resolve(mode === 'sparse' ? SPARSE : []);
      },
      1920,
      1080,
      () => ({ echo: ECHO, flags: [] }),
    );
    // Passes 1–4 only: with no pixels there is no tag read or equip check.
    expect(modes).toEqual(['sparse', 'digits', 'block', 'block']);
  });
});

describe('readPanel (filter tag, equip check, panel-less frames)', () => {
  const empty: PanelParse = { echo: { ...ECHO, echoDefId: null, cost: null, mainStat: null }, flags: [] };

  it('stops after pass 1 when it shows no Echo panel (the in-game Filter sheet)', async () => {
    const modes: PassMode[] = [];
    let pixelsAsked = false;
    const read = await readPanel(
      (_rect, mode) => {
        modes.push(mode);
        return Promise.resolve([w('Filtered:', 1300, 860, 1400, 880)]);
      },
      1920,
      1080,
      () => empty,
      () => {
        pixelsAsked = true;
        return Promise.reject(new Error('not needed'));
      },
    );
    expect(modes).toEqual(['sparse']);
    expect(pixelsAsked).toBe(false);
    expect(read.parse).toBe(empty);
    expect(read.extras).toEqual({});
  });

  /** Fake pixels: a dark tag box (tag area) and/or a gold line (footer strip), background elsewhere. */
  function fakePixels(opts: { tagBox: boolean; gold: boolean }, asked: Rect[]) {
    return (rect: Rect) => {
      asked.push(rect);
      const data = new Uint8ClampedArray(rect.width * rect.height * 4);
      for (let i = 0; i < rect.width * rect.height; i++) data.set([136, 159, 175, 255], i * 4);
      if (rect.top === 864 && opts.tagBox) {
        // 420×50 near-black box at (100, 20) of the tag area.
        for (let y = 20; y < 70; y++) for (let x = 100; x < 520; x++) data.set([20, 20, 24, 255], (y * rect.width + x) * 4);
      }
      if (rect.top === 619 && opts.gold) {
        // 230 gold pixels (0.1% of the 653×331 strip is 216.1) in one row, 10–239 px into the strip.
        for (let x = 10; x < 240; x++) data.set([230, 205, 150, 255], (40 * rect.width + x) * 4);
      }
      return Promise.resolve({ width: rect.width, height: rect.height, data });
    };
  }
  // The footer strip: 2 lines under the last stat row (y 575 + 2×22 = 619) to the band's bottom (950).
  const FOOTER = { left: 1267, top: 619, width: 653, height: 331 };
  // filterTagRect(1920, 1080): x 4–36%, y 80–95%.
  const TAG_AREA = { left: 77, top: 864, width: 614, height: 162 };

  it('reads the tag box found in pixels as one line, checks the footer for gold, and hands both to every parse', async () => {
    const calls: { mode: PassMode; rect: Rect }[] = [];
    const tagWords = [w('Trailblazing', 180, 890, 340, 912), w('Star', 350, 890, 400, 912)];
    const ocr = (rect: Rect, mode: PassMode): Promise<OcrWord[]> => {
      calls.push({ mode, rect });
      if (calls.length === 1) return Promise.resolve(SPARSE);
      return Promise.resolve(calls.length === 5 ? tagWords : []);
    };
    const asked: Rect[] = [];
    const seen: (PanelExtras | undefined)[] = [];
    const read = await readPanel(
      ocr,
      1920,
      1080,
      (_words, extras) => {
        seen.push(extras);
        return { echo: ECHO, flags: [] };
      },
      fakePixels({ tagBox: true, gold: true }, asked),
    );
    expect(asked).toEqual([TAG_AREA, FOOTER]);
    // The box, in frame pixels, read as one line from a crop.
    expect(calls[4]).toEqual({ mode: 'tag', rect: { left: 177, top: 884, width: 420, height: 50 } });
    const extras = { tag: tagWords, equipLine: { x0: 1277, y0: 659, x1: 1507, y1: 660 } };
    // seen[0] is the pass-1 panel check, which gets no extras.
    expect(seen).toEqual([undefined, extras]);
    expect(read.extras).toEqual(extras);
  });

  it('reads the grid bar instead when no tag box is seen, and reports no gold line', async () => {
    const calls: { mode: PassMode; rect: Rect }[] = [];
    const ocr = (rect: Rect, mode: PassMode): Promise<OcrWord[]> => {
      calls.push({ mode, rect });
      return Promise.resolve(calls.length === 1 ? SPARSE : []);
    };
    const read = await readPanel(ocr, 1920, 1080, () => ({ echo: ECHO, flags: [] }), fakePixels({ tagBox: false, gold: false }, []));
    // gridBarRect(1920, 1080): y 88% (950) to the tag area's bottom (1026).
    expect(calls[4]).toEqual({ mode: 'tag', rect: { left: 77, top: 950, width: 614, height: 76 } });
    expect(read.extras).toEqual({ tag: [], equipLine: null });
  });
});
