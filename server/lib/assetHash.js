import { stat } from 'fs/promises';
import { basename, join } from 'path';
import { atomicWrite, readJSONFile, sha256File, PATHS } from './fileUtils.js';

// Each image at `data/images/{uuid}.png` has a sibling `.metadata.json`
// sidecar carrying its generation provenance (model, prompt, dimensions, etc).
// The federated peer-sync system also needs the SHA-256 of the image bytes so
// the receiver can diff its local set against a sender's manifest without
// downloading every file. Computing sha256 over a 2–3 MB PNG is cheap on
// modern hardware but quickly adds up at universe-scale (~200 assets per
// universe × multiple universes × every sync cycle), so we persist the hash
// in the sidecar once and reuse it forever — invalidating only when the
// image's mtime+size change (a re-render replaces the file in place).
//
// The sharing-bucket exporter has its own per-bucket cache for the same
// reason, but that cache lives inside a specific bucket directory and is not
// reachable by the peer-sync path. The sidecar is the universal source of
// truth — both transports read from it.

const HEX_64 = /^[a-f0-9]{64}$/;

const isHexHash = (v) => typeof v === 'string' && HEX_64.test(v);

/**
 * Path to the metadata sidecar for an image filename. Accepts either the bare
 * filename (`abc.png`) or an absolute path; the sidecar always sits next to
 * the image in PATHS.images.
 */
export function sidecarPathForImage(imageFilenameOrPath) {
  // Total over all inputs — callers (`getOrComputeImageSha256`, the share-bucket
  // exporter, the upcoming peer-sync push) treat a null return as "no sidecar
  // path resolvable for this asset" and fall through. Without the type guard,
  // `path.basename(null)` would throw TypeError and crash the calling pipeline.
  if (typeof imageFilenameOrPath !== 'string' || !imageFilenameOrPath) return null;
  const base = basename(imageFilenameOrPath);
  if (!base) return null;
  // Strip extension and append `.metadata.json` (e.g. `abc.png` → `abc.metadata.json`).
  // Mirrors `imageSidecarName` in services/sharing/buckets.js — kept inline
  // here to avoid lib/ → services/ import direction.
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return join(PATHS.images, `${stem}.metadata.json`);
}

/**
 * Returns sha256 of the image at `imagePath`, reading from the sidecar when
 * possible and computing fresh (and persisting) when not. The sidecar entry
 * is keyed on mtimeMs + size so a re-rendered image (same UUID, different
 * bytes) invalidates the cached hash naturally.
 *
 * Returns `{ hash, sidecar }` where `sidecar` is the latest sidecar JSON
 * (with the sha256 entry merged in) — callers who already need to read the
 * sidecar for prompt/model metadata save a round-trip by reusing this object.
 *
 * Returns null when the image itself is missing or unreadable.
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
  const next = {
    ...(sidecar || {}),
    sha256: { value: hash, mtimeMs: info.mtimeMs, size: info.size },
  };
  // Atomic so a concurrent reader never sees a half-written file. A race with
  // a parallel re-render is benign: the loser's hash entry just gets
  // overwritten on the next read (mtimeMs comparison invalidates it).
  await atomicWrite(sidecarPath, next).catch((err) => {
    // Sidecar may be missing entirely (asset has no provenance) and the dir
    // may not exist — log but don't fail the caller, the hash is still valid
    // for this call's purposes.
    console.error(`⚠️ assetHash: sidecar write failed for ${sidecarPath}: ${err?.message || err}`);
  });
  return { hash, sidecar: next };
}
