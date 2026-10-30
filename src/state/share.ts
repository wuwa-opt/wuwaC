import { ZodError } from 'zod';
import { MAIN_STAT_RANGES, SECONDARY_MAIN_STAT_MAX, SUB_STAT_TIERS } from '../data/echoStats.ts';
import {
  buildSchema,
  SHARED_BUILD_VERSION,
  SHARED_BUILD_VERSION_SETTINGS,
  sharedBuildSchema,
  type Build,
  type CharacterData,
  type ObjectiveSpec,
  type OwnedEcho,
  type RosterEntry,
  type RotationBlockSpec,
  type SharedBuild,
  type SharedEcho,
  type Snapshot,
  type StatKey,
  type WeaponData,
} from '../data/schema.ts';
import { characterResonanceModes, type ResonanceMode } from '../domain/characterMods.ts';
import type { EnemySettings } from '../domain/enemy.ts';
import { isBlockStale, type RotationBuff } from '../domain/rotation.ts';
import { computeAtk, computeDef, computeHp, computeStats } from '../domain/stats.ts';
import { effectiveMinStats, type MinStats } from '../optimizer/minStats.ts';

/**
 * State layer: shareable build links. Client-side only (no backend); the
 * payload rides in the URL fragment, which browsers never send to a server.
 *
 * v2/v3: `#b=<tag>.<base64url(deflate-raw(JSON SharedBuild))>`. The
 *   `2.`/`3.` tag sits before the payload, so the version is known before
 *   anything is decompressed ('.' is outside the base64url alphabet).
 *   Self-contained: the 5 Echoes' stats, roster context and (opt-in) the
 *   objective spec — see `sharedBuildSchema`. v3 adds the run settings
 *   (enemy, Resonance Mode, minimum stats); the encoder emits v2 when a
 *   build has none, so plain links still open in older app copies. The tag
 *   must match the payload's `v`.
 * v1 (legacy, decode only): `#b=<base64url(JSON {v: 1, build})>`; a bare
 *   `Build` whose `echoIds` mean nothing outside the sender's inventory.
 *
 * Every link is untrusted input: the hash length is capped before any
 * decoding, the inflated size is capped while streaming, and the payload
 * must pass the strict schema. Errors are readable, never crashes.
 */

/** v1 envelope version (legacy links). */
export const BUILD_LINK_VERSION = 1;
/** Longest `#b=…` hash we decode at all (checked before base64/inflate). */
export const MAX_SHARE_HASH_LENGTH = 16_384;
/** Most bytes a v2/v3 payload may inflate to (decompression-bomb guard). */
export const MAX_SHARE_JSON_BYTES = 65_536;

const BASE64URL = /^[A-Za-z0-9_-]*$/;

export type DecodedShareLink = { version: 1; build: Build } | { version: 2 | 3; shared: SharedBuild };

/** One readable line for a schema failure (first issue, with its path). */
function describeZodError(err: ZodError): string {
  const issue = err.issues[0];
  const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  return `${path}${issue.message}`;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  if (!BASE64URL.test(text)) throw new Error('build link is not valid base64');
  try {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  } catch {
    throw new Error('build link is not valid base64');
  }
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function streamOf(bytes: Uint8Array<ArrayBuffer>): ReadableStream<BufferSource> {
  return new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function requireStreams(): void {
  if (typeof CompressionStream === 'undefined' || typeof DecompressionStream === 'undefined') {
    throw new Error('this browser cannot compress or open build links (no CompressionStream support)');
  }
}

async function deflateRaw(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  requireStreams();
  const reader = streamOf(bytes).pipeThrough(new CompressionStream('deflate-raw')).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  return concat(chunks, total);
}

/** Inflate, aborting as soon as the output passes `cap` bytes. */
export async function inflateRawCapped(bytes: Uint8Array<ArrayBuffer>, cap: number): Promise<Uint8Array> {
  requireStreams();
  const reader = streamOf(bytes).pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let step: ReadableStreamReadResult<Uint8Array>;
    try {
      step = await reader.read();
    } catch {
      throw new Error('build link is not valid compressed data');
    }
    if (step.done) break;
    total += step.value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`build link expands past ${cap} bytes — refusing to read it`);
    }
    chunks.push(step.value);
  }
  return concat(chunks, total);
}

