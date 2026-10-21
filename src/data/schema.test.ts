import { describe, expect, it } from 'vitest';
import { loadBundledSnapshot } from './index.ts';
import {
  buildSchema,
  characterSchema,
  echoDefSchema,
  ownedEchoSchema,
  SNAPSHOT_VERSION,
  snapshotSchema,
  statKeySchema,
  teamSchema,
} from './schema.ts';

describe('user-data schemas', () => {
  const validEcho = {
    id: 'echo-1',
    echoDefId: 'hooscamp',
    sonataId: 'sierra-gale',
    cost: 3,
    level: 25,
    rarity: 5,
    mainStat: { stat: 'dmgBonus:Aero', value: 0.3 },
    secondMainStat: { stat: 'atk', value: 100 },
    substats: [
      { stat: 'critRate', value: 0.063 },
      { stat: 'critDmg', value: 0.126 },
    ],
    equippedTo: null,
    origin: 'manual',
  } as const;

  it('accepts a well-formed owned Echo', () => {
    expect(ownedEchoSchema.parse(validEcho).id).toBe('echo-1');
  });

  it('accepts locked: true or no lock, rejects any other lock value', () => {
    expect(ownedEchoSchema.parse(validEcho).locked).toBeUndefined();
    expect(ownedEchoSchema.parse({ ...validEcho, locked: true }).locked).toBe(true);
    expect(() => ownedEchoSchema.parse({ ...validEcho, locked: false })).toThrow();
    expect(() => ownedEchoSchema.parse({ ...validEcho, locked: 'yes' })).toThrow();
  });

  it('rejects duplicate substats and bad costs', () => {
    expect(() =>
      ownedEchoSchema.parse({
        ...validEcho,
        substats: [
          { stat: 'critRate', value: 0.05 },
          { stat: 'critRate', value: 0.06 },
        ],
      }),
    ).toThrow(/duplicate substats/);
    expect(() => ownedEchoSchema.parse({ ...validEcho, cost: 2 })).toThrow();
    expect(() =>
      ownedEchoSchema.parse({ ...validEcho, substats: Array(6).fill({ stat: 'atk', value: 1 }) }),
    ).toThrow();
  });

  it('rejects builds that reuse an Echo or drop a slot', () => {
    const base = {
      id: 'b1',
      name: 'My build',
      characterId: 'jiyan',
      weaponId: 'verdant-summit',
      objectiveId: 'expected-liberation',
      updatedAt: new Date().toISOString(),
    };
    expect(() =>
      buildSchema.parse({ ...base, echoIds: ['a', 'b', 'c', 'd', 'e'] }),
    ).not.toThrow();
    expect(() =>
      buildSchema.parse({ ...base, echoIds: ['a', 'b', 'c', 'd', 'a'] }),
    ).toThrow(/cannot be equipped twice/);
    expect(() => buildSchema.parse({ ...base, echoIds: ['a', 'b', 'c', 'd'] })).toThrow();
  });

  it('accepts a build with the enemy and Resonance Mode its run used, and bounds the enemy', () => {
    const base = {
      id: 'b1',
      name: 'My build',
      characterId: 'denia',
      weaponId: 'augment',
      echoIds: ['a', 'b', 'c', 'd', 'e'],
      objectiveId: 'Rotation DPR',
      updatedAt: new Date().toISOString(),
    };
    const parsed = buildSchema.parse({ ...base, enemy: { kind: 'boss', level: 100, baseRES: 0.2 }, resonanceMode: 'tuneStrain' });
    expect(parsed.enemy).toEqual({ kind: 'boss', level: 100, baseRES: 0.2 });
    expect(parsed.resonanceMode).toBe('tuneStrain');
    // Older builds lack both; nothing is added.
    expect(Object.keys(buildSchema.parse(base))).not.toContain('enemy');
    expect(() => buildSchema.parse({ ...base, enemy: { kind: 'elite', level: 90, baseRES: 0.1 } })).toThrow();
    expect(() => buildSchema.parse({ ...base, enemy: { kind: 'mob', level: 121, baseRES: 0.1 } })).toThrow();
    expect(() => buildSchema.parse({ ...base, enemy: { kind: 'mob', level: 90.5, baseRES: 0.1 } })).toThrow();
    expect(() => buildSchema.parse({ ...base, enemy: { kind: 'mob', level: 90, baseRES: 0.81 } })).toThrow();
    expect(() => buildSchema.parse({ ...base, resonanceMode: '' })).toThrow();
  });

  it('keeps a team priority, and parses a malformed one as absent', () => {
    const team = { id: 't', name: 'T', characterIds: ['a', 'b', 'c'] };
    expect(teamSchema.parse({ ...team, priority: ['c', 'a', 'b'] }).priority).toEqual(['c', 'a', 'b']);
    expect(Object.keys(teamSchema.parse(team))).not.toContain('priority');
    expect(teamSchema.parse({ ...team, priority: ['a', 'b'] }).priority).toBeUndefined();
    expect(teamSchema.parse({ ...team, priority: 'abc' }).priority).toBeUndefined();
  });

  it('rejects teams with duplicate members', () => {
    expect(() =>
      teamSchema.parse({ id: 't', name: 'T', characterIds: ['a', 'b', 'c'] }),
    ).not.toThrow();
    expect(() =>
      teamSchema.parse({ id: 't', name: 'T', characterIds: ['a', 'b', 'a'] }),
    ).toThrow(/same character twice/);
  });

  it('accepts icon urls but rejects non-urls', () => {
    const char = loadBundledSnapshot().characters[0];
    const { iconUrl: _DROPPED, ...bare } = char;
    expect(_DROPPED).toBeDefined();
    expect(characterSchema.parse(bare).iconUrl).toBeUndefined();
    expect(
      characterSchema.parse({ ...bare, iconUrl: 'https://example.com/jiyan.webp' }).iconUrl,
    ).toBe('https://example.com/jiyan.webp');
    expect(() => characterSchema.parse({ ...bare, iconUrl: 'not a url' })).toThrow();
  });

  it('rejects out-of-range chain ranks', () => {
    const char = loadBundledSnapshot().characters[0];
    expect(() => characterSchema.parse({ ...char, rarity: 3 })).toThrow();
    expect(() =>
      characterSchema.parse({
        ...char,
        resonanceChain: char.resonanceChain.slice(0, 5),
      }),
    ).toThrow();
  });
});

