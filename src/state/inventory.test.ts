import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ownedEchoSchema } from '../data/schema.ts';
import { db } from './db.ts';
import { useInventoryStore, type EchoDraft } from './inventory.ts';

const draft: EchoDraft = {
  label: 'Hooscamp',
  echoDefId: 'hooscamp',
  sonataId: 'sierra-gale',
  cost: 1,
  level: 25,
  rarity: 5,
  mainStat: { stat: 'atkPct', value: 0.18 },
  secondMainStat: { stat: 'atk', value: 100 },
  substats: [{ stat: 'critRate', value: 0.063 }],
  equippedTo: null,
};

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(async () => {
  await db.ownedEchoes.clear();
  useInventoryStore.setState({ echoes: [], loaded: false });
});

describe('inventory store', () => {
  it('starts empty and unloaded', () => {
    const state = useInventoryStore.getState();
    expect(state.echoes).toEqual([]);
    expect(state.loaded).toBe(false);
  });

  it('load() reads rows written directly to Dexie', async () => {
    await db.ownedEchoes.add({
      id: 'seed-1',
      label: 'Hooscamp',
      echoDefId: 'hooscamp',
      sonataId: 'sierra-gale',
      cost: 3,
      level: 25,
      rarity: 5,
      mainStat: { stat: 'dmgBonus:Aero', value: 0.3 },
      substats: [],
      equippedTo: null,
      origin: 'manual',
    });
    await useInventoryStore.getState().load();
    const state = useInventoryStore.getState();
    expect(state.loaded).toBe(true);
    expect(state.echoes.map((e) => e.id)).toEqual(['seed-1']);
  });

  it('addEcho keeps the picked def id, persists, and updates state', async () => {
    const created = await useInventoryStore.getState().addEcho(draft);
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.origin).toBe('manual');
    expect(created.echoDefId).toBe('hooscamp');
    expect(useInventoryStore.getState().echoes).toHaveLength(1);
    expect(await db.ownedEchoes.get(created.id)).toMatchObject({ label: 'Hooscamp' });
  });

  it('addEcho rejects def-inconsistent drafts without touching state or Dexie', async () => {
    const store = useInventoryStore.getState();
    await expect(store.addEcho({ ...draft, echoDefId: 'no-such-echo' })).rejects.toThrow(/unknown echo definition/);
    await expect(store.addEcho({ ...draft, cost: 4 })).rejects.toThrow(/1-cost Echo, not 4/);
    await expect(store.addEcho({ ...draft, sonataId: 'void-thunder' })).rejects.toThrow(/cannot roll/);
    await expect(store.addEcho({ ...draft, mainStat: { stat: 'critDmg', value: 0.44 } })).rejects.toThrow(/cannot roll/);
    expect(useInventoryStore.getState().echoes).toEqual([]);
    expect(await db.ownedEchoes.count()).toBe(0);
  });

  it('addEcho rejects invalid drafts without touching state or Dexie', async () => {
    await expect(
      useInventoryStore.getState().addEcho({
        ...draft,
        substats: [
          { stat: 'critRate', value: 0.05 },
          { stat: 'critRate', value: 0.06 },
        ],
      }),
    ).rejects.toThrow(/duplicate substats/);
    expect(useInventoryStore.getState().echoes).toEqual([]);
    expect(await db.ownedEchoes.count()).toBe(0);
  });

  it('updateEcho patches fields and persists', async () => {
    const created = await useInventoryStore.getState().addEcho(draft);
    const updated = await useInventoryStore.getState().updateEcho(created.id, {
      mainStat: { stat: 'atkPct', value: 0.1 },
    });
    expect(updated.mainStat.value).toBeCloseTo(0.1, 10);
    expect(await db.ownedEchoes.get(created.id)).toMatchObject({
      mainStat: { stat: 'atkPct', value: 0.1 },
    });
  });

  it('updateEcho keeps the def id when only the label changes', async () => {
    const created = await useInventoryStore.getState().addEcho(draft);
    const updated = await useInventoryStore.getState().updateEcho(created.id, {
      label: 'Hooscamp Alpha',
    });
    expect(updated.echoDefId).toBe('hooscamp');
    expect(updated.label).toBe('Hooscamp Alpha');
  });

  it('updateEcho rejects def-inconsistent patches', async () => {
    const created = await useInventoryStore.getState().addEcho(draft);
    const store = useInventoryStore.getState();
    await expect(store.updateEcho(created.id, { cost: 4 })).rejects.toThrow(/1-cost Echo/);
    await expect(store.updateEcho(created.id, { echoDefId: 'no-such-echo' })).rejects.toThrow(/unknown echo definition/);
    expect(useInventoryStore.getState().echoes[0].cost).toBe(1);
  });

  it('updateEcho throws for unknown ids', async () => {
    await expect(useInventoryStore.getState().updateEcho('missing', {})).rejects.toThrow(/unknown echo/);
  });

  it('importEchoes bulk-adds with the import origin, keeping existing rows', async () => {
    const store = useInventoryStore.getState();
    const before = await store.addEcho(draft);
    const imported = await store.importEchoes(
      [
        { ...draft, label: 'Imported One' },
        { ...draft, label: 'Imported Two' },
      ],
      'import:wuwa-inventory-kamera',
    );
    expect(imported.map((r) => r.origin)).toEqual([
      'import:wuwa-inventory-kamera',
      'import:wuwa-inventory-kamera',
    ]);
    expect(new Set(imported.map((r) => r.id)).size).toBe(2);
    expect(useInventoryStore.getState().echoes.map((e) => e.id)).toContain(before.id);
    expect(await db.ownedEchoes.count()).toBe(3);
  });

  it('importEchoes rejects a bad row with its index and writes nothing', async () => {
    const store = useInventoryStore.getState();
    await expect(
      store.importEchoes([{ ...draft }, { ...draft, echoDefId: 'no-such-echo' }], 'import:test'),
    ).rejects.toThrow(/import row 2: unknown echo definition/);
    expect(useInventoryStore.getState().echoes).toEqual([]);
    expect(await db.ownedEchoes.count()).toBe(0);
  });

  it('removeEcho deletes from state and Dexie, and throws for unknown ids', async () => {
    const created = await useInventoryStore.getState().addEcho(draft);
    await useInventoryStore.getState().removeEcho(created.id);
    expect(useInventoryStore.getState().echoes).toEqual([]);
    expect(await db.ownedEchoes.count()).toBe(0);
    await expect(useInventoryStore.getState().removeEcho(created.id)).rejects.toThrow(/unknown echo/);
  });
});

