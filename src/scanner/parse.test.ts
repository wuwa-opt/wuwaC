import { describe, expect, it } from 'vitest';
import { loadBundledSnapshot } from '../data/index.ts';
import type { StatKey } from '../data/schema.ts';
import fixtures from './fixtures/panels.json';
import { groupRows, parsePanel, resolveCharacter, textLineBox, type OcrWord, type ScanBatch, type ScanField } from './parse.ts';

const snapshot = loadBundledSnapshot();

function w(text: string, x0: number, y0: number, x1: number, y1: number): OcrWord {
  return { text, bbox: { x0, y0, x1, y1 } };
}

/** Lay out "label … value" rows at 45 px pitch, like the real panel. */
function panelWords(header: string[], stats: [string, string][], footer: string[] = []): OcrWord[] {
  const out: OcrWord[] = [];
  let y = 130;
  for (const line of header) {
    let x = 1330;
    for (const word of line.split(' ')) {
      out.push(w(word, x, y, x + word.length * 14, y + 22));
      x += word.length * 14 + 8;
    }
    y += 60;
  }
  y = 460;
  for (const [label, value] of stats) {
    let x = 1355;
    for (const word of label.split(' ')) {
      out.push(w(word, x, y, x + word.length * 14, y + 22));
      x += word.length * 14 + 8;
    }
    out.push(w(value, 1848 - value.length * 16, y, 1848, y + 22));
    y += 45;
  }
  y += 40;
  for (const line of footer) {
    let x = 1335;
    for (const word of line.split(' ')) {
      out.push(w(word, x, y, x + word.length * 14, y + 22));
      x += word.length * 14 + 8;
    }
    y += 45;
  }
  return out;
}

const HEADER_KERASAUR = ['Kerasaur', '+25', 'COST 3'];
const STATS_KERASAUR: [string, string][] = [
  ['Fusion DMG Bonus', '30.0%'],
  ['ATK', '100'],
  ['Crit. Rate', '6.3%'],
  ['Energy Regen', '8.4%'],
  ['Heavy Attack DMG Bonus', '10.1%'],
  ['Crit. DMG', '17.4%'],
  ['Basic Attack DMG Bonus', '8.6%'],
];
// Kerasaur rolls Flaming Clawprint (checked against the snapshot below).
const BATCH: ScanBatch = { sonataId: 'flaming-clawprint', rarity: 5 };

describe('groupRows', () => {
  it('groups by vertical center and orders words left to right', () => {
    const rows = groupRows([w('Rate', 1428, 553, 1490, 575), w('6.3%', 1775, 554, 1848, 574), w('Crit.', 1355, 552, 1420, 575)]);
    expect(rows.map((r) => r.text)).toEqual(['Crit. Rate 6.3%']);
  });

  it('does not let one tall junk glyph merge two text lines', () => {
    // Real failure (Havoc Dreadmane, sparse mode): an art glyph spanning
    // y 102–209 swallowed "+25" (202–225) and "COST 3" (254–274).
    const rows = groupRows([w('+25', 1336, 202, 1384, 225), w('®', 1500, 102, 1540, 270), w('COST', 1338, 254, 1408, 274), w('3', 1425, 254, 1440, 274)]);
    expect(rows.map((r) => r.text)).toContain('+25');
    expect(rows.map((r) => r.text)).toContain('COST 3');
  });
});

