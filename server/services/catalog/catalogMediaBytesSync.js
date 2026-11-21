/**
 * Catalog federation ships `media_key` rows, not the files they name. The
 * universe push carries no catalog files and the library sweep covers only
 * full-sync peers, so on a partial-sync peer a cast reference's bytes never
 * arrived and its tile sat on "Syncing" for good. After a catalog sync this
 * pulls whatever the live media rows name that this install lacks, from the
 * peer the rows came from.
 *
 * Runs in the background so a slow download never holds the sync cycle. The
 * cursor-driven row sync offers each row once, so this also heals rows applied
 * before it existed: it re-derives "missing" from disk and the DB each sweep,
 * not from the envelope.
 */
import { existsSync } from 'fs';
import { join } from 'path';
import { PATHS, resolveImageInputPath } from '../../lib/fileUtils.js';
import { listLiveMediaFileKeys } from './catalogDB.js';
import { pullMissingAssetsFromPeer } from '../sharing/peerSyncAssets.js';
import { releasedHostedKeys } from '../peerHostedMedia.js';

// A quiet sweep re-checks disk this often; a sweep after applied rows runs at once.
export const CATALOG_BYTES_SWEEP_INTERVAL_MS = 10 * 60_000;
// A file the peer could not supply (pruned there, still being written) is not
// asked for again this soon, so an unservable key costs one request per window.
export const CATALOG_BYTES_RETRY_MS = 60 * 60_000;

// Catalog media kind → the asset-pull kind and the library directory it lands in.
const FILE_DIRS = {
  audio: { assetKind: 'audio', dir: () => PATHS.audio },
  video: { assetKind: 'video', dir: () => PATHS.videos },
  model: { assetKind: 'model', dir: () => PATHS.models },
};

const lastSweepAt = new Map(); // peerInstanceId → ms
const inFlight = new Set(); // peerInstanceId
const failedAt = new Map(); // `${peerInstanceId}\0${assetKind}\0${key}` → ms

const isPresent = ({ mediaKey, kind }) => (FILE_DIRS[kind]
  ? existsSync(join(FILE_DIRS[kind].dir(), mediaKey))
  : resolveImageInputPath(mediaKey) !== null);

// A gallery image or video this machine released to a Make-primary host
// (services/mediaHolders.js) streams from there on purpose: it is not missing.
const releasedKey = ({ mediaKey, kind }) => kind === 'video' ? `video:${mediaKey}` : FILE_DIRS[kind] ? null : `image:${mediaKey}`;

const retryKey = (peerId, entry) => `${peerId}\0${entry.kind}\0${entry.filename}`;

async function pullBatch(peerId, entries, now) {
  const due = entries.filter((e) => now - (failedAt.get(retryKey(peerId, e)) ?? -Infinity) >= CATALOG_BYTES_RETRY_MS);
  if (due.length === 0) return;
  await pullMissingAssetsFromPeer(peerId, due);
  for (const entry of due) {
    // pullMissingAssetsFromPeer swallows per-asset failures, so disk is the verdict.
    const landed = entry.kind === 'image-ref' ? existsSync(join(PATHS.imageRefs, entry.filename)) : isPresent({ mediaKey: entry.filename, kind: entry.catalogKind });
    if (landed) failedAt.delete(retryKey(peerId, entry));
    else failedAt.set(retryKey(peerId, entry), now);
  }
}

/**
 * Pull the catalog's missing media files from one peer. Never throws; returns
 * the number of files still missing after the pull, or null when skipped.
 * @param {{ instanceId: string }} peer
 * @param {{ applied?: number, now?: number }} [options] `applied`: catalog rows the sync just applied
 */
export async function pullMissingCatalogMediaBytes(peer, { applied = 0, now = Date.now() } = {}) {
  const peerId = peer?.instanceId;
  if (typeof peerId !== 'string' || !peerId || inFlight.has(peerId)) return null;
  if (applied === 0 && now - (lastSweepAt.get(peerId) ?? -Infinity) < CATALOG_BYTES_SWEEP_INTERVAL_MS) return null;
  inFlight.add(peerId);
  lastSweepAt.set(peerId, now);
  try {
    const released = await releasedHostedKeys().catch(() => new Set());
    const missing = (await listLiveMediaFileKeys()).filter((m) => !isPresent(m) && !released.has(releasedKey(m)));
    if (missing.length === 0) return 0;
    // Image keys name gallery files; a reference kept only as an upload lives in
    // image-refs on the sender, so ask there for whatever the gallery lacks.
    const images = missing.filter((m) => !FILE_DIRS[m.kind]).map((m) => ({ kind: 'image', filename: m.mediaKey, catalogKind: m.kind }));
    const files = missing.filter((m) => FILE_DIRS[m.kind]).map((m) => ({ kind: FILE_DIRS[m.kind].assetKind, filename: m.mediaKey, catalogKind: m.kind }));
    await pullBatch(peerId, [...images, ...files], now);
    const stillImages = images.filter((e) => !isPresent({ mediaKey: e.filename, kind: e.catalogKind }));
    await pullBatch(peerId, stillImages.map((e) => ({ ...e, kind: 'image-ref' })), now);
    const remaining = missing.filter((m) => !isPresent(m)).length;
    console.log(`📥 Catalog media bytes from ${peer.name || peerId}: ${missing.length} missing, ${remaining} still missing`);
    return remaining;
  } catch (err) {
    console.log(`⚠️ Catalog media bytes sweep for ${peer.name || peerId} failed: ${err.message}`);
    return null;
  } finally {
    inFlight.delete(peerId);
  }
}

export function resetCatalogMediaBytesSyncForTests() {
  lastSweepAt.clear();
  inFlight.clear();
  failedAt.clear();
}
