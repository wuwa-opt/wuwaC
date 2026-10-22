import { MAX_ENEMY_LEVEL, MAX_ENEMY_RES, type EnemySettings } from '../../domain/enemy.ts';
import { SliderField } from './SliderField.tsx';
import { inputClass, labelClass } from './classes.ts';
import { Window } from './ui.tsx';

interface EnemyConfigProps extends EnemySettings {
  onKindChange: (kind: EnemySettings['kind']) => void;
  onLevelChange: (level: number) => void;
  onRESChange: (res: number) => void;
}

/**
 * Enemy inputs: kind preset + level slider + base-resistance slider.
 * Percent UI, decimal state (0.10 = 10%). Sliders clamp; the store clamps
 * again so typed values can never escape range.
 */
export function EnemyConfig({ kind, level, baseRES, onKindChange, onLevelChange, onRESChange }: EnemyConfigProps) {
  return (
    <Window title="Enemy Config" bar="b">
      <div className="grid gap-4 md:grid-cols-3">
        <div>
          <label htmlFor="calc-enemy-kind" className={labelClass}>
            Enemy kind
          </label>
          <select
            id="calc-enemy-kind"
            value={kind}
            onChange={(e) => onKindChange(e.target.value as 'mob' | 'boss')}
            className={`${inputClass} mt-1.5`}
          >
            <option value="mob">Mob (10% base)</option>
            <option value="boss">Boss (40% in element)</option>
          </select>
        </div>
        <SliderField
          id="calc-enemy-level"
          label="Enemy level"
          value={level}
          min={1}
          max={MAX_ENEMY_LEVEL}
          onChange={onLevelChange}
        />
        <SliderField
          id="calc-enemy-res"
          label="Base resistance"
          value={Math.round(baseRES * 100)}
          min={0}
          max={Math.round(MAX_ENEMY_RES * 100)}
          display={`${Math.round(baseRES * 100)}%`}
          onChange={(pct) => onRESChange(pct / 100)}
        />
      </div>
    </Window>
  );
}
