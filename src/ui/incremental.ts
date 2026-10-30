import { useCallback, useEffect, useState } from 'react';

/**
 * Incremental list rendering: the first `step` items at once, `step` more
 * each time a sentinel after the last row nears the viewport (or `more()`
 * is called, e.g. from a "Show more" button), starting over when `resetKey`
 * changes (a new filter).
 *
 * Why: the Inventory rendered every Echo at once. With 700 Echoes that is
 * ~27 000 DOM nodes; on a phone with the CPU slowed 4× the first style pass
 * alone took 3.3 s and the switch back to the page froze it for ~5 s
 * (2026-10-30, `.agents/plans/2026-10-30-agents/reports/mobile-audit.md`).
 * CSS containment (`content-visibility`) didn't help: the cost is the
 * first style pass over the nodes, so the fix is fewer nodes.
 *
 * Without IntersectionObserver (old browsers, jsdom) only `more()` grows
 * the list.
 */
export function useIncrementalCount(
  total: number,
  resetKey: string,
  step: number,
): { count: number; more: () => void; sentinelRef: (node: HTMLElement | null) => void } {
  const [state, setState] = useState({ key: resetKey, count: step });
  // Reset during render (not in an effect) so a new filter never paints the old count.
  let count = state.count;
  if (state.key !== resetKey) {
    count = step;
    setState({ key: resetKey, count: step });
  }
  const more = useCallback(() => setState((s) => ({ ...s, count: s.count + step })), [step]);

  const [sentinel, setSentinel] = useState<HTMLElement | null>(null);
  const shown = Math.min(count, total);
  useEffect(() => {
    if (sentinel === null || shown >= total || typeof IntersectionObserver === 'undefined') return;
    // A fresh observer per growth: observe() reports the current state at
    // once, so a sentinel still in range after a batch asks for the next one.
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) more();
      },
      // About two phone screens ahead, so rows are there before the thumb is.
      { rootMargin: '0px 0px 1600px 0px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [sentinel, shown, total, more]);

  return { count: shown, more, sentinelRef: setSentinel };
}
