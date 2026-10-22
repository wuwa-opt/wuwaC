## Goal

Get the user's in-game Echo inventory (738 Echoes in the 2026-10-16 screenshot) into the app without hand entry. The app reads the game's **Echo Management** detail panel (name, `+level`, Sonata icon, COST, 2 main stats, up to 5 substats, "Equipped by X") from screen pixels, OCRs it in the browser, validates every value against the game's closed vocabularies and discrete roll tables, and stages the result for review before it touches `ownedEchoes`. Multi-session project. Each phase can be verified on its own and leaves the app working.

## Status (2026-10-22): Phase 4, video input

- **Sample:** the user's 32.7 s, 60 fps, 1894×1062 H.264 recording, clicking through the Windward Pilgrimage filter at ~1 Echo/s: 16 panels, 15 distinct Echoes (one Spectro Drake visited twice). Hand-read truth is in `scan-fixtures/truth.json` (`vid-seg00`–`15`), and the frames are in `scan-fixtures/video/`.
- **Change detector** (`src/scanner/video.ts`), measured on that recording at 10 fps, 96×128 gray:
  - text switches in one step (difference 5.3–12.3); idle noise ≤ 0.72; threshold 2.5.
  - The animated art is the main false trigger. Comparing only the name line (x < 0.55) and the stat block took it from 19 segments to the true 16.
  - The OCR frame is the first sample ≥ 0.2 s into a panel; a shorter panel is read from its last sample, never dropped.
- **Five passes now:** passes 1–4, then pass 5 re-reads only the rows the parser flagged, in single-line mode (PSM 7), adopting a strip only if `parseCost` drops.
  - It fixed the two block-mode misreads in the video ("DEF 60" → "0", "Fleurdelys" → "Fledrel=gis").
  - The first version ranked parses by flag count and picked a *worse* read: a lost name also silences the checks that depend on it. Unread fields now outrank flags.
  - Re-read strips use `textLineBox` (top edge + smallest wordy height), because art inflates name-row word boxes.
- **Other parser fixes from the video:**
  - The value column runs down to the footer; a missed last value had been sliced in half.
  - A label with no value is an error row, not a silent drop.
  - I/l/1 and O/0 are folded in vocab matching ("luno" → Iuno) when that leaves exactly one candidate.
- **Results:**
  - `scan-eval` js5pass over all 33 panels (17 screenshots + 16 video frames): **396/396 fields correct, 0 silent errors**, 31/33 panels need no review (one approximate name, one Rover choice).
  - Committed fixtures now hold all 33.
- **Walk (`videoFrames.ts`), measured in Chromium 155:**
  - Seeking costs 126 ms/sample (a keyframe every 2 s), so the first version took 46.5 s for the clip.
  - It now plays at 4× via requestVideoFrameCallback, decimated to ~10 fps, and refills any gap over 0.25 s by seeking; it also pauses while the tab is hidden.
  - The clip now takes 11.3 s including OCR, with identical results: 16 panels, all Ready, every value correct, the revisit flagged.
  - Stress at 16× playback (constant gap repair): all 15 Echoes found with correct values; one Echo split into two segments (caught as a repeat, unticked) and one benign "COST not read" review.
- **Review:** in-scan repeats (identical rolls) start unticked with "Same rolls as #n", and video frames with no Echo panel (no name, cost or main stat) are dropped and counted.
- **CSP:** `media-src blob:` was needed. Without it Chromium rejects the object URL ("Media load rejected by URL safety check").
- **Next:**
  - live capture (`getDisplayMedia`), which can reuse the detector and the walker's capture logic;
  - Phase 5 rescan sync.
- **Open risk:** a sample landing mid-transition could give a blended frame. It wasn't seen at 4× (16/16 clean), and it would surface as a flagged or repeat row, never a silent one.

## Status (2026-10-16)

- **Phase 0 done.** 17 user screenshots in gitignored `scan-fixtures/` (+ hand-read `truth.json`). Results (`scripts/scan-eval.ts`), fields correct out of 204 / silent errors:
  - tesseract CLI, 1 pass, PSM 11: 122 / 34 (most "silent" ones were parser cascade gaps, since fixed)
  - tesseract.js, 2 passes: 186 / 0
  - tesseract.js, 3 passes: 200 / 0
  - red-channel or grayscale preprocessing at 2×: 193 / 1 and 153 / 3, so we use **raw frames, no preprocessing**
  - **tesseract.js 7, 4 passes, raw: 203 / 0**. 14 of 17 panels need no review; ~1.2 s/panel in node with 1 worker, ~2 s for 2 panels in Chromium with 2 workers (including the first engine load)
