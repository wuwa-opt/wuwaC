import { useEffect, useMemo, useState } from 'react';
import { parseEchoSkillHits } from '../../data/echoSkills.ts';
import { findEchoDef } from '../../data/index.ts';
import { presetsForCharacter, presetToBlocks } from '../../data/rotationPresets.ts';
import type { Snapshot } from '../../data/schema.ts';
import { isBuffOnlySkill } from '../../domain/characterMods.ts';
import type { CritMode } from '../../domain/damage.ts';
import { buildEnemyProfile } from '../../domain/enemy.ts';
import { calculateRotation, isBlockStale, type BlockResult } from '../../domain/rotation.ts';
import { resolveTeamBuffs } from '../../domain/teamBuffs.ts';
import { useCalculatorStore } from '../../state/calculator.ts';
import { useInventoryStore } from '../../state/inventory.ts';
import { useRosterStore } from '../../state/roster.ts';
import { useSnapshotStore } from '../../state/snapshotStore.ts';
import { useTeamStore } from '../../state/teamStore.ts';
import { EnemyConfig } from '../components/EnemyConfig.tsx';
import { RotationOptimizer } from '../components/RotationOptimizer.tsx';
import { RotationTimeline } from '../components/RotationTimeline.tsx';
import { SliderField } from '../components/SliderField.tsx';
import { btnOutline, labelClass, selectClass } from '../components/classes.ts';
import { Alert, PageHeader, Window } from '../components/ui.tsx';

/** Default weapon for a character: first of its type, else the first weapon. */
function defaultWeaponFor(snapshot: Snapshot, characterId: string): string {
  const character = snapshot.characters.find((c) => c.id === characterId);
  if (!character) return '';
  return (
    snapshot.weapons.find((w) => w.weaponType === character.weaponType)?.id ?? snapshot.weapons[0].id
  );
}

