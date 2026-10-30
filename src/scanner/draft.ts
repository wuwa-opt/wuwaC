import type { OwnedEcho } from '../data/schema.ts';
import type { PanelParse, ScannedEcho } from './parse.ts';

/**
 * Scanner layer: from a parsed panel to an inventory draft, plus the
 * fingerprint used to recognize Echoes the inventory already holds.
 */

/** Same shape the Kamera importer feeds `importEchoes` (store derives id/origin). */
export type ScanDraft = Omit<OwnedEcho, 'id' | 'origin'>;

/** `origin` tag for scanned rows (schema.ts convention). */
export const SCAN_ORIGIN = 'import:screen-scan';

/**
 * Null while any error flag stands or a required field is unread. Review
 * flags do not block: the UI shows them, the user decides. An unresolved
 * "Equipped by" choice (e.g. Rover) imports as unequipped.
 */
export function toDraft({ echo, flags }: PanelParse): ScanDraft | null {
  if (flags.some((f) => f.severity === 'error')) return null;
  const { echoDefId, sonataId, cost, level, mainStat, secondMainStat, substats } = echo;
  if (echoDefId === null || sonataId === null || cost === null || level === null || mainStat === null || secondMainStat === null) return null;
  if (substats.some((s) => s === null)) return null;
  return {
    echoDefId,
    sonataId,
    cost,
    level,
    rarity: echo.rarity,
    mainStat,
    secondMainStat,
    substats: substats.filter((s) => s !== null),
    equippedTo: echo.equippedTo,
  };
}

type FingerprintInput = Pick<OwnedEcho, 'echoDefId' | 'sonataId' | 'level' | 'rarity' | 'mainStat' | 'substats'>;

function statPart(s: { stat: string; value: number }): string {
  return `${s.stat}=${s.value.toFixed(4)}`;
}

/**
 * Identity of an Echo's rolls. The game shows no per-copy id, so two
 * Echoes are "the same" when def, set, rarity, level, main stat and the
 * substat multiset agree. Substats are sorted: other importers do not
 * preserve on-screen order. `equippedTo` is deliberately excluded —
 * moving an Echo between characters does not make it a different Echo.
 */
export function echoFingerprint(e: FingerprintInput): string {
  const subs = e.substats.map(statPart).sort().join(',');
  return [e.echoDefId, e.sonataId, e.rarity, e.level, statPart(e.mainStat), subs].join('|');
}

/** Helper for UIs: a ScannedEcho is complete enough to fingerprint. */
export function scannedFingerprintInput(echo: ScannedEcho): FingerprintInput | null {
  if (echo.echoDefId === null || echo.sonataId === null || echo.level === null || echo.mainStat === null || echo.substats.some((s) => s === null)) {
    return null;
  }
  return {
    echoDefId: echo.echoDefId,
    sonataId: echo.sonataId,
    level: echo.level,
    rarity: echo.rarity,
    mainStat: echo.mainStat,
    substats: echo.substats.filter((s) => s !== null),
  };
}