describe('parsePanel (synthetic)', () => {
  it('reads a clean panel with no flags', () => {
    expect(snapshot.echoDefs.find((d) => d.id === 'kerasaur')?.sonataIds).toContain('flaming-clawprint');
    const { echo, flags } = parsePanel(panelWords(HEADER_KERASAUR, STATS_KERASAUR, ['Echo Skill', 'Equipped by Denia']), BATCH, snapshot);
    expect(flags).toEqual([]);
    expect(echo).toEqual({
      echoDefId: 'kerasaur',
      cost: 3,
      level: 25,
      rarity: 5,
      sonataId: 'flaming-clawprint',
      mainStat: { stat: 'dmgBonus:Fusion', value: 0.3 },
      secondMainStat: { stat: 'atk', value: 100 },
      substats: [
        { stat: 'critRate', value: 0.063 },
        { stat: 'energyRegen', value: 0.084 },
        { stat: 'dmgBonus:heavy', value: 0.101 },
        { stat: 'critDmg', value: 0.174 },
        { stat: 'dmgBonus:basic', value: 0.086 },
      ],
      equippedTo: 'denia',
    });
  });

  it('errors when the Echo cannot roll the batch Sonata (stale in-game filter)', () => {
    const { flags } = parsePanel(panelWords(HEADER_KERASAUR, STATS_KERASAUR), { sonataId: 'freezing-frost', rarity: 5 }, snapshot);
    expect(flags).toEqual([
      expect.objectContaining({ field: 'sonata', severity: 'error', message: expect.stringContaining('Is the in-game Sonata filter still set?') }),
    ]);
  });

  it('skips junk rows between COST and the stats instead of shifting every stat', () => {
    // The lock/discard icon row OCRs as e.g. "»A © 08" — it ends in a number.
    const words = panelWords([...HEADER_KERASAUR, '»A © 08'], STATS_KERASAUR);
    const { echo, flags } = parsePanel(words, BATCH, snapshot);
    expect(flags).toEqual([]);
    expect(echo.mainStat).toEqual({ stat: 'dmgBonus:Fusion', value: 0.3 });
  });

  it('flags every stat field when level or cost is unreadable', () => {
    const { echo, flags } = parsePanel(panelWords(['Kerasaur', 'COST 3'], STATS_KERASAUR), BATCH, snapshot);
    expect(echo.level).toBeNull();
    const errorFields = flags.filter((f) => f.severity === 'error').map((f) => f.field);
    expect(errorFields).toEqual<ScanField[]>(['level', 'main', 'second', 'substats']);
  });

  it('falls back to the def cost with a review flag when COST is unreadable', () => {
    const { echo, flags } = parsePanel(panelWords(['Kerasaur', '+25'], STATS_KERASAUR), BATCH, snapshot);
    expect(echo.cost).toBe(3);
    expect(flags).toEqual([{ field: 'cost', severity: 'review', message: "COST not read; using Kerasaur's cost 3" }]);
  });

  it('flags a missing substat row', () => {
    const { echo, flags } = parsePanel(panelWords(HEADER_KERASAUR, STATS_KERASAUR.slice(0, 6)), BATCH, snapshot);
    expect(echo.substats).toHaveLength(4);
    expect(flags).toEqual([
      { field: 'substats', severity: 'review', message: 'read 4 substats; a +25 Echo can have 5 — check none was missed' },
    ]);
  });

  it('errors on a duplicated substat', () => {
    const stats: [string, string][] = [...STATS_KERASAUR.slice(0, 6), ['Crit. Rate', '6.9%']];
    const { flags } = parsePanel(panelWords(HEADER_KERASAUR, stats), BATCH, snapshot);
    expect(flags).toContainEqual({ field: 'substats', severity: 'error', message: 'the same substat was read twice' });
  });

  it('merges a wrapped label line into its row', () => {
    const words = panelWords(HEADER_KERASAUR, STATS_KERASAUR.slice(0, 2));
    // "Resonance Skill DMG" + value at y 550, "Bonus" alone right below.
    words.push(w('Resonance', 1355, 550, 1480, 572), w('Skill', 1488, 550, 1550, 572), w('DMG', 1558, 550, 1610, 572));
    words.push(w('8.6%', 1784, 550, 1848, 572), w('Bonus', 1355, 584, 1430, 606));
    const { echo } = parsePanel(words, BATCH, snapshot);
    expect(echo.substats).toEqual([{ stat: 'dmgBonus:skill', value: 0.086 }]);
  });

  it('treats an icon glyph fused onto a label as icon residue', () => {
    const stats: [string, string][] = [['Fusion DMG Bonus', '30.0%'], ['WATK', '100'], ...STATS_KERASAUR.slice(2)];
    const { echo, flags } = parsePanel(panelWords(HEADER_KERASAUR, stats), BATCH, snapshot);
    expect(flags).toEqual([]);
    expect(echo.secondMainStat).toEqual({ stat: 'atk', value: 100 });
  });

  it('offers a unique name prefix for review when art hides the end of the name', () => {
    const { echo, flags } = parsePanel(panelWords(['Nightmare: Dwarf', '+25', 'COST 1'], []), { sonataId: 'x', rarity: 5 }, snapshot);
    expect(echo.echoDefId).toBe('nightmare-dwarf-cassowary');
    expect(flags[0]).toMatchObject({ field: 'name', severity: 'review', message: 'name read approximately as Nightmare: Dwarf Cassowary', row: { lines: 1 } });
  });
});

