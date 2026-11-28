/** Fetch, verify, and publish missing assets from configured federation peers. */

import { join } from 'path';
import { existsSync } from 'fs';
import { link, stat } from 'fs/promises';
import { pipeline } from 'node:stream/promises';
import { createHash, randomUUID } from 'node:crypto';
import { PATHS, atomicWrite, ensureDir, sha256File, createWriteStreamGuarded, unlinkGuarded } from '../../lib/fileUtils.js';
import { peerBaseUrl } from '../../lib/peerUrl.js';
import { peerFetch, peerStreamRequest, readPeerBody } from '../../lib/peerHttpClient.js';
import { RESPONSE_TOO_LARGE } from '../../lib/httpClient.js';
import { withAbortTimeout } from '../../lib/abortTimeout.js';
import { getOrComputeImageSha256 } from '../../lib/assetHash.js';
import { generateThumbnail } from '../../lib/ffmpeg.js';
import { sanitizeAssetFilename } from './buckets.js';
import { pullSidecarForImage, recordImageSupplier } from './sidecarSync.js';
import { WRITERS_ROOM_DRAFT_ASSET_KIND } from '../writersRoom/syncLogic.js';
import { WORK_ID_RE, DRAFT_ID_RE } from '../writersRoom/_shared.js';
import { getWorkForSync } from '../writersRoom/sync.js';
import { createKeyCachedQueue } from '../../lib/createKeyCachedQueue.js';
import { mapWithConcurrency } from '../../lib/mapWithConcurrency.js';
import { peerSyncEvents, findPeerById } from './peerSyncShared.js';
import { isStr } from '../../lib/textUtils.js';
import { detectMediaManifest } from '../../lib/mimeTypes.js';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { ASSET_PULL_MAX_BYTES } from './assetLimits.js';
import { assertFileNotMediaManifest } from '../../lib/uploads.js';
import { clearImageTombstoneSupersededByOwner } from '../imageGen/imageRecords.js';
import {
  blockedByImageTombstone,
  blockedByVideoTombstone,
  deletedImageStamps,
  deletedVideoIds,
  directoryForAssetKind,
  hasAllowedAssetExtension,
  isTransferMediaFilename,
  readVideoHistoryRows
} from './peerSyncAssetMetadata.js';

// The reverse lookup (#4162): given an on-disk video basename, what THUMBNAIL
// basename does its history row declare? Returns `null` when no row carries the
// filename or its `thumbnail` isn't a safe basename.
//
// A history id is NOT the video filename stem. `videoGen/local.js` names a clip
// `<jobId>.mp4` beside `thumbnail: '<jobId>.jpg'`, so stem-derivation happens to
// land on the right name there — but `videoTimeline/local.js` mints an
// independent `randomUUID()` id for a stitched final whose file is
// `timeline-<projectId-slice>-<ts>.mp4`. Every poster URL the UI builds is
// `/data/video-thumbnails/<row.id>.jpg`, so a stem-derived regeneration writes a
// name nothing ever requests and the card stays on MediaImage's "Syncing"
// placeholder forever.
//
// `row.thumbnail` rode the wire from a peer, so it goes through
// `sanitizeAssetFilename` before it can become a path segment.
function createVideoThumbnailLookup() {
  let cachedStamp = null;
  let byFilenamePromise = null;
  const videoHistoryStamp = () => stat(join(PATHS.data, 'video-history.json'))
    .then((info) => `${info.mtimeMs}:${info.size}:${info.ino}:${info.ctimeMs}`, () => 'missing');
  return async (filename) => {
    const stamp = await videoHistoryStamp();
    if (!byFilenamePromise || stamp !== cachedStamp) {
      cachedStamp = stamp;
      byFilenamePromise = readVideoHistoryRows()
        .then((rows) => {
          const map = new Map();
          for (const row of rows) {
            if (!isStr(row?.filename) || map.has(row.filename)) continue;
            map.set(row.filename, isStr(row?.thumbnail) ? sanitizeAssetFilename(row.thumbnail) : null);
          }
          return map;
        })
        .catch(() => new Map());
    }
    return (await byFilenamePromise).get(filename) ?? null;
  };
}

