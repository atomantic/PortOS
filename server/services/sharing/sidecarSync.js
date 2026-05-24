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
 *     tries each online peer until the sidecar is recovered. For use by a
 *     manual "Backfill sidecars" action in the Instances UI.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { atomicWrite, ensureDir, PATHS } from '../../lib/fileUtils.js';
import { imageSidecarName } from './buckets.js';
import { peerFetch } from '../../lib/peerHttpClient.js';
import { getPeers } from '../instances.js';
import { peerBaseUrl } from '../../lib/peerUrl.js';

const SIDECAR_MAX_BYTES = 256 * 1024;

/**
 * Pull `<image-basename>.metadata.json` from a peer's /data/images mount and
 * write it alongside the image. Best-effort: a 404 (no sidecar on the sender)
 * is normal and silently ignored. `imageFilename` must already be sanitized by
 * the caller (it is — doPullOneAsset sanitizes before this is reached).
 *
 * Returns true if the sidecar was successfully fetched and written.
 */
export async function pullSidecarForImage(peer, base, imageFilename) {
  const sidecarName = imageSidecarName(imageFilename);
  const url = `${base}/data/images/${encodeURIComponent(sidecarName)}`;
  const res = await peerFetch(url, { maxBytes: SIDECAR_MAX_BYTES }).catch(() => null);
  if (!res || !res.ok) return false;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0 || buf.length > SIDECAR_MAX_BYTES) return false;
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
 * images that already have a sidecar are silently skipped.
 */
export async function backfillMissingSidecars({ filenames }) {
  const peers = (await getPeers().catch(() => [])).filter(
    (p) => p?.status === 'online' && p.instanceId
  );
  let attempted = 0;
  let recovered = 0;
  for (const filename of Array.isArray(filenames) ? filenames : []) {
    const sidecarPath = join(PATHS.images, imageSidecarName(filename));
    if (existsSync(sidecarPath)) continue;
    attempted++;
    for (const peer of peers) {
      const ok = await pullSidecarForImage(peer, peerBaseUrl(peer), filename).catch(() => false);
      if (ok) {
        recovered++;
        break;
      }
    }
  }
  console.log(`🔄 sidecar backfill: ${recovered}/${attempted} recovered from ${peers.length} peer(s)`);
  return { attempted, recovered };
}
