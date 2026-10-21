import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadBundledSnapshot } from '../data/index.ts';
import { ownedEchoSchema } from '../data/schema.ts';
import { db } from './db.ts';
import { useInventoryStore, type EchoDraft, type EchoFormDraft } from './inventory.ts';
import { resetSnapshotStoreForTests, useSnapshotStore } from './snapshotStore.ts';

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

  /** What the Echo form submits: every form-owned field, never equippedTo/locked/origin. */
  const formFields = (over: Partial<EchoFormDraft> = {}): EchoFormDraft => {
    const fields: EchoDraft = { ...draft, ...over };
    delete fields.equippedTo;
    delete fields.locked;
    return fields;
  };

  it('replaceEcho saves the edited fields and persists', async () => {
    const created = await useInventoryStore.getState().addEcho(draft);
    const updated = await useInventoryStore.getState().replaceEcho(created.id, formFields({ mainStat: { stat: 'atkPct', value: 0.1 } }));
    expect(updated.mainStat.value).toBeCloseTo(0.1, 10);
    expect(await db.ownedEchoes.get(created.id)).toMatchObject({ mainStat: { stat: 'atkPct', value: 0.1 } });
  });

  it('replaceEcho keeps id, origin, equippedTo and locked (the form never shows them)', async () => {
    const created = await useInventoryStore.getState().addEcho({ ...draft, equippedTo: 'jiyan' });
    await useInventoryStore.getState().setLocked([created.id], true);
    const updated = await useInventoryStore.getState().replaceEcho(created.id, formFields({ level: 20 }));
    expect(updated).toMatchObject({ id: created.id, origin: 'manual', level: 20, equippedTo: 'jiyan', locked: true });
    expect(await db.ownedEchoes.get(created.id)).toMatchObject({ level: 20, equippedTo: 'jiyan', locked: true });
    expect(useInventoryStore.getState().echoes[0]).toEqual(updated);
  });

  it('replaceEcho keeps an unlocked, unequipped Echo that way (no `locked` key appears)', async () => {
    const created = await useInventoryStore.getState().addEcho(draft);
    const updated = await useInventoryStore.getState().replaceEcho(created.id, formFields({ level: 3 }));
    expect(updated.equippedTo).toBeNull();
    expect(updated).not.toHaveProperty('locked');
  });

  it('replaceEcho ignores equippedTo, locked, origin and id even if a caller smuggles them in', async () => {
    const created = await useInventoryStore.getState().addEcho({ ...draft, equippedTo: 'jiyan' });
    const sneaky = { ...formFields(), equippedTo: null, locked: true, origin: 'evil', id: 'other' } as EchoFormDraft;
    const updated = await useInventoryStore.getState().replaceEcho(created.id, sneaky);
    expect(updated).toMatchObject({ id: created.id, origin: 'manual', equippedTo: 'jiyan' });
    expect(updated).not.toHaveProperty('locked');
  });

  it('replaceEcho clears optional fields the form left out (nickname, second main stat, substats)', async () => {
    const created = await useInventoryStore.getState().addEcho(draft);
    expect(created).toMatchObject({ label: 'Hooscamp', secondMainStat: { stat: 'atk', value: 100 } });
    const bare = formFields({ substats: [] });
    delete bare.label;
    delete bare.secondMainStat;
    const updated = await useInventoryStore.getState().replaceEcho(created.id, bare);
    expect(updated).not.toHaveProperty('label');
    expect(updated).not.toHaveProperty('secondMainStat');
    expect(updated.substats).toEqual([]);
    const stored = await db.ownedEchoes.get(created.id);
    expect(stored).not.toHaveProperty('label');
    expect(stored).not.toHaveProperty('secondMainStat');
    expect(stored?.substats).toEqual([]);
  });

  describe('replaceEcho and substat rolls', () => {
    // `rolls` can only arrive through a restored backup or pasted JSON, so the row is seeded in Dexie.
    const seedRolled = async (): Promise<string> => {
      await db.ownedEchoes.add({
        ...formFields({
          substats: [
            { stat: 'critRate', value: 0.081, rolls: 2 },
            { stat: 'atkPct', value: 0.09 },
            { stat: 'critDmg', value: 0.126, rolls: 1 },
          ],
        }),
        id: 'rolled',
        origin: 'manual',
        equippedTo: null,
      });
      await useInventoryStore.getState().load();
      return 'rolled';
    };

    it('keeps a substat\'s rolls when an edit changes only the level', async () => {
      const id = await seedRolled();
      const { substats } = useInventoryStore.getState().echoes[0];
      const updated = await useInventoryStore.getState().replaceEcho(id, formFields({ level: 20, substats: substats.map(({ stat, value }) => ({ stat, value })) }));
      expect(updated.level).toBe(20);
      expect(updated.substats).toEqual([
        { stat: 'critRate', value: 0.081, rolls: 2 },
        { stat: 'atkPct', value: 0.09 },
        { stat: 'critDmg', value: 0.126, rolls: 1 },
      ]);
      expect((await db.ownedEchoes.get(id))?.substats).toEqual(updated.substats);
    });

    it('still matches a value the form round-tripped through display text', async () => {
      const id = await seedRolled();
      // 0.0007 -> "0.07" -> 0.07 / 100 is 0.0007000000000000001 in floating point.
      await db.ownedEchoes.update(id, { substats: [{ stat: 'critRate', value: 0.0007, rolls: 3 }] });
      await useInventoryStore.getState().load();
      const updated = await useInventoryStore.getState().replaceEcho(id, formFields({ substats: [{ stat: 'critRate', value: 0.07 / 100 }] }));
      expect(updated.substats).toEqual([{ stat: 'critRate', value: 0.07 / 100, rolls: 3 }]);
    });

    it('drops rolls from a substat whose value changed, but keeps the unchanged ones', async () => {
      const id = await seedRolled();
      const updated = await useInventoryStore.getState().replaceEcho(
        id,
        formFields({
          substats: [
            { stat: 'critRate', value: 0.087 },
            { stat: 'atkPct', value: 0.09 },
            { stat: 'critDmg', value: 0.126 },
          ],
        }),
      );
      expect(updated.substats[0]).toEqual({ stat: 'critRate', value: 0.087 });
      expect(updated.substats[0]).not.toHaveProperty('rolls');
      expect(updated.substats[2]).toEqual({ stat: 'critDmg', value: 0.126, rolls: 1 });
      expect((await db.ownedEchoes.get(id))?.substats[0]).not.toHaveProperty('rolls');
    });

    it('drops rolls when the stat changes, and never moves them to another stat', async () => {
      const id = await seedRolled();
      const updated = await useInventoryStore.getState().replaceEcho(
        id,
        formFields({ substats: [{ stat: 'energyRegen', value: 0.081 }, { stat: 'critDmg', value: 0.126 }] }),
      );
      expect(updated.substats).toEqual([
        { stat: 'energyRegen', value: 0.081 },
        { stat: 'critDmg', value: 0.126, rolls: 1 },
      ]);
    });

    it('gives a new Echo no rolls, and keeps what a caller submits explicitly', async () => {
      const created = await useInventoryStore.getState().addEcho(formFields({ substats: [{ stat: 'critRate', value: 0.081 }] }));
      expect(created.substats[0]).not.toHaveProperty('rolls');
      const edited = await useInventoryStore.getState().replaceEcho(created.id, formFields({ substats: [{ stat: 'critRate', value: 0.081 }] }));
      expect(edited.substats[0]).not.toHaveProperty('rolls');
      const explicit = await useInventoryStore.getState().replaceEcho(created.id, formFields({ substats: [{ stat: 'critRate', value: 0.081, rolls: 4 }] }));
      expect(explicit.substats[0].rolls).toBe(4);
    });
  });

  it('replaceEcho keeps the def id when only the label changes', async () => {
    const created = await useInventoryStore.getState().addEcho(draft);
    const updated = await useInventoryStore.getState().replaceEcho(created.id, formFields({ label: 'Hooscamp Alpha' }));
    expect(updated.echoDefId).toBe('hooscamp');
    expect(updated.label).toBe('Hooscamp Alpha');
  });

  it('addEcho without equippedTo starts unequipped', async () => {
    const created = await useInventoryStore.getState().addEcho(formFields());
    expect(created.equippedTo).toBeNull();
  });

  it('replaceEcho rejects def-inconsistent edits and leaves state and Dexie as they were', async () => {
    const created = await useInventoryStore.getState().addEcho(draft);
    const store = useInventoryStore.getState();
    await expect(store.replaceEcho(created.id, formFields({ cost: 4 }))).rejects.toThrow(/1-cost Echo/);
    await expect(store.replaceEcho(created.id, formFields({ echoDefId: 'no-such-echo' }))).rejects.toThrow(/unknown echo definition/);
    expect(useInventoryStore.getState().echoes[0].cost).toBe(1);
    expect((await db.ownedEchoes.get(created.id))?.cost).toBe(1);
  });

  it('replaceEcho throws for unknown ids', async () => {
    await expect(useInventoryStore.getState().replaceEcho('missing', formFields())).rejects.toThrow(/unknown echo/);
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

describe('inventory store: locks', () => {
  const seed = async (n: number) => {
    const rows = [];
    for (let i = 0; i < n; i += 1) rows.push(await useInventoryStore.getState().addEcho({ ...draft, label: `L${i}` }));
    return rows;
  };

  it('setLocked locks and unlocks, persisting `locked: true` or no key at all', async () => {
    const [a, b] = await seed(2);
    const locked = await useInventoryStore.getState().setLocked([a.id], true);
    expect(locked).toEqual([{ ...a, locked: true }]);
    expect(await db.ownedEchoes.get(a.id)).toEqual({ ...a, locked: true });
    expect(useInventoryStore.getState().echoes.find((e) => e.id === a.id)?.locked).toBe(true);
    expect(useInventoryStore.getState().echoes.find((e) => e.id === b.id)).toEqual(b);

    await useInventoryStore.getState().setLocked([a.id], false);
    expect(await db.ownedEchoes.get(a.id)).toEqual(a);
    expect(await db.ownedEchoes.get(a.id)).not.toHaveProperty('locked');
  });

  it('setLocked ignores unknown ids and rows already in that state', async () => {
    const [a] = await seed(1);
    expect(await useInventoryStore.getState().setLocked(['nope'], true)).toEqual([]);
    expect(await useInventoryStore.getState().setLocked([a.id], false)).toEqual([]);
    await useInventoryStore.getState().setLocked([a.id], true);
    expect(await useInventoryStore.getState().setLocked([a.id], true)).toEqual([]);
  });

  it('a failing setLocked transaction rolls back and leaves state untouched', async () => {
    const rows = await seed(3);
    const original = db.ownedEchoes.bulkPut.bind(db.ownedEchoes);
    vi.spyOn(db.ownedEchoes, 'bulkPut').mockImplementation((async (items: unknown[]) => {
      await original([items[0]] as never);
      throw new Error('disk full');
    }) as never);
    await expect(useInventoryStore.getState().setLocked(rows.map((r) => r.id), true)).rejects.toThrow('disk full');
    expect((await db.ownedEchoes.toArray()).some((e) => e.locked)).toBe(false);
    expect(useInventoryStore.getState().echoes).toEqual(rows);
  });

  it('removeEcho throws on a locked Echo and deletes it once unlocked', async () => {
    const [a] = await seed(1);
    await useInventoryStore.getState().setLocked([a.id], true);
    await expect(useInventoryStore.getState().removeEcho(a.id)).rejects.toThrow(/locked/);
    expect(await db.ownedEchoes.count()).toBe(1);
    await useInventoryStore.getState().setLocked([a.id], false);
    await expect(useInventoryStore.getState().removeEcho(a.id)).resolves.toEqual(a);
  });

  it('removeEchoes skips locked Echoes and returns only what it deleted', async () => {
    const [a, b, c] = await seed(3);
    await useInventoryStore.getState().setLocked([b.id], true);
    const removed = await useInventoryStore.getState().removeEchoes([a.id, b.id, c.id]);
    expect(removed).toEqual([a, c]);
    expect((await db.ownedEchoes.toArray()).map((e) => e.id)).toEqual([b.id]);
    expect(useInventoryStore.getState().echoes.map((e) => e.id)).toEqual([b.id]);
  });

  it('replaceEcho keeps the lock', async () => {
    const [a] = await seed(1);
    await useInventoryStore.getState().setLocked([a.id], true);
    const fields: EchoDraft = { ...a, level: 20 };
    delete fields.equippedTo;
    delete fields.locked;
    const updated = await useInventoryStore.getState().replaceEcho(a.id, fields);
    expect(updated.locked).toBe(true);
    expect((await db.ownedEchoes.get(a.id))?.locked).toBe(true);
  });
});

describe('inventory store: equipped reassignment', () => {
  const seed = async () => {
    const rows = [];
    for (const [i, who] of ([['jiyan'], ['jiyan'], ['verina'], [null]] as const).entries()) {
      rows.push(await useInventoryStore.getState().addEcho({ ...draft, label: `E${i}`, equippedTo: who[0] }));
    }
    return rows;
  };
  const worn = async (): Promise<(string | null)[]> =>
    (await db.ownedEchoes.toArray()).sort((a, b) => (a.label ?? '').localeCompare(b.label ?? '')).map((e) => e.equippedTo);

  it('reassignEquipped returns the previous values of changed rows only, in Dexie and state', async () => {
    const [a, b, c, d] = await seed();
    const previous = await useInventoryStore.getState().reassignEquipped([
      { id: a.id, equippedTo: null },
      { id: b.id, equippedTo: 'jiyan' }, // already there
      { id: c.id, equippedTo: 'yangyang' },
      { id: d.id, equippedTo: 'jiyan' },
      { id: 'missing', equippedTo: 'jiyan' },
    ]);
    expect(previous).toEqual([
      { id: a.id, equippedTo: 'jiyan' },
      { id: c.id, equippedTo: 'verina' },
      { id: d.id, equippedTo: null },
    ]);
    expect(await worn()).toEqual([null, 'jiyan', 'yangyang', 'jiyan']);
    expect(useInventoryStore.getState().echoes.map((e) => e.equippedTo)).toEqual([null, 'jiyan', 'yangyang', 'jiyan']);
  });

  it('writes through locks and keeps every other field', async () => {
    const [a] = await seed();
    await useInventoryStore.getState().setLocked([a.id], true);
    await useInventoryStore.getState().reassignEquipped([{ id: a.id, equippedTo: 'verina' }]);
    expect(await db.ownedEchoes.get(a.id)).toEqual({ ...a, locked: true, equippedTo: 'verina' });
  });

  it('a failing reassignEquipped transaction rolls back and leaves state and Dexie untouched', async () => {
    const rows = await seed();
    const original = db.ownedEchoes.bulkPut.bind(db.ownedEchoes);
    vi.spyOn(db.ownedEchoes, 'bulkPut').mockImplementation((async (items: unknown[]) => {
      await original([items[0]] as never); // partially applied inside the transaction...
      throw new Error('disk full');
    }) as never);

    await expect(
      useInventoryStore.getState().reassignEquipped(rows.map((r) => ({ id: r.id, equippedTo: 'calcharo' }))),
    ).rejects.toThrow('disk full');

    expect(await worn()).toEqual(['jiyan', 'jiyan', 'verina', null]); // ...and rolled back
    expect(useInventoryStore.getState().echoes).toEqual(rows);
  });

  it('restoreEquipped puts the previous values back', async () => {
    const rows = await seed();
    const applied = rows.map((r) => ({ id: r.id, equippedTo: 'calcharo' as string | null }));
    const previous = await useInventoryStore.getState().reassignEquipped(applied);
    expect(await worn()).toEqual(['calcharo', 'calcharo', 'calcharo', 'calcharo']);

    const { restored, skipped } = await useInventoryStore.getState().restoreEquipped(previous, applied);

    expect(restored.sort()).toEqual(rows.map((r) => r.id).sort());
    expect(skipped).toEqual([]);
    expect(await worn()).toEqual(['jiyan', 'jiyan', 'verina', null]);
    expect(useInventoryStore.getState().echoes).toEqual(rows);
  });

  it('restoreEquipped skips rows changed or deleted since, and reports them', async () => {
    const [a, b, c, d] = await seed();
    const applied = [a, b, c, d].map((r) => ({ id: r.id, equippedTo: 'calcharo' as string | null }));
    const previous = await useInventoryStore.getState().reassignEquipped(applied);
    await useInventoryStore.getState().reassignEquipped([{ id: b.id, equippedTo: 'yangyang' }]); // moved on
    await useInventoryStore.getState().removeEchoes([c.id]); // gone

    const { restored, skipped } = await useInventoryStore.getState().restoreEquipped(previous, applied);

    expect(restored.sort()).toEqual([a.id, d.id].sort());
    expect(skipped.sort()).toEqual([b.id, c.id].sort());
    expect(await db.ownedEchoes.get(a.id)).toMatchObject({ equippedTo: 'jiyan' });
    expect(await db.ownedEchoes.get(b.id)).toMatchObject({ equippedTo: 'yangyang' });
    expect(useInventoryStore.getState().echoes.find((e) => e.id === b.id)?.equippedTo).toBe('yangyang');
  });

  it('a failing restoreEquipped transaction rolls back', async () => {
    const rows = await seed();
    const applied = rows.map((r) => ({ id: r.id, equippedTo: 'calcharo' as string | null }));
    const previous = await useInventoryStore.getState().reassignEquipped(applied);
    const original = db.ownedEchoes.bulkPut.bind(db.ownedEchoes);
    vi.spyOn(db.ownedEchoes, 'bulkPut').mockImplementation((async (items: unknown[]) => {
      await original([items[0]] as never);
      throw new Error('quota exceeded');
    }) as never);

    await expect(useInventoryStore.getState().restoreEquipped(previous, applied)).rejects.toThrow('quota exceeded');

    expect(await worn()).toEqual(['calcharo', 'calcharo', 'calcharo', 'calcharo']);
    expect(useInventoryStore.getState().echoes.every((e) => e.equippedTo === 'calcharo')).toBe(true);
  });
});

describe('inventory store: active snapshot', () => {
  const newDef = (): EchoDraft => ({ ...draft, echoDefId: 'published-later', label: undefined });

  afterEach(() => {
    resetSnapshotStoreForTests();
  });

  it('rejects an Echo def only a newer publication holds until that snapshot is active', async () => {
    await expect(useInventoryStore.getState().addEcho(newDef())).rejects.toThrow(/unknown echo definition/);
  });

  it('add, edit and import accept a def from the active snapshot that the bundle lacks', async () => {
    const bundled = loadBundledSnapshot();
    const hooscamp = bundled.echoDefs.find((d) => d.id === 'hooscamp');
    if (!hooscamp) throw new Error('fixture: hooscamp missing from the bundle');
    expect(bundled.echoDefs.some((d) => d.id === 'published-later')).toBe(false);
    useSnapshotStore.setState({
      snapshot: { ...bundled, echoDefs: [...bundled.echoDefs, { ...hooscamp, id: 'published-later', name: 'Published Later' }] },
      source: 'cache',
    });

    const store = useInventoryStore.getState();
    const created = await store.addEcho(newDef());
    expect(created.echoDefId).toBe('published-later');
    const updated = await store.replaceEcho(created.id, { ...newDef(), level: 10 });
    expect(updated.level).toBe(10);
    const [imported] = await store.importEchoes([newDef()], 'import:test');
    expect(imported.echoDefId).toBe('published-later');
  });
});
