## Goal

Get the user's in-game Echo inventory (738 Echoes in the 2026-10-16 screenshot) into the app without hand entry. The app reads the game's **Echo Management** detail panel (name, `+level`, Sonata icon, COST, 2 main stats, up to 5 substats, "Equipped by X") from screen pixels, OCRs it in the browser, validates every value against the game's closed vocabularies and discrete roll tables, and stages the result for review before it touches `ownedEchoes`. Multi-session project. Each phase can be verified on its own and leaves the app working.

## Status (2026-10-31, latest): the user's real phone recording

- **Sample:** `~/Videos/Screenrecorder-2026-10-31-08-51-28-925.mp4`, the phone's own recorder: HEVC Main, 2400×1080 (20:9), full range (`yuvj420p`), ~24.2 fps variable, a keyframe every ~1 s, 61.3 s. Echo Management with no filter set ("Sort by Level" in every segment), clicking at ~1.5 s per Echo.
- **Playback:** Chromium 156 on Linux loads it with a 0×0 video track, and the app shows its "can't play … HEVC" message. For browser runs, an H.264 copy (`scan-fixtures/ph/ph-h264.mp4`: libx264 CRF 10, full-range flag and colour tags kept, all 1481 timestamps and all 62 keyframe times identical). A first copy with x264's default ~10 s keyframe spacing scanned in 179 s instead of 66 s (every gap repair decoded up to 10 s). Pixels: ffmpeg's decode of the copy vs the original, MAE 0.13%; Chromium's decode of the copy vs ffmpeg's of the original, MAE 0.37%, gold "Equipped by" (232,222,168) vs (234,224,171). The detector segments the original (ffmpeg) and the copy identically.
- **Real geometry:** the panel is the same size as on desktop (548 px wide at 1080 tall) but ends 126 px before the frame's edge (64 px at 16:9): the game keeps ~120 px side margins, and the grid has 8 columns. The old band (x 1747–2400) began on the Echo name's first pixel (1747). The Upgrade button's right edge is 125 px from the edge on all 51 phone frames and 60 px on every 16:9 frame (40 at 720p).
- **Truth:** `ph-seg00`–`50` in `scan-fixtures/truth.json`: 51 segment frames, 38 distinct Echoes, nothing uncertain. 13 frames are one-sample transitions (the next panel's text over the previous art). Only 4 of the 38 roll a single set, so with no filter set the rest must ask for theirs; 4 are on a Rover.
- **Changes:**
  - On a frame > 1% wider than 16:9, the band is placed by the Upgrade button found in pixels, with the 16:9 slack (`isWideFrame`, `findUpgradeButtonRight`). Every other frame keeps the old band, word for word. The walk places its detector band once; scan frames keep the button's own box (`buttonBox`) so the reader and the thumbnail agree.
  - A fuzzy "Family: Own" name needs ≤ 0.5 edits per character of its own part: "Reminiscence: El" (art over Fleurdelys) had matched "Reminiscence: Denia", a single-set Echo whose read then outranked the right one.
  - A flagged video row's second frame is the segment's second-to-last sample, and a capture reads no pixels back: in 4×-slowed runs Skywatch Lancer was twice replaced by the next panel's read.
  - The 51 phone frames joined the committed gate (135 panels).
- **Results** (offline: `scan-spike` + `scan-eval`, fields correct / silent / panels needing no review; browser: `compare-e2e-v3.mjs`, distinct Echoes matched, every row incl. Sonata):

  | Set | Before | After |
  |---|---|---|
  | 84 fixture panels, as recorded | 1081 / 0 / 55 | same, identical reads |
  | 720p | 1054 / 0 / 49 | same, identical reads |
  | 20:9 synthetic | 1085 / 0 / 53 | 1085 / 0 / 53 |
  | phone frames (51) | 661 of 663 / 0 / 5 | 654 / 0 / 4 |
  | phone, margin +40 px | 148 / **20** / 0 | 654 / 0 / 4 |
  | phone, margin +80 px | 60 / **47** / 0 | 654 / 0 / 4 |
  | browser, phone recording, desktop size | 37–38 of 38, 0 silent, 66–75 s | 38 of 38 every run, 0 silent, 72–77 s |
  | browser, phone emulation | 37–38, 0 silent, 66–69 s | 38 every run, 0 silent, 72–80 s |
  | browser, phone emulation, CPU 4× | 37–38, 0 silent, 173–177 s | 38 (3 runs), 0 silent, 173–176 s |
  | browser, margin +40 px | 0 of 38 (every row flagged) | 38 |
  | browser, recordings 1 / 2 | 15/15; 45/46, 0 silent | 15/15 all Ready; 44–46/46, 0 silent |

  Before, Fleurdelys came out as "Reminiscence: Denia" (flagged) in 4 of 6 runs. Review rows went from 44–50 to 38–41 (fewer duplicate segments: 51 → 41). Unslowed, the new build is ~7 s (~10%) slower on this recording (interleaved pairs), not fully isolated: OCR per phone panel is ~4% slower on the new band, and painting the button's search strip cost a few seconds (now only its box is painted). At 4× CPU the two are equal. Details: `.agents/plans/2026-10-30-agents/reports/mobile-3.md`.
- **Not verified:** a real phone's browser (HEVC decoding, speed, heat); a phone with other margins (only synthetic shifts); a recording with a filter tag on a phone.

## Status (2026-10-30): scanning on the phone itself

The user wants to upload on the phone itself and will record a phone video later.

- **Phone emulation** (`e2e-video.mjs` `MOBILE=1`: 412×915 at DPR 2.625, touch, Android Chrome UA; `CPU=n`; `SHOTS=` screenshots):
  - the 20:9 copy: 14/15 (the miss flagged), 0 silent, JS heap peak 19 MB;
  - the same with the CPU slowed: 4× 52 s, 8× 95 s for the 32.7 s recording (19 s unslowed), same reads, 0 silent. CDP throttling is approximate: it does not slow the GPU video decoder.
  - The layout works at phone width. Each review row is about a third of the screen, so with 100+ Echoes the Apply button was a long scroll away.
- **Changes:**
  - The screen is kept on while a scan runs (`ui/wakeLock.ts`): a sleeping screen hides the page, and the walk pauses while hidden.
  - The progress line says to keep the page open and in front.
  - The Apply / Clear list bar is pinned above the bottom tab bar (bottom of the screen on desktop).
  - The instructions say "tap or click", and that the phone's own screen recorder works.
- **Unverified:** a real phone (Android Chrome or iOS Safari). On iOS, whether Photos hands the file input a re-encoded or smaller video is unknown. HEVC plays in Safari and on most Android phones (hardware decoder), so on-device scans avoid the desktop HEVC problem.

## Status (2026-10-30, later): phone-style recordings

User direction (2026-10-30): no key (arrows, WASD, Tab) moves the Echo grid selection, so auto-advance would need clicks; set aside. Instead, make the video reader robust, including phone recordings (WuWa runs on mobile).

- **No real phone recording yet.** Every variant below is recording 1 (15 Echoes, hand-read truth) transformed with ffmpeg (`scan-fixtures/phone/`, runs in `scan-fixtures/runs-phone/`). The real mobile layout is unknown; a web search found no mobile screenshot of Echo Management.
- **Before any change** (browser, `e2e-video.mjs`, no set picked):
  - fine, 15/15 or 14/15 with the miss flagged, 0 silent: 720p, 720p 30 fps at 800 kbps (a messenger-style copy), 90° rotation metadata, variable frame rate (duplicate frames dropped), H.264 in .mov;
  - HEVC: "can't play" in this Chromium (Linux, no HEVC decoder);
  - 20:9 (2400×1080, the game frame on the right edge): 0/15, every row flagged. The panel band was 34% of the frame width, so it took in grid tiles, and the tag area missed the tag.
- **Changes:**
  - `designWidth` = the frame width up to 16:9, 16/9 × height beyond. The panel band is 34% of it on the right edge (unchanged at 16:9). The tag box is searched from x 0 to the band (same box on all 84 fixture frames as before). Its size limits use `designWidth` and its letter-gap bridge scales with the height (4K was splitting it).
  - Grid bar: single-line mode over the whole width read "Sort by" on 0/84 originals, so it is read in strips of the measured width (`gridBarRects`), stopping at the first that shows it. The first strip is the old one.
  - Gold "Equipped by" check: a fixed region (`equipCheckRect`, the band from 45% down) instead of the OCR-placed footer strip. On a 20:9 720p copy, pass 1 read a 55 px junk word on the last stat row, the footer strip landed under the gold line, and Kelpie came out unequipped with no flag, in 3/3 runs (a silent error). In the fixed region, unequipped panels have 0 gold pixels (27 × 3 sizes), and equipped ones have at least 0.98‰ (57 × 3). Threshold 0.2‰.
  - The footer strip (pass 4) never starts below half a line above the gold line found in pixels; the gold check now runs before passes 2–4. Placing the fallback by the stat values instead (median value height) fixed the junk case but cut into a last substat whose value pass 1 had missed (720p offline: 2 panels lost, 1 gained), so the old fallback stays, capped.
  - Tried and dropped: OCR on a 2× upscaled frame for 720p (`scan-spike --pre up`): 1028 vs 1050 of 1092 fields, 43 vs 46 clean panels, 40% slower.
  - The "can't play" message names HEVC.
- **Results after the changes** (offline = `scan-spike` + `scan-eval` on the 84 fixture panels; browser = one run each, no set picked):
  - Offline, fields correct / silent / panels needing no review:

    | Frames | Before | After |
    |---|---|---|
    | as recorded | 1088 / 0 / 52 | 1081 / 0 / 55 |
    | 720p | 1062 / 0 / 51 | 1054 / 0 / 49 |
    | 20:9 (2400×1080) | not readable | 1085 / 0 / 53 |

    The field losses are one panel per set whose whole stat block pass 1 missed (flagged) after the band moved 2–3 px. On the user's recordings, which are 0.3–0.4% wider than 16:9, the band is now 16/9 × height.
  - Browser:
    - recording 1: 15/15, all Ready;
    - 20:9: 14/15 (the miss is flagged);
    - 20:9 at 720p: 15/15, 0 silent (it was 1 silent in 3/3 runs);
    - 720p and the messenger copy: 15/15;
    - recording 2: 46/46 truth rows, 0 silent, 46.6 s.
  - Still unreadable: a black pillarbox (the frame padded with near-black). The tag finder takes the bar for the tag. With no set picked, every multi-set Echo is flagged (0/15, 0 silent). A set picked in the app would be applied, as for a region capture.
- **Next:** a real phone recording (any phone, Echo Management, a Sonata filter set, ~20 Echoes) to check the 20:9 assumption, then black-bar cropping if real recordings have bars.

## Status (2026-10-30): Phase 5, rescan sync

- **Matching** (`src/scanner/sync.ts`, pure): identical rolls pair first with the copy recorded on the same character, then with any copy. An upgrade means the same def/set/rarity/main stat at a lower level, with every owned substat among the scanned ones. It pairs only when there is one candidate group of identical owned rows with a copy for each distinct scanned Echo that claims it. Otherwise the row is new and says it may be an upgrade. A repeat (the same Echo clicked twice) claims once.
- **Applying** (`inventory.applyScan`, one Dexie transaction): add the new Echoes and update upgrades in place (same id; origin, nickname, lock and unchanged `rolls` kept). Set "Equipped by" from the scan (it wins; an unpicked Rover never overwrites). Delete the opt-in "Not in this scan" rows (never locked ones). If a row to update has gone since the review, nothing is written. `undoScan` reverts row by row, only rows still exactly as the scan left them; the Inventory page shows the Undo toast.
- **Back to the bag:** a character the scan shows wearing exactly 5 gets any other recorded Echo unequipped. Recording 1 shows Cartethyia with exactly 5. More than 5 is a warning and unequips nothing.
- **Browser** (`scan-fixtures/e2e-rescan.mjs`, recording 1, against `npm run preview`):
  - first scan: 15 added;
  - after making the stored data older (one Echo moved to Jiyan, one taken back to +20 with 4 substats, a stale Echo of the set on Cartethyia), the rescan showed 14 rows already in the inventory and "Apply: update 3";
  - after Apply: the Echo was back on its wearer, the +20 copy was +25 under the same id, and the stale one was unequipped;
  - Undo reverted all three. 0 CSP, 0 exceptions.
- **Tests:** `sync.test.ts` (14), `inventory.test.ts` apply/undo (5), and EchoScanner and Inventory page rescan + Undo flows. This meets the Phase 5 gate ("levelling one Echo shows exactly 1 Upgraded row, and builds still resolve": same id).
- **Not done** (from the Phase 5 list): "Create current-gear builds" from groups of 5 equipped Echoes.

## Status (2026-10-23, later): fewer reviews, 3× faster on filter switches

- **Filter sheet never emitted:** the walk skips samples whose stat block is dark (mean luminance < 75; panels measured 94.6–117.1, blends ≤ 63.2, sheet ≤ 41.4). No PNG encode or OCR runs for them. Recording 2 went from ~145 s to 45–48 s, and the blend rows ("stats not validated", "level not read") are gone.
- **Second frame:** a flagged video row re-reads its segment's last sample (when it's ≥ 0.3 s after the pick) from a second `<video>`, keeping it only if `parseCost` drops. Offline, over 62 panels: wrong fields 2 → 0, and 0 silent in 124 extra reads. In the browser, recording 1 is all Ready in 3/3 runs (the Kerasaur COST miss is fixed), and recording 2 has 2–3 rows read better per run.
- **Browser, 3 runs each:** 0 silent. Recording 2 matched 45/46 truth rows. Its fix rows are 13/19 the unfiltered start (expected); the rest are first frames after the sheet closes (~1–2 per run).
- **OCR workers:** 4 instead of 2 gained only 5–8%: the walk (video decode) is the limit now, so it stays at 2.
- **Console:** tesseract's "Estimating resolution" log is down from 17 to 2 per run (a fixed DPI for the tag crops; tag reads unchanged, 62/62).
- **Next (user, 2026-10-23):** a real batch of 100+ Echoes; then live capture together with an auto-advance helper (no clicking through the grid; plan Phase 6, ToS caveat); then rescan sync, where the scan wins over the app's `equippedTo`, with Undo.

