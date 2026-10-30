import { create } from 'zustand';
import { findEchoDef } from '../data/index.ts';
import { ownedEchoSchema, type EchoDefData, type OwnedEcho } from '../data/schema.ts';
import type { ScanDraft } from '../scanner/draft.ts';
import type { SyncPlan } from '../scanner/sync.ts';
import { db } from './db.ts';
import { useSnapshotStore } from './snapshotStore.ts';

/**
 * Form input for one Echo. The store derives identity: `id` is generated
 * and `origin` is always manual here. `echoDefId` must be a real synced
 * definition — the form picks it, never the label (Phase 3 decision:
 * legacy slugified rows are force re-linked on next edit).
 *
 * `equippedTo` is optional: a new row starts unequipped (importers may set
 * it), and an edit that omits it keeps the stored value. The Echo form
 * never submits it — it records the game's gear, which the form doesn't own.
 */
export type EchoDraft = Omit<OwnedEcho, 'id' | 'origin' | 'equippedTo'> & {
  label?: string;
  equippedTo?: string | null;
};

/**
 * What the Echo form owns: every field a user edits. A submit REPLACES these
 * (so clearing the nickname or the second main stat works), while the store
 * keeps the fields the form never shows: `id`, `origin`, `equippedTo`, `locked`.
 */
export type EchoFormDraft = Omit<EchoDraft, 'equippedTo' | 'locked'>;

/**
 * An edit's substats, with each one's stored `rolls` carried over when it is
 * the same roll: same stat, and a value equal up to float noise (the form
 * round-trips values through display text, which can move the last digit).
 * A changed value or a new stat gets none, since the roll count no longer
 * describes it. A `rolls` the caller submits itself is kept as given.
 */
function keepRolls(submitted: OwnedEcho['substats'], stored: OwnedEcho['substats']): OwnedEcho['substats'] {
  return submitted.map((sub) => {
    if (sub.rolls !== undefined) return sub;
    const before = stored.find((s) => s.stat === sub.stat);
    if (before?.rolls === undefined || Math.abs(before.value - sub.value) > 1e-9) return sub;
    return { ...sub, rolls: before.rolls };
  });
}

/** Row-level def problems. `orphan` = unknown def; the rest = known-def mismatch. */
export interface EchoDefIssue {
  kind: 'orphan' | 'cost' | 'sonata' | 'mainStat';
  message: string;
}

/** Check a row against its echo def. Empty = consistent. Tolerant reads use this; writes reject. */
export function echoDefIssues(echo: Pick<OwnedEcho, 'echoDefId' | 'sonataId' | 'cost' | 'mainStat'>, defs: readonly EchoDefData[] = useSnapshotStore.getState().snapshot.echoDefs): EchoDefIssue[] {
  const def = defs.find((d) => d.id === echo.echoDefId);
  if (!def) {
    return [{ kind: 'orphan', message: `No echo definition matches ${JSON.stringify(echo.echoDefId)} — pick the real Echo to re-link.` }];
  }
  const issues: EchoDefIssue[] = [];
  if (echo.cost !== def.cost) {
    issues.push({ kind: 'cost', message: `${def.name} is a ${def.cost}-cost Echo, not ${echo.cost} — fix on edit.` });
  }
  if (!def.sonataIds.includes(echo.sonataId)) {
    issues.push({ kind: 'sonata', message: `${def.name} cannot roll ${JSON.stringify(echo.sonataId)} — fix on edit.` });
  }
  if (!def.allowedMainStats.includes(echo.mainStat.stat)) {
    issues.push({ kind: 'mainStat', message: `${def.name} cannot roll ${echo.mainStat.stat} as a main stat — fix on edit.` });
  }
  return issues;
}

/** Strict write path: drafts must be fully def-consistent with the ACTIVE snapshot (an adopted newer publication counts). */
function assertDefConsistent(draft: EchoDraft): void {
  const def = findEchoDef(useSnapshotStore.getState().snapshot, draft.echoDefId);
  if (!def) {
    throw new Error(`unknown echo definition: ${JSON.stringify(draft.echoDefId)} — pick the Echo from the list`);
  }
  const issues = echoDefIssues(draft, [def]);
  if (issues.length > 0) {
    throw new Error(issues.map((i) => i.message).join(' '));
  }
}

