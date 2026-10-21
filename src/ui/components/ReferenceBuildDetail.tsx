import { useMemo } from 'react';
import type { Build, SharedBuild, Snapshot } from '../../data/schema.ts';
import { viewSharedBuild } from '../../state/share.ts';
import { SharedBuildCard } from './SharedBuildCard.tsx';

/**
 * Expanded view of a saved reference build: the share-link payload kept on the
 * build, shown with the same card as the link preview. Its Echoes never touch
 * the inventory, so nothing here is looked up there. Mounted only while the
 * card is open, so the view (which computes a stat sheet) is not built for
 * every saved build on each render.
 */
export function ReferenceBuildDetail({
  id,
  build,
  reference,
  snapshot,
}: {
  /** DOM id, so the toggle button can point at this region. */
  id: string;
  build: Build;
  reference: SharedBuild;
  snapshot: Snapshot;
}) {
  const view = useMemo(() => viewSharedBuild(reference, snapshot), [reference, snapshot]);
  return (
    <div id={id} role="region" aria-label={`Details for ${build.name}`} className="mt-3 border-t-2 border-dashed border-line pt-3">
      <SharedBuildCard shared={reference} view={view} snapshot={snapshot} hideTitle />
    </div>
  );
}
