import { useEffect } from 'react';

/**
 * Keep the screen on while `active` (Screen Wake Lock API). A scan on a
 * phone can take longer than the recording itself (about 1.6× its length
 * with the CPU slowed 4×, 2026-10-30), and a sleeping screen hides the
 * page, which pauses the video walk. Also held while a Calculator search
 * or a Team allocation runs (minutes on a phone without a Sonata lock).
 *
 * The browser drops the lock whenever the page is hidden, so it is asked
 * for again each time the page is visible while still active. Where the
 * API is missing or the request is refused (battery saver, no user
 * gesture yet), nothing happens: the scan still runs, the screen may
 * sleep.
 */
export function useScreenWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return;
    let held: WakeLockSentinel | null = null;
    let disposed = false;
    const acquire = (): void => {
      if (document.visibilityState !== 'visible' || (held !== null && !held.released)) return;
      navigator.wakeLock.request('screen').then(
        (sentinel) => {
          if (disposed) sentinel.release().catch(() => undefined);
          else held = sentinel;
        },
        () => undefined,
      );
    };
    acquire();
    document.addEventListener('visibilitychange', acquire);
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', acquire);
      if (held !== null && !held.released) held.release().catch(() => undefined);
    };
  }, [active]);
}
