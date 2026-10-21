import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  dismissToast,
  dismissToastScope,
  holdToast,
  pushToast,
  resetToastsForTests,
  useToastStore,
  type PushOptions,
  type Toast,
} from './toasts.ts';

/** The toast store with a per-test default delay, shaped like the hook the first version of these tests used. */
function useToasts(defaultMs: number) {
  const toasts = useToastStore((s) => s.toasts);
  return {
    toasts,
    push: (message: string, tone?: Toast['tone'], options: PushOptions = {}) =>
      pushToast(message, tone, { timeoutMs: defaultMs, ...options }),
    dismiss: dismissToast,
    hold: holdToast,
  };
}

afterEach(() => {
  resetToastsForTests();
  vi.useRealTimers();
});

describe('useToasts hold (hover/focus pause)', () => {
  it('pauses the countdown while held and resumes with the time left', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useToasts(1000));
    let id = 0;
    act(() => {
      id = result.current.push('Deleted.', 'success', { timeoutMs: 10_000 });
    });
    act(() => {
      vi.advanceTimersByTime(4000);
      result.current.hold(id, 'hover', true);
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current.toasts).toHaveLength(1);
    act(() => {
      result.current.hold(id, 'hover', false);
    });
    act(() => {
      vi.advanceTimersByTime(5999);
    });
    expect(result.current.toasts).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.toasts).toHaveLength(0);
  });

  it('stays paused until both hover and focus are released', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useToasts(1000));
    let id = 0;
    act(() => {
      id = result.current.push('Deleted.');
    });
    act(() => {
      result.current.hold(id, 'hover', true);
      result.current.hold(id, 'focus', true);
      vi.advanceTimersByTime(500);
      result.current.hold(id, 'hover', false);
    });
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(result.current.toasts).toHaveLength(1);
    act(() => {
      result.current.hold(id, 'focus', false);
      vi.advanceTimersByTime(999);
    });
    expect(result.current.toasts).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.toasts).toHaveLength(0);
  });

  it('dismissing a held toast leaves no timer behind', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useToasts(1000));
    let id = 0;
    act(() => {
      id = result.current.push('Deleted.');
      result.current.hold(id, 'hover', true);
      result.current.dismiss(id);
      result.current.hold(id, 'hover', false); // late event after dismissal: ignored
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('useToasts', () => {
  it('keeps an action toast up for its own, longer delay and returns its id', () => {
    vi.useFakeTimers();
    const onAction = vi.fn();
    const { result } = renderHook(() => useToasts(1000));
    let id = 0;
    act(() => {
      id = result.current.push('Deleted.', 'success', { timeoutMs: 5000, action: { label: 'Undo', onAction } });
    });
    expect(result.current.toasts[0]).toMatchObject({ id, action: { label: 'Undo' } });
    act(() => {
      vi.advanceTimersByTime(4999);
    });
    expect(result.current.toasts).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.toasts).toHaveLength(0);
  });

  it('pushes, dismisses, and auto-expires toasts', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useToasts(1000));
    act(() => {
      result.current.push('Echo saved.');
    });
    expect(result.current.toasts).toHaveLength(1);
    act(() => {
      result.current.dismiss(result.current.toasts[0].id);
    });
    expect(result.current.toasts).toHaveLength(0);

    act(() => {
      result.current.push('Expiring.');
    });
    expect(result.current.toasts).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.toasts).toHaveLength(0);
  });
});

describe('toast store (shared across pages)', () => {
  it('outlives the component that pushed it, and keeps counting down', () => {
    vi.useFakeTimers();
    const page = renderHook(() => useToasts(1000));
    act(() => {
      page.result.current.push('Deleted.', 'success', { timeoutMs: 10_000 });
    });
    page.unmount(); // the page the toast came from is gone
    const host = renderHook(() => useToastStore((s) => s.toasts));
    expect(host.result.current.map((t) => t.message)).toEqual(['Deleted.']);
    act(() => {
      vi.advanceTimersByTime(9999);
    });
    expect(host.result.current).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(host.result.current).toHaveLength(0);
  });

  it('keeps an action callable after the pusher unmounts', () => {
    const onAction = vi.fn();
    const page = renderHook(() => useToasts(1000));
    act(() => {
      page.result.current.push('Gone.', 'success', { action: { label: 'Undo', onAction } });
    });
    page.unmount();
    useToastStore.getState().toasts[0].action?.onAction();
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('shows at most three, and drops the timer of one pushed out', () => {
    vi.useFakeTimers();
    for (const m of ['a', 'b', 'c', 'd']) pushToast(m);
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual(['b', 'c', 'd']);
    expect(vi.getTimerCount()).toBe(3);
  });

  it('dismisses a whole scope and nothing else', () => {
    vi.useFakeTimers();
    pushToast('undo 1', 'success', { scope: 'inventory-undo' });
    pushToast('other');
    pushToast('undo 2', 'success', { scope: 'inventory-undo' });
    dismissToastScope('inventory-undo');
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual(['other']);
    expect(vi.getTimerCount()).toBe(1);
  });
});
