/**
 * Detects image type from magic bytes. The client-declared Content-Type and filename are never trusted:
 * SVG/HTML and anything unrecognised are rejected (prevents stored XSS via "images").
 */
export function sniffImageType(
  bytes: Buffer,
): 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return 'image/png';
  if (
    bytes.length >= 6 &&
    (bytes.subarray(0, 6).toString('ascii') === 'GIF87a' ||
      bytes.subarray(0, 6).toString('ascii') === 'GIF89a')
  )
    return 'image/gif';
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  )
    return 'image/webp';
  return null;
}

/** Keeps a display-safe filename (no paths, control chars or quotes). */
export function safeFilename(name: string | undefined): string {
  const base = (name ?? 'upload').split(/[\\/]/).pop() ?? 'upload';
  const cleaned = base
    .replace(/[^\w.\- ]+/g, '_')
    .trim()
    .slice(0, 120);
  return cleaned || 'upload';
}
