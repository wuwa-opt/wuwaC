/**
 * Offline game-data sync (reference doc §8.2).
 *
 * Fetches character/weapon/echo data from the encore.moe community API,
 * validates and normalizes it into this project's internal shapes, and
 * writes a versioned JSON snapshot to `src/data/generated/`. That snapshot
 * — not a live API call — is what ships with the app.
 *
 * The fetch + normalize pipeline lives in `src/data/providerSync.ts` and is
 * shared with the in-browser background refresh — this script keeps only the
 * CLI surface (flags, partial carry-over, file write, exit codes).
 *
 * Run manually (game patches ~every 6 weeks; no need for automation yet):
 *   npm run sync                          # everything (~500 requests)
 *   npm run sync -- --chars               # characters only
 *   npm run sync -- --weapons             # weapons only
 *   npm run sync -- --echoes              # echo defs (+ sonata sets) only
 *   npm run sync -- --only Jiyan Verina   # filter by exact name
 *
 * Partial syncs carry untouched categories over from the committed
 * snapshot, so `--echoes` never empties characters/weapons.
 * Echo coverage: cost prefers Handbook intensity with a detail-Rarity
 * fallback ({0:1, 1:3, 2:4, 3:4}, cross-checked against Handbook costs
 * and RandGroupId pool families); main-stat pools are cost-tier pools
 * (placeholders.ts, transcribed from docs/echostats.md) written verbatim —
 * the per-Echo Handbook pool text is unreliable and is not parsed.
 * Fallback records are logged, never silent.
 * Excluded up front (skipped before the detail fetch): `Phantom: ...`
 * shiny variants and unreleased `MonsterInfo_<id>_Name` placeholders —
 * neither is a separately farmable echo (see echoSkipReasonForName).
 *
 * Polite-client rules: sequential requests with a small delay between
 * detail fetches, no refetch loops. Per-record problems skip-and-report
 * (expected gaps like female Rover variants vs unexpected parse failures);
 * unexpected failures still write the partial snapshot but exit non-zero.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  assembleSnapshot,
  createCollectingReporter,
  DETAIL_DELAY_MS,
  fetchGameDataParts,
  fetchJsonFromProvider,
  PROVIDER_API_BASE,
} from '../src/data/providerSync.ts';
import { snapshotSchema, type Snapshot } from '../src/data/schema.ts';

interface SyncFlags {
  chars: boolean;
  weapons: boolean;
  echoes: boolean;
  only: Set<string> | null;
}

function parseFlags(argv: string[]): SyncFlags {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(
      'Usage: npm run sync -- [--chars] [--weapons] [--echoes] [--only Name ...]\n' +
        'No flags syncs everything. --only filters by exact provider name.',
    );
    process.exit(0);
  }
  const onlyIdx = argv.indexOf('--only');
  const only = onlyIdx >= 0 ? new Set(argv.slice(onlyIdx + 1)) : null;
  const anyCategory =
    argv.includes('--chars') || argv.includes('--weapons') || argv.includes('--echoes');
  return {
    chars: argv.includes('--chars') || !anyCategory,
    weapons: argv.includes('--weapons') || !anyCategory,
    echoes: argv.includes('--echoes') || !anyCategory,
    only,
  };
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const fetchedAt = new Date().toISOString();
  console.log(`syncing from ${PROVIDER_API_BASE} at ${fetchedAt}`);

  const { reporter, warnings, skips, fallbacks, failures } = createCollectingReporter({
    onInfo: (message) => console.log(message),
    onWarn: (message) => console.warn(`  warning: ${message}`),
    onProgress: (detailCount) => {
      if (detailCount % 25 === 0) console.log(`  …${detailCount} detail records fetched`);
    },
  });

  const parts = await fetchGameDataParts({
    fetchJson: fetchJsonFromProvider,
    fetchedAt,
    detailDelayMs: DETAIL_DELAY_MS,
    categories: { chars: flags.chars, weapons: flags.weapons, echoes: flags.echoes },
    only: flags.only,
    reporter,
  });

  // Partial syncs (--echoes etc.) carry the untouched categories over from
  // the committed snapshot instead of writing empty arrays (the schema
  // requires non-empty character/weapon lists).
  let charactersOut = parts.characters;
  let weaponsOut = parts.weapons;
  if (!flags.chars || !flags.weapons) {
    let prev: Snapshot | null;
    try {
      prev = snapshotSchema.parse(JSON.parse(readFileSync('src/data/generated/snapshot.json', 'utf8')));
    } catch {
      prev = null;
    }
    if (!flags.chars) {
      if (!prev) throw new Error('no committed snapshot to carry characters over from — run a full sync first');
      charactersOut = prev.characters;
    }
    if (!flags.weapons) {
      if (!prev) throw new Error('no committed snapshot to carry weapons over from — run a full sync first');
      weaponsOut = prev.weapons;
    }
  }

  const snapshot: Snapshot = assembleSnapshot(
    {
      characters: charactersOut,
      weapons: weaponsOut,
      sonataSets: parts.sonataSets,
      echoDefs: parts.echoDefs,
    },
    fetchedAt,
  );
  writeFileSync('src/data/generated/snapshot.json', `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(`wrote src/data/generated/snapshot.json (${charactersOut.length} characters, ${weaponsOut.length} weapons, ${parts.sonataSets.length} sonata sets, ${parts.echoDefs.length} echo defs)`);

  if (warnings.length > 0) console.log(`${warnings.length} warning(s)`);
  if (fallbacks.length > 0) {
    const byReason = new Map<string, string[]>();
    for (const fallback of fallbacks) {
      const list = byReason.get(fallback.reason) ?? [];
      list.push(fallback.name);
      byReason.set(fallback.reason, list);
    }
    console.log(`${fallbacks.length} fallback record(s) (auditable, included anyway):`);
    for (const [reason, names] of byReason) {
      console.log(`  - ${reason}: ${names.length} (e.g. ${names.slice(0, 3).join(', ')})`);
    }
  }
  if (skips.length > 0) {
    const byReason = new Map<string, string[]>();
    for (const skip of skips) {
      const list = byReason.get(skip.reason) ?? [];
      list.push(skip.name);
      byReason.set(skip.reason, list);
    }
    console.log(`${skips.length} expected skip(s):`);
    for (const [reason, names] of byReason) {
      console.log(`  - ${reason}: ${names.length} (e.g. ${names.slice(0, 3).join(', ')})`);
    }
  }
  if (failures.length > 0) {
    console.error(`${failures.length} unexpected failure(s):`);
    for (const failure of failures) console.error(`  - ${failure.name}: ${failure.error}`);
    process.exit(1);
  }
  console.log(failures.length === 0 && skips.length === 0 && warnings.length === 0 ? 'clean sync' : 'sync complete');
}

main().catch((err) => {
  console.error(`sync failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
