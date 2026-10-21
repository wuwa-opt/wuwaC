import { findEchoDef } from '../data/index.ts';
import type { Build, OwnedEcho, Snapshot } from '../data/schema.ts';
import { echoRollValue } from '../domain/rollValue.ts';

export function sonataName(snapshot: Snapshot, sonataId: string): string {
  return snapshot.sonataSets.find((s) => s.id === sonataId)?.name ?? sonataId;
}

/** Nickname first, then the real def name, then the raw id (orphans). */
export function echoDisplayName(snapshot: Snapshot, echo: OwnedEcho): string {
  if (echo.label) return echo.label;
  return findEchoDef(snapshot, echo.echoDefId)?.name ?? echo.echoDefId;
}

/** Echoes of an own build that are no longer in the inventory, per slot (slot 1 first). */
export function missingSlots(build: Build, inventory: readonly OwnedEcho[]): number[] {
  const owned = new Set(inventory.map((e) => e.id));
  return build.echoIds.flatMap((id, slot) => (owned.has(id) ? [] : [slot]));
}

/** Roll value of an echo, or null when none of its substats are tiered. */
export function echoScore(echo: OwnedEcho): number | null {
  return echoRollValue(echo.substats);
}


/**
 * Speech-bubble line for the Inventory banner. Only counts and an average
 * of values already on the echoes — nothing invented.
 */
export function inventorySummary(input: {
  loaded: boolean;
  echoes: readonly OwnedEcho[];
  /** Echoes whose def link is broken (orphans / mismatches). */
  flagged: number;
}): string {
  const { loaded, echoes, flagged } = input;
  if (!loaded) return 'Loading your echoes…';
  if (echoes.length === 0) return 'Your Echo Box is empty — add one or import a Kamera file.';
  const sets = new Set(echoes.map((e) => e.sonataId)).size;
  const parts = [
    `You're holding ${echoes.length} ${echoes.length === 1 ? 'echo' : 'echoes'} across ${sets} Sonata ${sets === 1 ? 'set' : 'sets'}.`,
  ];
  if (flagged > 0) parts.push(`${flagged} ${flagged === 1 ? 'needs' : 'need'} re-linking.`);
  const scores = echoes.map(echoScore).filter((s): s is number => s !== null);
  if (scores.length > 0) {
    const avg = scores.reduce((sum, s) => sum + s, 0) / scores.length;
    parts.push(`Average roll value: ${Math.round(avg)}.`);
  }
  return parts.join(' ');
}
