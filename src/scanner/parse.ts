import type { CharacterData, EchoDefData, Snapshot, StatKey } from '../data/schema.ts';
import { canonical, matchVocab, type MatchResult, type VocabEntry } from './match.ts';
import { readFilterTag, resolveSonata } from './sonata.ts';
import {
  parseNumberToken,
  readPrimaryMain,
  readSecondaryMain,
  readSubstat,
  type EchoContext,
  type StatFamily,
  type ValueRead,
} from './values.ts';

/**
 * Scanner layer: turn OCR words from the Echo Management detail panel
 * into an Echo draft plus review flags. Pure — input is engine-agnostic
 * words with pixel bboxes, output is data.
 *
 * Fields are located by CONTENT, not fixed pixel rows: screenshots arrive
 * at varying sizes/crops and long stat labels wrap onto two lines. Words
 * are regrouped into visual rows by vertical overlap (so it does not
 * matter how the OCR engine segmented lines), then:
 *   name    = best Echo-name match among rows above `COST n`
 *   level   = `+NN` above `COST n`
 *   cost    = `COST n`
 *   stats   = rows below COST ending in a number: 1st = primary main,
 *             2nd = fixed secondary, rest = substats (on-screen order)
 *   equipped = `Equipped by <character>`, backed by a gold-pixel check
 *             (`PanelExtras.equipLine`) so a missed line is flagged
 * The Sonata set is NOT on the panel as text: it comes from the in-game
 * filter tag beside the grid, or the set picked in the app (sonata.ts).
 * Rarity comes from the scan batch (the user mirrors the in-game filter).
 *
 * Contract: nothing is silently corrected. Every field that is not an
 * exact read carries a flag; `severity: 'error'` means no draft can be
 * produced until the user fixes it.
 */

export interface OcrBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OcrWord {
  text: string;
  bbox: OcrBox;
  /** Engine confidence 0–100 (informational; validation decides). */
  confidence?: number;
}

/** Per-batch context mirrored from the in-game filters. */
export interface ScanBatch {
  /** The set picked in the app; null = read it from the game (sonata.ts). */
  sonataId: string | null;
  rarity: number;
}

/** What the pipeline saw outside the panel passes. */
export interface PanelExtras {
  /** Words read off the filter tag, or off the grid bar when no tag was seen (pipeline `readTag`); absent = not read. */
  tag?: readonly OcrWord[];
  /**
   * Box of the gold "Equipped by" line found in pixels (`equipLineBox`),
   * null = no gold line; absent = pixels not checked.
   */
  equipLine?: OcrBox | null;
}

export type ScanField = 'name' | 'level' | 'cost' | 'sonata' | 'main' | 'second' | 'substats' | `sub${1 | 2 | 3 | 4 | 5}` | 'equipped';

export interface ScanFlag {
  field: ScanField;
  /** `review` = draft usable but a human should glance; `error` = blocks import. */
  severity: 'review' | 'error';
  message: string;
  /**
   * The on-screen row the flag is about (frame pixels), when there is one.
   * The pipeline re-reads exactly these rows in single-line mode.
   */
  row?: FlagRow;
}

export interface FlagRow {
  bbox: OcrBox;
  /** Text lines inside the bbox (2 for a wrapped stat label). */
  lines: number;
}

export interface ScannedStat {
  stat: StatKey;
  value: number;
}

/** Everything read off one panel, fields null when unreadable. */
export interface ScannedEcho {
  echoDefId: string | null;
  cost: 1 | 3 | 4 | null;
  level: number | null;
  rarity: number;
  /** Null when it could not be decided (an error flag says why). */
  sonataId: string | null;
  mainStat: ScannedStat | null;
  secondMainStat: ScannedStat | null;
  /** On-screen order; null = a row that was read but could not be resolved. */
  substats: (ScannedStat | null)[];
  equippedTo: string | null;
  /** Set when "Equipped by X" names several characters (e.g. Rover). */
  equippedCandidates?: string[];
}

export interface PanelParse {
  echo: ScannedEcho;
  flags: ScanFlag[];
}

// --- Rows ---------------------------------------------------------------------

export interface OcrRow {
  words: OcrWord[];
  text: string;
  bbox: OcrBox;
}