describe('inventory store: batch delete and restore', () => {
  const seed = async (n: number) => {
    const rows = [];
    for (let i = 0; i < n; i += 1) {
      rows.push(await useInventoryStore.getState().addEcho({ ...draft, label: `E${i}`, equippedTo: i === 0 ? 'jiyan' : null }));
    }
    return rows;
  };

  it('removeEchoes returns the exact rows removed and ignores unknown ids', async () => {
    const [a, b, c] = await seed(3);
    const removed = await useInventoryStore.getState().removeEchoes([a.id, c.id, 'nope', a.id]);
    expect(removed).toEqual([a, c]);
    expect(useInventoryStore.getState().echoes).toEqual([b]);
    expect((await db.ownedEchoes.toArray()).map((e) => e.id)).toEqual([b.id]);
  });

  it('removeEcho resolves to the row and still throws on an unknown id', async () => {
    const [a] = await seed(1);
    await expect(useInventoryStore.getState().removeEcho(a.id)).resolves.toEqual(a);
    await expect(useInventoryStore.getState().removeEcho(a.id)).rejects.toThrow(/unknown echo/);
  });

  it('round-trips: restoreEchoes puts identical rows back under the same ids (equippedTo kept)', async () => {
    const rows = await seed(3);
    const removed = await useInventoryStore.getState().removeEchoes(rows.map((r) => r.id));
    expect(useInventoryStore.getState().echoes).toEqual([]);

    const result = await useInventoryStore.getState().restoreEchoes(removed);

    expect(result.skipped).toEqual([]);
    expect(result.restored).toEqual(rows);
    expect(await db.ownedEchoes.bulkGet(rows.map((r) => r.id))).toEqual(rows);
    expect(useInventoryStore.getState().echoes.map((e) => e.id).sort()).toEqual(rows.map((r) => r.id).sort());
    expect(useInventoryStore.getState().echoes.find((e) => e.id === rows[0].id)?.equippedTo).toBe('jiyan');
  });

  it('restoring after ids reappeared (backup restore) skips them and never overwrites', async () => {
    const [a, b] = await seed(2);
    const removed = await useInventoryStore.getState().removeEchoes([a.id, b.id]);
    // A backup restore brings `a` back, edited, and reloads the store.
    const newer = { ...a, level: 5 };
    await db.ownedEchoes.put(newer);
    await useInventoryStore.getState().load();

    const result = await useInventoryStore.getState().restoreEchoes(removed);

    expect(result.restored).toEqual([b]);
    expect(result.skipped).toEqual([a]);
    expect(await db.ownedEchoes.get(a.id)).toEqual(newer);
    expect(await db.ownedEchoes.get(b.id)).toEqual(b);
    expect(useInventoryStore.getState().echoes.map((e) => e.id).sort()).toEqual([a.id, b.id].sort());
    expect(useInventoryStore.getState().echoes.find((e) => e.id === a.id)).toEqual(newer);
  });

  it('round-trips legacy rows unchanged: unknown keys kept, schema-rejected values kept', async () => {
    const legacyExtra = { ...draft, id: 'legacy-extra', origin: 'manual', oldField: { nested: [1, 2] } };
    const legacyInvalid = { ...draft, id: 'legacy-invalid', origin: 'manual', level: 999, rarity: 9 };
    expect(ownedEchoSchema.safeParse(legacyInvalid).success).toBe(false);
    await db.ownedEchoes.bulkAdd([legacyExtra, legacyInvalid] as never);
    await useInventoryStore.getState().load();

    const removed = await useInventoryStore.getState().removeEchoes(['legacy-extra', 'legacy-invalid']);
    const result = await useInventoryStore.getState().restoreEchoes(removed);

    expect(result.skipped).toEqual([]);
    expect(await db.ownedEchoes.get('legacy-extra')).toEqual(legacyExtra);
    expect(await db.ownedEchoes.get('legacy-invalid')).toEqual(legacyInvalid);
    expect(useInventoryStore.getState().echoes.find((e) => e.id === 'legacy-extra')).toEqual(legacyExtra);
  });

  it('restoring twice is harmless', async () => {
    const rows = await seed(2);
    const removed = await useInventoryStore.getState().removeEchoes(rows.map((r) => r.id));
    await useInventoryStore.getState().restoreEchoes(removed);
    const second = await useInventoryStore.getState().restoreEchoes(removed);
    expect(second.restored).toEqual([]);
    expect(second.skipped).toHaveLength(2);
    expect(useInventoryStore.getState().echoes).toHaveLength(2);
    expect(await db.ownedEchoes.count()).toBe(2);
  });

  it('a failing removeEchoes transaction rolls back and leaves state and Dexie untouched', async () => {
    const rows = await seed(3);
    const original = db.ownedEchoes.bulkDelete.bind(db.ownedEchoes);
    vi.spyOn(db.ownedEchoes, 'bulkDelete').mockImplementation((async (keys: string[]) => {
      await original([keys[0]]); // partially applied inside the transaction...
      throw new Error('disk full');
    }) as never);

    await expect(useInventoryStore.getState().removeEchoes(rows.map((r) => r.id))).rejects.toThrow('disk full');

    expect(await db.ownedEchoes.count()).toBe(3); // ...and rolled back
    expect(useInventoryStore.getState().echoes).toEqual(rows);
  });

  it('a failing restoreEchoes transaction rolls back and leaves state and Dexie untouched', async () => {
    const rows = await seed(3);
    const removed = await useInventoryStore.getState().removeEchoes(rows.map((r) => r.id));
    const original = db.ownedEchoes.bulkAdd.bind(db.ownedEchoes);
    vi.spyOn(db.ownedEchoes, 'bulkAdd').mockImplementation((async (items: unknown[]) => {
      await original([items[0]] as never);
      throw new Error('quota exceeded');
    }) as never);

    await expect(useInventoryStore.getState().restoreEchoes(removed)).rejects.toThrow('quota exceeded');

    expect(await db.ownedEchoes.count()).toBe(0);
    expect(useInventoryStore.getState().echoes).toEqual([]);
  });

  it('load() bumps generation so stale undo offers can be told apart', async () => {
    const before = useInventoryStore.getState().generation;
    await useInventoryStore.getState().load();
    expect(useInventoryStore.getState().generation).toBe(before + 1);
  });
});
