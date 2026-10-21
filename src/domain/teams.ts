import type { OwnedEcho, Team } from '../data/schema.ts';

/**
 * Domain layer: team Sonata coverage (reference doc §5, v1 scope).
 * Pure functions, no React. Outro/rotation modeling is an explicit v2
 * milestone — this module only counts equipped Echoes per member.
 */

export interface MemberCoverage {
  characterId: string;
  /** Distinct-definition piece counts per Sonata (reference doc §3 rule). */
  pieces: { sonataId: string; sonataName: string; count: number }[];
  totalEchoes: number;
}

export interface TeamCoverage {
  members: MemberCoverage[];
  /**
   * Equipped totals across the team, for display only — Sonata bonuses
   * apply per character, never team-wide.
   */
  combined: { sonataId: string; sonataName: string; count: number }[];
}

/**
 * Count equipped Echoes (via `equippedTo`) for each team member.
 * `sonataNameOf` resolves display names so this module never touches game data.
 * Order follows first-seen echoes (stable for a stable inventory order).
 */
export function teamSonataCoverage(
  echoes: OwnedEcho[],
  team: Team,
  sonataNameOf: (sonataId: string) => string,
): TeamCoverage {
  const byMember = new Map<string, OwnedEcho[]>(
    team.characterIds.map((id) => [id, []]),
  );
  for (const echo of echoes) {
    if (echo.equippedTo !== null && byMember.has(echo.equippedTo)) {
      byMember.get(echo.equippedTo)!.push(echo);
    }
  }
  const members: MemberCoverage[] = team.characterIds.map((characterId) => {
    const defs = new Map<string, Set<string>>();
    for (const echo of byMember.get(characterId)!) {
      let set = defs.get(echo.sonataId);
      if (!set) {
        set = new Set();
        defs.set(echo.sonataId, set);
      }
      set.add(echo.echoDefId);
    }
    return {
      characterId,
      pieces: [...defs].map(([sonataId, set]) => ({
        sonataId,
        sonataName: sonataNameOf(sonataId),
        count: set.size,
      })),
      totalEchoes: byMember.get(characterId)!.length,
    };
  });
  const combinedOrder: string[] = [];
  const combinedCounts = new Map<string, number>();
  for (const member of members) {
    for (const piece of member.pieces) {
      if (!combinedCounts.has(piece.sonataId)) combinedOrder.push(piece.sonataId);
      combinedCounts.set(piece.sonataId, (combinedCounts.get(piece.sonataId) ?? 0) + piece.count);
    }
  }
  return {
    members,
    combined: combinedOrder.map((sonataId) => ({
      sonataId,
      sonataName: sonataNameOf(sonataId),
      count: combinedCounts.get(sonataId)!,
    })),
  };
}

/** True when `order` holds exactly the team's three members, each once. */
export function isTeamPermutation(order: readonly string[] | undefined, characterIds: readonly string[]): boolean {
  return (
    order !== undefined &&
    order.length === characterIds.length &&
    new Set(order).size === order.length &&
    order.every((id) => characterIds.includes(id))
  );
}

/**
 * Team allocation priority: the saved `team.priority` when it is a
 * permutation of the members, else team order. Anything else is ignored.
 */
export function teamPriority(team: Pick<Team, 'characterIds' | 'priority'>): [string, string, string] {
  const order = isTeamPermutation(team.priority, team.characterIds) ? team.priority! : team.characterIds;
  return [order[0], order[1], order[2]];
}
