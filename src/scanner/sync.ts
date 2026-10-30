import type { OwnedEcho } from '../data/schema.ts';
import { echoFingerprint, type ScanDraft } from './draft.ts';

/**
 * Scanner layer: what a scan means for the inventory it lands in — a
 * rescan keeps existing rows (builds point at their ids) instead of adding
 * copies. Pure.
 *
 * Each scanned Echo pairs with at most one owned row:
 *   - `same`: identical rolls (`echoFingerprint`), preferring a row the app
 *     records on the same character;
 *   - `upgrade`: the owned row levelled up — same def, set, rarity and main
 *     stat, a lower level, and its substats all among the scanned ones.
 *     Paired only when certain: one group of identical owned candidates,
 *     with a copy for every distinct scanned Echo that claims it;
 *   - `new`: anything else.
 * The scan wins over the app's "Equipped by" (user decision 2026-10-23),
 * except where the scan could not tell (an unpicked Rover).
 */

export type SyncMatch =
  /**
   * Not in the inventory. `upgradeCandidates` > 0: it could be an upgrade of
   * that many owned Echoes, but not certainly one of them, so none is assumed.
   */
  | { kind: 'new'; upgradeCandidates: number }
  /** The inventory holds this Echo (same rolls). */
  | { kind: 'same'; ownedId: string }
  /** A levelled-up copy of an owned Echo, updated in place. */
  | { kind: 'upgrade'; ownedId: string };

export interface ScannedEntry {
  draft: ScanDraft;
  /**
   * False while "Equipped by" names several characters and none is picked
   * (Rover): the draft's `equippedTo: null` is then not a reading.
   */
  wearerKnown: boolean;
}

const subKey = (s: { stat: string; value: number }): string => `${s.stat}=${s.value.toFixed(4)}`;

/** Could `scanned` be `owned` after levelling (substats are fixed once rolled, main stats grow)? */
export function isUpgradeOf(owned: OwnedEcho, scanned: ScanDraft): boolean {
  if (owned.echoDefId !== scanned.echoDefId || owned.sonataId !== scanned.sonataId || owned.rarity !== scanned.rarity) return false;
  if (owned.mainStat.stat !== scanned.mainStat.stat || owned.level >= scanned.level) return false;
  if (owned.mainStat.value > scanned.mainStat.value + 1e-9) return false;
  const rolled = new Set(scanned.substats.map(subKey));
  return owned.substats.every((s) => rolled.has(subKey(s)));
}

const wearer = (e: OwnedEcho): string | null => e.equippedTo ?? null;

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = groups.get(k);
    if (list === undefined) groups.set(k, [item]);
    else list.push(item);
  }
  return groups;
}

/** Pair scanned Echoes (null = no draft yet) with owned rows; one result per entry. */
export function matchScan(scanned: readonly (ScannedEntry | null)[], owned: readonly OwnedEcho[]): (SyncMatch | null)[] {
  const result: (SyncMatch | null)[] = scanned.map(() => null);
  const free = new Set(owned.map((e) => e.id));
  const take = (list: readonly OwnedEcho[] | undefined, ok: (e: OwnedEcho) => boolean): OwnedEcho | undefined => {
    const hit = list?.find((e) => free.has(e.id) && ok(e));
    if (hit !== undefined) free.delete(hit.id);
    return hit;
  };

  // Identical rolls: first with the same wearer, so of two identical copies
  // the one the app records on that character is the one the scan saw.
  const byRolls = groupBy(owned, echoFingerprint);
  const fps = scanned.map((e) => (e === null ? null : echoFingerprint(e.draft)));
  scanned.forEach((e, i) => {
    if (e === null || !e.wearerKnown) return;
    const hit = take(byRolls.get(fps[i]!), (o) => wearer(o) === e.draft.equippedTo);
    if (hit !== undefined) result[i] = { kind: 'same', ownedId: hit.id };
  });
  scanned.forEach((e, i) => {
    if (e === null || result[i] !== null) return;
    const hit = take(byRolls.get(fps[i]!), () => true);
    if (hit !== undefined) result[i] = { kind: 'same', ownedId: hit.id };
  });

  // Upgrades, by group of identical owned rows. A group is claimed by every
  // distinct scanned Echo that could come from it (a repeat — the same
  // Echo clicked twice — claims once).
  const groups = groupBy(
    owned.filter((e) => free.has(e.id)),
    echoFingerprint,
  );
  const candidates = scanned.map((e, i) =>
    e === null || result[i] !== null ? [] : [...groups.keys()].filter((k) => isUpgradeOf(groups.get(k)![0], e.draft)),
  );
  const claimants = new Map<string, Set<string>>();
  candidates.forEach((ks, i) => {
    for (const k of ks) claimants.set(k, (claimants.get(k) ?? new Set()).add(fps[i]!));
  });
  scanned.forEach((e, i) => {
    if (e === null || result[i] !== null) return;
    const ks = candidates[i];
    const group = ks.length === 1 ? groups.get(ks[0])! : null;
    if (group !== null && claimants.get(ks[0])!.size <= group.length) {
      const hit = take(group, (o) => e.wearerKnown && wearer(o) === e.draft.equippedTo) ?? take(group, () => true);
      if (hit !== undefined) {
        result[i] = { kind: 'upgrade', ownedId: hit.id };
        return;
      }
    }
    // Copies a repeat's first sighting already took are no candidates.
    const left = ks.reduce((n, k) => n + groups.get(k)!.filter((o) => free.has(o.id)).length, 0);
    result[i] = { kind: 'new', upgradeCandidates: left };
  });
  return result;
}

