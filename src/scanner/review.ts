import type { OwnedEcho } from '../data/schema.ts';
import { echoFingerprint, markKnown, toDraft, type ScanDraft } from './draft.ts';
import type { PanelParse, ScanBatch } from './parse.ts';

/**
 * Scanner layer: review-list derivations for a scan session. Pure — the
 * store holds items, this decides what each one means.
 */

export interface ScanItem {
  id: string;
  fileName: string;
  /** Object URL of the panel crop (memory only), null if not made. */
  thumbUrl: string | null;
  /** Batch context at the time the image was added (in-game filter state). */
  batch: ScanBatch;
  status: 'reading' | 'done' | 'failed';
  error?: string;
  parse?: PanelParse;
  /** A manual fix from the Echo form; supersedes the parse entirely. */
  override?: ScanDraft;
  /** Explicit user choice; undefined = default (importable and not owned). */
  include?: boolean;
}

/**
 * - ready:  importable, nothing to look at
 * - review: importable, but flagged reads deserve a glance
 * - fix:    blocked until fixed in the form (error flags / unread fields)
 */
export type RowState = 'reading' | 'failed' | 'ready' | 'review' | 'fix';

export interface ReviewRow {
  item: ScanItem;
  draft: ScanDraft | null;
  state: RowState;
  /** The inventory already holds an identical Echo (multiset match). */
  known: boolean;
  /**
   * Index of an earlier row in this scan with identical rolls, or null.
   * In a video that is almost always the same Echo clicked twice (A -> B
   * -> A); two truly identical tuned Echoes are rare, so a repeat starts
   * unticked and the user can tick it.
   */
  repeatOf: number | null;
  /**
   * Another row has the same rolls but a different "Equipped by". One of
   * them is a misread (seen: a frame where the line was faded), so neither
   * is ticked by default — the user picks the right copy.
   */
  equipConflict: boolean;
  included: boolean;
}

function rowDraft(item: ScanItem): ScanDraft | null {
  if (item.override !== undefined) return item.override;
  return item.parse === undefined ? null : toDraft(item.parse);
}

function rowState(item: ScanItem, draft: ScanDraft | null): RowState {
  if (item.status !== 'done') return item.status;
  if (draft === null) return 'fix';
  if (item.override !== undefined) return 'ready';
  return (item.parse?.flags.length ?? 0) === 0 ? 'ready' : 'review';
}

export function reviewRows(items: readonly ScanItem[], owned: readonly OwnedEcho[]): ReviewRow[] {
  const drafts = items.map(rowDraft);
  const known = markKnown(drafts, owned);
  const fingerprints = drafts.map((d) => (d === null ? null : echoFingerprint(d)));
  const firstSeen = new Map<string, number>();
  const wearers = new Map<string, Set<string | null>>();
  fingerprints.forEach((fp, i) => {
    if (fp === null) return;
    if (!firstSeen.has(fp)) firstSeen.set(fp, i);
    const set = wearers.get(fp) ?? new Set<string | null>();
    set.add(drafts[i]!.equippedTo);
    wearers.set(fp, set);
  });
  return items.map((item, i) => {
    const draft = drafts[i];
    const fp = fingerprints[i];
    const first = fp === null ? undefined : firstSeen.get(fp);
    const repeatOf = first === undefined || first === i ? null : first;
    const equipConflict = fp !== null && (wearers.get(fp)?.size ?? 0) > 1;
    return {
      item,
      draft,
      state: rowState(item, draft),
      known: known[i],
      repeatOf,
      equipConflict,
      included: draft !== null && (item.include ?? (!known[i] && repeatOf === null && !equipConflict)),
    };
  });
}

export interface ScanSummary {
  total: number;
  reading: number;
  ready: number;
  review: number;
  fix: number;
  failed: number;
  known: number;
  repeats: number;
  included: number;
}

export function summarize(rows: readonly ReviewRow[]): ScanSummary {
  const count = (state: RowState): number => rows.filter((r) => r.state === state).length;
  return {
    total: rows.length,
    reading: count('reading'),
    ready: count('ready'),
    review: count('review'),
    fix: count('fix'),
    failed: count('failed'),
    known: rows.filter((r) => r.known).length,
    repeats: rows.filter((r) => r.repeatOf !== null).length,
    included: rows.filter((r) => r.included).length,
  };
}