describe('parsePanel row reporting (for the retry pass)', () => {
  it('errors on a stat label whose value was not read, instead of dropping the row', () => {
    // Real case (2026-10-22 video, Kerasaur): "Energy Regen 9.2%" lost its value.
    const words = panelWords(HEADER_KERASAUR, STATS_KERASAUR.slice(0, 6));
    // Next row at the 45 px pitch: 460 + 6 * 45 = 730.
    words.push(w('Energy', 1355, 730, 1440, 752), w('Regen', 1448, 730, 1520, 752));
    const { echo, flags } = parsePanel(words, BATCH, snapshot);
    expect(echo.substats).toHaveLength(5);
    expect(echo.substats[4]).toBeNull();
    expect(flags).toEqual([
      { field: 'sub5', severity: 'error', message: 'Energy Regen value not read', row: { bbox: { x0: 1355, y0: 730, x1: 1520, y1: 752 }, lines: 1 } },
    ]);
  });

  it('reports a wrapped label as a two-line row', () => {
    const words = panelWords(HEADER_KERASAUR, STATS_KERASAUR.slice(0, 2));
    words.push(w('Resonance', 1355, 550, 1480, 572), w('Skill', 1488, 550, 1550, 572), w('DMG', 1558, 550, 1610, 572));
    words.push(w('7.0%', 1784, 550, 1848, 572), w('Bonus', 1355, 584, 1430, 606));
    const { flags } = parsePanel(words, BATCH, snapshot);
    expect(flags[0]).toMatchObject({ field: 'sub1', severity: 'error', row: { lines: 2, bbox: { y0: 550, y1: 606 } } });
  });
});

describe('textLineBox', () => {
  it('uses the top edge and the smallest wordy height, ignoring art-inflated boxes and junk', () => {
    // Real boxes from the 2026-10-22 video (seg00 name row).
    const row = groupRows([w('Reminiscence:', 1308, 109, 1548, 150), w('Fledrel=gis', 1559, 108, 1737, 172), w('\\', 1712, 120, 1728, 140)])[0];
    expect(textLineBox(row)).toEqual({ x0: 1308, y0: 108, x1: 1737, y1: 149 });
  });
});

describe('resolveCharacter', () => {
  it('matches exactly, including colon names', () => {
    expect(resolveCharacter('Yangyang: Xuanling', snapshot.characters)).toEqual({ kind: 'one', id: 'yangyang-xuanling', name: 'Yangyang: Xuanling', exact: true });
  });

  it('reports the bare family name "Rover" as a choice, never a pick', () => {
    const r = resolveCharacter('Rover', snapshot.characters);
    expect(r.kind).toBe('many');
    if (r.kind === 'many') expect(r.ids.slice().sort()).toEqual(['rover-aero', 'rover-electro', 'rover-havoc', 'rover-spectro']);
  });

  it('reads the font-confusable "luno" as Iuno (capital I vs lowercase l)', () => {
    expect(resolveCharacter('luno', snapshot.characters)).toMatchObject({ kind: 'one', id: 'iuno', exact: true });
  });

  it('returns none for unknown text', () => {
    expect(resolveCharacter('Zzzzqx', snapshot.characters)).toEqual({ kind: 'none' });
  });
});

// --- Real OCR fixtures ---------------------------------------------------------------

interface Expected {
  name: string;
  level: number;
  cost: number;
  /** [label, value text] pairs exactly as on screen. */
  main: string[][];
  subs: string[][];
  equippedBy: string | null;
}

interface Panel {
  expected: Expected;
  words: OcrWord[];
}

/** Hand-written label table, deliberately NOT the parser's vocabulary. */
const LABEL_TO_STATS: Record<string, [StatKey, StatKey]> = {
  HP: ['hp', 'hpPct'],
  ATK: ['atk', 'atkPct'],
  DEF: ['def', 'defPct'],
  'Crit. Rate': ['critRate', 'critRate'],
  'Crit. DMG': ['critDmg', 'critDmg'],
  'Energy Regen': ['energyRegen', 'energyRegen'],
  'Glacio DMG Bonus': ['dmgBonus:Glacio', 'dmgBonus:Glacio'],
  'Fusion DMG Bonus': ['dmgBonus:Fusion', 'dmgBonus:Fusion'],
  'Electro DMG Bonus': ['dmgBonus:Electro', 'dmgBonus:Electro'],
  'Aero DMG Bonus': ['dmgBonus:Aero', 'dmgBonus:Aero'],
  'Havoc DMG Bonus': ['dmgBonus:Havoc', 'dmgBonus:Havoc'],
  'Basic Attack DMG Bonus': ['dmgBonus:basic', 'dmgBonus:basic'],
  'Heavy Attack DMG Bonus': ['dmgBonus:heavy', 'dmgBonus:heavy'],
  'Resonance Skill DMG Bonus': ['dmgBonus:skill', 'dmgBonus:skill'],
  'Resonance Liberation DMG Bonus': ['dmgBonus:liberation', 'dmgBonus:liberation'],
};

