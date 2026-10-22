import { useEffect, useRef, useState } from 'react';

/** True when the OS asks for reduced motion. Live-updates on change. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false,
  );
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (): void => setReduced(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

/**
 * Eased count-up/down toward `target` (cubic out, ~350ms). Settles
 * instantly under reduced motion, without rAF (SSR/tests), or for
 * non-finite targets. Formatting stays at the call site.
 */
export function useAnimatedNumber(target: number, durationMs = 350): number {
  const reduced = usePrefersReducedMotion();
  const [display, setDisplay] = useState(target);
  const fromRef = useRef(target);
  const canAnimate =
    !reduced && Number.isFinite(target) && typeof requestAnimationFrame === 'function';
  // No animation path: sync during render (the endorsed adjust-state
  // pattern — no effect, no cascading render). The ref resyncs in the
  // effect below, where ref writes are allowed.
  if (!canAnimate && display !== target) {
    setDisplay(target);
  }
  useEffect(() => {
    if (!canAnimate) {
      fromRef.current = target;
      return;
    }
    const from = fromRef.current;
    if (from === target) return;
    let frame = 0;
    const start = performance.now();
    const tick = (now: number): void => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - (1 - t) ** 3;
      const value = from + (target - from) * eased;
      fromRef.current = value;
      setDisplay(value);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, durationMs, canAnimate]);
  return display;
}

/**
 * Reveal-on-scroll: `visible` flips true the first time the element enters
 * the viewport. Starts (and stays) visible under reduced motion or without
 * IntersectionObserver (SSR/tests), so content is never stuck hidden.
 */
export function useReveal<T extends Element>(): { ref: (node: T | null) => void; visible: boolean } {
  const reduced = usePrefersReducedMotion();
  const supported = typeof window !== 'undefined' && typeof window.IntersectionObserver === 'function';
  const [seen, setSeen] = useState(false);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const ref = (node: T | null): void => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (node === null || !supported || reduced || seen) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          observer.disconnect();
        }
      },
      { rootMargin: '0px 0px -40px 0px' },
    );
    observer.observe(node);
    observerRef.current = observer;
  };
  return { ref, visible: seen || reduced || !supported };
}

/**
 * Typewriter reveal of `text`, `charsPerTick` characters every `tickMs`.
 * Restarts when the text changes; shows the full text at once under
 * reduced motion or without timers.
 */
export function useTypewriter(text: string, tickMs = 22, charsPerTick = 2): string {
  const reduced = usePrefersReducedMotion();
  const canAnimate = !reduced && typeof setInterval === 'function';
  const [shown, setShown] = useState(canAnimate ? 0 : text.length);
  const [prevText, setPrevText] = useState(text);
  if (prevText !== text) {
    setPrevText(text);
    setShown(canAnimate ? 0 : text.length);
  }
  useEffect(() => {
    if (!canAnimate) return;
    const id = setInterval(() => {
      setShown((n) => {
        const next = Math.min(text.length, n + charsPerTick);
        if (next >= text.length) clearInterval(id);
        return next;
      });
    }, tickMs);
    return () => clearInterval(id);
  }, [text, tickMs, charsPerTick, canAnimate]);
  return canAnimate ? text.slice(0, shown) : text;
}

/**
 * Whole seconds since the calling component mounted, ticking once a second.
 * A main-thread timer: a busy worker can't send a heartbeat. Mount the
 * component only while the run lasts, and the interval is cleared when it
 * ends, errors, is cancelled or the page unmounts. Wall-clock based, so a
 * throttled background tab still shows the right time when it wakes.
 */
export function useElapsedSeconds(): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const id = setInterval(() => setSeconds(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  return seconds;
}

/** "1:23", or "1:02:03" past an hour. */
export function formatElapsed(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const seconds = String(s % 60).padStart(2, '0');
  const minutes = Math.floor(s / 60) % 60;
  const hours = Math.floor(s / 3600);
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}