/** One row's `equippedTo`, as written or as it was. */
export interface EquipAssignment {
  id: string;
  equippedTo: string | null;
}

/** What `applyScan` wrote, for `undoScan`. */
export interface ScanApplied {
  added: OwnedEcho[];
  /** Rows an upgrade or "Equipped by" change touched: as they were, and as written (same order). */
  before: OwnedEcho[];
  after: OwnedEcho[];
  removed: OwnedEcho[];
}

/**
 * A levelled-up Echo's new row: the scanned fields replace the stored
 * ones, and it keeps its id (builds point at it), origin, nickname, lock
 * and the `rolls` of every substat that did not change.
 */
function upgradedRow(was: OwnedEcho, draft: ScanDraft): OwnedEcho {
  const label = draft.label ?? was.label;
  return ownedEchoSchema.parse({
    echoDefId: draft.echoDefId,
    sonataId: draft.sonataId,
    cost: draft.cost,
    level: draft.level,
    rarity: draft.rarity,
    mainStat: draft.mainStat,
    ...(draft.secondMainStat !== undefined ? { secondMainStat: draft.secondMainStat } : {}),
    substats: keepRolls(draft.substats, was.substats),
    equippedTo: draft.equippedTo,
    id: was.id,
    origin: was.origin,
    ...(label !== undefined ? { label } : {}),
    ...(was.locked === true ? { locked: true } : {}),
  });
}

/** Same row, field for field (rows read back keep their key order). */
const sameRow = (a: OwnedEcho | undefined, b: OwnedEcho): boolean => a !== undefined && JSON.stringify(a) === JSON.stringify(b);

interface InventoryState {
  echoes: OwnedEcho[];
  loaded: boolean;
  load: () => Promise<void>;
  addEcho: (draft: EchoDraft) => Promise<OwnedEcho>;
  /**
   * Save an edit from the Echo form: `fields` replace every form-owned field
   * (an absent optional one is cleared), and the row keeps its `id`, `origin`,
   * `equippedTo` and `locked` whatever the caller passes. A substat with the
   * same stat and value as a stored one keeps its `rolls` (the form never
   * shows them); a changed value or a new stat has none.
   */
  replaceEcho: (id: string, fields: EchoFormDraft) => Promise<OwnedEcho>;
  /** Delete one Echo; resolves to the exact row removed (for undo). Throws on an unknown or locked id. */
  removeEcho: (id: string) => Promise<OwnedEcho>;
  /**
   * Delete many Echoes in one Dexie transaction. Resolves to the exact rows
   * removed (read inside the transaction); unknown ids are ignored and locked
   * Echoes are skipped (never deleted). State is only touched after the
   * transaction commits.
   */
  removeEchoes: (ids: readonly string[]) => Promise<OwnedEcho[]>;
  /**
   * Lock or unlock Echoes in one Dexie transaction. Resolves to the rows that
   * changed; unknown ids and Echoes already in that state are ignored.
   */
  setLocked: (ids: readonly string[], locked: boolean) => Promise<OwnedEcho[]>;
  /**
   * Put rows from `removeEchoes` back under their original ids (so builds and
   * `equippedTo` resolve again), in one Dexie transaction. Takes ONLY
   * `removeEchoes` output and writes it verbatim: no schema parse, since
   * `load()` doesn't validate rows either, so a legacy row that today's schema
   * rejects (or carries unknown keys) must still come back unchanged.
   * Never overwrites: a row whose id exists again (a backup restore or
   * re-import in between) is left alone and reported in `skipped`.
   */
  restoreEchoes: (rows: readonly OwnedEcho[]) => Promise<{ restored: OwnedEcho[]; skipped: OwnedEcho[] }>;
  /**
   * Record who wears which Echo (`equippedTo`), in one Dexie transaction.
   * Mirrors a re-gear done in the game; the app can't change the game.
   * Resolves to the PREVIOUS `{ id, equippedTo }` of every row that changed
   * (read inside the transaction); unknown ids and rows already at the target
   * are ignored. Locks are irrelevant. State is only touched after commit.
   */
  reassignEquipped: (changes: readonly EquipAssignment[]) => Promise<EquipAssignment[]>;
  /**
   * Undo `reassignEquipped`: write `previous` back in one transaction, but
   * only for rows whose current `equippedTo` is still what `applied` set
   * (a row changed or deleted since is left as is and listed in `skipped`).
   */
  restoreEquipped: (
    previous: readonly EquipAssignment[],
    applied: readonly EquipAssignment[],
  ) => Promise<{ restored: string[]; skipped: string[] }>;
  /** Bumped by every `load()`; in-memory undo offers older than this are stale. */
  generation: number;
  /**
   * Bulk-add pre-validated import drafts (additive — existing rows are
   * untouched). Every draft still passes the strict write path, so a bad
   * row throws with its index instead of landing half-imported.
   */
  importEchoes: (drafts: EchoDraft[], origin: string) => Promise<OwnedEcho[]>;
  /**
   * Apply a reviewed scan (`scanner/sync.ts` `planSync`) in one Dexie
   * transaction: add new Echoes under `origin`, update levelled-up ones in
   * place, set "Equipped by" (the scan wins), and delete the rows the user
   * ticked (locked ones are skipped). If a row to update is gone, nothing
   * is written. Resolves to what changed, for `undoScan`.
   */
  applyScan: (plan: SyncPlan, origin: string) => Promise<ScanApplied>;
  /**
   * Undo `applyScan` in one transaction, row by row: only a row still exactly
   * as the scan left it is reverted (an added row deleted, an updated row put
   * back, a deleted row re-added if its id is free). Others are skipped.
   */
  undoScan: (applied: ScanApplied) => Promise<{ restored: number; skipped: number }>;
}

