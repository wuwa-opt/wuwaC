import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useScreenWakeLock } from './wakeLock.ts';

interface FakeSentinel {
  released: boolean;
  release: () => Promise<void>;
}

/** A fake `navigator.wakeLock` whose sentinels the test can inspect (and drop, as the browser does on hide). */
function installWakeLock(refuse = false): { request: ReturnType<typeof vi.fn>; sentinels: FakeSentinel[] } {
  const sentinels: FakeSentinel[] = [];
  const request = vi.fn(() => {
    if (refuse) return Promise.reject(new DOMException('battery saver', 'NotAllowedError'));
    const sentinel: FakeSentinel = {
      released: false,
      release: vi.fn(() => {
        sentinel.released = true;
        return Promise.resolve();
      }),
    };
    sentinels.push(sentinel);
    return Promise.resolve(sentinel);
  });
  Object.defineProperty(navigator, 'wakeLock', { value: { request }, configurable: true });
  return { request, sentinels };
}

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

afterEach(() => {
  delete (navigator as { wakeLock?: unknown }).wakeLock;
  delete (document as { visibilityState?: unknown }).visibilityState;
});

describe('useScreenWakeLock', () => {
  it('holds a screen lock while active and releases it when the scan ends', async () => {
    const { request, sentinels } = installWakeLock();
    const { rerender } = renderHook(({ active }) => useScreenWakeLock(active), { initialProps: { active: false } });
    expect(request).not.toHaveBeenCalled();

    rerender({ active: true });
    await act(async () => {});
    expect(request).toHaveBeenCalledWith('screen');
    expect(sentinels).toHaveLength(1);

    rerender({ active: false });
    expect(sentinels[0].released).toBe(true);
  });

  it('asks again when the page is visible again (the browser drops the lock on hide)', async () => {
    const { request, sentinels } = installWakeLock();
    renderHook(() => useScreenWakeLock(true));
    await act(async () => {});
    expect(request).toHaveBeenCalledTimes(1);

    sentinels[0].released = true;
    await act(async () => setVisibility('hidden'));
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => setVisibility('visible'));
    expect(request).toHaveBeenCalledTimes(2);
    // Still held: a second visibilitychange does not stack locks.
    await act(async () => setVisibility('visible'));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('releases a lock that arrives after the scan already ended', async () => {
    const { sentinels } = installWakeLock();
    const { unmount } = renderHook(() => useScreenWakeLock(true));
    unmount();
    await act(async () => {});
    expect(sentinels[0].released).toBe(true);
  });

  it('does nothing without the API, and a refused request is not an error', async () => {
    expect(() => renderHook(() => useScreenWakeLock(true))).not.toThrow();
    const { request } = installWakeLock(true);
    renderHook(() => useScreenWakeLock(true));
    await act(async () => {});
    expect(request).toHaveBeenCalledTimes(1);
  });
});
