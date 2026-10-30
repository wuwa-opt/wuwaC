import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import fixtures from '../../scanner/fixtures/panels.json';
import type { ParseFn } from '../../scanner/pipeline.ts';
import { reviewRows } from '../../scanner/review.ts';
import type { VideoScanOptions } from '../../scanner/videoFrames.ts';
import { db } from '../../state/db.ts';
import { useInventoryStore, type ScanApplied } from '../../state/inventory.ts';
import { setScanDeps, useScanStore } from '../../state/scanStore.ts';
import { EchoScanner } from './EchoScanner.tsx';

type RawPanel = { frame: number[]; words: (string | number)[][] };
const PANELS = fixtures.panels as Record<string, RawPanel>;

beforeEach(async () => {
  await db.ownedEchoes.clear();
  useInventoryStore.setState({ echoes: [], loaded: true });
  setScanDeps({
    // Replays the real OCR words recorded for the fixture named like the file.
    createReader: () =>
      Promise.resolve((image: Blob, parse: ParseFn) => {
        const panel = PANELS[(image as File).name.replace(/\.png$/, '')];
        const words = panel.words.map(([text, x0, y0, x1, y1]) => ({
          text: String(text),
          bbox: { x0: Number(x0), y0: Number(y0), x1: Number(x1), y1: Number(y1) },
        }));
        return Promise.resolve({ width: panel.frame[0], height: panel.frame[1], words, parse: parse(words) });
      }),
    thumbnail: () => Promise.resolve(null),
  });
  useScanStore.getState().clear();
  useScanStore.setState({ batch: { sonataId: '', rarity: 5, expected: null }, engine: 'idle', engineError: null });
});

afterEach(() => setScanDeps(null));

const png = (name: string): File => new File(['x'], `${name}.png`, { type: 'image/png' });

