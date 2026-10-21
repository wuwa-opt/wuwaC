/**
 * Size caps for user-picked JSON files, checked on `File.size` BEFORE the file
 * is read (`file.text()` + `JSON.parse` + zod would otherwise load whatever
 * the picker hands over into memory).
 *
 * Sized from the real formats (measured with the app's own writers): a backup
 * costs ~400 B per Echo and a pretty-printed Kamera file ~330 B per Echo, so
 * even 3,000 Echoes are ~1.2 MB. Saved builds add a few KB each. The caps sit
 * about an order of magnitude above any plausible inventory, which still stops
 * a wrong or hostile file long before it can freeze the tab.
 */
export const MAX_BACKUP_BYTES = 16 * 1024 * 1024;
export const MAX_KAMERA_BYTES = 8 * 1024 * 1024;

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

/** Read a picked file as text, refusing (with a readable message) one over `maxBytes`. */
export async function readTextFile(file: File, maxBytes: number, what: string): Promise<string> {
  if (file.size > maxBytes) {
    throw new Error(
      `That file is ${formatBytes(file.size)}, over the ${formatBytes(maxBytes)} limit for ${what} — pick the right file.`,
    );
  }
  return file.text();
}
