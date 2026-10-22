import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHARACTER_LEVEL,
  DEFAULT_FORTE_LEVEL,
  DEFAULT_ROTATION_TIME,
  selectBlockStartTimes,
  useCalculatorStore,
  type EchoSlots,
} from './calculator.ts';
import type { RosterEntry } from '../data/schema.ts';

const entry: RosterEntry = {
  characterId: 'jiyan',
  level: 80,
  ascension: 5,
  resonanceChain: 2,
  forteLevels: { '1001101': 8 },
  weaponId: 'verdant-summit',
  weaponLevel: 70,
  weaponRank: 3,
};

function freshState() {
  useCalculatorStore.getState().resetAll();
  return useCalculatorStore.getState();
}

describe('calculator store', () => {
  it('starts with documented defaults', () => {
    const s = freshState();
    expect(s.characterId).toBe('');
    expect(s.level).toBe(DEFAULT_CHARACTER_LEVEL);
    expect(s.enemyLevel).toBe(90);
    expect(s.enemyBaseRES).toBeCloseTo(0.1, 10);
    expect(s.rotationTime).toBe(DEFAULT_ROTATION_TIME);
    expect(s.echoIds).toEqual([null, null, null, null, null]);
  });

  it('clamps level and forte sliders into range', () => {
    freshState();
    useCalculatorStore.getState().setLevel(0);
    expect(useCalculatorStore.getState().level).toBe(1);
    useCalculatorStore.getState().setLevel(91);
    expect(useCalculatorStore.getState().level).toBe(90);
    useCalculatorStore.getState().setForteLevel('1001101', 11);
    expect(useCalculatorStore.getState().forteLevels['1001101']).toBe(10);
    useCalculatorStore.getState().setForteLevel('1001101', 0);
    expect(useCalculatorStore.getState().forteLevels['1001101']).toBe(1);
    expect(DEFAULT_FORTE_LEVEL).toBe(10);
  });

  it('clamps enemy and rotation-time inputs', () => {
    freshState();
    useCalculatorStore.getState().setEnemyLevel(121);
    expect(useCalculatorStore.getState().enemyLevel).toBe(120);
    useCalculatorStore.getState().setEnemyBaseRES(0.9);
    expect(useCalculatorStore.getState().enemyBaseRES).toBeCloseTo(0.8, 10);
    // Non-positive times are ignored — DPS divides by this value.
    useCalculatorStore.getState().setRotationTime(0);
    expect(useCalculatorStore.getState().rotationTime).toBe(DEFAULT_ROTATION_TIME);
    useCalculatorStore.getState().setRotationTime(-5);
    expect(useCalculatorStore.getState().rotationTime).toBe(DEFAULT_ROTATION_TIME);
    useCalculatorStore.getState().setRotationTime(12.5);
    expect(useCalculatorStore.getState().rotationTime).toBeCloseTo(12.5, 10);
  });

  it('ignores non-finite numeric input instead of corrupting state', () => {
    freshState();
    useCalculatorStore.getState().setLevel(Number.NaN);
    expect(useCalculatorStore.getState().level).toBe(DEFAULT_CHARACTER_LEVEL);
    useCalculatorStore.getState().setEnemyBaseRES(Number.NaN);
    expect(useCalculatorStore.getState().enemyBaseRES).toBeCloseTo(0.1, 10);
  });

  it('drops stale forte levels when the character changes', () => {
    freshState();
    useCalculatorStore.getState().setCharacterId('jiyan');
    useCalculatorStore.getState().setForteLevel('1001101', 8);
    useCalculatorStore.getState().setCharacterId('verina');
    const s = useCalculatorStore.getState();
    expect(s.characterId).toBe('verina');
    expect(s.forteLevels).toEqual({});
  });

  it('drops rotation blocks but keeps buffs when the character changes', () => {
    freshState();
    const store = useCalculatorStore.getState();
    store.setCharacterId('jiyan');
    const buff = store.addBuff({ label: 'B', source: 'test', mods: [] });
    useCalculatorStore.getState().toggleGlobalBuff(buff.id);
    const block = useCalculatorStore.getState().addBlock({ skillId: 's1', motionName: 'M1', forteLevel: 10, activeBuffIds: [buff.id] });
    expect(useCalculatorStore.getState().blocks).toHaveLength(1);

    // Same-character re-pick keeps the rotation.
    useCalculatorStore.getState().setCharacterId('jiyan');
    expect(useCalculatorStore.getState().blocks.map((b) => b.id)).toEqual([block.id]);

    useCalculatorStore.getState().setCharacterId('verina');
    const s = useCalculatorStore.getState();
    expect(s.blocks).toEqual([]);
    // Buffs are skill-agnostic stat mods — they survive with their global flags.
    expect(s.buffs.map((b) => b.id)).toEqual([buff.id]);
    expect(s.globalBuffIds).toEqual([buff.id]);
  });

  it('drops rotation blocks on cross-character roster refills only', () => {
    freshState();
    useCalculatorStore.getState().resetFromRoster(entry);
    const block = useCalculatorStore.getState().addBlock({ skillId: 's1', motionName: 'M1', forteLevel: 10, activeBuffIds: [] });

    // Same-character refill keeps the rotation.
    useCalculatorStore.getState().resetFromRoster({ ...entry, level: 90 });
    expect(useCalculatorStore.getState().blocks.map((b) => b.id)).toEqual([block.id]);

    useCalculatorStore.getState().resetFromRoster({ ...entry, characterId: 'verina' });
    const s = useCalculatorStore.getState();
    expect(s.characterId).toBe('verina');
    expect(s.blocks).toEqual([]);
  });

  it('sets and clears echo slots; ignores out-of-range indexes', () => {
    freshState();
    useCalculatorStore.getState().setEchoSlot(0, 'echo-a');
    useCalculatorStore.getState().setEchoSlot(4, 'echo-b');
    expect(useCalculatorStore.getState().echoIds).toEqual(['echo-a', null, null, null, 'echo-b']);
    useCalculatorStore.getState().setEchoSlot(5, 'echo-c');
    useCalculatorStore.getState().setEchoSlot(-1, 'echo-c');
    const slots = useCalculatorStore.getState().echoIds as EchoSlots;
    expect(slots.filter(Boolean)).toHaveLength(2);
    useCalculatorStore.getState().clearEchoes();
    expect(useCalculatorStore.getState().echoIds).toEqual([null, null, null, null, null]);
  });

  it('prefills everything from a roster entry', () => {
    freshState();
    useCalculatorStore.getState().resetFromRoster(entry);
    const s = useCalculatorStore.getState();
    expect(s.characterId).toBe('jiyan');
    expect(s.level).toBe(80);
    expect(s.ascension).toBe(5);
    expect(s.resonanceChain).toBe(2);
    expect(s.forteLevels).toEqual({ '1001101': 8 });
    expect(s.weaponId).toBe('verdant-summit');
    expect(s.weaponLevel).toBe(70);
    expect(s.weaponRank).toBe(3);
    expect(s.rosterSourceId).toBe('jiyan');
  });

  it('prefills weapon ascension + forte unlocks, defaulting absent fields', () => {
    freshState();
    useCalculatorStore.getState().resetFromRoster({
      ...entry,
      weaponAscension: 4,
      forteUnlockedIds: ['185', '186'],
    });
    let s = useCalculatorStore.getState();
    expect(s.weaponAscension).toBe(4);
    expect(s.forteUnlockedIds).toEqual(['185', '186']);
    // Legacy entries without the fields: pre-ascension weapon, all nodes on.
    useCalculatorStore.getState().resetFromRoster(entry);
    s = useCalculatorStore.getState();
    expect(s.weaponAscension).toBe(0);
    expect(s.forteUnlockedIds).toBeNull();
  });

  it('clamps the weapon ascension slider and resets unlocks on character switch', () => {
    freshState();
    useCalculatorStore.getState().setWeaponAscension(9);
    expect(useCalculatorStore.getState().weaponAscension).toBe(6);
    useCalculatorStore.getState().setWeaponAscension(-1);
    expect(useCalculatorStore.getState().weaponAscension).toBe(0);
    useCalculatorStore.getState().setCharacterId('jiyan');
    useCalculatorStore.getState().setForteUnlockedIds(['185']);
    useCalculatorStore.getState().setCharacterId('verina');
    expect(useCalculatorStore.getState().forteUnlockedIds).toBeNull();
  });

  it('resetAll restores defaults', () => {
    freshState();
    useCalculatorStore.getState().resetFromRoster(entry);
    useCalculatorStore.getState().resetAll();
    const s = useCalculatorStore.getState();
    expect(s.characterId).toBe('');
    expect(s.forteLevels).toEqual({});
    expect(s.rosterSourceId).toBe('');
    expect(s.weaponAscension).toBe(0);
    expect(s.forteUnlockedIds).toBeNull();
  });

  it('adds, reorders, and removes blocks', () => {
    freshState();
    const store = useCalculatorStore.getState();
    const a = store.addBlock({ skillId: 's1', motionName: 'M1', forteLevel: 10, activeBuffIds: [] });
    const b = useCalculatorStore.getState().addBlock({ skillId: 's2', motionName: 'M2', forteLevel: 8, activeBuffIds: [] });
    expect(a.id).not.toBe(b.id);
    expect(useCalculatorStore.getState().blocks.map((x) => x.id)).toEqual([a.id, b.id]);

    useCalculatorStore.getState().moveBlock(a.id, 1);
    expect(useCalculatorStore.getState().blocks.map((x) => x.id)).toEqual([b.id, a.id]);
    // Out-of-range moves are no-ops.
    useCalculatorStore.getState().moveBlock(a.id, 1);
    expect(useCalculatorStore.getState().blocks.map((x) => x.id)).toEqual([b.id, a.id]);

    useCalculatorStore.getState().setBlockForte(b.id, 99);
    expect(useCalculatorStore.getState().blocks.find((x) => x.id === b.id)?.forteLevel).toBe(10);
    useCalculatorStore.getState().removeBlock(b.id);
    expect(useCalculatorStore.getState().blocks.map((x) => x.id)).toEqual([a.id]);
  });

  it('toggles block and global buffs, and detaches removed buffs everywhere', () => {
    freshState();
    const buff = useCalculatorStore.getState().addBuff({ label: 'B', source: 'test', mods: [] });
    const block = useCalculatorStore.getState().addBlock({ skillId: 's1', motionName: 'M1', forteLevel: 10, activeBuffIds: [] });

    useCalculatorStore.getState().toggleBlockBuff(block.id, buff.id);
    expect(useCalculatorStore.getState().blocks[0].activeBuffIds).toEqual([buff.id]);
    useCalculatorStore.getState().toggleBlockBuff(block.id, buff.id);
    expect(useCalculatorStore.getState().blocks[0].activeBuffIds).toEqual([]);

    useCalculatorStore.getState().toggleGlobalBuff(buff.id);
    expect(useCalculatorStore.getState().globalBuffIds).toEqual([buff.id]);

    // Re-attach, then remove the buff: no dangling references remain.
    useCalculatorStore.getState().toggleBlockBuff(block.id, buff.id);
    useCalculatorStore.getState().removeBuff(buff.id);
    const s = useCalculatorStore.getState();
    expect(s.buffs).toEqual([]);
    expect(s.globalBuffIds).toEqual([]);
    expect(s.blocks[0].activeBuffIds).toEqual([]);
  });

  it('sets Resonance Mode and resets it on character switch and resetAll', () => {
    freshState();
    useCalculatorStore.getState().setResonanceMode('tuneRupture');
    expect(useCalculatorStore.getState().resonanceMode).toBe('tuneRupture');
    useCalculatorStore.getState().setCharacterId('aemeath');
    expect(useCalculatorStore.getState().resonanceMode).toBeNull();
    useCalculatorStore.getState().setResonanceMode('fusionBurst');
    useCalculatorStore.getState().setCharacterId('aemeath');
    expect(useCalculatorStore.getState().resonanceMode).toBe('fusionBurst');
    useCalculatorStore.getState().resetAll();
    expect(useCalculatorStore.getState().resonanceMode).toBeNull();
  });

  it('clamps kit-state inputs per field and keeps booleans', () => {
    freshState();
    const row = useCalculatorStore.getState().addBlock({ skillId: 'x', motionName: 'y', forteLevel: 1, activeBuffIds: [] });
    useCalculatorStore.getState().setBlockKitState(row.id, {
      targetHavocBaneStacks: 12,
      blazesConsumed: 200,
      nightfallBlazes: -5,
      ringsConsumed: 150,
      voiceFlux: true,
      wovenMyriad: true,
      sealMaster: true,
    });
    const b = useCalculatorStore.getState().blocks[0];
    expect(b.targetHavocBaneStacks).toBe(9);
    expect(b.blazesConsumed).toBe(150);
    expect(b.nightfallBlazes).toBe(0);
    expect(b.ringsConsumed).toBe(100);
    expect(b.voiceFlux).toBe(true);
    expect(b.wovenMyriad).toBe(true);
    expect(b.sealMaster).toBe(true);
    useCalculatorStore.getState().setBlockKitState(row.id, {
      tuneStrainStacks: 99,
      tuneResponseStacks: -4,
      tuneBreakMultiplier: 1.7334,
    });
    const t = useCalculatorStore.getState().blocks[0];
    expect(t.tuneStrainStacks).toBe(10);
    expect(t.tuneResponseStacks).toBe(0);
    expect(t.tuneBreakMultiplier).toBeCloseTo(1.7334, 10);
    useCalculatorStore.getState().setBlockKitState(row.id, {
      echoMotionValue: 120,
      echoFlatDamage: -5,
      echoAttribute: 'Havoc',
      echoScaling: 'HP',
    });
    const e = useCalculatorStore.getState().blocks[0];
    expect(e.echoMotionValue).toBe(99);
    expect(e.echoFlatDamage).toBe(0);
    expect(e.echoAttribute).toBe('Havoc');
    expect(e.echoScaling).toBe('HP');
    useCalculatorStore.getState().setBlockKitState('missing', { blazesConsumed: 10 });
    expect(useCalculatorStore.getState().blocks).toHaveLength(1);
  });

  it('resetAll clears rotation state too', () => {
    freshState();
    useCalculatorStore.getState().addBlock({ skillId: 's1', motionName: 'M1', forteLevel: 10, activeBuffIds: [] });
    useCalculatorStore.getState().addBuff({ label: 'B', source: 'test', mods: [] });
    useCalculatorStore.getState().resetAll();
    const s = useCalculatorStore.getState();
    expect(s.blocks).toEqual([]);
    expect(s.buffs).toEqual([]);
    expect(s.globalBuffIds).toEqual([]);
    expect(s.crit).toBe('expected');
  });

  it('stores timing fields passed to addBlock/addBuff, leaving them absent when omitted', () => {
    freshState();
    const block = useCalculatorStore.getState().addBlock({ skillId: 's1', motionName: 'M1', forteLevel: 10, activeBuffIds: [], durationSeconds: 2.5 });
    expect(block.durationSeconds).toBeCloseTo(2.5, 10);
    const buff = useCalculatorStore.getState().addBuff({ label: 'B', source: 'test', mods: [], windowStartSeconds: 1, windowDurationSeconds: 4 });
    expect(buff.windowStartSeconds).toBe(1);
    expect(buff.windowDurationSeconds).toBe(4);
    const plain = useCalculatorStore.getState().addBlock({ skillId: 's2', motionName: 'M2', forteLevel: 10, activeBuffIds: [] });
    expect(plain.durationSeconds).toBeUndefined();
  });

  it('clamps block durations to 0–3600 and ignores non-finite input', () => {
    freshState();
    const row = useCalculatorStore.getState().addBlock({ skillId: 's1', motionName: 'M1', forteLevel: 10, activeBuffIds: [] });
    useCalculatorStore.getState().setBlockDuration(row.id, 2.5);
    expect(useCalculatorStore.getState().blocks[0].durationSeconds).toBeCloseTo(2.5, 10);
    useCalculatorStore.getState().setBlockDuration(row.id, 5000);
    expect(useCalculatorStore.getState().blocks[0].durationSeconds).toBe(3600);
    // Zero is a real duration (instantaneous block), not "unset".
    useCalculatorStore.getState().setBlockDuration(row.id, -3);
    expect(useCalculatorStore.getState().blocks[0].durationSeconds).toBe(0);
    useCalculatorStore.getState().setBlockDuration('missing', 9);
    expect(useCalculatorStore.getState().blocks).toHaveLength(1);
    // Non-finite input is ignored — the stored 0 survives.
    useCalculatorStore.getState().setBlockDuration(row.id, Number.NaN);
    useCalculatorStore.getState().setBlockDuration(row.id, Number.POSITIVE_INFINITY);
    expect(useCalculatorStore.getState().blocks[0].durationSeconds).toBe(0);
  });

  it('sets and clears buff windows with clamps and atomic non-finite ignore', () => {
    freshState();
    const buff = useCalculatorStore.getState().addBuff({ label: 'B', source: 'test', mods: [] });
    useCalculatorStore.getState().setBuffWindow(buff.id, 1, 4);
    let b = useCalculatorStore.getState().buffs[0];
    expect(b.windowStartSeconds).toBe(1);
    expect(b.windowDurationSeconds).toBe(4);
    // Each end clamps independently into 0–3600.
    useCalculatorStore.getState().setBuffWindow(buff.id, 5000, -3);
    b = useCalculatorStore.getState().buffs[0];
    expect(b.windowStartSeconds).toBe(3600);
    expect(b.windowDurationSeconds).toBe(0);
    // A non-finite end ignores the whole call — the stored window survives.
    useCalculatorStore.getState().setBuffWindow(buff.id, Number.NaN, 9);
    useCalculatorStore.getState().setBuffWindow(buff.id, 2, Number.POSITIVE_INFINITY);
    b = useCalculatorStore.getState().buffs[0];
    expect(b.windowStartSeconds).toBe(3600);
    expect(b.windowDurationSeconds).toBe(0);
    // Zero duration is stored (degenerate window), distinct from cleared.
    useCalculatorStore.getState().setBuffWindow(buff.id, 2, 0);
    b = useCalculatorStore.getState().buffs[0];
    expect(b.windowStartSeconds).toBe(2);
    expect(b.windowDurationSeconds).toBe(0);
    // Missing ids are no-ops.
    useCalculatorStore.getState().setBuffWindow('missing', 1, 1);
    useCalculatorStore.getState().clearBuffWindow('missing');
    expect(useCalculatorStore.getState().buffs).toHaveLength(1);
    // Clear removes both ends and leaves everything else intact.
    useCalculatorStore.getState().clearBuffWindow(buff.id);
    b = useCalculatorStore.getState().buffs[0];
    expect(b.windowStartSeconds).toBeUndefined();
    expect(b.windowDurationSeconds).toBeUndefined();
    expect(b.label).toBe('B');
  });

  it('derives block starts as cumulative durations ([0, d0, d0+d1, …])', () => {
    freshState();
    expect(selectBlockStartTimes(useCalculatorStore.getState())).toEqual([]);
    useCalculatorStore.getState().addBlock({ skillId: 's1', motionName: 'M1', forteLevel: 10, activeBuffIds: [], durationSeconds: 2 });
    useCalculatorStore.getState().addBlock({ skillId: 's2', motionName: 'M2', forteLevel: 10, activeBuffIds: [], durationSeconds: 3 });
    useCalculatorStore.getState().addBlock({ skillId: 's3', motionName: 'M3', forteLevel: 10, activeBuffIds: [] });
    expect(selectBlockStartTimes(useCalculatorStore.getState())).toEqual([0, 2, 5]);
    // Reordering re-derives starts from the new order.
    const ids = useCalculatorStore.getState().blocks.map((x) => x.id);
    useCalculatorStore.getState().moveBlock(ids[0], 1);
    expect(selectBlockStartTimes(useCalculatorStore.getState())).toEqual([0, 3, 5]);
  });
});

