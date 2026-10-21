import { describe, expect, it } from 'vitest';
import { MAX_BACKUP_BYTES, MAX_KAMERA_BYTES, readTextFile } from './readFile.ts';
import { fakeSizedFile } from './testFile.ts';

describe('readTextFile', () => {
  it('reads a file at the cap', async () => {
    const { file, text } = fakeSizedFile(MAX_KAMERA_BYTES);
    await expect(readTextFile(file, MAX_KAMERA_BYTES, 'an Echo import')).resolves.toBe('{}');
    expect(text).toHaveBeenCalledTimes(1);
  });

  it('refuses a file over the cap without reading it, naming sizes and purpose', async () => {
    const { file, text } = fakeSizedFile(MAX_KAMERA_BYTES + 1);
    await expect(readTextFile(file, MAX_KAMERA_BYTES, 'an Echo import')).rejects.toThrow(
      /8\.0 MB, over the 8\.0 MB limit for an Echo import/,
    );
    expect(text).not.toHaveBeenCalled();
  });

  it('keeps the caps well above a real inventory (~400 B per Echo)', () => {
    expect(MAX_BACKUP_BYTES / 400).toBeGreaterThan(10_000);
    expect(MAX_KAMERA_BYTES / 340).toBeGreaterThan(10_000);
  });
});
