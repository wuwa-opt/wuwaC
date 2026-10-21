// Must stay the first import: zod's jitless config has to run before any
// schema below is built (CSP has no 'unsafe-eval'; see zodConfig.ts).
import './zodConfig.ts';
import { z } from 'zod';

/**
 * Data layer: canonical shapes for game data and user data.
 *
 * Every schema here is the single source of truth — TypeScript types are
 * inferred via `z.infer`, never declared separately. API sync output and
 * the bundled snapshot are validated against these before anything reaches
 * the domain layer ("validate, don't trust blindly", reference doc §8.2).
 *
 * Units: ratios are decimals (0.05 = 5%), flat stats are raw numbers.
 * Realm of this file is *shape*, not math — no game logic lives here.
 */

/** Increment on any breaking change to the snapshot file layout. */
export const SNAPSHOT_VERSION = 4;

const slug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be a URL-safe slug');

export const attributeSchema = z.enum([
  'Glacio',
  'Fusion',
  'Electro',
  'Aero',
  'Spectro',
  'Havoc',
]);
export type Attribute = z.infer<typeof attributeSchema>;

export const weaponTypeSchema = z.enum([
  'Sword',
  'Broadblade',
  'Pistols',
  'Gauntlets',
  'Rectifier',
]);
export type WeaponType = z.infer<typeof weaponTypeSchema>;

/** Damage-type buckets from reference doc §1/§6 (`forte` = Forte Circuit). */
export const damageTypeSchema = z.enum([
  'basic',
  'heavy',
  'skill',
  'liberation',
  'intro',
  'outro',
  'echo',
]);
export type DamageType = z.infer<typeof damageTypeSchema>;

/**
 * Skill kinds. `tunebreak` = Tune Break skills (3.x Off-Tune mechanic):
 * no scored motions expected — they render as buff carriers. `forte` =
 * Forte Circuit fallback for unknown per-hit bonus buckets.
 */
export const skillKindSchema = z.union([damageTypeSchema, z.literal('forte'), z.literal('tunebreak')]);
export type SkillKind = z.infer<typeof skillKindSchema>;

/**
 * Every aggregatable stat. Flat record keys — aggregation is pure addition,
 * except `amplify` which the domain layer applies as a separate
 * multiplicative stage (reference doc §6).
 */
export const statKeySchema = z.enum([
  'hp',
  'hpPct',
  'atk',
  'atkPct',
  'def',
  'defPct',
  'critRate',
  'critDmg',
  'energyRegen',
  'healingBonus',
  'dmgBonus:Glacio',
  'dmgBonus:Fusion',
  'dmgBonus:Electro',
  'dmgBonus:Aero',
  'dmgBonus:Spectro',
  'dmgBonus:Havoc',
  'dmgBonus:basic',
  'dmgBonus:heavy',
  'dmgBonus:skill',
  'dmgBonus:liberation',
  'dmgBonus:intro',
  'dmgBonus:outro',
  'dmgBonus:echo',
  /**
   * Coordinated Attack DMG Bonus. Joins `AllDmgBonus` additively, but ONLY
   * for hits flagged as coordinated attacks (registry in
   * domain/characterMods.ts — Decision 3, reference doc §6 note). A
   * coordinated attack is not an Echo skill: never merge with
   * `dmgBonus:echo`.
   */
  'dmgBonus:coordinated',
  'amplify',
  /** Amplification that applies to Negative Status damage only. */
  'negativeStatusAmplify',
  /**
   * Tune Break Boost points (3.x). Raw points, not percent — Tune Strain
   * grants +0.12% total DMG per point per stack. No mapped echo/weapon
   * source in the snapshot yet; set via manual buffs.
   */
  'tuneBreakBoost',
  /** Attacker-side DEF ignore (ratio) and flat DEF reduction (pre-ratio). */
  'defIgnore',
  'defReduction',
  /**
   * Attacker-side resistance penetration, SIGNED. `computeDamage` adds
   * this to the enemy base (`resTotal = base + penetration`, reference
   * doc §6), so penetration is positive and RES shred is NEGATIVE —
   * shred lowers effective resistance by exactly its magnitude. Pinned
   * by the shred-sign test in damage.test.ts: flipping the sign inverts
   * the proven damage ratio. Element-agnostic by design — element-gated
   * kit shred (Phoebe Spectro, Woodland Aria Aero, Suisui Havoc) is
   * transcribed here with its gate disclosed in the assumption.
   */
  'resistancePenetration',
  /** Unused by every live kit today; modeled for completeness (doc §6). */
  'specialBase',
  'specialBonus',
]);
export type StatKey = z.infer<typeof statKeySchema>;

