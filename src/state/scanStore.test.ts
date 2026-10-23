import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OwnedEcho } from '../data/schema.ts';
import fixtures from '../scanner/fixtures/panels.json';
import type { FrameRead } from '../scanner/engine.ts';
import type { ParseFn } from '../scanner/pipeline.ts';
import { reviewRows, summarize } from '../scanner/review.ts';
import { screenshotProblem } from '../scanner/imageLimits.ts';
import { pngBytes } from '../scanner/testImages.ts';
import { isPanelless, setScanDeps, useScanStore } from './scanStore.ts';
import type { VideoScanOptions } from '../scanner/videoFrames.ts';

type RawPanel = { frame: number[]; words: (string | number)[][] };
const PANELS = fixtures.panels as Record<string, RawPanel>;

/** Fake engine: replays the real OCR words recorded for the fixture with the file's name. */
function fakeReader(image: Blob, parse: ParseFn): Promise<FrameRead> {
  const name = (image as File).name;
  // "blank" stands for a frame with no Echo panel (e.g. the desktop): no words.
  if (name === 'blank') return Promise.resolve({ words: [], parse: parse([]), width: 1920, height: 1080 });
  const panel = PANELS[name];
  if (panel === undefined) return Promise.reject(new Error(`unreadable image ${name}`));
  const words = panel.words.map(([text, x0, y0, x1, y1]) => ({
    text: String(text),
    bbox: { x0: Number(x0), y0: Number(y0), x1: Number(x1), y1: Number(y1) },
  }));
  return Promise.resolve({ words, parse: parse(words), width: panel.frame[0], height: panel.frame[1] });
}

const file = (name: string): File => new File([], name, { type: 'image/png' });

beforeEach(() => {
  setScanDeps({ createReader: () => Promise.resolve(fakeReader), thumbnail: () => Promise.resolve(null) });
  useScanStore.getState().clear();
  useScanStore.setState({ batch: { sonataId: '', rarity: 5, expected: null }, engine: 'idle', engineError: null });
});

afterEach(() => setScanDeps(null));