export function CalculatorPage() {
  const snapshot = useSnapshotStore((s) => s.snapshot);
  const ensureSnapshotLoaded = useSnapshotStore((s) => s.ensureLoaded);
  const calc = useCalculatorStore();
  const rosterEntries = useRosterStore((s) => s.entries);
  const rosterLoaded = useRosterStore((s) => s.loaded);
  const loadRoster = useRosterStore((s) => s.load);
  const echoes = useInventoryStore((s) => s.echoes);
  const inventoryLoaded = useInventoryStore((s) => s.loaded);
  const loadInventory = useInventoryStore((s) => s.load);
  const teams = useTeamStore((s) => s.teams);
  const teamsLoaded = useTeamStore((s) => s.loaded);
  const loadTeams = useTeamStore((s) => s.load);
  const [importTeamId, setImportTeamId] = useState('');
  const [teamWarnings, setTeamWarnings] = useState<string[]>([]);
  const [presetId, setPresetId] = useState('');
  const [presetMessages, setPresetMessages] = useState<string[]>([]);

  useEffect(() => {
    if (!rosterLoaded) void loadRoster();
  }, [rosterLoaded, loadRoster]);
  useEffect(() => {
    if (!inventoryLoaded) void loadInventory();
  }, [inventoryLoaded, loadInventory]);
  useEffect(() => {
    if (!teamsLoaded) void loadTeams();
  }, [teamsLoaded, loadTeams]);
  useEffect(() => {
    void ensureSnapshotLoaded();
  }, [ensureSnapshotLoaded]);

  const handleImportTeamBuffs = (): void => {
    const pickedTeam = teams.find((t) => t.id === importTeamId);
    if (!pickedTeam) return;
    const resolved = resolveTeamBuffs(
      pickedTeam,
      (id) => snapshot.characters.find((c) => c.id === id)?.name ?? null,
      Object.fromEntries(rosterEntries.map((e) => [e.characterId, e.resonanceChain])),
    );
    setTeamWarnings(resolved.warnings);
    for (const buff of resolved.buffs) {
      if (calc.buffs.some((existing) => existing.label === buff.label)) continue;
      const row = calc.addBuff(buff);
      // Windowed imports score by coverage instead of full uptime; only
      // untimed imports (unknown length) default to global.
      if (row.windowDurationSeconds === undefined) calc.toggleGlobalBuff(row.id);
    }
  };

  const character = snapshot.characters.find((c) => c.id === calc.characterId);
  const charPresets = character ? presetsForCharacter(character.id) : [];
  const pickedPreset = charPresets.find((p) => p.id === presetId) ?? null;

  const handleLoadPreset = (): void => {
    if (!character || !pickedPreset) return;
    const messages: string[] = [];
    let added = 0;
    for (const spec of presetToBlocks(pickedPreset)) {
      // Snapshot drift must skip loudly: a stale block would throw in scoring.
      if (isBlockStale(character, { ...spec, id: 'preset-load-check' })) {
        messages.push(`skipped stale step ${JSON.stringify(spec.motionName || spec.skillId)}`);
        continue;
      }
      calc.addBlock(spec);
      added += 1;
    }
    messages.unshift(`Loaded ${added} blocks from ${pickedPreset.label} (${pickedPreset.sourceName}).`);
    setPresetMessages(messages);
  };
  const weapon = snapshot.weapons.find((w) => w.id === calc.weaponId);
  const scorable = character?.skills.filter((s) => s.motionValues.length > 0) ?? [];
  // Jiyan's outro is damage (coordinated lance), not a buff carrier — it
  // belongs in neither list (its fixed MV ignores forte levels).
  const buffOnly = character?.skills.filter((s) => isBuffOnlySkill(character.id, s)) ?? [];
  /** Pistols resonators use pistols: the list filters, mismatches warn and block scoring. */
  const usableWeapons = character
    ? snapshot.weapons.filter((w) => w.weaponType === character.weaponType)
    : snapshot.weapons;
  const weaponMismatch =
    character !== undefined && weapon !== undefined && weapon.weaponType !== character.weaponType;

  const characterName = (id: string): string =>
    snapshot.characters.find((c) => c.id === id)?.name ?? id;
  const echoById = new Map(echoes.map((e) => [e.id, e]));
  const picked = calc.echoIds.map((id) => (id === null ? null : (echoById.get(id) ?? null)));
  // Slot-1 echo skill for the rotation's "add Echo skill" panel (only slot
  // 1's skill is usable in combat — reference doc §2).
  const mainEchoSkill = (() => {
    const first = picked[0];
    if (!first) return null;
    const def = findEchoDef(snapshot, first.echoDefId);
    if (!def?.skillDescription) return null;
    return {
      echoName: def.name,
      cooldown: def.skillCooldown,
      hits: parseEchoSkillHits(def.skillDescription),
    };
  })();
  const costTotal = picked.reduce((sum, e) => sum + (e?.cost ?? 0), 0);
  const pickedIds = picked.filter((e) => e !== null).map((e) => e.id);
  const hasDuplicates = new Set(pickedIds).size !== pickedIds.length;

  const handleRosterPick = (pickedId: string): void => {
    if (pickedId === '') return;
    const entry = rosterEntries.find((e) => e.characterId === pickedId);
    if (entry) calc.resetFromRoster(entry);
  };

  const handleCharacterPick = (id: string): void => {
    calc.setCharacterId(id);
    if (id !== '' && calc.weaponId === '') {
      const weaponId = defaultWeaponFor(snapshot, id);
      if (weaponId !== '') calc.setWeaponId(weaponId);
    }
  };

  // Shared rotation context: the live scorer and the optimizer panel read
  // the same roster/enemy so recommendations always match the header DPR.
  const rosterEntry = useMemo(
    () =>
      character && weapon && !weaponMismatch
        ? {
            characterId: character.id,
            level: calc.level,
            ascension: calc.ascension,
            resonanceChain: calc.resonanceChain,
            forteLevels: calc.forteLevels,
            weaponId: weapon.id,
            weaponLevel: calc.weaponLevel,
            weaponRank: calc.weaponRank,
            weaponAscension: calc.weaponAscension,
            forteUnlockedIds: calc.forteUnlockedIds ?? undefined,
          }
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      character?.id, weapon?.id, calc.level, calc.ascension, calc.resonanceChain,
      calc.forteLevels, calc.weaponLevel, calc.weaponRank,
      calc.weaponAscension, calc.forteUnlockedIds,
    ],
  );
  const enemyProfile = useMemo(
    () =>
      character
        ? buildEnemyProfile(calc.enemyKind, calc.enemyLevel, calc.enemyBaseRES, character.attribute)
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [character?.id, calc.enemyKind, calc.enemyLevel, calc.enemyBaseRES],
  );

  // Rotation scoring: gated on character + weapon + 5 distinct echoes
  // (Phase 2 decision — no partial-loadout scores). Domain throws become
  // inline errors; they never crash the page.
  const pickedKey = pickedIds.join(',');
  const scoring = useMemo(() => {
    if (!character || !weapon || !enemyProfile) return null;
    if (weaponMismatch || !rosterEntry) {
      return {
        result: null,
        error: `${character.name} can't use ${weapon.name} — pick a ${character.weaponType}.` as string | null,
      };
    }
    const resolved = picked.map((e) => e);
    if (resolved.some((e) => e === null) || hasDuplicates) return null;
    const combo = resolved.filter((e) => e !== null);
    try {
      const result = calculateRotation({
        character,
        weapon,
        roster: rosterEntry,
        echoes: combo,
        sonataSets: snapshot.sonataSets,
        enemy: enemyProfile,
        blocks: calc.blocks,
        buffs: calc.buffs,
        globalBuffIds: calc.globalBuffIds,
        rotationTime: calc.rotationTime,
        crit: calc.crit,
        resonanceMode: calc.resonanceMode ?? undefined,
        mainEchoId: combo[0].id,
      });
      return { result, error: null as string | null };
    } catch (err) {
      return { result: null, error: err instanceof Error ? err.message : String(err) };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    character?.id, weapon?.id, rosterEntry, enemyProfile, pickedKey,
    calc.blocks, calc.buffs,
    calc.globalBuffIds, calc.rotationTime, calc.crit, calc.resonanceMode,
  ]);

  const resultsById = useMemo(
    () => new Map<string, BlockResult>((scoring?.result?.blocks ?? []).map((b) => [b.id, b])),
    [scoring],
  );
  const echoGateOpen = character !== undefined && weapon !== undefined &&
    (picked.some((e) => e === null) || hasDuplicates);

  return (
    <section>
      <PageHeader
        title="Damage Calculator"
        description="Build a rotation from real kit motions — DPR sums every action, DPS divides by rotation time."
      />

      {calc.draftSource !== null && (
        <Alert tone="info" role="status" className="mt-4">
          Loaded from the shared build “{calc.draftSource}”. This is an unsaved draft: your Roster wasn’t
          changed. Pick your own Echoes below or run the optimizer; “Prefill from roster” switches back.
        </Alert>
      )}

      <Window label="Resonator" title="Resonator" className="mt-6">
      <div className="grid gap-4 md:grid-cols-3">
        <div>
          <label htmlFor="calc-roster" className={labelClass}>
            Prefill from roster
          </label>
          <select
            id="calc-roster"
            value={calc.rosterSourceId}
            onChange={(e) => handleRosterPick(e.target.value)}
            className={`${selectClass} mt-0.5`}
          >
            <option value="">Manual input</option>
            {rosterEntries.map((entry) => (
              <option key={entry.characterId} value={entry.characterId}>
                {characterName(entry.characterId)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="calc-character" className={labelClass}>
            Character
          </label>
          <select
            id="calc-character"
            value={calc.characterId}
            onChange={(e) => handleCharacterPick(e.target.value)}
            className={`${selectClass} mt-0.5`}
          >
            <option value="">Pick a character…</option>
            {snapshot.characters.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="calc-weapon" className={labelClass}>
            Weapon
          </label>
          <select
            id="calc-weapon"
            value={calc.weaponId}
            onChange={(e) => calc.setWeaponId(e.target.value)}
            className={`${selectClass} mt-0.5`}
          >
            <option value="">Pick a weapon…</option>
            {weaponMismatch && weapon && (
              <option value={weapon.id}>{`${weapon.name} (${weapon.weaponType}, wrong type)`}</option>
            )}
            {usableWeapons.map((w) => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </select>
          {weaponMismatch && character && weapon && (
            <p role="alert" className="mt-1 text-xs text-amber">
              {character.name} needs a {character.weaponType} — {weapon.name} is a {weapon.weaponType}.
            </p>
          )}
        </div>
      </div>
      </Window>

      {character === undefined ? (
        <p className="mt-4 border-2 border-dashed border-line-strong bg-panel px-4 py-6 text-center text-sm text-fog">
          Pick a character above — or prefill from your roster — to unlock level and skill inputs.
        </p>
      ) : (
        <Window label="Investment" title="Investment" className="mt-6">
          <div className="grid gap-x-4 gap-y-3 md:grid-cols-2">
            <SliderField
              id="calc-level"
              label="Character level"
              value={calc.level}
              min={1}
              max={90}
              onChange={calc.setLevel}
            />
            <SliderField
              id="calc-weapon-level"
              label="Weapon level"
              value={calc.weaponLevel}
              min={1}
              max={90}
              onChange={calc.setWeaponLevel}
            />
            <SliderField
              id="calc-ascension"
              label="Ascension"
              value={calc.ascension}
              min={0}
              max={6}
              onChange={calc.setAscension}
            />
            <SliderField
              id="calc-chain"
              label="Resonance chain"
              value={calc.resonanceChain}
              min={0}
              max={6}
              onChange={calc.setResonanceChain}
            />
            <SliderField
              id="calc-weapon-rank"
              label="Weapon rank"
              value={calc.weaponRank}
              min={1}
              max={5}
              onChange={calc.setWeaponRank}
            />
            <SliderField
              id="calc-weapon-ascension"
              label="Weapon ascension"
              value={calc.weaponAscension}
              min={0}
              max={6}
              onChange={calc.setWeaponAscension}
            />
            <SliderField
              id="calc-rotation-time"
              label="Rotation time"
              value={calc.rotationTime}
              min={1}
              max={120}
              step={0.5}
              display={`${calc.rotationTime}s`}
              onChange={calc.setRotationTime}
            />
          </div>

          <fieldset className="mt-5">
            <legend className="text-xs text-fog">Skill levels (1-10)</legend>
            <div className="mt-2 grid gap-x-4 gap-y-3 md:grid-cols-2">
              {scorable.map((skill) => (
                <SliderField
                  key={skill.id}
                  id={`calc-forte-${skill.id}`}
                  label={skill.label}
                  value={calc.forteLevels[skill.id] ?? 10}
                  min={1}
                  max={10}
                  onChange={(v) => calc.setForteLevel(skill.id, v)}
                />
              ))}
            </div>
            {buffOnly.length > 0 && (
              <p className="mt-2 text-xs text-fog">
                Buff-only (no damage component — add below as buff carriers):{' '}
                {buffOnly.map((s) => s.label).join(', ')}
              </p>
            )}
          </fieldset>

          {character.forteNodes.length > 0 && (
            <fieldset className="mt-5">
              <legend className="text-xs text-fog">Forte nodes unlocked</legend>
              <div className="mt-2 grid gap-1 md:grid-cols-2">
                {character.forteNodes.map((node) => {
                  const unlocked = calc.forteUnlockedIds === null
                    ? true
                    : calc.forteUnlockedIds.includes(node.id);
                  return (
                    <label key={node.id} className="flex items-center gap-2 text-xs text-fog">
                      <input
                        type="checkbox"
                        checked={unlocked}
                        onChange={() => {
                          const current = calc.forteUnlockedIds === null
                            ? character.forteNodes.map((n) => n.id)
                            : calc.forteUnlockedIds;
                          calc.setForteUnlockedIds(
                            unlocked
                              ? current.filter((id) => id !== node.id)
                              : [...current, node.id],
                          );
                        }}
                      />
                      <span>{node.title}</span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          )}
        </Window>
      )}

      <div className="mt-4">
        <EnemyConfig
          kind={calc.enemyKind}
          level={calc.enemyLevel}
          baseRES={calc.enemyBaseRES}
          onKindChange={calc.setEnemyKind}
          onLevelChange={calc.setEnemyLevel}
          onRESChange={calc.setEnemyBaseRES}
        />
      </div>

      <Window
        label="Echo loadout"
        title="Echo Loadout"
        className="mt-4"
        actions={
          <span
            key={costTotal}
            className={`animate-tt-pop border-2 px-2 py-0.5 text-xs font-medium tnum ${
              costTotal > 12
                ? 'border-ember/40 bg-ember-wash text-ember'
                : costTotal === 12
                  ? 'border-tide/40 bg-tide-wash text-tide'
                  : 'border-line-strong bg-canvas text-fog'
            }`}
          >
            {costTotal}/12 COST
          </span>
        }
      >
        {echoes.length === 0 ? (
          <p className="mt-2 text-xs text-fog">
            No echoes in inventory yet — add some on the Inventory tab first.
          </p>
        ) : (
          <div className="mt-2 grid gap-2 md:grid-cols-2">
            {calc.echoIds.map((id, i) => (
              <div key={i}>
                <label htmlFor={`calc-echo-${i + 1}`} className={labelClass}>
                  {`Echo slot ${i + 1}`}
                </label>
                <select
                  id={`calc-echo-${i + 1}`}
                  value={id ?? ''}
                  onChange={(e) => calc.setEchoSlot(i, e.target.value === '' ? null : e.target.value)}
                  className={`${selectClass} mt-0.5`}
                >
                  <option value="">Empty</option>
                  {echoes.map((e) => (
                    <option key={e.id} value={e.id}>
                      {`${e.label ?? findEchoDef(snapshot, e.echoDefId)?.name ?? e.echoDefId} (cost ${e.cost})`}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        )}
        {hasDuplicates && (
          <p role="alert" className="mt-2 text-xs text-ember">
            The same Echo is picked twice — each Echo can only be equipped once.
          </p>
        )}
        {costTotal > 12 && (
          <p role="alert" className="mt-2 text-xs text-ember">
            Over the 12-cost budget — swap in cheaper Echoes.
          </p>
        )}
      </Window>

      {character !== undefined && weapon !== undefined && (
        <section aria-label="Rotation builder" className="mt-6">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h3 className="font-display text-3xl leading-none font-semibold text-ink">Rotation Builder</h3>
            </div>
            <div className="w-40">
              <label htmlFor="calc-crit" className={labelClass}>
                Crit mode
              </label>
              <select
                id="calc-crit"
                value={calc.crit}
                onChange={(e) => calc.setCrit(e.target.value as CritMode)}
                className={`${selectClass} mt-0.5`}
              >
                <option value="expected">Expected</option>
                <option value="crit">Crit</option>
                <option value="nonCrit">No crit</option>
              </select>
            </div>
          </div>
          {scoring?.error && (
            <Alert tone="danger" className="mt-3">
              {scoring.error}
            </Alert>
          )}
          {echoGateOpen && (
            <p className="mt-3 border-2 border-dashed border-line-strong bg-panel px-3 py-2 text-sm text-fog">
              Pick 5 distinct echoes above to score the rotation — blocks and buffs stay editable meanwhile.
            </p>
          )}
          {teams.length > 0 && (
            <div className="mt-3 flex flex-wrap items-end gap-2 px-card bg-panel p-4">
              <div className="min-w-48 flex-1">
                <label htmlFor="calc-team-import" className={labelClass}>
                  Import Outro / team buffs from a team
                </label>
                <select
                  id="calc-team-import"
                  value={importTeamId}
                  onChange={(e) => setImportTeamId(e.target.value)}
                  className={`${selectClass} mt-0.5`}
                >
                  <option value="">Pick a team…</option>
                  {teams.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                onClick={handleImportTeamBuffs}
                disabled={importTeamId === ''}
                className={btnOutline}
              >
                Import team buffs
              </button>
            </div>
          )}
          {teamWarnings.length > 0 && (
            <p className="mt-2 text-xs text-amber">
              Team import: {teamWarnings.join(' ')}
            </p>
          )}
          {charPresets.length > 0 && (
            <div className="mt-3 px-card bg-panel p-4">
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-48 flex-1">
                  <label htmlFor="calc-preset" className={labelClass}>
                    Load a rotation preset
                  </label>
                  <select
                    id="calc-preset"
                    value={pickedPreset?.id ?? ''}
                    onChange={(e) => {
                      setPresetId(e.target.value);
                      setPresetMessages([]);
                    }}
                    className={`${selectClass} mt-0.5`}
                  >
                    <option value="">Pick a preset…</option>
                    {charPresets.map((p) => (
                      <option key={p.id} value={p.id}>{p.label} ({p.sourceName})</option>
                    ))}
                  </select>
                </div>
                <button
                  type="button"
                  onClick={handleLoadPreset}
                  disabled={!pickedPreset}
                  title="Appends the preset steps as blocks (existing blocks are kept)"
                  className={btnOutline}
                >
                  Load preset
                </button>
              </div>
              {pickedPreset && (
                <p className="mt-2 text-xs text-fog">
                  Source:{' '}
                  <a
                    href={pickedPreset.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-glacio hover:underline"
                  >
                    {pickedPreset.sourceName} guide
                  </a>
                  {pickedPreset.notes ? ` — ${pickedPreset.notes}` : ''}
                </p>
              )}
              {presetMessages.length > 0 && (
                <p className="mt-1 text-xs text-amber">{presetMessages.join(' ')}</p>
              )}
            </div>
          )}
          <div className="mt-2">
            <RotationTimeline
              character={character}
              resonanceChain={calc.resonanceChain}
              forteLevels={calc.forteLevels}
              resonanceMode={calc.resonanceMode}
              onSetResonanceMode={calc.setResonanceMode}
              blocks={calc.blocks}
              buffs={calc.buffs}
              globalBuffIds={calc.globalBuffIds}
              results={resultsById}
              dpr={scoring?.result?.dpr ?? null}
              dps={scoring?.result?.dps ?? null}
              rotationTime={calc.rotationTime}
              weaponRank={calc.weaponRank}
              mainEchoSkill={mainEchoSkill}
              onAddBlock={(skillId, motionName, forteLevel, options) =>
                calc.addBlock({ skillId, motionName, forteLevel, activeBuffIds: [], ...options })}
              onRemoveBlock={calc.removeBlock}
              onMoveBlock={calc.moveBlock}
              onSetBlockForte={calc.setBlockForte}
              onSetBlockStatusStacks={calc.setBlockStatusStacks}
              onSetBlockConviction={calc.setBlockConviction}
              onSetBlockKitState={calc.setBlockKitState}
              onToggleBlockBuff={calc.toggleBlockBuff}
              onToggleGlobalBuff={calc.toggleGlobalBuff}
              onAddBuff={(buff) => calc.addBuff(buff)}
              onRemoveBuff={calc.removeBuff}
              onSetBlockDuration={calc.setBlockDuration}
              onSetBuffWindow={calc.setBuffWindow}
              onClearBuffWindow={calc.clearBuffWindow}
            />
            {(scoring?.result?.warnings.length ?? 0) > 0 && (
              <p className="mt-2 text-xs text-amber">
                {scoring?.result?.warnings.length} unmodeled effect{(scoring?.result?.warnings.length ?? 0) === 1 ? '' : 's'} —
                conditional/custom kit text that never touches the numbers.
              </p>
            )}
            {(scoring?.result?.appliedAssumptions.length ?? 0) > 0 && (
              <p className="mt-2 text-xs text-fog" title={(scoring?.result?.appliedAssumptions ?? []).join('\n')}>
                Assumes: {(scoring?.result?.appliedAssumptions ?? []).join('; ')}
              </p>
            )}
          </div>
          {rosterEntry && enemyProfile && (
            <div className="mt-4">
              <RotationOptimizer
                character={character}
                weapon={weapon}
                roster={rosterEntry}
                echoes={echoes}
                sonataSets={snapshot.sonataSets}
                enemy={enemyProfile}
                enemySettings={{ kind: calc.enemyKind, level: calc.enemyLevel, baseRES: calc.enemyBaseRES }}
                resonanceMode={calc.resonanceMode ?? undefined}
                blocks={calc.blocks}
                buffs={calc.buffs}
                globalBuffIds={calc.globalBuffIds}
                crit={calc.crit}
                currentDpr={scoring?.result?.dpr ?? null}
                rotationTime={calc.rotationTime}
                onApply={(echoIds) => {
                  echoIds.slice(0, 5).forEach((id, i) => calc.setEchoSlot(i, id));
                }}
              />
            </div>
          )}
        </section>
      )}
    </section>
  );
}
