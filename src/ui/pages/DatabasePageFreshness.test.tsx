import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { writeCachedSnapshot } from '../../data/activeSnapshot.ts';
import { buildGamedataPublication } from '../../data/gamedataPublication.ts';
import { loadBundledSnapshot } from '../../data/index.ts';
import { db } from '../../state/db.ts';
import { resetSnapshotStoreForTests } from '../../state/snapshotStore.ts';
import { DatabasePage } from './DatabasePage.tsx';
import { ToastHost } from '../components/ToastHost.tsx';
import { resetToastsForTests } from '../toasts.ts';

/**
 * Database freshness affordance: which snapshot is active (cached vs
 * bundled date) and the manual "Check for updates" control, which reads
 * the same-origin publication. The suite's fetch stub (offline) stands
 * unless a test overrides it — never real network.
 */

vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(console, 'info').mockImplementation(() => {});

/**
 * Serve `snapshot` as the same-origin game-data publication (stub fetch).
 * `failFirst` drops the first manifest request (the page's own background
 * check on mount), so a test can exercise the manual check alone.
 */
function servePublication(snapshot: unknown, { failFirst = false } = {}): void {
  const { manifest, payload } = buildGamedataPublication(snapshot);
  let manifestRequests = 0;
  vi.stubGlobal('fetch', (url: string) => {
    if (url === `${import.meta.env.BASE_URL}gamedata/manifest.json`) {
      manifestRequests += 1;
      if (failFirst && manifestRequests === 1) return Promise.reject(new Error('offline for a moment'));
      return Promise.resolve(new Response(JSON.stringify(manifest)));
    }
    if (url === `${import.meta.env.BASE_URL}${manifest.path}`) return Promise.resolve(new Response(payload));
    return Promise.resolve(new Response('not found', { status: 404 }));
  });
}

beforeEach(async () => {
  resetToastsForTests();
  await db.gamedataCache.clear();
  resetSnapshotStoreForTests();
});

describe('DatabasePage freshness', () => {
  it('shows the bundled source pill with an empty cache', async () => {
    render(<><DatabasePage /><ToastHost /></>);
    expect(await screen.findByText(/^Bundled · /)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /check for updates/i })).toBeInTheDocument();
  });

  it('shows the cached source pill when a usable cache wins', async () => {
    await writeCachedSnapshot({ ...loadBundledSnapshot(), fetchedAt: '2026-10-02T00:00:00.000Z' });
    render(<><DatabasePage /><ToastHost /></>);
    expect(await screen.findByText('Cached · 2026-10-02')).toBeInTheDocument();
  });

  it('renders content synchronously from the seed (no loading flash)', () => {
    render(<><DatabasePage /><ToastHost /></>);
    // First paint already lists entries — the cache resolves in place.
    expect(screen.getByText('Jiyan')).toBeInTheDocument();
    expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
  });

  it('manual check offline toasts and keeps serving the current snapshot', async () => {
    const user = userEvent.setup();
    render(<><DatabasePage /><ToastHost /></>);
    await screen.findByText(/^Bundled · /);

    await user.click(screen.getByRole('button', { name: /check for updates/i }));

    expect(await screen.findByText(/couldn't check for updates/i)).toBeInTheDocument();
    expect(screen.getByText(/^Bundled · /)).toBeInTheDocument();
    expect(screen.getByText('Jiyan')).toBeInTheDocument();
  });

  it('manual check reports up to date when the publication matches', async () => {
    servePublication(loadBundledSnapshot());
    const user = userEvent.setup();
    render(<><DatabasePage /><ToastHost /></>);
    await screen.findByText(/^Bundled · /);

    await user.click(screen.getByRole('button', { name: /check for updates/i }));

    expect(await screen.findByText(/already up to date/i)).toBeInTheDocument();
  });

  /** Bundled data with one renamed character and a newer fetch time. */
  function newerPublication(): unknown {
    const bundled = loadBundledSnapshot();
    return {
      ...bundled,
      fetchedAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      characters: [{ ...bundled.characters[0], name: 'Testina' }],
    };
  }

  it('adopts a newer publication in the background on first visit', async () => {
    servePublication(newerPublication());
    render(<><DatabasePage /><ToastHost /></>);
    expect(await screen.findByText('Testina')).toBeInTheDocument();
    expect(screen.getByText(/^Cached · /)).toBeInTheDocument();
    expect(screen.queryByText('Jiyan')).not.toBeInTheDocument();
  });

  it('manual check adopts a newer publication live', async () => {
    servePublication(newerPublication(), { failFirst: true });
    const user = userEvent.setup();
    render(<><DatabasePage /><ToastHost /></>);
    await screen.findByText(/^Bundled · /);

    await user.click(screen.getByRole('button', { name: /check for updates/i }));

    // The page adopts the refreshed data live: new pill, new rows, toast.
    expect(await screen.findByText(/game data updated to/i)).toBeInTheDocument();
    expect(screen.getByText(/^Cached · /)).toBeInTheDocument();
    expect(screen.getByText('Testina')).toBeInTheDocument();
    expect(screen.queryByText('Jiyan')).not.toBeInTheDocument();
  });
});
