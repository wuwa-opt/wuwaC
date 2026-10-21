import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { loadBundledSnapshot } from '../../data/index.ts';
import { resetSnapshotStoreForTests, useSnapshotStore } from '../../state/snapshotStore.ts';
import { EchoForm } from './EchoForm.tsx';

async function pickDef(user: ReturnType<typeof userEvent.setup>, id: string) {
  await user.selectOptions(screen.getByLabelText(/^echo$/i), id);
}

afterEach(() => {
  resetSnapshotStoreForTests();
});

describe('EchoForm', () => {
  it('blocks submit until an Echo is picked', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<EchoForm submitLabel="Add Echo" onSubmit={onSubmit} />);

    await user.click(screen.getByRole('button', { name: 'Add Echo' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/pick an echo/i);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('derives cost and sonata options from the picked Echo', async () => {
    const user = userEvent.setup();
    render(<EchoForm submitLabel="Add Echo" onSubmit={() => {}} />);

    // Hooscamp is 1-cost with two sonata sets (Sierra Gale / Lingering Tunes).
    await pickDef(user, 'hooscamp');
    expect(screen.getByText(/1 \(from Hooscamp\)/)).toBeInTheDocument();
    const sonata = screen.getByLabelText(/sonata set/i);
    expect(within(sonata as HTMLElement).getByRole('option', { name: 'Sierra Gale' })).toBeInTheDocument();
    // Fusion DMG is outside Hooscamp's pool.
    expect(
      within(screen.getByLabelText(/main stat$/i) as HTMLElement).queryByRole('option', { name: /fusion/i }),
    ).not.toBeInTheDocument();
  });

  it('filters the Echo list by search and cost', async () => {
    const user = userEvent.setup();
    render(<EchoForm submitLabel="Add Echo" onSubmit={() => {}} />);

    await user.click(screen.getByRole('button', { name: /^4$/ }));
    expect(
      within(screen.getByLabelText(/^echo$/i) as HTMLElement).queryByRole('option', { name: /Hooscamp/ }),
    ).not.toBeInTheDocument();
    expect(
      within(screen.getByLabelText(/^echo$/i) as HTMLElement).getByRole('option', { name: 'Tempest Mephis (4 cost · Void Thunder)' }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^4$/ }));
    await user.type(screen.getByLabelText(/search echoes/i), 'chest mimic');
    const list = within(screen.getByLabelText(/^echo$/i) as HTMLElement);
    // Exactly one Chest Mimic: Phantom shiny variants are excluded by sync.
    expect(list.getAllByRole('option', { name: /Chest Mimic/ })).toHaveLength(1);
    expect(list.queryByRole('option', { name: /Hooscamp/ })).not.toBeInTheDocument();
  });

  it('submits a def-backed draft with ratios', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<EchoForm submitLabel="Add Echo" onSubmit={onSubmit} />);

    await pickDef(user, 'hooscamp');
    await user.selectOptions(screen.getByLabelText(/sonata set/i), 'sierra-gale');
    await user.selectOptions(screen.getByLabelText(/main stat$/i), 'atkPct');
    await user.type(screen.getByLabelText(/main stat value/i), '30');
    await user.click(screen.getByRole('button', { name: 'Add Echo' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const draft = onSubmit.mock.calls[0][0];
    expect(draft.echoDefId).toBe('hooscamp');
    expect(draft.cost).toBe(1);
    expect(draft.sonataId).toBe('sierra-gale');
    expect(draft.mainStat).toEqual({ stat: 'atkPct', value: 0.3 });
    expect(draft.label).toBeUndefined();
    // Gear is recorded by the game, not the form: an edit must not overwrite it.
    expect(draft).not.toHaveProperty('equippedTo');
  });

  it('offers Echo defs from the active snapshot, not only the bundle', async () => {
    const user = userEvent.setup();
    const bundled = loadBundledSnapshot();
    const hooscamp = bundled.echoDefs.find((d) => d.id === 'hooscamp');
    if (!hooscamp) throw new Error('fixture: hooscamp missing from the bundle');
    useSnapshotStore.setState({
      snapshot: { ...bundled, echoDefs: [...bundled.echoDefs, { ...hooscamp, id: 'published-later', name: 'Published Later' }] },
      source: 'cache',
    });
    try {
      render(<EchoForm submitLabel="Add Echo" onSubmit={() => {}} />);
      await pickDef(user, 'published-later');
      expect(screen.getByLabelText(/^echo$/i)).toHaveValue('published-later');
    } finally {
      resetSnapshotStoreForTests();
    }
  });

  it('warns on above-reference values without blocking submit', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<EchoForm submitLabel="Add Echo" onSubmit={onSubmit} />);

    await pickDef(user, 'hooscamp');
    await user.selectOptions(screen.getByLabelText(/main stat$/i), 'atkPct');
    await user.type(screen.getByLabelText(/main stat value/i), '30');
    // 1-cost ATK% tops out at 18 (docs/echostats.md) — impossible at any level.
    expect(await screen.findByText(/main stat 30 is above the 1-cost reference maximum 18/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /add substat/i }));
    await user.selectOptions(screen.getByLabelText(/substat 1 stat/i), 'critDmg');
    await user.clear(screen.getByLabelText(/substat 1 value/i));
    await user.type(screen.getByLabelText(/substat 1 value/i), '30.59');
    // Crit DMG subs top out at tier 21.0 — the screenshot's exact case.
    expect(await screen.findByText(/substat 1 \(crit dmg\) 30\.59 is above the reference maximum 21/i)).toBeInTheDocument();

    // Warnings never block: the draft still submits.
    await user.click(screen.getByRole('button', { name: 'Add Echo' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].substats).toEqual([{ stat: 'critDmg', value: 0.3059 }]);
  });

  it('stays silent for below-minimum values (low-level echoes stay enterable)', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<EchoForm submitLabel="Add Echo" onSubmit={onSubmit} />);

    await pickDef(user, 'hooscamp');
    await user.selectOptions(screen.getByLabelText(/main stat$/i), 'atkPct');
    // 3% is below the 3.6% 5★ reference floor — legitimate on an unleveled echo.
    await user.type(screen.getByLabelText(/main stat value/i), '3');
    await user.click(screen.getByRole('button', { name: 'Add Echo' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].mainStat).toEqual({ stat: 'atkPct', value: 0.03 });
    expect(screen.queryByText(/above the .*reference maximum/i)).not.toBeInTheDocument();
  });

  it('announces force-fixes when the picked Echo changes', async () => {
    const user = userEvent.setup();
    render(<EchoForm submitLabel="Add Echo" onSubmit={() => {}} />);

    await pickDef(user, 'hooscamp');
    await user.selectOptions(screen.getByLabelText(/sonata set/i), 'lingering-tunes');
    // Tempest Mephis is 4-cost, Void Thunder only — sonata resets with a notice.
    await pickDef(user, 'tempest-mephis');
    expect(await screen.findByRole('status')).toHaveTextContent(/sonata reset/i);
    expect(screen.getByText(/4 \(from Tempest Mephis\)/)).toBeInTheDocument();
  });

  it('blocks submit on duplicate substats with an inline error', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<EchoForm submitLabel="Add Echo" onSubmit={onSubmit} />);

    await pickDef(user, 'hooscamp');
    await user.click(screen.getByRole('button', { name: /add substat/i }));
    await user.click(screen.getByRole('button', { name: /add substat/i }));
    await user.selectOptions(screen.getByLabelText(/substat 1 stat/i), 'critRate');
    await user.selectOptions(screen.getByLabelText(/substat 2 stat/i), 'critDmg');
    // Make them duplicates:
    await user.selectOptions(screen.getByLabelText(/substat 2 stat/i), 'critRate');
    await user.click(screen.getByRole('button', { name: 'Add Echo' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/duplicate/i);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('blocks submit on non-numeric stat values', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<EchoForm submitLabel="Add Echo" onSubmit={onSubmit} />);

    await pickDef(user, 'hooscamp');
    await user.type(screen.getByLabelText(/main stat value/i), 'abc');
    await user.click(screen.getByRole('button', { name: 'Add Echo' }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('prefills initial values for editing, including the def', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <EchoForm
        submitLabel="Save"
        onSubmit={onSubmit}
        initial={{
          echoDefId: 'hooscamp',
          label: 'My Hooscamp',
          sonataId: 'sierra-gale',
          level: '25',
          rarity: '5',
          mainStat: { stat: 'atkPct', valueText: '15' },
          substats: [],
        }}
      />,
    );

    expect(screen.getByLabelText(/nickname/i)).toHaveValue('My Hooscamp');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ echoDefId: 'hooscamp', cost: 1 });
  });

  it('bounds the main stat slider to the reference range and picks from it', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<EchoForm submitLabel="Add Echo" onSubmit={onSubmit} />);

    // Hooscamp is 1-cost: ATK% spans 3.6–18 in the reference.
    await pickDef(user, 'hooscamp');
    const slider = screen.getByRole('slider', { name: 'Main stat slider' });
    expect(slider).toHaveAttribute('min', '3.6');
    expect(slider).toHaveAttribute('max', '18');
    expect(screen.getByText(/5★ lv25 reference/i)).toBeInTheDocument();

    fireEvent.change(slider, { target: { value: '10' } });
    expect(screen.getByLabelText(/main stat value/i)).toHaveValue('10');
    await user.click(screen.getByRole('button', { name: 'Add Echo' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].mainStat).toEqual({ stat: 'atkPct', value: 0.1 });
  });

  it('snaps substats to discrete tiers and submits tier values', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<EchoForm submitLabel="Add Echo" onSubmit={onSubmit} />);

    await pickDef(user, 'hooscamp');
    await user.type(screen.getByLabelText(/main stat value/i), '10');
    await user.click(screen.getByRole('button', { name: /add substat/i }));
    // Switching type snaps to the first tier (Crit Rate 6.3%).
    await user.selectOptions(screen.getByLabelText(/substat 1 stat/i), 'critRate');
    expect(screen.getByLabelText(/substat 1 value/i)).toHaveValue('6.3');

    const tierSlider = screen.getByRole('slider', { name: /substat 1 tier slider/i });
    expect(tierSlider).toHaveAttribute('max', '7');
    fireEvent.change(tierSlider, { target: { value: '7' } });
    expect(screen.getByLabelText(/substat 1 value/i)).toHaveValue('10.5');

    await user.click(screen.getByRole('button', { name: 'Add Echo' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].substats).toEqual([{ stat: 'critRate', value: 0.105 }]);
  });
});
