import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import fixtures from '../../scanner/fixtures/panels.json';
import type { ParseFn } from '../../scanner/pipeline.ts';
import type { VideoScanOptions } from '../../scanner/videoFrames.ts';
import { db } from '../../state/db.ts';
import { useInventoryStore } from '../../state/inventory.ts';
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
  it('needs the batch Sonata before screenshots can be added', () => {
    render(<EchoScanner onClose={() => undefined} onImported={() => undefined} />);
    expect(screen.getByRole('button', { name: /add screenshots/i })).toBeDisabled();
  });

  it('scans, shows review states and the filter count, and imports the included echoes', async () => {
    const user = userEvent.setup();
    let imported = 0;
    render(<EchoScanner onClose={() => undefined} onImported={(n) => (imported = n)} />);

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
    render(<EchoScanner onClose={() => undefined} onImported={() => undefined} />);
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
    render(<EchoScanner onClose={() => undefined} onImported={() => undefined} />);
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
          options.onFrame(png(name), { start: i, end: i, pick: i });
          options.onProgress?.(i + 1, 4);
        });
        return Promise.resolve({ duration: 4, segments: 4 });
      },
    };
    setScanDeps(deps);
    render(<EchoScanner onClose={() => undefined} onImported={() => undefined} />);
    await user.selectOptions(screen.getByLabelText(/sonata set/i), 'windward-pilgrimage');
    await user.upload(screen.getByLabelText(/echo screenshots or recording/i), new File(['v'], 'clip.mp4', { type: 'video/mp4' }));

    expect(await screen.findByText('clip.mp4: 3 Echo panels found · 1 frame without an Echo panel skipped')).toBeInTheDocument();
    expect(screen.getByText(/3 scanned · 3 ready · 1 scanned twice/)).toBeInTheDocument();
    const repeat = screen.getByText(/Same rolls as #1/).closest('li')!;
    expect(within(repeat).getByText('Spectro Drake')).toBeInTheDocument();
    expect(within(repeat).getByRole('checkbox', { name: 'Add' })).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Add 2 echoes' })).toBeEnabled();
  });
});