/** Validate and encode a v2/v3 payload as a URL hash fragment (caller prefixes the page URL). */
export async function encodeSharedBuild(shared: SharedBuild): Promise<string> {
  const valid = sharedBuildSchema.parse(shared);
  const json = new TextEncoder().encode(JSON.stringify(valid));
  // Mirror the decoder's caps so we never hand out a link it would refuse.
  if (json.byteLength > MAX_SHARE_JSON_BYTES) {
    throw new Error(`the build is too large to share (${json.byteLength} bytes, limit ${MAX_SHARE_JSON_BYTES}) — try without the rotation`);
  }
  const compressed = await deflateRaw(json);
  const hash = `#b=${valid.v}.${toBase64Url(compressed)}`;
  if (hash.length > MAX_SHARE_HASH_LENGTH) {
    throw new Error(
      `the link would be ${hash.length} characters (limit ${MAX_SHARE_HASH_LENGTH})` +
        (valid.objective ? ' — try again without the rotation' : ''),
    );
  }
  return hash;
}

/** Legacy v1 encoder — kept so tests can produce links already in the wild. */
export function encodeBuildLink(build: Build): string {
  const payload = JSON.stringify({ v: BUILD_LINK_VERSION, build });
  return `#b=${toBase64Url(new TextEncoder().encode(payload))}`;
}

/** Decode and validate a v1 hash fragment back into a build. Throws when corrupt. */
export function decodeBuildLink(hash: string): Build {
  if (!hash.startsWith('#b=')) {
    throw new Error('not a build link (missing #b= prefix)');
  }
  const json = new TextDecoder().decode(fromBase64Url(hash.slice(3)));
  let envelope: unknown;
  try {
    envelope = JSON.parse(json);
  } catch {
    throw new Error('build link is not valid JSON');
  }
  if (
    typeof envelope !== 'object' ||
    envelope === null ||
    (envelope as { v?: unknown }).v !== BUILD_LINK_VERSION
  ) {
    throw new Error(`unsupported build link version (expected ${BUILD_LINK_VERSION})`);
  }
  return buildSchema.parse((envelope as { build?: unknown }).build);
}

/** Decode any supported link version. Throws readable errors on bad input. */
export async function decodeShareLink(hash: string): Promise<DecodedShareLink> {
  if (!hash.startsWith('#b=')) throw new Error('not a build link (missing #b= prefix)');
  if (hash.length > MAX_SHARE_HASH_LENGTH) {
    throw new Error(`build link is too long (${hash.length} characters, limit ${MAX_SHARE_HASH_LENGTH})`);
  }
  const body = hash.slice(3);
  try {
    const tag = /^(\d+)\./.exec(body);
    if (tag !== null) {
      const version = Number(tag[1]);
      if (version !== SHARED_BUILD_VERSION && version !== SHARED_BUILD_VERSION_SETTINGS) {
        throw new Error(`unsupported build link version ${tag[1]}`);
      }
      const bytes = await inflateRawCapped(fromBase64Url(body.slice(tag[0].length)), MAX_SHARE_JSON_BYTES);
      let json: unknown;
      try {
        json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } catch {
        throw new Error('build link is not valid JSON');
      }
      const shared = sharedBuildSchema.parse(json);
      if (shared.v !== version) throw new Error(`build link tag ${version} doesn't match its payload (v${shared.v})`);
      return { version: shared.v, shared };
    }
    return { version: 1, build: decodeBuildLink(hash) };
  } catch (err) {
    if (err instanceof ZodError) throw new Error(`build link failed validation (${describeZodError(err)})`, { cause: err });
    throw err;
  }
}