describe('EchoScanner', () => {
  it('takes screenshots with no set picked: the set is read from the in-game filter by default', () => {
    render(<EchoScanner onClose={() => undefined} onApplied={() => undefined} />);
    expect(screen.getByRole('button', { name: /add screenshots/i })).toBeEnabled();
    expect(screen.getByLabelText(/sonata set/i)).toHaveDisplayValue('Read from the in-game filter');
  });

  it('scans, shows review states and the filter count, and imports the included echoes', async () => {
    const user = userEvent.setup();
    let imported = 0;
    render(<EchoScanner onClose={() => undefined} onApplied={(a) => (imported = a.added.length)} />);

    await user.selectOptions(screen.getByLabelText(/sonata set/i), 'flamewing-s-shadow');
    await user.type(screen.getByLabelText(/count in filter/i), '2');
    // Leviathan reads clean; Kerasaur (also a Flamewing's Shadow roller) reads clean too.
    await user.upload(screen.getByLabelText(/echo screenshots/i), [png('2026-10-16_16-56-49'), png('2026-10-16_17-18-02')]);

    expect(await screen.findByText('Reminiscence: Threnodian - Leviathan')).toBeInTheDocument();
    expect(await screen.findByText('Kerasaur')).toBeInTheDocument();
    expect(screen.getByText(/2 scanned · 2 ready/)).toBeInTheDocument();
    expect(screen.getByText(/Flamewing's Shadow: 2 \/ 2/)).toBeInTheDocument();
    expect(screen.getByText('Crit Rate 22% · ATK 150')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add 2 echoes' }));
    await waitFor(() => expect(imported).toBe(2));
    const rows = await db.ownedEchoes.toArray();
    expect(rows.map((r) => [r.echoDefId, r.sonataId, r.origin, r.equippedTo]).sort()).toEqual([
      ['kerasaur', 'flamewing-s-shadow', 'import:screen-scan', 'denia'],
      ['reminiscence-threnodian-leviathan', 'flamewing-s-shadow', 'import:screen-scan', 'galbrena'],
    ]);
    expect(useScanStore.getState().items).toEqual([]);
  });

  it('blocks an Echo that cannot roll the batch set and explains why', async () => {
    const user = userEvent.setup();
    render(<EchoScanner onClose={() => undefined} onApplied={() => undefined} />);
    await user.selectOptions(screen.getByLabelText(/sonata set/i), 'freezing-frost');
    await user.upload(screen.getByLabelText(/echo screenshots/i), [png('2026-10-16_16-56-49')]);

    const row = (await screen.findByText('Reminiscence: Threnodian - Leviathan')).closest('li')!;
    expect(within(row).getByText('Needs a fix')).toBeInTheDocument();
    expect(within(row).getByText(/Is the in-game Sonata filter still set\?/)).toBeInTheDocument();
    expect(within(row).getByRole('checkbox', { name: 'Add' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add 0 echoes' })).toBeDisabled();
  });

  it('asks which Rover, and imports with the choice', async () => {
    const user = userEvent.setup();
    render(<EchoScanner onClose={() => undefined} onApplied={() => undefined} />);
    await user.selectOptions(screen.getByLabelText(/sonata set/i), 'rejuvenating-glow');
    await user.upload(screen.getByLabelText(/echo screenshots/i), [png('2026-10-16_17-19-07')]);

    const row = (await screen.findByText('Whiff Whaff')).closest('li')!;
    expect(within(row).getByText('Check')).toBeInTheDocument();
    await user.selectOptions(within(row).getByRole('combobox'), 'rover-spectro');
    expect(within(row).getByText('Ready')).toBeInTheDocument();
    expect(within(row).getByText('Equipped by Rover: Spectro')).toBeInTheDocument();
  });

  it('scans a screen recording: one row per panel, a skipped desktop frame, and a revisit flagged', async () => {
    const user = userEvent.setup();
    const deps = {
      createReader: () =>
        Promise.resolve((image: Blob, parse: ParseFn) => {
          const name = (image as File).name.replace(/\.png$/, '');
          const panel = PANELS[name];
          const words =
            panel === undefined
              ? []
              : panel.words.map(([text, x0, y0, x1, y1]) => ({
                  text: String(text),
                  bbox: { x0: Number(x0), y0: Number(y0), x1: Number(x1), y1: Number(y1) },
                }));
          return Promise.resolve({ width: 1894, height: 1062, words, parse: parse(words) });
        }),
      thumbnail: () => Promise.resolve(null),
      // Desktop first (no panel), then Spectro -> Fusion -> Spectro again, as in the real recording.
      scanVideo: (_video: File, options: VideoScanOptions) => {
        ['desktop', 'vid-seg10', 'vid-seg11', 'vid-seg12'].forEach((name, i) => {
          options.onFrame(png(name), { start: i, end: i, pick: i, alt: null });
          options.onProgress?.(i + 1, 4);
        });
        return Promise.resolve({ duration: 4, segments: 4 });
      },
    };
    setScanDeps(deps);
    render(<EchoScanner onClose={() => undefined} onApplied={() => undefined} />);
    await user.selectOptions(screen.getByLabelText(/sonata set/i), 'windward-pilgrimage');
    await user.upload(screen.getByLabelText(/echo screenshots or recording/i), new File(['v'], 'clip.mp4', { type: 'video/mp4' }));

    expect(await screen.findByText('clip.mp4: 3 Echo panels found · 1 frame without an Echo panel skipped')).toBeInTheDocument();
    expect(screen.getByText(/3 scanned · 3 ready · 1 scanned twice/)).toBeInTheDocument();
    const repeat = screen.getByText(/Same rolls as #1/).closest('li')!;
    expect(within(repeat).getByText('Spectro Drake')).toBeInTheDocument();
    expect(within(repeat).getByRole('checkbox', { name: 'Add' })).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Add 2 echoes' })).toBeEnabled();
  });

  it('keeps the screen on while a recording is scanned, and says the scan pauses in the background', async () => {
    const user = userEvent.setup();
    const sentinel = { released: false, release: vi.fn(() => ((sentinel.released = true), Promise.resolve())) };
    const request = vi.fn(() => Promise.resolve(sentinel));
    Object.defineProperty(navigator, 'wakeLock', { value: { request }, configurable: true });
    let finish: () => void = () => undefined;
    setScanDeps({
      createReader: () => Promise.resolve((_image: Blob, parse: ParseFn) => Promise.resolve({ width: 1894, height: 1062, words: [], parse: parse([]) })),
      thumbnail: () => Promise.resolve(null),
      scanVideo: () => new Promise((resolve) => (finish = () => resolve({ duration: 4, segments: 0 }))),
    });
    try {
      render(<EchoScanner onClose={() => undefined} onApplied={() => undefined} />);
      await user.upload(screen.getByLabelText(/echo screenshots or recording/i), new File(['v'], 'clip.mp4', { type: 'video/mp4' }));
      expect(await screen.findByText(/the scan pauses while it's hidden/)).toBeInTheDocument();
      await waitFor(() => expect(request).toHaveBeenCalledWith('screen'));
      expect(sentinel.released).toBe(false);

      await act(async () => finish());
      await waitFor(() => expect(sentinel.released).toBe(true));
      expect(screen.queryByText(/the scan pauses while it's hidden/)).not.toBeInTheDocument();
    } finally {
      delete (navigator as { wakeLock?: unknown }).wakeLock;
    }
  });
});

describe('EchoScanner: rescan', () => {
  it('updates known Echoes in place (the scan wins on "Equipped by"), lists unseen ones, and deletes only what is ticked', async () => {
    const user = userEvent.setup();
    // What the two screenshots read as, to build an inventory that predates them.
    useScanStore.getState().setBatch({ sonataId: 'flamewing-s-shadow' });
    await useScanStore.getState().addImages([png('2026-10-16_16-56-49'), png('2026-10-16_17-18-02')]);
    const [leviathan, kerasaur] = reviewRows(useScanStore.getState().items, []).map((r) => r.draft!);
    useScanStore.getState().clear();
    expect([leviathan.equippedTo, kerasaur.equippedTo]).toEqual(['galbrena', 'denia']);

    const store = useInventoryStore.getState();
    // The Leviathan, recorded on someone else; the Kerasaur before its last two tunes; one more Echo of the set.
    const lev = await store.addEcho({ ...leviathan, equippedTo: 'carlotta' });
    const ker = await store.addEcho({
      ...kerasaur,
      level: 15,
      mainStat: { ...kerasaur.mainStat, value: 0.2 },
      substats: kerasaur.substats.slice(0, 3),
      label: 'my kerasaur',
    });
    const unseen = await store.addEcho({ ...kerasaur, level: 0, mainStat: { stat: 'hpPct', value: 0.066 }, substats: [], equippedTo: null });

    let applied: ScanApplied | null = null;
    render(<EchoScanner onClose={() => undefined} onApplied={(a) => (applied = a)} />);
    await user.upload(screen.getByLabelText(/echo screenshots/i), [png('2026-10-16_16-56-49'), png('2026-10-16_17-18-02')]);

    const levRow = (await screen.findByText('Reminiscence: Threnodian - Leviathan')).closest('li')!;
    expect(within(levRow).getByText('already in inventory')).toBeInTheDocument();
    expect(within(levRow).getByText(/Your inventory has it on Carlotta; this scan updates that/)).toBeInTheDocument();
    expect(within(levRow).getByRole('checkbox', { name: 'Update' })).toBeChecked();
    // (The unseen Kerasaur is listed further down, under "Not in this scan".)
    const kerRow = (await screen.findByText('levelled up from your +15 copy')).closest('li')!;
    expect(within(kerRow).getByText('Kerasaur')).toBeInTheDocument();
    expect(within(kerRow).getByRole('checkbox', { name: 'Update' })).toBeChecked();

    expect(screen.getByText(/Not in this scan: 1 Echo in your inventory/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply: update 2' })).toBeEnabled();
    await user.click(screen.getByRole('checkbox', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Apply: update 2 · delete 1' }));

    await waitFor(() => expect(applied).not.toBeNull());
    expect((await db.ownedEchoes.get(lev.id))?.equippedTo).toBe('galbrena');
    // Same row (builds still point at it), new level and substats, nickname kept.
    expect(await db.ownedEchoes.get(ker.id)).toMatchObject({ level: 25, substats: kerasaur.substats, equippedTo: 'denia', label: 'my kerasaur' });
    expect(await db.ownedEchoes.get(unseen.id)).toBeUndefined();
    expect(await db.ownedEchoes.count()).toBe(2);
    expect(useScanStore.getState().items).toEqual([]);
  });

  it('never moves an Echo off its recorded wearer while "Equipped by" waits for a pick (Rover)', async () => {
    const user = userEvent.setup();
    useScanStore.getState().setBatch({ sonataId: 'rejuvenating-glow' });
    await useScanStore.getState().addImages([png('2026-10-16_17-19-07')]);
    const whiff = reviewRows(useScanStore.getState().items, [])[0].draft!;
    useScanStore.getState().clear();
    await useInventoryStore.getState().addEcho({ ...whiff, equippedTo: 'rover-havoc' });

    render(<EchoScanner onClose={() => undefined} onApplied={() => undefined} />);
    await user.upload(screen.getByLabelText(/echo screenshots/i), [png('2026-10-16_17-19-07')]);
    const row = (await screen.findByText('Whiff Whaff')).closest('li')!;
    expect(within(row).getByText('already in inventory')).toBeInTheDocument();
    expect(within(row).queryByRole('checkbox')).toBeNull();
    // Picking a different Rover is a reading: now it updates.
    await user.selectOptions(within(row).getByRole('combobox'), 'rover-spectro');
    expect(within(row).getByRole('checkbox', { name: 'Update' })).toBeChecked();
  });
});
