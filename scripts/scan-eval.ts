/**
 * Echo-scanner Phase 0 evaluator (manual, NOT a unit test). Scores
 * `parsePanel` over OCR word dumps against hand-read ground truth in the
 * gitignored `scan-fixtures/truth.json`.
 *
 * The gate is SILENT errors: a field whose value is wrong while carrying
 * no flag. Flagged fields cost the user a glance; silent ones corrupt the
 * inventory.
 *
 * Inputs (one per fixture, by basename):
 *   - tesseract CLI TSV:   <dir>/<name>.<variant>.tsv
 *   - tesseract.js dumps:  scan-fixtures/ocr/<name>.<variant>.json
 *     ({ words, tag?, equipLine? } — tag/equipLine from scan-spike.ts)
 *
 * The Sonata is scored as the app reads it with no set picked: the truth
 * is the in-game filter tag seen in the image (`filterTag`), else the one
 * set the Echo can roll, else unknown (the parse must leave it null).
 *
 * Run: npx tsx scripts/scan-eval.ts <dir-or-ocr-folder> <variant> [-v] [--prefix p]
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { snapshotSchema, type StatKey } from '../src/data/schema.ts';
import { parsePanel, type OcrBox, type OcrWord, type PanelExtras, type ScanField } from '../src/scanner/parse.ts';

interface TruthRow {
  name: string;
  level: number;
  cost: number;
  main: [string, string][];
  subs: [string, string][];
  equippedBy: string | null;
  /** Text of the in-game Sonata filter tag in the image, null = none visible. */
  filterTag?: string | null;
}

/** Independent of the parser's vocabulary on purpose (truth must not reuse code under test). */
const TRUTH_STATS: Record<string, [StatKey, StatKey]> = {
  HP: ['hp', 'hpPct'],
  ATK: ['atk', 'atkPct'],
  DEF: ['def', 'defPct'],
  'Crit. Rate': ['critRate', 'critRate'],
  'Crit. DMG': ['critDmg', 'critDmg'],
  'Energy Regen': ['energyRegen', 'energyRegen'],
  'Healing Bonus': ['healingBonus', 'healingBonus'],
  'Glacio DMG Bonus': ['dmgBonus:Glacio', 'dmgBonus:Glacio'],
  'Fusion DMG Bonus': ['dmgBonus:Fusion', 'dmgBonus:Fusion'],
  'Electro DMG Bonus': ['dmgBonus:Electro', 'dmgBonus:Electro'],
  'Aero DMG Bonus': ['dmgBonus:Aero', 'dmgBonus:Aero'],
  'Havoc DMG Bonus': ['dmgBonus:Havoc', 'dmgBonus:Havoc'],
  'Basic Attack DMG Bonus': ['dmgBonus:basic', 'dmgBonus:basic'],
  'Heavy Attack DMG Bonus': ['dmgBonus:heavy', 'dmgBonus:heavy'],
  'Resonance Skill DMG Bonus': ['dmgBonus:skill', 'dmgBonus:skill'],
  'Resonance Liberation DMG Bonus': ['dmgBonus:liberation', 'dmgBonus:liberation'],
};

function truthStat([label, text]: [string, string]): { stat: StatKey; value: number } {
  const pair = TRUTH_STATS[label];
  if (!pair) throw new Error(`truth label ${label} unmapped`);
  const pct = text.endsWith('%');
  const num = Number(text.replace('%', ''));
  return pct ? { stat: pair[1], value: Math.round(num * 10) / 1000 } : { stat: pair[0], value: num };
}

function readWords(source: string, name: string, variant: string): { words: OcrWord[]; extras: PanelExtras } | null {
  const tsv = join(source, `${name}.${variant}.tsv`);
  if (existsSync(tsv)) {
    const words = readFileSync(tsv, 'utf8')
      .split('\n')
      .slice(1)
      .map((line) => line.split('\t'))
      .filter((c) => c.length >= 12 && c[0] === '5' && c[11].trim() !== '')
      .map((c) => {
        const [left, top, w, h] = [c[6], c[7], c[8], c[9]].map(Number);
        return { text: c[11], confidence: Number(c[10]), bbox: { x0: left, y0: top, x1: left + w, y1: top + h } };
      });
    return { words, extras: {} };
  }
  const json = join(source, `${name}.${variant}.json`);
  if (!existsSync(json)) return null;
  const dump = JSON.parse(readFileSync(json, 'utf8')) as { words: OcrWord[]; tag?: OcrWord[] | null; equipLine?: OcrBox | null };
  const extras: PanelExtras = {};
  if (dump.tag != null) extras.tag = dump.tag;
  if (dump.equipLine !== undefined) extras.equipLine = dump.equipLine;
  return { words: dump.words, extras };
}

