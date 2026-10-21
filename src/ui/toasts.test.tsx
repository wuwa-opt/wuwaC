import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useToasts } from './toasts.ts';

afterEach(() => {
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
