import { describe, expect, it } from 'vitest';
import type { OwnedEcho } from '../data/schema.ts';
import type { ScanDraft } from './draft.ts';
import { isUpgradeOf, matchScan, planSync, syncChange, type ScannedEntry, type SyncEntry } from './sync.ts';

/** A +25 Hooscamp; tests vary the Crit Rate roll to make distinct Echoes. */
const scan = (over: Partial<ScanDraft> = {}): ScanDraft => ({
  echoDefId: 'hooscamp',
  sonataId: 'sierra-gale',
  cost: 1,
  level: 25,
  rarity: 5,
  mainStat: { stat: 'atkPct', value: 0.18 },
  secondMainStat: { stat: 'hp', value: 2280 },
  substats: [
    { stat: 'critRate', value: 0.063 },
    { stat: 'critDmg', value: 0.126 },
    { stat: 'atk', value: 40 },
    { stat: 'energyRegen', value: 0.068 },
    { stat: 'hpPct', value: 0.071 },
  ],
  equippedTo: null,
  ...over,
});
const own = (id: string, over: Partial<ScanDraft> = {}): OwnedEcho => ({ ...scan(over), id, origin: 'manual' });
const known = (draft: ScanDraft): ScannedEntry => ({ draft, wearerKnown: true });
/** A +10 copy of `scan()` before its last 3 substats were tuned. */
const early = { level: 10, mainStat: { stat: 'atkPct' as const, value: 0.081 }, substats: scan().substats.slice(0, 2) };
/** Distinct +25 Echoes: Crit Rate 6.3%, 6.9%, 7.5%… */
const nth = (n: number, over: Partial<ScanDraft> = {}): ScanDraft =>
  scan({ substats: [{ stat: 'critRate', value: 0.063 + 0.006 * n }, ...scan().substats.slice(1)], ...over });

describe('isUpgradeOf', () => {
  it('accepts a lower-level copy whose substats are all among the scanned ones', () => {
    expect(isUpgradeOf(own('a', early), scan())).toBe(true);
    expect(isUpgradeOf(own('a', { ...early, substats: [] }), scan())).toBe(true);
  });

  it('rejects anything a levelled Echo cannot become', () => {
    expect(isUpgradeOf(own('a'), scan())).toBe(false); // same level: same Echo or another one
    expect(isUpgradeOf(own('a', { ...early, substats: [{ stat: 'critRate', value: 0.069 }] }), scan())).toBe(false);
    expect(isUpgradeOf(own('a', { ...early, mainStat: { stat: 'hpPct', value: 0.081 } }), scan())).toBe(false);
    expect(isUpgradeOf(own('a', { ...early, mainStat: { stat: 'atkPct', value: 0.2 } }), scan())).toBe(false);
    expect(isUpgradeOf(own('a', { ...early, sonataId: 'void-thunder' }), scan())).toBe(false);
    expect(isUpgradeOf(own('a', { ...early, rarity: 4 }), scan())).toBe(false);
  });
});

