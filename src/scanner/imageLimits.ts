/**
 * Screenshot limits, checked BEFORE a file reaches `createImageBitmap` (which
 * decodes the whole image to RGBA, 4 bytes per pixel) and the OCR engine.
 *
 * Sized from real Echo Management screenshots (`scan-fixtures/`): 1080p PNGs
 * are 1.8-2.1 MB and 1920x1080 (2.1 MP); 4K is four times the pixels, so
 * roughly 8 MB as PNG. The caps leave room above that and stop anything
 * that is not a screenshot:
 * - bytes: 20 MiB, over twice a 4K PNG; a bigger file is a photo or an
 *   uncompressed export, not a panel capture.
 * - pixels: 16 MP covers 4K (8.3 MP), ultrawide 5120x2160 (11 MP) and 5K
 *   (14.7 MP). 8K (33 MP) is refused: decoded it would be ~130 MB per image,
 *   and the panel is just as readable at 4K. A decoded image is therefore
 *   at most 64 MB.
 * Size comes from the file header (PNG, JPEG, WebP), so a refusal costs a
 * 512 KiB slice, never a decode. Other formats are refused, not guessed at.
 */
export const MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024;
export const MAX_SCREENSHOT_PIXELS = 16_000_000;
/** JPEG puts its size after the EXIF/ICC segments, which can be large. */
const HEADER_BYTES = 512 * 1024;

export interface ImageSize {
  width: number;
  height: number;
}

const u16be = (b: Uint8Array, i: number): number => (b[i] << 8) | b[i + 1];
const u32be = (b: Uint8Array, i: number): number => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const u24le = (b: Uint8Array, i: number): number => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const ascii = (b: Uint8Array, i: number, text: string): boolean => [...text].every((c, k) => b[i + k] === c.charCodeAt(0));

function pngSize(b: Uint8Array): ImageSize | null {
  // 8-byte signature, then the IHDR chunk: length, "IHDR", width, height.
  if (b.length < 24 || !ascii(b, 12, 'IHDR')) return null;
  return { width: u32be(b, 16), height: u32be(b, 20) };
}

function jpegSize(b: Uint8Array): ImageSize | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = b[i + 1];
    if (marker === 0xff) {
      i += 1; // fill byte
    } else if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2; // markers without a length
    } else if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: u16be(b, i + 5), width: u16be(b, i + 7) }; // SOFn
    } else {
      i += 2 + u16be(b, i + 2);
    }
  }
  return null;
}

function webpSize(b: Uint8Array): ImageSize | null {
  if (b.length < 30) return null;
  if (ascii(b, 12, 'VP8X')) return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  if (ascii(b, 12, 'VP8L') && b[20] === 0x2f) {
    const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (ascii(b, 12, 'VP8 ') && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
    return { width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff };
  }
  return null;
}

/** Format and pixel size from the first bytes of a file; null for anything else. */
export function readImageHeader(bytes: Uint8Array): { format: 'png' | 'jpeg' | 'webp'; size: ImageSize | null } | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 'PNG\r\n') && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return { format: 'png', size: pngSize(bytes) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { format: 'jpeg', size: jpegSize(bytes) };
  }
  if (bytes.length >= 12 && ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')) {
    return { format: 'webp', size: webpSize(bytes) };
  }
  return null;
}

const mb = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/**
 * Why a screenshot can't be scanned (a per-file message naming the file), or
 * null when it is within the limits. Never reads more than the header.
 */
export async function screenshotProblem(file: Blob & { name?: string }): Promise<string | null> {
  const name = file.name ?? 'This file';
  if (file.size > MAX_SCREENSHOT_BYTES) {
    return `${name} is ${mb(file.size)}, over the ${mb(MAX_SCREENSHOT_BYTES)} limit for a screenshot. Take it at 4K or lower.`;
  }
  const header = readImageHeader(new Uint8Array(await file.slice(0, HEADER_BYTES).arrayBuffer()));
  if (header === null) return `${name} is not a PNG, JPEG or WebP image.`;
  if (header.size === null || header.size.width < 1 || header.size.height < 1) {
    return `${name} has an unreadable image header, so its size can't be checked.`;
  }
  const { width, height } = header.size;
  if (width * height > MAX_SCREENSHOT_PIXELS) {
    return `${name} is ${width}×${height} (${(width * height / 1e6).toFixed(1)} MP), over the ${MAX_SCREENSHOT_PIXELS / 1e6} MP limit. Take it at 4K (3840×2160) or lower.`;
  }
  return null;
}
