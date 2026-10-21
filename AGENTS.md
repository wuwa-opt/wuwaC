# Agents.md — WuWa Optimizer

This file is project memory. Read it at the start of every
session. Full game-mechanics detail lives in
`docs/WUWA_GAME_REFERENCE.md` — read that too before touching anything in
the domain/calculation layer. Where this file and your own background
knowledge about Wuthering Waves disagree, this file (and the reference
doc) win — the game patches often and your training data may predate the
current patch.

## What this project is

A local-first, client-only web app for Wuthering Waves that mirrors what
frzyc's Genshin Optimizer does for Genshin: a personal Echo/character
database plus a solver that searches the user's own Echo inventory for the
best gear combination for a given character and objective. No backend, no
account system — everything lives in the browser (IndexedDB).

## Tech stack & commands

- React + TypeScript (Vite), strict mode.
- Zustand for state, Dexie.js over IndexedDB for persistence.
- Tailwind for styling.
- Vitest for tests.
- Optimizer search runs inside a Web Worker.

```
npm run dev       # local dev server
npm run test       # vitest
npm run build       # production build (+ service worker, manifest)
npm run preview    # serve dist/ at http://localhost:4173/wuwaC/
npm run lint       # eslint
npm run sync       # encore.moe -> src/data/generated/ (CLI; CI runs it weekly via sync-gamedata.yml — avoid ad-hoc full syncs, ~370 requests)
npm run bench      # optimizer benchmark vs the brute-force oracle (manual; synthetic + realistic inventories, n = 12..300; WORKERS=k, INVENTORY=, REFERENCE_MAX=)
npx tsx scripts/gamedata-summary.ts <before.json> <after.json>   # Markdown change summary used in sync PRs
```

## Hosting (GitHub Pages)

Canonical deploy: https://wuwa-opt.github.io/wuwaC/ (repo `wuwa-opt/wuwaC`),
by `.github/workflows/deploy.yml` on push to `main`; `ci.yml` runs
lint/test/build on other branches and PRs. Still client-only: the app must
work offline and from any static host.

Two deploy modes from one codebase, picked at build time (`src/site.ts`,
`siteMode()` in `vite.config.ts`):

- **Live** (default, `wuwa-opt/wuwaC`): the app, plus a dismissible
  first-run hint ("Coming from carmukyo.github.io/wuwaC? Import your
  backup") when the DB is empty (`ImportHint`, key
  `wuwa-import-hint-dismissed`).
- **Moved** (`VITE_MOVED_TO=<https URL ending in />`, set from the repo
  variable `MOVED_TO`): the original `carmukyo/wuwaC`, kept up as a
  migration page. It works normally but shows a persistent banner with an
  Export backup button and a link to the new site (`MovedBanner`). A pending
  `#b=` share link gets an "Open this shared build on the new site" link
  with the same fragment. The value is validated at build time
  (`parseMovedTo`) and is never derived from the page.

The canonical URL lives in one constant, `CANONICAL_URL` in `src/site.ts`.
`index.html` uses a `%SITE_URL%` placeholder that `vite.config.ts` fills.
Never hand-copy the host into HTML or components.

- `base: '/wuwaC/'` (`vite.config.ts`) must match the repo name. Reference
  `public/` files via `import.meta.env.BASE_URL`, never a leading `/`.
  Routing is hash-based (`#section`, `#b=`), so no 404.html fallback exists.
- Service worker via vite-plugin-pwa (`registerType: 'prompt'`, build-only).
  `UpdatePrompt.tsx` (mounted in `main.tsx`, outside `App`) shows the
  reload banner. Never let the SW cache encore.moe or `gamedata/**`;
  `activeSnapshot.ts` owns game data via IndexedDB.
- **Build chunks.** `snapshot` (game data), `vendor`, and app code are split
  (`codeSplitting.groups`) so a code-only deploy doesn't re-download the
  data. Pages are lazy-loaded per section (`App.tsx` `PAGE_IMPORTS`, with
  idle prefetch), so the shell entry chunk carries no page or snapshot code.
  `build.rolldownOptions.plugins` ships the snapshot as a minified JSON
  string.