/**
 * A stat contribution. `conditional` preserves the trigger wording without
 * inventing numbers; `custom` is an honest escape hatch for effects the
 * data layer cannot structure (never fabricate structure from prose).
 */
export const statEffectSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('stat'),
    stat: statKeySchema,
    value: z.number(),
  }),
  z.object({
    kind: z.literal('conditional'),
    condition: z.string().min(1),
    stat: statKeySchema,
    value: z.number(),
  }),
  z.object({
    kind: z.literal('custom'),
    note: z.string().min(1),
  }),
]);
export type StatEffect = z.infer<typeof statEffectSchema>;

/** Provenance: every game-data record carries its source. */
export const sourceSchema = z.object({
  provider: z.literal('encore.moe'),
  fetchedAt: z.string().datetime({ offset: true }),
  /** Numeric id in the provider API (for re-sync/debugging). */
  apiId: z.number().int().nonnegative(),
});
export type Source = z.infer<typeof sourceSchema>;

const levelPointSchema = z.object({
  /** Weapon curves use x.5 for the post-ascension tier of level x. */
  level: z.number().min(1).max(90).multipleOf(0.5),
  value: z.number().nonnegative(),
});
export type LevelPoint = z.infer<typeof levelPointSchema>;

// --- Characters -------------------------------------------------------------

const scalingSchema = z.enum(['ATK', 'HP', 'DEF']);

/**
 * Which DMG-bonus bucket a single motion scores against.
 * From the provider `DamageList[].Type` per hit (Fandom wiki Damage page:
 * "On hit, the attack will use its corresponding Type Bonus"), NOT the
 * parent `SkillType` — e.g. Luuk Herssen's Liberation hits are typed
 * `Basic Attack`, Jiyan's Liberation hits are typed `Heavy Attack`.
 * `forte` is the fallback when the provider type is unknown/empty and
 * preserves the v1 attribute-only behavior for Forte Circuit.
 */
export const motionBonusKindSchema = z.union([damageTypeSchema, z.literal('forte')]);
export type MotionBonusKind = z.infer<typeof motionBonusKindSchema>;

export const characterSkillSchema = z.object({
  id: z.string().min(1),
  kind: skillKindSchema,
  /** Human-readable label, e.g. "Lone Lance (Normal Attack)". */
  label: z.string().min(1),
  /**
   * Stripped provider kit prose (SkillDescribe). Present when non-empty —
   * the ground truth for hand-modeled kit mechanics (stack/mode rules).
   * Absent means the provider shipped no prose, never "no mechanics".
   */
  description: z.string().min(1).optional(),
  attribute: attributeSchema,
  /** Which character stat the motion values scale off. */
  scaling: scalingSchema,
  /**
   * Per-skill motion values across Forte levels (index 0 = level 1).
   * Empty for buff-only skills (e.g. Outro Skills) — no motion values exist.
   */
  motionValues: z.array(
    z
      .object({
        name: z.string().min(1),
        /** Ratio-of-scaling-stat part ("11.33%" -> 0.1133). */
        values: z.array(z.number().nonnegative()).min(1),
        /**
         * Flat part for hybrid formulas ("500+11.33%" -> flat 500).
         * Present only when nonzero; same length as `values`.
         */
        flatValues: z.array(z.number().nonnegative()).optional(),
        /** Total hit count the value is spread over (default 1). */
        hits: z.number().int().positive().default(1),
        /**
         * DMG-bonus bucket for this motion, from provider DamageList.Type.
         * Healing motions still carry a bucket but always score 0 damage.
         */
        dmgType: motionBonusKindSchema,
        /**
         * Which stat this motion scales off, from provider DamageList.
         * PropertyName — usually the skill's scaling, except mixed skills
         * (Taoqi's Power Shift damage is DEF under an ATK-first entry).
         */
        scaling: scalingSchema,
        /** True for healing motions (attributeName contains "Healing") — scores 0 damage. */
        isHealing: z.boolean().default(false),
      })
      .refine((m) => m.flatValues === undefined || m.flatValues.length === m.values.length, {
        message: 'flatValues must match values in length',
      }),
  ),
});
export type CharacterSkill = z.infer<typeof characterSkillSchema>;