async function videoThumbnailNameForVideo(filename, lookupVideoThumbnail) {
  if (lookupVideoThumbnail) return lookupVideoThumbnail(filename);
  for (const row of await readVideoHistoryRows()) {
    if (row?.filename !== filename) continue;
    return isStr(row?.thumbnail) ? sanitizeAssetFilename(row.thumbnail) : null;
  }
  return null;
}

// Regenerate a video poster under the history row's declared name. The helper
// also runs for a hash-matched video: metadata and bytes can arrive in either
// order, and a first pull may have made only the filename-stem fallback before
// a later videoHistory sync declared an independent poster name.
async function reconcileVideoThumbnail(filename, videoPath, peerId, lookupVideoThumbnail) {
  const rowThumbnail = await videoThumbnailNameForVideo(filename, lookupVideoThumbnail).catch(() => null);
  const jobId = (rowThumbnail || filename).replace(/\.[a-z0-9]+$/i, '');
  const expectedFilename = `${jobId}.jpg`;
  if (existsSync(join(PATHS.videoThumbnails, expectedFilename))) return null;

  const thumbFilename = await generateThumbnail(videoPath, jobId).catch(() => null);
  if (thumbFilename) {
    peerSyncEvents.emit('asset-arrived', {
      filename: thumbFilename,
      kind: 'video-thumbnail',
      peerId,
    });
  }
  return thumbFilename;
}

// --- Receiver-side asset pull worker ------------------------------------

const ASSET_KIND_TO_URL_PREFIX = Object.freeze({
  image: '/data/images',
  'image-ref': '/data/image-refs',
  video: '/data/videos',
  music: '/data/music',
  // `audio` (#1566) — pipeline TTS / generated audio under data/audio, pulled by
  // the standalone media-library sweep. (video-thumbnails are NOT pulled: a video
  // pull regenerates its thumbnail locally — see doPullOneAsset's video branch.)
  audio: '/data/audio',
  model: '/data/models',
});

export const ASSET_PULL_TIMEOUT_MS = 60000;
const ASSET_PULL_CONCURRENCY = 4;

// In-flight pull dedup. A peer can push multiple records that reference the
// same asset in quick succession (universe edit → child collection re-link
// → series under that universe), and without this guard we'd kick off
// duplicate downloads of the same UUID-named PNG — wasting bandwidth,
// doubling the 100MB memory ceiling per asset, and racing on the same
// destination filename. Key on (peerId, kind, filename) so concurrent
// pushes from DIFFERENT peers for the same filename are still allowed
// (e.g. peer-A re-renders and peer-B caches the old bytes — we want the
// newer-pushing peer to win, and the snapshot-sync safety net catches
// any divergence).
export const inflightPulls = new Set();
export function inflightKey(peerId, kind, filename) {
  return `${peerId}:${kind}:${filename}`;
}

// Per-DESTINATION serialization (#3929). `inflightPulls` above is deliberately
// peer-scoped, so two DIFFERENT full-sync peers advertising the same filename —
// the normal case for a mirrored media library — both pass its guard and would
// otherwise download and write `data/{images,videos,...}/<name>` concurrently.
// Key this queue on the destination (kind + filename) ONLY, so those pulls run
// one-after-another instead of racing on the same target path. Serializing (not
// dropping) preserves the peer-scoped guard's intent — the later-pushing peer
// still gets its turn to win — while the re-check at the top of doPullOneAsset
// means the second turn usually costs a hash instead of a second download.
export const assetWriteQueue = createKeyCachedQueue();
export function assetDestinationKey(kind, filename) {
  return `${kind}:${filename}`;
}

/**
 * Background-fetch every asset in `missingAssets` from the named peer's
 * static `/data/{kind-dir}/` mount, writing each to the local PATHS dir for
 * that kind. Emits `peerSyncEvents 'asset-arrived'` per file so the client's
 * MediaImage placeholder can swap to the live asset.
 *
 * Each fetch is best-effort: a single failure does NOT abort the others, and
 * the asset will be retried on the next push cycle (since the receiver will
 * still report it as missing). The 60s loop's snapshot path also catches
 * up if push-driven pulls keep failing — defense in depth.
 *
 * Pools up to ASSET_PULL_CONCURRENCY concurrent fetches while preserving
 * per-peer in-flight dedup and per-destination write serialization.
 */