- **Phase 1 done** (parser + validation, plus the pass plan): `src/scanner/{match,values,parse,layout,pipeline}.ts` with tests. The 17 real OCR reads are committed as text-only fixtures (`src/scanner/fixtures/panels.json`); the zero-silent-error gate is a unit test.
- **Phase 2 is reduced** to the change detector needed by Phase 4. The Sonata icon matcher is dropped (Key Decision 5).
- **Phase 3 MVP done:**
  - `engine.ts` (tesseract.js pool), `draft.ts`, `review.ts`, `state/scanStore.ts`, `ui/components/EchoScanner.tsx`, and a "Scan screenshots" action on the Inventory page.
  - Verified end to end in headless Chromium against `npm run preview` with all 17 fixtures (local `scan-fixtures/e2e-cdp.mjs`): the browser output equals the node output.
  - Imports use `origin: import:screen-scan` and set `equippedTo`. Echoes already owned (fingerprint multiset) are unticked by default.
- **Next:** Phase 4 (video / live capture + change detector), then Phase 5 (rescan sync: keep ids, upgraded pairing, not-seen list).
- **Known residual risks:**
  - If the footer OCR misses "Equipped by", the Echo imports as unequipped and isn't flagged. 14/14 equipped Echoes were read in the fixtures. A gold-pixel presence hint is the planned guard (Phase 2).
  - Garbled reads like "0939" (for 9.3%) are flagged as errors and need a manual fix.
  - Below +25, values are only range-checked.

## Success Criteria

- On a hand-checked sample of at least 50 real Echoes, every field is either correct or visibly flagged for review. **Zero silent errors** is the hard gate. Raw accuracy is secondary.
- A full inventory can be scanned by clicking through the grid once, with no screenshot hotkeys or per-Echo typing. Target: about 1 Echo per second of clicking.
- Re-scanning later keeps existing Echo ids (builds survive), recognizes upgraded Echoes, and lists Echoes that are in the app but weren't seen in the scan. Nothing is deleted automatically.
- Everything runs client-side. Frames never leave the browser, and the scanner works offline once its OCR assets have been fetched once.
- `npm run test`, `npm run lint`, and `npm run build` pass. Existing Kamera import/export behaves the same as before.

## Context And Current Facts