## Status (2026-10-23): second recording, zero silent errors restored

- **Sample:** the user's 117 s, 60 fps, 1914×1072 recording. It has five Sonata filters plus an unfiltered start, with the in-game Filter sheet opened between them: 47 panel visits, 45 distinct Echoes. Hand-read truth for 51 frames (`v2-seg*`) and the filter tag of all 84 truth frames are in `scan-fixtures/truth.json`. A Herdr helper agent did the reading; the parent spot-checked it by eye. Details: `.agents/plans/2026-10-23-scanner-video2/`.
- **It broke the gate:** 3 silent errors. On the first frame after the Filter sheet closes, the sheet's text is still faded over "Equipped by", OCR missed the line, and the Echo imported as unequipped. The review also ticked that copy and unticked the correct repeat.
- **Fixes:**
  - Gold-pixel check in the footer (`pixels.ts`). Measured on 84 panels: unequipped 0 px, equipped ≥ 464 px. Gold with no line read raises an error flag, and pass 5 re-reads the gold box: all 3 faded frames now read their wearer.
  - Same-roll rows that disagree on the wearer both start unticked.
  - Sonata per row from the in-game filter tag (`sonata.ts`; user decision: use the icon only if it can be identified confidently, otherwise the tag). The tag's dark box is found in pixels and read as one line: 62/62 exact. With no tag but the grid bar visible ("Sort by" read on 84/84 frames), no filter is set, and the app's pick is not applied.
  - Panel-less frames (the Filter sheet) stop after pass 1: 137 of 141 sheet frames, and 0 of 84 real panels.
  - The 4-cost Healing Bonus max is 26.4% (in-game, `v2-seg44`), not 26.0%.
  - "Phantom: X" names match X (cosmetic; user-confirmed).
