import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App.tsx';
import { useAppStore } from './state/store.ts';
import { useThemeStore } from './state/theme.ts';

// Pages are lazy chunks: a cold transform in a busy full-suite run can take
// well over findBy's default 1 s (1.2 s seen), so page headings get 4 s —
// still inside the 5 s test timeout.
const PAGE_LOAD = { timeout: 4000 };

beforeEach(() => {
  useAppStore.setState({ activeSection: 'inventory' });
  useThemeStore.getState().setTheme('paper');
});

describe('App shell', () => {
  it('opens on the inventory section', async () => {
    render(<App />);
    expect(await screen.findByRole('heading', { name: /echo inventory/i }, PAGE_LOAD)).toBeInTheDocument();
  });

  it('switches sections from the terminal nav', async () => {
    const user = userEvent.setup();
    render(<App />);
    // Sidebar and mobile top bar both render (CSS hides one); either navigates.
    const [rosterButton] = screen.getAllByRole('button', { name: /roster/i });
    await user.click(rosterButton);
    expect(await screen.findByRole('heading', { name: /character roster/i }, PAGE_LOAD)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /echo inventory/i })).not.toBeInTheDocument();
  });

  it('toggles between paper and ink themes', async () => {
    const user = userEvent.setup();
    render(<App />);
    const [toggle] = screen.getAllByRole('button', { name: /switch to ink theme/i });
    await user.click(toggle);
    expect(document.documentElement.dataset.theme).toBe('ink');
    expect(screen.getAllByRole('button', { name: /switch to paper theme/i })).not.toHaveLength(0);
  });

  it('navigates from the phone bottom tab bar', async () => {
    const user = userEvent.setup();
    render(<App />);
    const tabs = screen.getByRole('navigation', { name: 'Section tabs' });
    await user.click(within(tabs).getByRole('button', { name: /teams/i }));
    expect(within(tabs).getByRole('button', { name: /teams/i })).toHaveAttribute('aria-current', 'page');
    expect(useAppStore.getState().activeSection).toBe('teams');
  });

  it('starts a new section at the top, and a second tap on the current tab scrolls up', async () => {
    const user = userEvent.setup();
    const scrollTo = vi.spyOn(window, 'scrollTo');
    render(<App />);
    await screen.findByRole('heading', { name: /echo inventory/i }, PAGE_LOAD);
    expect(scrollTo).not.toHaveBeenCalled();

    const tabs = screen.getByRole('navigation', { name: 'Section tabs' });
    await user.click(within(tabs).getByRole('button', { name: /builds/i }));
    expect(scrollTo).toHaveBeenCalledWith(0, 0);

    scrollTo.mockClear();
    await user.click(within(tabs).getByRole('button', { name: /builds/i }));
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
    expect(useAppStore.getState().activeSection).toBe('builds');
    scrollTo.mockRestore();
  });

  it('locks page scrolling while the command palette is open', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Open command palette' }));
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
    expect(document.documentElement).toHaveClass('scroll-locked');
    await user.keyboard('{Escape}');
    expect(document.documentElement).not.toHaveClass('scroll-locked');
  });
});

describe('route-level code splitting', () => {
  // A fresh module registry, so no page chunk has been loaded yet.
  async function freshApp() {
    vi.resetModules();
    const { default: FreshApp } = await import('./App.tsx');
    const { useAppStore: freshStore } = await import('./state/store.ts');
    freshStore.setState({ activeSection: 'inventory' });
    return FreshApp;
  }

  let idleCallbacks: (() => void)[] = [];
  beforeEach(() => {
    idleCallbacks = [];
    vi.stubGlobal('requestIdleCallback', (cb: () => void) => idleCallbacks.push(cb));
    vi.stubGlobal('cancelIdleCallback', () => {});
  });
  afterEach(() => {
    cleanup(); // unmount (cancelIdleCallback) before the stubs go away
    vi.unstubAllGlobals();
  });

  it('shows a loading status until the opening section chunk arrives', async () => {
    const FreshApp = await freshApp();
    render(<FreshApp />);
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: /echo inventory/i }, PAGE_LOAD)).toBeInTheDocument();
  });

  it('prefetches the other sections when idle, so navigation renders without a fallback', async () => {
    const user = userEvent.setup();
    const FreshApp = await freshApp();
    render(<FreshApp />);
    await screen.findByRole('heading', { name: /echo inventory/i }, PAGE_LOAD);
    expect(idleCallbacks).toHaveLength(1);
    idleCallbacks[0]();
    // Wait for the chunks the prefetch requested, then one task for its callbacks.
    await import('./ui/pages/DatabasePage.tsx');
    await new Promise((resolve) => setTimeout(resolve, 0));

    const tabs = screen.getByRole('navigation', { name: 'Section tabs' });
    await user.click(within(tabs).getByRole('button', { name: /database/i }));
    expect(screen.getByRole('heading', { name: 'Database' })).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Loading' })).not.toBeInTheDocument();
  });
});

describe('per-section error boundary', () => {
  afterEach(() => {
    vi.doUnmock('./ui/pages/RosterPage.tsx');
    vi.restoreAllMocks();
  });

  it('keeps the nav alive when a page chunk fails to load', async () => {
    const user = userEvent.setup();
    vi.resetModules();
    vi.doMock('./ui/pages/RosterPage.tsx', () => {
      throw new Error('Failed to fetch dynamically imported module');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { default: FreshApp } = await import('./App.tsx');
    const { useAppStore: freshStore } = await import('./state/store.ts');
    freshStore.setState({ activeSection: 'roster' });
    render(<FreshApp />);
    expect(await screen.findByRole('alert', {}, PAGE_LOAD)).toHaveTextContent(/something broke/i);
    // The shell survived: navigating away renders the next section.
    const tabs = screen.getByRole('navigation', { name: 'Section tabs' });
    await user.click(within(tabs).getByRole('button', { name: /inventory/i }));
    expect(await screen.findByRole('heading', { name: /echo inventory/i }, PAGE_LOAD)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
