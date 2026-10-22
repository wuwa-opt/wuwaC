/**
 * Scanner layer: fuzzy matching of OCR text against closed vocabularies
 * (Echo names, stat labels, character names). Pure string functions — no
 * DOM, no game math.
 *
 * OCR noise is mostly character-level (dropped punctuation, `l`/`I`/`1`
 * swaps, stray icon glyphs), so matching is a normalized Levenshtein
 * distance over a canonical form (lowercase, alphanumerics + single
 * spaces). A match is only accepted when it is close enough AND clearly
 * better than the runner-up — an ambiguous read is reported as such,
 * never resolved by guessing.
 */

/** Lowercase, punctuation -> space, collapse whitespace. "Crit. DMG" -> "crit dmg". */
export function canonical(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Classic Levenshtein edit distance (insert/delete/substitute = 1). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** Edit distance divided by the longer length: 0 = identical, 1 = nothing shared. */
export function normalizedDistance(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  return longest === 0 ? 0 : levenshtein(a, b) / longest;
}

export interface VocabEntry<T> {
  /** Display text as the game renders it, e.g. "Crit. DMG". */
  text: string;
  value: T;
}

export type MatchResult<T> =
  | { kind: 'exact'; value: T; text: string }
  | { kind: 'fuzzy'; value: T; text: string; distance: number }
  | { kind: 'ambiguous'; candidates: { value: T; text: string; distance: number }[] }
  | { kind: 'none' };

export interface MatchOptions {
  /** Max normalized distance accepted as a fuzzy match. */
  maxDistance: number;
  /** Min gap between the best and runner-up distance for a fuzzy match to stand. */
  minMargin: number;
}

const DEFAULT_MATCH: MatchOptions = { maxDistance: 0.25, minMargin: 0.1 };

/**
 * Match `text` against `vocab`. Exact = canonical forms equal. Several
 * vocab entries may share one value (e.g. two spellings) — they count as
 * one candidate, so synonyms never make a read look ambiguous.
 */
/**
 * Fold the glyphs this game font renders (near-)identically, so OCR can't
 * tell them apart: capital I, lowercase l and digit 1 (after lowercasing:
 * i/l/1), and O/0. "luno" for "Iuno" is the real case (2026-10-22 video).
 */
export function foldConfusables(canonicalText: string): string {
  return canonicalText.replace(/[l1|]/g, 'i').replace(/0/g, 'o');
}

/**
 * Match `text` against `vocab`. Exact = canonical forms equal, or equal
 * after `foldConfusables` when that identifies exactly ONE vocab value
 * (a glyph the font draws identically is not evidence of anything).
 * Several vocab entries may share one value (e.g. two spellings) — they
 * count as one candidate, so synonyms never make a read look ambiguous.
 */
export function matchVocab<T>(
  text: string,
  vocab: readonly VocabEntry<T>[],
  options: Partial<MatchOptions> = {},
): MatchResult<T> {
  const { maxDistance, minMargin } = { ...DEFAULT_MATCH, ...options };
  const needle = canonical(text);
  if (needle.length === 0) return { kind: 'none' };
  const folded = foldConfusables(needle);
  const best = new Map<T, { value: T; text: string; distance: number }>();
  const foldedHits = new Map<T, string>();
  for (const entry of vocab) {
    const target = canonical(entry.text);
    if (target === needle) return { kind: 'exact', value: entry.value, text: entry.text };
    const foldedTarget = foldConfusables(target);
    if (foldedTarget === folded) foldedHits.set(entry.value, entry.text);
    const distance = normalizedDistance(folded, foldedTarget);
    const seen = best.get(entry.value);
    if (seen === undefined || distance < seen.distance) {
      best.set(entry.value, { value: entry.value, text: entry.text, distance });
    }
  }
  if (foldedHits.size === 1) {
    const [[value, hitText]] = [...foldedHits];
    return { kind: 'exact', value, text: hitText };
  }
  const ranked = [...best.values()].sort((x, y) => x.distance - y.distance);
  const [first, second] = ranked;
  if (first === undefined || first.distance > maxDistance) return { kind: 'none' };
  if (second !== undefined && second.distance - first.distance < minMargin) {
    return {
      kind: 'ambiguous',
      candidates: ranked.filter((c) => c.distance - first.distance < minMargin),
    };
  }
  return { kind: 'fuzzy', value: first.value, text: first.text, distance: first.distance };
}
