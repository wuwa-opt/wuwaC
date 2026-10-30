import { describe, expect, it } from 'vitest';
import { echoFingerprint, scannedFingerprintInput, toDraft } from './draft.ts';
import type { PanelParse, ScannedEcho } from './parse.ts';

const ECHO: ScannedEcho = {
  echoDefId: 'kerasaur',
  cost: 3,
  level: 25,
  rarity: 5,
  sonataId: 'flaming-clawprint',
  mainStat: { stat: 'dmgBonus:Fusion', value: 0.3 },
  secondMainStat: { stat: 'atk', value: 100 },
  substats: [
    { stat: 'critRate', value: 0.063 },
    { stat: 'energyRegen', value: 0.084 },
  ],
  equippedTo: 'denia',
};

describe('toDraft', () => {
  it('converts a clean parse, keeping on-screen substat order', () => {
    expect(toDraft({ echo: ECHO, flags: [] })).toEqual({
      echoDefId: 'kerasaur',
      sonataId: 'flaming-clawprint',
      cost: 3,
      level: 25,
      rarity: 5,
      mainStat: { stat: 'dmgBonus:Fusion', value: 0.3 },
      secondMainStat: { stat: 'atk', value: 100 },
      substats: [
        { stat: 'critRate', value: 0.063 },
        { stat: 'energyRegen', value: 0.084 },
      ],
      equippedTo: 'denia',
    });
  });

  it('lets review flags through but blocks on errors and unread fields', () => {
    const review: PanelParse = { echo: ECHO, flags: [{ field: 'name', severity: 'review', message: 'approx' }] };
    expect(toDraft(review)).not.toBeNull();
    expect(toDraft({ echo: ECHO, flags: [{ field: 'sub1', severity: 'error', message: 'bad' }] })).toBeNull();
    expect(toDraft({ echo: { ...ECHO, mainStat: null }, flags: [] })).toBeNull();
    expect(toDraft({ echo: { ...ECHO, substats: [null] }, flags: [] })).toBeNull();
  });
});

describe('echoFingerprint', () => {
  it('ignores substat order and equip state, but not values', () => {
    const a = scannedFingerprintInput(ECHO)!;
    const reordered = { ...a, substats: [...a.substats].reverse() };
    expect(echoFingerprint(reordered)).toBe(echoFingerprint(a));
    expect(echoFingerprint({ ...a, substats: [{ stat: 'critRate', value: 0.069 }, a.substats[1]] })).not.toBe(echoFingerprint(a));
    expect(echoFingerprint({ ...a, level: 20 })).not.toBe(echoFingerprint(a));
  });

  it('is a readable, hand-checkable string', () => {
    expect(echoFingerprint(scannedFingerprintInput(ECHO)!)).toBe(
      'kerasaur|flaming-clawprint|5|25|dmgBonus:Fusion=0.3000|critRate=0.0630,energyRegen=0.0840',
    );
  });
});
