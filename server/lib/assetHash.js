/**
 * SHA-256 cache for data/images assets stored in metadata sidecars, plus `sidecarGenParamsHash` and
 * `stripImageSidecarLocalFields` for cross-machine sidecar comparison and peer sync.
 */

import { stat } from 'fs/promises';
import { basename, join } from 'path';
import { createHash } from 'crypto';
import { atomicWrite, readJSONFile, sha256File, PATHS } from './fileUtils.js';
import { isPlainObject, canonicalStringify, POLLUTING_KEYS } from './objects.js';
import { compareNewerWins } from './lwwTimestamp.js';
import { HOSTED_DELETED_AT_FIELDS } from './renderTiming.js';

// Each image `data/images/{uuid}.png` has a sibling `.metadata.json` sidecar with its
// generation provenance. Peer sync also needs the image SHA-256 so a receiver can diff
// against a sender's manifest; hashing at universe scale every sync cycle adds up, so the
// hash is persisted in the sidecar and invalidated only when mtime+size change (a re-render
// replaces the file in place). The sidecar, not the sharing-bucket cache, is the source of
// truth because both transports can read it.

const HEX_64 = /^[a-f0-9]{64}$/;

const isHexHash = (v) => typeof v === 'string' && HEX_64.test(v);

/**
 * Path to the metadata sidecar for an image filename. Accepts either the bare
 * filename (`abc.png`) or an absolute path; the sidecar always sits next to
 * the image in PATHS.images.
 */
export function sidecarPathForImage(imageFilenameOrPath) {
  // Total over all inputs: null means "no sidecar path resolvable"; callers fall through.
  if (typeof imageFilenameOrPath !== 'string' || !imageFilenameOrPath) return null;
  const base = basename(imageFilenameOrPath);
  if (!base) return null;
  // Mirrors `imageSidecarName` in services/sharing/buckets.js (inline: lib/ never imports services/).
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return join(PATHS.images, `${stem}.metadata.json`);
}

/**
 * sha256 of the image at `imagePath`, from the sidecar cache (keyed on mtimeMs + size) or
 * computed fresh and persisted.
 *
 * Returns `{ hash, sidecar }` (latest sidecar JSON with the sha256 entry merged in, so
 * callers can skip a re-read), or null when the image is missing or unreadable.
 */
export async function getOrComputeImageSha256(imagePath) {
  const info = await stat(imagePath).catch(() => null);
  if (!info) return null;
  const sidecarPath = sidecarPathForImage(imagePath);
  if (!sidecarPath) return null;
  const sidecar = await readJSONFile(sidecarPath, null, { logError: false });
  const cached = sidecar?.sha256;
  if (
    cached
    && isHexHash(cached.value)
    && cached.mtimeMs === info.mtimeMs
    && cached.size === info.size
  ) {
    return { hash: cached.value, sidecar };
  }
  const hash = await sha256File(imagePath);
  const entry = { value: hash, mtimeMs: info.mtimeMs, size: info.size };
  const fallback = { ...(sidecar || {}), sha256: entry };
  const filename = basename(imagePath);
  if (!/^[\w.-]+\.png$/i.test(filename) || filename.includes('..')) {
    // Not a gallery filename the edit queue accepts: keep the plain write.
    await atomicWrite(sidecarPath, fallback).catch((err) => {
      console.error(`⚠️ assetHash: sidecar write failed for ${sidecarPath}: ${err?.message || err}`);
    });
    return { hash, sidecar: fallback };
  }
  // Write via the gallery sidecar edit queue, which re-reads the CURRENT sidecar; our own
  // read-modify-write would drop an edit (hidden flag, supplying peer) landed since the
  // read above. services/ registers the writer (lib never imports upward); without one the
  // hash is simply not persisted.
  if (!gallerySha256Writer) return { hash, sidecar: fallback };
  const merged = await Promise.resolve()
    .then(() => gallerySha256Writer(filename, entry))
    .catch((err) => {
      console.error(`⚠️ assetHash: sidecar write failed for ${sidecarPath}: ${err?.message || err}`);
      return null;
    });
  return { hash, sidecar: merged || fallback };
}

let gallerySha256Writer = null;
/**
 * Register the gallery sidecar edit-queue writer `(filename, entry) => merged | null`
 * that persists the hash cache (services/imageGen/localGallery.js `cacheImageSha256`).
 */
export function registerGallerySha256Writer(writer) {
  gallerySha256Writer = typeof writer === 'function' ? writer : null;
}

/**
 * Content hash of a sidecar's GEN-PARAMS, identical on every machine so sender and
 * receiver can compare prompt/model metadata.
 *
 * CRITICAL: the `sha256` key is the per-image cache re-stamped with the LOCAL file's
 * mtime+size on every read; hashing it would give identical sidecars different hashes
 * that never converge, re-flagging the image "missing" every sync. So it is stripped and
 * a CANONICAL (sorted-key) serialization of the rest is hashed.
 *
 * Returns a hex sha256 string, or null when the sidecar carries no gen-params
 * beyond the cache key (nothing worth syncing — callers must NOT advertise a
 * sidecarSha256 in that case).
 */
export function sidecarGenParamsHash(sidecar) {
  return genParamsHash(sidecar, null);
}

