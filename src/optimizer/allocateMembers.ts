import type { Build, CharacterData, RosterEntry, SonataSetData, WeaponData } from '../data/schema.ts';
import { characterResonanceModes } from '../domain/characterMods.ts';
import { buildEnemyProfile, type EnemyKind } from '../domain/enemy.ts';
import type { AllocationMember, AllocationResult } from './allocate.ts';
import { pruneInputs } from './prune.ts';

/**
 * Optimizer layer: turn a team member into an `AllocationMember`, or say why
 * it can't run. Pure; the caller passes plain data read from the stores.
 *
 * Objective and context come from a saved build (`Build.objective`,
 * `Build.context`), never invented:
 * - the build is the member's newest own (non-reference) build with an
 *   objective unless the caller picks another;
 * - context is `build.context`, else the Roster entry (only when the Roster
 *   weapon is the build's weapon);
 * - the enemy is the Calculator's current settings, shared by every member.
 */

export interface EnemySettings {
  kind: EnemyKind;
  level: number;
  baseRES: number;
}

export interface MemberInputs {
  characterId: string;
  /** Chosen build id; absent or unknown = the newest objective build. */
  buildId?: string;
  builds: readonly Build[];
  roster: readonly RosterEntry[];
  characters: readonly CharacterData[];
  weapons: readonly WeaponData[];
  sonataSets: readonly SonataSetData[];
  enemy: EnemySettings;
}

export type ResolvedMember =
  | { ok: true; characterId: string; build: Build; choices: Build[]; member: AllocationMember }
  | { ok: false; characterId: string; choices: Build[]; reason: string };

/** The member's own builds that carry an objective, newest first. */
export function objectiveBuildsFor(builds: readonly Build[], characterId: string): Build[] {
  return builds
    .filter((b) => b.characterId === characterId && b.reference === undefined && b.objective !== undefined)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}

export function resolveMember(input: MemberInputs): ResolvedMember {
  const { characterId } = input;
  const choices = objectiveBuildsFor(input.builds, characterId);
  const block = (reason: string): ResolvedMember => ({ ok: false, characterId, choices, reason });

  const character = input.characters.find((c) => c.id === characterId);
  if (character === undefined) return block(`${characterId} is not in the current game data.`);
  if (characterResonanceModes(characterId).length > 0) {
    return block(
      `${character.name} has Resonance Modes. Set the mode in the Calculator; allocating for dual-mode characters isn't supported here yet.`,
    );
  }
  const build = choices.find((b) => b.id === input.buildId) ?? choices[0];
  if (build === undefined || build.objective === undefined) {
    return block(`${character.name} has no saved build with an objective. Save one from the Calculator first.`);
  }
  const context = build.context ?? input.roster.find((r) => r.characterId === characterId);
  if (context === undefined) {
    return block(`No Roster entry or saved context for ${character.name}. Add them to the Roster first.`);
  }
  if (context.characterId !== characterId || context.weaponId !== build.weaponId) {
    return block(
      build.context === undefined
        ? `The Roster has ${character.name} on a different weapon than "${build.name}". Pick another build or update the Roster.`
        : `"${build.name}" saved a context for a different character or weapon.`,
    );
  }
  const weapon = input.weapons.find((w) => w.id === build.weaponId);
  if (weapon === undefined) return block(`"${build.name}" uses a weapon that is not in the current game data.`);
  if (weapon.weaponType !== character.weaponType) {
    return block(`${character.name} can't use ${weapon.name} (needs a ${character.weaponType}).`);
  }
  try {
    pruneInputs(character, build.objective);
  } catch {
    return block(`"${build.name}" no longer matches current game data (its skill is gone).`);
  }
  let enemy;
  try {
    enemy = buildEnemyProfile(input.enemy.kind, input.enemy.level, input.enemy.baseRES, character.attribute);
  } catch (err) {
    return block(err instanceof Error ? err.message : 'The enemy settings are invalid.');
  }
  return {
    ok: true,
    characterId,
    build,
    choices,
    member: {
      characterId,
      objective: build.objective,
      context: { character, weapon, roster: context, sonataSets: [...input.sonataSets], enemy },
    },
  };
}

/** Slot order for a saved build: the winning main Echo first (slot 1), the rest sorted. */
export function slotOrder(echoIds: readonly string[], mainEchoId: string | undefined): [string, string, string, string, string] {
  const rest = echoIds.filter((id) => id !== mainEchoId).sort();
  return (mainEchoId === undefined ? rest : [mainEchoId, ...rest]) as [string, string, string, string, string];
}

export type AllocationBuildDraft = Omit<Build, 'id' | 'updatedAt'>;

/**
 * One draft per member that got a build, in priority order. Objective,
 * `objectiveId`, weapon and context are the source build's / resolved ones,
 * so the saved build re-runs and shares like any other.
 */
export function allocationDrafts(input: {
  teamName: string;
  resolved: readonly ResolvedMember[];
  allocation: AllocationResult;
  characterName: (id: string) => string;
}): AllocationBuildDraft[] {
  const drafts: AllocationBuildDraft[] = [];
  const count = input.allocation.members.length;
  input.allocation.members.forEach((result, index) => {
    const resolved = input.resolved.find((r) => r.characterId === result.characterId);
    if (result.best === null || resolved === undefined || !resolved.ok) return;
    drafts.push({
      name: `${input.teamName} · ${input.characterName(result.characterId)}`,
      characterId: result.characterId,
      weaponId: resolved.build.weaponId,
      echoIds: slotOrder(result.best.echoIds, result.best.mainEchoId),
      objectiveId: resolved.build.objectiveId,
      objective: resolved.member.objective,
      score: result.best.score,
      notes: `Team allocation for ${input.teamName} (greedy, priority ${index + 1} of ${count}).`,
      // Plain copy: the run used this context, and it must not alias store state.
      context: JSON.parse(JSON.stringify(resolved.member.context.roster)) as RosterEntry,
    });
  });
  return drafts;
}