function expectedStat([label, text]: string[]): { stat: StatKey; value: number } {
  const [flat, pct] = LABEL_TO_STATS[label];
  return text.endsWith('%') ? { stat: pct, value: Math.round(Number(text.slice(0, -1)) * 10) / 1000 } : { stat: flat, value: Number(text) };
}

/** JSON tuples arrive as loose arrays; rebuild them as typed words. */
const panels: [string, Panel][] = Object.entries(fixtures.panels).map(([name, raw]) => [
  name,
  {
    expected: raw.expected,
    words: raw.words.map(([text, x0, y0, x1, y1]) => w(String(text), Number(x0), Number(y0), Number(x1), Number(y1))),
  },
]);

function panel(name: string): Panel {
  const found = panels.find(([n]) => n === name);
  if (found === undefined) throw new Error(`no fixture ${name}`);
  return found[1];
}

describe('parsePanel on 33 real OCR reads (tesseract.js 7, 5-pass: 17 screenshots + 16 video frames)', () => {
  it.each(panels)('%s: every wrong field is flagged (zero silent errors)', (_name, panel) => {
    const words = panel.words;
    const def = snapshot.echoDefs.find((d) => d.name === panel.expected.name);
    expect(def).toBeDefined();
    const { echo, flags } = parsePanel(words, { sonataId: def!.sonataIds[0], rarity: 5 }, snapshot);
    const flagged = new Set(flags.map((f) => f.field));
    const wrongAndSilent: string[] = [];
    const check = (field: ScanField, ok: boolean): void => {
      const covered = flagged.has(field) || (field.startsWith('sub') && flagged.has('substats'));
      if (!ok && !covered) wrongAndSilent.push(field);
    };
    check('name', echo.echoDefId === def!.id);
    check('level', echo.level === panel.expected.level);
    check('cost', echo.cost === panel.expected.cost);
    check('main', JSON.stringify(echo.mainStat) === JSON.stringify(expectedStat(panel.expected.main[0])));
    check('second', JSON.stringify(echo.secondMainStat) === JSON.stringify(expectedStat(panel.expected.main[1])));
    panel.expected.subs.forEach((s, i) => {
      check(`sub${(i + 1) as 1 | 2 | 3 | 4 | 5}`, JSON.stringify(echo.substats[i] ?? null) === JSON.stringify(expectedStat(s)));
    });
    check('substats', echo.substats.length === panel.expected.subs.length);
    const equipId = panel.expected.equippedBy === null ? null : snapshot.characters.find((c) => c.name === panel.expected.equippedBy)?.id;
    check('equipped', equipId === undefined ? (echo.equippedCandidates?.length ?? 0) > 1 : echo.equippedTo === equipId);
    expect(wrongAndSilent).toEqual([]);
  });

  it('reads 31 of 33 panels with no flags at all (the rest: one approximate name, one Rover choice)', () => {
    const clean = panels.filter(([, panel]) => {
      const def = snapshot.echoDefs.find((d) => d.name === panel.expected.name)!;
      return parsePanel(panel.words, { sonataId: def.sonataIds[0], rarity: 5 }, snapshot).flags.length === 0;
    });
    expect(clean).toHaveLength(31);
  });

  it('reads the reference panel (Threnodian Leviathan) exactly', () => {
    const { echo, flags } = parsePanel(panel('2026-10-16_16-56-49').words, { sonataId: 'flamewing-s-shadow', rarity: 5 }, snapshot);
    expect(flags).toEqual([]);
    expect(echo).toEqual({
      echoDefId: 'reminiscence-threnodian-leviathan',
      cost: 4,
      level: 25,
      rarity: 5,
      sonataId: 'flamewing-s-shadow',
      mainStat: { stat: 'critRate', value: 0.22 },
      secondMainStat: { stat: 'atk', value: 150 },
      substats: [
        { stat: 'dmgBonus:skill', value: 0.094 },
        { stat: 'critDmg', value: 0.198 },
        { stat: 'critRate', value: 0.069 },
        { stat: 'energyRegen', value: 0.108 },
        { stat: 'hpPct', value: 0.064 },
      ],
      equippedTo: 'galbrena',
    });
  });
});
