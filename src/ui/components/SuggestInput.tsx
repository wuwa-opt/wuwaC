import { useRef, useState } from 'react';
import { inputClass, labelClass } from './classes.ts';

export interface SuggestOption {
  value: string;
  label: string;
  hint?: string;
}

/**
 * Free-text input with a filterable suggestion popup — a friendlier
 * datalist. The typed text is always the value (unlisted ids stay
 * valid); picking a suggestion just fills it in. Keyboard: Down opens,
 * arrows move, Enter fills, Esc closes. Focus leaving the whole control
 * (e.g. tabbing to the submit button) closes without filling.
 */
export function SuggestInput({
  id,
  label,
  value,
  suggestions,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  suggestions: SuggestOption[];
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);

  const q = value.trim().toLowerCase();
  const matches =
    q === ''
      ? suggestions
      : suggestions.filter((o) => `${o.label} ${o.value} ${o.hint ?? ''}`.toLowerCase().includes(q));
  const current = Math.min(highlight, Math.max(0, matches.length - 1));

  const close = (): void => {
    setOpen(false);
    setHighlight(0);
  };

  const fill = (index: number): void => {
    const option = matches[index];
    if (!option) return;
    onChange(option.value);
    close();
  };

  return (
    <div className="min-w-0">
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      <div
        ref={wrapRef}
        className="relative mt-0.5"
        onBlur={(e) => {
          if (!wrapRef.current?.contains(e.relatedTarget as Node | null)) close();
        }}
      >
        <input
          id={id}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={`${id}-suggestions`}
          aria-activedescendant={open && matches[current] ? `${id}-sug-${matches[current].value}` : undefined}
          autoComplete="off"
          value={value}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(true);
            setHighlight(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              if (!open) {
                setOpen(true);
              } else {
                setHighlight((h) => (matches.length === 0 ? 0 : (h + 1) % matches.length));
              }
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              if (open) {
                setHighlight((h) => (matches.length === 0 ? 0 : (h - 1 + matches.length) % matches.length));
              }
            } else if (e.key === 'Enter') {
              if (open && matches[current]) {
                e.preventDefault();
                fill(current);
              }
            } else if (e.key === 'Escape') {
              e.preventDefault();
              close();
            }
          }}
          className={inputClass}
        />
        {open && (
          <ul
            id={`${id}-suggestions`}
            role="listbox"
            aria-label={`${label} suggestions`}
            className="absolute z-50 mt-1 max-h-56 w-full overflow-y-auto border-2 border-line-strong bg-panel p-1 shadow-lg"
          >
            {matches.length === 0 ? (
              <li className="px-2 py-1.5 text-sm text-fog">No matches — custom ids still work.</li>
            ) : (
              matches.map((option, i) => (
                <li key={option.value}>
                  <button
                    id={`${id}-sug-${option.value}`}
                    type="button"
                    role="option"
                    aria-selected={i === current}
                    onClick={() => fill(i)}
                    onMouseMove={() => {
                      if (i !== highlight) setHighlight(i);
                    }}
                    className={`flex w-full items-baseline justify-between gap-2 px-2 py-1.5 text-left text-sm transition-terminal pointer-coarse:min-h-11 pointer-coarse:items-center ${
                      i === current ? 'bg-panel-2 text-ink' : 'text-fog'
                    }`}
                  >
                    <span className="min-w-0 truncate">{option.label}</span>
                    {option.hint !== undefined && (
                      <span className="shrink-0 text-xs text-fog">
                        {option.hint}
                      </span>
                    )}
                  </button>
                </li>
              ))
            )}
          </ul>
        )}
      </div>
    </div>
  );
}
