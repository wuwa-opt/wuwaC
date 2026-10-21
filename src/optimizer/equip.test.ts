import { describe, expect, it } from 'vitest';
import type { OwnedEcho } from '../data/schema.ts';
import type { AllocationResult, MemberAllocation } from './allocate.ts';
import { planEquip } from './equip.ts';
import type { RankedBuild } from './search.ts';

const echo = (id: string, equippedTo: string | null = null, extra: Partial<OwnedEcho> = {}): OwnedEcho => ({
  id,
  echoDefId: 'def',
  sonataId: 'sierra-gale',
  cost: 1,
  level: 25,
  rarity: 5,
  mainStat: { stat: 'hp', value: 0 },
  substats: [],
  equippedTo,
  origin: 'manual',
  ...extra,
});

const build = (...ids: string[]): RankedBuild => ({
  echoIds: ids,
  score: 1,
  sheet: {} as RankedBuild['sheet'],
  warnings: [],
  appliedAssumptions: [],
});
const member = (characterId: string, best: RankedBuild | null): MemberAllocation => ({
  characterId,
  pool: 10,
  best,
  baseline: null,
  baselineNote: null,
});
const result = (...members: MemberAllocation[]): AllocationResult => ({ members });
const five = (prefix: string): string[] => [1, 2, 3, 4, 5].map((n) => `${prefix}${n}`);

describe('planEquip', () => {
  it('assigns allocated Echoes from the bag and nothing else', () => {
    const echoes = [...five('a'), ...five('b')].map((id) => echo(id));
    const plan = planEquip(result(member('jiyan', build(...five('a')))), echoes);
    expect(plan.changes).toEqual(five('a').map((id) => ({ id, equippedTo: 'jiyan' })));
    expect(plan.assigned).toEqual([{ characterId: 'jiyan', count: 5 }]);
    expect(plan.takenFrom).toEqual([]);
    expect(plan.unequipped).toBe(0);
  });

  it('swaps inside the team: the loser gets the winner\'s old Echoes unless they are reassigned too', () => {
    // jiyan wears a1..a5, verina wears b1..b5; the allocation swaps the two sets.
    const echoes = [...five('a').map((id) => echo(id, 'jiyan')), ...five('b').map((id) => echo(id, 'verina'))];
    const plan = planEquip(result(member('jiyan', build(...five('b'))), member('verina', build(...five('a')))), echoes);
    expect(new Map(plan.changes.map((c) => [c.id, c.equippedTo]))).toEqual(
      new Map([...five('b').map((id) => [id, 'jiyan']), ...five('a').map((id) => [id, 'verina'])] as [string, string][]),
    );
    expect(plan.assigned).toEqual([
      { characterId: 'jiyan', count: 5 },
      { characterId: 'verina', count: 5 },
    ]);
    expect(plan.takenFrom).toEqual([
      { characterId: 'verina', count: 5 },
      { characterId: 'jiyan', count: 5 },
    ]);
    expect(plan.unequipped).toBe(0); // assignment beats unequip
  });

  it('takes an Echo from an outside character, who loses it', () => {
    const echoes = [...five('a').map((id) => echo(id)), echo('a1', 'calcharo')].slice(1);
    const plan = planEquip(result(member('jiyan', build(...five('a')))), echoes);
    expect(plan.changes).toContainEqual({ id: 'a1', equippedTo: 'jiyan' });
    expect(plan.takenFrom).toEqual([{ characterId: 'calcharo', count: 1 }]);
    expect(plan.assigned).toEqual([{ characterId: 'jiyan', count: 5 }]);
    expect(plan.unequipped).toBe(0); // calcharo has no result: only what was taken moves
  });

  it('puts the member\'s old Echoes that are not reused back in the bag', () => {
    const echoes = [...five('a').map((id) => echo(id)), ...five('o').map((id) => echo(id, 'jiyan'))];
    const plan = planEquip(result(member('jiyan', build(...five('a')))), echoes);
    expect(plan.unequipped).toBe(5);
    expect(plan.changes.filter((c) => c.equippedTo === null).map((c) => c.id).sort()).toEqual(five('o'));
    expect(plan.takenFrom).toEqual([]);
  });

  it('leaves a member without a result, and what they wear, untouched', () => {
    const echoes = [...five('a').map((id) => echo(id)), ...five('v').map((id) => echo(id, 'verina'))];
    const plan = planEquip(result(member('jiyan', build(...five('a'))), member('verina', null)), echoes);
    expect(plan.changes.every((c) => five('a').includes(c.id))).toBe(true);
    expect(plan.unequipped).toBe(0);
  });

  it('does not count or change Echoes already recorded on their member', () => {
    const echoes = five('a').map((id, i) => echo(id, i < 2 ? 'jiyan' : null));
    const plan = planEquip(result(member('jiyan', build(...five('a')))), echoes);
    expect(plan.unchanged).toBe(2);
    expect(plan.changes).toHaveLength(3);
    expect(plan.assigned).toEqual([{ characterId: 'jiyan', count: 3 }]);
  });

  it('ignores locks and is empty once applied', () => {
    const echoes = five('a').map((id) => echo(id, null, { locked: true }));
    const first = planEquip(result(member('jiyan', build(...five('a')))), echoes);
    expect(first.changes).toHaveLength(5);
    const applied = echoes.map((e) => ({ ...e, equippedTo: 'jiyan' }));
    const again = planEquip(result(member('jiyan', build(...five('a')))), applied);
    expect(again.changes).toEqual([]);
    expect(again.signature).not.toBe(first.signature);
  });

  it('skips allocated ids that are not in the inventory', () => {
    const plan = planEquip(result(member('jiyan', build(...five('a')))), [echo('a1')]);
    expect(plan.changes).toEqual([{ id: 'a1', equippedTo: 'jiyan' }]);
  });
});