describe('loadSharedDraft', () => {
  const sharedEntry: RosterEntry = { ...entry, level: 90, ascension: 6, resonanceChain: 6, weaponRank: 5, weaponAscension: 6 };

  it('loads the context as a manual (non-roster) draft and clears the Echo slots', () => {
    const s = freshState();
    s.resetFromRoster(entry);
    s.setEchoSlot(0, 'mine-1');
    useCalculatorStore.getState().loadSharedDraft({ sourceName: 'Friend build', roster: sharedEntry, skippedBlocks: 0 });
    const after = useCalculatorStore.getState();
    expect(after).toMatchObject({
      characterId: 'jiyan',
      level: 90,
      ascension: 6,
      resonanceChain: 6,
      weaponRank: 5,
      weaponAscension: 6,
      rosterSourceId: '',
      draftSource: 'Friend build',
    });
    expect(after.echoIds).toEqual([null, null, null, null, null]);
  });

  it('replaces the rotation when the link carries one (fresh block ids)', () => {
    freshState().addBlock({ skillId: 'old', motionName: 'Old', forteLevel: 10, activeBuffIds: [] });
    useCalculatorStore.getState().loadSharedDraft({
      sourceName: 'Rotation build',
      roster: sharedEntry,
      skippedBlocks: 0,
      rotation: {
        blocks: [{ skillId: '1001103', motionName: 'Lance', forteLevel: 10, activeBuffIds: ['b1'] }],
        buffs: [{ id: 'b1', label: 'Buff', source: 'Team', mods: [{ stat: 'atkPct', value: 0.1 }] }],
        globalBuffIds: ['b1'],
        crit: 'crit',
      },
    });
    const after = useCalculatorStore.getState();
    expect(after.blocks.map((b) => b.motionName)).toEqual(['Lance']);
    expect(after.blocks[0].id).toEqual(expect.any(String));
    expect(after.buffs.map((b) => b.id)).toEqual(['b1']);
    expect(after.globalBuffIds).toEqual(['b1']);
    expect(after.crit).toBe('crit');
  });

  it('applies the enemy and Resonance Mode a v3 link carries', () => {
    const s = freshState();
    s.setEnemyKind('mob');
    useCalculatorStore.getState().loadSharedDraft({
      sourceName: 'Boss build',
      roster: { ...sharedEntry, characterId: 'denia', weaponId: 'augment' },
      skippedBlocks: 0,
      enemy: { kind: 'boss', level: 100, baseRES: 0.2 },
      resonanceMode: 'tuneStrain',
    });
    expect(useCalculatorStore.getState()).toMatchObject({
      enemyKind: 'boss',
      enemyLevel: 100,
      enemyBaseRES: 0.2,
      resonanceMode: 'tuneStrain',
    });
  });

  it('leaves the current enemy alone when the link carries none, and the mode only for the same character', () => {
    const s = freshState();
    s.setEnemyKind('boss');
    s.setEnemyLevel(80);
    s.setCharacterId('jiyan');
    s.setResonanceMode('tuneRupture');
    useCalculatorStore.getState().loadSharedDraft({ sourceName: 'Plain', roster: sharedEntry, skippedBlocks: 0 });
    expect(useCalculatorStore.getState()).toMatchObject({ enemyKind: 'boss', enemyLevel: 80, resonanceMode: 'tuneRupture' });
    useCalculatorStore.getState().loadSharedDraft({
      sourceName: 'Other',
      roster: { ...sharedEntry, characterId: 'denia', weaponId: 'augment' },
      skippedBlocks: 0,
    });
    expect(useCalculatorStore.getState()).toMatchObject({ enemyKind: 'boss', enemyLevel: 80, resonanceMode: null });
  });

  it('resetAll clears the minimum-stat boxes', () => {
    useCalculatorStore.getState().setMinStatTexts({ critRate: '70' });
    useCalculatorStore.getState().resetAll();
    expect(useCalculatorStore.getState().minStatTexts).toEqual({});
  });

  it('is cleared by a roster prefill or a reset', () => {
    freshState().loadSharedDraft({ sourceName: 'X', roster: sharedEntry, skippedBlocks: 0 });
    useCalculatorStore.getState().resetFromRoster(entry);
    expect(useCalculatorStore.getState().draftSource).toBeNull();
    useCalculatorStore.getState().loadSharedDraft({ sourceName: 'X', roster: sharedEntry, skippedBlocks: 0 });
    useCalculatorStore.getState().resetAll();
    expect(useCalculatorStore.getState().draftSource).toBeNull();
  });
});
