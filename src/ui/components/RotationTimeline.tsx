import { useState, type FormEvent } from 'react';
import { BUFF_PRESETS, isAutoApplied, resolvePresetMods, type BuffPreset } from '../../data/buffPresets.ts';
import { attributeSchema, statKeySchema, type Attribute, type CharacterData, type StatKey } from '../../data/schema.ts';
import type { EchoSkillHit } from '../../data/echoSkills.ts';
import {
  characterResonanceModes,
  characterStatusBlocks,
  characterTuneRuptureResponses,
  characterUsesHavocBane,
  characterUsesTuneStrain,
  isBuffOnlySkill,
  isParameterMotionRow,
  type ResonanceMode,
} from '../../domain/characterMods.ts';
import { resolveMotion } from '../../domain/damage.ts';
import { JIYAN_OUTRO_LANCE_MV } from '../../domain/jiyan.ts';
import { maxStatusStacks, negativeStatusDef } from '../../domain/negativeStatus.ts';
import type { ActionBlock, BlockResult, RotationBuff } from '../../domain/rotation.ts';
import { blockStartTimes, buffAppliesAt, isBlockStale } from '../../domain/rotation.ts';
import { isPercentStat, parseDisplayValue, RESONANCE_MODE_LABELS, statLabel, toDisplayValue } from '../format.ts';
import { btnDangerGhost, btnGhost, btnOutline, btnSm, inputClass, labelClass } from './classes.ts';
import { Window } from './ui.tsx';
import { AnimatedNumber, DeltaChip, ScoreBar } from './feedback.tsx';

type KitStatePatch = Partial<
  Pick<
    ActionBlock,
    | 'targetHavocBaneStacks'
    | 'blazesConsumed'
    | 'nightfallBlazes'
    | 'ringsConsumed'
    | 'voiceFlux'
    | 'wovenMyriad'
    | 'sealMaster'
    | 'tuneStrainStacks'
    | 'tuneResponseStacks'
    | 'tuneBreakMultiplier'
    | 'echoMotionValue'
    | 'echoFlatDamage'
    | 'echoAttribute'
    | 'echoScaling'
  >
>;

/** Slot-1 echo skill parsed for the "add Echo skill" panel (null = slot 1 empty/unknown). */
export interface MainEchoSkill {
  echoName: string;
  cooldown?: number;
  hits: EchoSkillHit[];
}

const KIND_ORDER = ['basic', 'heavy', 'skill', 'liberation', 'intro', 'outro', 'forte', 'echo', 'tunebreak'] as const;
const KIND_LABELS: Record<string, string> = {
  basic: 'Basic Attack',
  heavy: 'Heavy Attack',
  skill: 'Resonance Skill',
  liberation: 'Resonance Liberation',
  intro: 'Intro Skill',
  outro: 'Outro Skill',
  forte: 'Forte Circuit',
  echo: 'Echo Skill',
  tunebreak: 'Tune Break',
};

interface RotationTimelineProps {
  character: CharacterData;
  resonanceChain: number;
  forteLevels: Record<string, number>;
  resonanceMode: ResonanceMode | null;
  onSetResonanceMode: (mode: ResonanceMode | null) => void;
  blocks: ActionBlock[];
  buffs: RotationBuff[];
  globalBuffIds: string[];
  results: Map<string, BlockResult>;
  dpr: number | null;
  dps: number | null;
  rotationTime: number;
  /** Equipped weapon rank (1-5) for resolving weapon preset series. Defaults to 5. */
  weaponRank?: number;
  /** Slot-1 echo skill for the "add Echo skill" panel. Absent = slot 1 empty/unknown. */
  mainEchoSkill?: MainEchoSkill | null;
  onAddBlock: (
    skillId: string,
    motionName: string,
    forteLevel: number,
    options?: Pick<ActionBlock, 'damageKind' | 'statusType' | 'statusStacks' | 'tuneResponseStacks' | 'tuneBreakMultiplier' | 'echoName' | 'echoMotionValue' | 'echoFlatDamage' | 'echoAttribute' | 'echoScaling' | 'echoCooldown'>,
  ) => void;
  onRemoveBlock: (id: string) => void;
  onMoveBlock: (id: string, direction: -1 | 1) => void;
  onSetBlockForte: (id: string, forteLevel: number) => void;
  onSetBlockStatusStacks: (id: string, stacks: number) => void;
  onSetBlockConviction: (id: string, conviction: number) => void;
  onSetBlockKitState: (id: string, patch: KitStatePatch) => void;
  onToggleBlockBuff: (blockId: string, buffId: string) => void;
  onToggleGlobalBuff: (id: string) => void;
  onAddBuff: (buff: Omit<RotationBuff, 'id'>) => void;
  onRemoveBuff: (id: string) => void;
  onSetBlockDuration: (id: string, seconds: number) => void;
  onSetBuffWindow: (id: string, start: number, duration: number) => void;
  onClearBuffWindow: (id: string) => void;
}