function main(): void {
  const [source = 'scan-fixtures/ocr', variant = 'psm11'] = process.argv.slice(2);
  const truth = JSON.parse(readFileSync('scan-fixtures/truth.json', 'utf8')) as Record<string, TruthRow | string>;
  const snapshot = snapshotSchema.parse(JSON.parse(readFileSync('src/data/generated/snapshot.json', 'utf8')));
  let fields = 0;
  let correct = 0;
  let flaggedWrong = 0;
  let flaggedRight = 0;
  let silent = 0;
  let panels = 0;
  let clean = 0;
  const verbose = process.argv.includes('-v');
  const prefixAt = process.argv.indexOf('--prefix');
  const prefix = prefixAt >= 0 ? process.argv[prefixAt + 1] : '';

  for (const [name, row] of Object.entries(truth)) {
    if (typeof row === 'string' || !name.startsWith(prefix)) continue;
    const read = readWords(source, name, variant);
    if (read === null) {
      console.log(`${name}: no OCR input`);
      continue;
    }
    // "Phantom: X" is the cosmetic variant of X (user-confirmed 2026-10-23).
    const baseName = row.name.replace(/^Phantom: /, '');
    const def = snapshot.echoDefs.find((d) => d.name === baseName);
    const tagSet = row.filterTag == null ? null : snapshot.sonataSets.find((s) => s.name === row.filterTag);
    if (tagSet === undefined) throw new Error(`truth filterTag ${row.filterTag} unmapped`);
    const expectSonata = tagSet?.id ?? (def?.sonataIds.length === 1 ? def.sonataIds[0] : null);
    const { echo, flags } = parsePanel(read.words, { sonataId: null, rarity: 5 }, snapshot, read.extras);
    panels++;
    if (flags.length === 0) clean++;
    const flaggedFields = new Set<ScanField>(flags.map((f) => f.field));
    const expectEquip = row.equippedBy === null ? null : snapshot.characters.find((c) => c.name === row.equippedBy)?.id ?? `ambiguous:${row.equippedBy}`;
    const subs = row.subs.map(truthStat);
    const checks: [ScanField, boolean][] = [
      ['name', echo.echoDefId === def?.id],
      ['level', echo.level === row.level],
      ['cost', echo.cost === row.cost],
      ['main', JSON.stringify(echo.mainStat) === JSON.stringify(truthStat(row.main[0]))],
      ['second', JSON.stringify(echo.secondMainStat) === JSON.stringify(truthStat(row.main[1]))],
      ...subs.map((s, i): [ScanField, boolean] => [`sub${(i + 1) as 1 | 2 | 3 | 4 | 5}`, JSON.stringify(echo.substats[i] ?? null) === JSON.stringify(s)]),
      ['substats', echo.substats.length === subs.length],
      ['equipped', expectEquip?.startsWith('ambiguous:') ? (echo.equippedCandidates?.length ?? 0) > 1 : echo.equippedTo === expectEquip],
      ['sonata', echo.sonataId === expectSonata],
    ];
    const problems: string[] = [];
    for (const [field, ok] of checks) {
      fields++;
      const isFlagged = flaggedFields.has(field) || (field.startsWith('sub') && flaggedFields.has('substats'));
      if (ok) correct++;
      if (ok && isFlagged) flaggedRight++;
      if (!ok && isFlagged) flaggedWrong++;
      if (!ok && !isFlagged) {
        silent++;
        problems.push(`SILENT ${field}`);
      } else if (!ok) {
        problems.push(`flagged-wrong ${field}`);
      }
    }
    console.log(`${name.replace(/^screenshot-2026-/, '').padEnd(18)} ${row.name.padEnd(36)} ${problems.length === 0 ? 'ok' : problems.join(', ')}${flags.length ? `  [${flags.length} flags]` : ''}`);
    if (verbose && (problems.length > 0 || flags.length > 0)) {
      for (const f of flags) console.log(`      ${f.severity} ${f.field}: ${f.message}`);
      if (problems.some((p) => p.startsWith('SILENT'))) console.log('      parsed:', JSON.stringify(echo));
    }
  }
  console.log(`\n${variant}: ${correct}/${fields} correct, ${flaggedWrong} wrong-but-flagged, ${flaggedRight} right-but-flagged, SILENT ERRORS: ${silent}`);
  console.log(`${clean}/${panels} panels need no review`);
}

main();
