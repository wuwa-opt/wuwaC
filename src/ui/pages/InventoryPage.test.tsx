import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Build, OwnedEcho } from '../../data/schema.ts';
import { db } from '../../state/db.ts';
import { useInventoryStore } from '../../state/inventory.ts';
import { useLibraryStore } from '../../state/library.ts';
import { InventoryPage } from './InventoryPage.tsx';

beforeEach(async () => {
  await db.ownedEchoes.clear();
  await db.builds.clear();
  useInventoryStore.setState({ echoes: [], loaded: false });
  useLibraryStore.setState({ builds: [], loaded: false });
});

async function addEchoViaUi(user: ReturnType<typeof userEvent.setup>, nickname?: string): Promise<void> {
  await user.click(screen.getByRole('button', { name: /add echo/i }));
  await user.selectOptions(screen.getByLabelText(/^echo$/i), 'hooscamp');
  if (nickname) await user.type(screen.getByLabelText(/nickname/i), nickname);
  await user.type(screen.getByLabelText(/main stat value/i), '30');
  await user.click(screen.getByRole('button', { name: /^add echo$/i }));
}

/** Select an echo in the Echo Box and return the Status window it opens. */
async function selectEcho(user: ReturnType<typeof userEvent.setup>, name: string): Promise<HTMLElement> {
  await user.click(within(screen.getByRole('table')).getByRole('button', { name }));
  return screen.getByRole('region', { name: 'Status' });
}