export const characterSchema = z.object({
  id: slug,
  name: z.string().min(1),
  /**
   * Remote portrait URL (provider CDN). Display only, never bundled —
   * the UI falls back to initials when absent or unreachable (offline).
   */
  iconUrl: z.string().url().optional(),
  rarity: z.union([z.literal(4), z.literal(5)]),
  attribute: attributeSchema,
  weaponType: weaponTypeSchema,
  /** Level curve incl. ascension steps (duplicate levels = ascension tiers). */
  baseStats: z
    .array(
      z.object({
        level: z.number().int().min(1).max(90),
        hp: z.number().nonnegative(),
        atk: z.number().nonnegative(),
        def: z.number().nonnegative(),
      }),
    )
    .min(1),
  /** Combat skills, including Tune Break skills (buff carriers, no motions). */
  skills: z.array(characterSkillSchema).min(1),
  /**
   * Inherent-skill kit prose (mode/stack rules live here). The ubiquitous
   * cooking passive is excluded by sync; an empty array means none found.
   */
  inherentSkills: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      description: z.string().min(1),
    }),
  ),
  forteNodes: z.array(
    z.object({
      id: z.string().min(1),
      title: z.string().min(1),
      stat: statKeySchema,
      value: z.number(),
    }),
  ),
  resonanceChain: z
    .array(
      z.object({
        rank: z.number().int().min(1).max(6),
        name: z.string().min(1),
        description: z.string().min(1),
        effect: statEffectSchema,
      }),
    )
    .length(6),
  source: sourceSchema,
});
export type CharacterData = z.infer<typeof characterSchema>;

// --- Weapons ----------------------------------------------------------------

export const weaponSchema = z.object({
  id: slug,
  name: z.string().min(1),
  /** Remote icon URL (provider CDN). Display only — UI falls back to initials. */
  iconUrl: z.string().url().optional(),
  weaponType: weaponTypeSchema,
  rarity: z.number().int().min(1).max(5),
  atkByLevel: z.array(levelPointSchema).min(1),
  /** Absent on weapons with no secondary stat (low rarity). */
  secondaryStat: z
    .object({
      stat: statKeySchema,
      byLevel: z.array(levelPointSchema).min(1),
    })
    .nullable(),
  passive: z.object({
    name: z.string().min(1),
    /** Provider description with markup stripped. */
    description: z.string().min(1),
    /** Raw per-rank parameter arrays (one entry per refinement rank). */
    paramsByRank: z.array(z.array(z.string())),
    effect: statEffectSchema,
  }),
  source: sourceSchema,
});
export type WeaponData = z.infer<typeof weaponSchema>;

// --- Sonata sets --------------------------------------------------------------

export const sonataSetSchema = z.object({
  id: slug,
  name: z.string().min(1),
  /** Piece thresholds are per-set data, never hardcoded (reference doc §3). */
  bonuses: z
    .array(
      z.object({
        pieceCount: z.number().int().positive(),
        effect: statEffectSchema,
      }),
    )
    .min(1),
  source: sourceSchema,
});
export type SonataSetData = z.infer<typeof sonataSetSchema>;

// --- Echo definitions (static side) -------------------------------------------
/**
 * What an Echo *can* be. Per-copy rolls live in `OwnedEcho`.
 * Sourced from encore.moe `/echo/<id>` detail records: cost from
 * `Handbook.Intensity` (detail-Rarity fallback), sonatas from
 * `FetterGroup`. Main-stat pools are cost-tier pools from
 * `placeholders.ts` (docs/echostats.md), identical for every Echo of a
 * cost — the per-Echo Handbook pool text is unreliable and is not parsed.
 * Records without Handbook data are skipped by the sync (reported, never
 * guessed).
 */