describe('matchScan', () => {
  it('pairs identical rolls as a multiset, preferring the copy on the same character', () => {
    const owned = [own('on-a', { equippedTo: 'a' }), own('bag')];
    expect(matchScan([known(scan())], owned)).toEqual([{ kind: 'same', ownedId: 'bag' }]);
    expect(matchScan([known(scan({ equippedTo: 'a' }))], owned)).toEqual([{ kind: 'same', ownedId: 'on-a' }]);
    // Moved to someone else in game: still the same Echo (the first free copy).
    expect(matchScan([known(scan({ equippedTo: 'b' }))], owned)).toEqual([{ kind: 'same', ownedId: 'on-a' }]);
    // Two scanned, one owned: the second is new (and a repeat in review).
    expect(matchScan([known(scan()), known(scan()), null], [own('x')])).toEqual([
      { kind: 'same', ownedId: 'x' },
      { kind: 'new', upgradeCandidates: 0 },
      null,
    ]);
  });

  it('does not use an unpicked wearer (Rover) to choose between copies', () => {
    const owned = [own('on-a', { equippedTo: 'a' }), own('bag')];
    expect(matchScan([{ draft: scan(), wearerKnown: false }], owned)).toEqual([{ kind: 'same', ownedId: 'on-a' }]);
  });

  it('pairs a levelled-up Echo with its one possible owned row', () => {
    expect(matchScan([known(scan({ equippedTo: 'a' }))], [own('old', early), own('other', nth(3))])).toEqual([
      { kind: 'upgrade', ownedId: 'old' },
    ]);
  });

  it('never guesses between different possible originals', () => {
    const owned = [own('plus5', { ...early, level: 5, substats: early.substats.slice(0, 1) }), own('plus10', early)];
    expect(matchScan([known(scan())], owned)).toEqual([{ kind: 'new', upgradeCandidates: 2 }]);
  });

  it('never guesses when two scanned Echoes claim one original', () => {
    const blank = { ...early, level: 0, mainStat: { stat: 'atkPct' as const, value: 0.036 }, substats: [] };
    expect(matchScan([known(nth(0)), known(nth(1))], [own('raw', blank)])).toEqual([
      { kind: 'new', upgradeCandidates: 1 },
      { kind: 'new', upgradeCandidates: 1 },
    ]);
    // With two identical originals there is one for each.
    expect(matchScan([known(nth(0)), known(nth(1))], [own('raw1', blank), own('raw2', blank)])).toEqual([
      { kind: 'upgrade', ownedId: 'raw1' },
      { kind: 'upgrade', ownedId: 'raw2' },
    ]);
  });

  it('lets a repeat (clicked twice) claim once: the first sighting upgrades, the repeat is plain new', () => {
    expect(matchScan([known(scan()), known(scan())], [own('old', early)])).toEqual([
      { kind: 'upgrade', ownedId: 'old' },
      { kind: 'new', upgradeCandidates: 0 },
    ]);
  });
});

describe('syncChange', () => {
  it('updates a known Echo only when the scan reads a different wearer', () => {
    const owned = own('x', { equippedTo: 'a' });
    const same = { kind: 'same', ownedId: 'x' } as const;
    expect(syncChange(same, scan({ equippedTo: 'a' }), true, owned)).toBe('none');
    expect(syncChange(same, scan({ equippedTo: 'b' }), true, owned)).toBe('update');
    expect(syncChange(same, scan(), true, owned)).toBe('update'); // unequipped in game
    expect(syncChange(same, scan(), false, owned)).toBe('none'); // Rover not picked yet
    expect(syncChange({ kind: 'upgrade', ownedId: 'x' }, scan(), true, owned)).toBe('update');
    expect(syncChange({ kind: 'new', upgradeCandidates: 0 }, scan(), true, undefined)).toBe('add');
  });
});

/** Review-like entries: matched, every change ticked unless listed in `skip`. */
function entries(scanned: readonly ScannedEntry[], owned: readonly OwnedEcho[], skip: readonly number[] = []): SyncEntry[] {
  const byId = new Map(owned.map((e) => [e.id, e]));
  return matchScan(scanned, owned).map((match, i) => {
    const change = syncChange(match!, scanned[i].draft, scanned[i].wearerKnown, match!.kind === 'new' ? undefined : byId.get(match!.ownedId));
    return { draft: scanned[i].draft, match, change, included: change !== 'none' && !skip.includes(i), wearerKnown: scanned[i].wearerKnown };
  });
}

