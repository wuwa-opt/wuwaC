import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { formatElapsed, useAnimatedNumber, useElapsedSeconds, usePrefersReducedMotion, useReveal, useTypewriter } from './motion.ts';

function mockMatchMedia(matches: boolean): void {
  window.matchMedia = vi.fn().mockReturnValue({
    matches,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('usePrefersReducedMotion', () => {
  it('is false when the OS reports no preference', () => {
    mockMatchMedia(false);
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);
  });

  it('is true when the OS asks for reduced motion', () => {
    mockMatchMedia(true);
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(true);
  });
});

describe('useAnimatedNumber', () => {
  it('returns the target on first render', () => {
    mockMatchMedia(false);
    const { result } = renderHook(() => useAnimatedNumber(1234.5));
    expect(result.current).toBe(1234.5);
  });

  it('settles instantly under reduced motion', () => {
    mockMatchMedia(true);
    const { result, rerender } = renderHook(({ target }: { target: number }) => useAnimatedNumber(target), {
      initialProps: { target: 100 },
    });
    rerender({ target: 250 });
    expect(result.current).toBe(250);
  });
});

describe('useReveal', () => {
  it('is visible immediately without IntersectionObserver', () => {
    mockMatchMedia(false);
    vi.stubGlobal('IntersectionObserver', undefined);
    const { result } = renderHook(() => useReveal<HTMLDivElement>());
    expect(result.current.visible).toBe(true);
  });

  it('is visible immediately under reduced motion', () => {
    mockMatchMedia(true);
    const { result } = renderHook(() => useReveal<HTMLDivElement>());
    expect(result.current.visible).toBe(true);
  });

  it('starts hidden and flips visible once the element intersects', () => {
    mockMatchMedia(false);
    let fire: (entries: { isIntersecting: boolean }[]) => void = () => {};
    const disconnect = vi.fn();
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(cb: typeof fire) {
          fire = cb;
        }
        observe = vi.fn();
        disconnect = disconnect;
      },
    );
    const { result } = renderHook(() => useReveal<HTMLDivElement>());
    expect(result.current.visible).toBe(false);
    act(() => result.current.ref(document.createElement('div')));
    act(() => fire([{ isIntersecting: true }]));
    expect(result.current.visible).toBe(true);
    expect(disconnect).toHaveBeenCalled();
  });
});

describe('useTypewriter', () => {
  it('reveals the text a few characters per tick, then stops at the end', () => {
    mockMatchMedia(false);
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useTypewriter('Hello', 10, 2));
      expect(result.current).toBe('');
      act(() => vi.advanceTimersByTime(10));
      expect(result.current).toBe('He');
      act(() => vi.advanceTimersByTime(20));
      expect(result.current).toBe('Hello');
      act(() => vi.advanceTimersByTime(100));
      expect(result.current).toBe('Hello');
    } finally {
      vi.useRealTimers();
    }
  });

  it('restarts when the text changes', () => {
    mockMatchMedia(false);
    vi.useFakeTimers();
    try {
      const { result, rerender } = renderHook(({ t }) => useTypewriter(t, 10, 2), { initialProps: { t: 'abcd' } });
      act(() => vi.advanceTimersByTime(50));
      expect(result.current).toBe('abcd');
      rerender({ t: 'xyz' });
      expect(result.current).toBe('');
      act(() => vi.advanceTimersByTime(10));
      expect(result.current).toBe('xy');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the full text under reduced motion', () => {
    mockMatchMedia(true);
    const { result } = renderHook(() => useTypewriter('Hello'));
    expect(result.current).toBe('Hello');
  });
});

describe('formatElapsed', () => {
  it('formats m:ss, then h:mm:ss past an hour', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(9)).toBe('0:09');
    expect(formatElapsed(83)).toBe('1:23');
    expect(formatElapsed(600)).toBe('10:00');
    expect(formatElapsed(3723)).toBe('1:02:03');
    expect(formatElapsed(-4)).toBe('0:00');
  });
});

describe('useElapsedSeconds', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts whole seconds from mount and clears its interval on unmount', () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useElapsedSeconds());
    expect(result.current).toBe(0);
    act(() => {
      vi.advanceTimersByTime(3_400);
    });
    expect(result.current).toBe(3);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
