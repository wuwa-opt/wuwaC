import { describe, expect, it } from 'vitest';
import { loadBundledSnapshot } from '../data/index.ts';
import { buildSchema, type Build, type RosterEntry } from '../data/schema.ts';
import type { AllocationResult } from './allocate.ts';
import {
  allocationDrafts,
  objectiveBuildsFor,
  resolveMember,
  slotOrder,
  type MemberInputs,
} from './allocateMembers.ts';

const snapshot = loadBundledSnapshot();

const rosterFor = (characterId: string, weaponId: string): RosterEntry => ({
  characterId,
  level: 90,
  ascension: 6,
  resonanceChain: 0,
  forteLevels: {},
  weaponId,
  weaponLevel: 90,
  weaponRank: 1,
});

const mkBuild = (id: string, extra: Partial<Build> = {}): Build => ({
  id,
  name: id,
  characterId: 'jiyan',
  weaponId: 'verdant-summit',
  echoIds: ['a', 'b', 'c', 'd', 'e'],
  objectiveId: 'Max ATK',
  objective: { kind: 'max-stat', stat: 'atk' },
  updatedAt: '2026-10-20T00:00:00.000Z',
  ...extra,
});

const inputs = (over: Partial<MemberInputs> = {}): MemberInputs => ({
  characterId: 'jiyan',
  builds: [mkBuild('b1')],
  roster: [rosterFor('jiyan', 'verdant-summit')],
  characters: snapshot.characters,
  weapons: snapshot.weapons,
  sonataSets: snapshot.sonataSets,
  enemy: { kind: 'mob', level: 90, baseRES: 0.1 },
  ...over,
});

describe('objectiveBuildsFor', () => {
  it("lists the character's own objective builds newest first, skipping references and no-objective builds", () => {
    const builds = [
      mkBuild('old', { updatedAt: '2026-10-01T00:00:00.000Z' }),
      mkBuild('new', { updatedAt: '2026-10-21T00:00:00.000Z' }),
      mkBuild('none', { objective: undefined }),
      mkBuild('other', { characterId: 'verina' }),
      mkBuild('ref', { reference: {} as Build['reference'], updatedAt: '2026-10-22T00:00:00.000Z' }),
    ];
    expect(objectiveBuildsFor(builds, 'jiyan').map((b) => b.id)).toEqual(['new', 'old']);
  });
});

describe('resolveMember', () => {
  it('uses the newest objective build by default and the picked one when asked', () => {
    const builds = [mkBuild('old', { updatedAt: '2026-10-01T00:00:00.000Z' }), mkBuild('new', { updatedAt: '2026-10-21T00:00:00.000Z' })];
    const def = resolveMember(inputs({ builds }));
    expect(def.ok && def.build.id).toBe('new');
    const picked = resolveMember(inputs({ builds, buildId: 'old' }));
    expect(picked.ok && picked.build.id).toBe('old');
    expect(resolveMember(inputs({ builds, buildId: 'gone' })).ok).toBe(true); // unknown pick falls back
  });

  it('prefers the context saved with the build over the Roster, and falls back to the Roster', () => {
    const saved = { ...rosterFor('jiyan', 'verdant-summit'), level: 70 };
    const withContext = resolveMember(inputs({ builds: [mkBuild('b1', { context: saved })] }));
    expect(withContext.ok && withContext.member.context.roster.level).toBe(70);
    const fallback = resolveMember(inputs());
    expect(fallback.ok && fallback.member.context.roster.level).toBe(90);
  });

  it('blocks with a reason instead of guessing', () => {
    const reason = (r: ReturnType<typeof resolveMember>): string => (r.ok ? '' : r.reason);
    expect(reason(resolveMember(inputs({ characterId: 'nobody' })))).toMatch(/not in the current game data/);
    expect(reason(resolveMember(inputs({ builds: [mkBuild('plain', { objective: undefined })] })))).toMatch(
      /no saved build with an objective/,
    );
    expect(reason(resolveMember(inputs({ roster: [] })))).toMatch(/No Roster entry or saved context/);
    expect(reason(resolveMember(inputs({ roster: [rosterFor('jiyan', 'augment')] })))).toMatch(/different weapon/);
    expect(reason(resolveMember(inputs({ builds: [mkBuild('w', { weaponId: 'nonexistent-weapon' })], roster: [rosterFor('jiyan', 'nonexistent-weapon')] })))).toMatch(
      /not in the current game data/,
    );
    expect(reason(resolveMember(inputs({ builds: [mkBuild('w', { weaponId: 'augment' })], roster: [rosterFor('jiyan', 'augment')] })))).toMatch(
      /can't use/,
    );
    const stale = mkBuild('s', { objective: { kind: 'expected-damage', skillId: 'gone', motionName: 'x', forteLevel: 10, crit: 'expected' } });
    expect(reason(resolveMember(inputs({ builds: [stale] })))).toMatch(/no longer matches current game data/);
  });

  it('blocks dual-mode (Resonance Mode) characters and points to the Calculator', () => {
    const denia = resolveMember(
      inputs({
        characterId: 'denia',
        builds: [mkBuild('d', { characterId: 'denia', weaponId: 'augment' })],
        roster: [rosterFor('denia', 'augment')],
      }),
    );
    expect(denia.ok).toBe(false);
    expect(!denia.ok && denia.reason).toMatch(/Resonance Modes.*Calculator/);
  });

  it("builds the enemy from the Calculator's settings for the member's attribute", () => {
    const mob = resolveMember(inputs());
    const boss = resolveMember(inputs({ enemy: { kind: 'boss', level: 100, baseRES: 0.2 } }));
    expect(mob.ok && boss.ok).toBe(true);
    if (!mob.ok || !boss.ok) return;
    const attribute = mob.member.context.character.attribute;
    expect(mob.member.context.enemy.baseResistance[attribute]).toBe(0.1);
    expect(boss.member.context.enemy.baseResistance[attribute]).toBe(0.4); // elemental boss preset floor
    expect(boss.member.context.enemy.level).toBe(100);
  });

  it('is blocked, not thrown, for invalid enemy settings', () => {
    const r = resolveMember(inputs({ enemy: { kind: 'mob', level: 0, baseRES: 0.1 } }));
    expect(r.ok).toBe(false);
  });
});

