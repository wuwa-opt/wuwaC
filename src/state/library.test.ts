import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from './db.ts';
import { serializeBuilds, useLibraryStore } from './library.ts';
import type { Build, SharedBuild } from '../data/schema.ts';
import { BACKUP_FORMAT, BACKUP_VERSION, parseBackup } from './backup.ts';
import { referenceBuildFrom } from './share.ts';
import { loadBundledSnapshot } from '../data/index.ts';
import { findUnusedEchoes } from '../optimizer/unused.ts';

type Draft = Omit<Build, 'id' | 'updatedAt'>;

const draft: Draft = {
  name: 'Jiyan Liberation',
  characterId: 'jiyan',
  weaponId: 'verdant-summit',
  echoIds: ['a', 'b', 'c', 'd', 'e'],
  objectiveId: 'Expected damage',
  objective: {
    kind: 'expected-damage',
    skillId: '1001103',
    motionName: 'Lance of Qingloong Stage 1 DMG',
    forteLevel: 10,
    crit: 'expected',
  },
  score: 650.5,
};

beforeEach(async () => {
  await db.builds.clear();
  useLibraryStore.setState({ builds: [], loaded: false });
});

describe('library store', () => {
  it('starts empty and unloaded', () => {
    expect(useLibraryStore.getState().builds).toEqual([]);
    expect(useLibraryStore.getState().loaded).toBe(false);
  });

  it('saveBuild stamps id/updatedAt and persists', async () => {
    const saved = await useLibraryStore.getState().saveBuild(draft);
    expect(saved.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(saved.updatedAt).getTime()).not.toBeNaN();
    expect(saved.objective).toEqual(draft.objective);
    expect(useLibraryStore.getState().builds).toHaveLength(1);
    expect(await db.builds.get(saved.id)).toMatchObject({ name: 'Jiyan Liberation' });
  });

  it('saveBuild rejects invalid drafts without writing', async () => {
    await expect(
      useLibraryStore.getState().saveBuild({ ...draft, echoIds: ['a', 'b', 'c', 'd', 'a'] }),
    ).rejects.toThrow(/equipped twice/);
    expect(useLibraryStore.getState().builds).toEqual([]);
    expect(await db.builds.count()).toBe(0);
  });

  it('updateBuild edits name and notes', async () => {
    const saved = await useLibraryStore.getState().saveBuild(draft);
    const updated = await useLibraryStore.getState().updateBuild(saved.id, {
      name: 'Renamed',
      notes: 'hello',
    });
    expect(updated.name).toBe('Renamed');
    expect(updated.notes).toBe('hello');
    expect(await db.builds.get(saved.id)).toMatchObject({ name: 'Renamed', notes: 'hello' });
  });

  describe('updateBuild minStats', () => {
    const update = (id: string, minStats: Parameters<ReturnType<typeof useLibraryStore.getState>['updateBuild']>[1]['minStats']) =>
      useLibraryStore.getState().updateBuild(id, { minStats });
    const persisted = async (id: string) => (await db.builds.get(id))!;

    it('sets, changes, and clears one minimum at a time', async () => {
      const saved = await useLibraryStore.getState().saveBuild(draft);
      expect('minStats' in saved).toBe(false);

      const set = await update(saved.id, { energyRegen: 0.2 });
      expect(set.minStats).toEqual({ energyRegen: 0.2 });
      expect((await persisted(saved.id)).minStats).toEqual({ energyRegen: 0.2 });
      expect(useLibraryStore.getState().builds[0].minStats).toEqual({ energyRegen: 0.2 });

      const changed = await update(saved.id, { energyRegen: 0.25, critRate: 0.7 });
      expect(changed.minStats).toEqual({ energyRegen: 0.25, critRate: 0.7 });

      const one = await update(saved.id, { critRate: 0.7 });
      expect(one.minStats).toEqual({ critRate: 0.7 });
      expect((await persisted(saved.id)).minStats).toEqual({ critRate: 0.7 });
      // The rest of the row is untouched, and the row is still schema-valid.
      expect(one).toMatchObject({ name: draft.name, score: draft.score, echoIds: draft.echoIds });
      expect(() => serializeBuilds(useLibraryStore.getState().builds)).not.toThrow();
    });

    it('clearing everything removes the key (never {}), for null, {} and all-zero input', async () => {
      const saved = await useLibraryStore.getState().saveBuild({ ...draft, minStats: { critRate: 0.7, critDmg: 1.8 } });
      for (const empty of [null, {}, { critRate: 0, critDmg: 0 }] as const) {
        await update(saved.id, { critRate: 0.7 });
        const cleared = await update(saved.id, empty);
        expect('minStats' in cleared).toBe(false);
        expect('minStats' in useLibraryStore.getState().builds[0]).toBe(false);
        expect('minStats' in (await persisted(saved.id))).toBe(false);
      }
    });

    it('stores only positive finite entries', async () => {
      const saved = await useLibraryStore.getState().saveBuild(draft);
      const row = await update(saved.id, { energyRegen: 0, critRate: 0.7 });
      expect(row.minStats).toEqual({ critRate: 0.7 });
    });

    it('leaves minStats alone when the patch does not mention it', async () => {
      const saved = await useLibraryStore.getState().saveBuild({ ...draft, minStats: { critRate: 0.7 } });
      const renamed = await useLibraryStore.getState().updateBuild(saved.id, { name: 'Renamed' });
      expect(renamed.minStats).toEqual({ critRate: 0.7 });
    });

    it('rejects invalid input and writes nothing', async () => {
      const saved = await useLibraryStore.getState().saveBuild({ ...draft, minStats: { critRate: 0.7 } });
      await expect(update(saved.id, { critRate: -0.1 })).rejects.toThrow();
      await expect(update(saved.id, { critRate: Number.NaN })).rejects.toThrow();
      await expect(update(saved.id, { critRate: Infinity })).rejects.toThrow();
      await expect(update(saved.id, { notAStat: 0.5 } as never)).rejects.toThrow();
      await expect(update('missing', { critRate: 0.7 })).rejects.toThrow(/unknown build/);
      expect(useLibraryStore.getState().builds[0].minStats).toEqual({ critRate: 0.7 });
      expect((await persisted(saved.id)).minStats).toEqual({ critRate: 0.7 });
    });

    it('a newly set minimum makes the unused-Echo finder keep an Echo it called fodder', async () => {
      const characters = loadBundledSnapshot().characters;
      const mk = (id: string, cost: 1 | 3 | 4, stats: Record<string, number>) => ({
        id,
        label: id,
        echoDefId: `${id}-def`,
        sonataId: 'sierra-gale',
        cost,
        level: 25,
        rarity: 5 as const,
        mainStat: { stat: 'atk' as const, value: 0 },
        substats: Object.entries(stats).map(([stat, value]) => ({ stat: stat as 'atk', value })),
        equippedTo: null,
        origin: 'manual' as const,
      });
      const fillers = Array.from({ length: 4 }, (_, i) => mk(`f${i}`, 1, {}));
      const echoes = [mk('strong1', 4, { atk: 100 }), mk('strong2', 4, { atk: 90 }), mk('regen', 4, { atk: 10, energyRegen: 0.2 }), ...fillers];
      const saved = await useLibraryStore.getState().saveBuild({
        ...draft,
        characterId: 'jiyan',
        echoIds: ['strong1', 'f0', 'f1', 'f2', 'f3'],
        objectiveId: 'max-stat',
        objective: { kind: 'max-stat', stat: 'atk' },
      });
      const verdict = () => findUnusedEchoes({ echoes, builds: useLibraryStore.getState().builds, characters }).get('regen');
      expect(verdict()).toMatchObject({ status: 'fodder' });

      await update(saved.id, { energyRegen: 0.2 });
      expect(verdict()).toMatchObject({ status: 'unused', reason: 'kept', keptBy: saved.id });

      await update(saved.id, null);
      expect(verdict()).toMatchObject({ status: 'fodder' });
    });
  });

  it('updateBuild throws for unknown ids and blank names', async () => {
    const saved = await useLibraryStore.getState().saveBuild(draft);
    await expect(useLibraryStore.getState().updateBuild('missing', { name: 'x' })).rejects.toThrow(
      /unknown build/,
    );
    await expect(useLibraryStore.getState().updateBuild(saved.id, { name: '' })).rejects.toThrow();
  });

  it('removeBuild deletes and throws for unknown ids', async () => {
    const saved = await useLibraryStore.getState().saveBuild(draft);
    await useLibraryStore.getState().removeBuild(saved.id);
    expect(useLibraryStore.getState().builds).toEqual([]);
    expect(await db.builds.count()).toBe(0);
    await expect(useLibraryStore.getState().removeBuild(saved.id)).rejects.toThrow(/unknown build/);
  });

  it('importBuilds adds valid builds and reports counts', async () => {
    const now = new Date().toISOString();
    const result = await useLibraryStore.getState().importBuilds([
      { ...draft, name: 'One', updatedAt: now },
      { ...draft, name: 'Two', updatedAt: now },
    ]);
    expect(result).toEqual({ added: 2, skipped: 0 });
    expect(useLibraryStore.getState().builds).toHaveLength(2);
  });

  it('importBuilds throws on garbage without writing anything', async () => {
    await expect(useLibraryStore.getState().importBuilds([{ nope: true }])).rejects.toThrow();
    await expect(useLibraryStore.getState().importBuilds('nope')).rejects.toThrow();
    expect(useLibraryStore.getState().builds).toEqual([]);
    expect(await db.builds.count()).toBe(0);
  });

  it('importBuilds skips id collisions', async () => {
    const saved = await useLibraryStore.getState().saveBuild(draft);
    const result = await useLibraryStore.getState().importBuilds([
      { ...saved, name: 'Collision' },
    ]);
    expect(result).toEqual({ added: 0, skipped: 1 });
    expect(useLibraryStore.getState().builds).toHaveLength(1);
  });
});

