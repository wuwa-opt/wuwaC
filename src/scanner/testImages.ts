/** Synthetic image headers for tests: just enough bytes for `readImageHeader`. */

const be32 = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const be16 = (n: number): number[] => [(n >> 8) & 0xff, n & 0xff];
const le24 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
export const text = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

/** PNG signature + IHDR (width, height, 8-bit RGBA). */
export const pngBytes = (w: number, h: number): Uint8Array<ArrayBuffer> =>
  Uint8Array.from([0x89, ...text('PNG\r\n'), 0x1a, 0x0a, ...be32(13), ...text('IHDR'), ...be32(w), ...be32(h), 8, 6, 0, 0, 0]);

/** JPEG: SOI, an APP1 segment of `appBytes` (EXIF stand-in), then SOF0. */
export const jpegBytes = (w: number, h: number, appBytes = 0): Uint8Array<ArrayBuffer> =>
  Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xe1, ...be16(appBytes + 2), ...new Array<number>(appBytes).fill(0x45),
    0xff, 0xc4, ...be16(4), 0, 0, // a DHT before the frame header must be skipped, not mistaken for SOF
    0xff, 0xc0, ...be16(17), 8, ...be16(h), ...be16(w), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
  ]);

export const webpBytes = (kind: 'VP8X' | 'VP8L' | 'VP8 ', w: number, h: number): Uint8Array<ArrayBuffer> => {
  const head = [...text('RIFF'), ...be32(0), ...text('WEBP'), ...text(kind), ...be32(10)];
  if (kind === 'VP8X') return Uint8Array.from([...head, 0, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)]);
  if (kind === 'VP8L') {
    const bits = ((w - 1) | ((h - 1) << 14)) >>> 0;
    return Uint8Array.from([...head, 0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >>> 24) & 0xff, 0, 0, 0, 0, 0]);
  }
  return Uint8Array.from([...head, 0, 0, 0, 0x9d, 0x01, 0x2a, w & 0xff, w >> 8, h & 0xff, h >> 8]);
};
