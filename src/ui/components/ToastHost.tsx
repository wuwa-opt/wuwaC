import { useEffect } from 'react';
import { useInventoryStore } from '../../state/inventory.ts';
import { useLibraryStore } from '../../state/library.ts';
import {
  dismissToast,
  dismissToastScope,
  holdToast,
  INVENTORY_UNDO_SCOPE,
  LIBRARY_UNDO_SCOPE,
  useToastStore,
} from '../toasts.ts';
import { ToastStack } from './feedback.tsx';

/**
 * The single toast outlet, mounted once at the app shell (never per page), so
 * toasts and their Undo buttons survive a section switch.
 *
 * An inventory Undo is only valid for the inventory it was issued under: a
 * `load()` (backup restore) bumps `generation`, and every toast in
 * `INVENTORY_UNDO_SCOPE` goes with it. A section switch doesn't reload the
 * inventory, so it doesn't. The build library works the same way
 * (`LIBRARY_UNDO_SCOPE`, library `generation`).
 */
export function ToastHost() {
  const toasts = useToastStore((s) => s.toasts);
  const generation = useInventoryStore((s) => s.generation);
  useEffect(() => {
    dismissToastScope(INVENTORY_UNDO_SCOPE);
  }, [generation]);
  const libraryGeneration = useLibraryStore((s) => s.generation);
  useEffect(() => {
    dismissToastScope(LIBRARY_UNDO_SCOPE);
  }, [libraryGeneration]);
  return <ToastStack toasts={toasts} onDismiss={dismissToast} onHold={holdToast} />;
}
