import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App.tsx';
import type { OwnedEcho } from './data/schema.ts';
import { db } from './state/db.ts';
import { useInventoryStore } from './state/inventory.ts';
import { useAppStore } from './state/store.ts';
import { resetToastsForTests } from './ui/toasts.ts';

// Pages are lazy chunks: see App.test.tsx for the page-load timeout.
const PAGE_LOAD = { timeout: 4000 };

const echo: OwnedEcho = {
  id: 'e1',
  label: 'Seeded',
  echoDefId: 'hooscamp',
  sonataId: 'sierra-gale',
  cost: 1,
  level: 25,
  rarity: 5,
  mainStat: { stat: 'atkPct', value: 0.18 },
  substats: [],
  equippedTo: null,
  origin: 'manual',
};

beforeEach(async () => {
  resetToastsForTests();
  await db.ownedEchoes.clear();
  await db.ownedEchoes.add(echo);
  useInventoryStore.setState({ echoes: [], loaded: false });
  useAppStore.setState({ activeSection: 'inventory' });
});

afterEach(() => {
  cleanup();
  resetToastsForTests();
});

/** Delete the seeded Echo from the Inventory page, leaving its Undo toast up. */
async function deleteSeeded(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const table = await screen.findByRole('table', {}, PAGE_LOAD);
  await user.click(within(table).getByRole('button', { name: 'Seeded' }));
  await user.click(within(screen.getByRole('region', { name: 'Status' })).getByRole('button', { name: /delete/i }));
  expect(await screen.findByRole('button', { name: 'Undo' })).toBeInTheDocument();
}

async function goTo(user: ReturnType<typeof userEvent.setup>, label: RegExp, heading: RegExp): Promise<void> {
  const [button] = screen.getAllByRole('button', { name: label });
  await user.click(button);
  expect(await screen.findByRole('heading', { name: heading }, PAGE_LOAD)).toBeInTheDocument();
}

describe('toasts at the app shell', () => {
  it('an inventory Undo survives a section switch and still restores the Echo', async () => {
    const user = userEvent.setup();
    render(<App />);
    await deleteSeeded(user);
    expect(await db.ownedEchoes.count()).toBe(0);

    await goTo(user, /roster/i, /character roster/i);
    expect(screen.queryByRole('heading', { name: /echo inventory/i })).not.toBeInTheDocument();
    expect(screen.getByText('Echo deleted.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect(await db.ownedEchoes.get('e1')).toEqual(echo));
    expect(await screen.findByText('Restored 1 echo.')).toBeInTheDocument();

    // And the restored Echo is there when the user goes back.
    await goTo(user, /inventory/i, /echo inventory/i);
    expect(await screen.findByRole('button', { name: 'Seeded' })).toBeInTheDocument();
  });

  it('survives going away and coming back, without a second copy', async () => {
    const user = userEvent.setup();
    render(<App />);
    await deleteSeeded(user);
    await goTo(user, /roster/i, /character roster/i);
    await goTo(user, /inventory/i, /echo inventory/i);
    expect(screen.getAllByRole('button', { name: 'Undo' })).toHaveLength(1);
  });

  it('drops the Undo when the inventory is reloaded (a backup restore), even from another section', async () => {
    const user = userEvent.setup();
    render(<App />);
    await deleteSeeded(user);
    await goTo(user, /roster/i, /character roster/i);
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();

    await useInventoryStore.getState().load();

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument());
  });

  it('a plain toast from one page is still shown after switching, and expires on its own clock', async () => {
    const user = userEvent.setup();
    render(<App />);
    const table = await screen.findByRole('table', {}, PAGE_LOAD);
    await user.click(within(table).getByRole('button', { name: 'Seeded' }));
    await user.click(within(screen.getByRole('region', { name: 'Status' })).getByRole('button', { name: /^lock$/i }));
    expect(await screen.findByText('Echo locked.')).toBeInTheDocument();

    await goTo(user, /roster/i, /character roster/i);
    expect(screen.getByText('Echo locked.')).toBeInTheDocument();
    // One outlet for the whole app, not one per page.
    expect(document.querySelectorAll('[aria-live="polite"]')).toHaveLength(1);
  });
});
