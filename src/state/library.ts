import { create } from 'zustand';
import { buildSchema, type Build } from '../data/schema.ts';
import { effectiveMinStats, type MinStats } from '../optimizer/minStats.ts';
import { db } from './db.ts';

/** Draft for a new build: everything except generated id/timestamp. */
export type BuildDraft = Omit<Build, 'id' | 'updatedAt'>;

export type BuildPatch = Partial<Pick<Build, 'name' | 'notes'>> & { minStats?: MinStats | null };

interface LibraryState {
  builds: Build[];
  loaded: boolean;
  /** Bumped by every `load()` (a backup restore reloads); in-memory undo offers older than this are stale. */
  generation: number;
  load: () => Promise<void>;
  saveBuild: (draft: BuildDraft) => Promise<Build>;
  /**
   * Save several builds atomically: every draft is validated first, then all
   * rows are added in one Dexie transaction (all or nothing).
   */
  saveBuilds: (drafts: readonly BuildDraft[]) => Promise<Build[]>;
  /**
   * Delete builds by id in one transaction; resolves to the rows removed
   * (unknown ids ignored). Used to undo `saveBuilds`.
   */
  removeBuilds: (ids: readonly string[]) => Promise<Build[]>;
  /**
   * Put rows from `removeBuild` / `removeBuilds` back under their original
   * ids, in one Dexie transaction, so everything that names a build by id
   * (allocation picks, the Builds page's open details) finds it again. Takes
   * ONLY that output and writes it verbatim: no schema parse, since `load()`
   * doesn't validate rows either. Never overwrites: a row whose id exists
   * again (a backup restore or import in between) is left alone and reported
   * in `skipped`. Restored rows go back to their old place in the list.
   */
  restoreBuilds: (rows: readonly Build[]) => Promise<{ restored: Build[]; skipped: Build[] }>;
  /**
   * Patch a build's name, notes or minimum stats. `minStats` takes sheet
   * fractions: only positive finite entries are stored (`effectiveMinStats`,
   * the Calculator's rule), and `null` or nothing left removes the key (never
   * `{}`). A negative or non-finite entry throws and writes nothing.
   */
  updateBuild: (id: string, patch: BuildPatch) => Promise<Build>;
  /** Delete one build; resolves to the row removed (for `restoreBuilds`). Unknown ids throw. */
  removeBuild: (id: string) => Promise<Build>;
  importBuilds: (json: unknown) => Promise<{ added: number; skipped: number }>;
}

/** Serialize validated builds for JSON export. */
export function serializeBuilds(builds: Build[]): string {
  return JSON.stringify(builds.map((b) => buildSchema.parse(b)));
}

/**
 * Where each removed row sat in the in-memory list, keyed by the row object
 * `removeBuilds` returned, so `restoreBuilds` can put it back in place.
 */
const removedAt = new WeakMap<Build, number>();

export const useLibraryStore = create<LibraryState>()((set, get) => ({
  builds: [],
  loaded: false,
  generation: 0,

  load: async () => {
    const builds = await db.builds.toArray();
    set((s) => ({ builds, loaded: true, generation: s.generation + 1 }));
  },

  saveBuild: async (draft) => {
    const row = buildSchema.parse({
      ...draft,
      id: crypto.randomUUID(),
      updatedAt: new Date().toISOString(),
    });
    await db.builds.add(row);
    set((s) => ({ builds: [...s.builds, row] }));
    return row;
  },

  saveBuilds: async (drafts) => {
    const updatedAt = new Date().toISOString();
    const rows = drafts.map((draft) => buildSchema.parse({ ...draft, id: crypto.randomUUID(), updatedAt }));
    await db.transaction('rw', db.builds, async () => {
      await db.builds.bulkAdd(rows);
    });
    set((s) => ({ builds: [...s.builds, ...rows] }));
    return rows;
  },

  removeBuilds: async (ids) => {
    const wanted = [...new Set(ids)];
    const removed = await db.transaction('rw', db.builds, async () => {
      const found = (await db.builds.bulkGet(wanted)).filter((row): row is Build => row !== undefined);
      await db.builds.bulkDelete(found.map((row) => row.id));
      return found;
    });
    const listed = get().builds.map((b) => b.id);
    for (const row of removed) removedAt.set(row, listed.indexOf(row.id));
    const gone = new Set(removed.map((row) => row.id));
    set((s) => ({ builds: s.builds.filter((b) => !gone.has(b.id)) }));
    return removed;
  },

  restoreBuilds: async (rows) => {
    const { restored, skipped } = await db.transaction('rw', db.builds, async () => {
      const present = await db.builds.bulkGet(rows.map((row) => row.id));
      const toAdd = rows.filter((_, i) => present[i] === undefined);
      await db.builds.bulkAdd(toAdd);
      return { restored: toAdd, skipped: rows.filter((_, i) => present[i] !== undefined) };
    });
    const back = new Set(restored.map((row) => row.id));
    set((s) => {
      const builds = s.builds.filter((b) => !back.has(b.id));
      // Lowest old index first, so earlier insertions keep later indices right.
      const placed = [...restored].sort((a, b) => (removedAt.get(a) ?? Infinity) - (removedAt.get(b) ?? Infinity));
      for (const row of placed) {
        const at = removedAt.get(row);
        builds.splice(at === undefined || at < 0 ? builds.length : Math.min(at, builds.length), 0, row);
      }
      return { builds };
    });
    return { restored, skipped };
  },

  updateBuild: async (id, patch) => {
    const existing = get().builds.find((b) => b.id === id);
    if (!existing) throw new Error(`unknown build: ${JSON.stringify(id)}`);
    const { minStats, ...rest } = patch;
    const candidate: Record<string, unknown> = { ...existing, ...rest };
    if (minStats !== undefined) {
      if (minStats !== null && Object.values(minStats).some((v) => !Number.isFinite(v) || v < 0)) {
        throw new Error('minimum stats must be non-negative numbers');
      }
      const next = effectiveMinStats(minStats ?? undefined);
      if (next === undefined) delete candidate.minStats;
      else candidate.minStats = next;
    }
    const row = buildSchema.parse(candidate);
    await db.builds.put(row);
    set((s) => ({ builds: s.builds.map((b) => (b.id === id ? row : b)) }));
    return row;
  },

  removeBuild: async (id) => {
    const [row] = await get().removeBuilds([id]);
    if (!row) throw new Error(`unknown build: ${JSON.stringify(id)}`);
    return row;
  },

  importBuilds: async (json) => {
    if (!Array.isArray(json)) throw new Error('expected an array of builds');
    // Validate everything before writing anything. Missing ids are assigned
    // (foreign exports may not carry them); everything else must validate.
    const rows = json.map((item) => {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        throw new Error('expected each build to be an object');
      }
      const record = item as Record<string, unknown>;
      return buildSchema.parse({
        ...record,
        id: typeof record.id === 'string' ? record.id : crypto.randomUUID(),
      });
    });
    const known = new Set(get().builds.map((b) => b.id));
    let skipped = 0;
    const fresh = rows.filter((row) => {
      if (known.has(row.id)) {
        skipped += 1;
        return false;
      }
      known.add(row.id);
      return true;
    });
    await db.builds.bulkAdd(fresh);
    set((s) => ({ builds: [...s.builds, ...fresh] }));
    return { added: fresh.length, skipped };
  },
}));