function height(b: OcrBox): number {
  return b.y1 - b.y0;
}

function centerY(b: OcrBox): number {
  return (b.y0 + b.y1) / 2;
}

/**
 * Group words into visual rows. A word joins the row whose median center
 * is within 0.6× the smaller of (word height, row median height) — using
 * medians and the SMALLER height means one tall junk glyph from the Echo
 * art cannot stretch a row until it swallows the next text line (seen in
 * real fixtures: "+25" and "COST 3" merged). Rows are returned top to
 * bottom, words left to right.
 */
export function groupRows(words: readonly OcrWord[]): OcrRow[] {
  const sorted = words.filter((w) => w.text.trim() !== '').slice().sort((a, b) => centerY(a.bbox) - centerY(b.bbox));
  const rows: OcrWord[][] = [];
  const median = (values: number[]): number => {
    const v = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(v.length / 2);
    return v.length % 2 === 1 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  };
  for (const word of sorted) {
    const c = centerY(word.bbox);
    const h = height(word.bbox);
    const row = rows.find((r) => {
      const rc = median(r.map((w) => centerY(w.bbox)));
      const rh = median(r.map((w) => height(w.bbox)));
      return Math.abs(rc - c) <= 0.6 * Math.min(h, rh);
    });
    if (row === undefined) rows.push([word]);
    else row.push(word);
  }
  return rows
    .map((r) => {
      const ordered = r.slice().sort((a, b) => a.bbox.x0 - b.bbox.x0);
      const bbox = {
        x0: Math.min(...r.map((w) => w.bbox.x0)),
        y0: median(r.map((w) => w.bbox.y0)),
        x1: Math.max(...r.map((w) => w.bbox.x1)),
        y1: median(r.map((w) => w.bbox.y1)),
      };
      return { words: ordered, text: ordered.map((w) => w.text.trim()).join(' '), bbox };
    })
    .sort((a, b) => centerY(a.bbox) - centerY(b.bbox));
}

/**
 * The text line of a header/footer row, for re-reading it. Echo art
 * bleeds into these rows and inflates word boxes downward ("Fledrel=gis"
 * spanned 64 px for ~30 px of text), but the text itself is top-aligned:
 * take the words' common top edge and the SMALLEST wordy box height.
 */
export function textLineBox(row: OcrRow): OcrBox {
  const wordy = row.words.filter((w) => /[a-z0-9]{2,}/i.test(w.text));
  const words = wordy.length > 0 ? wordy : row.words;
  const y0 = Math.min(...words.map((w) => w.bbox.y0));
  const h = Math.min(...words.map((w) => height(w.bbox)));
  return { x0: row.bbox.x0, y0, x1: row.bbox.x1, y1: y0 + h };
}

// --- Vocabularies --------------------------------------------------------------

/** On-screen stat labels (English client) -> stat family. */
export const STAT_LABELS: readonly VocabEntry<StatFamily>[] = [
  { text: 'HP', value: { kind: 'pair', flat: 'hp', pct: 'hpPct' } },
  { text: 'ATK', value: { kind: 'pair', flat: 'atk', pct: 'atkPct' } },
  { text: 'DEF', value: { kind: 'pair', flat: 'def', pct: 'defPct' } },
  { text: 'Crit. Rate', value: { kind: 'single', stat: 'critRate' } },
  { text: 'Crit. DMG', value: { kind: 'single', stat: 'critDmg' } },
  { text: 'Energy Regen', value: { kind: 'single', stat: 'energyRegen' } },
  { text: 'Healing Bonus', value: { kind: 'single', stat: 'healingBonus' } },
  { text: 'Glacio DMG Bonus', value: { kind: 'single', stat: 'dmgBonus:Glacio' } },
  { text: 'Fusion DMG Bonus', value: { kind: 'single', stat: 'dmgBonus:Fusion' } },
  { text: 'Electro DMG Bonus', value: { kind: 'single', stat: 'dmgBonus:Electro' } },
  { text: 'Aero DMG Bonus', value: { kind: 'single', stat: 'dmgBonus:Aero' } },
  { text: 'Spectro DMG Bonus', value: { kind: 'single', stat: 'dmgBonus:Spectro' } },
  { text: 'Havoc DMG Bonus', value: { kind: 'single', stat: 'dmgBonus:Havoc' } },
  { text: 'Basic Attack DMG Bonus', value: { kind: 'single', stat: 'dmgBonus:basic' } },
  { text: 'Heavy Attack DMG Bonus', value: { kind: 'single', stat: 'dmgBonus:heavy' } },
  { text: 'Resonance Skill DMG Bonus', value: { kind: 'single', stat: 'dmgBonus:skill' } },
  { text: 'Resonance Liberation DMG Bonus', value: { kind: 'single', stat: 'dmgBonus:liberation' } },
];

