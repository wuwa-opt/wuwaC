/* Shared Pixel Arcade class strings. Kept separate from ui.tsx so that file
 * only exports components (react-refresh rule). Frames, buttons and their
 * variants are defined in src/index.css (`px-*`). */

export const labelClass = 'block text-xs font-bold text-fog';

/* Touch screens (`pointer-coarse:`) get 44 px targets throughout (WCAG 2.5.5);
 * mouse layouts keep their density. */
export const inputClass =
  'w-full min-h-9 pointer-coarse:min-h-11 border-2 border-line-strong bg-canvas px-2.5 py-1.5 text-sm text-ink transition-terminal placeholder:text-fog hover:border-fog focus:border-outline';

export const selectClass = inputClass;

/* Layout/typography for every button; the frame comes from `px-button`. */
export const btnBase =
  'inline-flex min-h-10 pointer-coarse:min-h-11 items-center justify-center gap-1.5 px-3 py-1.5 font-display text-base font-semibold disabled:cursor-not-allowed disabled:opacity-50';

export const btnPrimary = `${btnBase} px-button px-button-primary`;

/** Secondary: panel fill. */
export const btnOutline = `${btnBase} px-button`;

/** Edit-style cyan fill. */
export const btnCyan = `${btnBase} px-button px-button-cyan`;

/** Flat text button for dense inline actions — no frame. */
export const btnGhost = `${btnBase} font-sans text-sm font-bold text-fog transition-terminal hover:bg-panel-2 hover:text-ink`;

export const btnDangerGhost = `${btnBase} px-button px-button-danger`;

export const btnSm = 'min-h-9 pointer-coarse:min-h-11 pointer-coarse:min-w-11 px-2 py-1 text-sm';

/** Square filter chip: 2px border, accent fill when active. */
export const chipClass = (active: boolean): string =>
  `min-h-9 pointer-coarse:min-h-11 pointer-coarse:min-w-11 border-2 px-2.5 py-1 text-xs font-bold tnum transition-terminal ${
    active ? 'border-outline bg-seal text-seal-ink' : 'border-line-strong text-fog hover:bg-panel-2'
  }`;