// --- Sender side ----------------------------------------------------------------

function sharedEchoFrom(echo: OwnedEcho): SharedEcho {
  return {
    def: echo.echoDefId,
    set: echo.sonataId,
    cost: echo.cost,
    level: echo.level,
    rarity: echo.rarity,
    main: { stat: echo.mainStat.stat, value: echo.mainStat.value },
    ...(echo.secondMainStat
      ? { second: { stat: echo.secondMainStat.stat, value: echo.secondMainStat.value } }
      : {}),
    subs: echo.substats.map((s) => ({ stat: s.stat, value: s.value })),
  };
}

/**
 * The run settings a build carries into a link, each only when present.
 * `minStats` keeps positive finite entries (`effectiveMinStats`); a
 * Resonance Mode the character doesn't have counts as unset, as everywhere
 * else it is read.
 */
function runSettingsOf(build: Build): { enemy?: EnemySettings; resonanceMode?: string; minStats?: MinStats } {
  const minStats = effectiveMinStats(build.minStats);
  const modeKnown =
    build.resonanceMode !== undefined &&
    characterResonanceModes(build.characterId).some((m) => m === build.resonanceMode);
  return {
    ...(build.enemy ? { enemy: { kind: build.enemy.kind, level: build.enemy.level, baseRES: build.enemy.baseRES } } : {}),
    ...(modeKnown ? { resonanceMode: build.resonanceMode } : {}),
    ...(minStats ? { minStats } : {}),
  };
}

/**
 * Build a v2 payload (v3 when the build carries run settings) from a library build plus the sender's inventory.
 * `build.echoIds` is slot order (slot 1 first). Character/weapon context
 * comes from `build.context` (what the optimizer run used, saved with the
 * build); only older builds without it fall back to the current Roster
 * entry. A reference build re-shares its stored payload. Throws a readable
 * error when the link can't be made self-contained — never guesses a value.
 */
export function sharedBuildFromLibrary(input: {
  build: Build;
  roster: RosterEntry | undefined;
  inventory: readonly OwnedEcho[];
  includeObjective: boolean;
}): SharedBuild {
  const { build, roster, inventory, includeObjective } = input;
  const objective = includeObjective ? build.objective : undefined;
  if (build.reference) {
    const { objective: storedObjective, ...rest } = build.reference;
    return {
      ...rest,
      name: build.name.slice(0, 80),
      ...(includeObjective && storedObjective ? { objective: storedObjective } : {}),
    };
  }
  const byId = new Map(inventory.map((e) => [e.id, e]));
  const missing = build.echoIds.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new Error(`${missing.length} of this build's Echoes are no longer in your inventory`);
  }
  const context = build.context ?? rosterFallback(build, roster);
  const echoes = build.echoIds.map((id) => sharedEchoFrom(byId.get(id)!));
  const settings = runSettingsOf(build);
  const result = sharedBuildSchema.safeParse({
    v: Object.keys(settings).length === 0 ? SHARED_BUILD_VERSION : SHARED_BUILD_VERSION_SETTINGS,
    name: build.name.slice(0, 80),
    ...(build.score === undefined ? {} : { score: build.score }),
    summary: build.objectiveId.slice(0, 120),
    character: {
      id: context.characterId,
      level: context.level,
      ascension: context.ascension,
      chain: context.resonanceChain,
      forte: { ...context.forteLevels },
      ...(context.forteUnlockedIds ? { nodes: [...context.forteUnlockedIds] } : {}),
    },
    weapon: {
      id: context.weaponId,
      level: context.weaponLevel,
      ascension: context.weaponAscension ?? 0,
      rank: context.weaponRank,
    },
    echoes,
    ...(objective ? { objective } : {}),
    ...settings,
  });
  if (!result.success) throw new Error(`this build can't be shared as-is (${describeZodError(result.error)})`);
  return result.data;
}

