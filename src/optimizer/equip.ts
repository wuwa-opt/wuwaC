import type { OwnedEcho } from '../data/schema.ts';
import type { AllocationResult } from './allocate.ts';

/**
 * Optimizer layer: what "Mark as equipped" would change in the Echo record
 * for a team allocation.
 *
 * `OwnedEcho.equippedTo` mirrors the game, which the app cannot change, so
 * this only describes a record update for a re-gear the user does (or has
 * done) in the game. Pure: no store, no Dexie.
 *
 * - A member with a result gets its allocated Echoes (`equippedTo` = member).
 * - Echoes recorded on that member that are not in its new set go back to
 *   the bag (`null`), as in the game.
 * - An allocated Echo worn by someone else, in or outside the team, moves;
 *   that character loses it. Assignment beats unequip when both apply (a
 *   swap inside the team).
 * - A member without a result is untouched. Locks don't matter.
 */

export interface EquipChange {
  id: string;
  equippedTo: string | null;
}

export interface EquipCount {
  characterId: string;
  count: number;
}

export interface EquipPlan {
  /** Only rows whose `equippedTo` actually changes, in member order. */
  changes: EquipChange[];
  /** Echoes that gain a new owner, per receiving member. */
  assigned: EquipCount[];
  /** Assigned Echoes that were recorded on another character, per previous owner. */
  takenFrom: EquipCount[];
  /** Echoes going back to the bag. */
  unequipped: number;
  /** Allocated Echoes already recorded on their member (no change). */
  unchanged: number;
  /** Identity of `changes`, for telling a confirm step apart from fresh state. */
  signature: string;
}

function bump(counts: Map<string, number>, characterId: string): void {
  counts.set(characterId, (counts.get(characterId) ?? 0) + 1);
}

function toCounts(counts: Map<string, number>): EquipCount[] {
  return [...counts].map(([characterId, count]) => ({ characterId, count }));
}

export function planEquip(allocation: AllocationResult, echoes: readonly OwnedEcho[]): EquipPlan {
  const byId = new Map(echoes.map((e) => [e.id, e]));
  const current = (echo: OwnedEcho): string | null => echo.equippedTo ?? null;

  // Final owner of every Echo the allocation touches.
  const target = new Map<string, string | null>();
  const allocated = new Map<string, string>();
  for (const m of allocation.members) {
    if (m.best === null) continue;
    for (const id of m.best.echoIds) if (byId.has(id)) allocated.set(id, m.characterId);
  }
  for (const m of allocation.members) {
    if (m.best === null) continue;
    for (const echo of echoes) {
      if (current(echo) === m.characterId && !allocated.has(echo.id)) target.set(echo.id, null);
    }
  }
  for (const [id, characterId] of allocated) target.set(id, characterId);

  const assigned = new Map<string, number>();
  const takenFrom = new Map<string, number>();
  const changes: EquipChange[] = [];
  let unequipped = 0;
  let unchanged = 0;
  const order = new Map(allocation.members.map((m, i) => [m.characterId, i]));
  const ids = [...target.keys()].sort((a, b) => {
    const rank = (id: string): number => order.get(allocated.get(id) ?? '') ?? allocation.members.length;
    return rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0);
  });
  for (const id of ids) {
    const echo = byId.get(id)!;
    const to = target.get(id) ?? null;
    const from = current(echo);
    if (from === to) {
      unchanged += 1;
      continue;
    }
    changes.push({ id, equippedTo: to });
    if (to === null) {
      unequipped += 1;
      continue;
    }
    bump(assigned, to);
    if (from !== null) bump(takenFrom, from);
  }

  return {
    changes,
    assigned: toCounts(assigned),
    takenFrom: toCounts(takenFrom),
    unequipped,
    unchanged,
    signature: JSON.stringify(changes),
  };
}