export const echoDefSchema = z.object({
  id: slug,
  name: z.string().min(1),
  /** Remote icon URL (provider CDN, small variant). Display only — UI falls back to initials. */
  iconUrl: z.string().url().optional(),
  /**
   * Echo element (display only — no logic keys off it). The six character
   * attributes; ABSENT for element-less echoes. The provider labels those
   * "Physical" (element Id 0, Zero icon), but the game has no Physical
   * element, so no element is stored.
   */
  element: attributeSchema.optional(),
  sonataIds: z.array(z.string().min(1)).min(1),
  cost: z.union([z.literal(1), z.literal(3), z.literal(4)]),
  allowedMainStats: z.array(statKeySchema).min(1),
  /** Active echo-skill text (slot-1 use). Display only in v1. */
  skillDescription: z.string().min(1).optional(),
  skillCooldown: z.number().nonnegative().optional(),
  /** Per-rank skill parameters (one array per rank), display only. */
  skillRanks: z.array(z.array(z.string())).optional(),
  source: sourceSchema,
});
export type EchoDefData = z.infer<typeof echoDefSchema>;

// --- User data (IndexedDB rows) -------------------------------------------------
/**
 * `origin` convention: `"manual"` for hand entry, `"import:<tool>"` for
 * bulk imports (e.g. `"import:wuwa-inventory-kamera"`). Free-form string so
 * future importers never require a schema change.
 */
export const ownedEchoSchema = z
  .object({
    id: z.string().min(1),
    /** Display name for manual entries (synced defs carry their own names). */
    label: z.string().min(1).optional(),
    echoDefId: z.string().min(1),
    sonataId: z.string().min(1),
    cost: z.union([z.literal(1), z.literal(3), z.literal(4)]),
    level: z.number().int().min(0).max(25),
    rarity: z.number().int().min(1).max(5),
    mainStat: z.object({ stat: statKeySchema, value: z.number() }),
    /** Fixed secondary: flat HP on 1-cost, flat ATK on 3/4-cost (reference doc §2). */
    secondMainStat: z
      .object({ stat: statKeySchema, value: z.number() })
      .optional(),
    /** Fixed once rolled — the optimizer only chooses *which* Echo (doc §2). */
    substats: z
      .array(
        z.object({
          stat: statKeySchema,
          value: z.number(),
          rolls: z.number().int().positive().optional(),
        }),
      )
      .max(5),
    equippedTo: z.string().min(1).nullable().default(null),
    origin: z.string().min(1),
    /**
     * Protection, like the in-game lock: a locked Echo is never safe fodder and
     * can't be deleted until unlocked. It does not filter the optimizer. Absent
     * = unlocked (never stored as `false`). Unindexed: no Dexie version bump.
     */
    locked: z.literal(true).optional(),
  })
  .refine((e) => new Set(e.substats.map((s) => s.stat)).size === e.substats.length, {
    message: 'duplicate substats on one Echo',
  });
export type OwnedEcho = z.infer<typeof ownedEchoSchema>;

export const rosterEntrySchema = z.object({
  characterId: z.string().min(1),
  level: z.number().int().min(1).max(90),
  /** Ascension tier: selects the post-ascension curve entry at `level`. */
  ascension: z.number().int().min(0).max(6),
  resonanceChain: z.number().int().min(0).max(6),
  /** Skill id -> Forte level. No max cap: unsourced — TODO once verified. */
  forteLevels: z.record(z.string(), z.number().int().min(1)),
  /**
   * Unlocked forte-node ids. Absent = all active (legacy default — the
   * provider ships no unlock gating, so this is user-declared).
   */
  forteUnlockedIds: z.array(z.string().min(1)).optional(),
  weaponId: z.string().min(1),
  weaponLevel: z.number().int().min(1).max(90),
  /** Weapon ascension tier: selects the post-ascension curve entry at `weaponLevel`. Absent = 0. */
  weaponAscension: z.number().int().min(0).max(6).optional(),
  weaponRank: z.number().int().min(1).max(5),
});
export type RosterEntry = z.infer<typeof rosterEntrySchema>;

/**
 * Scoring objective as data (reference doc §7). Fully serializable — safe
 * for the worker boundary, Dexie rows, and share links. Evaluated by
 * `domain/objectives.ts`; the data layer never interprets it.
 */

