import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadBundledSnapshot } from '../data/index.ts';
import type { Build, RosterEntry, Team } from '../data/schema.ts';
import { BACKUP_FORMAT, createBackup, parseBackup, restoreBackup } from './backup.ts';
import { db } from './db.ts';
import { useInventoryStore } from './inventory.ts';
import { useRosterStore } from './roster.ts';
import { buildSeedEchoes } from './seed.ts';

const entry: RosterEntry = {
  characterId: 'jiyan',
  level: 90,
  ascension: 6,
  resonanceChain: 0,
  forteLevels: {},
  weaponId: 'verdant-summit',
  weaponLevel: 90,
  weaponRank: 1,
};

const build: Build = {
  id: 'build-1',
  updatedAt: '2026-10-01T00:00:00.000Z',
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

const team: Team = { id: 'team-1', name: 'Main', characterIds: ['jiyan', 'verina', 'rover'] };

// Deterministic PRNG so seeded echoes are stable across runs.
function lcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 2 ** 32;
    return s / 2 ** 32;
  };
}

const echoes = buildSeedEchoes(loadBundledSnapshot().echoDefs, 3, lcg(7));

async function clearAll(): Promise<void> {
  await Promise.all([db.ownedEchoes.clear(), db.roster.clear(), db.builds.clear(), db.teams.clear()]);
}

async function seedAll(): Promise<void> {
  await db.ownedEchoes.bulkAdd(echoes);
  await db.roster.add(entry);
  await db.builds.add(build);
  await db.teams.add(team);
}

beforeEach(async () => {
  await clearAll();
  useInventoryStore.setState({ echoes: [], loaded: false });
  useRosterStore.setState({ entries: [], loaded: false });
});

describe('backup', () => {
  it('createBackup captures all four user tables with a fixed header', async () => {
    await seedAll();
    const backup = await createBackup(new Date('2026-10-09T12:00:00.000Z'));
    expect(backup.format).toBe(BACKUP_FORMAT);
    expect(backup.version).toBe(1);
    expect(backup.exportedAt).toBe('2026-10-09T12:00:00.000Z');
    expect(backup.tables.ownedEchoes).toHaveLength(3);
    expect(backup.tables.roster).toEqual([entry]);
    expect(backup.tables.builds).toEqual([build]);
    expect(backup.tables.teams).toEqual([team]);
  });

  it('round-trips through JSON: export, wipe, restore', async () => {
    await seedAll();
    const json = JSON.parse(JSON.stringify(await createBackup())) as unknown;
    await clearAll();

    const counts = await restoreBackup(parseBackup(json), 'replace');

    expect(counts).toEqual({ ownedEchoes: 3, roster: 1, builds: 1, teams: 1 });
    expect(await db.ownedEchoes.count()).toBe(3);
    expect(await db.roster.get('jiyan')).toEqual(entry);
    expect(await db.builds.get('build-1')).toEqual(build);
    expect(await db.teams.get('team-1')).toEqual(team);
    // In-memory stores reload so the UI reflects the restore.
    expect(useInventoryStore.getState().echoes).toHaveLength(3);
    expect(useRosterStore.getState().loaded).toBe(true);
  });

  it('round-trips locked Echoes, and a backup from before locks still imports unlocked', async () => {
    await db.ownedEchoes.bulkAdd([{ ...echoes[0], locked: true }, echoes[1]]);
    const json = JSON.parse(JSON.stringify(await createBackup())) as {
      tables: { ownedEchoes: Record<string, unknown>[] };
    };
    expect(json.tables.ownedEchoes.find((e) => e.id === echoes[0].id)?.locked).toBe(true);
    expect(json.tables.ownedEchoes.find((e) => e.id === echoes[1].id)).not.toHaveProperty('locked');
    await clearAll();

    await restoreBackup(parseBackup(json), 'replace');
    expect((await db.ownedEchoes.get(echoes[0].id))?.locked).toBe(true);
    expect(await db.ownedEchoes.get(echoes[1].id)).not.toHaveProperty('locked');

    // A pre-lock backup (rows never had the key) parses and restores as-is.
    const old = { ...json, tables: { ...json.tables, ownedEchoes: json.tables.ownedEchoes.map((e) => Object.fromEntries(Object.entries(e).filter(([k]) => k !== 'locked'))) } };
    await clearAll();
    await restoreBackup(parseBackup(old), 'replace');
    expect(await db.ownedEchoes.count()).toBe(2);
    expect((await db.ownedEchoes.toArray()).some((e) => e.locked)).toBe(false);
  });

  it('replace drops rows absent from the backup; merge keeps them', async () => {
    const backup = parseBackup(JSON.parse(JSON.stringify(await createBackup())) as unknown); // empty
    await db.teams.add(team);

    await restoreBackup(backup, 'merge');
    expect(await db.teams.count()).toBe(1);

    await restoreBackup(backup, 'replace');
    expect(await db.teams.count()).toBe(0);
  });

  it('merge overwrites same-id rows with the backup copy', async () => {
    await db.teams.add(team);
    const backup = await createBackup();
    await db.teams.put({ ...team, name: 'Renamed' });

    await restoreBackup(backup, 'merge');
    expect((await db.teams.get('team-1'))?.name).toBe('Main');
  });

  it('rejects non-backups and invalid rows without writing', async () => {
    expect(() => parseBackup([build])).toThrow(/not a valid WuWa Optimizer backup/);
    expect(() => parseBackup({ format: BACKUP_FORMAT, version: 2, exportedAt: '', tables: {} })).toThrow(
      /at version/,
    );
    const bad = {
      format: BACKUP_FORMAT,
      version: 1,
      exportedAt: '2026-10-09T00:00:00.000Z',
      tables: { ownedEchoes: [], roster: [{ ...entry, level: 0 }], builds: [], teams: [] },
    };
    expect(() => parseBackup(bad)).toThrow(/at tables\.roster\.0\.level/);
    expect(await db.roster.count()).toBe(0);
  });

  describe('saved build context (optional field, backup format stays v1)', () => {
    const withContext: Build = {
      ...build,
      id: 'build-ctx',
      context: { ...entry, level: 70, resonanceChain: 2, forteLevels: { '1001103': 9 }, weaponLevel: 60, weaponAscension: 3, weaponRank: 2 },
    };

    it('a v1 backup without context still parses and restores unchanged', async () => {
      const legacy = {
        format: BACKUP_FORMAT,
        version: 1,
        exportedAt: '2026-10-01T00:00:00.000Z',
        tables: { ownedEchoes: [], roster: [entry], builds: [build], teams: [] },
      };
      const parsed = parseBackup(legacy);
      expect(parsed.tables.builds[0]).toEqual(build);
      expect(parsed.tables.builds[0].context).toBeUndefined();
      await restoreBackup(parsed, 'replace');
      expect(await db.builds.get('build-1')).toEqual(build);
    });

    it('round-trips a build with context through JSON backup and restore', async () => {
      await db.builds.add(withContext);
      const json = JSON.parse(JSON.stringify(await createBackup())) as unknown;
      expect((json as { version: number }).version).toBe(1);
      await clearAll();
      await restoreBackup(parseBackup(json), 'replace');
      expect(await db.builds.get('build-ctx')).toEqual(withContext);
    });
  });
});