describe('scan store', () => {
  it('reads images with no set picked, and asks for the set when the game does not show it', async () => {
    // The fake reader passes no filter-tag words, and Leviathan rolls two sets.
    await useScanStore.getState().addImages([file('2026-10-16_16-56-49')]);
    const [item] = useScanStore.getState().items;
    expect(item.batch).toEqual({ sonataId: null, rarity: 5 });
    expect(item.parse?.echo.sonataId).toBeNull();
    expect(item.parse?.flags).toEqual([
      { field: 'sonata', severity: 'error', message: expect.stringMatching(/^Sonata set not known/) as unknown as string },
    ]);
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
      createReader: () => Promise.resolve((image, parse) => {
        reads.push((image as File).name);
        return fakeReader(image, parse);
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
  it('classifies rows; owned Echoes and in-scan repeats start unticked', async () => {
    const store = useScanStore.getState();
    store.setBatch({ sonataId: 'flamewing-s-shadow' });
    await store.addImages([file('2026-10-16_16-56-49'), file('2026-10-16_17-18-02'), file('2026-10-16_16-56-49')]);
    const items = useScanStore.getState().items;
    const rows = reviewRows(items, []);
    // The third row has the first one's exact rolls: a repeat (e.g. clicked twice in a video).
    expect(rows.map((r) => [r.state, r.known, r.repeatOf, r.included])).toEqual([
      ['ready', false, null, true],
      ['ready', false, null, true],
      ['ready', false, 0, false],
    ]);

    // Own one identical copy: the first scanned copy is known; the repeat stays a repeat.
    const owned: OwnedEcho = { ...rows[0].draft!, id: 'owned-1', origin: 'manual' };
    const withOwned = reviewRows(items, [owned]);
    expect(withOwned.map((r) => [r.known, r.repeatOf, r.included])).toEqual([
      [true, null, false],
      [false, null, true],
      [false, 0, false],
    ]);
    expect(summarize(withOwned)).toEqual({ total: 3, reading: 0, ready: 3, review: 0, fix: 0, failed: 0, known: 1, repeats: 1, included: 1 });

    // An explicit tick overrides either default (e.g. two truly identical Echoes).
    useScanStore.getState().setInclude(items[0].id, true);
    useScanStore.getState().setInclude(items[2].id, true);
    expect(reviewRows(useScanStore.getState().items, [owned]).map((r) => r.included)).toEqual([true, true, true]);
  });

  it('ticks neither copy when same-roll rows disagree on who wears the Echo', async () => {
    const store = useScanStore.getState();
    store.setBatch({ sonataId: 'flamewing-s-shadow' });
    await store.addImages([file('2026-10-16_16-56-49'), file('2026-10-16_17-18-02'), file('2026-10-16_16-56-49')]);
    const items = useScanStore.getState().items;
    // The first copy read "Equipped by Galbrena"; say the third came out unequipped (a faded line).
    const unequipped = { ...reviewRows(items, [])[2].draft!, equippedTo: null };
    const rows = reviewRows([items[0], items[1], { ...items[2], override: unequipped }], []);
    expect(rows.map((r) => [r.repeatOf, r.equipConflict, r.included])).toEqual([
      [null, true, false],
      [null, false, true],
      [0, true, false],
    ]);
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

describe('video scans', () => {
  /** Fake walker: emits the named fixture frames in order, reporting progress per frame. */
  function walker(names: string[], opts: { failAfter?: number } = {}) {
    return (_video: File, options: VideoScanOptions) => {
      for (const [i, name] of names.entries()) {
        options.signal?.throwIfAborted();
        if (opts.failAfter === i) return Promise.reject(new Error('decoder died'));
        options.onFrame(file(name), { start: i, end: i, pick: i });
        options.onProgress?.(i + 1, names.length);
      }
      return Promise.resolve({ duration: names.length, segments: names.length });
    };
  }

  it('reads each found panel, drops panel-less frames, and keeps revisits as repeats', async () => {
    // The 2026-10-22 recording: a desktop frame first, two Fleurdelys, then a Spectro Drake revisit.
    setScanDeps({
      createReader: () => Promise.resolve(fakeReader),
      thumbnail: () => Promise.resolve(null),
      scanVideo: walker(['blank', 'vid-seg01', 'vid-seg02', 'vid-seg10', 'vid-seg11', 'vid-seg12']),
    });
    const store = useScanStore.getState();
    store.setBatch({ sonataId: 'windward-pilgrimage' });
    await store.addVideo(file('clip.mp4'));

    const state = useScanStore.getState();
    expect(state.video).toBeNull();
    expect(state.lastVideo).toEqual({ fileName: 'clip.mp4', found: 5, skipped: 1, cancelled: false, error: null });
    expect(state.items.map((it) => it.parse?.echo.echoDefId)).toEqual([
      'reminiscence-fleurdelys',
      'reminiscence-fleurdelys',
      'spectro-drake',
      'fusion-drake',
      'spectro-drake',
    ]);
    expect(reviewRows(state.items, []).map((r) => r.repeatOf)).toEqual([null, null, null, null, 2]);
  });

  it('cancels between frames and keeps what was already found', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    setScanDeps({
      createReader: () => Promise.resolve(fakeReader),
      thumbnail: () => Promise.resolve(null),
      scanVideo: async (_video, options) => {
        options.onFrame(file('vid-seg03'), { start: 0, end: 0, pick: 0 });
        await gate;
        options.signal?.throwIfAborted();
        options.onFrame(file('vid-seg04'), { start: 1, end: 1, pick: 1 });
        return { duration: 2, segments: 2 };
      },
    });
    const store = useScanStore.getState();
    store.setBatch({ sonataId: 'windward-pilgrimage' });
    const running = store.addVideo(file('clip.mp4'));
    expect(useScanStore.getState().video).toMatchObject({ fileName: 'clip.mp4', found: 1 });
    await expect(useScanStore.getState().addVideo(file('other.mp4'))).rejects.toThrow(/already being scanned/);
    useScanStore.getState().cancelVideo();
    release();
    await running;
    expect(useScanStore.getState().lastVideo).toEqual({ fileName: 'clip.mp4', found: 1, skipped: 0, cancelled: true, error: null });
    expect(useScanStore.getState().items).toHaveLength(1);
  });

  it('reports a recording that cannot be decoded, keeping frames read before the failure', async () => {
    setScanDeps({
      createReader: () => Promise.resolve(fakeReader),
      thumbnail: () => Promise.resolve(null),
      scanVideo: walker(['vid-seg05', 'vid-seg06'], { failAfter: 1 }),
    });
    const store = useScanStore.getState();
    store.setBatch({ sonataId: 'windward-pilgrimage' });
    await store.addVideo(file('broken.mkv'));
    expect(useScanStore.getState().lastVideo).toEqual({ fileName: 'broken.mkv', found: 1, skipped: 0, cancelled: false, error: 'decoder died' });
  });

  it('treats a parse with no name, cost or main stat as panel-less — and only that', () => {
    const empty = { echoDefId: null, cost: null, level: null, rarity: 5, sonataId: 'x', mainStat: null, secondMainStat: null, substats: [], equippedTo: null };
    expect(isPanelless({ echo: empty, flags: [] })).toBe(true);
    expect(isPanelless({ echo: { ...empty, cost: 4 }, flags: [] })).toBe(false);
  });
});
