import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OwnedEcho } from '../data/schema.ts';
import fixtures from '../scanner/fixtures/panels.json';
import type { OcrWord } from '../scanner/parse.ts';
import { reviewRows, summarize } from '../scanner/review.ts';
import { screenshotProblem } from '../scanner/imageLimits.ts';
import { pngBytes } from '../scanner/testImages.ts';
import { setScanDeps, useScanStore } from './scanStore.ts';

type RawPanel = { frame: number[]; words: (string | number)[][] };
const PANELS = fixtures.panels as Record<string, RawPanel>;

/** Fake engine: replays the real OCR words recorded for the fixture with the file's name. */
function fakeReader(image: Blob): Promise<{ words: OcrWord[]; width: number; height: number }> {
  const name = (image as File).name;
  const panel = PANELS[name];
  if (panel === undefined) return Promise.reject(new Error(`unreadable image ${name}`));
  const words = panel.words.map(([text, x0, y0, x1, y1]) => ({
    text: String(text),
    bbox: { x0: Number(x0), y0: Number(y0), x1: Number(x1), y1: Number(y1) },
  }));
  return Promise.resolve({ words, width: panel.frame[0], height: panel.frame[1] });
}

const file = (name: string): File => new File([], name, { type: 'image/png' });

beforeEach(() => {
  setScanDeps({ createReader: () => Promise.resolve(fakeReader), thumbnail: () => Promise.resolve(null) });
  useScanStore.getState().clear();
  useScanStore.setState({ batch: { sonataId: '', rarity: 5, expected: null }, engine: 'idle', engineError: null });
});

afterEach(() => setScanDeps(null));

describe('scan store', () => {
  it('refuses images until the batch Sonata is chosen', async () => {
    await expect(useScanStore.getState().addImages([file('2026-10-16_16-56-49')])).rejects.toThrow(/Sonata set/);
    expect(useScanStore.getState().items).toEqual([]);
  });

  it('reads and parses images under the batch, stamping the batch on each item', async () => {
    const store = useScanStore.getState();
    store.setBatch({ sonataId: 'flamewing-s-shadow' });
    await store.addImages([file('2026-10-16_16-56-49'), file('no-such-fixture')]);
    const [ok, bad] = useScanStore.getState().items;
    expect(useScanStore.getState().engine).toBe('ready');
    expect(ok.status).toBe('done');
    expect(ok.batch).toEqual({ sonataId: 'flamewing-s-shadow', rarity: 5 });
    expect(ok.parse?.flags).toEqual([]);
    expect(ok.parse?.echo.echoDefId).toBe('reminiscence-threnodian-leviathan');
    expect(bad).toMatchObject({ status: 'failed', error: 'unreadable image no-such-fixture' });
  });

  it('resolves a Rover choice and drops its review flag', async () => {
    const store = useScanStore.getState();
    // Whiff Whaff rolls Rejuvenating Glow among others (fixture batch of the eval).
    store.setBatch({ sonataId: 'rejuvenating-glow' });
    await store.addImages([file('2026-10-16_17-19-07')]);
    const item = useScanStore.getState().items[0];
    expect(item.parse?.echo.equippedCandidates).toHaveLength(4);
    useScanStore.getState().setEquipped(item.id, 'rover-havoc');
    const after = useScanStore.getState().items[0];
    expect(after.parse?.echo.equippedTo).toBe('rover-havoc');
    expect(after.parse?.echo.equippedCandidates).toBeUndefined();
    expect(after.parse?.flags.filter((f) => f.field === 'equipped')).toEqual([]);
  });

  it('removes and clears items', async () => {
    const store = useScanStore.getState();
    store.setBatch({ sonataId: 'flamewing-s-shadow' });
    await store.addImages([file('2026-10-16_16-56-49'), file('2026-10-16_16-56-49')]);
    const [first] = useScanStore.getState().items;
    useScanStore.getState().remove(first.id);
    expect(useScanStore.getState().items).toHaveLength(1);
    useScanStore.getState().clear();
    expect(useScanStore.getState().items).toEqual([]);
  });

  it('reports an engine that fails to load, then retries on the next image', async () => {
    let attempts = 0;
    setScanDeps({
      createReader: () => (++attempts === 1 ? Promise.reject(new Error('wasm blocked')) : Promise.resolve(fakeReader)),
      thumbnail: () => Promise.resolve(null),
    });
    const store = useScanStore.getState();
    store.setBatch({ sonataId: 'flamewing-s-shadow' });
    await store.addImages([file('2026-10-16_16-56-49')]);
    expect(useScanStore.getState()).toMatchObject({ engine: 'error', engineError: 'wasm blocked' });
    expect(useScanStore.getState().items[0].status).toBe('failed');
    await useScanStore.getState().addImages([file('2026-10-16_16-56-49')]);
    expect(useScanStore.getState().engine).toBe('ready');
    expect(useScanStore.getState().items[1].status).toBe('done');
  });
});

