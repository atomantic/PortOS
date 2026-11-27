/** Verify and publish asset bytes referenced by shared manifests. */

import { isStr } from '../../lib/textUtils.js';
import { basename, join, resolve, relative, sep, dirname } from 'path';
import { isHexHash, bucketBlobPath, bucketBlobSidecarPath, imageSidecarName } from './buckets.js';
import { PATHS, atomicWrite, unlinkGuarded, ensureDir } from '../../lib/fileUtils.js';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { realpath, lstat, open, link } from 'fs/promises';
import { constants, existsSync } from 'fs';
import { ASSET_PULL_MAX_BYTES, SIDECAR_MAX_BYTES } from './assetLimits.js';
import { detectMediaManifest, detectImageFormat } from '../../lib/mimeTypes.js';
import { createHash, randomUUID } from 'crypto';
import { mapWithConcurrency } from '../../lib/mapWithConcurrency.js';
import { stripImageSidecarLocalBytes } from '../../lib/assetHash.js';
import { logFailureWithStack } from '../../lib/failureLogging.js';

// `image-ref` covers files under data/image-refs/ (character reference
// sheets). Unknown kinds collapse to 'image' for back-compat with v1
// peers that only emitted 'image' / 'video'.
const KNOWN_ASSET_KINDS = new Set(['video', 'image', 'image-ref']);

export function manifestAssetRefs(manifest) {
  const refs = [];
  const seen = new Set();
  const push = (raw) => {
    if (!raw || !isStr(raw.ref)) return;
    const kind = KNOWN_ASSET_KINDS.has(raw.kind) ? raw.kind : 'image';
    const filename = basename(raw.ref);
    if (!filename || filename !== raw.ref) return;
    const key = `${kind}:${filename}`;
    if (seen.has(key)) return;
    seen.add(key);
    // hash is optional — only v2+ manifests carry it. Collection items have
    // never carried per-item hashes (they reference filenames in the user's
    // local data dir), so the legacy filename path covers them.
    //
    // Hashes are UNTRUSTED peer input. Accept only well-formed SHA-256
    // (64 lowercase hex chars) so `bucketBlobPath(bucketPath, hash)` can't
    // be coerced into a `path.join('.../assets/blobs', '../../etc/hosts')`
    // path-traversal primitive that would `copyFile` an arbitrary file from
    // the user's filesystem into `data/{images,videos}/`. A malformed hash
    // means the manifest is broken or hostile — drop the ref entirely
    // rather than fall back to the legacy filename path (a v2 manifest
    // that sets a bogus hash isn't a v1 manifest).
    const entry = { kind, ref: filename };
    if (raw.hash !== undefined && raw.hash !== null) {
      if (!isHexHash(raw.hash)) {
        console.error(`⚠️ sharing.importer: dropping asset ref with invalid hash: ${kind}/${filename}`);
        return;
      }
      entry.hash = raw.hash;
    }
    refs.push(entry);
  };
  for (const ref of manifest?.assetRefs || []) push(ref);
  // Universe collection payloads are also asset membership. Import from the
  // payload so late-arriving Drive files can be copied and added incrementally
  // even if assetRefs was incomplete in an older manifest.
  for (const item of manifest?.collection?.items || []) push(item);
  return refs;
}

/**
 * Resolve the bucket-side blob + optional sidecar paths for an asset ref.
 * v2 manifests carry `hash` and read from `assets/blobs/`; legacy v1
 * manifests fall back to `assets/{images,videos}/<filename>`. Videos have no
 * sidecar convention.
 */
function resolveBucketAssetPaths(bucketPath, ref) {
  const isVideo = ref.kind === 'video';
  if (ref.hash) {
    return {
      blobPath: bucketBlobPath(bucketPath, ref.hash),
      sidecarPath: isVideo ? null : bucketBlobSidecarPath(bucketPath, ref.hash),
    };
  }
  const legacyDir = join(bucketPath, 'assets', isVideo ? 'videos' : 'images');
  return {
    blobPath: join(legacyDir, ref.ref),
    sidecarPath: isVideo ? null : join(legacyDir, imageSidecarName(ref.ref)),
  };
}

// Local target dir per asset kind. 'image-ref' covers character reference
// sheets (data/image-refs/). Unknown kinds route to the gallery for
// safety — peer manifests using a kind we don't recognize land there.
const LOCAL_TARGET_DIRS = Object.freeze({
  video: PATHS.videos,
  image: PATHS.images,
  'image-ref': PATHS.imageRefs,
});

