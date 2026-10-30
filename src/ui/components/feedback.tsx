import type { CSSProperties } from 'react';
import { formatElapsed, useAnimatedNumber, useElapsedSeconds } from '../motion.ts';
import type { HoldReason, Toast } from '../toasts.ts';

/* Live-feedback primitives: animated readouts, bars, skeletons, toasts.
 * All motion degrades to instant under reduced motion (see motion.ts +
 * index.css); tests cover the settled states, not the frames. */

/** Count-up/down readout. `format` turns the eased value into text. */
export function AnimatedNumber({
  value,
  format = (n) => Math.round(n).toLocaleString(),
  className = '',
  label,
}: {
  value: number;
  format?: (n: number) => string;
  className?: string;
  label?: string;
}) {
  const display = useAnimatedNumber(value);
  return (
    <span aria-label={label} className={`tnum ${className}`}>
      {format(display)}
    </span>
  );
}

/** +/- percent chip vs the previous value (tide up, ember down, dim flat). */
export function DeltaChip({ current, previous }: { current: number; previous: number }) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  const pct = ((current - previous) / Math.abs(previous)) * 100;
  if (Math.abs(pct) < 0.05) return null;
  const up = pct > 0;
  return (
    <span
      className={`px-1 py-px text-xs font-medium tnum ${
        up ? 'bg-tide-wash text-tide' : 'bg-ember-wash text-ember'
      }`}
    >
      {up ? '▲' : '▼'} {Math.abs(pct).toFixed(1)}%
    </span>
  );
}

/** Damage/score share bar. Width eases via `.score-bar-fill` (CSS-gated). */
export function ScoreBar({ share, className = '' }: { share: number; className?: string }) {
  return (
    <div className={`h-1 rounded-full bg-panel-3 ${className}`} aria-hidden="true">
      <div
        className="score-bar-fill h-1 rounded-full bg-seal"
        style={{ width: `${Math.max(0, Math.min(100, share))}%` }}
      />
    </div>
  );
}

/**
 * Proof of life for a long run: a row of pixel blocks that chase left to
 * right (still under reduced motion) and "Running for m:ss". Purely visual
 * (`aria-hidden`); the caller owns the live region. Mount it only while the
 * run lasts; unmounting stops its timer.
 */
export function RunClock({ className = '' }: { className?: string }) {
  const seconds = useElapsedSeconds();
  return (
    <span aria-hidden="true" className={`inline-flex items-center gap-2 ${className}`}>
      <span className="inline-flex gap-0.5 border-2 border-outline bg-panel p-0.5">
        {Array.from({ length: 8 }, (_, i) => (
          <span key={i} style={{ '--i': i } as CSSProperties} className="px-activity h-[10px] w-[6px] bg-meter" />
        ))}
      </span>
      <span className="tnum">Running for {formatElapsed(seconds)}</span>
    </span>
  );
}

/** Loading placeholder: shimmer rows + screen-reader text. */
export function Skeleton({
  lines = 3,
  className = '',
}: {
  lines?: number;
  className?: string;
}) {
  return (
    <div role="status" aria-label="Loading" className={`space-y-2 ${className}`}>
      <span className="sr-only">Loading…</span>
      {Array.from({ length: lines }, (_, i) => (
        <div
          key={i}
          aria-hidden="true"
          className="skeleton h-12"
          style={{ width: `${100 - (i % 3) * 7}%` }}
        />
      ))}
    </div>
  );
}

const TOAST_STYLES: Record<Toast['tone'], string> = {
  success: 'border-tide/40 bg-panel text-ink',
  info: 'border-line-strong bg-panel text-ink',
  danger: 'border-ember/40 bg-panel text-ink',
};

const TOAST_DOT: Record<Toast['tone'], string> = {
  success: 'bg-tide',
  info: 'bg-seal',
  danger: 'bg-ember',
};

/**
 * An action toast usually follows deleting the control that had focus, which
 * strands keyboard focus on <body>. Then (and only then) hand it to the action.
 */
function focusIfStranded(button: HTMLButtonElement | null): void {
  if (button !== null && (document.activeElement === null || document.activeElement === document.body)) {
    button.focus();
  }
}

/** Fixed bottom-right toast stack. */
export function ToastStack({
  toasts,
  onDismiss,
  onHold,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
  /** Pause/resume a toast's auto-dismiss while it is hovered or has focus. */
  onHold?: (id: number, reason: HoldReason, held: boolean) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div aria-live="polite" className="fixed inset-x-4 bottom-20 z-50 flex flex-col gap-2 sm:inset-x-auto sm:right-4 sm:w-72 md:bottom-4">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role={toast.tone === 'danger' ? 'alert' : 'status'}
          onMouseEnter={() => onHold?.(toast.id, 'hover', true)}
          onMouseLeave={() => onHold?.(toast.id, 'hover', false)}
          onFocus={() => onHold?.(toast.id, 'focus', true)}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onHold?.(toast.id, 'focus', false);
          }}
          className={`animate-tt-toast flex items-center gap-2 border-2 px-3 py-2 text-sm shadow-lg ${TOAST_STYLES[toast.tone]}`}
        >
          <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${TOAST_DOT[toast.tone]}`} />
          <span className="min-w-0 flex-1">{toast.message}</span>
          {toast.action !== undefined && (
            <button
              type="button"
              ref={focusIfStranded}
              onClick={toast.action.onAction}
              className="shrink-0 border-2 border-line-strong px-2 py-0.5 text-xs font-bold text-accent-text hover:bg-panel-2 pointer-coarse:min-h-11 pointer-coarse:px-3 pointer-coarse:text-sm"
            >
              {toast.action.label}
            </button>
          )}
          <button
            type="button"
            onClick={() => onDismiss(toast.id)}
            aria-label={`Dismiss: ${toast.message}`}
            className="shrink-0 px-1 text-xs text-fog hover:text-ink pointer-coarse:min-h-11 pointer-coarse:min-w-11"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