export async function pullMissingAssetsFromPeer(senderInstanceId, missingAssets, { includeMismatched = true } = {}) {
  if (!isStr(senderInstanceId) || !Array.isArray(missingAssets) || missingAssets.length === 0) return;
  // Trust posture: `senderInstanceId` arrives in the push payload (the route
  // is Tailnet-only per the project's documented threat model — see
  // AGENTS.md "Security Model"). We DON'T derive it from the TCP origin
  // because Express behind Tailscale loses that fidelity to the SO_REUSEADDR
  // socket. The guard below means even a payload that *spoofs* a different
  // peer's id can only redirect the asset pull at one of our OWN registered
  // peers — `findPeerById` returns null for any unknown id, aborting the
  // pull. So the worst case is fetching from peer-B when peer-A actually
  // pushed; both are trusted Tailnet peers, the fetch either succeeds (we
  // get the bytes peer-A wanted us to have) or 404s (we re-request next
  // push cycle). Outside the Tailnet trust boundary, the right answer is
  // mutual TLS or an HMAC over the payload — explicitly out of scope for
  // PortOS's stated security model.
  const peer = await findPeerById(senderInstanceId);
  if (!peer) {
    console.log(`⚠️ peerSync: can't pull assets — peer ${senderInstanceId} not in registry`);
    return;
  }
  const base = peerBaseUrl(peer);
  const deletedImages = await deletedImageStamps(missingAssets);
  const deletedVideos = await deletedVideoIds(missingAssets);
  const eligible = missingAssets.filter(
    (entry) => !blockedByImageTombstone(deletedImages, entry) && !blockedByVideoTombstone(deletedVideos, entry),
  );
  const lookupVideoThumbnail = createVideoThumbnailLookup();
  await mapWithConcurrency(eligible, ASSET_PULL_CONCURRENCY, (entry) =>
    pullOneAsset(peer, base, entry, includeMismatched, lookupVideoThumbnail).catch((err) => {
      console.log(`⚠️ peerSync: asset pull ${entry.filename} from ${peer.name || senderInstanceId} failed: ${err.message}`);
    }),
  );
}

// Explicit collection moves can include long video renders. Stream them into
// a sibling temp file so an authenticated copy is bounded without a RAM-sized
// ceiling, and publish only after the complete payload verifies.
export const VERIFIED_MEDIA_COPY_TIMEOUT_MS = 10 * 60_000;
const VERIFIED_MEDIA_COPY_MAX_BYTES = 32 * 1024 ** 3;

export async function pullVerifiedMediaCopy(peer, entry) {
  const { kind, filename, sha256 } = entry;
  if (!['image', 'video'].includes(kind) || sanitizeAssetFilename(filename) !== filename || !isTransferMediaFilename(kind, filename)) return;
  if (blockedByImageTombstone(await deletedImageStamps([entry]), entry) || blockedByVideoTombstone(await deletedVideoIds([entry]), entry)) return;

  const dir = directoryForAssetKind(kind);
  const fullPath = join(dir, filename);
  const base = peerBaseUrl(peer);
  const url = `${base}${ASSET_KIND_TO_URL_PREFIX[kind]}/${encodeURIComponent(filename)}`;
  await assetWriteQueue(assetDestinationKey(kind, filename), async () => {
    if (existsSync(fullPath)) return;
    await ensureDir(dir);
    const temp = join(dir, `.media-copy-${randomUUID()}.tmp`);
    try {
      const size = await withAbortTimeout(VERIFIED_MEDIA_COPY_TIMEOUT_MS, async (signal) => {
        const { status, headers, stream } = await peerStreamRequest(url, { signal }, peer);
        try {
          const size = Number(headers['content-length']);
          if (status !== 200 || headers['x-portos-media-location'] === 'remote' ||
              !Number.isSafeInteger(size) || size <= 0 || size > VERIFIED_MEDIA_COPY_MAX_BYTES) return null;
          let received = 0;
          await pipeline(stream, async function* (chunks) {
            for await (const chunk of chunks) {
              received += chunk.length;
              if (received > size) throw new Error('Media copy exceeded its declared length');
              yield chunk;
            }
          }, await createWriteStreamGuarded(temp, { flags: 'wx' }), { signal });
          return received === size ? size : null;
        } finally {
          stream.destroy();
        }
      });
      if (size === null || await sha256File(temp) !== sha256) return;
      await assertFileNotMediaManifest(temp);
      await withBackupAssetPublication(async () => {
        // A hard link publishes atomically without replacing a file another
        // writer created while this transfer was underway.
        const published = await link(temp, fullPath).then(() => true).catch((err) => {
          if (err.code === 'EEXIST') return false;
          throw err;
        });
        if (published) await finishPulledAsset(peer, base, entry, fullPath, filename, size, true);
      });
    } finally {
      await unlinkGuarded(temp).catch((err) => {
        if (err.code !== 'ENOENT') throw err;
      });
    }
  });
}