/** One sequenced rotation action, without the session-local block id. */
export const rotationBlockSpecSchema = z.object({
  /** Empty only for non-motion status actions. */
  skillId: z.string(),
  motionName: z.string(),
  forteLevel: z.number().int().min(1),
  activeBuffIds: z.array(z.string()),
  /** Optional non-motion damage source. Omitted means a normal kit motion. */
  damageKind: z.enum(['ability', 'negativeStatus', 'tuneRupture', 'tuneBreak', 'echoSkill']).optional(),
  // Keep in sync with NEGATIVE_STATUSES in src/domain/negativeStatus.ts
  // (duplicated here because the data layer must not import the domain).
  statusType: z
    .enum(['aeroErosion', 'spectroFrazzle', 'havocBane', 'fusionBurst', 'electroFlare', 'glacioChafe'])
    .optional(),
  /** Current status stacks used by a Negative Status detonation hit. */
  statusStacks: z.number().int().min(1).max(10).optional(),
  /** Target stacks used by Cartethyia's Wind's Indelible Imprint. */
  targetStatusStacks: z.number().int().min(0).max(9).optional(),
  /** Havoc Bane stacks on the target — percentage enemy DEF reduction. */
  targetHavocBaneStacks: z.number().int().min(0).max(9).optional(),
  /** Fleurdelys Conviction used by S1's Crit DMG thresholds. */
  conviction: z.number().int().min(0).max(120).optional(),
  /** Cumulative Blazes consumed — Zani S3 scales The Last Stand off it. */
  blazesConsumed: z.number().int().min(0).max(150).optional(),
  /** Blazes consumed by this Nightfall hit — Zani base kit and S6 scale off it. */
  nightfallBlazes: z.number().int().min(0).max(40).optional(),
  /** Rings of Chainsaw consumed for this Eradication hit (Chisa, kit counts up to 100). */
  ringsConsumed: z.number().int().min(0).max(100).optional(),
  /** Voice Flux active — Xuanling S6 Heavy bonus. */
  voiceFlux: z.boolean().optional(),
  /** Woven Myriad - Convergence active — Chisa liberation state. */
  wovenMyriad: z.boolean().optional(),
  /** Seal Master active — Suoming Unfurled Canopy MVs doubled (12s). */
  sealMaster: z.boolean().optional(),
  /** Tune Strain - Interfered stacks on the target (total-DMG amp). */
  tuneStrainStacks: z.number().int().min(0).max(10).optional(),
  /** Trail (or equivalent) stacks consumed by a Tune Rupture response. */
  tuneResponseStacks: z.number().int().min(0).max(99).optional(),
  /**
   * Tune Break coefficient for a tuneBreak block. No verified default
   * exists (G3) — the user supplies it from their own research.
   */
  tuneBreakMultiplier: z.number().min(0).max(99).optional(),
  /**
   * Echo-skill block inputs (damageKind 'echoSkill'). The block carries
   * the slot-1 Echo's parsed skill values as data so rotation objectives
   * cross the worker boundary self-contained (see data/echoSkills.ts for
   * the parser and its documented shapes). Motion value and attribute are
   * required by the scorer; scaling defaults to ATK, flat to 0.
   * Cooldown is display-only (shown, not simulated — no cooldown-clock model).
   */
  echoName: z.string().min(1).optional(),
  echoMotionValue: z.number().min(0).max(99).optional(),
  echoFlatDamage: z.number().min(0).optional(),
  echoAttribute: attributeSchema.optional(),
  echoScaling: z.enum(['ATK', 'HP', 'DEF']).optional(),
  echoCooldown: z.number().min(0).optional(),
  /**
   * Per-block duration in seconds. Block i's start is the cumulative sum of
   * durations before it (missing = 0 contribution); windowed buffs apply by
   * block start. Optional — untimed blocks score exactly as before.
   */
  durationSeconds: z.number().min(0).optional(),
});
export type RotationBlockSpec = z.infer<typeof rotationBlockSpecSchema>;

/** Calculator-local buff, as data (ids are stable once saved in a spec). */
export const rotationBuffSpecSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  source: z.string().min(1),
  mods: z.array(
    z.object({
      stat: statKeySchema,
      value: z.number(),
    }),
  ),
  /**
   * Optional time window `[start, start + duration)` in seconds. A buff
   * carrying a duration auto-applies to blocks whose derived start falls
   * inside (start defaults to 0); zero-duration windows never apply.
   * Optional — untimed buffs keep today's global/toggle meaning.
   */
  windowStartSeconds: z.number().min(0).optional(),
  windowDurationSeconds: z.number().min(0).optional(),
});
export type RotationBuffSpec = z.infer<typeof rotationBuffSpecSchema>;

