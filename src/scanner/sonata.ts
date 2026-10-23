import type { EchoDefData, SonataSetData } from '../data/schema.ts';
import { canonical, matchVocab } from './match.ts';
import { groupRows, type OcrWord } from './parse.ts';

/**
 * Scanner layer: which Sonata set a scanned Echo belongs to. Pure.
 *
 * The detail panel shows the set only as a small icon, and the app holds
 * no reference icons (game art is never bundled), so the icon is not used.
 * The set comes from, in order:
 *   1. the in-game Sonata filter's tag — the dark chip above the Filter
 *      button, bottom-left of the grid ("Windward Pilgrimage"), read by its
 *      own OCR pass (`filterTagRect`);
 *   2. when the tag area shows the grid's bottom bar ("Sort by …") but no
 *      tag, no filter is set: only an Echo that can roll exactly one set is
 *      certain, and the set picked in the app is NOT applied (it would
 *      silently mislabel an unfiltered Echo that can also roll it);
 *   3. when the frame shows neither (a region capture of the panel), the
 *      set picked in the app, validated against the Echo;
 *   4. an Echo that can roll exactly one set.
 * Anything else is an error the user resolves in the form.
 */

export type TagRead =
  /** A Sonata name was read off the tag. */
  | { kind: 'set'; sonataId: string; name: string; exact: boolean }
  /** Text sits where the tag goes, but it is not one Sonata name. */
  | { kind: 'unreadable'; text: string }
  /** No tag; `gridBar` = the grid's bottom bar is visible, so no filter is set. */
  | { kind: 'none'; gridBar: boolean };

const GRID_BAR_RE = /\bsort\s*by\b|\bbatch\s*manage\b/;

/**
 * Read the filter tag from the tag pass's words. A row matches when one
 * contiguous span of it is a Sonata name; the bar under the tag ("Sort by
 * Level", "Batch Manage") and grid-cell digits never are.
 */
export function readFilterTag(words: readonly OcrWord[], sets: readonly SonataSetData[]): TagRead {
  const vocab = sets.map((s) => ({ text: s.name, value: s }));
  const rows = groupRows(words);
  let gridBar = false;
  let leftover: string | null = null;
  for (const row of rows) {
    const text = canonical(row.text);
    if (GRID_BAR_RE.test(text)) {
      gridBar = true;
      continue;
    }
    const texts = row.words.map((w) => w.text);
    let best: { set: SonataSetData; exact: boolean; distance: number } | null = null;
    for (let i = 0; i < texts.length; i++) {
      for (let j = i + 1; j <= texts.length; j++) {
        const m = matchVocab(texts.slice(i, j).join(' '), vocab, { maxDistance: 0.2, minMargin: 0.08 });
        if (m.kind === 'exact') return { kind: 'set', sonataId: m.value.id, name: m.value.name, exact: true };
        if (m.kind === 'fuzzy' && (best === null || m.distance < best.distance)) best = { set: m.value, exact: false, distance: m.distance };
      }
    }
    if (best !== null) return { kind: 'set', sonataId: best.set.id, name: best.set.name, exact: false };
    // Long wordy text in the tag area that is no set name (a truncated or
    // multi-set tag): surfaced, never guessed.
    if (/[a-z]{4,}.*[a-z]{4,}/.test(text) && leftover === null) leftover = row.text;
  }
  return leftover !== null ? { kind: 'unreadable', text: leftover } : { kind: 'none', gridBar };
}

export interface SonataDecision {
  sonataId: string | null;
  flags: { severity: 'review' | 'error'; message: string }[];
}

function setName(sets: readonly SonataSetData[], id: string): string {
  return sets.find((s) => s.id === id)?.name ?? id;
}

function rolls(def: EchoDefData, sets: readonly SonataSetData[]): string {
  return def.sonataIds.map((id) => setName(sets, id)).join(' / ');
}

/**
 * Decide the set of one scanned Echo. `picked` is the set chosen in the
 * app (null = read it from the game). `def` is null when the name was not
 * read (that already blocks the row).
 */
export function resolveSonata(
  def: EchoDefData | null,
  tag: TagRead,
  picked: string | null,
  sets: readonly SonataSetData[],
): SonataDecision {
  const flags: SonataDecision['flags'] = [];
  const only = def !== null && def.sonataIds.length === 1 ? def.sonataIds[0] : null;

  if (tag.kind === 'set') {
    if (picked !== null && picked !== tag.sonataId) {
      flags.push({
        severity: 'error',
        message: `The in-game filter shows ${tag.name}, but ${setName(sets, picked)} is picked here`,
      });
    }
    if (def !== null && !def.sonataIds.includes(tag.sonataId)) {
      flags.push({ severity: 'error', message: `${def.name} cannot roll ${tag.name} (the in-game filter) — it rolls ${rolls(def, sets)}` });
    }
    if (!tag.exact) flags.push({ severity: 'review', message: `in-game filter read approximately as ${tag.name}` });
    return { sonataId: tag.sonataId, flags };
  }

  if (tag.kind === 'unreadable') {
    flags.push({ severity: 'review', message: `in-game filter "${tag.text}" not recognized as one Sonata set` });
  }

  // No filter set in game: the app's pick would be a guess for this Echo.
  const noFilter = tag.kind === 'none' && tag.gridBar;
  if (picked !== null && !noFilter) {
    if (def !== null && !def.sonataIds.includes(picked)) {
      flags.push({
        severity: 'error',
        message: `${def.name} cannot roll ${setName(sets, picked)} — it rolls ${rolls(def, sets)}. Is the in-game Sonata filter still set?`,
      });
    }
    return { sonataId: picked, flags };
  }
  if (only !== null) return { sonataId: only, flags };
  if (def !== null) {
    flags.push({
      severity: 'error',
      message: noFilter
        ? `No in-game Sonata filter is set, and ${def.name} rolls ${rolls(def, sets)} — set the filter, or pick the set`
        : `Sonata set not known: ${def.name} rolls ${rolls(def, sets)} — pick the set`,
    });
  }
  return { sonataId: null, flags };
}