/** Compact seconds for timeline display (integers stay clean, float noise trimmed). */
function formatSeconds(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

function motionPercent(skill: CharacterData['skills'][number], motionName: string, forteLevel: number): string {
  const motion = resolveMotion(skill, motionName, forteLevel);
  const pct = (motion.ratio * 100).toFixed(1);
  return motion.hits > 1 ? `${pct}% (×${motion.hits})` : `${pct}%`;
}

/** Healing motions score 0 damage — hidden from the action picker (name fallback covers legacy data). */
function isHealingMotionRow(
  motion: CharacterData['skills'][number]['motionValues'][number],
): boolean {
  return motion.isHealing ?? /healing/i.test(motion.name);
}

/** Tooltip extras: scaling stat + true bonus bucket when it differs from the skill kind. */
function motionTitle(
  skill: CharacterData['skills'][number],
  motion: CharacterData['skills'][number]['motionValues'][number],
  forteLevel: number,
): string {
  const parts = [motionPercent(skill, motion.name, forteLevel)];
  const scaling = motion.scaling ?? skill.scaling;
  if (scaling !== 'ATK') parts.push(`scales off ${scaling}`);
  const bucket = motion.dmgType ?? skill.kind;
  if (bucket !== skill.kind) parts.push(`scores as ${KIND_LABELS[bucket] ?? bucket} DMG Bonus`);
  return parts.join(' · ');
}

/** Per-motion scaling tag (falls back to the skill default for legacy data). */
function motionScaling(
  skill: CharacterData['skills'][number],
  motion: CharacterData['skills'][number]['motionValues'][number],
): string {
  return motion.scaling ?? skill.scaling;
}

/**
 * Read-only rotation overview: one segment per block, proportional to
 * duration when blocks are timed (equal widths otherwise). Segments
 * starting past rotation time render ember. Tooltips carry the detail;
 * the list below stays the editor of record.
 */
function RotationStrip({
  blocks,
  starts,
  rotationTime,
  anyTimed,
}: {
  blocks: ActionBlock[];
  starts: number[];
  rotationTime: number;
  anyTimed: boolean;
}) {
  const totalDuration = blocks.reduce((sum, block) => sum + (block.durationSeconds ?? 0), 0);
  const span = Math.max(totalDuration, rotationTime, 0.001);
  return (
    <div aria-label="Rotation overview" className="mb-2">
      <div className="flex h-5 gap-px overflow-hidden bg-panel-3">
        {blocks.map((block, index) => {
          const width = anyTimed
            ? Math.max(1.5, ((block.durationSeconds ?? 0) / span) * 100)
            : 100 / blocks.length;
          const overrun = (starts[index] ?? 0) >= rotationTime;
          const label = block.motionName !== '' ? block.motionName : block.skillId;
          return (
            <div
              key={block.id}
              title={`${index + 1}. ${label} @${formatSeconds(starts[index] ?? 0)}s`}
              style={{ width: `${width}%` }}
              className={`score-bar-fill h-5 shrink-0 ${overrun ? 'bg-ember/70' : 'bg-seal/70'}`}
            />
          );
        })}
      </div>
      <div className="mt-0.5 flex justify-between text-xs text-fog tnum">
        <span>0s</span>
        <span>{formatSeconds(rotationTime)}s</span>
      </div>
    </div>
  );
}

export function RotationTimeline(props: RotationTimelineProps) {
  const {
    character, resonanceChain, forteLevels, resonanceMode, onSetResonanceMode, blocks, buffs, globalBuffIds, results, dpr, dps, rotationTime,
    weaponRank = 5,
    mainEchoSkill = null,
    onAddBlock, onRemoveBlock, onMoveBlock, onSetBlockForte, onSetBlockStatusStacks, onSetBlockConviction,
    onSetBlockKitState, onToggleBlockBuff, onToggleGlobalBuff, onAddBuff, onRemoveBuff,
    onSetBlockDuration, onSetBuffWindow, onClearBuffWindow,
  } = props;
  const starts = blockStartTimes(blocks);
  const anyTimed = blocks.some((block) => block.durationSeconds !== undefined);
  const totalDuration = blocks.reduce((sum, block) => sum + (block.durationSeconds ?? 0), 0);
  const statusOptions = characterStatusBlocks(character.id);
  const baneCharacter = characterUsesHavocBane(character.id);
  const strainCharacter = characterUsesTuneStrain(character.id);
  const ruptureResponses = characterTuneRuptureResponses(character.id);
  const resonanceModes = characterResonanceModes(character.id);
  // Previous scores for the delta chips, carried as render state: when
  // the scores move, this render compares against the last committed
  // pair (adjust-state pattern — React re-renders before painting).
  const [scorePair, setScorePair] = useState({
    dpr,
    dps,
    prevDpr: null as number | null,
    prevDps: null as number | null,
  });
  if (dpr !== scorePair.dpr || dps !== scorePair.dps) {
    setScorePair({ dpr, dps, prevDpr: scorePair.dpr, prevDps: scorePair.dps });
  }
  const [buffError, setBuffError] = useState<string | null>(null);
  const [buffLabel, setBuffLabel] = useState('');
  const [buffSource, setBuffSource] = useState('');
  const [buffStat, setBuffStat] = useState<StatKey>('atkPct');
  const [buffValue, setBuffValue] = useState('');
  const [buffStat2, setBuffStat2] = useState<StatKey>('dmgBonus:basic');
  const [buffValue2, setBuffValue2] = useState('');
  const [presetId, setPresetId] = useState('');

  const kinds = KIND_ORDER.filter((kind) => character.skills.some((s) => s.kind === kind));

  type ParsedMod = { ok: true; mod: { stat: StatKey; value: number } | null } | { ok: false };
  const parseBuffMod = (stat: StatKey, text: string): ParsedMod => {
    if (text.trim() === '') return { ok: true, mod: null };
    try {
      return { ok: true, mod: { stat, value: parseDisplayValue(stat, text) } };
    } catch {
      setBuffError(`Buff value is not a valid ${isPercentStat(stat) ? 'percent' : 'number'}.`);
      return { ok: false };
    }
  };

  const handleAddBuff = (event: FormEvent): void => {
    event.preventDefault();
    const label = buffLabel.trim();
    if (label === '') {
      setBuffError('Buff name is required.');
      return;
    }
    setBuffError(null);
    const first = parseBuffMod(buffStat, buffValue);
    if (!first.ok || first.mod === null) {
      if (first.ok) setBuffError('Buff value is required.');
      return;
    }
    const second = parseBuffMod(buffStat2, buffValue2);
    if (!second.ok) return;
    const mods = second.mod === null ? [first.mod] : [first.mod, second.mod];
    onAddBuff({ label, source: buffSource.trim() === '' ? 'Custom' : buffSource.trim(), mods });
    setBuffLabel('');
    setBuffSource('');
    setBuffValue('');
    setBuffValue2('');
  };

  const selectedPreset: BuffPreset | undefined = BUFF_PRESETS.find((p) => p.id === presetId);

  const handleAddPreset = (): void => {
    if (!selectedPreset) return;
    const mods = resolvePresetMods(selectedPreset, { weaponRank, attribute: character.attribute });
    onAddBuff({
      label: selectedPreset.label,
      source: `${selectedPreset.source} preset`,
      mods,
      ...(selectedPreset.windowSeconds !== undefined ? { windowDurationSeconds: selectedPreset.windowSeconds } : {}),
    });
    setPresetId('');
  };

  return (
    <div className="space-y-4">
      {dpr !== null && dps !== null && (
        <div
          aria-label="Rotation results"
          className="sticky top-2 z-[5] overflow-hidden px-card bg-panel"
        >
          <div className="px-4 pt-3 pb-2">
            <h3 className="font-display text-2xl leading-tight font-semibold text-ink">Rotation results</h3>
          </div>
          <div className="grid grid-cols-3 gap-2 px-4 pt-1 pb-4 text-center">
            <div className="min-w-0">
              <p className="text-xs text-fog">DPR</p>
              <p className="mt-0.5 truncate font-display text-3xl leading-none font-semibold text-accent-text sm:text-4xl">
                <AnimatedNumber value={dpr} />
              </p>
              <div className="mt-1 flex h-4 items-center justify-center">
                <DeltaChip current={dpr} previous={scorePair.prevDpr ?? dpr} />
              </div>
            </div>
            <div className="min-w-0 border-x border-line">
              <p className="text-xs text-fog">DPS</p>
              <p className="mt-0.5 truncate font-display text-3xl leading-none font-semibold text-ink sm:text-4xl">
                <AnimatedNumber value={dps} />
              </p>
              <div className="mt-1 flex h-4 items-center justify-center">
                <DeltaChip current={dps} previous={scorePair.prevDps ?? dps} />
              </div>
            </div>
            <div className="min-w-0">
              <p className="text-xs text-fog">Time</p>
              <p className="mt-0.5 truncate font-display text-3xl leading-none font-semibold text-ink tnum sm:text-4xl">{rotationTime}s</p>
            </div>
          </div>
        </div>
      )}

      <section aria-label="Rotation timeline">
        {totalDuration > 0 && totalDuration > rotationTime && (
          <p role="alert" className="mb-2 text-xs text-amber">
            Total block duration {formatSeconds(totalDuration)}s exceeds rotation time {rotationTime}s — out-of-range blocks still score.
          </p>
        )}
        {totalDuration > 0 && totalDuration <= rotationTime && (
          <p className="mb-2 text-xs text-fog">
            Total block duration {formatSeconds(totalDuration)}s of {rotationTime}s rotation time.
          </p>
        )}
        {blocks.length > 0 && (
          <RotationStrip blocks={blocks} starts={starts} rotationTime={rotationTime} anyTimed={anyTimed} />
        )}
        {blocks.length === 0 ? (
          <p className="border-2 border-dashed border-line-strong bg-panel px-4 py-6 text-center text-sm text-fog">No actions yet — add your first hit below to start the rotation.</p>
        ) : (
          <ol className="space-y-2">
            {blocks.map((block, index) => {
              const negativeStatus = block.damageKind === 'negativeStatus';
              const stale = negativeStatus ? false : isBlockStale(character, block);
              const result = results.get(block.id);
              const skill = character.skills.find((s) => s.id === block.skillId);
              const statusLabel = block.statusType ? negativeStatusDef(block.statusType).label : null;
              const tuneBreak = block.damageKind === 'tuneBreak';
              const tuneRupture = block.damageKind === 'tuneRupture';
              const echoSkill = block.damageKind === 'echoSkill';
              const specialKind = negativeStatus || tuneBreak || tuneRupture || echoSkill;
              const echoSubtitle = echoSkill
                ? `${((block.echoMotionValue ?? 0) * 100).toFixed(1)}% ${block.echoAttribute ?? '?'}${(block.echoFlatDamage ?? 0) > 0 ? `+${block.echoFlatDamage}` : ''}${(block.echoScaling ?? 'ATK') !== 'ATK' ? `[${block.echoScaling}]` : ''}`
                : null;
              const lanceBlock = !specialKind && skill !== undefined &&
                skill.motionValues.length === 0 && !isBuffOnlySkill(character.id, skill);
              const blockLabel = specialKind
                ? (result?.label ?? (statusLabel ? `${statusLabel} DMG` : block.motionName !== '' ? `${block.motionName} (Tune)` : 'Tune Break DMG'))
                : (skill?.label ?? block.skillId);
              const skillKind = skill?.kind;
              const blockCap = maxStatusStacks(block.statusType ?? 'aeroErosion', character.id, resonanceChain);
              return (
                <li key={block.id} className="animate-tt-fade px-card bg-panel px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="min-w-0 flex-1 basis-48">
                      <p className="truncate font-display text-lg leading-tight font-semibold text-ink">
                        <span className="mr-1.5 text-xs font-medium text-accent-text tnum">{String(index + 1).padStart(2, '0')}</span>
                        {blockLabel}
                        {anyTimed && <span className="ml-1.5 text-xs font-medium text-fog tnum">@{formatSeconds(starts[index])}s</span>}
                        {result?.buffCarrier && <span className="ml-1.5 text-xs text-fog">buff carrier</span>}
                      </p>
                      <p className="mt-0.5 truncate text-xs text-fog tnum">
                        {negativeStatus
                          ? `${block.statusStacks ?? 1} stack${(block.statusStacks ?? 1) === 1 ? '' : 's'}`
                          : tuneBreak
                            ? `coefficient ${block.tuneBreakMultiplier ?? '—'}`
                            : echoSkill
                              ? (echoSubtitle ?? 'Echo Skill')
                              : lanceBlock
                                ? 'Coordinated lance (one trigger)'
                                : block.motionName === '' ? 'No damage component' : block.motionName}
                        {result && !result.buffCarrier && (
                          <span className="text-ink"> · {Math.round(result.damage).toLocaleString()} dmg · {result.share.toFixed(1)}%</span>
                        )}
                      </p>
                    </div>
                    <div className="ml-auto flex shrink-0 items-center gap-1">
                      <button type="button" aria-label={`Move ${block.motionName || 'block'} up`} disabled={index === 0} onClick={() => onMoveBlock(block.id, -1)} className={`${btnGhost} ${btnSm}`}>↑</button>
                      <button type="button" aria-label={`Move ${block.motionName || 'block'} down`} disabled={index === blocks.length - 1} onClick={() => onMoveBlock(block.id, 1)} className={`${btnGhost} ${btnSm}`}>↓</button>
                      <button type="button" onClick={() => onRemoveBlock(block.id)} className={`${btnDangerGhost} ${btnSm}`}>Remove</button>
                    </div>
                  </div>
                  {result && !result.buffCarrier && (
                    <ScoreBar share={result.share} className="mt-2" />
                  )}
                  {stale ? (
                    <p role="alert" className="mt-1 text-xs text-amber">
                      This action is not on {character.name}’s kit — remove it or switch back.
                    </p>
                  ) : (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-xs text-fog">
                        {negativeStatus
                          ? `${statusLabel ?? 'Status'} · ${block.statusStacks ?? 1} stack${(block.statusStacks ?? 1) === 1 ? '' : 's'}`
                          : tuneBreak
                            ? `Tune Break ×${block.tuneBreakMultiplier ?? '—'}`
                            : tuneRupture
                              ? `${block.motionName} · ${block.tuneResponseStacks ?? 0} trail stacks`
                              : echoSkill
                                ? `Echo Skill · ${block.activeBuffIds.length} buff${block.activeBuffIds.length === 1 ? '' : 's'}`
                                : lanceBlock
                                ? `Coordinated lance · ${block.activeBuffIds.length} buff${block.activeBuffIds.length === 1 ? '' : 's'}`
                                : `Forte ${block.forteLevel} · ${block.activeBuffIds.length} buff${block.activeBuffIds.length === 1 ? '' : 's'}`}
                      </summary>
                      <div className="mt-2 grid gap-2 md:grid-cols-2">
                        <div>
                          <label htmlFor={`block-duration-${block.id}`} className={labelClass}>Duration (s)</label>
                          <input
                            id={`block-duration-${block.id}`}
                            type="number"
                            min={0}
                            max={3600}
                            step="any"
                            value={block.durationSeconds ?? ''}
                            onChange={(e) => {
                              if (e.target.value.trim() === '') return;
                              const num = Number(e.target.value);
                              if (Number.isFinite(num)) onSetBlockDuration(block.id, num);
                            }}
                            className={`${inputClass} mt-0.5`}
                          />
                        </div>
                        {tuneBreak ? (
                          <div>
                            <label htmlFor={`block-break-mult-${block.id}`} className={labelClass}>Tune Break coefficient (unverified — your research)</label>
                            <input
                              id={`block-break-mult-${block.id}`}
                              type="number"
                              min={0}
                              max={99}
                              step="any"
                              value={block.tuneBreakMultiplier ?? ''}
                              onChange={(e) => {
                                if (e.target.value.trim() === '') return;
                                const num = Number(e.target.value);
                                if (Number.isFinite(num)) onSetBlockKitState(block.id, { tuneBreakMultiplier: num });
                              }}
                              className={`${inputClass} mt-0.5`}
                            />
                          </div>
                        ) : tuneRupture ? (
                          <>
                            <div>
                              <label htmlFor={`block-forte-${block.id}`} className={labelClass}>Forte level</label>
                              <input
                                id={`block-forte-${block.id}`}
                                type="number"
                                min={1}
                                max={10}
                                value={block.forteLevel}
                                onChange={(e) => {
                                  if (e.target.value.trim() === '') return;
                                  const num = Number(e.target.value);
                                  if (Number.isInteger(num)) onSetBlockForte(block.id, num);
                                }}
                                className={`${inputClass} mt-0.5`}
                              />
                            </div>
                            <div>
                              <label htmlFor={`block-response-stacks-${block.id}`} className={labelClass}>Trail stacks consumed</label>
                              <input
                                id={`block-response-stacks-${block.id}`}
                                type="number"
                                min={0}
                                max={99}
                                value={block.tuneResponseStacks ?? 0}
                                onChange={(e) => {
                                  if (e.target.value.trim() === '') return;
                                  const num = Number(e.target.value);
                                  if (Number.isInteger(num)) onSetBlockKitState(block.id, { tuneResponseStacks: num });
                                }}
                                className={`${inputClass} mt-0.5`}
                              />
                            </div>
                          </>
                        ) : negativeStatus ? (
                          <div>
                            <label htmlFor={`block-status-stacks-${block.id}`} className={labelClass}>{statusLabel ?? 'Status'} stacks</label>
                            <input
                              id={`block-status-stacks-${block.id}`}
                              type="number"
                              min={1}
                              max={blockCap}
                              value={block.statusStacks ?? 1}
                              onChange={(e) => {
                                if (e.target.value.trim() === '') return;
                                const num = Number(e.target.value);
                                if (Number.isInteger(num)) onSetBlockStatusStacks(block.id, num);
                              }}
                              className={`${inputClass} mt-0.5`}
                            />
                          </div>
                        ) : echoSkill ? (
                          <>
                            <div>
                              <label htmlFor={`block-echo-mv-${block.id}`} className={labelClass}>Motion value (%)</label>
                              <input
                                id={`block-echo-mv-${block.id}`}
                                type="number"
                                min={0}
                                max={9900}
                                step="any"
                                value={block.echoMotionValue === undefined ? '' : Math.round(block.echoMotionValue * 100 * 1e6) / 1e6}
                                onChange={(e) => {
                                  if (e.target.value.trim() === '') return;
                                  const num = Number(e.target.value);
                                  if (Number.isFinite(num)) onSetBlockKitState(block.id, { echoMotionValue: num / 100 });
                                }}
                                className={`${inputClass} mt-0.5`}
                              />
                            </div>
                            <div>
                              <label htmlFor={`block-echo-flat-${block.id}`} className={labelClass}>Flat damage</label>
                              <input
                                id={`block-echo-flat-${block.id}`}
                                type="number"
                                min={0}
                                step="any"
                                value={block.echoFlatDamage ?? 0}
                                onChange={(e) => {
                                  if (e.target.value.trim() === '') return;
                                  const num = Number(e.target.value);
                                  if (Number.isFinite(num)) onSetBlockKitState(block.id, { echoFlatDamage: num });
                                }}
                                className={`${inputClass} mt-0.5`}
                              />
                            </div>
                            <div>
                              <label htmlFor={`block-echo-attr-${block.id}`} className={labelClass}>Damage element</label>
                              <select
                                id={`block-echo-attr-${block.id}`}
                                value={block.echoAttribute ?? 'Havoc'}
                                onChange={(e) => onSetBlockKitState(block.id, { echoAttribute: e.target.value as Attribute })}
                                className={`${inputClass} mt-0.5`}
                              >
                                {attributeSchema.options.map((attr) => (
                                  <option key={attr} value={attr}>{attr}</option>
                                ))}
                              </select>
                            </div>
                            <div>
                              <label htmlFor={`block-echo-scaling-${block.id}`} className={labelClass}>Scales off</label>
                              <select
                                id={`block-echo-scaling-${block.id}`}
                                value={block.echoScaling ?? 'ATK'}
                                onChange={(e) => {
                                  const scaling = e.target.value;
                                  if (scaling === 'ATK' || scaling === 'HP' || scaling === 'DEF') {
                                    onSetBlockKitState(block.id, { echoScaling: scaling });
                                  }
                                }}
                                className={`${inputClass} mt-0.5`}
                              >
                                <option value="ATK">ATK</option>
                                <option value="HP">HP</option>
                                <option value="DEF">DEF</option>
                              </select>
                            </div>
                            {block.echoCooldown !== undefined && (
                              <p className="text-xs text-fog">
                                Cooldown {block.echoCooldown}s (shown, not simulated).
                              </p>
                            )}
                          </>
                        ) : (
                          <div>
                            <label htmlFor={`block-forte-${block.id}`} className={labelClass}>Forte level</label>
                            <input
                              id={`block-forte-${block.id}`}
                              type="number"
                              min={1}
                              max={10}
                              value={block.forteLevel}
                              onChange={(e) => {
                                if (e.target.value.trim() === '') return;
                                const num = Number(e.target.value);
                                if (Number.isInteger(num)) onSetBlockForte(block.id, num);
                              }}
                              className={`${inputClass} mt-0.5`}
                            />
                          </div>
                        )}
                        {!specialKind && character.id === 'cartethyia' && (
                          <div>
                            <label htmlFor={`target-status-stacks-${block.id}`} className={labelClass}>Target Aero Erosion stacks</label>
                            <input
                              id={`target-status-stacks-${block.id}`}
                              type="number"
                              min={0}
                              max={maxStatusStacks('aeroErosion', character.id, resonanceChain)}
                              value={block.targetStatusStacks ?? 0}
                              onChange={(e) => {
                                if (e.target.value.trim() === '') return;
                                const num = Number(e.target.value);
                                if (Number.isInteger(num)) onSetBlockStatusStacks(block.id, num);
                              }}
                              className={`${inputClass} mt-0.5`}
                            />
                          </div>
                        )}
                        {!specialKind && strainCharacter && (
                          <div>
                            <label htmlFor={`tune-strain-stacks-${block.id}`} className={labelClass}>Tune Strain stacks on target</label>
                            <input
                              id={`tune-strain-stacks-${block.id}`}
                              type="number"
                              min={0}
                              max={10}
                              value={block.tuneStrainStacks ?? 0}
                              onChange={(e) => {
                                if (e.target.value.trim() === '') return;
                                const num = Number(e.target.value);
                                if (Number.isInteger(num)) onSetBlockKitState(block.id, { tuneStrainStacks: num });
                              }}
                              className={`${inputClass} mt-0.5`}
                            />
                          </div>
                        )}
                        {!specialKind && baneCharacter && (
                          <div>
                            <label htmlFor={`target-bane-stacks-${block.id}`} className={labelClass}>Target Havoc Bane stacks</label>
                            <input
                              id={`target-bane-stacks-${block.id}`}
                              type="number"
                              min={0}
                              max={maxStatusStacks('havocBane', character.id, resonanceChain)}
                              value={block.targetHavocBaneStacks ?? 0}
                              onChange={(e) => {
                                if (e.target.value.trim() === '') return;
                                const num = Number(e.target.value);
                                if (Number.isInteger(num)) onSetBlockKitState(block.id, { targetHavocBaneStacks: num });
                              }}
                              className={`${inputClass} mt-0.5`}
                            />
                          </div>
                        )}
                        {!specialKind && character.id === 'zani' && skillKind === 'liberation' && (
                          <div>
                            <label htmlFor={`blazes-consumed-${block.id}`} className={labelClass}>Blazes consumed (S3)</label>
                            <input
                              id={`blazes-consumed-${block.id}`}
                              type="number"
                              min={0}
                              max={150}
                              value={block.blazesConsumed ?? 0}
                              onChange={(e) => {
                                if (e.target.value.trim() === '') return;
                                const num = Number(e.target.value);
                                if (Number.isInteger(num)) onSetBlockKitState(block.id, { blazesConsumed: num });
                              }}
                              className={`${inputClass} mt-0.5`}
                            />
                          </div>
                        )}
                        {!specialKind && character.id === 'zani' && skillKind === 'forte' && (
                          <div>
                            <label htmlFor={`nightfall-blazes-${block.id}`} className={labelClass}>Blazes on Nightfall hit</label>
                            <input
                              id={`nightfall-blazes-${block.id}`}
                              type="number"
                              min={0}
                              max={40}
                              value={block.nightfallBlazes ?? 0}
                              onChange={(e) => {
                                if (e.target.value.trim() === '') return;
                                const num = Number(e.target.value);
                                if (Number.isInteger(num)) onSetBlockKitState(block.id, { nightfallBlazes: num });
                              }}
                              className={`${inputClass} mt-0.5`}
                            />
                          </div>
                        )}
                        {!specialKind && character.id === 'yangyang-xuanling' && (
                          <label className="flex items-center gap-2 text-xs text-fog">
                            <input
                              type="checkbox"
                              checked={block.voiceFlux ?? false}
                              onChange={() => onSetBlockKitState(block.id, { voiceFlux: !(block.voiceFlux ?? false) })}
                            />
                            <span>Voice Flux active (S6 Heavy +40%)</span>
                          </label>
                        )}
                        {!specialKind && character.id === 'suoming' && (
                          <label className="flex items-center gap-2 text-xs text-fog">
                            <input
                              type="checkbox"
                              checked={block.sealMaster ?? false}
                              onChange={() => onSetBlockKitState(block.id, { sealMaster: !(block.sealMaster ?? false) })}
                            />
                            <span>Seal Master active (Unfurled ×2, 12s)</span>
                          </label>
                        )}
                        {!specialKind && character.id === 'chisa' && skillKind === 'forte' && (
                          <div>
                            <label className="flex items-center gap-2 text-xs text-fog">
                              <input
                                type="checkbox"
                                checked={block.wovenMyriad ?? false}
                                onChange={() => onSetBlockKitState(block.id, { wovenMyriad: !(block.wovenMyriad ?? false) })}
                              />
                              <span>Woven Myriad active (Liberation state)</span>
                            </label>
                            <label htmlFor={`rings-consumed-${block.id}`} className={`${labelClass} mt-2`}>Rings consumed (Eradication)</label>
                            <input
                              id={`rings-consumed-${block.id}`}
                              type="number"
                              min={0}
                              max={99}
                              value={block.ringsConsumed ?? 0}
                              onChange={(e) => {
                                if (e.target.value.trim() === '') return;
                                const num = Number(e.target.value);
                                if (Number.isInteger(num)) onSetBlockKitState(block.id, { ringsConsumed: num });
                              }}
                              className={`${inputClass} mt-0.5`}
                            />
                          </div>
                        )}
                        {!specialKind && character.id === 'cartethyia' && character.skills.find((s) => s.id === block.skillId)?.kind === 'forte' && (
                          <div>
                            <label htmlFor={`conviction-${block.id}`} className={labelClass}>Fleurdelys Conviction (S1)</label>
                            <input
                              id={`conviction-${block.id}`}
                              type="number"
                              min={0}
                              max={120}
                              value={block.conviction ?? 0}
                              onChange={(e) => {
                                if (e.target.value.trim() === '') return;
                                const num = Number(e.target.value);
                                if (Number.isInteger(num)) onSetBlockConviction(block.id, num);
                              }}
                              className={`${inputClass} mt-0.5`}
                            />
                          </div>
                        )}
                        <fieldset>
                          <legend className={labelClass}>Buffs on this action</legend>
                          {buffs.length === 0 ? (
                            <p className="mt-0.5 text-xs text-fog">No buffs yet — add one below.</p>
                          ) : (
                            <div className="mt-1 space-y-1">
                              {buffs.map((buff) => {
                                const manual = block.activeBuffIds.includes(buff.id);
                                const inWindow = buffAppliesAt(buff, starts[index]);
                                return (
                                  <label key={buff.id} className="flex items-center gap-2 text-xs text-fog">
                                    <input
                                      type="checkbox"
                                      checked={manual || inWindow}
                                      disabled={inWindow && !manual}
                                      onChange={() => onToggleBlockBuff(block.id, buff.id)}
                                    />
                                    <span>[{buff.source}] {buff.label}</span>
                                    {inWindow && <span className="bg-panel-3 px-1 text-fog">window</span>}
                                  </label>
                                );
                              })}
                            </div>
                          )}
                        </fieldset>
                      </div>
                    </details>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <Window title="Add Actions" label="Add actions">
        {resonanceModes.length > 0 && (
          <div className="mt-3 border-2 border-line bg-canvas p-3">
            <p className="text-xs text-fog">Resonance Mode</p>
            <p className="mt-1 text-xs text-fog">
              This kit scores differently per mode — pick the one this rotation runs.
            </p>
            <div className="mt-1.5 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Resonance Mode">
              {resonanceModes.map((mode) => (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={resonanceMode === mode}
                  onClick={() => onSetResonanceMode(mode)}
                  className={`border-2 px-2.5 py-1 text-xs font-medium transition-terminal hover:bg-panel-2 ${
                    resonanceMode === mode
                      ? 'border-glacio text-glacio'
                      : 'border-line-strong text-ink'
                  }`}
                >
                  {RESONANCE_MODE_LABELS[mode]}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="mt-3 space-y-3">
          {kinds.map((kind) => (
            <div key={kind}>
              <p className="text-xs text-fog">{KIND_LABELS[kind]}</p>
              <div className="mt-1 flex flex-wrap gap-1">
                {character.skills.filter((s) => s.kind === kind).flatMap((skill) => {
                  if (skill.motionValues.length === 0 && !isBuffOnlySkill(character.id, skill)) {
                    // Jiyan's outro lance: buff-carrier-shaped, scores damage.
                    return (
                      <button
                        key={skill.id}
                        type="button"
                        title={`${(JIYAN_OUTRO_LANCE_MV * 100).toFixed(1)}% ATK · Aero + coordinated buckets`}
                        onClick={() => onAddBlock(skill.id, '', forteLevels[skill.id] ?? 10)}
                        className="border-2 border-line-strong px-2 py-1 text-xs text-fog transition-terminal hover:border-fog hover:bg-panel-2 hover:text-ink"
                      >
                        {skill.label} (coordinated lance)
                      </button>
                    );
                  }
                  return skill.motionValues.length === 0 ? (
                    <button
                      key={skill.id}
                      type="button"
                      onClick={() => onAddBlock(skill.id, '', forteLevels[skill.id] ?? 10)}
                      className="border-2 border-line-strong px-2 py-1 text-xs text-fog transition-terminal hover:border-fog hover:bg-panel-2 hover:text-ink"
                    >
                      {skill.label} (buff carrier)
                    </button>
                  ) : (
                    skill.motionValues.filter((motion) => !isHealingMotionRow(motion) && !isParameterMotionRow(character.id, motion.name)).map((motion) => (
                      <button
                        key={`${skill.id}:${motion.name}`}
                        type="button"
                        title={motionTitle(skill, motion, forteLevels[skill.id] ?? 10)}
                        onClick={() => onAddBlock(skill.id, motion.name, forteLevels[skill.id] ?? 10)}
                        className="border-2 border-line-strong px-2 py-1 text-xs text-fog transition-terminal hover:border-fog hover:bg-panel-2 hover:text-ink"
                      >
                        {motion.name} · {motionPercent(skill, motion.name, forteLevels[skill.id] ?? 10)}
                        {motionScaling(skill, motion) !== 'ATK' && ` [${motionScaling(skill, motion)}]`}
                        {(motion.dmgType ?? skill.kind) !== skill.kind && ` (${KIND_LABELS[motion.dmgType ?? skill.kind] ?? motion.dmgType} bonus)`}
                      </button>
                    ))
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        {statusOptions.map((status) => {
          const def = negativeStatusDef(status);
          const cap = maxStatusStacks(status, character.id, resonanceChain);
          return (
            <div key={status} className="mt-3 border-2 border-line bg-canvas p-3">
              <p className="text-xs text-fog">Negative Status DMG</p>
              <p className="mt-1 text-xs text-fog">
                {def.label} ignores {def.element}/action DMG bonuses and Crit. Its damage is resolved from the selected stack count.
              </p>
              <div className="mt-1 flex flex-wrap gap-1">
                {Array.from({ length: cap }, (_, i) => i + 1).map((stacks) => (
                  <button
                    key={stacks}
                    type="button"
                    onClick={() => onAddBlock('', `${def.label} DMG`, 1, {
                      damageKind: 'negativeStatus',
                      statusType: status,
                      statusStacks: stacks,
                    })}
                    className="border-2 border-line-strong px-2 py-1 text-xs text-fog transition-terminal hover:border-fog hover:bg-panel-2 hover:text-ink"
                  >
                    {def.label} ×{stacks}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
        {ruptureResponses.length > 0 && resonanceMode === 'tuneRupture' && (
          <div className="mt-3 border-2 border-line bg-canvas p-3">
            <p className="text-xs text-fog">Tune Rupture Response (provisional)</p>
            <p className="mt-1 text-xs text-fog">
              Response instances use the snapshot MV with trail scaling, no base Crit, and no verified formula — tune the trail count per block.
            </p>
            <div className="mt-1 flex flex-wrap gap-1">
              {ruptureResponses.map((motionName) => {
                const skill = character.skills.find((s) => s.motionValues.some((m) => m.name === motionName));
                if (!skill) return null;
                return (
                  <button
                    key={motionName}
                    type="button"
                    onClick={() => onAddBlock(skill.id, motionName, forteLevels[skill.id] ?? 10, {
                      damageKind: 'tuneRupture',
                      tuneResponseStacks: 0,
                    })}
                    className="border-2 border-line-strong px-2 py-1 text-xs text-fog transition-terminal hover:border-fog hover:bg-panel-2 hover:text-ink"
                  >
                    {motionName}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        <div className="mt-3 border-2 border-line bg-canvas p-3">
          <p className="text-xs text-fog">Tune Break (provisional)</p>
          <p className="mt-1 text-xs text-fog">
            Mistuned-target break hit: provisional base-10000 shape, no verified formula or coefficients — set the coefficient per block from your own research.
          </p>
          <div className="mt-1 flex flex-wrap gap-1">
            <button
              type="button"
              onClick={() => onAddBlock('', 'Tune Break DMG', 1, {
                damageKind: 'tuneBreak',
                tuneBreakMultiplier: 1,
              })}
              className="border-2 border-line-strong px-2 py-1 text-xs text-fog transition-terminal hover:border-fog hover:bg-panel-2 hover:text-ink"
            >
              Tune Break ×1.0
            </button>
          </div>
        </div>
        {mainEchoSkill !== null && (
          <div className="mt-3 border-2 border-line bg-canvas p-3">
            <p className="text-xs text-fog">Echo Skill (slot 1: {mainEchoSkill.echoName})</p>
            {mainEchoSkill.hits.length === 0 ? (
              <p className="mt-1 text-xs text-fog">
                No damaging skill to score — heals, shields, Physical damage, and utility echoes carry no scorable hit.
              </p>
            ) : (
              <>
                <p className="mt-1 text-xs text-fog">
                  One block per hit — repeat for multi-hit skills{mainEchoSkill.cooldown !== undefined ? ` (cooldown ${mainEchoSkill.cooldown}s shown, not simulated)` : ''}.
                </p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {mainEchoSkill.hits.map((hit) => (
                    <button
                      key={hit.label}
                      type="button"
                      onClick={() => onAddBlock('', mainEchoSkill.echoName, 1, {
                        damageKind: 'echoSkill',
                        echoName: mainEchoSkill.echoName,
                        echoMotionValue: hit.motionValue,
                        echoFlatDamage: hit.flatDamage,
                        echoAttribute: hit.attribute,
                        echoScaling: hit.scaling,
                        echoCooldown: mainEchoSkill.cooldown,
                      })}
                      className="border-2 border-line-strong px-2 py-1 text-xs text-fog transition-terminal hover:border-fog hover:bg-panel-2 hover:text-ink"
                    >
                      {mainEchoSkill.hits.length > 1 ? `${hit.label} · ` : ''}{(hit.motionValue * 100).toFixed(1)}% {hit.attribute}
                      {hit.flatDamage > 0 && ` +${hit.flatDamage}`}
                      {hit.scaling !== 'ATK' && ` [${hit.scaling}]`}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </Window>

      <Window title="Buffs" bar="b" label="Buffs">
        {buffs.length === 0 ? (
          <p className="mt-1 text-xs text-fog">
            No buffs yet — pick a preset below or add a custom buff with its verified numbers.
          </p>
        ) : (
          <ul className="mt-2 space-y-1">
            {buffs.map((buff) => {
              const hasWindow = buff.windowDurationSeconds !== undefined;
              const windowStart = buff.windowStartSeconds ?? 0;
              const windowEnd = windowStart + (buff.windowDurationSeconds ?? 0);
              return (
                <li key={buff.id} className="text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="flex min-w-0 flex-1 basis-48 items-center gap-2 text-ink">
                      <input
                        type="checkbox"
                        checked={globalBuffIds.includes(buff.id)}
                        onChange={() => onToggleGlobalBuff(buff.id)}
                      />
                      <span className="truncate">
                        [{buff.source}] {buff.label} ({buff.mods.map((m) => `${statLabel(m.stat)} ${toDisplayValue(m.stat, m.value)}`).join(', ')})
                        {hasWindow ? ` — window [${formatSeconds(windowStart)}s, ${formatSeconds(windowEnd)}s)` : ' — full uptime'}
                      </span>
                    </label>
                    <button type="button" onClick={() => onRemoveBuff(buff.id)} className={`${btnDangerGhost} ml-auto shrink-0 ${btnSm}`}>
                      Remove {buff.label}
                    </button>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 pl-6 text-fog">
                    <label htmlFor={`buff-window-start-${buff.id}`}>Window start (s)</label>
                    <input
                      id={`buff-window-start-${buff.id}`}
                      type="number"
                      min={0}
                      max={3600}
                      step="any"
                      value={buff.windowStartSeconds ?? ''}
                      onChange={(e) => {
                        if (e.target.value.trim() === '') return;
                        const num = Number(e.target.value);
                        if (Number.isFinite(num)) onSetBuffWindow(buff.id, num, buff.windowDurationSeconds ?? 0);
                      }}
                      className="min-h-9 w-20 border-2 border-line-strong bg-canvas px-2 py-1 text-xs text-ink tnum"
                    />
                    <label htmlFor={`buff-window-duration-${buff.id}`}>Window duration (s)</label>
                    <input
                      id={`buff-window-duration-${buff.id}`}
                      type="number"
                      min={0}
                      max={3600}
                      step="any"
                      value={buff.windowDurationSeconds ?? ''}
                      onChange={(e) => {
                        if (e.target.value.trim() === '') return;
                        const num = Number(e.target.value);
                        if (Number.isFinite(num)) onSetBuffWindow(buff.id, buff.windowStartSeconds ?? 0, num);
                      }}
                      className="min-h-9 w-20 border-2 border-line-strong bg-canvas px-2 py-1 text-xs text-ink tnum"
                    />
                    {hasWindow && (
                      <button
                        type="button"
                        onClick={() => onClearBuffWindow(buff.id)}
                        aria-label={`Clear window for ${buff.label}`}
                        className={`${btnGhost} shrink-0 ${btnSm}`}
                      >
                        Clear window
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <div className="mt-3 grid gap-2 md:grid-cols-[1fr_auto]">
          <div>
            <label htmlFor="buff-preset" className={labelClass}>Preset (Echo / Sonata / Weapon)</label>
            <select id="buff-preset" value={presetId} onChange={(e) => setPresetId(e.target.value)} className={`${inputClass} mt-0.5`}>
              <option value="">Pick a preset…</option>
              {(['Echo', 'Sonata', 'Weapon'] as const).map((source) => (
                <optgroup key={source} label={source}>
                  {BUFF_PRESETS.filter((p) => p.source === source && !isAutoApplied(p)).map((p) => (
                    <option key={p.id} value={p.id}>{p.label}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          <div className="flex items-end">
            <button type="button" onClick={handleAddPreset} disabled={presetId === ''} className={btnOutline}>
              Add preset
            </button>
          </div>
        </div>
        {selectedPreset?.assumption && (
          <p className="mt-1 text-xs text-fog">{selectedPreset.label}: {selectedPreset.assumption}</p>
        )}
        <form onSubmit={handleAddBuff} className="mt-3 grid gap-2 md:grid-cols-4">
          <div>
            <label htmlFor="buff-label" className={labelClass}>Buff name</label>
            <input id="buff-label" type="text" value={buffLabel} onChange={(e) => setBuffLabel(e.target.value)} placeholder="Verina Outro" className={`${inputClass} mt-0.5`} />
          </div>
          <div>
            <label htmlFor="buff-source" className={labelClass}>Source</label>
            <input id="buff-source" type="text" value={buffSource} onChange={(e) => setBuffSource(e.target.value)} placeholder="Teammate" className={`${inputClass} mt-0.5`} />
          </div>
          <div>
            <label htmlFor="buff-stat" className={labelClass}>Stat</label>
            <select id="buff-stat" value={buffStat} onChange={(e) => setBuffStat(e.target.value as StatKey)} className={`${inputClass} mt-0.5`}>
              {statKeySchema.options.map((stat) => (
                <option key={stat} value={stat}>{statLabel(stat)}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="buff-value" className={labelClass}>Value{isPercentStat(buffStat) ? ' (%)' : ''}</label>
            <input id="buff-value" type="text" inputMode="decimal" value={buffValue} onChange={(e) => setBuffValue(e.target.value)} className={`${inputClass} mt-0.5`} />
          </div>
          <div>
            <label htmlFor="buff-stat-2" className={labelClass}>Second stat (optional)</label>
            <select id="buff-stat-2" value={buffStat2} onChange={(e) => setBuffStat2(e.target.value as StatKey)} className={`${inputClass} mt-0.5`}>
              {statKeySchema.options.map((stat) => (
                <option key={stat} value={stat}>{statLabel(stat)}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="buff-value-2" className={labelClass}>Second value{isPercentStat(buffStat2) ? ' (%)' : ''}</label>
            <input id="buff-value-2" type="text" inputMode="decimal" value={buffValue2} onChange={(e) => setBuffValue2(e.target.value)} className={`${inputClass} mt-0.5`} />
          </div>
        </form>
        {buffError && <div role="alert" className="mt-2 text-xs text-ember">{buffError}</div>}
        <button type="button" onClick={(e) => handleAddBuff(e as unknown as FormEvent)} className={`${btnOutline} mt-2`}>
          Add buff
        </button>
        <p className="mt-1 text-xs text-fog">RES shred is entered as a negative RES Penetration value.</p>
      </Window>
    </div>
  );
}