function toRow(draft: EchoDraft, id: string, origin = 'manual'): OwnedEcho {
  assertDefConsistent(draft);
  return ownedEchoSchema.parse({ ...draft, id, origin });
}

/** `locked: true` or no `locked` key at all — never `locked: false`. */
function withLock(row: OwnedEcho, locked: boolean): OwnedEcho {
  const next = { ...row };
  if (locked) next.locked = true;
  else delete next.locked;
  return next;
}

export const useInventoryStore = create<InventoryState>()((set, get) => ({
  echoes: [],
  loaded: false,
  generation: 0,

  load: async () => {
    const echoes = await db.ownedEchoes.toArray();
    set((s) => ({ echoes, loaded: true, generation: s.generation + 1 }));
  },

  addEcho: async (draft) => {
    const row = toRow(draft, crypto.randomUUID());
    await db.ownedEchoes.add(row);
    set((s) => ({ echoes: [...s.echoes, row] }));
    return row;
  },

  replaceEcho: async (id, fields) => {
    const existing = get().echoes.find((e) => e.id === id);
    if (!existing) throw new Error(`unknown echo: ${JSON.stringify(id)}`);
    assertDefConsistent(fields);
    // The kept fields come from the stored row alone: a stray key on `fields`
    // (the type forbids them, a cast would not) can neither set nor clear them.
    // An absent optional field is cleared, not stored as `undefined`.
    const edited: Record<string, unknown> = Object.fromEntries(
      Object.entries(fields).filter(([key, value]) => value !== undefined && !['id', 'origin', 'equippedTo', 'locked'].includes(key)),
    );
    const row = ownedEchoSchema.parse({
      ...edited,
      substats: keepRolls(fields.substats, existing.substats),
      id,
      origin: existing.origin,
      equippedTo: existing.equippedTo,
      ...(existing.locked === true ? { locked: true } : {}),
    });
    await db.ownedEchoes.put(row);
    set((s) => ({ echoes: s.echoes.map((e) => (e.id === id ? row : e)) }));
    return row;
  },

  removeEcho: async (id) => {
    const [row] = await get().removeEchoes([id]);
    if (row) return row;
    const existing = await db.ownedEchoes.get(id);
    if (existing?.locked) throw new Error('this Echo is locked — unlock it to delete it');
    throw new Error(`unknown echo: ${JSON.stringify(id)}`);
  },

  removeEchoes: async (ids) => {
    const wanted = [...new Set(ids)];
    const removed = await db.transaction('rw', db.ownedEchoes, async () => {
      const found = (await db.ownedEchoes.bulkGet(wanted)).filter(
        (row): row is OwnedEcho => row !== undefined && !row.locked,
      );
      await db.ownedEchoes.bulkDelete(found.map((row) => row.id));
      return found;
    });
    const gone = new Set(removed.map((row) => row.id));
    set((s) => ({ echoes: s.echoes.filter((e) => !gone.has(e.id)) }));
    return removed;
  },

  setLocked: async (ids, locked) => {
    const wanted = [...new Set(ids)];
    const changed = await db.transaction('rw', db.ownedEchoes, async () => {
      const rows = (await db.ownedEchoes.bulkGet(wanted))
        .filter((row): row is OwnedEcho => row !== undefined && (row.locked === true) !== locked)
        .map((row) => withLock(row, locked));
      await db.ownedEchoes.bulkPut(rows);
      return rows;
    });
    const byId = new Map(changed.map((row) => [row.id, row]));
    set((s) => ({ echoes: s.echoes.map((e) => byId.get(e.id) ?? e) }));
    return changed;
  },

  restoreEchoes: async (rows) => {
    const { restored, skipped } = await db.transaction('rw', db.ownedEchoes, async () => {
      const present = await db.ownedEchoes.bulkGet(rows.map((row) => row.id));
      const toAdd = rows.filter((_, i) => present[i] === undefined);
      await db.ownedEchoes.bulkAdd(toAdd);
      return { restored: toAdd, skipped: rows.filter((_, i) => present[i] !== undefined) };
    });
    const back = new Set(restored.map((row) => row.id));
    set((s) => ({ echoes: [...s.echoes.filter((e) => !back.has(e.id)), ...restored] }));
    return { restored, skipped };
  },

  reassignEquipped: async (changes) => {
    const wanted = new Map(changes.map((c) => [c.id, c.equippedTo]));
    const { previous, written } = await db.transaction('rw', db.ownedEchoes, async () => {
      const rows = (await db.ownedEchoes.bulkGet([...wanted.keys()])).filter(
        (row): row is OwnedEcho => row !== undefined && (row.equippedTo ?? null) !== wanted.get(row.id),
      );
      const next = rows.map((row) => ({ ...row, equippedTo: wanted.get(row.id) ?? null }));
      await db.ownedEchoes.bulkPut(next);
      return {
        previous: rows.map((row) => ({ id: row.id, equippedTo: row.equippedTo ?? null })),
        written: new Map(next.map((row) => [row.id, row])),
      };
    });
    set((s) => ({ echoes: s.echoes.map((e) => written.get(e.id) ?? e) }));
    return previous;
  },

  restoreEquipped: async (previous, applied) => {
    const expected = new Map(applied.map((c) => [c.id, c.equippedTo]));
    const { restored, skipped, written } = await db.transaction('rw', db.ownedEchoes, async () => {
      const rows = await db.ownedEchoes.bulkGet(previous.map((p) => p.id));
      const back: OwnedEcho[] = [];
      const left: string[] = [];
      previous.forEach((p, i) => {
        const row = rows[i];
        if (row !== undefined && expected.has(p.id) && (row.equippedTo ?? null) === expected.get(p.id)) {
          back.push({ ...row, equippedTo: p.equippedTo });
        } else left.push(p.id);
      });
      await db.ownedEchoes.bulkPut(back);
      return { restored: back.map((row) => row.id), skipped: left, written: new Map(back.map((row) => [row.id, row])) };
    });
    set((s) => ({ echoes: s.echoes.map((e) => written.get(e.id) ?? e) }));
    return { restored, skipped };
  },

  importEchoes: async (drafts, origin) => {
    const rows = drafts.map((draft, i) => {
      try {
        return toRow(draft, crypto.randomUUID(), origin);
      } catch (err) {
        throw new Error(`import row ${i + 1}: ${err instanceof Error ? err.message : 'invalid'}`);
      }
    });
    await db.ownedEchoes.bulkAdd(rows);
    set((s) => ({ echoes: [...s.echoes, ...rows] }));
    return rows;
  },

  applyScan: async (plan, origin) => {
    const added = plan.add.map((draft, i) => {
      try {
        return toRow(draft, crypto.randomUUID(), origin);
      } catch (err) {
        throw new Error(`scan row ${i + 1}: ${err instanceof Error ? err.message : 'invalid'}`);
      }
    });
    for (const { draft } of plan.upgrade) assertDefConsistent(draft);
    const applied = await db.transaction('rw', db.ownedEchoes, async () => {
      const ids = [...plan.upgrade.map((u) => u.id), ...plan.equip.map((e) => e.id)];
      const rows = await db.ownedEchoes.bulkGet(ids);
      if (rows.some((row) => row === undefined)) {
        throw new Error('Your inventory changed since this scan was checked against it. Nothing was saved; review the scan again.');
      }
      const before: OwnedEcho[] = [];
      const after: OwnedEcho[] = [];
      plan.upgrade.forEach((u, i) => {
        before.push(rows[i]!);
        after.push(upgradedRow(rows[i]!, u.draft));
      });
      plan.equip.forEach((e, j) => {
        const was = rows[plan.upgrade.length + j]!;
        if ((was.equippedTo ?? null) === e.equippedTo) return;
        before.push(was);
        after.push({ ...was, equippedTo: e.equippedTo });
      });
      const removed = (await db.ownedEchoes.bulkGet(plan.remove)).filter(
        (row): row is OwnedEcho => row !== undefined && !row.locked,
      );
      await db.ownedEchoes.bulkAdd(added);
      await db.ownedEchoes.bulkPut(after);
      await db.ownedEchoes.bulkDelete(removed.map((row) => row.id));
      return { added, before, after, removed };
    });
    const written = new Map(applied.after.map((row) => [row.id, row]));
    const gone = new Set(applied.removed.map((row) => row.id));
    set((s) => ({
      echoes: [...s.echoes.filter((e) => !gone.has(e.id)).map((e) => written.get(e.id) ?? e), ...applied.added],
    }));
    return applied;
  },

  undoScan: async (applied) => {
    const { drop, back, readd } = await db.transaction('rw', db.ownedEchoes, async () => {
      const addedNow = await db.ownedEchoes.bulkGet(applied.added.map((row) => row.id));
      const afterNow = await db.ownedEchoes.bulkGet(applied.after.map((row) => row.id));
      const removedNow = await db.ownedEchoes.bulkGet(applied.removed.map((row) => row.id));
      const result = {
        drop: applied.added.filter((row, i) => sameRow(addedNow[i], row)),
        back: applied.before.filter((_, i) => sameRow(afterNow[i], applied.after[i])),
        readd: applied.removed.filter((_, i) => removedNow[i] === undefined),
      };
      await db.ownedEchoes.bulkDelete(result.drop.map((row) => row.id));
      await db.ownedEchoes.bulkPut(result.back);
      await db.ownedEchoes.bulkAdd(result.readd);
      return result;
    });
    const dropped = new Set(drop.map((row) => row.id));
    const reverted = new Map(back.map((row) => [row.id, row]));
    set((s) => ({
      echoes: [...s.echoes.filter((e) => !dropped.has(e.id)).map((e) => reverted.get(e.id) ?? e), ...readd],
    }));
    const restored = drop.length + back.length + readd.length;
    return { restored, skipped: applied.added.length + applied.after.length + applied.removed.length - restored };
  },
}));
