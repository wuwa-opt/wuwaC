import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { OwnedEcho, RosterEntry, SharedBuild } from '../../data/schema.ts';
import { useCalculatorStore } from '../../state/calculator.ts';
import { db } from '../../state/db.ts';
import { useInventoryStore } from '../../state/inventory.ts';
import { useLibraryStore, type BuildDraft } from '../../state/library.ts';
import { useRosterStore } from '../../state/roster.ts';
import { decodeShareLink, encodeBuildLink, encodeSharedBuild, referenceBuildFrom } from '../../state/share.ts';
import { useAppStore } from '../../state/store.ts';
import { ToastHost } from '../components/ToastHost.tsx';
import { useToastStore } from '../toasts.ts';
import { BuildsPage } from './BuildsPage.tsx';

const seed: BuildDraft = {
  name: 'Seeded Build',
  characterId: 'jiyan',
  weaponId: 'verdant-summit',
  echoIds: ['a', 'b', 'c', 'd', 'e'],
  objectiveId: 'Expected damage',
  score: 99.5,
};

const LIBERATION = '1001103';

const ownEchoes: OwnedEcho[] = (
  [
    ['a', 'feilian-beringal', 4, 'critRate', 0.22, 'atk', 150],
    ['b', 'hoochief', 3, 'dmgBonus:Aero', 0.3, 'atk', 100],
    ['c', 'carapace', 3, 'atkPct', 0.3, 'atk', 100],
    ['d', 'hooscamp', 1, 'atkPct', 0.18, 'hp', 2280],
    ['e', 'chirpuff', 1, 'atkPct', 0.18, 'hp', 2280],
  ] as const
).map(([id, def, cost, main, value, second, secondValue]) => ({
  id,
  echoDefId: def,
  sonataId: 'sierra-gale',
  cost,
  level: 25,
  rarity: 5,
  mainStat: { stat: main, value },
  secondMainStat: { stat: second, value: secondValue },
  substats: [],
  equippedTo: null,
  origin: 'manual',
}));

const myRoster: RosterEntry = {
  characterId: 'jiyan',
  level: 70,
  ascension: 4,
  resonanceChain: 0,
  forteLevels: { [LIBERATION]: 6 },
  weaponId: 'verdant-summit',
  weaponLevel: 80,
  weaponRank: 1,
};

/** A v2 payload as another player would send it (5★ +25 table values). */
const sharedPayload: SharedBuild = {
  v: 2,
  name: 'Friend Jiyan',
  score: 2500,
  summary: 'Expected damage',
  character: { id: 'jiyan', level: 90, ascension: 6, chain: 6, forte: { [LIBERATION]: 10 } },
  weapon: { id: 'verdant-summit', level: 90, ascension: 6, rank: 5 },
  echoes: ownEchoes.map((e) => ({
    def: e.echoDefId,
    set: e.sonataId,
    cost: e.cost,
    level: e.level,
    rarity: e.rarity,
    main: e.mainStat,
    second: e.secondMainStat,
    subs: [],
  })) as unknown as SharedBuild['echoes'],
};

async function openLink(payload: SharedBuild): Promise<string> {
  const link = await encodeSharedBuild(payload);
  window.history.replaceState(null, '', `/${link}`);
  useAppStore.setState({ shareLink: link, activeSection: 'builds' });
  return link;
}

beforeEach(async () => {
  await db.builds.clear();
  await db.ownedEchoes.clear();
  await db.roster.clear();
  useLibraryStore.setState({ builds: [], loaded: false });
  useInventoryStore.setState({ echoes: [], loaded: false });
  useRosterStore.setState({ entries: [], loaded: false });
  useCalculatorStore.getState().resetAll();
  useAppStore.setState({ shareLink: null });
  useToastStore.setState({ toasts: [] });
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  window.history.replaceState(null, '', '/');
  vi.unstubAllGlobals();
});

