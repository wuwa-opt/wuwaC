import { describe, expect, it } from 'vitest';
import { MIN_STAT_FIELDS, minStatTextsFor, parseMinStatTexts } from './minStatFields.ts';

describe('parseMinStatTexts', () => {
  it('turns % text into sheet fractions', () => {
    const parsed = parseMinStatTexts({ energyRegen: '20', critRate: ' 70 ', critDmg: '180.5' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.minStats?.energyRegen).toBeCloseTo(0.2, 10);
    expect(parsed.minStats?.critRate).toBeCloseTo(0.7, 10);
    expect(parsed.minStats?.critDmg).toBeCloseTo(1.805, 10);
  });

  it('treats empty and zero boxes as no minimum, and none left as undefined (never {})', () => {
    expect(parseMinStatTexts({})).toEqual({ ok: true, minStats: undefined });
    expect(parseMinStatTexts({ critRate: '', critDmg: '  ', energyRegen: '0' })).toEqual({ ok: true, minStats: undefined });
    expect(parseMinStatTexts({ critRate: '0', critDmg: '150' })).toEqual({ ok: true, minStats: { critDmg: 1.5 } });
  });

  it('names the failing field and rejects non-numbers and negatives', () => {
    for (const bad of ['abc', '-5', '1e999']) {
      const parsed = parseMinStatTexts({ critRate: bad });
      expect(parsed).toEqual({
        ok: false,
        message: 'Minimum Crit Rate must be a non-negative number (in %), or empty for no minimum.',
      });
    }
  });
});

describe('minStatTextsFor', () => {
  it('round-trips through parseMinStatTexts without float noise', () => {
    const texts = minStatTextsFor({ energyRegen: 0.2, critRate: 0.7000000000000001 });
    expect(texts).toEqual({ energyRegen: '20', critRate: '70' });
    expect(minStatTextsFor(undefined)).toEqual({});
  });

  it('only covers the editable fields', () => {
    expect(minStatTextsFor({ atk: 100, critRate: 0.5 })).toEqual({ critRate: '50' });
    expect(MIN_STAT_FIELDS.map((f) => f.stat)).toEqual(['energyRegen', 'critRate', 'critDmg']);
  });
});
