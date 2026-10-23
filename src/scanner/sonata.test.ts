import { describe, expect, it } from 'vitest';
import { loadBundledSnapshot } from '../data/index.ts';
import type { OcrWord } from './parse.ts';
import { readFilterTag, resolveSonata, type TagRead } from './sonata.ts';

const snapshot = loadBundledSnapshot();
const sets = snapshot.sonataSets;
const def = (id: string) => {
  const found = snapshot.echoDefs.find((d) => d.id === id);
  if (found === undefined) throw new Error(`no def ${id}`);
  return found;
};
// Kerasaur rolls Windward Pilgrimage / Flaming Clawprint / Flamewing's Shadow;
// Crownless rolls only Havoc Eclipse (both checked against the snapshot here).
const KERASAUR = def('kerasaur');
const CROWNLESS = def('crownless');

/** One OCR line of words at height y (the tag pass's coordinates don't matter to the reader). */
function line(text: string, y: number): OcrWord[] {
  let x = 180;
  return text.split(' ').map((word) => {
    const out = { text: word, bbox: { x0: x, y0: y, x1: x + word.length * 14, y1: y + 22 } };
    x += word.length * 14 + 8;
    return out;
  });
}

describe('readFilterTag', () => {
  it('checks the defs the tests rely on', () => {
    expect(KERASAUR.sonataIds).toEqual(['windward-pilgrimage', 'flaming-clawprint', 'flamewing-s-shadow']);
    expect(CROWNLESS.sonataIds).toEqual(['havoc-eclipse']);
  });

  it('reads the tag above the grid bar, skipping grid digits and the trash icon', () => {
    const words = [...line('+25 3 1', 870), ...line('Windward Pilgrimage m', 900), ...line('T Sort by Level', 960)];
    expect(readFilterTag(words, sets)).toEqual({ kind: 'set', sonataId: 'windward-pilgrimage', name: 'Windward Pilgrimage', exact: true });
  });

  it('marks a near read as approximate', () => {
    // One letter dropped from 24: distance 1/24. (A 1-for-l swap would be
    // exact: those glyphs are folded, see match.ts.)
    expect(readFilterTag(line('Wishes of Quiet Snowfal', 900), sets)).toEqual({
      kind: 'set',
      sonataId: 'wishes-of-quiet-snowfall',
      name: 'Wishes of Quiet Snowfall',
      exact: false,
    });
  });

  it('tells "no filter set" (grid bar, no tag) from "not in the picture"', () => {
    expect(readFilterTag(line('Sort by Level', 960), sets)).toEqual({ kind: 'none', gridBar: true });
    expect(readFilterTag([...line('+25 +25', 870), ...line('Batch Manage', 960)], sets)).toEqual({ kind: 'none', gridBar: true });
    expect(readFilterTag([], sets)).toEqual({ kind: 'none', gridBar: false });
  });

  it('surfaces wordy text that is no single set name instead of guessing', () => {
    expect(readFilterTag(line('Several Sonatas Selected', 900), sets)).toEqual({ kind: 'unreadable', text: 'Several Sonatas Selected' });
  });
});

describe('resolveSonata', () => {
  const tag = (sonataId: string, exact = true): TagRead => ({
    kind: 'set',
    sonataId,
    name: sets.find((s) => s.id === sonataId)!.name,
    exact,
  });
  const noTag: TagRead = { kind: 'none', gridBar: false };
  const noFilter: TagRead = { kind: 'none', gridBar: true };

  it('takes the in-game filter tag', () => {
    expect(resolveSonata(KERASAUR, tag('windward-pilgrimage'), null, sets)).toEqual({ sonataId: 'windward-pilgrimage', flags: [] });
  });

  it('flags an approximate tag for review', () => {
    expect(resolveSonata(KERASAUR, tag('windward-pilgrimage', false), null, sets)).toEqual({
      sonataId: 'windward-pilgrimage',
      flags: [{ severity: 'review', message: 'in-game filter read approximately as Windward Pilgrimage' }],
    });
  });

  it('errors when the tag names a set the Echo cannot roll', () => {
    expect(resolveSonata(CROWNLESS, tag('windward-pilgrimage'), null, sets).flags).toEqual([
      { severity: 'error', message: 'Crownless cannot roll Windward Pilgrimage (the in-game filter) — it rolls Havoc Eclipse' },
    ]);
  });

  it('errors when the tag and the set picked in the app disagree', () => {
    expect(resolveSonata(KERASAUR, tag('windward-pilgrimage'), 'flaming-clawprint', sets).flags).toEqual([
      { severity: 'error', message: 'The in-game filter shows Windward Pilgrimage, but Flaming Clawprint is picked here' },
    ]);
  });

  it('uses the picked set when the picture holds no tag area, validated against the Echo', () => {
    expect(resolveSonata(KERASAUR, noTag, 'flaming-clawprint', sets)).toEqual({ sonataId: 'flaming-clawprint', flags: [] });
    expect(resolveSonata(CROWNLESS, noTag, 'flaming-clawprint', sets).flags).toEqual([
      {
        severity: 'error',
        message: 'Crownless cannot roll Flaming Clawprint — it rolls Havoc Eclipse. Is the in-game Sonata filter still set?',
      },
    ]);
  });

  it('never applies the picked set when the game shows no filter is set', () => {
    expect(resolveSonata(KERASAUR, noFilter, 'flaming-clawprint', sets)).toEqual({
      sonataId: null,
      flags: [
        {
          severity: 'error',
          message: "No in-game Sonata filter is set, and Kerasaur rolls Windward Pilgrimage / Flaming Clawprint / Flamewing's Shadow — set the filter, or pick the set",
        },
      ],
    });
  });

  it('knows the set of an Echo that rolls only one, filter or not', () => {
    expect(resolveSonata(CROWNLESS, noFilter, null, sets)).toEqual({ sonataId: 'havoc-eclipse', flags: [] });
    expect(resolveSonata(CROWNLESS, noTag, null, sets)).toEqual({ sonataId: 'havoc-eclipse', flags: [] });
  });

  it('asks for the set when nothing decides it', () => {
    expect(resolveSonata(KERASAUR, noTag, null, sets)).toEqual({
      sonataId: null,
      flags: [{ severity: 'error', message: "Sonata set not known: Kerasaur rolls Windward Pilgrimage / Flaming Clawprint / Flamewing's Shadow — pick the set" }],
    });
  });

  it('reviews an unreadable tag, then falls back like no tag', () => {
    expect(resolveSonata(CROWNLESS, { kind: 'unreadable', text: 'Several Sonatas' }, null, sets)).toEqual({
      sonataId: 'havoc-eclipse',
      flags: [{ severity: 'review', message: 'in-game filter "Several Sonatas" not recognized as one Sonata set' }],
    });
  });

  it('leaves the set to the tag or pick when the name was not read', () => {
    expect(resolveSonata(null, tag('trailblazing-star'), null, sets)).toEqual({ sonataId: 'trailblazing-star', flags: [] });
    expect(resolveSonata(null, noTag, null, sets)).toEqual({ sonataId: null, flags: [] });
  });
});
