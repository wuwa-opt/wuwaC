import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadBundledSnapshot } from '../data/index.ts';
import { buildSchema, sharedBuildSchema, type Build, type OwnedEcho, type RosterEntry, type SharedBuild, type SharedEcho } from '../data/schema.ts';
import {
  BUILD_LINK_VERSION,
  MAX_SHARE_HASH_LENGTH,
  MAX_SHARE_JSON_BYTES,
  REFERENCE_ECHO_IDS,
  checkSharedEchoValues,
  decodeBuildLink,
  decodeShareLink,
  encodeBuildLink,
  encodeSharedBuild,
  referenceBuildFrom,
  sharedBuildFromLibrary,
  sharedCalculatorDraft,
  viewSharedBuild,
} from './share.ts';

const snapshot = loadBundledSnapshot();
const jiyan = snapshot.characters.find((c) => c.id === 'jiyan')!;
const LIBERATION = '1001103';
const MOTION = 'Lance of Qingloong Stage 1 DMG';

const build: Build = {
  id: 'b1',
  name: 'Jiyan ★ Liberation ✓',
  characterId: 'jiyan',
  weaponId: 'verdant-summit',
  echoIds: ['a', 'b', 'c', 'd', 'e'],
  objectiveId: 'Expected damage',
  objective: { kind: 'expected-damage', skillId: LIBERATION, motionName: MOTION, forteLevel: 10, crit: 'expected' },
  score: 1234.5,
  notes: 'private note',
  updatedAt: new Date().toISOString(),
};

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const utf8 = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);