describe('bundled snapshot', () => {
  it('validates against the snapshot schema', () => {
    const snapshot = loadBundledSnapshot();
    expect(snapshot.snapshotVersion).toBe(SNAPSHOT_VERSION);
    const characterIds = snapshot.characters.map((c) => c.id);
    expect(characterIds).toContain('jiyan');
    expect(characterIds).toContain('verina');
    expect(new Set(characterIds).size).toBe(characterIds.length);
    const weaponIds = snapshot.weapons.map((w) => w.id);
    expect(weaponIds).toContain('verdant-summit');
    expect(weaponIds).toContain('cosmic-ripples');
    expect(snapshot.sonataSets.length).toBeGreaterThan(0);
  });

  it('re-parses the raw file identically (no drift)', () => {
    expect(snapshotSchema.parse(JSON.parse(JSON.stringify(loadBundledSnapshot())))).toEqual(
      loadBundledSnapshot(),
    );
  });

  it('has no Physical element or Physical DMG bucket (the game has neither)', () => {
    expect(statKeySchema.options).not.toContain('dmgBonus:physical');
    const snapshot = loadBundledSnapshot();
    for (const def of snapshot.echoDefs) {
      expect(def.element, `${def.name} element`).not.toBe('Physical');
    }
    // Element-less echoes (provider element Id 0) carry no element at all.
    const diamondclaw = snapshot.echoDefs.find((d) => d.id === 'diamondclaw')!;
    expect(diamondclaw.element).toBeUndefined();
    const { element: _DROPPED, ...bare } = snapshot.echoDefs.find((d) => d.id === 'hooscamp')!;
    expect(_DROPPED).toBeDefined();
    expect(echoDefSchema.parse(bare).element).toBeUndefined();
  });
});