describe('serializeBuilds', () => {
  it('round-trips through importBuilds', async () => {
    const saved = await useLibraryStore.getState().saveBuild(draft);
    const json = serializeBuilds([saved]);
    expect(JSON.parse(json)).toHaveLength(1);
    await db.builds.clear();
    useLibraryStore.setState({ builds: [], loaded: true });
    const result = await useLibraryStore.getState().importBuilds(JSON.parse(json));
    expect(result).toEqual({ added: 1, skipped: 0 });
  });
});

describe('saved build context', () => {
  it('survives Dexie and JSON export/import', async () => {
    const context = {
      characterId: 'jiyan',
      level: 70,
      ascension: 4,
      resonanceChain: 1,
      forteLevels: { '1001103': 8 },
      forteUnlockedIds: ['node-a'],
      weaponId: 'verdant-summit',
      weaponLevel: 60,
      weaponAscension: 3,
      weaponRank: 2,
    };
    const saved = await useLibraryStore.getState().saveBuild({ ...draft, context });
    expect((await db.builds.get(saved.id))?.context).toEqual(context);

    const exported = serializeBuilds([saved]);
    await db.builds.clear();
    useLibraryStore.setState({ builds: [], loaded: true });
    await useLibraryStore.getState().importBuilds(JSON.parse(exported) as unknown);
    expect((await db.builds.get(saved.id))?.context).toEqual(context);
  });

  it('rejects a context for a different character', async () => {
    await expect(
      useLibraryStore.getState().saveBuild({
        ...draft,
        context: { characterId: 'verina', level: 90, ascension: 6, resonanceChain: 0, forteLevels: {}, weaponId: 'verdant-summit', weaponLevel: 90, weaponRank: 1 },
      }),
    ).rejects.toThrow(/context/);
    expect(await db.builds.count()).toBe(0);
  });
});