async function deflate(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
/** A v2 hash around arbitrary JSON text (bypasses the encoder's validation). */
async function rawV2(json: string): Promise<string> {
  return `#b=2.${toBase64Url(await deflate(utf8(json)))}`;
}

const owned = (id: string, echo: Partial<OwnedEcho> & Pick<OwnedEcho, 'echoDefId' | 'cost' | 'mainStat'>): OwnedEcho => ({
  id,
  label: `secret label ${id}`,
  sonataId: 'sierra-gale',
  level: 25,
  rarity: 5,
  substats: [],
  equippedTo: 'jiyan',
  origin: 'manual',
  ...echo,
});

// 5★ +25 values straight from the echoStats tables (no invented numbers).
const inventory: OwnedEcho[] = [
  owned('a', { echoDefId: 'feilian-beringal', cost: 4, mainStat: { stat: 'critRate', value: 0.22 }, secondMainStat: { stat: 'atk', value: 150 }, substats: [{ stat: 'critDmg', value: 0.21 }] }),
  owned('b', { echoDefId: 'hoochief', cost: 3, mainStat: { stat: 'dmgBonus:Aero', value: 0.3 }, secondMainStat: { stat: 'atk', value: 100 } }),
  owned('c', { echoDefId: 'carapace', cost: 3, mainStat: { stat: 'atkPct', value: 0.3 }, secondMainStat: { stat: 'atk', value: 100 } }),
  owned('d', { echoDefId: 'hooscamp', cost: 1, mainStat: { stat: 'atkPct', value: 0.18 }, secondMainStat: { stat: 'hp', value: 2280 } }),
  owned('e', { echoDefId: 'chirpuff', cost: 1, mainStat: { stat: 'atkPct', value: 0.18 }, secondMainStat: { stat: 'hp', value: 2280 } }),
];
const roster: RosterEntry = {
  characterId: 'jiyan',
  level: 90,
  ascension: 6,
  resonanceChain: 2,
  forteLevels: { [LIBERATION]: 10 },
  weaponId: 'verdant-summit',
  weaponLevel: 90,
  weaponAscension: 6,
  weaponRank: 1,
};

const shared = (includeObjective = false): SharedBuild =>
  sharedBuildFromLibrary({ build, roster, inventory, includeObjective });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('locked Echoes', () => {
  it('never leak into a share link', async () => {
    const locked = inventory.map((e) => ({ ...e, locked: true as const }));
    const payload = sharedBuildFromLibrary({ build, roster, inventory: locked, includeObjective: false });
    expect(JSON.stringify(payload)).not.toContain('locked');
    expect(await encodeSharedBuild(payload)).toBe(await encodeSharedBuild(shared()));
  });
});

describe('v1 links (legacy)', () => {
  it('round-trips a build, unicode included', () => {
    const hash = encodeBuildLink(build);
    expect(decodeBuildLink(hash)).toEqual(build);
  });

  it('still decode through decodeShareLink', async () => {
    expect(await decodeShareLink(encodeBuildLink(build))).toEqual({ version: 1, build });
  });

  it('rejects missing prefixes, garbage, wrong versions, and invalid builds', () => {
    expect(() => decodeBuildLink('b=abc')).toThrow();
    expect(() => decodeBuildLink('#b=!!!not-base64!!!')).toThrow();
    expect(() => decodeBuildLink(`#b=${toBase64Url(utf8(JSON.stringify({ v: 999, build })))}`)).toThrow(/version/);
    expect(() => decodeBuildLink(`#b=${toBase64Url(utf8(JSON.stringify({ v: BUILD_LINK_VERSION })))}`)).toThrow();
    expect(() =>
      decodeBuildLink(`#b=${toBase64Url(utf8(JSON.stringify({ v: BUILD_LINK_VERSION, build: { ...build, echoIds: ['a'] } })))}`),
    ).toThrow();
  });
});

describe('v2 payload from a library build', () => {
  it('carries stats and roster context, never ids, equip state, origin, labels or notes', () => {
    const payload = shared();
    expect(payload.character).toEqual({ id: 'jiyan', level: 90, ascension: 6, chain: 2, forte: { [LIBERATION]: 10 } });
    expect(payload.weapon).toEqual({ id: 'verdant-summit', level: 90, ascension: 6, rank: 1 });
    expect(payload.echoes[0]).toEqual({
      def: 'feilian-beringal', set: 'sierra-gale', cost: 4, level: 25, rarity: 5,
      main: { stat: 'critRate', value: 0.22 }, second: { stat: 'atk', value: 150 },
      subs: [{ stat: 'critDmg', value: 0.21 }],
    });
    expect(payload.summary).toBe('Expected damage');
    expect(payload.objective).toBeUndefined();
    const text = JSON.stringify(payload);
    for (const leaked of ['"a"', 'secret label', 'equippedTo', 'origin', 'private note', 'b1']) {
      expect(text).not.toContain(leaked);
    }
  });

  it('includes the objective only when asked, which changes the link', async () => {
    const without = shared(false);
    const withObjective = shared(true);
    expect(withObjective.objective).toEqual(build.objective);
    expect(await encodeSharedBuild(withObjective)).not.toBe(await encodeSharedBuild(without));
  });

  describe('with a context saved on the build', () => {
    const savedContext: RosterEntry = {
      characterId: 'jiyan',
      level: 80,
      ascension: 5,
      resonanceChain: 4,
      forteLevels: { [LIBERATION]: 9 },
      forteUnlockedIds: ['node-1'],
      weaponId: 'verdant-summit',
      weaponLevel: 70,
      weaponAscension: 4,
      weaponRank: 3,
    };
    const withContext: Build = { ...build, context: savedContext };

    it('uses the saved context even after the Roster changed level and weapon', () => {
      const changedRoster: RosterEntry = { ...roster, level: 50, resonanceChain: 0, weaponId: 'other-weapon', weaponLevel: 1 };
      const payload = sharedBuildFromLibrary({ build: withContext, roster: changedRoster, inventory, includeObjective: false });
      expect(payload.character).toEqual({ id: 'jiyan', level: 80, ascension: 5, chain: 4, forte: { [LIBERATION]: 9 }, nodes: ['node-1'] });
      expect(payload.weapon).toEqual({ id: 'verdant-summit', level: 70, ascension: 4, rank: 3 });
      // No Roster entry at all is fine too.
      expect(sharedBuildFromLibrary({ build: withContext, roster: undefined, inventory, includeObjective: false }).character.level).toBe(80);
    });

    it('still explains a saved value the link format cannot carry', () => {
      const forte11: Build = { ...build, context: { ...savedContext, forteLevels: { [LIBERATION]: 11 } } };
      expect(() => sharedBuildFromLibrary({ build: forte11, roster, inventory, includeObjective: false })).toThrow(
        `this build can't be shared as-is (character.forte.${LIBERATION}: Too big: expected number to be <=10)`,
      );
    });

    it("must match the build's character and weapon", () => {
      expect(buildSchema.safeParse(withContext).success).toBe(true);
      expect(buildSchema.safeParse({ ...build, context: { ...savedContext, weaponId: 'other' } }).success).toBe(false);
    });
  });

  it('falls back to the current Roster for builds saved without context', () => {
    expect(build.context).toBeUndefined();
    expect(sharedBuildFromLibrary({ build, roster, inventory, includeObjective: false }).character.level).toBe(90);
  });

  it('refuses to guess missing context', () => {
    expect(() => sharedBuildFromLibrary({ build, roster: undefined, inventory, includeObjective: false })).toThrow(/Roster/);
    expect(() =>
      sharedBuildFromLibrary({ build, roster: { ...roster, weaponId: 'other' }, inventory, includeObjective: false }),
    ).toThrow(/different weapon/);
    expect(() =>
      sharedBuildFromLibrary({ build, roster, inventory: inventory.slice(1), includeObjective: false }),
    ).toThrow(/1 of this build's Echoes/);
    expect(() =>
      sharedBuildFromLibrary({ build, roster: { ...roster, forteLevels: { [LIBERATION]: 11 } }, inventory, includeObjective: false }),
    ).toThrow(`this build can't be shared as-is (character.forte.${LIBERATION}: Too big: expected number to be <=10)`);
  });
});

describe('v2 encode / decode', () => {
  it('round-trips, tagged with its version before the compressed payload', async () => {
    const payload = shared(true);
    const hash = await encodeSharedBuild(payload);
    expect(hash.startsWith('#b=2.')).toBe(true);
    expect(await decodeShareLink(hash)).toEqual({ version: 2, shared: payload });
  });

  it('refuses to encode a payload the decoder would reject', async () => {
    const block = { skillId: LIBERATION, motionName: 'M'.repeat(120), forteLevel: 10, activeBuffIds: Array.from({ length: 64 }, (_, i) => `buff-${i}`) };
    const huge: SharedBuild = {
      ...shared(),
      objective: { kind: 'rotation-dpr', blocks: Array.from({ length: 200 }, () => block), buffs: [], globalBuffIds: [], crit: 'expected' },
    };
    expect(sharedBuildSchema.safeParse(huge).success).toBe(true);
    await expect(encodeSharedBuild(huge)).rejects.toThrow(/too large to share .* without the rotation/);
  });

  it('explains a browser without CompressionStream instead of crashing', async () => {
    const hash = await encodeSharedBuild(shared());
    vi.stubGlobal('DecompressionStream', undefined);
    await expect(decodeShareLink(hash)).rejects.toThrow(/no CompressionStream support/);
  });

  it('rejects an oversized hash before decompressing anything', async () => {
    const inflate = vi.fn();
    vi.stubGlobal('DecompressionStream', inflate);
    await expect(decodeShareLink(`#b=2.${'A'.repeat(MAX_SHARE_HASH_LENGTH)}`)).rejects.toThrow(/too long/);
    expect(inflate).not.toHaveBeenCalled();
  });

  it('aborts a decompression bomb past the byte cap', async () => {
    // 4× the cap of zeros deflates to a few hundred bytes — well under the hash cap.
    const bomb = await deflate(new Uint8Array(MAX_SHARE_JSON_BYTES * 4));
    const hash = `#b=2.${toBase64Url(bomb)}`;
    expect(hash.length).toBeLessThan(MAX_SHARE_HASH_LENGTH);
    await expect(decodeShareLink(hash)).rejects.toThrow(/expands past 65536 bytes/);
  });

  it('rejects unknown keys, a 6th Echo, and non-finite numbers', async () => {
    const valid = shared();
    await expect(decodeShareLink(await rawV2(JSON.stringify({ ...valid, extra: 1 })))).rejects.toThrow(/validation/);
    await expect(
      decodeShareLink(await rawV2(JSON.stringify({ ...valid, echoes: valid.echoes.map((e) => ({ ...e, id: 'x' })) }))),
    ).rejects.toThrow(/validation/);
    await expect(
      decodeShareLink(await rawV2(JSON.stringify({ ...valid, echoes: [...valid.echoes, valid.echoes[0]] }))),
    ).rejects.toThrow(/validation/);
    // JSON can't spell NaN; 1e999 parses to Infinity.
    const infinite = JSON.stringify(valid).replace('"score":1234.5', '"score":1e999');
    expect(infinite).toContain('1e999');
    await expect(decodeShareLink(await rawV2(infinite))).rejects.toThrow(/validation/);
    expect(sharedBuildSchema.safeParse({ ...valid, score: Number.NaN }).success).toBe(false);
    expect(sharedBuildSchema.safeParse({ ...valid, score: Number.POSITIVE_INFINITY }).success).toBe(false);
  });

  it('rejects unknown versions, bad base64, and corrupt compressed data readably', async () => {
    await expect(decodeShareLink('#b=3.abc')).rejects.toThrow(/unsupported build link version 3/);
    await expect(decodeShareLink('#b=2.$$$')).rejects.toThrow(/base64/);
    await expect(decodeShareLink(`#b=2.${toBase64Url(utf8('not deflate at all, honest'))}`)).rejects.toThrow(
      /compressed data|JSON/,
    );
  });
});

describe('checkSharedEchoValues', () => {
  const base: SharedEcho = {
    def: 'feilian-beringal', set: 'sierra-gale', cost: 4, level: 25, rarity: 5,
    main: { stat: 'critRate', value: 0.22 }, second: { stat: 'atk', value: 150 }, subs: [],
  };

  it('passes exact 5★ +25 values from the tables', () => {
    expect(checkSharedEchoValues({ ...base, subs: [{ stat: 'critRate', value: 0.081 }, { stat: 'atk', value: 60 }] })).toEqual([]);
  });

  it('flags values the tables contradict', () => {
    const flags = checkSharedEchoValues({
      ...base,
      main: { stat: 'critRate', value: 0.3 }, // 5★ +25 4-cost Crit Rate is 0.22
      second: { stat: 'atk', value: 160 }, // 4-cost secondary is ATK 150
      subs: [{ stat: 'critRate', value: 0.08 }], // not a roll tier
    });
    expect(flags.map((f) => [f.part, f.severity])).toEqual([
      ['main', 'out-of-range'],
      ['second', 'out-of-range'],
      ['sub', 'out-of-range'],
    ]);
    expect(checkSharedEchoValues({ ...base, cost: 1, main: { stat: 'critRate', value: 0.1 } })[0].message).toBe(
      'not a 1-cost main stat',
    );
  });

  it('uses the range below +25 and only an upper bound for the secondary', () => {
    // 5★ 4-cost Crit Rate range 0.044–0.22; secondary ≤ 150 below +25.
    expect(checkSharedEchoValues({ ...base, level: 10, main: { stat: 'critRate', value: 0.1 }, second: { stat: 'atk', value: 80 } })).toEqual([]);
    expect(checkSharedEchoValues({ ...base, level: 10, main: { stat: 'critRate', value: 0.04 } })[0].severity).toBe('out-of-range');
  });

  it('marks what no table covers as unverified, not wrong', () => {
    const fourStar = checkSharedEchoValues({ ...base, rarity: 4, subs: [{ stat: 'critDmg', value: 0.1 }] });
    expect(fourStar.map((f) => f.severity)).toEqual(['unverified', 'unverified', 'unverified']);
    expect(checkSharedEchoValues({ ...base, subs: [{ stat: 'healingBonus', value: 0.05 }] })).toEqual([
      expect.objectContaining({ part: 'sub', severity: 'unverified' }),
    ]);
  });
});

describe('viewSharedBuild', () => {
  it('computes key stats with the recipient snapshot', () => {
    const view = viewSharedBuild(shared(), snapshot);
    expect(view.issues).toEqual([]);
    expect(view.stats).toBeDefined();
    expect(view.echoNames[0]).toBe(snapshot.echoDefs.find((d) => d.id === 'feilian-beringal')!.name);
    // One extra 10.5% Crit Rate substat raises the sheet's Crit Rate by exactly 0.105.
    const payload = shared();
    const boosted: SharedBuild = {
      ...payload,
      echoes: [{ ...payload.echoes[0], subs: [...payload.echoes[0].subs, { stat: 'critRate', value: 0.105 }] }, ...payload.echoes.slice(1)] as SharedBuild['echoes'],
    };
    expect(viewSharedBuild(boosted, snapshot).stats!.critRate - view.stats!.critRate).toBeCloseTo(0.105, 10);
  });

  it('reports unknown ids instead of crashing', () => {
    const payload = shared();
    const view = viewSharedBuild(
      {
        ...payload,
        character: { ...payload.character, id: 'nobody' },
        echoes: [{ ...payload.echoes[0], def: 'mystery-echo', set: 'mystery-set' }, ...payload.echoes.slice(1)] as SharedBuild['echoes'],
      },
      snapshot,
    );
    expect(view.stats).toBeUndefined();
    expect(view.issues).toEqual([
      'Unknown character "nobody" — your game data may be older than the sender\'s.',
      'Unknown Echo "mystery-echo" — shown by id.',
      'Unknown Sonata set "mystery-set" — its bonuses aren\'t counted.',
    ]);
    expect(view.echoNames[0]).toBe('mystery-echo');
  });
});

describe('reference builds', () => {
  it('store the payload on the build with placeholder echo ids', () => {
    const payload = shared(true);
    const ref = referenceBuildFrom(payload, new Date('2026-10-21T00:00:00.000Z'));
    expect(ref.echoIds).toEqual([...REFERENCE_ECHO_IDS]);
    expect(ref.reference).toEqual(payload);
    expect(ref.objective).toEqual(payload.objective);
    expect(referenceBuildFrom(payload).id).toBe(ref.id);
  });

  it('re-share their stored payload, honouring the rotation toggle', () => {
    const ref = referenceBuildFrom(shared(true));
    const again = sharedBuildFromLibrary({ build: ref, roster: undefined, inventory: [], includeObjective: false });
    expect(again.objective).toBeUndefined();
    expect(again.echoes).toEqual(shared().echoes);
    expect(sharedBuildFromLibrary({ build: ref, roster: undefined, inventory: [], includeObjective: true }).objective).toEqual(
      build.objective,
    );
  });
});

describe('sharedCalculatorDraft', () => {
  it('carries roster context and drops rotation blocks the kit does not know', () => {
    const payload: SharedBuild = {
      ...shared(),
      objective: {
        kind: 'rotation-dpr',
        blocks: [
          { skillId: LIBERATION, motionName: MOTION, forteLevel: 10, activeBuffIds: ['buff-1'] },
          { skillId: 'gone', motionName: 'Removed Motion', forteLevel: 10, activeBuffIds: [] },
        ],
        buffs: [{ id: 'buff-1', label: 'Team buff', source: 'Team', mods: [{ stat: 'atkPct', value: 0.1 }] }],
        globalBuffIds: [],
        crit: 'expected',
      },
    };
    const draft = sharedCalculatorDraft(payload, jiyan);
    expect(draft.roster).toMatchObject({ characterId: 'jiyan', resonanceChain: 2, weaponId: 'verdant-summit', weaponRank: 1 });
    expect(draft.rotation?.blocks.map((b) => b.motionName)).toEqual([MOTION]);
    expect(draft.skippedBlocks).toBe(1);
    expect(sharedCalculatorDraft(shared(), jiyan).rotation).toBeUndefined();
  });
});