export const objectiveSpecSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('expected-damage'),
    skillId: z.string().min(1),
    motionName: z.string().min(1),
    forteLevel: z.number().int().min(1),
    crit: z.enum(['expected', 'crit', 'nonCrit']),
  }),
  z.object({
    kind: z.literal('max-stat'),
    stat: statKeySchema,
  }),
  z.object({
    kind: z.literal('rotation-dpr'),
    blocks: z.array(rotationBlockSpecSchema).min(1),
    buffs: z.array(rotationBuffSpecSchema),
    globalBuffIds: z.array(z.string()),
    crit: z.enum(['expected', 'crit', 'nonCrit']),
  }),
]);
export type ObjectiveSpec = z.infer<typeof objectiveSpecSchema>;

// --- Share links (v2) -------------------------------------------------------------
/**
 * Self-contained build link payload (`#b=2.<deflate-raw, base64url>`), decoded
 * from UNTRUSTED input: every object is strict (unknown keys reject), strings
 * and arrays are bounded, numbers are finite (zod 4 rejects NaN/Infinity).
 * Carries game ids and stat values only — never the sender's Echo ids,
 * `equippedTo`, `origin`, notes, or labels. `echoes[0]` is slot 1.
 */
export const SHARED_BUILD_VERSION = 2;

const shareId = z.string().min(1).max(64);
const shareStatSchema = z.strictObject({ stat: statKeySchema, value: z.number().min(0).max(100_000) });

export const sharedEchoSchema = z
  .strictObject({
    def: shareId,
    set: shareId,
    cost: z.union([z.literal(1), z.literal(3), z.literal(4)]),
    level: z.number().int().min(0).max(25),
    rarity: z.number().int().min(1).max(5),
    main: shareStatSchema,
    second: shareStatSchema.optional(),
    subs: z.array(shareStatSchema).max(5),
  })
  .refine((e) => new Set(e.subs.map((s) => s.stat)).size === e.subs.length, {
    message: 'duplicate substats on one Echo',
  });
export type SharedEcho = z.infer<typeof sharedEchoSchema>;

const sharedBlockSchema = rotationBlockSpecSchema
  .extend({
    skillId: z.string().max(64),
    motionName: z.string().max(120),
    activeBuffIds: z.array(shareId).max(64),
    echoName: z.string().min(1).max(120).optional(),
  })
  .strict();

const sharedBuffSchema = rotationBuffSpecSchema
  .extend({
    id: shareId,
    label: z.string().min(1).max(120),
    source: z.string().min(1).max(120),
    mods: z.array(z.strictObject({ stat: statKeySchema, value: z.number() })).max(32),
  })
  .strict();

/** `objectiveSpecSchema`, strict and bounded. Opt-in on the sender side (it can be large). */
export const sharedObjectiveSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('expected-damage'),
    skillId: shareId,
    motionName: z.string().min(1).max(120),
    forteLevel: z.number().int().min(1).max(10),
    crit: z.enum(['expected', 'crit', 'nonCrit']),
  }),
  z.strictObject({
    kind: z.literal('max-stat'),
    stat: statKeySchema,
  }),
  z.strictObject({
    kind: z.literal('rotation-dpr'),
    blocks: z.array(sharedBlockSchema).min(1).max(200),
    buffs: z.array(sharedBuffSchema).max(64),
    globalBuffIds: z.array(shareId).max(64),
    crit: z.enum(['expected', 'crit', 'nonCrit']),
  }),
]);