/**
 * Fetch a peer's static-mount asset URL into a size-capped Buffer, or null on
 * any failure. Centralizes the content-length guards shared by the generic
 * asset pull (`doPullOneAsset`) and the Writers Room draft-body pull
 * (`pullOneWorkBody`): REQUIRE a trustworthy content-length header up front
 * (Express serve-static always sets it) so a hostile peer can't OOM us by
 * shipping a huge body under a small filename before the `.arrayBuffer()` cap
 * runs. `label` is the filename used in log lines.
 */
export async function fetchCappedAssetBuffer(peer, url, label, maxBytes, { allowEmpty = false } = {}) {
  // maxBytes propagates into the HTTPS shim's streaming cap (see
  // server/lib/httpClient.js), which rejects with a RESPONSE_TOO_LARGE-coded
  // Error; the plain-HTTP path falls back to the post-resolve content-length
  // checks below (serve-static always sets it).
  const res = await withAbortTimeout(ASSET_PULL_TIMEOUT_MS, (signal) =>
    peerFetch(url, { signal, maxBytes }, peer))
    .catch((err) => {
      if (err?.code === RESPONSE_TOO_LARGE) {
        console.log(`⚠️ peerSync: ${label} exceeded asset size cap — ${err.message}`);
      }
      return null;
    });
  if (!res || !res.ok) return null;
  // Use has() to distinguish "header missing" from "header is '0'" — without it
  // `Number(null)` is 0 and slips past the finite-non-negative guard.
  if (!res.headers.has('content-length')) {
    console.log(`⚠️ peerSync: asset ${label} has no content-length — refusing pull`);
    return null;
  }
  const contentLength = Number(res.headers.get('content-length'));
  // Writers Room draft bodies can legitimately be EMPTY (a brand-new or cleared
  // draft is a 0-byte .md), so they pass `allowEmpty` to permit Content-Length: 0;
  // for every other asset kind a 0-byte body is meaningless and stays rejected.
  const lengthOk = Number.isFinite(contentLength) && (allowEmpty ? contentLength >= 0 : contentLength > 0);
  if (!lengthOk) {
    console.log(`⚠️ peerSync: asset ${label} has invalid content-length (${res.headers.get('content-length')}) — refusing pull`);
    return null;
  }
  if (contentLength > maxBytes) {
    console.log(`⚠️ peerSync: asset ${label} too large (${contentLength}) — refusing pull`);
    return null;
  }
  const bytes = await readPeerBody(res, 'arrayBuffer', { maxBytes, idleTimeoutMs: ASSET_PULL_TIMEOUT_MS }).catch(() => null);
  if (bytes === null) return null;
  const buffer = Buffer.from(bytes);
  // Defense in depth: the server claimed length X but actually sent more.
  if (buffer.length > maxBytes || buffer.length !== contentLength) {
    console.log(`⚠️ peerSync: asset ${label} length mismatch (header=${contentLength}, body=${buffer.length}) — refusing pull`);
    return null;
  }
  return buffer;
}

