/**
 * Pure layout rules for the Beeper attachment byte mirror (#37, decided on
 * #13). No I/O — the service (`services/beeperAttachments.js`), the serving
 * route and the GC sweep all derive the same path from the same two facts, so
 * the rule lives in one place rather than three.
 *
 * **Content-addressed.** A mirrored file is `<sha256[0..2]>/<sha256>.<ext>`
 * under `PATHS.beeperAttachments`. The prefix directory keeps a five-figure
 * attachment count off one inode-heavy directory, and addressing by hash means
 * the same photo forwarded into four chats occupies one file — which is also
 * why every deletion path has to run a reference check before unlinking (three
 * other rows may still point at it).
 *
 * **The extension is cosmetic, never the type.** `GET /v1/assets/serve` sends
 * no `Content-Type` at all (probed on a live install, #13), so the mirror
 * stores Beeper's declared `mimeType` in the row and serves from THAT. The
 * extension exists so a file recovered from a backup is still openable by
 * hand; `serveLocalFile` is handed an explicit `contentType` so it can never
 * be sniffed back out of the filename.
 */

/**
 * The per-attachment ceiling, matching `FEDERATED_MEDIA_ASSET_MAX_BYTES` in
 * `federatedMediaWire.js` — the other place PortOS decided how large a single
 * mirrored asset may be. A named constant, deliberately NOT a setting: a
 * measured attachment mix is overwhelmingly small files with a thin tail over
 * this line, so a knob here would be one nobody needs and one more value the
 * budget sweep has to reason about. An over-cap attachment is not lost — it
 * keeps its row and offers "fetch anyway", which is the escape hatch a setting
 * would otherwise have been.
 */
export const BEEPER_ATTACHMENT_MAX_BYTES = 32 * 1024 * 1024;

// Deliberately small: the extension is a convenience for a human browsing a
// restored backup, not a type declaration, so an unknown mime just gets `bin`.
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
 * The media types the mirror knows how to store, as a Set — the keys of
 * `MIME_EXTENSIONS` above, exported so the serving pipeline can BOUND the
 * `contentType` override rather than echo it.
 *
 * The declared type on a mirrored attachment is written by a remote sender, and
 * the mirror is served from the authenticated dashboard origin, so a type
 * outside this set is served as `application/octet-stream` instead
 * (`serveLocalFile` in `lib/uploads.js`). Reusing the extension table's keys
 * keeps the two answers in lockstep: a type the mirror cannot even name a file
 * for is not a type it should be declaring on the wire either.
 */
export const MIRRORED_MIME_TYPES = new Set(MIME_EXTENSIONS.keys());

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const EXTENSION_PATTERN = /^[a-z0-9]{1,8}$/;

/**
 * The stored extension for one attachment: the declared mime first, then the
 * source file name's own suffix, then `bin`.
 *
 * The file name is NOT trusted as a path — only its trailing `[a-z0-9]{1,8}`
 * run is read, so a name carrying separators, dots or a traversal segment can
 * never reach the filesystem through here.
 */
export function attachmentExtension({ mimeType, fileName } = {}) {
  const mime = String(mimeType || '').trim().toLowerCase().split(';')[0];
  const known = MIME_EXTENSIONS.get(mime);
  if (known) return known;
  const suffix = String(fileName || '').trim().toLowerCase().split('.').pop() || '';
  return EXTENSION_PATTERN.test(suffix) ? suffix : 'bin';
}

/**
 * `<sha256[0..2]>/<sha256>.<ext>` — the store-relative path for one mirrored
 * attachment. Returns `null` for anything that is not a lowercase 64-hex
 * digest, so a caller can never build a path out of a half-computed hash.
 */
export function attachmentRelativePath(sha256, extension = 'bin') {
  const digest = String(sha256 || '').trim().toLowerCase();
  if (!SHA256_PATTERN.test(digest)) return null;
  const ext = EXTENSION_PATTERN.test(String(extension || '')) ? extension : 'bin';
  return `${digest.slice(0, 2)}/${digest}.${ext}`;
}

/**
 * Whether a stored `local_path` still looks like something this layout wrote.
 *
 * The value comes out of Postgres rather than off a request, but it is the one
 * DB column that becomes a filesystem path, and a mirror row is written by
 * whatever version of PortOS was running at the time. Validating the SHAPE
 * (prefix dir matches the digest, no separators beyond the one, no traversal)
 * is cheaper than reasoning about which past version could have written what.
 */
export function isSafeAttachmentRelativePath(relativePath) {
  const value = String(relativePath || '');
  const match = /^([0-9a-f]{2})\/([0-9a-f]{64})\.([a-z0-9]{1,8})$/.exec(value);
  return Boolean(match) && match[2].startsWith(match[1]);
}
