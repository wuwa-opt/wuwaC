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
   * Patch a build's name, notes or minimum stats. `minStats` takes sheet
   * fractions: only positive finite entries are stored (`effectiveMinStats`,
   * the Calculator's rule), and `null` or nothing left removes the key (never
   * `{}`). A negative or non-finite entry throws and writes nothing.
   */
  updateBuild: (id: string, patch: BuildPatch) => Promise<Build>;
  removeBuild: (id: string) => Promise<void>;
  importBuilds: (json: unknown) => Promise<{ added: number; skipped: number }>;
}

/** Serialize validated builds for JSON export. */
export function serializeBuilds(builds: Build[]): string {
  return JSON.stringify(builds.map((b) => buildSchema.parse(b)));
}

export const useLibraryStore = create<LibraryState>()((set, get) => ({
  builds: [],
  loaded: false,

  load: async () => {
    const builds = await db.builds.toArray();
    set({ builds, loaded: true });
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
    const gone = new Set(removed.map((row) => row.id));
    set((s) => ({ builds: s.builds.filter((b) => !gone.has(b.id)) }));
    return removed;
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
    const existing = get().builds.find((b) => b.id === id);
    if (!existing) throw new Error(`unknown build: ${JSON.stringify(id)}`);
    await db.builds.delete(id);
    set((s) => ({ builds: s.builds.filter((b) => b.id !== id) }));
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