- **Game data publication.** `vite.config.ts` `gamedataPublication()` emits
  `gamedata/manifest.json` and the content-addressed
  `gamedata/snapshot-<checksum>.json` from the committed snapshot on every
  build (also served by `npm run dev`). New data reaches users only by
  merging a reviewed PR:
  - `.github/workflows/sync-gamedata.yml` (weekly + manual, guarded to
    `wuwa-opt/wuwaC`) runs `npm run sync` and every gate in a read-only job.
  - A write job that runs no npm then commits the artifact to
    `data/gamedata-sync` and opens or updates a PR with a
    `scripts/gamedata-summary.ts` change summary.
  - A timestamp-only sync opens no PR. Nothing auto-merges.
  - It needs the repo setting "Allow GitHub Actions to create and approve
    pull requests".
- **Security headers.** A build-only `<meta>` CSP (`contentSecurityPolicy()`
  in `vite.config.ts`):
  - `connect-src 'self'` (browsers never call the provider API);
  - `img-src` adds `https://api.encore.moe` for game art;
  - the inline theme script is allowed by an auto-computed sha256, never
    `'unsafe-inline'`/`'unsafe-eval'`.

  Any new origin the app talks to needs a matching directive there. Meta CSP
  can't set `frame-ancestors`. zod runs jitless (`data/zodConfig.ts`, the
  first import of `data/schema.ts`), so it needs no `eval`. The referrer
  policy is `no-referrer`. Fonts are self-hosted (`@fontsource` woff2 via
  `@font-face` in `index.css`, latin subset, precached); never load Google
  Fonts or another font CDN.
- **CI.** Every action is pinned to a full commit SHA (Dependabot updates
  them). `pages: write`/`id-token: write` live on the deploy job only, never
  on a job that runs `npm ci`. CI also runs
  `npm audit --omit=dev --audit-level=high`.