/** What applying a row would do to the inventory. */
export type SyncChange = 'add' | 'update' | 'none';

export function syncChange(match: SyncMatch, draft: ScanDraft, wearerKnown: boolean, owned: OwnedEcho | undefined): SyncChange {
  if (match.kind === 'new') return 'add';
  if (match.kind === 'upgrade') return 'update';
  return wearerKnown && owned !== undefined && wearer(owned) !== draft.equippedTo ? 'update' : 'none';
}

/** One review row, as far as syncing is concerned (`ReviewRow` fits). */
export interface SyncEntry {
  draft: ScanDraft | null;
  match: SyncMatch | null;
  change: SyncChange | null;
  included: boolean;
  wearerKnown: boolean;
}

/** Everything a sync writes; `applyScan` runs it in one transaction. */
export interface SyncPlan {
  add: ScanDraft[];
  /** Scanned fields replace the row's; it keeps its id, origin, label and lock. */
  upgrade: { id: string; draft: ScanDraft }[];
  /** "Equipped by" changes on rows otherwise left as they are. */
  equip: { id: string; equippedTo: string | null }[];
  remove: string[];
}

export interface SyncPreview {
  plan: SyncPlan;
  /**
   * Owned Echoes no scanned row matched, of a Sonata set and rarity the scan
   * covered (plus any the plan unequips). Deleting one is the user's choice.
   */
  notSeen: OwnedEcho[];
  /** Owned Echoes going back to the bag: their character wears 5 scanned Echoes. */
  bagged: { id: string; from: string }[];
  /** Characters the scan puts on more than 5 Echoes (a misread): none of theirs is unequipped. */
  overfull: { characterId: string; count: number }[];
}

/** A character wears at most 5 Echoes. */
const SLOTS = 5;

const scopeKey = (e: { sonataId: string; rarity: number }): string => `${e.sonataId}|${e.rarity}`;

/**
 * The writes for the ticked rows. `remove` = owned ids the user ticked
 * for deletion; only unlocked "not seen" rows are deleted.
 *
 * When the scan shows exactly 5 Echoes on a character, that is all they
 * wear, so any other owned row recorded on them goes back to the bag. With
 * more than 5 (a misread), nothing is unequipped for that character.
 */
export function planSync(entries: readonly SyncEntry[], owned: readonly OwnedEcho[], remove: ReadonlySet<string>): SyncPreview {
  const byId = new Map(owned.map((e) => [e.id, e]));
  const plan: SyncPlan = { add: [], upgrade: [], equip: [], remove: [] };
  const matched = new Set<string>();
  const scope = new Set<string>();
  const worn = new Map<string, number>();

  for (const e of entries) {
    if (e.draft === null || e.match === null || e.change === null) continue;
    scope.add(scopeKey(e.draft));
    if (e.match.kind !== 'new') matched.add(e.match.ownedId);
    if (e.change !== 'none' && !e.included) continue;
    if (e.wearerKnown && e.draft.equippedTo !== null) worn.set(e.draft.equippedTo, (worn.get(e.draft.equippedTo) ?? 0) + 1);
    if (e.change === 'none') continue;
    if (e.match.kind === 'new') plan.add.push(e.draft);
    else if (e.match.kind === 'upgrade') {
      const was = byId.get(e.match.ownedId);
      plan.upgrade.push({
        id: e.match.ownedId,
        draft: e.wearerKnown ? e.draft : { ...e.draft, equippedTo: was === undefined ? null : wearer(was) },
      });
    } else plan.equip.push({ id: e.match.ownedId, equippedTo: e.draft.equippedTo });
  }

  const full = new Set([...worn].filter(([, n]) => n === SLOTS).map(([id]) => id));
  const overfull = [...worn].filter(([, n]) => n > SLOTS).map(([characterId, count]) => ({ characterId, count }));
  const unmatched = owned.filter((e) => !matched.has(e.id));
  const offFull = unmatched.filter((e) => e.equippedTo != null && full.has(e.equippedTo));
  const offFullIds = new Set(offFull.map((e) => e.id));
  const notSeen = unmatched.filter((e) => scope.has(scopeKey(e)) || offFullIds.has(e.id));
  plan.remove = notSeen.filter((e) => remove.has(e.id) && e.locked !== true).map((e) => e.id);
  const removed = new Set(plan.remove);
  const bagged = offFull.filter((e) => !removed.has(e.id)).map((e) => ({ id: e.id, from: e.equippedTo! }));
  plan.equip.push(...bagged.map((b) => ({ id: b.id, equippedTo: null })));
  return { plan, notSeen, bagged, overfull };
}
