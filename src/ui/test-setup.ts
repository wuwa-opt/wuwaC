// Vitest setup: custom matchers (toBeInTheDocument, …) for UI tests.
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

// jsdom has no layout: scrolling is a no-op here (it would otherwise log
// "Not implemented" for every scrollTo).
if (typeof window !== 'undefined') {
  window.scrollTo = () => {};
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
}

// Without `globals: true`, Testing Library cannot auto-register cleanup —
// do it explicitly so each test gets a fresh document.
afterEach(() => {
  cleanup();
});

// Pages resolve the game-data snapshot through the snapshot store, which
// background-refreshes stale data against the provider. UI tests run
// offline: every provider call fails fast and the app keeps serving its
// snapshot (the specified failure behavior — no real network in tests).
// Re-stubbed before each test because some suites call `vi.unstubAllGlobals`.
beforeEach(() => {
  vi.stubGlobal('fetch', () => Promise.reject(new Error('offline in tests')));
});