- **Results** (`scan-eval js6`, no set picked, Sonata scored): 1088/1092 fields correct, **0 silent**, 52/84 panels need no review. The other 32: 16 multi-set Echoes with no filter set, 14 approximate names, 3 COST misses, and one each of a missed row, a misread value and a Rover choice. Committed fixtures now hold all 84.
- **Browser (Chromium 155, no set picked, every row compared with truth incl. Sonata, `scan-fixtures/compare-e2e-v3.mjs`):**
  - First recording, 11 runs: 0 silent, 15/15 Echoes in every run, Windward Pilgrimage read from the tag on every row. 12.8–15.4 s with the final build, against 12.7–13.7 s for `3c581c5` on the same day (the machine was slower than on 10-22).
  - Second recording, 8 runs: 0 silent. 43–44 of 46 truth rows matched (a revisited Echo with a different Sonata counts twice). The misses are always flagged: Thousand-Puppet Pavilion's name covered by its art. The three faded frames read their wearer. ~145 s, against 141.5 s for `3c581c5`.
  - **The walk, not OCR, sets the pace there:** while the Filter sheet is open, nearly every 0.1 s sample is a new segment, each PNG-encoded on the main thread, so the walk runs at ~1× real time. The early stop saves OCR work but not wall time. Next: recognise the sheet in the detector and emit nothing for it.
- **Phase 4 correction:** the 2026-10-22 "16 panels, all Ready" below held in 1 of 10 runs. Typically one Kerasaur row carried a benign COST review, and 3 of 10 runs split a Sacerdos into an unticked repeat. Values were correct in all runs.

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