// --- Receiver-side Writers Room draft-body pull -------------------------
// Bodies live at works/<workId>/drafts/<draftId>.md (nested), not a flat
// basename under one dir, so they ride a dedicated manifest + pull instead of
// the generic flat-asset pipeline. The sender serves them from its
// /data/writers-room/works static mount (server/index.js).
const WORK_BODY_PULL_MAX_BYTES = 16 * 1024 * 1024; // bodies are ≤5MB (validated); 16MB is generous

export async function pullMissingWorkBodies(senderInstanceId, missingBodies) {
  if (!isStr(senderInstanceId) || !Array.isArray(missingBodies) || missingBodies.length === 0) return;
  const peer = await findPeerById(senderInstanceId);
  if (!peer) {
    console.log(`⚠️ peerSync: can't pull draft bodies — peer ${senderInstanceId} not in registry`);
    return;
  }
  const base = peerBaseUrl(peer);
  await mapWithConcurrency(missingBodies, ASSET_PULL_CONCURRENCY, (entry) =>
    pullOneWorkBody(peer, base, entry).catch((err) => {
      console.log(`⚠️ peerSync: draft-body pull ${entry?.draftId} from ${peer.name || senderInstanceId} failed: ${err.message}`);
    }),
  );
}

async function pullOneWorkBody(peer, base, entry) {
  const { workId, draftId } = entry || {};
  // Re-validate the path segments here even though diffWorkBodyManifest already
  // did — belt-and-suspenders against a future refactor that bypasses the diff.
  if (typeof workId !== 'string' || !WORK_ID_RE.test(workId)) return;
  if (typeof draftId !== 'string' || !DRAFT_ID_RE.test(draftId)) return;
  const safeLabel = `${workId}/${draftId}.md`;
  const key = inflightKey(peer.instanceId, WRITERS_ROOM_DRAFT_ASSET_KIND, safeLabel);
  if (inflightPulls.has(key)) return;
  inflightPulls.add(key);
  try {
    const url = `${base}/data/writers-room/works/${encodeURIComponent(workId)}/drafts/${encodeURIComponent(draftId)}.md`;
    const buffer = await fetchCappedAssetBuffer(peer, url, safeLabel, WORK_BODY_PULL_MAX_BYTES, { allowEmpty: true });
    if (!buffer) return;
    // Integrity: the bytes must hash to the advertised sha256 (discard a corrupt
    // or wrong download instead of writing it over the draft).
    const bufHash = createHash('sha256').update(buffer).digest('hex');
    if (bufHash !== entry.sha256) {
      console.log(`⚠️ peerSync: draft body ${safeLabel} hash mismatch — discarding (got ${bufHash.slice(0, 8)}, want ${String(entry.sha256).slice(0, 8)})`);
      return;
    }
    const { applyPulledDraftBody } = await import('../writersRoom/local.js');
    const written = await applyPulledDraftBody(entry, buffer, { via: 'peer-sync', peerId: peer.instanceId });
    if (!written) {
      console.log(`⚠️ peerSync: draft body ${safeLabel} target moved since diff — skipping write`);
      return;
    }
    peerSyncEvents.emit('asset-arrived', {
      filename: `${draftId}.md`,
      kind: WRITERS_ROOM_DRAFT_ASSET_KIND,
      peerId: peer.instanceId,
    });
    console.log(`📥 peerSync: pulled draft body ${safeLabel} from ${peer.name || peer.instanceId} (${buffer.length} bytes)`);
  } finally {
    inflightPulls.delete(key);
  }
}