describe('slotOrder', () => {
  it('puts the main Echo first and sorts the rest', () => {
    expect(slotOrder(['e', 'c', 'a', 'b', 'd'], 'c')).toEqual(['c', 'a', 'b', 'd', 'e']);
    expect(slotOrder(['e', 'c', 'a', 'b', 'd'], undefined)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

describe('allocationDrafts', () => {
  const resolved = [
    resolveMember(inputs()),
    resolveMember(
      inputs({
        characterId: 'verina',
        builds: [mkBuild('v', { characterId: 'verina', weaponId: 'augment', objectiveId: 'Verina DPR' })],
        roster: [rosterFor('verina', 'augment')],
      }),
    ),
  ];
  const ranked = (echoIds: string[], mainEchoId?: string) => ({
    echoIds,
    score: 123.5,
    sheet: {} as never,
    warnings: [],
    appliedAssumptions: [],
    ...(mainEchoId === undefined ? {} : { mainEchoId }),
  });
  const allocation: AllocationResult = {
    members: [
      { characterId: 'jiyan', pool: 10, best: ranked(['e5', 'e1', 'e2', 'e3', 'e4'], 'e3'), baseline: null, baselineNote: 'x' },
      { characterId: 'verina', pool: 5, best: null, baseline: null, baselineNote: 'x' },
    ],
  };

  it('makes one valid, re-runnable build per member that got a result', () => {
    const drafts = allocationDrafts({ teamName: 'Main', resolved, allocation, characterName: (id) => id.toUpperCase() });
    expect(drafts).toHaveLength(1);
    const [draft] = drafts;
    expect(draft).toMatchObject({
      name: 'Main · JIYAN',
      characterId: 'jiyan',
      weaponId: 'verdant-summit',
      objectiveId: 'Max ATK',
      objective: { kind: 'max-stat', stat: 'atk' },
      score: 123.5,
      echoIds: ['e3', 'e1', 'e2', 'e4', 'e5'],
    });
    expect(draft.notes).toContain('greedy, priority 1 of 2');
    // Passes the real build schema (context must match character and weapon).
    expect(() => buildSchema.parse({ ...draft, id: 'x', updatedAt: new Date().toISOString() })).not.toThrow();
  });

  it('copies the context instead of aliasing store state', () => {
    const [draft] = allocationDrafts({ teamName: 'Main', resolved, allocation, characterName: (id) => id });
    const first = resolved[0];
    if (!first.ok) throw new Error('expected a resolved member');
    expect(draft.context).toEqual(first.member.context.roster);
    expect(draft.context).not.toBe(first.member.context.roster);
    expect(draft.context?.forteLevels).not.toBe(first.member.context.roster.forteLevels);
  });
});