/** Short labels need a tighter fuzzy bound: one wrong letter in "HP" is 50%. */
const LABEL_MATCH = { maxDistance: 0.25, minMargin: 0.1 };

type Scored<T> = { value: T; text: string; distance: number; exact: boolean };

function scored<T>(m: MatchResult<T>): Scored<T> | null {
  if (m.kind === 'exact') return { value: m.value, text: m.text, distance: 0, exact: true };
  if (m.kind === 'fuzzy') return { value: m.value, text: m.text, distance: m.distance, exact: false };
  return null;
}

/**
 * Best vocab match over every contiguous word span of `words`. Stat
 * icons OCR as junk glyphs ("X%", "#¢", even a digit) at the start of a
 * row, and Echo art bleeds junk after a name — trying spans skips both
 * without guessing which words are junk. An icon can also fuse onto the
 * first word of a label ("WATK" for the crossed-swords ATK icon), so a
 * span's first word is also tried with 1–2 leading characters removed;
 * that only ever helps when the remainder is an exact vocab label.
 */
function bestSpanMatch<T>(words: readonly string[], vocab: readonly VocabEntry<T>[], options = LABEL_MATCH): Scored<T> | null {
  let best: Scored<T> | null = null;
  const consider = (m: Scored<T> | null): void => {
    if (m === null) return;
    // Prefer smaller distance; on ties prefer the longer vocab text (more evidence).
    if (best === null || m.distance < best.distance || (m.distance === best.distance && m.text.length > best.text.length)) {
      best = m;
    }
  };
  for (let i = 0; i < words.length; i++) {
    for (let j = i + 1; j <= words.length; j++) {
      const span = words.slice(i, j);
      consider(scored(matchVocab(span.join(' '), vocab, options)));
      for (const cut of [1, 2]) {
        const head = span[0].slice(cut);
        if (canonical(head).length < 2) continue;
        const m = matchVocab([head, ...span.slice(1)].join(' '), vocab, options);
        if (m.kind === 'exact') consider(scored(m));
      }
    }
  }
  return best;
}

// --- Stat rows -------------------------------------------------------------------

interface StatRow {
  labelWords: string[];
  valueText: string;
  bbox: OcrBox;
  lines: number;
}

/** Trailing value token(s): "10.8%", or "10.8" + "%" split by the engine. */
function splitValue(row: OcrRow): StatRow | null {
  const texts = row.words.map((w) => w.text.trim().replace(/[.:;,]+$/, ''));
  if (texts.length < 2) return null;
  let valueText = texts[texts.length - 1];
  let labelEnd = texts.length - 1;
  if (valueText === '%' && texts.length >= 3) {
    valueText = `${texts[texts.length - 2]}%`;
    labelEnd = texts.length - 2;
  }
  if (parseNumberToken(valueText) === null) return null;
  return { labelWords: texts.slice(0, labelEnd), valueText, bbox: row.bbox, lines: 1 };
}

/** A label-only row directly under a stat row is its wrapped second line ("Bonus", "DMG Bonus"). */
function isWrapContinuation(row: OcrRow, prev: StatRow): boolean {
  if (splitValue(row) !== null) return false;
  const gap = row.bbox.y0 - prev.bbox.y1;
  const lineHeight = height(prev.bbox);
  const words = canonical(row.text).split(' ');
  return gap < lineHeight && words.length <= 3 && words.some((w) => w === 'bonus' || w === 'dmg');
}

// --- Main parse --------------------------------------------------------------------

const STOP_RE = /echo\s*skill|equipped\s*by/i;