- **An importer already exists, but only for a file format.** `src/data/kamera.ts` maps WuWa_Inventory_Kamera JSON to drafts (`mapKameraEchoes`, `:182`). The UI is a file-pick → preview Window → additive `importEchoes` flow (`src/ui/pages/InventoryPage.tsx:88,241-275`, store `src/state/inventory.ts:107-117`). The scanner should produce the same draft shape (`KameraDraft` = `OwnedEcho` minus `id`/`origin`) and reuse the preview → import path.
- **Kamera is not a viable source for this user.** It emits numeric `monsterID` keys whenever its OCR succeeds and falls back to names only on OCR failure (README, inspected 2026-10-16: "monsterID(340000070): string(int), if not the OCR failed and you will see a flatcase name"). Our importer skips numeric keys (`kamera.ts:338`, there's no crosswalk: snapshot `apiId`s are encore.moe ids such as 6000167). So a real Kamera export would be mostly rejected. Kamera also requires fullscreen, has only been tested at 3 resolutions, and its README doesn't mention Linux/Proton. The user plays on Linux (Hyprland).
- **The vocabularies are closed, which is what makes OCR safe.**
  - Echo names: 199 `echoDefs`, no duplicate names (checked 2026-10-16).
  - Stat labels: about 20 strings that map 1:1 to `StatKey`.
  - Substat values: discrete tiers in `SUB_STAT_TIERS` (`src/data/echoStats.ts:53`).
  - Main-stat bounds: `MAIN_STAT_RANGES` (`:19`), 5★ Lv0 to Lv25.
  - Flat and % values of the same stat never overlap (ATK 30–60 vs 6.4–11.6%, HP 320–580 vs 6.4–11.6%, DEF 40–70 vs 8.1–14.7%). A dropped `%` sign is therefore recoverable from magnitude.
- **The Sonata set is not in the panel text.** It shows only as the small icon next to `+25`. However, `echoDef.sonataIds` narrows the candidates to 1–4 sets per Echo (counts: 63 Echoes ×1, 89 ×2, 44 ×3, 3 ×4). Example: Reminiscence: Threnodian - Leviathan → Flamewing's Shadow or Thread of Severed Fate. `sonataSetSchema` has no `iconUrl` (`src/data/schema.ts:323`).
- **Panel layout at 1920×1080** (from the user's screenshot):
  - Panel box: x 1315–1855, y 128–920. It's anchored to the right edge.
  - Rows: name at y≈128–162, `+25` and Sonata icon at y≈195–232, `COST n` at y≈248–282, stats block at y≈455–800, "Equipped by" at y≈870–905.
  - The first two stat rows are shaded. They are the primary main stat and the fixed secondary (ATK 150 on 3/4-cost, flat HP on 1-cost).
  - Long labels wrap. "Resonance Skill DMG Bonus" takes 2 lines, so rows can't be sliced at a fixed height.
  - The selected grid cell has a gold frame.
- **`equippedTo` is a character id** (`src/domain/teams.ts:26-40`). Builds reference Echo ids (`buildSchema.echoIds`, `src/data/schema.ts:550-556`). A rescan that recreates rows would orphan builds.
- **Hosting.** Workbox precaches only `js,css,html,svg,png,gif` (`vite.config.ts:39`), so a self-hosted `.wasm` or `.traineddata` file wouldn't be precached. That's what we want: users who never scan never download it.

## Constraints And Non-goals

- Local-first: no backend, no account, no upload of frames. Network use is limited to fetching our own OCR assets, same-origin.
- Layering: a new `src/scanner/` layer sits beside `src/optimizer/` (UI → scanner → domain → data). Pixel and text parsing are pure functions over plain `{width, height, data}` buffers and strings, so Vitest can run them in `node` without a canvas. Only the capture adapters touch DOM APIs.
- Strict TS, no `any` in `src/scanner/`. Every pure function gets a test with a hand-computed expected value.
- No fabrication: a value that didn't OCR exactly as a valid tier or range is **flagged**, never silently "corrected". Main-stat values between Lv0 and Lv25 are range-checked only, because the per-level curve is unsourced.
- No new Dexie table in v1 of this feature. Staging lives in memory plus a try/catch-guarded `localStorage` draft (`wuwa-scanner-draft`). Learned Sonata icon signatures go in `wuwa-scanner-sonata-sigs`. If either is promoted to Dexie later: version(2) + upgrade + backup format bump.
- No copyrighted art in the repo. Real screenshots used for the spike stay in a gitignored `scan-fixtures/`. Committed tests use OCR **text** fixtures and synthetic pixel buffers only.
- Non-goals: reading game memory, packets, or files (anti-cheat/ToS risk; the inventory is server-side anyway), the Kuro companion-app API (needs an account token plus a server, and only covers equipped Echoes), scanning characters/weapons, and non-English game clients (English only first).

## Key Decisions

1. **Screen OCR in the browser, not an external tool.** Every community scanner reads the screen. We do it inside the app, so there's nothing to install and it works on Linux/Proton, Windows, and any static host.
2. **Three input sources share one pipeline:**
   - (a) dropping screenshots,
   - (b) dropping a screen recording (e.g. `wf-recorder` on Hyprland while clicking through the grid),
   - (c) live capture via `getDisplayMedia`.
   All three produce frames → change detector → OCR queue. (a) and (b) are deterministic and have no tab-throttling problems, so they ship first.
3. **OCR engine: tesseract.js** in a Web Worker. We self-host the core `.wasm` and `eng` traineddata under `public/ocr/` and override the worker, core, and lang paths so no CDN is used. These files are lazy-loaded when the Scanner opens and cached by a Workbox `CacheFirst` route on `${BASE}ocr/`.
   - Run separate passes per region: values with a digit/`.`/`%` whitelist, labels and names in normal mode.
   - Escalation: if the Phase 0 spike shows tesseract can't reach the zero-silent-error gate even after preprocessing, re-evaluate a PaddleOCR model on onnxruntime-web. It's heavier, so it's only worth it if needed.
4. **Validate, then match. Never guess.** For each field:
   - Echo name: fuzzy-matched (normalized Levenshtein) against snapshot names.
   - Stat labels: fuzzy-matched against the stat vocabulary.
   - Substats: must OCR exactly to a tier, otherwise the nearest tier is pre-selected and flagged.
   - `COST n`: cross-checked against `def.cost`.
   - Main stat: must be in `def.allowedMainStats` and inside `MAIN_STAT_RANGES`. At 5★ +25 it must equal the max.
   - Each field gets a confidence (`exact | snapped | fuzzy | unknown`), and the review UI highlights anything that isn't `exact`.
5. **Sonata from the in-game filter, not pixels** (user decision 2026-10-16). The Echo Management filter has a Sonata dropdown that shows a count per set (e.g. "Flower of Tinged Yearning 17"). A scan runs as **batches**:
   - The user sets the in-game Sonata filter, then picks the same set (and optionally the expected count) in the app.
   - Every Echo scanned in that batch gets that `sonataId`.
   - Validation: `def.sonataIds` must include the batch set. If it doesn't, the row is flagged, which catches a forgotten filter change.
   - The expected count drives a "17 / 17 done" progress readout and warns on overshoot (filter wrong) or undershoot (missed Echoes) before import.
   - Icon matching is dropped from scope. The `+25`-adjacent icon is ignored.
6. **Advance detection** (live and video): a new Echo is recorded when the panel-content hash changes **or** the gold-framed grid cell moves, and the panel has then been stable for 2 frames. The cell signal keeps two identical, adjacent +0 Echoes from collapsing into one.
7. **Rarity:** read from the name text's hue (gold = 5★). A main-stat value outside the 5★ range at that level downgrades confidence. Non-5★ Echoes import with main-stat validation off and are flagged.
8. **Rescan sync, keyed by fingerprint.** Fingerprint = def + sonata + rarity + level + main + sorted substats. The scan is a multiset.
   - Exact matches keep their existing row id.
   - An app row and a scanned Echo with the same def/sonata/main, where the app row's substats are a prefix of the scanned substats and the scanned level is higher, are paired as "upgraded" and updated in place.
   - New scans are added.
   - Rows in the app that weren't seen are listed. Deleting them is opt-in.
   - Origin tag: `import:screen-scan`.
9. **Auto-advance is optional and lives outside the web app.** Browsers can't send input to another window. A separate opt-in helper script (Phase 6) clicks grid cells. It's the only part that injects input into the game, so it's the part most likely to conflict with Kuro's terms or anti-cheat. It's documented that way and never bundled into the page.

## Phases

### Phase 0: Spike and in-game facts (no app code)
- `scripts/scan-spike.ts` (`tsx`, tesseract.js in node): crop ROIs from 20–30 real screenshots in gitignored `scan-fixtures/`, OCR them, and dump the raw text and word bboxes to JSON. Measure exact-match rates per field.
- Lock the ROIs as right-edge-anchored fractions of frame height: x = W − k·H, y = k·H. Verify them on the user's resolution, plus one 16:10 frame if available.
- Things to observe in-game and record in this plan before Phase 1. Unknowns stay unknowns until observed:
  - How locked or untuned substat slots render at low levels.
  - Whether the detail panel can show the Sonata name as text when scrolled (if so, Key Decision 5 gets simpler).
  - Name colour per rarity.
  - The "Equipped by" wording for Rover.
  - Whether keyboard or controller input moves grid selection (this shapes Phase 6).
- Exit: an engine decision, frozen ROIs, and committed OCR-text fixtures (text only).

### Phase 1: Pure panel parser (`src/scanner/parse.ts`)
- `parsePanel(ocr: PanelOcr, snapshot) → { draft: KameraDraft | null, fields: FieldConfidence[], issues }`.
- Label/value pairing by bbox y-overlap. A label line with no value merges into the next line, which handles wrapped labels.
- Rows 1–2 are main stats and rows 3+ are substats. `%` is inferred by magnitude when it's missing.
- Tier and range validation, cost cross-check, `Equipped by` → character id via fuzzy match (Rover is ambiguous → flag).
- Tests: hand-computed drafts from the Phase 0 text fixtures, including the screenshot Echo:
  - Name and main stats: Threnodian Leviathan, Lv25, cost 4, main Crit Rate 0.22 + ATK 150.
  - Substats: Skill DMG 0.094, Crit DMG 0.198, Crit Rate 0.069, ER 0.108, HP% 0.064.
  - Equipped by Galbrena.
  - Plus wrapped-label, missing-`%`, misread-digit, and unknown-name cases.

### Phase 2: Pixel utilities (`src/scanner/pixels.ts`), reduced scope
- dHash of the panel band (change detection for video/live), gold-frame cell locator (advance detection), and a gold-text presence check for the footer (guards against a missed "Equipped by" read). All pure over `{width, height, data: Uint8ClampedArray}`.
- Preprocessing (threshold/upscale) is dropped: Phase 0 showed it hurts.
- The Sonata matcher is dropped: Sonata comes from the batch.
- Tests on synthetic buffers with known hashes and hues.

### Phase 3: MVP (screenshot and video drop → review → import)
- `src/scanner/ocr.worker.ts` + `protocol.ts`, mirroring `src/optimizer/` (a pool of 2 workers, transferable `ImageBitmap`s).
- Self-hosted assets in `public/ocr/`, plus a Workbox `CacheFirst` runtime route.
- Frame sources: image files, and video files via `<video>` + `requestVideoFrameCallback`/seek stepping.
- UI: a "Scan from game" Window on the Inventory page:
  - Progress, then a review list showing the panel crop thumbnail, parsed fields, and confidence chips.
  - Non-exact fields open the existing `EchoForm` for fixes.
  - Sonata picker for ambiguous rows.
  - "Import N" → `importEchoes(drafts, 'import:screen-scan')`.
- Tokens and primitives only (`classes.ts`, `ui.tsx`). No raw hex.
- Exit: the user records one pass with `wf-recorder`, drops the file, reviews, and imports.

### Phase 4: Live capture
- `getDisplayMedia` (on Hyprland via `xdg-desktop-portal-hyprland`) → frames.
- Preferred path: Chromium `MediaStreamTrackProcessor` in the worker, which isn't throttled while the tab is hidden.
- Fallback: `<video>` + timers, with a note to keep the app visible (second monitor or a pinned floating window) because hidden tabs throttle to about 1 Hz.
- Live counter, scanned-count beep/toast, pause/resume, and a draft autosave to `localStorage`.
- Verify early, before building the UI: portal capture of the Proton game window, and frame rate while the game is fullscreen on one monitor.

### Phase 5: Rescan sync and equipped state
- Fingerprint/upgrade matching (Key Decision 8) as a pure function with tests.
- Review shows four groups: Unchanged / Upgraded / New / Not seen.
- Store gains a transactional `syncScannedEchoes(plan)`: add + update in place + optional delete, in one Dexie transaction.
- `equippedTo` from "Equipped by". Optional action: "Create current-gear builds" from groups of 5 equipped Echoes (cost-checked).

### Phase 6 (optional, opt-in): auto-advance helper
- `scripts/echo-autoclick.sh` using `ydotool` (Wayland): click each of the 6×4 visible cells, scroll, and repeat, with a dwell time long enough for the panel to settle.
- Documented in the README with the ToS caveat. Not wired into the app.
- Only build this if Phase 4 manual clicking turns out to be the bottleneck.

## Verification

- Per phase: `npm run test && npm run lint && npm run build`.
- Phase 3+: run the app, scan the spike fixtures end to end, and diff against hand-entered truth for the 50-Echo sample (zero silent errors).
- Phase 4: a timed live scan of a filtered in-game view (e.g. 4-cost only).
- Phase 5: a rescan after levelling one Echo shows exactly 1 Upgraded row, and builds still resolve.

## Side Item (separate, not blocking)

- Kamera numeric-id crosswalk: check whether encore.moe echo detail records expose the game monster id. If they do, sync it onto `echoDefSchema` (optional field) so real Kamera exports import. Only worth doing if someone actually uses Kamera.