describe('planSync', () => {
  it('adds new Echoes, updates upgraded and re-equipped ones, and skips unticked rows', () => {
    const owned = [own('old', { ...early, equippedTo: 'a', label: 'keeper' }), own('moved', nth(2, { equippedTo: 'a' })), own('kept', nth(3))];
    const scanned = [
      known(scan({ equippedTo: 'b' })), // upgrade of old, now on b
      known(nth(2, { equippedTo: 'b' })), // moved from a to b
      known(nth(3)), // unchanged
      known(nth(4)), // new
      known(nth(5)), // new, unticked
    ];
    const { plan, notSeen, bagged, overfull } = planSync(entries(scanned, owned, [4]), owned, new Set());
    expect(plan).toEqual({
      add: [nth(4)],
      upgrade: [{ id: 'old', draft: scan({ equippedTo: 'b' }) }],
      equip: [{ id: 'moved', equippedTo: 'b' }],
      remove: [],
    });
    expect([notSeen, bagged, overfull]).toEqual([[], [], []]);
  });

  it("keeps the app's wearer on an upgrade whose wearer was not picked", () => {
    const owned = [own('old', { ...early, equippedTo: 'rover-havoc' })];
    const { plan } = planSync(entries([{ draft: scan(), wearerKnown: false }], owned), owned, new Set());
    expect(plan.upgrade).toEqual([{ id: 'old', draft: scan({ equippedTo: 'rover-havoc' }) }]);
    expect(plan.equip).toEqual([]);
  });

  it('lists unmatched Echoes of the scanned sets and rarities, and deletes only ticked, unlocked ones', () => {
    const owned = [
      own('seen', nth(0)),
      own('gone', nth(1)),
      own('locked', { ...nth(2), locked: true }),
      own('other-set', nth(3, { sonataId: 'void-thunder' })),
      own('four-star', nth(4, { rarity: 4 })),
    ];
    const { plan, notSeen } = planSync(entries([known(nth(0))], owned), owned, new Set(['gone', 'locked', 'other-set']));
    expect(notSeen.map((e) => e.id)).toEqual(['gone', 'locked']);
    expect(plan.remove).toEqual(['gone']);
  });

  it('sends an Echo back to the bag when the scan shows its character wearing 5 others', () => {
    const owned = [
      ...[0, 1, 2, 3].map((n) => own(`worn${n}`, nth(n, { equippedTo: 'a' }))),
      own('stale', nth(9, { sonataId: 'void-thunder', equippedTo: 'a' })),
      own('elsewhere', nth(8, { sonataId: 'void-thunder', equippedTo: 'b' })),
    ];
    // In game, a now wears worn0-3 plus a new one; "stale" (another set, so not scanned) came off.
    const scanned = [0, 1, 2, 3, 4].map((n) => known(nth(n, { equippedTo: 'a' })));
    const { plan, notSeen, bagged } = planSync(entries(scanned, owned), owned, new Set());
    expect(bagged).toEqual([{ id: 'stale', from: 'a' }]);
    expect(plan.equip).toEqual([{ id: 'stale', equippedTo: null }]);
    expect(notSeen.map((e) => e.id)).toEqual(['stale']);
    // Ticked for deletion instead: deleted, not unequipped.
    const deleting = planSync(entries(scanned, owned), owned, new Set(['stale']));
    expect([deleting.plan.remove, deleting.plan.equip, deleting.bagged]).toEqual([['stale'], [], []]);
    // Four seen on a: the fifth may simply not have been scanned, so nothing moves.
    expect(planSync(entries(scanned.slice(0, 4), owned), owned, new Set()).bagged).toEqual([]);
    // An unticked row is not counted as seen on a.
    expect(planSync(entries(scanned, owned, [4]), owned, new Set()).bagged).toEqual([]);
  });

  it('flags more than 5 Echoes on one character and then unequips nothing for them', () => {
    const owned = [own('stale', nth(9, { sonataId: 'void-thunder', equippedTo: 'a' }))];
    const scanned = [0, 1, 2, 3, 4, 5].map((n) => known(nth(n, { equippedTo: 'a' })));
    const { overfull, bagged } = planSync(entries(scanned, owned), owned, new Set());
    expect(overfull).toEqual([{ characterId: 'a', count: 6 }]);
    expect(bagged).toEqual([]);
  });
});