/** Context for builds saved before `context` existed: today's Roster entry, if it still fits. */
function rosterFallback(build: Build, roster: RosterEntry | undefined): RosterEntry {
  if (!roster) {
    throw new Error('add this character to your Roster first — the link carries its level, chain and forte levels');
  }
  if (roster.weaponId !== build.weaponId) {
    throw new Error(
      `your Roster entry has a different weapon equipped (${roster.weaponId}); equip ${build.weaponId} there so the link carries its level and rank`,
    );
  }
  return roster;
}

// --- Recipient side -------------------------------------------------------------

/** A shared Echo as an in-memory `OwnedEcho` (never written to `ownedEchoes`). */
export function sharedEchoToOwned(echo: SharedEcho, slot: number): OwnedEcho {
  return {
    id: `ref:${slot}`,
    echoDefId: echo.def,
    sonataId: echo.set,
    cost: echo.cost,
    level: echo.level,
    rarity: echo.rarity,
    mainStat: { ...echo.main },
    ...(echo.second ? { secondMainStat: { ...echo.second } } : {}),
    substats: echo.subs.map((s) => ({ ...s })),
    equippedTo: null,
    origin: 'shared-link',
  };
}

/** The shared character's roster context as a `RosterEntry` (in memory only). */
export function sharedRosterEntry(shared: SharedBuild): RosterEntry {
  return {
    characterId: shared.character.id,
    level: shared.character.level,
    ascension: shared.character.ascension,
    resonanceChain: shared.character.chain,
    forteLevels: { ...shared.character.forte },
    ...(shared.character.nodes ? { forteUnlockedIds: [...shared.character.nodes] } : {}),
    weaponId: shared.weapon.id,
    weaponLevel: shared.weapon.level,
    weaponAscension: shared.weapon.ascension,
    weaponRank: shared.weapon.rank,
  };
}

export interface EchoValueFlag {
  part: 'main' | 'second' | 'sub';
  stat: StatKey;
  value: number;
  /** `out-of-range`: contradicts a reference table. `unverified`: no table covers it. */
  severity: 'out-of-range' | 'unverified';
  message: string;
}

const same = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;

/**
 * Check one shared Echo's values against the reference tables in
 * `data/echoStats.ts` (5★ basis). Flags, never fixes: values outside a
 * table are `out-of-range`; values no table covers (non-5★ Echoes,
 * untiered substats) are `unverified`. No range is invented here.
 */
export function checkSharedEchoValues(echo: SharedEcho): EchoValueFlag[] {
  const flags: EchoValueFlag[] = [];
  const fiveStar = echo.rarity === 5;
  const atMax = fiveStar && echo.level === 25;

  const range = MAIN_STAT_RANGES[echo.cost][echo.main.stat];
  if (range === undefined) {
    flags.push({ part: 'main', stat: echo.main.stat, value: echo.main.value, severity: 'out-of-range', message: `not a ${echo.cost}-cost main stat` });
  } else if (!fiveStar) {
    flags.push({ part: 'main', stat: echo.main.stat, value: echo.main.value, severity: 'unverified', message: `no reference range for ${echo.rarity}★ Echoes` });
  } else if (atMax ? !same(echo.main.value, range.max) : echo.main.value < range.min - 1e-6 || echo.main.value > range.max + 1e-6) {
    flags.push({
      part: 'main',
      stat: echo.main.stat,
      value: echo.main.value,
      severity: 'out-of-range',
      message: atMax ? `5★ +25 value is ${range.max}` : `outside the 5★ range ${range.min}–${range.max}`,
    });
  }

  const secondary = SECONDARY_MAIN_STAT_MAX[echo.cost];
  if (echo.second) {
    if (echo.second.stat !== secondary.stat) {
      flags.push({ part: 'second', stat: echo.second.stat, value: echo.second.value, severity: 'out-of-range', message: `${echo.cost}-cost secondary is ${secondary.stat}` });
    } else if (!fiveStar) {
      flags.push({ part: 'second', stat: echo.second.stat, value: echo.second.value, severity: 'unverified', message: `no reference value for ${echo.rarity}★ Echoes` });
    } else if (atMax ? !same(echo.second.value, secondary.value) : echo.second.value > secondary.value + 1e-6) {
      flags.push({
        part: 'second',
        stat: echo.second.stat,
        value: echo.second.value,
        severity: 'out-of-range',
        message: atMax ? `5★ +25 value is ${secondary.value}` : `above the 5★ maximum ${secondary.value}`,
      });
    }
  }

  for (const sub of echo.subs) {
    const tiers = SUB_STAT_TIERS[sub.stat];
    if (tiers === undefined) {
      flags.push({ part: 'sub', stat: sub.stat, value: sub.value, severity: 'unverified', message: 'no roll-tier table for this substat' });
    } else if (!fiveStar) {
      flags.push({ part: 'sub', stat: sub.stat, value: sub.value, severity: 'unverified', message: `no roll tiers for ${echo.rarity}★ Echoes` });
    } else if (!tiers.some((t) => same(t, sub.value))) {
      flags.push({ part: 'sub', stat: sub.stat, value: sub.value, severity: 'out-of-range', message: 'not a possible 5★ roll' });
    }
  }
  return flags;
}