export function parsePanel(words: readonly OcrWord[], batch: ScanBatch, snapshot: Snapshot, extras: PanelExtras = {}): PanelParse {
  const rows = groupRows(words);
  const flags: ScanFlag[] = [];
  const flag = (field: ScanField, severity: ScanFlag['severity'], message: string, row?: FlagRow): void => {
    flags.push(row === undefined ? { field, severity, message } : { field, severity, message, row });
  };

  // COST anchors the layout.
  const costIndex = rows.findIndex((r) => /\bcost\s*[134]\b/.test(canonical(r.text)));
  const costMatch = costIndex >= 0 ? /\bcost\s*([134])\b/.exec(canonical(rows[costIndex].text)) : null;
  const header = costIndex >= 0 ? rows.slice(0, costIndex) : rows;

  // Name.
  // "Phantom: X" is a cosmetic variant of X (same Echo, same stats; user-confirmed 2026-10-23).
  const nameVocab: VocabEntry<EchoDefData>[] = snapshot.echoDefs.flatMap((d) => [
    { text: d.name, value: d },
    { text: `${PHANTOM_PREFIX}${d.name}`, value: d },
  ]);
  let def: EchoDefData | null = null;
  let bestName: Scored<EchoDefData> | null = null;
  let nameIndex = -1;
  for (const [i, row] of header.entries()) {
    const m = bestSpanMatch(row.words.map((w) => w.text), nameVocab, { maxDistance: 0.2, minMargin: 0.08 });
    if (m !== null && (bestName === null || m.distance < bestName.distance)) {
      bestName = m;
      nameIndex = i;
    }
  }
  if (bestName === null) {
    // Echo art can swallow the end of a long name ("Nightmare: Dwarf"
    // for "Nightmare: Dwarf Cassowary"). A long read that is the prefix
    // of exactly ONE name is offered for review — never accepted silently.
    for (const row of header) {
      const prefix = uniquePrefixMatch(row.words.map((w) => w.text), snapshot.echoDefs);
      if (prefix !== null) {
        bestName = { value: prefix, text: prefix.name, distance: 1, exact: false };
        nameIndex = header.indexOf(row);
        break;
      }
    }
  }
  if (bestName === null) {
    // The topmost wordy header row is where the name sits.
    const nameRow = header.find((r) => /[a-z]{4,}/i.test(r.text));
    flag('name', 'error', 'Echo name not recognized', nameRow === undefined ? undefined : { bbox: textLineBox(nameRow), lines: 1 });
  } else {
    def = bestName.value;
    if (!bestName.exact) flag('name', 'review', `name read approximately as ${def.name}`, { bbox: textLineBox(header[nameIndex]), lines: 1 });
  }

  // Cost.
  let cost: 1 | 3 | 4 | null = costMatch ? (Number(costMatch[1]) as 1 | 3 | 4) : null;
  if (cost === null) {
    if (def !== null) {
      cost = def.cost;
      flag('cost', 'review', `COST not read; using ${def.name}'s cost ${def.cost}`);
    } else {
      flag('cost', 'error', 'COST not read');
    }
  } else if (def !== null && def.cost !== cost) {
    flag('cost', 'error', `read COST ${cost}, but ${def.name} is ${def.cost}-cost`);
  }

  // Level: "+25" between the name and COST (the HUD above has a "+"
  // button). The COST row itself is searched too, left of "COST", in
  // case the engine put both on one line.
  let level: number | null = null;
  const levelRows = [
    ...header.slice(nameIndex + 1).map((r) => r.text),
    ...(costIndex >= 0 ? [rows[costIndex].text.split(/c\s*o\s*s\s*t/i)[0]] : []),
  ];
  for (const text of levelRows) {
    const m = /[+＋]\s?(\d{1,2})\b/.exec(text);
    if (m !== null && Number(m[1]) <= 25) {
      level = Number(m[1]);
      break;
    }
  }
  if (level === null) flag('level', 'error', 'level (+N) not read');

  // Sonata: the in-game filter tag, else the set picked in the app (sonata.ts).
  const tag = extras.tag === undefined ? { kind: 'none' as const, gridBar: false } : readFilterTag(extras.tag, snapshot.sonataSets);
  const sonata = resolveSonata(def, tag, batch.sonataId, snapshot.sonataSets);
  for (const f of sonata.flags) flag('sonata', f.severity, f.message);

  // Stat rows. The block starts at the first row with a recognizable
  // stat label: junk between COST and the stats (the lock/discard icon
  // row OCRs as e.g. "»A © 08") must not shift every stat down a slot.
  // Once the block has started, an unrecognized row is KEPT so it
  // surfaces as an error instead of silently vanishing.
  const statRows: StatRow[] = [];
  for (const row of rows.slice(costIndex + 1)) {
    if (STOP_RE.test(row.text)) break;
    const prev = statRows[statRows.length - 1];
    const split = splitValue(row);
    if (split !== null && (prev !== undefined || bestSpanMatch(split.labelWords, STAT_LABELS) !== null)) {
      statRows.push(split);
    } else if (prev !== undefined && isWrapContinuation(row, prev)) {
      prev.labelWords.push(...row.words.map((w) => w.text));
      prev.bbox = { ...prev.bbox, y1: row.bbox.y1 };
      prev.lines += 1;
    } else if (prev !== undefined && bestSpanMatch(row.words.map((w) => w.text), STAT_LABELS) !== null) {
      // A stat label whose value was not read: keep the row so it errors
      // (and gets re-read) instead of silently shortening the Echo.
      statRows.push({ labelWords: row.words.map((w) => w.text), valueText: '', bbox: row.bbox, lines: 1 });
    }
  }

  const ctx: EchoContext | null = cost !== null && level !== null ? { cost, level, rarity: batch.rarity } : null;
  const resolve = (row: StatRow | undefined, field: ScanField, reader: (f: StatFamily, t: NonNullable<ReturnType<typeof parseNumberToken>>) => ValueRead): ScannedStat | null => {
    if (row === undefined) {
      flag(field, 'error', 'row not read');
      return null;
    }
    const at: FlagRow = { bbox: row.bbox, lines: row.lines };
    const label = bestSpanMatch(row.labelWords, STAT_LABELS);
    if (label === null) {
      flag(field, 'error', `stat label "${row.labelWords.join(' ')}" not recognized`, at);
      return null;
    }
    const token = parseNumberToken(row.valueText);
    if (token === null) {
      flag(field, 'error', row.valueText === '' ? `${label.text} value not read` : `value "${row.valueText}" not readable`, at);
      return null;
    }
    const read = reader(label.value, token);
    if (read.status === 'invalid') {
      flag(field, 'error', read.note, at);
      return null;
    }
    if (!label.exact) flag(field, 'review', `label read approximately as ${label.text}`, at);
    if (read.status !== 'exact') flag(field, 'review', read.note ?? read.status, at);
    return { stat: read.stat, value: read.value };
  };

  let mainStat: ScannedStat | null = null;
  let secondMainStat: ScannedStat | null = null;
  let substats: (ScannedStat | null)[] = [];
  if (ctx === null) {
    for (const field of ['main', 'second', 'substats'] as const) {
      flag(field, 'error', 'stats not validated: cost/level unknown');
    }
  } else {
    mainStat = resolve(statRows[0], 'main', (f, t) => readPrimaryMain(f, t, ctx));
    if (mainStat !== null && def !== null && !def.allowedMainStats.includes(mainStat.stat)) {
      flag('main', 'error', `${def.name} cannot roll ${mainStat.stat} as a main stat`);
    }
    secondMainStat = resolve(statRows[1], 'second', (f, t) => readSecondaryMain(f, t, ctx));
    substats = statRows.slice(2).map((row, i) => resolve(row, `sub${(i + 1) as 1 | 2 | 3 | 4 | 5}`, readSubstat));
    if (substats.length > 5) {
      flag('substats', 'error', `read ${substats.length} substat rows; an Echo has at most 5`);
    }
    const seen = substats.filter((s): s is ScannedStat => s !== null).map((s) => s.stat);
    if (new Set(seen).size !== seen.length) flag('substats', 'error', 'the same substat was read twice');
    const unlocked = Math.floor(ctx.level / 5);
    if (substats.length < Math.min(unlocked, 5)) {
      flag('substats', 'review', `read ${substats.length} substats; a +${ctx.level} Echo can have ${Math.min(unlocked, 5)} — check none was missed`);
    }
  }

  // Equipped by.
  let equippedTo: string | null = null;
  let equippedCandidates: string[] | undefined;
  const everyone = (): string[] =>
    snapshot.characters
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => c.id);
  const equippedRow = rows.find((r) => /equipped\s*by/i.test(r.text));
  if (equippedRow !== undefined) {
    const who = equippedRow.text.replace(/^.*?equipped\s*by\s*/i, '');
    const resolved = resolveCharacter(who, snapshot.characters);
    const at: FlagRow = { bbox: textLineBox(equippedRow), lines: 1 };
    if (resolved.kind === 'one') {
      equippedTo = resolved.id;
      if (!resolved.exact) flag('equipped', 'review', `equipped character read approximately as ${resolved.name}`, at);
    } else if (resolved.kind === 'many') {
      equippedCandidates = resolved.ids;
      // A real choice (e.g. "Rover"), not a misread: no row to re-read.
      flag('equipped', 'review', `"${who.trim()}" matches ${resolved.ids.length} characters — pick one`);
    } else {
      // Importing it as unequipped would be a wrong value: the user picks.
      equippedCandidates = everyone();
      flag('equipped', 'error', `equipped character "${who.trim()}" not recognized — pick who wears it`, at);
    }
  } else if (extras.equipLine != null) {
    // Gold text where no line was read (e.g. the Filter sheet still fading
    // out over it): the Echo is equipped, so "unequipped" would be wrong.
    equippedCandidates = everyone();
    flag('equipped', 'error', 'an "Equipped by" line is visible but was not read — pick who wears it', { bbox: extras.equipLine, lines: 1 });
  }

  return {
    echo: {
      echoDefId: def?.id ?? null,
      cost,
      level,
      rarity: batch.rarity,
      sonataId: sonata.sonataId,
      mainStat,
      secondMainStat,
      substats,
      equippedTo,
      ...(equippedCandidates ? { equippedCandidates } : {}),
    },
    flags,
  };
}