- **Dependabot and `main`.** One PR per major version. Gate and merge them
  one at a time, and watch the next deploy after an Actions major (CI
  doesn't run `deploy.yml` or `sync-gamedata.yml`). Never add a
  `version-update:semver-major` ignore to `.github/dependabot.yml`: an
  `ignore` rule also suppresses security updates. The ruleset
  `protect-main` blocks force-push and deletion on `main`. Don't make a
  check required: sync PRs opened with `GITHUB_TOKEN` never run `ci.yml`.
- User data lives only in visitors' browsers. `state/backup.ts` is the
  whole-DB export/restore (versioned `wuwa-optimizer-backup` JSON, zod-validated);
  `state/persistence.ts` requests non-evictable storage. A new user table
  must be added to the backup format (bump `BACKUP_VERSION`, keep reading v1).
- **Storage is per origin.** The app lives on its own origin
  (`wuwa-opt.github.io`), so other Pages repos can't read or poison its
  IndexedDB / Cache Storage. Keep IndexedDB/localStorage names prefixed
  (`wuwa-optimizer`, `wuwa-*`) and never rename existing ones: users'
  backups and the first-run hint rely on them. Never transfer or delete
  `carmukyo/wuwaC`; it is the only place existing users' data can still be
  exported from. Keep third-party JS out of the `wuwa-opt` org's Pages sites
  for the same reason.

(Update this block as the real scripts are set up — keep it accurate.)

## Architecture — one-way dependency, do not violate

```
UI (React components)
   -> Optimizer layer (worker-hosted search)
      -> Domain/calculation layer (pure TS functions, no React)
         -> Data layer (static character/weapon/echo/sonata data)
```

- **Data layer**: character/weapon/echo/Sonata data is sourced from the
  encore.moe API (`https://api-v2.encore.moe/api/en`) via an offline sync
  step, not hand-typed — see `docs/WUWA_GAME_REFERENCE.md` section 8 for
  the full fetch-validate-cache-fallback pipeline. What the rest of the
  app actually reads at runtime is a bundled/cached snapshot, never a
  direct blocking fetch on page load.

  Runtime contract (`data/activeSnapshot.ts`, React bridge
  `state/snapshotStore.ts`). The fallback order is:
  1. **Validated IndexedDB cache** (`gamedataCache`/`active` row: payload +
     FNV checksum). The checksum is recomputed on every read; zod validation
     is memoised once per (production build, checksum).
  2. **Bundled `snapshot.json`**, imported as a string and `JSON.parse`d. It
     is trusted at runtime, gated by `src/data/index.test.ts`.
  3. **Background revalidation** against the reviewed same-origin
     publication, which never blocks load: one
     `<base>gamedata/manifest.json` check per session
     (`cache: 'no-store'`), plus manual "Check for updates" on the Database
     page. The payload `<base>gamedata/snapshot-<checksum>.json` is
     downloaded only when the manifest is strictly newer. It must match the
     manifest's checksum, version and `fetchedAt` and pass zod before
     `writeCachedSnapshot` adopts it.

  Version decides who serves (matching-or-newer cache wins), adoption needs
  a strictly newer candidate, and newer-than-app publications are held out.
  Anything else keeps serving current data silently.

  Browsers never call the provider API (CSP `connect-src 'self'`).
  `data/providerSync.ts` is the single provider pipeline. It runs only in
  `npm run sync` (CLI) and the scheduled CI sync; never fork a second one.
  `data/gamedataPublication.ts` (pure) builds the manifest and payload for
  the build plugin and holds the client's manifest schema. Beyond that
  sync step, this layer is plain data; no game-math functions live here.
- **Domain layer**: pure functions, e.g. `computeStats(character, weapon,
  echoes, sonataBonuses) -> StatSheet` and `computeDamage(statSheet,
  skill, enemy) -> number`. Fully unit-testable without rendering
  anything. This is where the formulas from
  `docs/WUWA_GAME_REFERENCE.md` live.
- **Optimizer layer**: takes the domain layer's pure functions and
  searches combinations of Echoes, off the main thread. The search is
  exact:
  - **Search:** `searchExhaustive` uses cost-pattern enumeration plus
    branch-and-bound over an additive decomposition derived from
    `computeStats` and verified at runtime. It must return exactly what
    `searchReference` (brute force) returns. `search.test.ts` holds a
    seeded equivalence suite; keep it green for any search change.
  - **Workers:** it runs in `defaultConcurrency` Web Workers as
    deterministic shards (`SearchShard`), merged by `mergeShardResults`.
    Domain math stays in `src/domain`; the optimizer only adds and compares
    vectors `computeStats` produced.
  - **Pruning:** dominance pruning (`optimizer/prune.ts`) must never change
    the top-N result.
    - An Echo is dropped only with ≥ k + topN − 1 counted same-cost,
      same-set dominators, where k = `maxSameCostInCombo` (the most Echoes
      of that cost in one legal combo under the budget).
    - Def rules are in the `pruneDominated` comment; main-slot carriers
      need same-def dominators.
    - `prune.soundness.test.ts` (a seeded pruned-vs-unpruned property test)
      is the regression gate.
    - Relevant stats and main-slot carriers come only from `pruneInputs`
      (`optimizer/prune.ts`), shared by `prepare()` and the unused-Echo
      finder. Never re-derive them elsewhere.
  - **Cost budget:** the app always searches with 12 (Calculator, team
    allocation, unused-Echo finder) and never offers 10. 12 is a cap that
    covers every layout (4-4-1-1-1, 4-3-3-1-1, …), so a lower cap never
    scores higher. The engine still accepts `OptimizeRequest.costBudget:
    10 | 12` (the game caps at 10 before Data Bank upgrades, reference doc
    §2), and its tests cover both.

    One dominator is unsound: several same-cost Echoes share a combo, and
    duplicate defs don't add Sonata pieces.
  - **minStats** are checked per slot-1 choice.
  - **Bounds and pruning both assume monotonicity:** the score never
    decreases when a sheet stat rises. A new objective that breaks this must
    disable both.
- **UI layer**: rendering and user input only. If you find yourself
  writing a stat formula inside a `.tsx` file, stop — it belongs in the
  domain layer.

## Core data model (adjust field names as the schema firms up, but keep this shape)

```ts
type Attribute = "Glacio" | "Fusion" | "Electro" | "Aero" | "Spectro" | "Havoc";

interface StatSheet {
  hp: number; atk: number; def: number;
  critRate: number; critDmg: number; energyRegen: number;
  healingBonus: number;
  attributeDmgBonus: Record<Attribute, number>;
  // basic/heavy/skill/liberation DMG bonus buckets, def ignore/shred,
  // resistance shred, etc. — see reference doc's stat list.
}

interface Character {
  id: string; name: string; attribute: Attribute; weaponType: string;
  baseStatsByLevel: /* curve or formula */ unknown;
  forteTree: unknown;         // skill tree, levels, passive unlocks
  resonanceChain: unknown[];  // S1..S6 effects
  skills: { id: string; motionValue: number; damageType: string }[];
  // TODO per character: verify against a live source before shipping,
  // see docs/WUWA_GAME_REFERENCE.md "Data sources"
}

interface Echo {
  id: string; setId: string; cost: 1 | 3 | 4;
  level: number; rarity: number;
  mainStat: { stat: keyof StatSheet | string; value: number };
  substats: { stat: string; value: number }[]; // up to 5
}

interface EchoSet {
  id: string; name: string;
  bonuses: { pieceCount: 2 | 3 | 5; effect: string /* structured later */ }[];
}

interface Build {
  id: string; characterId: string; weaponId: string;
  echoIds: string[]; // exactly 5, respecting cost budget
  notes?: string;
  context?: RosterEntry;  // the context the optimizer run used (see below)
  reference?: SharedBuild; // a saved share-link payload ("reference build")
}

// Build.context: the RosterEntry the optimizer run actually used, saved with
//   the build. It may be a calculator draft, not the Roster, and it must match
//   the build's character and weapon. Share links prefer it; builds without it
//   (saved before 2026-10-21) fall back to the current Roster entry.
// Build.reference: a saved v2 share-link payload. Its Echoes live only there,
//   never in ownedEchoes, and its echoIds are the placeholders ref:0..ref:4.
//   Code that resolves library echoIds against the inventory must skip
//   reference builds (isReferenceBuild).
// Build.enemy / Build.resonanceMode: the Calculator enemy settings
//   ({kind, level, baseRES}) and Resonance Mode the run used. Every
//   save-from-a-run path writes them (RotationOptimizer saveBuild,
//   allocation saveBuilds). resonanceMode is a plain string that consumers
//   check against characterResonanceModes(id); an unknown one counts as
//   unset. Neither ever appears in share links.
// Build.minStats: the sheet minimums the run used (OptimizeRequest.minStats,
//   as sheet fractions: 0.7 = 70% Crit Rate). Energy Regen is the sheet's
//   bonus, since no base is seeded. RotationOptimizer saveBuild writes it,
//   allocation drafts copy it, and allocation and the unused-Echo finder
//   read it, only via optimizer/minStats.ts (effectiveMinStats: positive
//   finite entries, else absent). Never in share links.
// All five fields are optional and unindexed: no Dexie version bump, and
// backup format v1 is unchanged (new backups are a superset).

interface Team {
  id: string; name: string; characterIds: [string, string, string];
  priority?: [string, string, string]; // team-allocation order (below)
}

// Team.priority: a permutation of characterIds, read only via teamPriority
//   (anything else means team order; a malformed value parses as absent).
//   setPriority writes it once per reorder; setMembers drops it when it no
//   longer matches.
```

## Game-mechanics cheat sheet (see reference doc for full detail)

- **Stats**: HP, ATK, DEF, Crit Rate (base 5%), Crit DMG (base 150%),
  Energy Regen, Healing Bonus, and per-attribute DMG bonus (one of the 6
  elements), plus Basic/Heavy/Skill/Liberation DMG bonus buckets.
- **Echoes**: 5 slots, each Cost 1/3/4; a full loadout is normally capped
  at 12 total cost (commonly 1×4 + 2×3 + 2×1). Only slot 1's Echo skill is
  usable in combat; the rest are pure stat sticks. Main stat pool depends
  on cost (1-cost primary is HP%/ATK%/DEF%-only with a fixed flat-HP
  secondary; 4-cost has the widest pool including Crit Rate/Crit
  DMG/Healing Bonus). Up to 5 substats, unlocked
  by "Tuning," fixed once rolled.
- **Sonata sets**: equipping same-Sonata Echoes grants bonuses at 2 and 5
  pieces (a few sets instead use 1/3). You can run one 5-piece set, or mix
  two different 2-piece sets, across the 5 slots.
- **Forte tree**: per-character skill-upgrade tree (passive stat/damage
  nodes + active skill leveling).
- **Resonance Chain**: character's duplicate-copy upgrade track, S0–S6,
  each rank changing the kit (Genshin's Constellation equivalent).
- **Concerto Energy / Intro & Outro Skills**: each character has a
  Concerto gauge filled by basic attacks/dodges/skills; swapping
  characters at full gauge fires the outgoing character's Outro Skill and
  the incoming character's Intro Skill simultaneously — this is where
  cross-character buffs and off-field damage come from, and it's the
  mechanic the v2 team/rotation layer needs to model.
- **Damage formula** (source: the Wuthering Waves Fandom wiki's Damage
  page — see `docs/WUWA_GAME_REFERENCE.md` section 6 for the full,
  authoritative derivation; don't approximate from memory):
  `Damage = BaseDamage × Resistances × Bonuses`, where `Resistances =
  ResMultiplier × DefMultiplier × DmgReductionTotal × ElemReductionTotal`
  and `Bonuses = DmgBonusPercent × DmgAmplifyTotal × SpecialDmgPercent ×
  CritMultiplier` — these are each independent multiplicative terms, not
  one summed bucket. Implement one small pure function per term.

## Coding conventions

- TypeScript strict mode; no `any` in the domain/optimizer layers.
- Every function in the domain layer gets a unit test with a
  hand-computed expected value — not just a snapshot test.
- File layout mirrors the architecture: `src/data/`, `src/domain/`,
  `src/optimizer/`, `src/ui/` (or `src/components/` + `src/pages/`).
- Prefer small, pure, composable functions in the domain layer over one
  large `calculateEverything()` function — it needs to be testable piece
  by piece.

## Guardrails

- Real users hold Dexie v1 data in the wild. Never edit an existing
  `this.version(n).stores(...)`; schema changes add `version(n+1)` with an
  `.upgrade()` and a test that migrates a v-n row.
- Never fabricate a specific character's exact multipliers/stats and
  present them as fact. If a real source isn't available, use a
  clearly-labeled placeholder and leave a TODO citing what needs
  verification.
- Don't add a backend, analytics, or account system without asking first
  — this is meant to stay a local-first, offline-capable app.
- Don't bundle copyrighted character art in the repo; reference official
  image URLs at runtime or use placeholders.
- When in doubt about a mechanic, check `docs/WUWA_GAME_REFERENCE.md`
  before guessing.

## Code Map

- `src` — application source
- `docs` — project documentation
- UI styling ("Pixel Arcade", spec in `docs/design/PIXEL_ARCADE_HANDOFF.md`):
  `src/index.css` `@theme static` tokens (light default + `[data-theme="ink"]`
  dark overrides) consumed via `src/ui/components/classes.ts` (class strings)
  and `src/ui/components/ui.tsx` (`Window`, `SegmentMeter`, `CostPips`,
  `PageHeader`, `Alert`). Never raw hex in components — add a token instead.
  The accent fill is `seal`; the accent as *text* / focus ring is
  `accent-text` (never `text-seal`). `text-dim` is decorative only — use
  `text-fog` for readable secondary text. Pixel frames/buttons are the
  `px-frame` / `px-card` / `px-button(-primary|-cyan|-danger)` / `px-tag`
  utilities in `src/index.css` (stepped corners via offset box-shadows, no
  border-radius — don't put a `shadow-*` utility on them). Pixel icons:
  bitmaps in `src/ui/components/pixelIcons.ts`, rendered by `PixelIcon.tsx`
  (colours from `--color-icon-*`). Mascot: `Mascot.tsx` renders `public/aemeath-ames.gif` (own
  animation; nothing bounces it) with `public/aemeath-ames-still.png` for
  prefers-reduced-motion, falling back to a pixel placeholder if the art is
  absent; hover (mouse) or tap (touch) freezes her on the current frame via
  canvas. Phones (<md) get a fixed bottom tab bar instead of the top nav. The art is user-supplied — don't add more character art. Theme
  state lives in `src/state/theme.ts`.
- Echo scanner (screenshots of the in-game Echo Management panel -> OCR ->
  review -> import; plan + Phase 0 results in
  `.agents/plans/2026-10-16-echo-scanner.md`) is the `src/scanner/` layer,
  beside the optimizer (UI -> scanner -> domain -> data). Pure:
  `parse.ts` (content-located fields, closed-vocab matching, nothing
  silently corrected — every non-exact read is flagged), `values.ts`
  (tier/range validation), `layout.ts` + `pipeline.ts` (the 4-pass OCR
  plan), `draft.ts`, `review.ts`. Browser-only: `engine.ts` (tesseract.js
  pool, lazily imported by `state/scanStore.ts`). Sonata and rarity are
  NOT read from pixels — the user mirrors the in-game filter per batch.
  OCR runtime is self-hosted under `ocr/<tesseract version>/` by the
  `ocrAssets` plugin in `vite.config.ts` (never precached, never a CDN;
  tesseract's own IndexedDB cache stays off — unprefixed store name).
  Screenshots are checked by `scanner/imageLimits.ts` before any decode:
  20 MiB, 16 MP (4K = 8.3 MP, 5K = 14.7 MP), PNG/JPEG/WebP only, with the
  size read from the header. A refused file fails its own row with a
  message, and the rest of the batch is read.
  Regression gate: `src/scanner/fixtures/panels.json` (real OCR words +
  hand-read truth) must keep ZERO silent errors. Real screenshots live
  only in gitignored `scan-fixtures/`; re-measure engine changes with
  `npx tsx scripts/scan-spike.ts` then `npx tsx scripts/scan-eval.ts
  scan-fixtures/ocr js4pass`.
- Roll quality (Echo substat tiers, 10-block roll value) is the pure module
  `src/domain/rollValue.ts` over `SUB_STAT_TIERS`; UI only renders it.
- Unused-Echo finder: the pure optimizer module `src/optimizer/unused.ts`
  (`findUnusedEchoes`), memoised by the Inventory page and filtered with
  `filterByUsage` (`src/ui/filter.ts`). It is derived, never stored.
  Under the Safe fodder filter the Inventory page offers a bulk delete of
  the visible fodder behind a confirm step. It re-runs the finder at click
  time and deletes nothing if any confirmed Echo is no longer fodder.
  - **Unused**: `equippedTo === null` and in no saved non-reference build.
  - **Safe fodder**: unused, at least one saved build has an `objective`,
    and `pruneDominated` drops it for every such build (`topN: 1`,
    `costBudget: 12`) in both the whole inventory and the
    equipped-elsewhere-excluded pool (`selectCandidates`).
  - **Locked**: `OwnedEcho.locked?: true` protects an Echo, like the
    in-game lock. It is unindexed: no Dexie bump, backup v1 unchanged.
    - A locked Echo is never fodder (verdict `unused`, reason `locked`).
      It stays in the pruning pool, so it never changes another Echo's
      verdict.
    - `removeEcho` refuses it, `removeEchoes` skips it, and the UI disables
      Delete until it's unlocked.
    - Lock doesn't filter the optimizer and never appears in share links.
  - Each build's saved `minStats` keys count as relevant stats in
    `pruneInputs`, so an Echo a build needs to meet its minimum is never
    fodder.
  - That covers the top-1 result at minimum level 0, for the saved
    objectives and minimums only. A build that can't be checked against the current
    snapshot blocks all fodder.
- **Echo edits.** The Echo form submits an `EchoFormDraft` (no
  `equippedTo`, `locked`, `origin` or `id`). `replaceEcho` replaces every
  form-owned field, so an absent optional one is cleared, and keeps those
  four from the stored row. A new Echo starts unequipped.
  - A substat's `rolls` (the form never shows it) is kept when the edit
    submits the same stat with the same value (within 1e-9: the form
    round-trips values through display text). A changed value or a new
    stat has none. Nothing in the app writes `rolls`; it only arrives
    through a backup or pasted JSON.
- **Def checks use the active snapshot.** `state/inventory.ts` and
  `EchoForm` read `useSnapshotStore`, never `loadBundledSnapshot()`. Only
  `data/`, `snapshotStore`, the dev seed and the Database page's bundled
  date use the bundle directly.
- **Delete undo.** Every Echo delete, single or bulk, shows an Undo toast
  (10 s, paused while hovered or focused). `useInventoryStore.removeEchoes`
  and `restoreEchoes` each run in one Dexie transaction. `removeEchoes`
  skips locked Echoes.
  - `restoreEchoes` takes only `removeEchoes` output. It writes those rows
    back verbatim under the same ids, with no schema parse (`load()` never
    validates rows), and never overwrites an id that exists again.
  - Undo lives in memory only. It is dropped when `load()` bumps
    `generation` (a backup restore) and when the toast goes. It survives a
    section switch, because toasts live in one app-wide store.
- **Team allocation** (Teams page, `ui/components/TeamAllocation.tsx`;
  optimizer side `optimizer/allocate.ts` + `allocateMembers.ts`). It is
  greedy, not a joint optimum, and the UI must keep saying so.
  - **Search:** members search in a user-ordered priority with the
    existing exact search (`runOptimization`, injectable `run`). Each
    searches the inventory minus the Echoes earlier members took. The
    priority order is saved on the Team (`Team.priority`).
  - **Pool:** it ignores `equippedTo`, keeps locked Echoes and honours a
    minimum level. Cost budget always 12 (`ALLOCATION_COST_BUDGET`), used
    for every step and for the baseline's legality. No Sonata lock, top 1.
  - **Inputs:** the objective and context come from a saved build
    (`Build.objective`, `Build.context`, else the Roster entry on the same
    weapon).
    - The enemy is `Build.enemy`, else the Calculator's session-only
      setting. Each member row says which one it uses.
    - A dual-mode character's mode is `Build.resonanceMode`, else a
      required per-member picker (`characterResonanceModes`). It is passed
      as `SearchData.resonanceMode`.
  - **Minimum stats:** the source build's `minStats` go into every step's
    request and the baseline's, into `planKey` and into the saved drafts.
    A baseline that misses them gets no comparison.
  - **Baseline:** the same search over exactly the five `equippedTo`
    Echoes (best slot-1 order).
  - **Cancel:** `handle.cancel()` never settles its promise, so
    `runAllocation` races it against an `AbortSignal`.
  - **Stale preview:** Save is disabled when `planKey` changes: every Echo
    field except `locked`/`origin`, each member's objective, context,
    weapon, enemy and Resonance Mode, the minimum level,
    and `dataStamp` (snapshot version and `fetchedAt`).
  - **Save:** "Save as builds" is `saveBuilds` (one transaction) with an
    Undo (`removeBuilds`). Saving never writes `equippedTo`.
  - **Mark as equipped** (`MarkEquipped.tsx`, pure `optimizer/equip.ts`
    `planEquip`). `equippedTo` mirrors the game, which the app can't
    change, so this only *records* a re-gear done in the game. The copy
    says so.
    - Rules: each member with a result gets its 5 Echoes, and its other
      recorded Echoes go back to the bag. An Echo worn by anyone else
      moves (assignment beats unequip). Members without a result are
      untouched, and locks don't matter.
    - It is enabled only for a non-stale preview, behind a confirm step
      that lists counts per character (Cancel focused) and is recomputed
      at click time.
    - `reassignEquipped` is one Dexie transaction that returns the previous
      `equippedTo` of the changed rows. `restoreEquipped(previous,
      applied)` restores only rows still holding the value it set.
    - The Undo toast lives on the Teams page, in memory only, and is
      dropped on an inventory `generation` change.
    - After marking, the preview is stale by design (`equippedTo` is in
      `planKey`): run again to compare against the new gear.
- **Toasts.** One store (`ui/toasts.ts`: `pushToast`, `dismissToast`,
  `holdToast`, `dismissToastScope`), rendered once by `ToastHost` in
  `App.tsx`. Pages never render a `ToastStack`.
  - Timers live in the store, so a toast and its Undo survive a section
    switch.
  - An Undo tied to the loaded inventory uses `scope:
    INVENTORY_UNDO_SCOPE`; `ToastHost` drops that scope when
    `useInventoryStore.generation` changes.
  - A page test that expects a toast must render `<ToastHost />`.
- **Builds page detail.** A saved own build's card expands (`BuildDetail`)
  to its five Echoes as they are in the inventory now, plus the weapon and
  the saved enemy, Resonance Mode and minimum stats. A deleted
  Echo is marked in its slot and on the card. A reference build expands
  (`ReferenceBuildDetail`) to its saved payload on `SharedBuildCard`
  (`hideTitle`), with `viewSharedBuild` computed only while open. It never
  resolves against the inventory, so nothing is marked missing.
- UI dynamics: live-feedback primitives in `src/ui/components/feedback.tsx` +
  `src/ui/toasts.ts`, motion hooks in `src/ui/motion.ts` (`useAnimatedNumber`,
  `useReveal` for scroll-in Windows, `useTypewriter` for the mascot bubble), command palette in
  `src/ui/components/palette.tsx`, free-text suggest in
  `src/ui/components/SuggestInput.tsx`. All keyframes
  live in the Motion section of `src/index.css` (reduced-motion safe);
  section routing (`#section`) lives in `src/state/store.ts`.
- **Share links.** A `#b=` link opens Builds and is held as
  `useAppStore.shareLink`, captured at load and on `hashchange`; `syncHash`
  won't overwrite it.
  - **Format:** v2 links (`#b=2.<base64url(deflate-raw JSON)>`,
    `state/share.ts`, schema `sharedBuildSchema`) are self-contained. They
    carry the 5 Echoes' stats (slot 1 first), the character/weapon context
    (`Build.context`, else the current Roster entry) and, opt-in, the
    objective. They never carry Echo ids, `equippedTo`, `origin`, labels or
    notes. v1 links (`#b=<base64url JSON>`) still decode.
  - **Untrusted input:** the hash is ≤ 16 384 characters before decoding,
    and the inflated payload ≤ 64 KiB, checked while streaming. The zod
    schema is strict. Values are flagged against `data/echoStats.ts`, never
    corrected.
  - **Preview:** nothing is written until the user acts. The options are
    Save as reference, Optimize with my Echoes (a non-persisted Calculator
    draft; the roster is never written) and Dismiss. Each resolves the link
    to `#builds`.
- **Picked-file caps.** Read user-picked JSON only through
  `ui/readFile.ts` `readTextFile`, which checks the size before
  `file.text()`. Backups are capped at 16 MiB and Kamera imports at 8 MiB,
  at least 10x a real inventory (~400 B per Echo, measured).
- **Downloads and errors.** File downloads go through `src/ui/download.ts`
  (`downloadBlob`, `downloadBackup`): object URLs are revoked after a delay,
  never right after `click()`. `src/ui/components/ErrorBoundary.tsx` wraps
  the app in `main.tsx` and each section in `App.tsx`. Its fallback offers
  Export backup, Try again and Reload, and a failed lazy page chunk is
  retried.

## Conventions

- Use ESM `import`/`export` with explicit `.ts`/`.tsx` extensions in relative paths.

## Subagent delegation

Default to working inline — a lookup one `search`/`read` answers stays
inline. Spawn child agents when the work splits into genuinely independent
units:

- **Fan-out transcription/audit**: N same-shaped units (per-Sonata-set
  values, per-character/per-weapon checks, provider-vs-snapshot diffs).
  One child per batch, not per keyword; cap width to the units at hand.
- **Bounded read-only research**: snapshot/API/live-source lookups with a
  crisp question that needs no session context.

Never delegate cross-cutting design, final integration, or verification.
Children are read-only researchers: they return evidence (file:line,
values, exact URLs inspected), and the parent does all edits, runs the
gates, and owns correctness. A child result you haven't verified is a
lead, not a fact — especially numbers, which re-enter the
no-fabrication guardrail at integration time.

Reusable child briefs (paste into the spawn prompt, scoped to the task):

- **data-transcriber**: "Transcribe these snapshot records into
  `BUFF_PRESETS`/`TEAM_BUFFS` entry text: <ids>. Rules: values only from
  the quoted source strings; flag ambiguities instead of guessing; return
  entries + one-line provenance each. Do not edit files."
- **source-scout**: "Find current numeric values for <items> from live
  sources. Inspect underlying page content (search snippets don't count);
  return value + exact URL per item, or 'unresolved' with what you tried.
  Do not edit files."
- **mechanics-checker**: "Review <diff/plan> against
  `docs/WUWA_GAME_REFERENCE.md` (it wins over background knowledge).
  Return each contradiction with doc section + file:line, or 'no
  contradictions found'. Do not edit files."
