import { create } from 'zustand';
import { findEchoDef, loadBundledSnapshot } from '../data/index.ts';
import { ownedEchoSchema, type EchoDefData, type OwnedEcho } from '../data/schema.ts';
import { db } from './db.ts';

/**
 * Form input for one Echo. The store derives identity: `id` is generated
 * and `origin` is always manual here. `echoDefId` must be a real synced
 * definition — the form picks it, never the label (Phase 3 decision:
 * legacy slugified rows are force re-linked on next edit).
 */
export type EchoDraft = Omit<OwnedEcho, 'id' | 'origin'> & {
  label?: string;
};

/** Row-level def problems. `orphan` = unknown def; the rest = known-def mismatch. */
export interface EchoDefIssue {
  kind: 'orphan' | 'cost' | 'sonata' | 'mainStat';
  message: string;
}

/** Check a row against its echo def. Empty = consistent. Tolerant reads use this; writes reject. */
export function echoDefIssues(echo: Pick<OwnedEcho, 'echoDefId' | 'sonataId' | 'cost' | 'mainStat'>, defs: readonly EchoDefData[] = loadBundledSnapshot().echoDefs): EchoDefIssue[] {
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

/** Strict write path: drafts must be fully def-consistent. */
function assertDefConsistent(draft: EchoDraft): void {
  const def = findEchoDef(loadBundledSnapshot(), draft.echoDefId);
  if (!def) {
    throw new Error(`unknown echo definition: ${JSON.stringify(draft.echoDefId)} — pick the Echo from the list`);
  }
  const issues = echoDefIssues(draft, [def]);
  if (issues.length > 0) {
    throw new Error(issues.map((i) => i.message).join(' '));
  }
}

interface InventoryState {
  echoes: OwnedEcho[];
  loaded: boolean;
  load: () => Promise<void>;
  addEcho: (draft: EchoDraft) => Promise<OwnedEcho>;
  updateEcho: (id: string, patch: Partial<EchoDraft>) => Promise<OwnedEcho>;
  /** Delete one Echo; resolves to the exact row removed (for undo). Throws on an unknown id. */
  removeEcho: (id: string) => Promise<OwnedEcho>;
  /**
   * Delete many Echoes in one Dexie transaction. Resolves to the exact rows
   * removed (read inside the transaction); unknown ids are ignored. State is
   * only touched after the transaction commits.
   */
  removeEchoes: (ids: readonly string[]) => Promise<OwnedEcho[]>;
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
  /** Bumped by every `load()`; in-memory undo offers older than this are stale. */
  generation: number;
  /**
   * Bulk-add pre-validated import drafts (additive — existing rows are
   * untouched). Every draft still passes the strict write path, so a bad
   * row throws with its index instead of landing half-imported.
   */
  importEchoes: (drafts: EchoDraft[], origin: string) => Promise<OwnedEcho[]>;
}

function toRow(draft: EchoDraft, id: string, origin = 'manual'): OwnedEcho {
  assertDefConsistent(draft);
  return ownedEchoSchema.parse({ ...draft, id, origin });
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

  updateEcho: async (id, patch) => {
    const existing = get().echoes.find((e) => e.id === id);
    if (!existing) throw new Error(`unknown echo: ${JSON.stringify(id)}`);
    const merged: EchoDraft = { ...existing, ...patch };
    assertDefConsistent(merged);
    const row = ownedEchoSchema.parse(merged);
    await db.ownedEchoes.put(row);
    set((s) => ({ echoes: s.echoes.map((e) => (e.id === id ? row : e)) }));
    return row;
  },

  removeEcho: async (id) => {
    const [row] = await get().removeEchoes([id]);
    if (!row) throw new Error(`unknown echo: ${JSON.stringify(id)}`);
    return row;
  },

  removeEchoes: async (ids) => {
    const wanted = [...new Set(ids)];
    const removed = await db.transaction('rw', db.ownedEchoes, async () => {
      const found = (await db.ownedEchoes.bulkGet(wanted)).filter((row): row is OwnedEcho => row !== undefined);
      await db.ownedEchoes.bulkDelete(found.map((row) => row.id));
      return found;
    });
    const gone = new Set(removed.map((row) => row.id));
    set((s) => ({ echoes: s.echoes.filter((e) => !gone.has(e.id)) }));
    return removed;
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
}));
