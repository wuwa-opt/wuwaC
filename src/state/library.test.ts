import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from './db.ts';
import { serializeBuilds, useLibraryStore } from './library.ts';
import type { Build, SharedBuild } from '../data/schema.ts';
import { BACKUP_FORMAT, BACKUP_VERSION, parseBackup } from './backup.ts';
import { referenceBuildFrom } from './share.ts';

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
