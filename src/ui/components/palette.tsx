import { useEffect, useMemo, useState } from 'react';
import { SECTIONS, useAppStore } from '../../state/store.ts';
import { useThemeStore } from '../../state/theme.ts';

/**
 * Ctrl+K command palette — the terminal earns its name. Sections plus a
 * theme toggle, fuzzy-filtered, fully keyboard driven (arrows + Enter,
 * Esc closes). Rendered by App; `open` state lives there.
 */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const setActiveSection = useAppStore((s) => s.setActiveSection);
  const toggleTheme = useThemeStore((s) => s.toggleTheme);

  const actions = useMemo(() => {
    const items = [
      ...SECTIONS.map((s) => ({
        id: `go:${s.id}` as const,
        label: `Go to ${s.label}`,
        hint: s.blurb,
        run: () => setActiveSection(s.id),
      })),
      {
        id: 'theme' as const,
        label: 'Toggle theme',
        hint: 'Light / Dark',
        run: () => toggleTheme(),
      },
    ];
    const q = query.trim().toLowerCase();
    if (q === '') return items;
    return items.filter((a) => `${a.label} ${a.hint}`.toLowerCase().includes(q));
  }, [query, setActiveSection, toggleTheme]);

  // Fresh query on every open, synced during render (adjust-state
  // pattern) instead of an effect.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    setQuery('');
    setHighlight(0);
  }

  // The page behind doesn't scroll while the palette is up (touch drags
  // went through to it).
  useEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    root.classList.add('scroll-locked');
    return () => root.classList.remove('scroll-locked');
  }, [open]);

  if (!open) return null;
  const current = Math.min(highlight, Math.max(0, actions.length - 1));

  const run = (index: number): void => {
    const action = actions[index];
    if (!action) return;
    action.run();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]">
      <button
        type="button"
        aria-label="Close command palette"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-ink/30"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="animate-tt-toast relative w-full max-w-md overflow-hidden border-2 border-line-strong bg-panel shadow-xl"
      >
        <input
          autoFocus
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-listbox"
          aria-activedescendant={actions[current] ? `palette-${actions[current].id}` : undefined}
          aria-label="Type a command"
          placeholder="Type a command…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setHighlight(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setHighlight((h) => (actions.length === 0 ? 0 : (h + 1) % actions.length));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setHighlight((h) =>
                actions.length === 0 ? 0 : (h - 1 + actions.length) % actions.length,
              );
            } else if (e.key === 'Enter') {
              e.preventDefault();
              run(current);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            }
          }}
          className="w-full border-b border-line bg-panel px-4 py-3 text-sm text-ink outline-none placeholder:text-fog"
        />
        <ul id="palette-listbox" role="listbox" aria-label="Commands" className="max-h-64 overflow-y-auto overscroll-contain p-1.5">
          {actions.length === 0 ? (
            <li className="px-3 py-2 text-sm text-fog">No matching command.</li>
          ) : (
            actions.map((action, i) => (
              <li key={action.id}>
                <button
                  id={`palette-${action.id}`}
                  type="button"
                  role="option"
                  aria-selected={i === current}
                  onClick={() => run(i)}
                  onMouseMove={() => {
                    if (i !== highlight) setHighlight(i);
                  }}
                  className={`flex w-full items-baseline justify-between gap-3 px-3 py-2 text-left text-sm transition-terminal ${
                    i === current ? 'bg-panel-2 text-ink' : 'text-fog'
                  }`}
                >
                  <span className="font-medium">{action.label}</span>
                  <span className="shrink-0 text-xs text-fog">
                    {action.hint}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
