/**
 * Sidecar sync helpers for federated image gen-params metadata.
 *
 * Each locally-generated image can have a `<base>.metadata.json` sidecar
 * stored alongside it in PATHS.images. When a peer pulls an image over
 * federated sync they should also receive the gen-params sidecar so the
 * image lands in their gallery with its prompt intact (not stuck in Unsorted
 * with no prompts). This module provides:
 *
 *   - `pullSidecarForImage` — fetches one sidecar from a peer's /data/images
 *     static mount and writes it locally. Best-effort; 404 = no sidecar on
 *     the sender, silently ignored.
 *   - `backfillMissingSidecars` — walks a list of local image filenames and
 *     tries each online peer until the sidecar is recovered. Drives the manual
 *     "Pull missing prompts" action (Unsorted view in MediaCollectionDetail +
 *     the sync drawer) via POST /api/peer-sync/pull-metadata.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { atomicWrite, ensureDir, readJSONFile, PATHS } from '../../lib/fileUtils.js';
import { imageSidecarName, sanitizeAssetFilename } from './buckets.js';
import { sidecarGenParamsHash } from '../../lib/assetHash.js';
import { isPlainObject } from '../../lib/objects.js';
import { peerFetch } from '../../lib/peerHttpClient.js';
import { withAbortTimeout } from '../../lib/abortTimeout.js';
import { getPeers } from '../instances.js';
import { peerBaseUrl } from '../../lib/peerUrl.js';

const SIDECAR_MAX_BYTES = 256 * 1024;
// Mirror the image-pull timeout (peerSync.js ASSET_PULL_TIMEOUT_MS) so a hung
// peer connection aborts instead of holding the pull open indefinitely.
const SIDECAR_PULL_TIMEOUT_MS = 60000;

/**
 * Read a fetch Response body into a Buffer, aborting once `maxBytes` is
 * exceeded. peerFetch's HTTPS shim already enforces maxBytes mid-stream, but the
 * plain-HTTP path falls back to native fetch, which does NOT — a peer that lies
 * about Content-Length (or uses chunked transfer) could otherwise buffer an
 * unbounded body via `res.arrayBuffer()` before any post-read size check runs.
 * When a ReadableStream reader is available (native fetch) we cap mid-stream;
 * otherwise we fall back to arrayBuffer (the shim already bounded it, or it's a
 * test mock). Returns null on over-cap or any read error (best-effort, runs
 * outside the Express request lifecycle so a throw must not escape).
 */
async function readBodyCapped(res, maxBytes) {
  const reader = res.body?.getReader?.();
  if (!reader) {
    return res.arrayBuffer().then((ab) => Buffer.from(ab)).catch(() => null);
  }
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(Buffer.from(value));
    }
  } catch {
    return null;
  }
  return Buffer.concat(chunks);
}

/**
 * Pull `<image-basename>.metadata.json` from a peer's /data/images mount and
 * write it alongside the image. Best-effort: a 404 (no sidecar on the sender)
 * is normal and silently ignored.
 *
 * Defense-in-depth: the filename is sanitized HERE (not only by callers) so the
 * function is safe regardless of entry point — `backfillMissingSidecars` is a
 * future client-POST surface and `encodeURIComponent` only protects the URL,
 * not the local `join(PATHS.images, …)` path. A `../`-bearing filename is
 * rejected before any FS op.
 *
 * Returns true if the sidecar was successfully fetched, parsed, and written.
 */
