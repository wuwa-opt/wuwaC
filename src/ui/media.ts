import { useSyncExternalStore } from 'react';

/**
 * Live `matchMedia(query).matches`. False where matchMedia is missing
 * (jsdom, SSR), so tests get the wide layout unless they stub it.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches,
    () => false,
  );
}

/** Below Tailwind's `lg`: the Inventory's Status window becomes a bottom sheet. */
export const NARROW_QUERY = '(max-width: 1023.98px)';
