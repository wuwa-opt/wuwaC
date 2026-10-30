import { describe, expect, it } from 'vitest';
import { designWidth, equipCheckRect, filterTagRect, footerRect, gridBarRects, labelColumnRect, panelRect, replaceWords, valueColumnRect } from './layout.ts';
import type { OcrWord } from './parse.ts';

function w(text: string, x0: number, y0: number, x1: number, y1: number): OcrWord {
  return { text, bbox: { x0, y0, x1, y1 } };
}

/** A minimal 1920×1080 panel read: header, three stat rows, footer. */
const PASS1: OcrWord[] = [
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
  w('6.3%', 1775, 553, 1848, 575),
  w('Echo', 1335, 830, 1400, 852),
  w('Skill', 1408, 830, 1470, 852),
];

describe('designWidth', () => {
  it('is the frame width up to 16:9 and 16/9 of the height beyond', () => {
    expect(designWidth(1920, 1080)).toBe(1920);
    expect(designWidth(1891, 1080)).toBe(1891); // a region capture a little narrower than 16:9
    expect(designWidth(1920, 1200)).toBe(1920); // 16:10
    expect(designWidth(2400, 1080)).toBe(1920); // a 20:9 phone
    expect(designWidth(1914, 1072)).toBe(1906); // 1072 × 16/9 = 1905.8
  });
});

describe('filterTagRect', () => {
  it('spans x from the left edge to the panel band, y 80–95%', () => {
    expect(filterTagRect(1920, 1080)).toEqual({ left: 0, top: 864, width: 1267, height: 162 });
    // The user's 1914×1072 recording: its measured tag box [183, 886, 592, 935] sits inside.
    expect(filterTagRect(1914, 1072)).toEqual({ left: 0, top: 858, width: 1266, height: 160 });
    expect(filterTagRect(2400, 1080)).toEqual({ left: 0, top: 864, width: 1747, height: 162 });
  });
});

describe('gridBarRects', () => {
  it('starts with the measured strip (x 4–36%, y 88% to the tag area\'s bottom), then steps right half a strip at a time', () => {
    expect(gridBarRects(1920, 1080)).toEqual([
      { left: 77, top: 950, width: 614, height: 76 },
      { left: 384, top: 950, width: 614, height: 76 },
      { left: 653, top: 950, width: 614, height: 76 }, // clamped to end at the band (1267)
    ]);
  });

  it('keeps the 16:9 strip width on a wider frame and covers up to its band', () => {
    expect(gridBarRects(2400, 1080).map((r) => r.left)).toEqual([77, 384, 691, 998, 1133]);
    expect(gridBarRects(2400, 1080).every((r) => r.width === 614)).toBe(true);
  });
});

describe('equipCheckRect', () => {
  it('is the panel band from 45% of its height down', () => {
    // panelRect(1920, 1080): y 86–950; 86 + 864 × 0.45 = 474.8 -> 475.
    expect(equipCheckRect(panelRect(1920, 1080))).toEqual({ left: 1267, top: 475, width: 653, height: 475 });
  });
});

describe('panelRect', () => {
  it('covers the right-hand 34% band, y 8–88%', () => {
    // 1920*0.34 = 652.8 -> 653 wide from the right edge; 1080*0.08 = 86.4 -> 86; 1080*0.8 = 864.
    expect(panelRect(1920, 1080)).toEqual({ left: 1267, top: 86, width: 653, height: 864 });
  });

  it('keeps its 16:9 size on the right edge of a wider frame', () => {
    expect(panelRect(2400, 1080)).toEqual({ left: 1747, top: 86, width: 653, height: 864 });
    // 1600×720: 1280 × 0.34 = 435.2 -> 435.
    expect(panelRect(1600, 720)).toEqual({ left: 1165, top: 58, width: 435, height: 576 });
  });

  it('is 34% of the frame width when the frame is narrower than 16:9', () => {
    // 1920×1200 (16:10): 653 wide; 1200*0.08 = 96; 1200*0.8 = 960.
    expect(panelRect(1920, 1200)).toEqual({ left: 1267, top: 96, width: 653, height: 960 });
  });
});

