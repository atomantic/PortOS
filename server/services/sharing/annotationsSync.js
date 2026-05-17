/**
 * Outgoing annotation manifest writer. One file per (bucket, instance),
 * rewritten on a 2s debounce after any local annotation change. Inbox-mode
 * buckets are skipped (not a fit for constant pings). Per-bucket scoping: an
 * annotation is only written into a bucket that already has the underlying
 * asset, so a private note can't leak into an unrelated share.
 */

import { join } from 'path';
import { readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { ensureDir, atomicWrite, readJSONFile } from '../../lib/fileUtils.js';
import { listBuckets } from './buckets.js';
import { buildManifest, writeManifest, annotationManifestFilename } from './manifest.js';
import { getProducedByVersion } from './version.js';
import { getInstanceId } from '../instances.js';
import { resolveLocalAuthorName } from './annotationIdentity.js';
import { onLocalAnnotationChange, listLocalAuthorAnnotations } from '../mediaAnnotations.js';

const DEBOUNCE_MS = 2000;
let pendingTimer = null;
let installed = false;

async function listBucketAssetKeys(bucketPath) {
  const keys = new Set();
  for (const [subdir, kind] of [['images', 'image'], ['videos', 'video']]) {
    const dir = join(bucketPath, 'assets', subdir);
    if (!existsSync(dir)) continue;
    const files = await readdir(dir).catch(() => []);
    for (const f of files) {
      if (f.endsWith('.metadata.json')) continue;
      keys.add(`${kind}:${f}`);
    }
  }
  return keys;
}

async function exportAnnotationsToBucket(bucket, localAnnotations, senderInstanceId, sourceName) {
  if (bucket.mode !== 'auto-merge') return { skipped: true, reason: 'not-auto-merge' };
  const assetKeys = await listBucketAssetKeys(bucket.path);
  if (assetKeys.size === 0) return { skipped: true, reason: 'no-bucket-assets' };
  const filtered = {};
  for (const [key, entry] of Object.entries(localAnnotations)) {
    if (assetKeys.has(key)) filtered[key] = entry;
  }
  const recordDir = join(bucket.path, 'records', 'media-annotations');
  await ensureDir(recordDir);
  const recordId = senderInstanceId;
  const recordPath = join(recordDir, `${recordId}.json`);

  // Tombstone synthesis: peers only learn about deletions by seeing them. The
  // import-side merge (`mergePeerAnnotations`) iterates incoming keys and
  // treats `sanitizeAuthorEntry` returning null as "delete the peer's entry."
  // So we diff the previously-written record (for this bucket+instance) for
  // keys we used to publish but no longer do, and emit an explicit empty
  // tombstone for each. Without this, a local delete shows up as "the key is
  // simply absent from the next snapshot" — and peers retain the stale note
  // forever. Scoped per-bucket because each bucket's prior record is its own
  // file, so a key dropped from bucket A doesn't tombstone the same key on
  // bucket B (it may still be valid there).
  const tombstoneTs = new Date().toISOString();
  const prior = await readJSONFile(recordPath, null, { logError: false });
  const priorKeys = prior && prior.annotations && typeof prior.annotations === 'object'
    ? Object.keys(prior.annotations)
    : [];
  for (const key of priorKeys) {
    if (filtered[key]) continue;
    // Only tombstone keys whose assets are still in this bucket — pruning a
    // key whose asset has been removed from the bucket would tell peers to
    // delete the note even though they may still hold the asset.
    if (!assetKeys.has(key)) continue;
    filtered[key] = { starred: false, note: '', updatedAt: tombstoneTs };
  }

  const record = {
    id: recordId,
    instanceId: senderInstanceId,
    authorName: sourceName,
    updatedAt: tombstoneTs,
    annotations: filtered,
  };
  await atomicWrite(recordPath, record);
  const manifest = buildManifestForAnnotations({
    senderInstanceId,
    sourceName,
    bucket,
    recordId,
  });
  const filename = await writeManifest(bucket.path, manifest);
  return { skipped: false, filename, entryCount: Object.keys(filtered).length };
}

function buildManifestForAnnotations({ senderInstanceId, sourceName, bucket, recordId }) {
  return buildManifest({
    kind: 'media-annotations',
    senderInstanceId,
    source: sourceName,
    sourceBio: null,
    recordIds: [recordId],
    assetRefs: [],
    bucketId: bucket.id,
    bucketName: bucket.name,
    producedByVersion: getProducedByVersion(),
  });
}

async function flushAll() {
  // pendingTimer is already cleared by scheduleFlush's setTimeout callback.
  const [buckets, senderInstanceId, sourceName, localAnnotations] = await Promise.all([
    listBuckets().catch(() => []),
    getInstanceId().catch(() => null),
    resolveLocalAuthorName().catch(() => 'unknown'),
    listLocalAuthorAnnotations().catch(() => ({})),
  ]);
  if (!senderInstanceId || senderInstanceId === 'unknown') return;
  const autoMerge = buckets.filter((b) => b.mode === 'auto-merge');
  if (autoMerge.length === 0) return;
  await Promise.all(autoMerge.map(async (bucket) => {
    const res = await exportAnnotationsToBucket(bucket, localAnnotations, senderInstanceId, sourceName).catch((err) => {
      console.error(`⚠️ sharing.annotations: export to bucket=${bucket.name} failed: ${err.message}`);
      return null;
    });
    if (res && !res.skipped) {
      console.log(`📤 sharing.annotations: bucket=${bucket.name} wrote ${res.entryCount} annotation(s) (${res.filename})`);
    }
  }));
}

function scheduleFlush() {
  // True debounce: restart the timer on every call so a burst of rapid edits
  // collapses into one flush 2s after the LAST change. The previous
  // "if (pendingTimer) return" was a throttle — the first edit started the
  // timer and subsequent edits within the window were absorbed but the
  // flush still fired mid-burst (and the trailing edits then triggered
  // another flush a moment later).
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    flushAll().catch((err) => {
      console.error(`⚠️ sharing.annotations: flushAll failed: ${err.message}`);
    });
  }, DEBOUNCE_MS);
  pendingTimer.unref?.();
}

/** Install the local-annotation-change listener. Idempotent. Called once on boot. */
export function initAnnotationsSync() {
  if (installed) return;
  installed = true;
  onLocalAnnotationChange(() => scheduleFlush());
}
