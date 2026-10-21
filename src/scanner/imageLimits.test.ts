import { describe, expect, it } from 'vitest';
import {
  MAX_SCREENSHOT_BYTES,
  MAX_SCREENSHOT_PIXELS,
  readImageHeader,
  screenshotProblem,
} from './imageLimits.ts';
import { jpegBytes, pngBytes, text, webpBytes } from './testImages.ts';

describe('readImageHeader', () => {
  it('reads PNG, JPEG (past a large EXIF segment) and the three WebP flavours', () => {
    expect(readImageHeader(pngBytes(3840, 2160))).toEqual({ format: 'png', size: { width: 3840, height: 2160 } });
    expect(readImageHeader(jpegBytes(1920, 1080))).toEqual({ format: 'jpeg', size: { width: 1920, height: 1080 } });
    expect(readImageHeader(jpegBytes(2560, 1440, 60_000))).toEqual({ format: 'jpeg', size: { width: 2560, height: 1440 } });
    expect(readImageHeader(webpBytes('VP8X', 1920, 1080))).toEqual({ format: 'webp', size: { width: 1920, height: 1080 } });
    expect(readImageHeader(webpBytes('VP8L', 1920, 1080))).toEqual({ format: 'webp', size: { width: 1920, height: 1080 } });
    expect(readImageHeader(webpBytes('VP8 ', 1920, 1080))).toEqual({ format: 'webp', size: { width: 1920, height: 1080 } });
  });

  it('returns null for other formats and a null size for a truncated header', () => {
    expect(readImageHeader(Uint8Array.from(text('GIF89a......')))).toBeNull();
    expect(readImageHeader(Uint8Array.from(text('BM......')))).toBeNull();
    expect(readImageHeader(new Uint8Array(0))).toBeNull();
    expect(readImageHeader(pngBytes(10, 10).slice(0, 14))?.size).toBeNull();
    expect(readImageHeader(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0]))?.size).toBeNull();
  });
});

const fileOf = (bytes: Uint8Array<ArrayBuffer>, name: string, size?: number): File => {
  const file = new File([bytes], name);
  if (size !== undefined) Object.defineProperty(file, 'size', { value: size });
  return file;
};

describe('screenshotProblem', () => {
  it('accepts 1080p, 4K and 5K screenshots', async () => {
    for (const [w, h] of [[1920, 1080], [1891, 1080], [3840, 2160], [5120, 2880]] as const) {
      expect(await screenshotProblem(fileOf(pngBytes(w, h), 'ok.png'))).toBeNull();
    }
    expect(5120 * 2880).toBeLessThanOrEqual(MAX_SCREENSHOT_PIXELS);
    expect(await screenshotProblem(fileOf(jpegBytes(3840, 2160, 30_000), 'ok.jpg'))).toBeNull();
  });

  it('refuses a file over the byte cap without reading it, naming the file', async () => {
    const big = fileOf(pngBytes(1920, 1080), 'huge.png', MAX_SCREENSHOT_BYTES + 1);
    expect(await screenshotProblem(big)).toMatch(/^huge\.png is 20\.0 MB, over the 20\.0 MB limit for a screenshot/);
  });

  it('accepts a file exactly at the byte cap', async () => {
    expect(await screenshotProblem(fileOf(pngBytes(1920, 1080), 'edge.png', MAX_SCREENSHOT_BYTES))).toBeNull();
  });

  it('refuses over the pixel cap from the header alone (8K), with the size in the message', async () => {
    const message = await screenshotProblem(fileOf(pngBytes(7680, 4320), 'eightk.png'));
    expect(message).toMatch(/^eightk\.png is 7680×4320 \(33\.2 MP\), over the 16 MP limit/);
    expect(await screenshotProblem(fileOf(jpegBytes(7680, 4320), 'eightk.jpg'))).toMatch(/7680×4320/);
    // A tiny file that declares a huge canvas (a decompression bomb) is the case this guards.
    expect(await screenshotProblem(fileOf(pngBytes(60000, 60000), 'bomb.png'))).toMatch(/over the 16 MP limit/);
  });

  it('refuses other formats and unreadable headers instead of guessing', async () => {
    expect(await screenshotProblem(fileOf(Uint8Array.from(text('GIF89a......')), 'a.gif'))).toBe('a.gif is not a PNG, JPEG or WebP image.');
    expect(await screenshotProblem(fileOf(pngBytes(10, 10).slice(0, 14), 'cut.png'))).toMatch(/^cut\.png has an unreadable image header/);
    expect(await screenshotProblem(fileOf(pngBytes(0, 1080), 'zero.png'))).toMatch(/unreadable image header/);
  });
});
