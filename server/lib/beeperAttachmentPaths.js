/**
 * Pure layout rules for the Beeper attachment byte mirror (#37, decided on #13).
 *
 * No I/O — the service, serving route and GC sweep all derive the same path from here.
 *
 * **Content-addressed.** A mirrored file is `<sha256[0..2]>/<sha256>.<ext>`
 * under `PATHS.beeperAttachments`. The prefix directory bounds directory size, and
 * hash addressing means one file may back many rows, so every deletion path must
 * run a reference check before unlinking.
 *
 * **The extension is cosmetic, never the type.** `GET /v1/assets/serve` sends
 * no `Content-Type`, so the mirror stores Beeper's declared `mimeType` in the row
 * and serves from THAT; `serveLocalFile` gets an explicit `contentType` so it is
 * never sniffed from the filename.
 */

/**
 * Per-attachment ceiling, matching `FEDERATED_MEDIA_ASSET_MAX_BYTES` in
 * `federatedMediaWire.js`. Deliberately a constant, not a setting; an over-cap
 * attachment keeps its row and offers "fetch anyway".
 */
export const BEEPER_ATTACHMENT_MAX_BYTES = 32 * 1024 * 1024;

// Deliberately small: an unknown mime just gets `bin`.
const MIME_EXTENSIONS = new Map([
  ['image/jpeg', 'jpg'],
  ['image/jpg', 'jpg'],
  ['image/png', 'png'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
  ['image/heic', 'heic'],
  ['image/avif', 'avif'],
  ['image/svg+xml', 'svg'],
  ['video/mp4', 'mp4'],
  ['video/quicktime', 'mov'],
  ['video/webm', 'webm'],
  ['audio/mpeg', 'mp3'],
  ['audio/mp4', 'm4a'],
  ['audio/ogg', 'ogg'],
  ['audio/wav', 'wav'],
  ['application/pdf', 'pdf'],
  ['text/plain', 'txt'],
]);

/**
 * The media types the mirror can store (keys of `MIME_EXTENSIONS`), used to BOUND
 * the `contentType` override. The declared type is written by a remote sender and
 * served from the authenticated dashboard origin, so a type outside this set is
 * served as `application/octet-stream` (`serveLocalFile` in `lib/uploads.js`).
 */
export const MIRRORED_MIME_TYPES = new Set(MIME_EXTENSIONS.keys());

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const EXTENSION_PATTERN = /^[a-z0-9]{1,8}$/;

/**
 * The stored extension: declared mime, then the file name's suffix, then `bin`.
 * The file name is NOT trusted as a path; only a trailing `[a-z0-9]{1,8}` run is
 * read, so separators or traversal segments never reach the filesystem.
 */
export function attachmentExtension({ mimeType, fileName } = {}) {
  const mime = String(mimeType || '').trim().toLowerCase().split(';')[0];
  const known = MIME_EXTENSIONS.get(mime);
  if (known) return known;
  const suffix = String(fileName || '').trim().toLowerCase().split('.').pop() || '';
  return EXTENSION_PATTERN.test(suffix) ? suffix : 'bin';
}

/** Store-relative `<sha256[0..2]>/<sha256>.<ext>`, or `null` unless the digest is lowercase 64-hex. */
export function attachmentRelativePath(sha256, extension = 'bin') {
  const digest = String(sha256 || '').trim().toLowerCase();
  if (!SHA256_PATTERN.test(digest)) return null;
  const ext = EXTENSION_PATTERN.test(String(extension || '')) ? extension : 'bin';
  return `${digest.slice(0, 2)}/${digest}.${ext}`;
}

/**
 * Whether a stored `local_path` still looks like something this layout wrote.
 * It is the one DB column that becomes a filesystem path and may have been written
 * by any past version, so the SHAPE is validated (prefix matches digest, no traversal).
 */
export function isSafeAttachmentRelativePath(relativePath) {
  const value = String(relativePath || '');
  const match = /^([0-9a-f]{2})\/([0-9a-f]{64})\.([a-z0-9]{1,8})$/.exec(value);
  return Boolean(match) && match[2].startsWith(match[1]);
}