function genParamsHash(sidecar, extra) {
  if (!isPlainObject(sidecar)) return null;
  // Object.create(null) plus skipping POLLUTING_KEYS keeps a peer-supplied `__proto__`
  // inert; real gen-params never use them. Machine-local fields are skipped like `sha256`.
  const genParams = Object.create(null);
  let count = 0;
  for (const key of Object.keys(sidecar)) {
    if (key === 'sha256' || POLLUTING_KEYS.has(key) || IMAGE_SIDECAR_LOCAL_FIELDS.includes(key)) continue;
    genParams[key] = sidecar[key];
    count += 1;
  }
  if (count === 0 && !extra) return null;
  if (extra) Object.assign(genParams, extra);
  return createHash('sha256').update(canonicalStringify(genParams)).digest('hex');
}

/**
 * Per-machine image sidecar fields: this machine's hide state, a delete it has
 * queued for the image's owner, the peer that handed it the image, and whether it
 * deleted the provider-hosted copy. They are
 * never served to a peer, never taken from a peer's copy, and not part of
 * `sidecarGenParamsHash`. `originInstanceId` is not among them: it syncs.
 */
export const IMAGE_SIDECAR_LOCAL_FIELDS = Object.freeze(['hidden', 'pendingDelete', 'suppliedByInstanceId', ...HOSTED_DELETED_AT_FIELDS]);

/** A copy of `sidecar` without the machine-local fields (non-objects pass through). */
export function stripImageSidecarLocalFields(sidecar) {
  if (!isPlainObject(sidecar)) return sidecar;
  const out = { ...sidecar };
  for (const key of IMAGE_SIDECAR_LOCAL_FIELDS) delete out[key];
  return out;
}

/**
 * Sidecar bytes without the machine-local fields, for a copy that leaves this
 * machine or arrives from another (share buckets, the `/data/images` mount).
 * Bytes that carry none of them, or are not a JSON object, come back unchanged
 * (the same Buffer), so the caller can keep serving or copying them as-is.
 */
export function stripImageSidecarLocalBytes(bytes) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes));
  } catch {
    return bytes;
  }
  if (!isPlainObject(parsed) || !IMAGE_SIDECAR_LOCAL_FIELDS.some((key) => Object.hasOwn(parsed, key))) return bytes;
  return Buffer.from(JSON.stringify(stripImageSidecarLocalFields(parsed), null, 2));
}

/**
 * When this copy of an image came to exist, for tombstone supersession. ISO
 * string, or null when unknown: a caller treats a null-stamped copy as OLD, so
 * a tombstone retires it and a pull of a tombstoned name stays blocked.
 *
 * The sidecar's `createdAt` is the stamp whenever it has one; it travels with
 * the sidecar, so every machine sees the same time. The file's modify time is a
 * stamp ONLY when the sidecar names THIS machine as the image's origin. Any other
 * copy (pulled, imported, restored, synced by an older peer, or with no origin
 * at all) may have landed after the delete, and its file time would make the
 * deleted image look newer than its delete and bring it back. An origin-less
 * copy has no owner candidates either, so a peer's tombstone cannot reach it and
 * the stricter stamp never deletes anything a peer could not already delete.
 * Birth time is never used: copies and restores set it.
 */
export function imageLiveStamp(sidecar, fileStat, { localInstanceId = null } = {}) {
  const meta = isPlainObject(sidecar) ? sidecar : {};
  const created = createdStamp(meta, fileStat, localInstanceId);
  // The owner stamps `restoredAt` past the delete when the user brings a
  // deleted image back (mediaRestoreTombstones.js), so a peer still holding
  // that delete admits the restored copy. It never makes a copy look older.
  return compareNewerWins(meta.restoredAt, created) ? meta.restoredAt : created;
}

function createdStamp(meta, fileStat, localInstanceId) {
  if (typeof meta.createdAt === 'string' && Number.isFinite(Date.parse(meta.createdAt))) return meta.createdAt;
  if (typeof localInstanceId !== 'string' || !localInstanceId || meta.originInstanceId !== localInstanceId) return null;
  const ms = Number(fileStat?.mtimeMs);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

/**
 * True when `sidecar`'s gen-params hash to `advertised`. Copies that differ
 * only in what this machine never takes from a peer also match, or each such
 * image would re-pull every sweep: an older peer still hashes its own `hidden`
 * flag, and a held image without an origin never adopts the sender's
 * (`originCandidates`, e.g. the sender's instance id).
 */
export function sidecarMatchesGenParamsHash(sidecar, advertised, { originCandidates = [] } = {}) {
  const local = sidecarGenParamsHash(sidecar);
  if (local === advertised) return true;
  if (typeof advertised !== 'string' || !isPlainObject(sidecar)) return false;
  const origins = sidecar.originInstanceId === undefined
    ? [undefined, ...originCandidates.filter((id) => typeof id === 'string' && id)]
    : [undefined];
  for (const originInstanceId of origins) {
    const origin = originInstanceId ? { originInstanceId } : null;
    for (const hidden of [undefined, true, false]) {
      const extra = { ...origin, ...(hidden === undefined ? {} : { hidden }) };
      if (Object.keys(extra).length > 0 && genParamsHash(sidecar, extra) === advertised) return true;
    }
  }
  return false;
}