describe('valueColumnRect', () => {
  const panel = panelRect(1920, 1080);

  it('spans 1.5× the widest value back from the values’ right edge', () => {
    // Widest value "30.0%" = 88 px; right edge 1848 -> left = 1848 - 132 = 1716.
    // Line height 22: top = 463 - 44 = 419; bottom = 575 + 44 = 619.
    expect(valueColumnRect(PASS1, panel)).toEqual({ left: 1716, top: 419, width: 1920 - 1716, height: 619 - 419 });
  });

  it('extends down to the footer when that is lower (a missed last value must not be sliced)', () => {
    // Same column as above, but the footer starts at 700: bottom = 700, not 619.
    expect(valueColumnRect(PASS1, panel, 700)).toEqual({ left: 1716, top: 419, width: 204, height: 700 - 419 });
    // A higher footer never shortens the column.
    expect(valueColumnRect(PASS1, panel, 500)?.height).toBe(619 - 419);
  });

  it('is null without stat rows to anchor on', () => {
    expect(valueColumnRect(PASS1.slice(0, 4), panel)).toBeNull();
  });
});

describe('footerRect', () => {
  const panel = panelRect(1920, 1080);

  it('starts half a line above "Echo Skill"', () => {
    // Echo Skill row 830–852 (h 22) -> top 819; panel bottom 86 + 864 = 950.
    expect(footerRect(PASS1, panel)).toEqual({ left: 1267, top: 819, width: 653, height: 131 });
  });

  it('falls back to two line-heights under the last stat row', () => {
    // Last stat row 553–575 (h 22) -> 575 + 44 = 619.
    expect(footerRect(PASS1.slice(0, -2), panel).top).toBe(619);
  });

  it('never starts below half a line above the gold "Equipped by" line', () => {
    // The last row as pass 1 read it on a 720p frame: label lost, two junk words off the icon and art, 2–3 lines tall.
    // Its box is the words' median: 552–596 (44 tall), so the fallback is 596 + 2 × 44 = 684, under the line.
    const junk = [...PASS1.slice(0, 10), w('lr', 1330, 550, 1350, 600), w('1', 1500, 552, 1510, 596), w('6.3%', 1775, 553, 1848, 575)];
    expect(footerRect(junk, panel).top).toBe(684);
    // The gold line found in pixels at 640–660 caps it: 640 − 10 = 630.
    expect(footerRect(junk, panel, { x0: 1300, y0: 640, x1: 1600, y1: 660 }).top).toBe(630);
    // A gold line below the strip changes nothing.
    expect(footerRect(PASS1, panel, { x0: 1300, y0: 870, x1: 1600, y1: 890 }).top).toBe(819);
  });
});

describe('labelColumnRect', () => {
  it('fills the space left of the values and above the footer', () => {
    const panel = panelRect(1920, 1080);
    const values = { left: 1716, top: 419, width: 204, height: 200 };
    const footer = { left: 1267, top: 819, width: 653, height: 131 };
    expect(labelColumnRect(values, footer, panel)).toEqual({ left: 1267, top: 419, width: 449, height: 400 });
    expect(labelColumnRect(values, { ...footer, top: 400 }, panel)).toBeNull();
  });
});

describe('replaceWords', () => {
  it('swaps only the words centered inside the rectangle', () => {
    const rect = { left: 1700, top: 450, width: 220, height: 140 };
    const later = [w('6.3%', 1776, 553, 1848, 575), w('ignored', 10, 10, 20, 20)];
    const merged = replaceWords(PASS1, later, rect);
    // The three pass-1 values inside the rect are gone, replaced by the one later word inside it.
    expect(merged.filter((x) => /\d%?$/.test(x.text) && x.bbox.x0 > 1700).map((x) => x.text)).toEqual(['6.3%']);
    expect(merged.some((x) => x.text === 'ignored')).toBe(false);
    expect(merged).toHaveLength(PASS1.length - 3 + 1);
  });
});