async function pullOneAsset(peer, base, entry, includeMismatched, lookupVideoThumbnail) {
  const urlPrefix = ASSET_KIND_TO_URL_PREFIX[entry.kind];
  const localDir = directoryForAssetKind(entry.kind);
  // Re-validate the filename here even though the receiver already
  // sanitized it in diffAssetManifestAgainstLocal — belt-and-suspenders
  // against any future refactor that bypasses the diff path.
  const safeName = sanitizeAssetFilename(entry.filename);
  if (!urlPrefix || !localDir || !safeName) return;
  if (!hasAllowedAssetExtension(entry.kind, safeName)) return;
  // Dedup in-flight pulls — if the same (peer, kind, filename) is already
  // being downloaded, skip rather than starting a second concurrent pull.
  // The first pull's `asset-arrived` event will resolve the UI for both
  // the original triggering push AND any subsequent push that wanted the
  // same bytes.
  const key = inflightKey(peer.instanceId, entry.kind, safeName);
  if (inflightPulls.has(key)) return;
  inflightPulls.add(key);
  try {
    // Serialize on the DESTINATION path so a concurrent sweep from a different
    // peer for this same filename waits its turn instead of writing alongside us
    // (#3929). See assetWriteQueue.
    await assetWriteQueue(
      assetDestinationKey(entry.kind, safeName),
      () => doPullOneAsset(peer, base, entry, urlPrefix, localDir, safeName, includeMismatched, lookupVideoThumbnail),
    );
  } finally {
    inflightPulls.delete(key);
  }
}

async function doPullOneAsset(peer, base, entry, urlPrefix, localDir, safeName, includeMismatched, lookupVideoThumbnail) {
  // A missing asset can arrive while this stale push waits on the write queue.
  // Preserve its bytes and sidecar once another writer has filled the gap.
  const fullPath = join(localDir, safeName);
  if (!includeMismatched && existsSync(fullPath)) return;
  // Re-check disk against the advertised hash before spending a download. Two
  // distinct cases land here with the bytes already correct:
  //   - sidecar-only divergence: the image bytes hash-match and
  //     diffAssetManifestAgainstLocal returned this entry purely because the
  //     local gen-params sidecar is absent or stale;
  //   - a concurrent sweep from ANOTHER peer just committed these same bytes
  //     while we waited on the destination queue (#3929) — the diff that queued
  //     this entry ran before the lock, so it can be stale by the time we run.
  // Checking for EVERY kind (not just images) is the point: a video/music
  // re-pull is the expensive duplicate, and hashing a local file beats
  // re-streaming it from the peer.
  if (isStr(entry.sha256)) {
    const localFullPath = join(localDir, safeName);
    if (existsSync(localFullPath)) {
      const localHash = entry.kind === 'image'
        ? (await getOrComputeImageSha256(localFullPath))?.hash ?? null
        : await sha256File(localFullPath).catch(() => null);
      if (localHash === entry.sha256) {
        // Bytes already up-to-date. Images still reconcile their sidecar, since
        // that may be the only reason this entry was flagged.
        // A video can have arrived before its video-history metadata. Recheck
        // the declared poster even though the mp4 itself does not need a pull.
        await withBackupAssetPublication(async () => {
          if (entry.kind === 'image') await pullSidecarForImage(peer, base, safeName).catch(() => {});
          if (entry.kind === 'video') await reconcileVideoThumbnail(safeName, localFullPath, peer.instanceId, lookupVideoThumbnail);
        });
        return;
      }
    }
  }

  const url = `${base}${urlPrefix}/${encodeURIComponent(safeName)}`;
  const buffer = await fetchCappedAssetBuffer(peer, url, safeName, ASSET_PULL_MAX_BYTES);
  if (!buffer) return;
  if (isStr(entry.sha256) && createHash('sha256').update(buffer).digest('hex') !== entry.sha256) {
    console.warn('⚠️ peerSync: discarded asset with mismatched sha256');
    return;
  }
  // Every pulled kind is media that ffmpeg may probe, thumbnail or render, and
  // ffmpeg opens a playlist or manifest by its bytes whatever the name says.
  const manifest = detectMediaManifest(buffer);
  if (manifest) {
    console.warn(`⚠️ peerSync: discarded ${entry.kind} asset whose bytes are a ${manifest} manifest`);
    return;
  }
  // The download stays outside the backup lease. Replacing the file, its sidecar
  // and poster, and the media_assets row that indexes them hold it together, so
  // a cut never captures a row for bytes it did not copy, or the reverse.
  await withBackupAssetPublication(() => commitPulledAsset(peer, base, entry, localDir, fullPath, safeName, buffer, includeMismatched, lookupVideoThumbnail));
}

