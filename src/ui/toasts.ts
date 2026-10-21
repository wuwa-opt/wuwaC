import { useEffect, useRef, useState } from 'react';

export interface Toast {
  id: number;
  message: string;
  tone: 'success' | 'info' | 'danger';
  /** Optional button (e.g. Undo). Activating it is the caller's job to follow with `dismiss`. */
  action?: { label: string; onAction: () => void };
}

export interface PushOptions {
  action?: Toast['action'];
  /** Overrides the hook's auto-dismiss delay for this toast. */
  timeoutMs?: number;
}

/** Long enough to find and press an Undo button, keyboard or pointer. */
export const UNDO_TOAST_MS = 10_000;

export type HoldReason = 'hover' | 'focus';

interface Timer {
  handle: ReturnType<typeof setTimeout> | null;
  /** Ms left when the timer was last (re)started. */
  remaining: number;
  startedAt: number;
  holds: Set<HoldReason>;
}

/**
 * Toast list with auto-dismiss. Timers clear on unmount. While a toast is
 * held (hovered or focused, via `hold`) its countdown pauses and resumes
 * with the time it had left (WCAG 2.2.1).
 */
export function useToasts(timeoutMs = 4000): {
  toasts: Toast[];
  push: (message: string, tone?: Toast['tone'], options?: PushOptions) => number;
  dismiss: (id: number) => void;
  hold: (id: number, reason: HoldReason, held: boolean) => void;
} {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, Timer>());

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) if (timer.handle !== null) clearTimeout(timer.handle);
      pending.clear();
    };
  }, []);

  const dismiss = (id: number): void => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      if (timer.handle !== null) clearTimeout(timer.handle);
      timers.current.delete(id);
    }
    setToasts((current) => current.filter((t) => t.id !== id));
  };

  const push = (message: string, tone: Toast['tone'] = 'success', options: PushOptions = {}): number => {
    const id = nextId.current++;
    setToasts((current) => [...current.slice(-2), { id, message, tone, action: options.action }]);
    const remaining = options.timeoutMs ?? timeoutMs;
    timers.current.set(id, {
      handle: setTimeout(() => dismiss(id), remaining),
      remaining,
      startedAt: Date.now(),
      holds: new Set(),
    });
    return id;
  };

  const hold = (id: number, reason: HoldReason, held: boolean): void => {
    const timer = timers.current.get(id);
    if (timer === undefined) return;
    const wasHeld = timer.holds.size > 0;
    if (held) timer.holds.add(reason);
    else timer.holds.delete(reason);
    const isHeld = timer.holds.size > 0;
    if (!wasHeld && isHeld) {
      if (timer.handle !== null) clearTimeout(timer.handle);
      timer.handle = null;
      timer.remaining = Math.max(0, timer.remaining - (Date.now() - timer.startedAt));
    } else if (wasHeld && !isHeld) {
      timer.startedAt = Date.now();
      timer.handle = setTimeout(() => dismiss(id), timer.remaining);
    }
  };

  return { toasts, push, dismiss, hold };
}