export interface SharedBuildView {
  /** Ids the recipient's game data doesn't know — shown, never thrown. */
  issues: string[];
  character?: CharacterData;
  weapon?: WeaponData;
  /** Slot order; `echoes[0]` is slot 1. Ids are `ref:<slot>`. */
  echoes: OwnedEcho[];
  echoNames: string[];
  flags: EchoValueFlag[][];
  /** Key stats from the recipient's snapshot (absent when character/weapon is unknown). */
  stats?: {
    hp: number;
    atk: number;
    def: number;
    critRate: number;
    critDmg: number;
    energyRegen: number;
    attributeDmg: number;
  };
  warnings: string[];
  appliedAssumptions: string[];
}

/**
 * Resolve a shared build against the recipient's own snapshot and compute
 * its key stats through the domain layer (`computeStats` + totals).
 */
export function viewSharedBuild(shared: SharedBuild, snapshot: Snapshot): SharedBuildView {
  const issues: string[] = [];
  const character = snapshot.characters.find((c) => c.id === shared.character.id);
  const weapon = snapshot.weapons.find((w) => w.id === shared.weapon.id);
  if (!character) issues.push(`Unknown character "${shared.character.id}" — your game data may be older than the sender's.`);
  if (!weapon) issues.push(`Unknown weapon "${shared.weapon.id}" — your game data may be older than the sender's.`);
  if (character && weapon && weapon.weaponType !== character.weaponType) {
    issues.push(`${character.name} can't use ${weapon.name} (${weapon.weaponType}).`);
  }
  const echoes = shared.echoes.map((e, slot) => sharedEchoToOwned(e, slot));
  const unknownSets = new Set<string>();
  const echoNames = shared.echoes.map((e) => {
    if (!snapshot.sonataSets.some((s) => s.id === e.set)) unknownSets.add(e.set);
    const def = snapshot.echoDefs.find((d) => d.id === e.def);
    if (!def) issues.push(`Unknown Echo "${e.def}" — shown by id.`);
    return def?.name ?? e.def;
  });
  for (const set of unknownSets) issues.push(`Unknown Sonata set "${set}" — its bonuses aren't counted.`);
  const flags = shared.echoes.map((e) => checkSharedEchoValues(e));

  if (!character || !weapon) {
    return { issues, character, weapon, echoes, echoNames, flags, warnings: [], appliedAssumptions: [] };
  }
  const result = computeStats({
    character,
    weapon,
    roster: sharedRosterEntry(shared),
    echoes,
    sonataSets: snapshot.sonataSets,
    mainEcho: echoes[0],
  });
  const { sheet } = result;
  return {
    issues,
    character,
    weapon,
    echoes,
    echoNames,
    flags,
    stats: {
      hp: computeHp(result.baseHp.character, sheet),
      atk: computeAtk(result.baseAtk.character, result.baseAtk.weapon, sheet),
      def: computeDef(result.baseDef.character, sheet),
      critRate: sheet.critRate,
      critDmg: sheet.critDmg,
      energyRegen: sheet.energyRegen,
      attributeDmg: sheet[`dmgBonus:${character.attribute}`],
    },
    warnings: result.warnings,
    appliedAssumptions: result.appliedAssumptions,
  };
}