describe('reference builds (saved share links)', () => {
  const payload: SharedBuild = {
    v: 2,
    name: 'Friend build',
    summary: 'Expected damage',
    character: { id: 'jiyan', level: 90, ascension: 6, chain: 0, forte: { '1001103': 10 } },
    weapon: { id: 'verdant-summit', level: 90, ascension: 6, rank: 1 },
    echoes: Array.from({ length: 5 }, (_, i) => ({
      def: `def-${i}`,
      set: 'sierra-gale',
      cost: 1 as const,
      level: 25,
      rarity: 5,
      main: { stat: 'atkPct' as const, value: 0.18 },
      subs: [],
    })) as unknown as SharedBuild['echoes'],
  };

  it('persist with their payload and touch nothing in ownedEchoes', async () => {
    const before = await db.ownedEchoes.count();
    const { added } = await useLibraryStore.getState().importBuilds([referenceBuildFrom(payload)]);
    expect(added).toBe(1);
    useLibraryStore.setState({ builds: [], loaded: false });
    await useLibraryStore.getState().load();
    const [row] = useLibraryStore.getState().builds;
    expect(row.reference).toEqual(payload);
    expect(await db.ownedEchoes.count()).toBe(before);
  });

  it('survive JSON export/import and validate in a version-1 backup', () => {
    const ref = referenceBuildFrom(payload);
    const exported = JSON.parse(serializeBuilds([ref])) as unknown[];
    expect(exported[0]).toEqual(ref);
    const backup = {
      format: BACKUP_FORMAT,
      version: 1,
      exportedAt: '2026-10-21T00:00:00.000Z',
      tables: { ownedEchoes: [], roster: [], builds: [ref], teams: [] },
    };
    expect(BACKUP_VERSION).toBe(1);
    expect(parseBackup(backup).tables.builds[0].reference).toEqual(payload);
  });
});