export async function pullSidecarForImage(peer, base, imageFilename) {
  const safeName = sanitizeAssetFilename(imageFilename);
  if (!safeName) return false;
  const sidecarName = imageSidecarName(safeName);
  const url = `${base}/data/images/${encodeURIComponent(sidecarName)}`;
  // Abort a hung connection after the timeout — mirrors the image pull worker.
  const res = await withAbortTimeout(SIDECAR_PULL_TIMEOUT_MS, (signal) =>
    peerFetch(url, { signal, maxBytes: SIDECAR_MAX_BYTES }, peer))
    .catch(() => null);
  if (!res || !res.ok) return false;
  // Require a trustworthy content-length and refuse over-cap BEFORE buffering.
  // peerFetch only enforces `maxBytes` on the HTTPS shim; the plain-HTTP path
  // falls back to native fetch (no streaming cap), so without this guard an
  // HTTP peer could stream an unbounded body into memory. serve-static always
  // sets content-length for static files — mirrors doPullOneAsset in peerSync.js.
  if (!res.headers.has('content-length')) return false;
  const contentLength = Number(res.headers.get('content-length'));
  if (!Number.isFinite(contentLength) || contentLength <= 0 || contentLength > SIDECAR_MAX_BYTES) return false;
  // Stream with a hard cap so a peer lying about Content-Length can't blow
  // memory on the native-fetch (plain-HTTP) path before the size checks below.
  const buf = await readBodyCapped(res, SIDECAR_MAX_BYTES);
  if (!buf || buf.length === 0 || buf.length > SIDECAR_MAX_BYTES || buf.length !== contentLength) return false;
  // JSON-parse gate: a peer (or an intermediary) could serve an HTML error
  // page with a 200, which we'd otherwise write as `<base>.metadata.json` and
  // corrupt the gallery's gen-params reader. Only write if the body is valid
  // JSON. Wrapped in try/catch because JSON.parse throws (this runs outside the
  // Express request lifecycle, so an uncaught throw would crash the worker).
  let parsed;
  try {
    parsed = JSON.parse(buf.toString('utf8'));
  } catch {
    return false;
  }
  // Must be a JSON OBJECT, not just valid JSON. A scalar/array (`"oops"`, `[]`)
  // parses fine but writing it would corrupt the gallery reader: downstream
  // getOrComputeImageSha256 does `{ ...(sidecar || {}) }`, and spreading a
  // truthy string yields numeric char keys (`{0:'o',1:'o',…}`).
  if (!isPlainObject(parsed)) return false;
  // Refuse a cache-only sidecar (just the machine-local `sha256` block, no
  // gen-params): it carries no prompt worth recovering and writing it could
  // clobber a prompt-bearing sidecar already on disk. sidecarGenParamsHash
  // returns null exactly when nothing remains beyond the sha256 cache key.
  if (sidecarGenParamsHash(parsed) === null) return false;
  await ensureDir(PATHS.images);
  await atomicWrite(join(PATHS.images, sidecarName), buf);
  console.log(`📥 peerSync: pulled sidecar ${sidecarName} from ${peer.name || peer.instanceId}`);
  return true;
}

/**
 * For each local image filename lacking a sidecar, try each online peer until
 * one yields the sidecar. Returns `{ attempted, recovered }`.
 *
 * `filenames` should be an array of image filenames (with extension) already
 * present in PATHS.images. Only images whose sidecar is absent are attempted —
 * images that already have a sidecar are silently skipped. Filenames that fail
 * sanitization (path traversal) are skipped entirely.
 */
export async function backfillMissingSidecars({ filenames }) {
  // Skip peers the user explicitly turned off (enabled:false) or disabled sync
  // for (syncEnabled:false) — the manual backfill must not contact peers the
  // user opted out of, matching how syncOrchestrator gates its peer set. Both
  // default-on-unless-false (mirrors useSyncIntegrity's eligibility filter).
  const peers = (await getPeers().catch(() => [])).filter(
    (p) => p?.enabled !== false && p?.syncEnabled !== false && p?.status === 'online' && p.instanceId
  );
  let attempted = 0;
  let recovered = 0;
  for (const filename of Array.isArray(filenames) ? filenames : []) {
    const safeName = sanitizeAssetFilename(filename);
    if (!safeName) continue;
    // Contract: filenames name images already present in PATHS.images. Skip any
    // whose image bytes are absent — a stale/invalid filename would otherwise
    // write an orphan `<base>.metadata.json` (sidecar with no image) and inflate
    // `attempted`.
    if (!existsSync(join(PATHS.images, safeName))) continue;
    const sidecarPath = join(PATHS.images, imageSidecarName(safeName));
    // A sidecar can exist yet carry NO prompt: getOrComputeImageSha256 writes a
    // cache-only `{ sha256: {...} }` sidecar for every image it hashes during
    // sync. Skipping on mere file existence would make "Pull missing prompts" a
    // no-op for exactly the images this repair targets (synced-in, no gen-params).
    // Only skip when the sidecar already holds real gen-params — sidecarGenParamsHash
    // strips the sha256 cache key and returns null when nothing else remains.
    if (existsSync(sidecarPath)) {
      const existing = await readJSONFile(sidecarPath, null, { logError: false });
      if (sidecarGenParamsHash(existing) !== null) continue;
    }
    attempted++;
    for (const peer of peers) {
      const ok = await pullSidecarForImage(peer, peerBaseUrl(peer), safeName).catch(() => false);
      if (ok) {
        recovered++;
        break;
      }
    }
  }
  console.log(`🔄 sidecar backfill: ${recovered}/${attempted} recovered from ${peers.length} peer(s)`);
  return { attempted, recovered };
}