async function commitPulledAsset(peer, base, entry, localDir, fullPath, safeName, buffer, includeMismatched, lookupVideoThumbnail) {
  await ensureDir(localDir);
  if (!includeMismatched && existsSync(fullPath)) return;
  const isNewHere = !existsSync(fullPath);
  // atomicWrite (temp + rename) so a crash mid-write doesn't leave a
  // half-written file that subsequent `diffAssetManifestAgainstLocal`
  // calls would see as "present" and stop re-requesting.
  await atomicWrite(fullPath, buffer);
  await finishPulledAsset(peer, base, entry, fullPath, safeName, buffer.length, isNewHere, lookupVideoThumbnail);
}

async function finishPulledAsset(peer, base, entry, fullPath, safeName, size, isNewHere, lookupVideoThumbnail) {
  peerSyncEvents.emit('asset-arrived', {
    filename: safeName,
    kind: entry.kind,
    peerId: peer.instanceId,
  });
  console.log(`📥 peerSync: pulled ${entry.kind}/${safeName} from ${peer.name || peer.instanceId} (${size} bytes)`);
  // After a successful image pull, also fetch the gen-params sidecar if present
  // on the sender. Best-effort: the image is already safely written above;
  // a missing sidecar just means the image lands in Unsorted without a prompt.
  if (entry.kind === 'image') {
    await pullSidecarForImage(peer, base, safeName).catch(() => {});
    // Even with no sidecar from the peer, record who supplied a copy new here:
    // its file time is then never mistaken for this machine making it.
    if (isNewHere) await recordImageSupplier(safeName, peer.instanceId).catch((err) => console.error(`❌ peerSync: supplier record for ${safeName} failed: ${err.message}`));
    // The owner restored an image deleted here (#14099): its copy outlives the delete.
    await clearImageTombstoneSupersededByOwner(safeName, peer.instanceId)
      .catch((err) => console.error(`❌ peerSync: delete record check for ${safeName} failed: ${err.message}`));
    await import('../mediaAssetIndex/index.js').then(m => m.indexImage({ filename: safeName })).catch(err => console.error(`❌ Media index peer asset refresh: ${err.message}`));
  }
  // After a video pull, regenerate the thumbnail LOCALLY rather than pulling it
  // as a sibling asset. Its own `asset-arrived` event lets a poster that already
  // 404'd leave MediaImage's "Syncing" placeholder without a remount.
  if (entry.kind === 'video') {
    await reconcileVideoThumbnail(safeName, fullPath, peer.instanceId, lookupVideoThumbnail);
  }
}

/** Pull only the three authored bible files; analysis snapshots never enter this path. */
export async function pullMissingWorkBibles(senderInstanceId, entries) {
  if (!isStr(senderInstanceId) || !Array.isArray(entries) || !entries.length) return;
  const peer = await findPeerById(senderInstanceId);
  if (!peer) return;
  const { workBiblePath, BIBLE_FILES, applyWorkBibleBytes } = await import('../writersRoom/bibleSync.js');
  for (const entry of entries) {
    if (!workBiblePath(entry?.workId, entry?.kind)) continue;
    const filename = `${BIBLE_FILES[entry.kind]}.json`;
    const key = `writers-room-bible:${entry.workId}:${entry.kind}`;
    // Destination queue serializes incoming peers; the apply step rechecks local LWW.
    await assetWriteQueue(key, async () => {
      const url = `${peerBaseUrl(peer)}/data/writers-room/works/${encodeURIComponent(entry.workId)}/${filename}`;
      const buffer = await fetchCappedAssetBuffer(peer, url, filename, WORK_BODY_PULL_MAX_BYTES);
      if (!buffer) return;
      const current = await getWorkForSync(entry.workId);
      if (!current || current.deleted || current.ephemeral) return;
      if (await withBackupAssetPublication(() => applyWorkBibleBytes(entry, buffer, { via: 'peer-sync', peerId: senderInstanceId }))) {
        peerSyncEvents.emit('asset-arrived', { filename, kind: 'writers-room-bible', workId: entry.workId, peerId: senderInstanceId });
      }
    }).catch((err) => console.error(`❌ peerSync: bible pull failed: ${err.message}`));
  }
}