describe('screenshot limits in the scan store', () => {
  it('fails an oversized file on its own row and still reads the rest of the batch', async () => {
    const reads: string[] = [];
    setScanDeps({
      validate: screenshotProblem,
      createReader: () => Promise.resolve((image) => {
        reads.push((image as File).name);
        return fakeReader(image);
      }),
      thumbnail: () => Promise.resolve(null),
    });
    const good = new File([pngBytes(1920, 1080)], '2026-10-16_16-56-49', { type: 'image/png' });
    const eightK = new File([pngBytes(7680, 4320)], 'eightk.png', { type: 'image/png' });
    const heavy = new File([pngBytes(1920, 1080)], 'heavy.png', { type: 'image/png' });
    Object.defineProperty(heavy, 'size', { value: 30 * 1024 * 1024 });
    const store = useScanStore.getState();
    store.setBatch({ sonataId: 'flamewing-s-shadow' });
    await store.addImages([eightK, good, heavy]);

    const [a, b, c] = useScanStore.getState().items;
    expect(a).toMatchObject({ fileName: 'eightk.png', status: 'failed' });
    expect(a.error).toMatch(/7680×4320.*over the 16 MP limit/);
    expect(b.status).toBe('done');
    expect(c).toMatchObject({ fileName: 'heavy.png', status: 'failed' });
    expect(c.error).toMatch(/30\.0 MB, over the 20\.0 MB limit/);
    // Refused files never reach the OCR engine.
    expect(reads).toEqual(['2026-10-16_16-56-49']);
  });

  it('fails a non-image the same way instead of throwing', async () => {
    setScanDeps({ validate: screenshotProblem, createReader: () => Promise.resolve(fakeReader), thumbnail: () => Promise.resolve(null) });
    const store = useScanStore.getState();
    store.setBatch({ sonataId: 'flamewing-s-shadow' });
    await store.addImages([new File(['not an image'], 'notes.png', { type: 'image/png' })]);
    expect(useScanStore.getState().items[0]).toMatchObject({ status: 'failed', error: 'notes.png is not a PNG, JPEG or WebP image.' });
  });
});

describe('reviewRows', () => {
  it('classifies rows and skips Echoes the inventory already owns by default', async () => {
    const store = useScanStore.getState();
    store.setBatch({ sonataId: 'flamewing-s-shadow' });
    await store.addImages([file('2026-10-16_16-56-49'), file('2026-10-16_16-56-49')]);
    const items = useScanStore.getState().items;
    const rows = reviewRows(items, []);
    expect(rows.map((r) => [r.state, r.known, r.included])).toEqual([
      ['ready', false, true],
      ['ready', false, true],
    ]);

    // Own one identical copy: the first scanned copy is known, the second is new.
    const draft = rows[0].draft!;
    const owned: OwnedEcho = { ...draft, id: 'owned-1', origin: 'manual' };
    const withOwned = reviewRows(items, [owned]);
    expect(withOwned.map((r) => [r.known, r.included])).toEqual([
      [true, false],
      [false, true],
    ]);
    // An explicit include overrides the default.
    useScanStore.getState().setInclude(items[0].id, true);
    expect(reviewRows(useScanStore.getState().items, [owned])[0].included).toBe(true);

    expect(summarize(withOwned)).toEqual({ total: 2, reading: 0, ready: 2, review: 0, fix: 0, failed: 0, known: 1, included: 1 });
  });

  it('marks error rows as fix and never includes them until overridden', async () => {
    const store = useScanStore.getState();
    // Wrong batch set for this Echo -> sonata error flag.
    store.setBatch({ sonataId: 'freezing-frost' });
    await store.addImages([file('2026-10-16_16-56-49')]);
    const item = useScanStore.getState().items[0];
    expect(reviewRows([item], [])[0]).toMatchObject({ state: 'fix', draft: null, included: false });

    const fixed = { ...reviewRows([{ ...item, batch: { sonataId: 'flamewing-s-shadow', rarity: 5 }, parse: { ...item.parse!, flags: [] } }], [])[0].draft! };
    useScanStore.getState().setOverride(item.id, { ...fixed, sonataId: 'flamewing-s-shadow' });
    expect(reviewRows(useScanStore.getState().items, [])[0]).toMatchObject({ state: 'ready', included: true });
  });
});
