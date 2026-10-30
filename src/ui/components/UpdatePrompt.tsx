import { useRegisterSW } from 'virtual:pwa-register/react';
import { btnGhost, btnPrimary, btnSm } from './classes.ts';

/**
 * Service-worker update banner (hosted build only). A new deploy waits
 * until the user reloads, so an open tab never mixes old and new chunks.
 */
export function UpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  if (!needRefresh) return null;
  return (
    <div
      role="status"
      className="animate-tt-toast fixed inset-x-4 top-[calc(0.75rem+env(safe-area-inset-top))] z-50 mx-auto flex max-w-md flex-wrap items-center gap-2 border-2 border-line-strong bg-panel px-3 py-2 text-sm text-ink shadow-lg"
    >
      <span className="min-w-0 flex-1">A new version of WuWa Optimizer is available.</span>
      <button type="button" className={`${btnPrimary} ${btnSm}`} onClick={() => void updateServiceWorker(true)}>
        Reload
      </button>
      <button type="button" className={`${btnGhost} ${btnSm}`} onClick={() => setNeedRefresh(false)}>
        Later
      </button>
    </div>
  );
}