/**
 * Copy bundled assets from the bucket into local data dirs. Runs in parallel.
 * The copies and the media_assets rows that index them share one backup lease;
 * the records naming these files merge afterwards, so a cut sees the bytes
 * durable before any row that names them.
 */
export function copyAssetsLocally(bucketPath, assetRefs) {
  return withBackupAssetPublication(() => copyAssetsLocallyAdmitted(bucketPath, assetRefs));
}

// Pin reads to one regular-file descriptor. A cloud-sync writer can replace
// paths during inspection; neither a symlink nor a later path swap may select
// the bytes we publish. The extra byte detects growth without an unbounded read.
async function readBucketAsset(bucketPath, sourcePath, maxBytes) {
  const root = await realpath(bucketPath);
  const source = await realpath(sourcePath);
  const expected = resolve(root, relative(resolve(bucketPath), resolve(sourcePath)));
  if (source !== expected || !source.startsWith(`${root}${sep}`)) return null;
  const info = await lstat(sourcePath);
  if (!info.isFile() || info.size > maxBytes) return null;
  const handle = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino
      || opened.size > maxBytes || await realpath(sourcePath) !== source) return null;
    const buffer = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > opened.size) return null;
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}

async function verifiedBucketAsset(bucketPath, sourcePath, { hash, image = false, maxBytes = ASSET_PULL_MAX_BYTES } = {}) {
  const buffer = await readBucketAsset(bucketPath, sourcePath, maxBytes).catch(() => null);
  if (!buffer?.length || detectMediaManifest(buffer) || image && !detectImageFormat(buffer)) return null;
  if (hash && createHash('sha256').update(buffer).digest('hex') !== hash) return null;
  return buffer;
}

// Publish durable bytes atomically without replacing an existing destination.
// The short temporary name also supports asset filenames already at NAME_MAX.
async function publishBucketAsset(targetPath, buffer) {
  const temporary = join(dirname(targetPath), `.sharing-${randomUUID()}.tmp`);
  try {
    await atomicWrite(temporary, buffer);
    return await link(temporary, targetPath).then(() => true).catch(err => {
      if (err?.code === 'EEXIST') return false;
      throw err;
    });
  } finally {
    await unlinkGuarded(temporary).catch(err => {
      if (err?.code !== 'ENOENT') throw err;
    });
  }
}

async function copyAssetsLocallyAdmitted(bucketPath, assetRefs) {
  await ensureDir(PATHS.images);
  await ensureDir(PATHS.videos);
  await ensureDir(PATHS.imageRefs);
  const copied = [];
  const available = [];
  const missing = [];
  // Buffers remain live through publication; do not read an entire manifest at once.
  await mapWithConcurrency(assetRefs || [], 2, async (ref) => {
    if (!ref || !isStr(ref.ref)) return;
    const filename = basename(ref.ref);
    const kind = ref.kind;
    const targetDir = LOCAL_TARGET_DIRS[kind] || PATHS.images;
    const targetPath = join(targetDir, filename);
    const { blobPath, sidecarPath } = resolveBucketAssetPaths(bucketPath, ref);
    if (!existsSync(blobPath)) {
      missing.push({ kind, ref: filename });
      return;
    }
    const buffer = await verifiedBucketAsset(bucketPath, blobPath, { hash: ref.hash, image: kind !== 'video' });
    const hasSidecar = sidecarPath && existsSync(sidecarPath);
    const sidecar = hasSidecar ? await verifiedBucketAsset(bucketPath, sidecarPath, { maxBytes: SIDECAR_MAX_BYTES }) : null;
    if (!buffer || hasSidecar && !sidecar) {
      console.warn(`⚠️ sharing.importer: refused asset ${kind}/${JSON.stringify(filename)}`);
      missing.push({ kind, ref: filename });
      return;
    }
    available.push({ kind, ref: filename });
    if (!existsSync(targetPath) && await publishBucketAsset(targetPath, buffer)) {
      copied.push({ kind, ref: filename });
    }
    if (sidecar) {
      const sidecarTarget = join(targetDir, imageSidecarName(filename));
      // Another machine's own fields never land here: a foreign supplier id
      // would make a third machine eligible to delete this image.
      if (!existsSync(sidecarTarget)) await publishBucketAsset(sidecarTarget, stripImageSidecarLocalBytes(sidecar));
    }
    if (kind === 'image') await import('../mediaAssetIndex/index.js').then(m => m.indexImage({ filename })).catch(err => logFailureWithStack('❌ Media index imported asset refresh', err));
  });
  return { copied, available, missing };
}