describe('BuildsPage', () => {
  it('lists saved builds', async () => {
    await useLibraryStore.getState().saveBuild(seed);
    render(<BuildsPage />);
    expect(await screen.findByText('Seeded Build')).toBeInTheDocument();
    expect(screen.getByText(/99\.5/)).toBeInTheDocument();
  });

  describe('build details', () => {
    const detailed: BuildDraft = {
      ...seed,
      context: { ...myRoster, level: 80, resonanceChain: 2, weaponLevel: 90, weaponRank: 3 },
      objective: { kind: 'expected-damage', skillId: LIBERATION, motionName: 'Lance of Qingloong Stage 1 DMG', forteLevel: 10, crit: 'expected' },
      enemy: { kind: 'boss', level: 100, baseRES: 0.2 },
      minStats: { energyRegen: 0.2, critRate: 0.6 },
    };

    it('is collapsed until asked, then lists the five Echoes with slot 1 marked, plus the weapon and saved run settings', async () => {
      const user = userEvent.setup();
      await db.ownedEchoes.bulkAdd(ownEchoes);
      await useLibraryStore.getState().saveBuild(detailed);
      render(<BuildsPage />);
      await screen.findByText('Seeded Build');
      expect(screen.queryByRole('list', { name: 'Build Echoes' })).not.toBeInTheDocument();
      const toggle = screen.getByRole('button', { name: /show details for seeded build/i });
      expect(toggle).toHaveAttribute('aria-expanded', 'false');

      await user.click(toggle);
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
      const region = screen.getByRole('region', { name: /details for seeded build/i });
      expect(toggle).toHaveAttribute('aria-controls', region.id);
      const rows = within(within(region).getByRole('list', { name: 'Build Echoes' })).getAllByRole('listitem');
      expect(rows).toHaveLength(5);
      expect(rows[0]).toHaveTextContent(/Slot 1 \(main\) · Feilian Beringal/);
      expect(rows[0]).toHaveTextContent('4-cost');
      expect(rows[0]).toHaveTextContent('+25');
      expect(rows[0]).toHaveTextContent('Sierra Gale');
      expect(rows[0]).toHaveTextContent('Crit Rate 22%');
      expect(rows[1]).toHaveTextContent(/Slot 2 · Hoochief/);
      expect(rows[1]).not.toHaveTextContent('Slot 1');
      expect(rows[4]).toHaveTextContent(/Slot 5 · Chirpuff/);
      expect(region).toHaveTextContent(/Weapon\s*Verdant Summit Lv 90 R3/);
      expect(region).toHaveTextContent(/Character\s*Lv 80 · S2/);
      expect(region).toHaveTextContent(/Enemy\s*boss, Lv 100, 20% base RES/);
      expect(region).toHaveTextContent(/Minimum stats\s*Energy Regen ≥ 20%, Crit Rate ≥ 60%/);
      expect(region).toHaveTextContent('rotation saved');
      expect(screen.queryByText(/missing/i)).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /hide details for seeded build/i }));
      expect(screen.queryByRole('region', { name: /details for seeded build/i })).not.toBeInTheDocument();
    });

    it('omits settings the build did not save, and an unknown Resonance Mode', async () => {
      const user = userEvent.setup();
      await db.ownedEchoes.bulkAdd(ownEchoes);
      await useLibraryStore.getState().saveBuild({ ...seed, resonanceMode: 'tuneStrain' }); // Jiyan has no modes
      render(<BuildsPage />);
      await screen.findByText('Seeded Build');
      await user.click(screen.getByRole('button', { name: /show details for seeded build/i }));
      const region = screen.getByRole('region', { name: /details for seeded build/i });
      expect(region).toHaveTextContent('Weapon');
      for (const absent of ['Enemy', 'Minimum stats', 'Resonance Mode', 'Character']) {
        expect(region).not.toHaveTextContent(absent);
      }
    });

    it("shows a dual-mode character's saved Resonance Mode", async () => {
      const user = userEvent.setup();
      await db.ownedEchoes.bulkAdd(ownEchoes);
      await useLibraryStore.getState().saveBuild({ ...seed, characterId: 'denia', weaponId: 'augment', resonanceMode: 'tuneStrain' });
      render(<BuildsPage />);
      await screen.findByText('Seeded Build');
      await user.click(screen.getByRole('button', { name: /show details for seeded build/i }));
      expect(screen.getByRole('region', { name: /details for seeded build/i })).toHaveTextContent(/Resonance Mode\s*Tune Strain/);
    });

    it('marks each deleted Echo in its slot, and on the card while collapsed', async () => {
      const user = userEvent.setup();
      await db.ownedEchoes.bulkAdd(ownEchoes.filter((e) => e.id !== 'c' && e.id !== 'e'));
      await useLibraryStore.getState().saveBuild(seed);
      render(<BuildsPage />);
      const card = (await screen.findByText('Seeded Build')).closest('li')!;
      expect(await within(card).findByText('2 Echoes missing')).toBeInTheDocument();

      await user.click(within(card).getByRole('button', { name: /show details/i }));
      const rows = within(within(card).getByRole('list', { name: 'Build Echoes' })).getAllByRole('listitem');
      expect(rows[0]).toHaveTextContent('Feilian Beringal');
      expect(rows[2]).toHaveTextContent('Slot 3 · Missing — this Echo was deleted from your inventory.');
      expect(rows[3]).toHaveTextContent('Hooscamp');
      expect(rows[4]).toHaveTextContent('Slot 5 · Missing');
    });

    it('says "1 Echo missing" in the singular, including when the main Echo is the one gone', async () => {
      await db.ownedEchoes.bulkAdd(ownEchoes.filter((e) => e.id !== 'a'));
      await useLibraryStore.getState().saveBuild(seed);
      render(<BuildsPage />);
      expect(await screen.findByText('1 Echo missing')).toBeInTheDocument();
    });

    it('marks nothing as missing before the inventory has loaded', async () => {
      await useLibraryStore.getState().saveBuild(seed);
      useInventoryStore.setState({ echoes: [], loaded: false, load: () => new Promise(() => {}) });
      try {
        render(<BuildsPage />);
        await screen.findByText('Seeded Build');
        expect(screen.queryByText(/missing/i)).not.toBeInTheDocument();
        await userEvent.setup().click(screen.getByRole('button', { name: /show details/i }));
        expect(screen.getAllByText(/Loading your inventory/i, { selector: 'li' })).toHaveLength(5);
        expect(screen.queryByText(/Missing —/)).not.toBeInTheDocument();
      } finally {
        useInventoryStore.setState({ load: useInventoryStore.getInitialState().load });
      }
    });

    describe('edit minimum stats', () => {
      async function openEditor(draft: BuildDraft = detailed) {
        const user = userEvent.setup();
        await db.ownedEchoes.bulkAdd(ownEchoes);
        const saved = await useLibraryStore.getState().saveBuild(draft);
        render(<><BuildsPage /><ToastHost /></>);
        await screen.findByText('Seeded Build');
        await user.click(screen.getByRole('button', { name: /show details for seeded build/i }));
        await user.click(screen.getByRole('button', { name: 'Edit minimum stats' }));
        return { user, saved };
      }
      const field = (name: RegExp) => screen.getByRole('textbox', { name });
      const stored = () => useLibraryStore.getState().builds[0];

      it('opens with the saved minimums as % text, the stale-score note and the Energy Regen hint', async () => {
        await openEditor();
        expect(field(/Minimum Energy Regen/)).toHaveValue('20');
        expect(field(/Minimum Crit Rate/)).toHaveValue('60');
        expect(field(/Minimum Crit DMG/)).toHaveValue('');
        expect(screen.getByText(/Bonus only/)).toBeInTheDocument();
        expect(screen.getByText(/aren't recomputed/)).toBeInTheDocument();
      });

      it('saves edited minimums as sheet fractions, persists them and shows them in the details', async () => {
        const { user } = await openEditor();
        await user.clear(field(/Minimum Crit Rate/));
        await user.type(field(/Minimum Crit Rate/), '70');
        await user.type(field(/Minimum Crit DMG/), '180.5');
        await user.click(screen.getByRole('button', { name: 'Save minimum stats' }));

        await screen.findByText(/Minimum stats updated/);
        expect(stored().minStats?.energyRegen).toBeCloseTo(0.2, 10);
        expect(stored().minStats?.critRate).toBeCloseTo(0.7, 10);
        expect(stored().minStats?.critDmg).toBeCloseTo(1.805, 10);
        expect((await db.builds.toArray())[0].minStats?.critRate).toBeCloseTo(0.7, 10);
        expect(screen.queryByRole('form', { name: /edit minimum stats/i })).not.toBeInTheDocument();
        expect(screen.getByRole('region', { name: /details for seeded build/i })).toHaveTextContent(/Minimum stats\s*Energy Regen ≥ 20%, Crit Rate ≥ 70%, Crit DMG ≥ 180\.5%/);
      });

      it('clears the key when every box is empty', async () => {
        const { user } = await openEditor();
        await user.clear(field(/Minimum Energy Regen/));
        await user.clear(field(/Minimum Crit Rate/));
        await user.click(screen.getByRole('button', { name: 'Save minimum stats' }));
        await screen.findByText(/Minimum stats updated/);
        expect('minStats' in stored()).toBe(false);
        expect('minStats' in (await db.builds.toArray())[0]).toBe(false);
        expect(screen.getByRole('region', { name: /details for seeded build/i })).not.toHaveTextContent('Minimum stats');
      });

      it('shows an error and saves nothing for invalid input', async () => {
        const { user } = await openEditor();
        await user.clear(field(/Minimum Crit Rate/));
        await user.type(field(/Minimum Crit Rate/), 'abc');
        await user.click(screen.getByRole('button', { name: 'Save minimum stats' }));
        expect(await screen.findByRole('alert')).toHaveTextContent(/Minimum Crit Rate must be a non-negative number/);
        expect(stored().minStats).toEqual(detailed.minStats);

        await user.clear(field(/Minimum Crit Rate/));
        await user.type(field(/Minimum Crit Rate/), '-5');
        await user.click(screen.getByRole('button', { name: 'Save minimum stats' }));
        expect(await screen.findByRole('alert')).toHaveTextContent(/Crit Rate must be a non-negative number/);
        expect(stored().minStats).toEqual(detailed.minStats);
        expect(screen.queryByText(/Minimum stats updated/)).not.toBeInTheDocument();
      });

      it('Cancel closes the editor without saving, and reopening starts from the saved values', async () => {
        const { user } = await openEditor();
        await user.clear(field(/Minimum Energy Regen/));
        await user.type(field(/Minimum Energy Regen/), '99');
        await user.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(screen.queryByRole('form', { name: /edit minimum stats/i })).not.toBeInTheDocument();
        expect(stored().minStats).toEqual(detailed.minStats);
        await user.click(screen.getByRole('button', { name: 'Edit minimum stats' }));
        expect(field(/Minimum Energy Regen/)).toHaveValue('20');
      });

      it('Undo restores the previous minimums', async () => {
        const { user } = await openEditor();
        await user.clear(field(/Minimum Crit Rate/));
        await user.type(field(/Minimum Crit Rate/), '75');
        await user.click(screen.getByRole('button', { name: 'Save minimum stats' }));
        await screen.findByText(/Minimum stats updated/);
        await user.click(screen.getByRole('button', { name: 'Undo' }));
        await screen.findByText(/Restored the previous minimum stats/);
        expect(stored().minStats).toEqual(detailed.minStats);
        expect((await db.builds.toArray())[0].minStats).toEqual(detailed.minStats);
      });

      it('Undo of a first-time set makes the key absent again', async () => {
        const { user } = await openEditor({ ...seed });
        await user.type(field(/Minimum Crit Rate/), '70');
        await user.click(screen.getByRole('button', { name: 'Save minimum stats' }));
        await screen.findByText(/Minimum stats updated/);
        expect(stored().minStats?.critRate).toBeCloseTo(0.7, 10);
        await user.click(screen.getByRole('button', { name: 'Undo' }));
        await screen.findByText(/Restored the previous minimum stats/);
        expect('minStats' in stored()).toBe(false);
        expect('minStats' in (await db.builds.toArray())[0]).toBe(false);
      });

      it('Undo of a clear brings the minimums back', async () => {
        const { user } = await openEditor();
        await user.clear(field(/Minimum Energy Regen/));
        await user.clear(field(/Minimum Crit Rate/));
        await user.click(screen.getByRole('button', { name: 'Save minimum stats' }));
        await screen.findByText(/Minimum stats updated/);
        await user.click(screen.getByRole('button', { name: 'Undo' }));
        await screen.findByText(/Restored the previous minimum stats/);
        expect(stored().minStats).toEqual(detailed.minStats);
      });

      it('Undo leaves a build alone that was edited again since', async () => {
        const { user, saved } = await openEditor();
        await user.clear(field(/Minimum Crit Rate/));
        await user.type(field(/Minimum Crit Rate/), '75');
        await user.click(screen.getByRole('button', { name: 'Save minimum stats' }));
        await screen.findByText(/Minimum stats updated/);
        await useLibraryStore.getState().updateBuild(saved.id, { minStats: { critDmg: 2 } });
        await user.click(screen.getByRole('button', { name: 'Undo' }));
        await screen.findByText(/changed since, left as is/);
        expect(stored().minStats).toEqual({ critDmg: 2 });
      });

      it('is not offered on a reference build', async () => {
        const user = userEvent.setup();
        await useLibraryStore.getState().importBuilds([referenceBuildFrom(sharedPayload)]);
        render(<BuildsPage />);
        await screen.findByText('Friend Jiyan');
        await user.click(screen.getByRole('button', { name: /show details for friend jiyan/i }));
        expect(screen.getByRole('region', { name: /details for friend jiyan/i })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Edit minimum stats' })).not.toBeInTheDocument();
      });
    });

    it('opens a saved reference build to its own five Echoes, with no inventory lookups', async () => {
      const user = userEvent.setup();
      await useLibraryStore.getState().importBuilds([referenceBuildFrom(sharedPayload)]);
      render(<BuildsPage />);
      await screen.findByText('Friend Jiyan');
      expect(screen.getByText('reference')).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: /details for friend jiyan/i })).not.toBeInTheDocument();
      const toggle = screen.getByRole('button', { name: /show details for friend jiyan/i });
      expect(toggle).toHaveAttribute('aria-expanded', 'false');

      await user.click(toggle);
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
      const region = screen.getByRole('region', { name: /details for friend jiyan/i });
      expect(toggle).toHaveAttribute('aria-controls', region.id);
      const rows = within(within(region).getByRole('list', { name: 'Shared Echoes' })).getAllByRole('listitem');
      expect(rows).toHaveLength(5);
      expect(rows[0]).toHaveTextContent(/Slot 1 \(main\) · Feilian Beringal/);
      expect(rows[0]).toHaveTextContent('Crit Rate 22%');
      expect(rows[4]).toHaveTextContent('Chirpuff');
      expect(region).toHaveTextContent(/Jiyan Lv 90 · S6/);
      // The list row already shows the name; the opened card doesn't repeat it.
      expect(within(region).queryByText('Friend Jiyan')).not.toBeInTheDocument();
      expect(screen.queryByText(/missing/i)).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /hide details for friend jiyan/i }));
      expect(screen.queryByRole('region', { name: /details for friend jiyan/i })).not.toBeInTheDocument();
    });
  });

  it('deletes a build', async () => {
    const user = userEvent.setup();
    await useLibraryStore.getState().saveBuild(seed);
    render(<BuildsPage />);
    await screen.findByText('Seeded Build');

    // The visible label stays short (a long build name overflowed phones);
    // the accessible name still says which build.
    const del = screen.getByRole('button', { name: 'Delete Seeded Build' });
    expect(del).toHaveTextContent(/^Delete$/);
    await user.click(del);
    expect(useLibraryStore.getState().builds).toEqual([]);
    expect(await db.builds.count()).toBe(0);
  });

  it('exports builds as a JSON download', async () => {
    const user = userEvent.setup();
    const created = await useLibraryStore.getState().saveBuild(seed);
    const createObjectURL = vi.fn((blob: Blob) => {
      expect(blob).toBeInstanceOf(Blob);
      return 'blob:mock';
    });
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL: vi.fn() });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    render(<BuildsPage />);
    await screen.findByText('Seeded Build');
    await user.click(screen.getByRole('button', { name: /export/i }));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0][0];
    const parsed = JSON.parse(await blob.text()) as { id: string; name: string }[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ id: created.id, name: 'Seeded Build' });
    clickSpy.mockRestore();
  });

  it('imports pasted JSON and rejects garbage', async () => {
    const user = userEvent.setup();
    render(<BuildsPage />);

    const valid = JSON.stringify([
      { ...seed, name: 'Imported', updatedAt: new Date().toISOString() },
    ]);
    // fireEvent: user.type() would parse the JSON braces as key descriptors.
    fireEvent.change(screen.getByLabelText(/paste build json/i), { target: { value: valid } });
    await user.click(screen.getByRole('button', { name: /^import$/i }));
    expect(await screen.findByText('Imported')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/paste build json/i), { target: { value: 'not json' } });
    await user.click(screen.getByRole('button', { name: /^import$/i }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(useLibraryStore.getState().builds).toHaveLength(1);
  });

  it('copies a self-contained v2 link; the rotation toggle adds the objective', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await db.ownedEchoes.bulkAdd(ownEchoes);
    await db.roster.add(myRoster);
    await useLibraryStore.getState().saveBuild({
      ...seed,
      objective: { kind: 'expected-damage', skillId: LIBERATION, motionName: 'Lance of Qingloong Stage 1 DMG', forteLevel: 10, crit: 'expected' },
    });

    render(<BuildsPage />);
    await screen.findByText('Seeded Build');
    const copy = screen.getByRole('button', { name: /copy link/i });
    await vi.waitFor(() => expect(copy).toBeEnabled());
    await user.click(copy);
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const plain = writeText.mock.calls[0][0] as string;
    expect(plain).toContain('#b=2.');
    const decoded = await decodeShareLink(plain.slice(plain.indexOf('#')));
    expect(decoded.version).toBe(2);
    if (decoded.version !== 2) return;
    expect(decoded.shared.character).toMatchObject({ id: 'jiyan', level: 70 });
    expect(decoded.shared.echoes.map((e) => e.def)).toEqual(ownEchoes.map((e) => e.echoDefId));
    expect(decoded.shared.objective).toBeUndefined();

    await user.click(screen.getByRole('checkbox', { name: /include rotation in the link for seeded build/i }));
    await user.click(copy);
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    const withRotation = writeText.mock.calls[1][0] as string;
    expect(withRotation).not.toBe(plain);
    const decoded2 = await decodeShareLink(withRotation.slice(withRotation.indexOf('#')));
    expect(decoded2.version === 2 && decoded2.shared.objective?.kind).toBe('expected-damage');
  });

  it('explains why a link cannot be made instead of guessing', async () => {
    const user = userEvent.setup();
    await useLibraryStore.getState().saveBuild(seed);
    render(<BuildsPage />);
    await screen.findByText('Seeded Build');
    const copy = screen.getByRole('button', { name: /copy link/i });
    await vi.waitFor(() => expect(copy).toBeEnabled());
    await user.click(copy);
    expect(await screen.findByText(/no longer in your inventory/i)).toBeInTheDocument();
  });

  it('previews a v2 link as a build card and flags out-of-range values', async () => {
    const payload: SharedBuild = {
      ...sharedPayload,
      echoes: [
        { ...sharedPayload.echoes[0], main: { stat: 'critRate', value: 0.5 } },
        ...sharedPayload.echoes.slice(1),
      ] as SharedBuild['echoes'],
    };
    await openLink(payload);
    render(<BuildsPage />);
    const preview = await screen.findByRole('region', { name: 'Shared build' });
    expect(within(preview).getByText('Friend Jiyan')).toBeInTheDocument();
    expect(within(preview).getByRole('list', { name: 'Shared Echoes' }).children).toHaveLength(5);
    const stats = within(preview).getByLabelText('Key stats');
    expect(within(stats).getByText('Crit Rate')).toBeInTheDocument();
    expect(within(preview).getByText(/1 value falls outside/i)).toBeInTheDocument();
    expect(within(preview).getByText(/out of range: 5★ \+25 value is 0\.22/i)).toBeInTheDocument();
    expect(await db.builds.count()).toBe(0);
  });

  it('handles ids the recipient game data does not know', async () => {
    await openLink({ ...sharedPayload, character: { ...sharedPayload.character, id: 'nobody' } });
    render(<BuildsPage />);
    const preview = await screen.findByRole('region', { name: 'Shared build' });
    expect(within(preview).getByText(/unknown character "nobody"/i)).toBeInTheDocument();
    expect(within(preview).getByRole('button', { name: /optimize with my echoes/i })).toBeDisabled();
  });

  it('saves as a reference without adding Echoes to the inventory', async () => {
    const user = userEvent.setup();
    await db.ownedEchoes.bulkAdd(ownEchoes.slice(0, 2));
    await openLink(sharedPayload);
    render(<BuildsPage />);
    const preview = await screen.findByRole('region', { name: 'Shared build' });
    await user.click(within(preview).getByRole('button', { name: /save as reference/i }));
    expect(await screen.findByText(/saved “friend jiyan” as a reference build/i)).toBeInTheDocument();
    expect(await db.ownedEchoes.count()).toBe(2);
    const rows = await db.builds.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0].reference).toEqual(sharedPayload);
    expect(rows[0].echoIds).toEqual(['ref:0', 'ref:1', 'ref:2', 'ref:3', 'ref:4']);
    expect(screen.getByText('reference')).toBeInTheDocument();
    expect(window.location.hash).toBe('#builds');
  });

  it('optimize loads a calculator draft and leaves the roster alone', async () => {
    const user = userEvent.setup();
    await db.roster.add(myRoster);
    await openLink(sharedPayload);
    render(<BuildsPage />);
    const preview = await screen.findByRole('region', { name: 'Shared build' });
    await user.click(within(preview).getByRole('button', { name: /optimize with my echoes/i }));
    expect(useAppStore.getState().activeSection).toBe('calculator');
    expect(useCalculatorStore.getState()).toMatchObject({
      characterId: 'jiyan',
      level: 90,
      resonanceChain: 6,
      weaponRank: 5,
      rosterSourceId: '',
      draftSource: 'Friend Jiyan',
    });
    expect(await db.roster.get('jiyan')).toEqual(myRoster);
    expect(await db.builds.count()).toBe(0);
  });

  describe('links that carry run settings (v3)', () => {
    const v3: SharedBuild = {
      ...sharedPayload,
      v: 3,
      enemy: { kind: 'boss', level: 100, baseRES: 0.2 },
      minStats: { energyRegen: 0.2, critRate: 0.6 },
    };
    const denia: SharedBuild = {
      ...v3,
      character: { ...v3.character, id: 'denia' },
      weapon: { ...v3.weapon, id: 'augment' },
      resonanceMode: 'tuneStrain',
    };

    it('previews the enemy, Resonance Mode and minimum stats, and nothing for a plain link', async () => {
      await openLink(denia);
      const { unmount } = render(<BuildsPage />);
      const settings = within(await screen.findByRole('region', { name: 'Shared build' })).getByLabelText('Run settings');
      expect(settings).toHaveTextContent(/Enemy\s*boss, Lv 100, 20% base RES/);
      expect(settings).toHaveTextContent(/Resonance Mode\s*Tune Strain/);
      expect(settings).toHaveTextContent(/Minimum stats\s*Energy Regen ≥ 20%, Crit Rate ≥ 60%/);
      unmount();

      await openLink(sharedPayload);
      render(<BuildsPage />);
      const preview = await screen.findByRole('region', { name: 'Shared build' });
      await within(preview).findByLabelText('Key stats');
      expect(within(preview).queryByLabelText('Run settings')).not.toBeInTheDocument();
    });

    it("ignores a Resonance Mode the character doesn't have", async () => {
      await openLink({ ...v3, resonanceMode: 'tuneStrain' }); // Jiyan has no modes
      render(<BuildsPage />);
      const settings = within(await screen.findByRole('region', { name: 'Shared build' })).getByLabelText('Run settings');
      expect(settings).not.toHaveTextContent('Resonance Mode');
      expect(settings).toHaveTextContent('Enemy');
    });

    it('Optimize with my Echoes applies them to the Calculator draft and prefills the minimums, writing nothing', async () => {
      const user = userEvent.setup();
      await db.roster.add(myRoster);
      await openLink(denia);
      render(<BuildsPage />);
      const preview = await screen.findByRole('region', { name: 'Shared build' });
      await user.click(within(preview).getByRole('button', { name: /optimize with my echoes/i }));
      expect(useAppStore.getState().activeSection).toBe('calculator');
      expect(useCalculatorStore.getState()).toMatchObject({
        characterId: 'denia',
        enemyKind: 'boss',
        enemyLevel: 100,
        enemyBaseRES: 0.2,
        resonanceMode: 'tuneStrain',
        rosterSourceId: '',
        minStatTexts: { energyRegen: '20', critRate: '60' },
      });
      expect(await db.roster.get('jiyan')).toEqual(myRoster);
      expect(await db.roster.count()).toBe(1);
      expect(await db.builds.count()).toBe(0);
    });

    it('a v3 link without minimums clears the prefilled boxes, but leaves the enemy alone', async () => {
      const user = userEvent.setup();
      useCalculatorStore.getState().setEnemyLevel(77);
      useCalculatorStore.getState().setMinStatTexts({ critDmg: '200', critRate: '70' });
      const { minStats: _dropped, ...noMins } = v3;
      void _dropped;
      await openLink(noMins);
      render(<BuildsPage />);
      const preview = await screen.findByRole('region', { name: 'Shared build' });
      await user.click(within(preview).getByRole('button', { name: /optimize with my echoes/i }));
      expect(useCalculatorStore.getState().minStatTexts).toEqual({});
      // The link's enemy is applied; only the boxes are cleared.
      expect(useCalculatorStore.getState()).toMatchObject({ enemyLevel: 100, enemyKind: 'boss' });
    });

    it('a v3 link with minimums replaces whatever the boxes held', async () => {
      const user = userEvent.setup();
      useCalculatorStore.getState().setMinStatTexts({ critDmg: '200' });
      await openLink(v3);
      render(<BuildsPage />);
      const preview = await screen.findByRole('region', { name: 'Shared build' });
      await user.click(within(preview).getByRole('button', { name: /optimize with my echoes/i }));
      expect(useCalculatorStore.getState().minStatTexts).toEqual({ energyRegen: '20', critRate: '60' });
    });

    it('a plain (v2) link leaves the Calculator enemy and minimum boxes alone', async () => {
      const user = userEvent.setup();
      useCalculatorStore.getState().setEnemyLevel(77);
      useCalculatorStore.getState().setMinStatTexts({ critDmg: '200' });
      await openLink(sharedPayload);
      render(<BuildsPage />);
      const preview = await screen.findByRole('region', { name: 'Shared build' });
      await user.click(within(preview).getByRole('button', { name: /optimize with my echoes/i }));
      expect(useCalculatorStore.getState()).toMatchObject({ enemyLevel: 77, minStatTexts: { critDmg: '200' } });
    });

    it('Save as reference keeps them, and the reference details show them', async () => {
      const user = userEvent.setup();
      await openLink(v3);
      render(<BuildsPage />);
      const preview = await screen.findByRole('region', { name: 'Shared build' });
      await user.click(within(preview).getByRole('button', { name: /save as reference/i }));
      await screen.findByText(/saved “friend jiyan” as a reference build/i);
      const [row] = await db.builds.toArray();
      expect(row.reference).toEqual(v3);

      await user.click(await screen.findByRole('button', { name: /show details for friend jiyan/i }));
      const region = screen.getByRole('region', { name: /details for friend jiyan/i });
      expect(region).toHaveTextContent(/Enemy\s*boss, Lv 100, 20% base RES/);
      expect(region).toHaveTextContent(/Minimum stats\s*Energy Regen ≥ 20%, Crit Rate ≥ 60%/);
    });

    it('Copy link on an own build with settings produces a v3 link that opens', async () => {
      const user = userEvent.setup();
      await db.ownedEchoes.bulkAdd(ownEchoes);
      await db.roster.add(myRoster);
      await useLibraryStore.getState().saveBuild({
        ...seed,
        enemy: { kind: 'boss', level: 100, baseRES: 0.2 },
        minStats: { critRate: 0.6 },
      });
      let copied = '';
      vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: (t: string) => ((copied = t), Promise.resolve()) } });
      render(<BuildsPage />);
      await screen.findByText('Seeded Build');
      await user.click(screen.getByRole('button', { name: /copy link/i }));
      await vi.waitFor(() => expect(copied).toContain('#b=3.'));
      const decoded = await decodeShareLink(copied.slice(copied.indexOf('#b=')));
      expect(decoded).toMatchObject({ version: 3, shared: { enemy: { level: 100 }, minStats: { critRate: 0.6 } } });
    });
  });

  it('previews a shared build from the link and writes nothing until Import', async () => {
    const user = userEvent.setup();
    const saved = await useLibraryStore.getState().saveBuild(seed);
    await db.builds.clear();
    useLibraryStore.setState({ builds: [], loaded: false });
    const link = encodeBuildLink({ ...saved });
    window.history.replaceState(null, '', `/${link}`);
    useAppStore.setState({ shareLink: link });

    render(<BuildsPage />);
    const preview = await screen.findByRole('region', { name: 'Shared build' });
    expect(within(preview).getByText('Seeded Build')).toBeInTheDocument();
    expect(within(preview).getByText(/99\.5/)).toBeInTheDocument();
    expect(useLibraryStore.getState().builds).toHaveLength(0);
    expect(await db.builds.count()).toBe(0);

    await user.click(within(preview).getByRole('button', { name: /import shared build/i }));
    expect(await screen.findByText(/imported shared build/i)).toBeInTheDocument();
    expect(await db.builds.count()).toBe(1);
    expect(screen.queryByRole('region', { name: 'Shared build' })).toBeNull();
    expect(useAppStore.getState().shareLink).toBeNull();
    expect(window.location.hash).toBe('#builds');
  });

  it('dismisses a shared build without saving it', async () => {
    const user = userEvent.setup();
    const saved = await useLibraryStore.getState().saveBuild(seed);
    await db.builds.clear();
    useLibraryStore.setState({ builds: [], loaded: false });
    const link = encodeBuildLink({ ...saved });
    window.history.replaceState(null, '', `/${link}`);
    useAppStore.setState({ shareLink: link });

    render(<BuildsPage />);
    const preview = await screen.findByRole('region', { name: 'Shared build' });
    await user.click(within(preview).getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByRole('region', { name: 'Shared build' })).toBeNull();
    expect(await db.builds.count()).toBe(0);
    expect(window.location.hash).toBe('#builds');
  });

  it('reports a corrupt share link instead of importing', async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, '', '/#b=not-base64!');
    useAppStore.setState({ shareLink: '#b=not-base64!' });

    render(<BuildsPage />);
    expect(await screen.findByText(/could not open the shared build/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByText(/could not open the shared build/i)).toBeNull();
    expect(await db.builds.count()).toBe(0);
  });
});
