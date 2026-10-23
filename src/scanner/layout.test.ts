import { describe, expect, it } from 'vitest';
import { filterTagRect, footerRect, gridBarRect, labelColumnRect, panelRect, replaceWords, valueColumnRect } from './layout.ts';
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

describe('filterTagRect', () => {
  it('covers the filter tag and the grid bar under it: x 4–36%, y 80–95%', () => {
    expect(filterTagRect(1920, 1080)).toEqual({ left: 77, top: 864, width: 614, height: 162 });
    // The user's 1914×1072 recording: its measured tag box [183, 886, 592, 935] sits inside.
    expect(filterTagRect(1914, 1072)).toEqual({ left: 77, top: 858, width: 612, height: 160 });
  });
});

describe('gridBarRect', () => {
  it('is the bottom of the tag area from y 88% ("Sort by Level")', () => {
    expect(gridBarRect(1920, 1080)).toEqual({ left: 77, top: 950, width: 614, height: 76 });
  });
});

describe('panelRect', () => {
  it('covers the right-hand 34% band, y 8–88%', () => {
    // 1920*0.66 = 1267.2 -> 1267; 1080*0.08 = 86.4 -> 86; 1080*0.8 = 864.
    expect(panelRect(1920, 1080)).toEqual({ left: 1267, top: 86, width: 653, height: 864 });
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
