import { describe, expect, it } from 'vitest';
import { filterByName, filterByUsage } from './filter.ts';

const items = [{ name: 'Jiyan' }, { name: 'Jinhsi' }, { name: 'Verina' }];

describe('filterByName', () => {
  it('matches case-insensitive substrings', () => {
    expect(filterByName(items, (i) => i.name, 'ji').map((i) => i.name)).toEqual(['Jiyan', 'Jinhsi']);
    expect(filterByName(items, (i) => i.name, 'VER')).toEqual([{ name: 'Verina' }]);
  });

  it('returns everything on empty/blank queries', () => {
    expect(filterByName(items, (i) => i.name, '')).toHaveLength(3);
    expect(filterByName(items, (i) => i.name, '   ')).toHaveLength(3);
  });

  it('returns nothing when nothing matches', () => {
    expect(filterByName(items, (i) => i.name, 'zzz')).toEqual([]);
  });
});

describe('filterByUsage', () => {
  const echoes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  const usage = new Map([
    ['a', { status: 'in-use' as const }],
    ['b', { status: 'unused' as const }],
    ['c', { status: 'fodder' as const }],
  ]);

  it('treats fodder as a subset of unused', () => {
    expect(filterByUsage(echoes, usage, 'unused').map((e) => e.id)).toEqual(['b', 'c']);
    expect(filterByUsage(echoes, usage, 'fodder').map((e) => e.id)).toEqual(['c']);
  });

  it('keeps everything, verdict or not, for all', () => {
    expect(filterByUsage(echoes, usage, 'all')).toHaveLength(4);
  });
});