/** Placeholder `echoIds` of a reference build — they never resolve in the inventory. */
export const REFERENCE_ECHO_IDS = ['ref:0', 'ref:1', 'ref:2', 'ref:3', 'ref:4'] as const;

/** Is this library build a saved share link rather than the user's own Echoes? */
export function isReferenceBuild(build: Build): boolean {
  return build.reference !== undefined;
}

/**
 * A library row for "Save as reference": the payload is stored on the build
 * itself, so nothing is added to `ownedEchoes`. `id` is derived from the
 * payload (stable), so saving the same link twice is detected as a duplicate.
 */
export function referenceBuildFrom(shared: SharedBuild, now: Date = new Date()): Build {
  return buildSchema.parse({
    id: `ref-${fnv1a(JSON.stringify(shared))}`,
    name: shared.name,
    characterId: shared.character.id,
    weaponId: shared.weapon.id,
    echoIds: [...REFERENCE_ECHO_IDS],
    objectiveId: shared.summary || 'Shared build',
    ...(shared.objective ? { objective: shared.objective } : {}),
    ...(shared.score === undefined ? {} : { score: shared.score }),
    reference: shared,
    updatedAt: now.toISOString(),
  });
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export interface SharedCalculatorDraft {
  sourceName: string;
  roster: RosterEntry;
  /** Present only when the link carries a rotation objective. */
  rotation?: {
    blocks: RotationBlockSpec[];
    buffs: RotationBuff[];
    globalBuffIds: string[];
    crit: 'expected' | 'crit' | 'nonCrit';
  };
  /** Rotation blocks dropped because the recipient's kit data doesn't know them. */
  skippedBlocks: number;
  /** Run settings carried by a v3 link; absent ones leave the Calculator's current values alone. */
  enemy?: EnemySettings;
  /** Only a mode this character has (`characterResonanceModes`); anything else counts as unset. */
  resonanceMode?: ResonanceMode;
  minStats?: MinStats;
}

/**
 * Calculator inputs for "Optimize with my Echoes": the shared roster
 * context plus, when carried, the rotation and the run settings (enemy,
 * Resonance Mode, minimum stats). Stale blocks (motions the
 * recipient's snapshot doesn't have) are dropped and counted, as presets do.
 */
export function sharedCalculatorDraft(shared: SharedBuild, character: CharacterData): SharedCalculatorDraft {
  const mode = characterResonanceModes(character.id).find((m) => m === shared.resonanceMode);
  const draft: SharedCalculatorDraft = {
    sourceName: shared.name,
    roster: sharedRosterEntry(shared),
    skippedBlocks: 0,
    ...(shared.enemy ? { enemy: { ...shared.enemy } } : {}),
    ...(mode ? { resonanceMode: mode } : {}),
    ...(shared.minStats ? { minStats: { ...shared.minStats } } : {}),
  };
  const objective: ObjectiveSpec | undefined = shared.objective;
  if (objective?.kind !== 'rotation-dpr') return draft;
  const blocks = objective.blocks.filter((b) => !isBlockStale(character, { ...b, id: 'share-check' }));
  return {
    ...draft,
    rotation: { blocks, buffs: objective.buffs, globalBuffIds: objective.globalBuffIds, crit: objective.crit },
    skippedBlocks: objective.blocks.length - blocks.length,
  };
}