describe('reference builds with run settings (v3 payload)', () => {
  const v2: SharedBuild = {
    v: 2,
    name: 'Old link',
    summary: 'Expected damage',
    character: { id: 'jiyan', level: 90, ascension: 6, chain: 0, forte: { '1001103': 10 } },
    weapon: { id: 'verdant-summit', level: 90, ascension: 6, rank: 1 },
    echoes: Array.from({ length: 5 }, (_, i) => ({
      def: `def-${i}`,
      set: 'sierra-gale',
      cost: 1 as const,
      level: 25,
      rarity: 5,
      main: { stat: 'atkPct' as const, value: 0.18 },
      subs: [],
    })) as unknown as SharedBuild['echoes'],
  };
  const v3: SharedBuild = {
    ...v2,
    v: 3,
    name: 'New link',
    enemy: { kind: 'boss', level: 100, baseRES: 0.2 },
    resonanceMode: 'tuneStrain',
    minStats: { critRate: 0.6 },
  };

  it('stored v2 references still parse, and a v3 one parses and keeps its settings', async () => {
    expect(referenceBuildFrom(v2).reference).toEqual(v2);
    expect(referenceBuildFrom(v3).reference).toEqual(v3);
    const { added } = await useLibraryStore.getState().importBuilds([referenceBuildFrom(v2), referenceBuildFrom(v3)]);
    expect(added).toBe(2);
    useLibraryStore.setState({ builds: [], loaded: false });
    await useLibraryStore.getState().load();
    const byName = Object.fromEntries(useLibraryStore.getState().builds.map((b) => [b.name, b.reference]));
    expect(byName['Old link']).toEqual(v2);
    expect(byName['New link']).toEqual(v3);
  });

  it('both validate in a version-1 backup and survive JSON export', () => {
    const refs = [referenceBuildFrom(v2), referenceBuildFrom(v3)];
    expect(JSON.parse(serializeBuilds(refs))).toEqual(refs);
    const backup = {
      format: BACKUP_FORMAT,
      version: 1,
      exportedAt: '2026-10-22T00:00:00.000Z',
      tables: { ownedEchoes: [], roster: [], builds: refs, teams: [] },
    };
    expect(parseBackup(backup).tables.builds.map((b) => b.reference)).toEqual([v2, v3]);
  });

  it('a v2 payload carrying a v3 field is refused on import', async () => {
    const bad = { ...referenceBuildFrom(v2), reference: { ...v2, minStats: { critRate: 0.6 } } };
    await expect(useLibraryStore.getState().importBuilds([bad])).rejects.toThrow();
  });
});

describe('library store: saveBuilds / removeBuilds', () => {
  const draft = (name: string): Omit<Build, 'id' | 'updatedAt'> => ({
    name,
    characterId: 'jiyan',
    weaponId: 'verdant-summit',
    echoIds: [`${name}1`, `${name}2`, `${name}3`, `${name}4`, `${name}5`],
    objectiveId: 'Max ATK',
    objective: { kind: 'max-stat', stat: 'atk' },
  });

  it('saves every draft in one transaction with fresh ids', async () => {
    const rows = await useLibraryStore.getState().saveBuilds([draft('A'), draft('B')]);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
    expect(await db.builds.count()).toBe(2);
    expect(useLibraryStore.getState().builds).toEqual(rows);
  });

  it('writes nothing when one draft is invalid', async () => {
    const bad = { ...draft('Bad'), echoIds: ['x', 'x', 'y', 'z', 'w'] } as Omit<Build, 'id' | 'updatedAt'>;
    await expect(useLibraryStore.getState().saveBuilds([draft('A'), bad])).rejects.toThrow();
    expect(await db.builds.count()).toBe(0);
    expect(useLibraryStore.getState().builds).toEqual([]);
  });

  it('rolls back and leaves state untouched when the transaction fails part-way', async () => {
    const original = db.builds.bulkAdd.bind(db.builds);
    const spy = vi.spyOn(db.builds, 'bulkAdd').mockImplementation((async (items: unknown[]) => {
      await original([items[0]] as never);
      throw new Error('quota exceeded');
    }) as never);
    await expect(useLibraryStore.getState().saveBuilds([draft('A'), draft('B')])).rejects.toThrow('quota exceeded');
    spy.mockRestore();
    expect(await db.builds.count()).toBe(0);
    expect(useLibraryStore.getState().builds).toEqual([]);
  });

  it('removeBuilds returns the rows removed, ignores unknown ids, and undoes a save', async () => {
    const saved = await useLibraryStore.getState().saveBuilds([draft('A'), draft('B')]);
    const keep = await useLibraryStore.getState().saveBuild(draft('Keep'));
    const removed = await useLibraryStore.getState().removeBuilds([...saved.map((r) => r.id), 'nope']);
    expect(removed).toEqual(saved);
    expect((await db.builds.toArray()).map((b) => b.id)).toEqual([keep.id]);
    expect(useLibraryStore.getState().builds.map((b) => b.id)).toEqual([keep.id]);
    expect(await useLibraryStore.getState().removeBuilds(saved.map((r) => r.id))).toEqual([]);
  });
});

