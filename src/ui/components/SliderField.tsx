interface SliderFieldProps {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Text shown next to the label (e.g. "90" or "10%"). Defaults to the value. */
  display?: string;
  onChange: (value: number) => void;
}

/**
 * Slider + synced number input. The slider is the primary control (spec:
 * level sliders 1-90, skill sliders 1-10); the number field covers
 * out-of-range typing and screen-reader users. Invalid text is ignored —
 * the last valid value stays, matching `RosterPage` behavior.
 */
export function SliderField({ id, label, value, min, max, step = 1, display, onChange }: SliderFieldProps) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="block text-xs font-medium text-fog">
        <span className="flex items-baseline justify-between gap-2">
          <span className="min-w-0 truncate">{label}</span>
          <span className="shrink-0 font-display text-xl leading-none font-semibold text-accent-text tnum" aria-hidden="true">
            {display ?? value}
          </span>
        </span>
      </label>
      <div className="mt-1.5 flex items-center gap-2">
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="terminal-range min-w-0 flex-1"
        />
        <input
          aria-label={`${label} (exact value)`}
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => {
            if (e.target.value.trim() === '') return;
            const num = Number(e.target.value);
            if (!Number.isFinite(num)) return;
            onChange(num);
          }}
          className="min-h-9 pointer-coarse:min-h-11 w-20 shrink-0 border-2 border-line-strong bg-canvas px-2 py-1 text-xs text-ink tnum transition-terminal hover:border-fog focus:border-seal"
        />
      </div>
    </div>
  );
}
