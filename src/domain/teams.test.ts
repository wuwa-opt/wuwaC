import { describe, expect, it } from 'vitest';
import type { OwnedEcho, StatKey, Team } from '../data/schema.ts';
import { isTeamPermutation, teamPriority, teamSonataCoverage } from './teams.ts';

function mkEcho(id: string, defId: string, sonataId: string, equippedTo: string | null): OwnedEcho {
  return {
    id,
    label: id,
    echoDefId: defId,
    sonataId,
    cost: 3,
    level: 25,
    rarity: 5,
    mainStat: { stat: 'atk' as StatKey, value: 100 },
    substats: [],
    equippedTo,
    origin: 'manual',
  };
}

const team: Team = { id: 't', name: 'Main', characterIds: ['jiyan', 'verina', 'rover'] };
const names = (id: string): string => ({ 'sierra-gale': 'Sierra Gale', 'rejuvenating-glow': 'Rejuvenating Glow' })[id] ?? id;

describe('teamSonataCoverage', () => {
  it('counts distinct definitions per member, ignoring duplicates and others', () => {
    const echoes = [
      mkEcho('a', 'def-a', 'sierra-gale', 'jiyan'),
      mkEcho('b', 'def-b', 'sierra-gale', 'jiyan'),
      mkEcho('c', 'def-a', 'sierra-gale', 'jiyan'), // same def as a: no double count
      mkEcho('d', 'def-c', 'rejuvenating-glow', 'verina'),
      mkEcho('e', 'def-d', 'sierra-gale', 'outsider'), // not on the team
      mkEcho('f', 'def-e', 'sierra-gale', null), // unequipped
    ];
    const coverage = teamSonataCoverage(echoes, team, names);
    const jiyan = coverage.members.find((m) => m.characterId === 'jiyan')!;
    expect(jiyan.totalEchoes).toBe(3);
    expect(jiyan.pieces).toEqual([{ sonataId: 'sierra-gale', sonataName: 'Sierra Gale', count: 2 }]);
    const verina = coverage.members.find((m) => m.characterId === 'verina')!;
    expect(verina.pieces).toEqual([
      { sonataId: 'rejuvenating-glow', sonataName: 'Rejuvenating Glow', count: 1 },
    ]);
    const rover = coverage.members.find((m) => m.characterId === 'rover')!;
    expect(rover.pieces).toEqual([]);
    expect(rover.totalEchoes).toBe(0);
    expect(coverage.combined).toEqual([
      { sonataId: 'sierra-gale', sonataName: 'Sierra Gale', count: 2 },
      { sonataId: 'rejuvenating-glow', sonataName: 'Rejuvenating Glow', count: 1 },
    ]);
  });
});

describe('teamPriority', () => {
  const members: [string, string, string] = ['jiyan', 'verina', 'yangyang'];

  it('uses a saved permutation of the members', () => {
    expect(teamPriority({ characterIds: members, priority: ['yangyang', 'jiyan', 'verina'] })).toEqual([
      'yangyang',
      'jiyan',
      'verina',
    ]);
  });

  it('falls back to team order for no priority or anything that is not a permutation', () => {
    expect(teamPriority({ characterIds: members })).toEqual(members);
    expect(teamPriority({ characterIds: members, priority: ['jiyan', 'jiyan', 'verina'] })).toEqual(members);
    expect(teamPriority({ characterIds: members, priority: ['jiyan', 'verina', 'rover'] })).toEqual(members);
  });

  it('isTeamPermutation needs every member exactly once', () => {
    expect(isTeamPermutation(['verina', 'yangyang', 'jiyan'], members)).toBe(true);
    expect(isTeamPermutation(undefined, members)).toBe(false);
    expect(isTeamPermutation(['verina', 'yangyang'], members)).toBe(false);
    expect(isTeamPermutation(['verina', 'yangyang', 'jiyan', 'rover'], members)).toBe(false);
  });
});