describe('library store: restoreBuilds (Undo for deletes)', () => {
  const draft = (name: string): Omit<Build, 'id' | 'updatedAt'> => ({
    name,
    characterId: 'jiyan',
    weaponId: 'verdant-summit',
    echoIds: [`${name}1`, `${name}2`, `${name}3`, `${name}4`, `${name}5`],
    objectiveId: 'Max ATK',
    objective: { kind: 'max-stat', stat: 'atk' },
  });

  it('removeBuild returns the row, and restoreBuilds puts it back verbatim, same id, same place', async () => {
    const [a, b, c] = await useLibraryStore.getState().saveBuilds([draft('A'), draft('B'), draft('C')]);
    const removed = await useLibraryStore.getState().removeBuild(b.id);
    expect(removed).toEqual(b);
    expect(useLibraryStore.getState().builds.map((x) => x.name)).toEqual(['A', 'C']);

    const { restored, skipped } = await useLibraryStore.getState().restoreBuilds([removed]);
    expect(restored).toEqual([b]);
    expect(skipped).toEqual([]);
    expect(await db.builds.get(b.id)).toEqual(b);
    expect(useLibraryStore.getState().builds.map((x) => x.id)).toEqual([a.id, b.id, c.id]);
  });

  it('writes a row the schema would now reject unchanged (no parse, like load())', async () => {
    const legacy = { ...(await useLibraryStore.getState().saveBuild(draft('Old'))), legacyField: 1 } as unknown as Build;
    await db.builds.put(legacy);
    await useLibraryStore.getState().load();
    const [row] = await useLibraryStore.getState().removeBuilds([legacy.id]);
    await useLibraryStore.getState().restoreBuilds([row]);
    expect(await db.builds.get(legacy.id)).toEqual(legacy);
  });

  it('never overwrites an id that exists again, and reports it as skipped', async () => {
    const [a, b] = await useLibraryStore.getState().saveBuilds([draft('A'), draft('B')]);
    const removed = await useLibraryStore.getState().removeBuilds([a.id, b.id]);
    // A backup restore in between brings A back, renamed.
    const backA = { ...a, name: 'A from the backup' };
    await db.builds.add(backA);
    await useLibraryStore.getState().load();

    const { restored, skipped } = await useLibraryStore.getState().restoreBuilds(removed);
    expect(restored.map((r) => r.id)).toEqual([b.id]);
    expect(skipped.map((r) => r.id)).toEqual([a.id]);
    expect(await db.builds.get(a.id)).toEqual(backA);
    expect(useLibraryStore.getState().builds.map((x) => x.name).sort()).toEqual(['A from the backup', 'B']);
  });

  it('writes nothing and leaves state untouched when the transaction fails', async () => {
    const [a, b] = await useLibraryStore.getState().saveBuilds([draft('A'), draft('B')]);
    const removed = await useLibraryStore.getState().removeBuilds([a.id, b.id]);
    const original = db.builds.bulkAdd.bind(db.builds);
    const spy = vi.spyOn(db.builds, 'bulkAdd').mockImplementation((async (items: unknown[]) => {
      await original([items[0]] as never);
      throw new Error('quota exceeded');
    }) as never);
    await expect(useLibraryStore.getState().restoreBuilds(removed)).rejects.toThrow('quota exceeded');
    spy.mockRestore();
    expect(await db.builds.count()).toBe(0);
    expect(useLibraryStore.getState().builds).toEqual([]);
  });

  it('load() bumps generation', async () => {
    const before = useLibraryStore.getState().generation;
    await useLibraryStore.getState().load();
    expect(useLibraryStore.getState().generation).toBe(before + 1);
  });
});
