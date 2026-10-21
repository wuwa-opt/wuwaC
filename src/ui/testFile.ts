import { vi } from 'vitest';

/** A File that reports `size` bytes without allocating them; `text` records whether it was read. */
export function fakeSizedFile(size: number, name = 'big.json') {
  const file = new File(['{}'], name, { type: 'application/json' });
  Object.defineProperty(file, 'size', { value: size });
  const text = vi.spyOn(file, 'text');
  return { file, text };
}