describe('InventoryPage', () => {
  it('shows an empty state with zero echoes', async () => {
    render(<InventoryPage />);
    expect(await screen.findByText(/no echoes yet/i)).toBeInTheDocument();
  });

  it('adds an echo through the form and persists it', async () => {
    const user = userEvent.setup();
    render(<InventoryPage />);
    await screen.findByText(/no echoes yet/i);

    await addEchoViaUi(user, 'Page Echo');

    expect(await screen.findByText('Page Echo')).toBeInTheDocument();
    expect(screen.queryByText(/no echoes yet/i)).not.toBeInTheDocument();
    const rows = await db.ownedEchoes.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: 'Page Echo', echoDefId: 'hooscamp', cost: 1 });
  });

  it('falls back to the def name without a nickname', async () => {
    const user = userEvent.setup();
    render(<InventoryPage />);
    await screen.findByText(/no echoes yet/i);

    await addEchoViaUi(user);

    expect(await screen.findByText('Hooscamp')).toBeInTheDocument();
  });

  it('edits a nickname', async () => {
    const user = userEvent.setup();
    render(<InventoryPage />);
    await addEchoViaUi(user, 'Page Echo');

    const status = await selectEcho(user, 'Page Echo');
    await user.click(within(status).getByRole('button', { name: /edit/i }));
    const nameField = screen.getByLabelText(/nickname/i);
    await user.clear(nameField);
    await user.type(nameField, 'Renamed');
    await user.click(screen.getByRole('button', { name: /save/i }));

    await within(screen.getByRole('table')).findByRole('button', { name: 'Renamed' });
    expect(screen.queryByText('Page Echo')).not.toBeInTheDocument();
    const rows = await db.ownedEchoes.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('Renamed');
  });

  it('deletes an echo and returns to the empty state', async () => {
    const user = userEvent.setup();
    render(<InventoryPage />);
    await addEchoViaUi(user, 'Page Echo');

    const status = await selectEcho(user, 'Page Echo');
    await user.click(within(status).getByRole('button', { name: /delete/i }));

    expect(await screen.findByText(/no echoes yet/i)).toBeInTheDocument();
    expect(await db.ownedEchoes.count()).toBe(0);
  });

  it('locks an echo: Delete is disabled until unlocked, and the lock persists', async () => {
    const user = userEvent.setup();
    render(<InventoryPage />);
    await addEchoViaUi(user, 'Page Echo');
    const status = await selectEcho(user, 'Page Echo');

    await user.click(within(status).getByRole('button', { name: 'Lock' }));

    expect(await within(status).findByRole('button', { name: 'Unlock' })).toHaveAttribute('aria-pressed', 'true');
    const del = within(status).getByRole('button', { name: /delete/i });
    expect(del).toBeDisabled();
    expect(del).toHaveAccessibleDescription(/unlock this echo to delete it/i);
    expect(within(screen.getByRole('table')).getByText('Locked')).toBeInTheDocument();
    expect((await db.ownedEchoes.toArray())[0].locked).toBe(true);

    await user.click(within(status).getByRole('button', { name: 'Unlock' }));
    await waitFor(() => expect(within(status).getByRole('button', { name: /delete/i })).toBeEnabled());
    expect((await db.ownedEchoes.toArray())[0]).not.toHaveProperty('locked');
    expect(within(screen.getByRole('table')).queryByText('Locked')).not.toBeInTheDocument();
  });

  it('offers Undo after a delete and puts the same row back', async () => {
    const user = userEvent.setup();
    render(<InventoryPage />);
    await addEchoViaUi(user, 'Page Echo');
    const [before] = await db.ownedEchoes.toArray();

    const status = await selectEcho(user, 'Page Echo');
    await user.click(within(status).getByRole('button', { name: /delete/i }));
    await screen.findByText(/no echoes yet/i);
    expect(screen.getByText('Echo deleted.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Undo' }));

    expect(await screen.findByText('Page Echo')).toBeInTheDocument();
    expect(screen.getByText('Restored 1 echo.')).toBeInTheDocument();
    expect(await db.ownedEchoes.get(before.id)).toEqual(before);
  });

  it('drops the Undo offer when the inventory reloads', async () => {
    const user = userEvent.setup();
    render(<InventoryPage />);
    await addEchoViaUi(user, 'Page Echo');
    const status = await selectEcho(user, 'Page Echo');
    await user.click(within(status).getByRole('button', { name: /delete/i }));
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeInTheDocument();

    await useInventoryStore.getState().load();

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument());
  });

  it('shows errors and writes nothing when no Echo is picked', async () => {
    const user = userEvent.setup();
    render(<InventoryPage />);
    await screen.findByText(/no echoes yet/i);

    await user.click(screen.getByRole('button', { name: /add echo/i }));
    await user.click(screen.getByRole('button', { name: /^add echo$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/pick an echo/i);
    expect(await db.ownedEchoes.count()).toBe(0);
  });

  it('filters the list by sonata set and restores with all sets', async () => {
    const lingering: OwnedEcho = {
      id: 'echo-lingering',
      label: 'Lingering One',
      echoDefId: 'hooscamp',
      sonataId: 'lingering-tunes',
      cost: 1,
      level: 25,
      rarity: 5,
      mainStat: { stat: 'atkPct', value: 0.3 },
      substats: [],
      equippedTo: null,
      origin: 'manual',
    };
    const thunder: OwnedEcho = {
      ...lingering,
      id: 'echo-thunder',
      label: 'Thunder One',
      echoDefId: 'tempest-mephis',
      sonataId: 'void-thunder',
      cost: 4,
    };
    await db.ownedEchoes.bulkAdd([lingering, thunder]);
    const user = userEvent.setup();
    render(<InventoryPage />);

    expect(await screen.findByText('Lingering One')).toBeInTheDocument();
    expect(screen.getByText('Thunder One')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText(/sonata set/i), 'lingering-tunes');
    expect(screen.getByText('Lingering One')).toBeInTheDocument();
    expect(screen.queryByText('Thunder One')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /echo inventory/i })).toHaveTextContent('(1/2)');

    await user.selectOptions(screen.getByLabelText(/sonata set/i), '');
    expect(screen.getByText('Lingering One')).toBeInTheDocument();
    expect(screen.getByText('Thunder One')).toBeInTheDocument();
  });

  it('shows an empty-filter state when no echo matches the sonata set', async () => {
    await db.ownedEchoes.add({
      id: 'echo-lingering',
      label: 'Lingering One',
      echoDefId: 'hooscamp',
      sonataId: 'lingering-tunes',
      cost: 1,
      level: 25,
      rarity: 5,
      mainStat: { stat: 'atkPct', value: 0.3 },
      substats: [],
      equippedTo: null,
      origin: 'manual',
    });
    const user = userEvent.setup();
    render(<InventoryPage />);

    await screen.findByText('Lingering One');
    await user.selectOptions(screen.getByLabelText(/sonata set/i), 'void-thunder');
    expect(await screen.findByText(/no echoes with this sonata set/i)).toBeInTheDocument();
  });

  it('previews a Kamera file and imports the matchable rows', async () => {
    const user = userEvent.setup();
    render(<InventoryPage />);
    await screen.findByText(/no echoes yet/i);

    const file = new File(
      [
        JSON.stringify([
          {
            Hooscamp: {
              level: 25,
              tuneLv: 1,
              sonata: 'lingeringtunes',
              rarity: 5,
              stats: { main: { 'atk%': 30 }, sub: { cr: 8.7 } },
            },
          },
          { '340000070': { level: 25, tuneLv: 0, sonata: 'voidthunder', rarity: 5, stats: { main: { atk: 60 }, sub: {} } } },
        ]),
      ],
      'echoes_wuwainventorykamera.json',
      { type: 'application/json' },
    );
    await user.upload(screen.getByLabelText(/import echoes file/i), file);

    expect(await screen.findByText(/1 echo ready to add, 1 skipped/i)).toBeInTheDocument();
    expect(screen.getByText(/row 2 \(340000070\)/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^add 1 echo$/i }));

    expect(await screen.findByText('Hooscamp')).toBeInTheDocument();
    const rows = await db.ownedEchoes.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      echoDefId: 'hooscamp',
      sonataId: 'lingering-tunes',
      origin: 'import:wuwa-inventory-kamera',
      mainStat: { stat: 'atkPct', value: 0.3 },
    });
  });

  it('cancels an import preview without writing anything', async () => {
    const user = userEvent.setup();
    render(<InventoryPage />);
    await screen.findByText(/no echoes yet/i);

    const file = new File(
      [
        JSON.stringify([
          {
            hooscamp: {
              level: 0,
              tuneLv: 0,
              sonata: 'sierragale',
              rarity: 5,
              stats: { main: { 'atk%': 18.0, hp: 2280 }, sub: {} },
            },
          },
        ]),
      ],
      'echoes.json',
      { type: 'application/json' },
    );
    await user.upload(screen.getByLabelText(/import echoes file/i), file);
    expect(await screen.findByText(/1 echo ready to add, 0 skipped/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(screen.queryByText(/ready to add/i)).not.toBeInTheDocument();
    expect(await db.ownedEchoes.count()).toBe(0);
  });

  it('alerts on a non-JSON import file', async () => {
    const user = userEvent.setup();
    render(<InventoryPage />);
    await screen.findByText(/no echoes yet/i);

    const file = new File(['definitely not json'], 'echoes.json', { type: 'application/json' });
    await user.upload(screen.getByLabelText(/import echoes file/i), file);

    expect(await screen.findByRole('alert')).toHaveTextContent(/not a JSON file/i);
    expect(await db.ownedEchoes.count()).toBe(0);
  });

  it('exports the inventory in the Kamera shape', async () => {
    await db.ownedEchoes.add({
      id: 'echo-export',
      echoDefId: 'hooscamp',
      sonataId: 'sierra-gale',
      cost: 1,
      level: 25,
      rarity: 5,
      mainStat: { stat: 'atkPct', value: 0.3 },
      substats: [{ stat: 'critRate', value: 0.087 }],
      equippedTo: null,
      origin: 'manual',
    });
    const blobs: Blob[] = [];
    const downloads: { href: string; download: string }[] = [];
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: vi.fn((blob: Blob) => {
          blobs.push(blob);
          return 'blob:mock-export';
        }),
        revokeObjectURL: vi.fn(),
      }),
    );
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        downloads.push({ href: this.href, download: this.download });
      });
    try {
      const user = userEvent.setup();
      render(<InventoryPage />);
      await screen.findByText('Hooscamp');

      await user.click(screen.getByRole('button', { name: /^export$/i }));

      expect(blobs).toHaveLength(1);
      expect(JSON.parse(await blobs[0].text())).toEqual([
        {
          hooscamp: {
            level: 25,
            tuneLv: 1,
            sonata: 'sierragale',
            rarity: 5,
            stats: { main: { 'atk%': 30 }, sub: { 'cr%': 8.7 } },
          },
        },
      ]);
      expect(downloads).toEqual([{ href: 'blob:mock-export', download: 'echoes_wuwainventorykamera.json' }]);
    } finally {
      clickSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('flags orphan rows and re-links them through edit', async () => {
    const orphan: OwnedEcho = {
      id: 'orphan-1',
      label: 'Old Echo',
      echoDefId: 'slugged-label',
      sonataId: 'sierra-gale',
      cost: 3,
      level: 25,
      rarity: 5,
      mainStat: { stat: 'atkPct', value: 0.3 },
      substats: [],
      equippedTo: null,
      origin: 'manual',
    };
    await db.ownedEchoes.add(orphan);
    const user = userEvent.setup();
    render(<InventoryPage />);

    expect(await screen.findByText(/re-linking — press edit/i)).toBeInTheDocument();
    expect(screen.getByText(/needs re-link:/i)).toBeInTheDocument();

    const status = await selectEcho(user, 'Old Echo');
    await user.click(within(status).getByRole('button', { name: /edit/i }));
    await user.selectOptions(screen.getByLabelText(/^echo$/i), 'hooscamp');
    await user.click(screen.getByRole('button', { name: /save/i }));

    // Cost force-fixed to the def (1), banner clears.
    expect(await db.ownedEchoes.get('orphan-1')).toMatchObject({ echoDefId: 'hooscamp', cost: 1 });
    expect(screen.queryByText(/re-linking — press edit/i)).not.toBeInTheDocument();
  });

  describe('Pixel Arcade box', () => {
    const base: OwnedEcho = {
      id: 'a',
      label: 'Alpha',
      echoDefId: 'hooscamp',
      sonataId: 'sierra-gale',
      cost: 1,
      level: 25,
      rarity: 5,
      mainStat: { stat: 'atkPct', value: 0.18 },
      substats: [
        { stat: 'critRate', value: 0.093 },
        { stat: 'atk', value: 30 },
      ],
      equippedTo: null,
      origin: 'manual',
    };

    it('puts substats in aligned columns and shows roll tiers in the Status window', async () => {
      await db.ownedEchoes.add(base);
      const user = userEvent.setup();
      render(<InventoryPage />);
      await screen.findByText('Alpha');

      const row = screen.getByText('Alpha').closest('tr')!;
      const cells = within(row).getAllByRole('cell');
      // Echo | Cost | Lv | Main | CR | CD | ATK% | ER | Roll | Other
      expect(cells[4]).toHaveTextContent('9.3%');
      expect(cells[5]).toHaveTextContent('–');
      expect(cells[9]).toHaveTextContent('ATK 30');
      // critRate tier 6/8 (75) and atk 1/4 (25) average to a roll value of 50.
      expect(within(row).getByRole('img', { name: 'Roll value 50 of 100' })).toBeInTheDocument();

      const status = await selectEcho(user, 'Alpha');
      expect(within(status).getByRole('img', { name: 'Crit Rate roll tier 6 of 8' })).toBeInTheDocument();
      expect(within(status).getByRole('img', { name: 'ATK roll tier 1 of 4' })).toBeInTheDocument();
    });

    it('filters the box with the cost tiles and clears on a second press', async () => {
      await db.ownedEchoes.bulkAdd([
        base,
        { ...base, id: 'b', label: 'Bravo', cost: 3, mainStat: { stat: 'atkPct', value: 0.3 } },
      ]);
      const user = userEvent.setup();
      render(<InventoryPage />);
      await screen.findByText('Alpha');

      const tile = screen.getByRole('button', { name: /3-cost/ });
      await user.click(tile);
      expect(tile).toHaveAttribute('aria-pressed', 'true');
      expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
      expect(screen.getByText('Bravo')).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: /echo inventory/i })).toHaveTextContent('(1/2)');

      await user.click(tile);
      expect(screen.getByText('Alpha')).toBeInTheDocument();
    });

    it('summarises the box in the speech bubble', async () => {
      await db.ownedEchoes.add(base);
      render(<InventoryPage />);
      expect(await screen.findByText(/You're holding 1 echo across 1 Sonata set/)).toBeInTheDocument();
    });
  });

  describe('unused-Echo finder', () => {
    const one: OwnedEcho = {
      id: 's1',
      label: 'Strong 1',
      echoDefId: 'hooscamp',
      sonataId: 'sierra-gale',
      cost: 1,
      level: 25,
      rarity: 5,
      mainStat: { stat: 'atkPct', value: 0.3 },
      substats: [],
      equippedTo: null,
      origin: 'manual',
    };
    // Five same-def 1-costs fill the build; a 1-cost at budget 12 needs 5 dominators (k = 5).
    const strong = [0.3, 0.29, 0.28, 0.27, 0.26].map((value, i) => ({
      ...one,
      id: `s${i + 1}`,
      label: `Strong ${i + 1}`,
      mainStat: { stat: 'atkPct' as const, value },
    }));
    const spare: OwnedEcho = { ...one, id: 'spare', label: 'Spare', mainStat: { stat: 'atkPct', value: 0.1 } };
    // The only 4-cost: nothing dominates it, so it is unused but not fodder.
    const big: OwnedEcho = {
      ...one,
      id: 'big',
      label: 'Big',
      echoDefId: 'tempest-mephis',
      sonataId: 'void-thunder',
      cost: 4,
    };
    const build: Build = {
      id: 'build-1',
      name: 'ATK% test',
      characterId: 'jiyan',
      weaponId: 'verdant-summit',
      echoIds: ['s1', 's2', 's3', 's4', 's5'],
      objectiveId: 'max-stat',
      objective: { kind: 'max-stat', stat: 'atkPct' },
      updatedAt: '2026-10-21T00:00:00.000Z',
    };

    it('counts, tags and filters unused Echoes and safe fodder', async () => {
      await db.ownedEchoes.bulkAdd([...strong, spare, big]);
      await db.builds.add(build);
      const user = userEvent.setup();
      render(<InventoryPage />);
      await screen.findByText('Spare');

      expect(await screen.findByText('2 unused')).toBeInTheDocument();
      expect(screen.getByText('1 safe fodder')).toBeInTheDocument();
      expect(screen.getByText(/not equipped and in no saved build/)).toBeInTheDocument();
      expect(screen.getByText(/for every saved build with an objective \(1\)/)).toBeInTheDocument();
      // Fodder is always tagged; plain unused only while filtering.
      const spareRow = screen.getByText('Spare').closest('tr')!;
      expect(within(spareRow).getByText('fodder')).toHaveClass('px-tag');
      expect(within(screen.getByText('Big').closest('tr')!).queryByText('unused')).not.toBeInTheDocument();

      await user.selectOptions(screen.getByLabelText(/usage/i), 'fodder');
      expect(screen.getByText('Spare')).toBeInTheDocument();
      expect(screen.queryByText('Big')).not.toBeInTheDocument();
      expect(screen.queryByText('Strong 1')).not.toBeInTheDocument();
      expect(screen.getByRole('heading', { name: /echo inventory/i })).toHaveTextContent('(1/7)');

      await user.selectOptions(screen.getByLabelText(/usage/i), 'unused');
      expect(screen.getByText('Spare')).toBeInTheDocument();
      expect(within(screen.getByText('Big').closest('tr')!).getByText('unused')).toBeInTheDocument();
      expect(screen.queryByText('Strong 5')).not.toBeInTheDocument();

      await user.selectOptions(screen.getByLabelText(/usage/i), 'all');
      expect(screen.getByText('Strong 5')).toBeInTheDocument();
    });

    describe('bulk delete', () => {
      const spare2: OwnedEcho = { ...spare, id: 'spare2', label: 'Spare 2', mainStat: { stat: 'atkPct', value: 0.09 } };

      async function openFodderFilter(user: ReturnType<typeof userEvent.setup>): Promise<void> {
        render(<InventoryPage />);
        await screen.findByText('Spare');
        await screen.findByText('2 safe fodder');
        await user.selectOptions(screen.getByLabelText(/usage/i), 'fodder');
      }

      beforeEach(async () => {
        await db.ownedEchoes.bulkAdd([...strong, spare, spare2, big]);
        await db.builds.add(build);
      });

      it('is only offered under the Safe fodder filter', async () => {
        const user = userEvent.setup();
        render(<InventoryPage />);
        await screen.findByText('2 safe fodder');
        expect(screen.queryByRole('button', { name: /safe-fodder/i })).not.toBeInTheDocument();
        await user.selectOptions(screen.getByLabelText(/usage/i), 'unused');
        expect(screen.queryByRole('button', { name: /safe-fodder/i })).not.toBeInTheDocument();
        await user.selectOptions(screen.getByLabelText(/usage/i), 'fodder');
        expect(screen.getByRole('button', { name: 'Delete 2 safe-fodder Echoes' })).toBeInTheDocument();
      });

      it('confirms with the count and Undo note, deletes only fodder, and Undo makes them fodder again', async () => {
        const user = userEvent.setup();
        await openFodderFilter(user);

        await user.click(screen.getByRole('button', { name: 'Delete 2 safe-fodder Echoes' }));
        const confirm = screen.getByRole('group', { name: /confirm bulk delete/i });
        expect(confirm).toHaveTextContent('Delete 2 safe-fodder Echoes?');
        expect(confirm).toHaveTextContent(/undo button appears right after.*lost if you leave this page or reload/i);
        expect(within(confirm).getByRole('button', { name: 'Cancel' })).toHaveFocus();

        await user.click(within(confirm).getByRole('button', { name: 'Delete 2 Echoes' }));

        await waitFor(() => expect(screen.queryByText('Spare 2')).not.toBeInTheDocument());
        expect((await db.ownedEchoes.toArray()).map((e) => e.id).sort()).toEqual(
          ['big', 's1', 's2', 's3', 's4', 's5'],
        );
        expect(screen.getByText('Deleted 2 safe-fodder Echoes.')).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Undo' }));

        expect(await screen.findByText('Spare 2')).toBeInTheDocument();
        expect(screen.getByText('Spare')).toBeInTheDocument();
        expect(await db.ownedEchoes.count()).toBe(8);
        // Same rows, same ids: the finder tags them fodder again.
        expect(await screen.findByRole('button', { name: 'Delete 2 safe-fodder Echoes' })).toBeInTheDocument();
        expect(screen.getByText('2 safe fodder')).toBeInTheDocument();
      });

      it('excludes locked Echoes from the count and the delete', async () => {
        await db.ownedEchoes.update('spare2', { locked: true });
        const user = userEvent.setup();
        render(<InventoryPage />);
        await screen.findByText('Spare');
        expect(await screen.findByText('1 safe fodder')).toBeInTheDocument();
        expect(screen.getByText('1 locked')).toBeInTheDocument();
        await user.selectOptions(screen.getByLabelText(/usage/i), 'fodder');
        expect(screen.queryByText('Spare 2')).not.toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Delete 1 safe-fodder Echo' }));
        await user.click(screen.getByRole('button', { name: 'Delete 1 Echo' }));

        await waitFor(() => expect(screen.queryByText('Spare')).not.toBeInTheDocument());
        expect((await db.ownedEchoes.toArray()).map((e) => e.id)).toContain('spare2');
        expect(await db.ownedEchoes.count()).toBe(7);
      });

      it('aborts if a confirmed Echo gets locked before the click', async () => {
        const user = userEvent.setup();
        await openFodderFilter(user);
        await user.click(screen.getByRole('button', { name: 'Delete 2 safe-fodder Echoes' }));
        await useInventoryStore.getState().setLocked(['spare2'], true);

        await user.click(screen.getByRole('button', { name: 'Delete 2 Echoes' }));

        expect(await screen.findByText(/safe-fodder list changed/i)).toBeInTheDocument();
        expect(await db.ownedEchoes.count()).toBe(8);
      });

      it('Cancel deletes nothing', async () => {
        const user = userEvent.setup();
        await openFodderFilter(user);
        await user.click(screen.getByRole('button', { name: 'Delete 2 safe-fodder Echoes' }));
        await user.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(screen.queryByRole('group', { name: /confirm bulk delete/i })).not.toBeInTheDocument();
        expect(await db.ownedEchoes.count()).toBe(8);
      });

      it('rechecks at click time and deletes nothing if the fodder set changed', async () => {
        const user = userEvent.setup();
        await openFodderFilter(user);
        await user.click(screen.getByRole('button', { name: 'Delete 2 safe-fodder Echoes' }));
        // A build starts using Spare 2 after the confirm opened.
        useLibraryStore.setState((s) => ({
          builds: s.builds.map((b) => ({ ...b, echoIds: ['s1', 's2', 's3', 's4', 'spare2'] })),
        }));

        await user.click(screen.getByRole('button', { name: 'Delete 2 Echoes' }));

        expect(await screen.findByText(/safe-fodder list changed/i)).toBeInTheDocument();
        expect(await db.ownedEchoes.count()).toBe(8);
        expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
      });
    });

    it('explains that safe fodder needs a saved build with an objective', async () => {
      await db.ownedEchoes.bulkAdd([spare, big]);
      render(<InventoryPage />);
      expect(await screen.findByText('2 unused')).toBeInTheDocument();
      expect(screen.getByText('0 safe fodder')).toBeInTheDocument();
      expect(screen.getByText(/needs a saved build with an objective/)).toBeInTheDocument();
    });
  });
});