/** Cosmetic variant prefix on some Echo names ("Phantom: Forbidden Bastion"). */
const PHANTOM_PREFIX = 'Phantom: ';

/**
 * A frame shows no Echo panel when the parser recognized none of name,
 * cost and main stat (the in-game Filter sheet, another menu, the desktop).
 */
export function isPanelless(parse: PanelParse): boolean {
  return parse.echo.echoDefId === null && parse.echo.cost === null && parse.echo.mainStat === null;
}

/** Minimum canonical length for a prefix read to count as evidence. */
const MIN_PREFIX = 10;

function uniquePrefixMatch(words: readonly string[], defs: readonly EchoDefData[]): EchoDefData | null {
  for (let i = 0; i < words.length; i++) {
    for (let j = words.length; j > i; j--) {
      const needle = canonical(words.slice(i, j).join(' '));
      if (needle.length < MIN_PREFIX) break;
      const hits = defs.filter((d) => canonical(d.name).startsWith(needle));
      if (hits.length === 1) return hits[0];
    }
  }
  return null;
}

type CharacterResolution =
  | { kind: 'one'; id: string; name: string; exact: boolean }
  | { kind: 'many'; ids: string[] }
  | { kind: 'none' };

/**
 * "Equipped by <name>". The game shows the bare family name for some
 * characters ("Rover" for every Rover attribute), so a read that is the
 * prefix of several `"<name>: <variant>"` characters is reported as a
 * choice instead of a fuzzy pick.
 */
export function resolveCharacter(text: string, characters: readonly CharacterData[]): CharacterResolution {
  const needle = canonical(text);
  if (needle === '') return { kind: 'none' };
  const vocab = characters.map((c) => ({ text: c.name, value: c }));
  const m = matchVocab(text, vocab, { maxDistance: 0.2, minMargin: 0.08 });
  if (m.kind === 'exact' || m.kind === 'fuzzy') {
    return { kind: 'one', id: m.value.id, name: m.value.name, exact: m.kind === 'exact' };
  }
  const family = characters.filter((c) => canonical(c.name).startsWith(`${needle} `));
  if (family.length === 1) return { kind: 'one', id: family[0].id, name: family[0].name, exact: false };
  if (family.length > 1) return { kind: 'many', ids: family.map((c) => c.id) };
  if (m.kind === 'ambiguous') return { kind: 'many', ids: m.candidates.map((c) => c.value.id) };
  return { kind: 'none' };
}
