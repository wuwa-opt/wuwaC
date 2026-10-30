import { create } from 'zustand';

export interface Toast {
  id: number;
  message: string;
  tone: 'success' | 'info' | 'danger';
  /** Optional button (e.g. Undo). Activating it is the caller's job to follow with `dismissToast`. */
  action?: { label: string; onAction: () => void };
}

export interface PushOptions {
  action?: Toast['action'];
  /** Overrides the default auto-dismiss delay for this toast. */
  timeoutMs?: number;
  /**
   * Group tag for `dismissToastScope` (e.g. Undo offers tied to the inventory
   * generation). Never rendered.
   */
  scope?: string;
}

/** Default auto-dismiss delay. */
export const TOAST_MS = 4000;

/** Long enough to find and press an Undo button, keyboard or pointer. */
export const UNDO_TOAST_MS = 10_000;

/** Scope of Undo offers that are only valid for one loaded inventory (see `ToastHost`). */
export const INVENTORY_UNDO_SCOPE = 'inventory-undo';

/** Scope of Undo offers that are only valid for one loaded build library (see `ToastHost`). */
export const LIBRARY_UNDO_SCOPE = 'library-undo';

export type HoldReason = 'hover' | 'focus';

interface Timer {
  handle: ReturnType<typeof setTimeout> | null;
  /** Ms left when the timer was last (re)started. */
  remaining: number;
  startedAt: number;
  holds: Set<HoldReason>;
  scope: string | undefined;
}

interface ToastState {
  toasts: Toast[];
}

/**
 * The one toast list, rendered once by `ToastHost` at the app shell, so a
 * toast (an Undo included) outlives the page that raised it. Timers live
 * here, not in a component: switching sections neither drops nor restarts
 * them. While a toast is held (hovered or focused, via `holdToast`) its
 * countdown pauses and resumes with the time it had left (WCAG 2.2.1).
 */
export const useToastStore = create<ToastState>()(() => ({ toasts: [] }));

const timers = new Map<number, Timer>();
let nextId = 1;

export function dismissToast(id: number): void {
  const timer = timers.get(id);
  if (timer !== undefined) {
    if (timer.handle !== null) clearTimeout(timer.handle);
    timers.delete(id);
  }
  useToastStore.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

/** Show a toast; resolves to its id (for `dismissToast` from an action). At most 3 stay on screen. */
export function pushToast(message: string, tone: Toast['tone'] = 'success', options: PushOptions = {}): number {
  const id = nextId++;
  useToastStore.setState((s) => ({ toasts: [...s.toasts.slice(-2), { id, message, tone, action: options.action }] }));
  const remaining = options.timeoutMs ?? TOAST_MS;
  timers.set(id, {
    handle: setTimeout(() => dismissToast(id), remaining),
    remaining,
    startedAt: Date.now(),
    holds: new Set(),
    scope: options.scope,
  });
  // A toast pushed out of the stack of three is gone; its timer must go too.
  const live = new Set(useToastStore.getState().toasts.map((t) => t.id));
  for (const [timerId, timer] of timers) {
    if (!live.has(timerId)) {
      if (timer.handle !== null) clearTimeout(timer.handle);
      timers.delete(timerId);
    }
  }
  return id;
}

export function holdToast(id: number, reason: HoldReason, held: boolean): void {
  const timer = timers.get(id);
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
    timer.handle = setTimeout(() => dismissToast(id), timer.remaining);
  }
}

/** Dismiss every toast pushed with `scope`. */
export function dismissToastScope(scope: string): void {
  for (const [id, timer] of [...timers]) if (timer.scope === scope) dismissToast(id);
}

/** Test-only: drop every toast and timer. */
export function resetToastsForTests(): void {
  for (const timer of timers.values()) if (timer.handle !== null) clearTimeout(timer.handle);
  timers.clear();
  useToastStore.setState({ toasts: [] });
}