export const sharedBuildSchema = z.strictObject({
  v: z.literal(SHARED_BUILD_VERSION),
  name: z.string().min(1).max(80),
  score: z.number().optional(),
  /** Short human summary of the objective (the build's `objectiveId` label). */
  summary: z.string().max(120),
  character: z.strictObject({
    id: shareId,
    level: z.number().int().min(1).max(90),
    ascension: z.number().int().min(0).max(6),
    chain: z.number().int().min(0).max(6),
    forte: z
      .record(shareId, z.number().int().min(1).max(10))
      .refine((r) => Object.keys(r).length <= 16, { message: 'too many forte entries' }),
    /** Unlocked forte-node ids; absent = all unlocked (roster default). */
    nodes: z.array(shareId).max(32).optional(),
  }),
  weapon: z.strictObject({
    id: shareId,
    level: z.number().int().min(1).max(90),
    ascension: z.number().int().min(0).max(6),
    rank: z.number().int().min(1).max(5),
  }),
  echoes: z.tuple([sharedEchoSchema, sharedEchoSchema, sharedEchoSchema, sharedEchoSchema, sharedEchoSchema]),
  objective: sharedObjectiveSchema.optional(),
});
export type SharedBuild = z.infer<typeof sharedBuildSchema>;

export const buildSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    characterId: z.string().min(1),
    weaponId: z.string().min(1),
    echoIds: z.tuple([
      z.string().min(1),
      z.string().min(1),
      z.string().min(1),
      z.string().min(1),
      z.string().min(1),
    ]),
    objectiveId: z.string().min(1),
    /** Full spec when saved from the optimizer — makes builds re-runnable. */
    objective: objectiveSpecSchema.optional(),
    score: z.number().optional(),
    notes: z.string().optional(),
    /**
     * Present on a build saved from someone else's share link ("Save as
     * reference"). Its Echoes live here, NOT in `ownedEchoes`; `echoIds`
     * are then placeholders (`ref:0`..`ref:4`) that resolve to nothing in
     * the inventory. Optional and unindexed, so no Dexie version bump.
     */
    reference: sharedBuildSchema.optional(),
    /**
     * Character/weapon context the build was optimized with (levels, chain,
     * forte, nodes, weapon level/rank), captured at save time — it may be a
     * calculator draft, not the Roster. Share links prefer it over the
     * current Roster. Optional and unindexed: no Dexie version bump; builds
     * saved before it existed simply lack it.
     */
    context: rosterEntrySchema.optional(),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .refine((b) => new Set(b.echoIds).size === b.echoIds.length, {
    message: 'the same Echo cannot be equipped twice',
  })
  .refine((b) => !b.context || (b.context.characterId === b.characterId && b.context.weaponId === b.weaponId), {
    message: "the saved context doesn't match the build's character and weapon",
    path: ['context'],
  });
export type Build = z.infer<typeof buildSchema>;

export const teamSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    characterIds: z.tuple([
      z.string().min(1),
      z.string().min(1),
      z.string().min(1),
    ]),
    /** Display-only in v1; drives rotation modeling in v2 (reference §5). */
    outroBuffs: z
      .array(
        z.object({
          fromCharacterId: z.string().min(1),
          effect: statEffectSchema,
          windowSeconds: z.number().positive().optional(),
        }),
      )
      .optional(),
  })
  .refine((t) => new Set(t.characterIds).size === t.characterIds.length, {
    message: 'a team cannot contain the same character twice',
  });
export type Team = z.infer<typeof teamSchema>;

/**
 * Row for the `gamedataCache` Dexie table (reference doc §8.2). Single row
 * (`id: 'active'`) holding the last validated provider snapshot. The payload
 * is re-validated against `snapshotSchema` on every read — a row that fails
 * validation (or its checksum) is treated as missing, never served.
 */
export const gameDataCacheRowSchema = z.object({
  id: z.string().min(1),
  fetchedAt: z.string().datetime({ offset: true }),
  provider: z.literal('encore.moe'),
  snapshotVersion: z.number().int().positive(),
  /** FNV-1a checksum over the canonical payload JSON (corruption guard). */
  checksum: z.string().min(1),
  /** Raw snapshot payload — validated on read, never trusted blindly. */
  payload: z.unknown(),
});
export type GameDataCacheRow = z.infer<typeof gameDataCacheRowSchema>;

// --- Snapshot file --------------------------------------------------------------

export const snapshotSchema = z.object({
  snapshotVersion: z.literal(SNAPSHOT_VERSION),
  fetchedAt: z.string().datetime({ offset: true }),
  provider: z.literal('encore.moe'),
  characters: z.array(characterSchema).min(1),
  weapons: z.array(weaponSchema).min(1),
  sonataSets: z.array(sonataSetSchema).min(1),
  echoDefs: z.array(echoDefSchema).default([]),
});
export type Snapshot = z.infer<typeof snapshotSchema>;
