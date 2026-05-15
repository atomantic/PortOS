/**
 * Share Bucket — chokidar watcher on each bucket's `manifests/` directory.
 *
 * When a peer's cloud-sync app drops a new manifest into the shared folder,
 * chokidar fires `add` and we ingest it via importer.processManifest. Mirrors
 * the pattern in server/services/taskWatcher.js — persistent + ignoreInitial
 * + awaitWriteFinish so we don't pick up the file mid-write.
 *
 * Per-bucket watchers are kept in a map keyed by bucket id so a bucket
 * registration / removal can attach / detach individually without restarting
 * everything.
 */

import { watch } from 'chokidar';
import { join, basename } from 'path';
import { processManifest, processBacklog, sharingEvents } from './importer.js';
import { getBucket, listBuckets, ensureBucketLayout } from './buckets.js';

const watchers = new Map(); // bucketId → chokidar instance

export async function attachWatcher(bucketId) {
  const existing = watchers.get(bucketId);
  if (existing) {
    await existing.close().catch(() => {});
  }
  const bucket = await getBucket(bucketId);
  await ensureBucketLayout(bucket);
  const manifestsDir = join(bucket.path, 'manifests');
  const w = watch(manifestsDir, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  });

  // try/catch around async event handlers — see CLAUDE.md "PTY/child-process
  // /setTimeout/setInterval callbacks" rule (chokidar events fire outside the
  // request lifecycle, no Express middleware to bubble the throw to).
  w.on('add', async (path) => {
    const file = basename(path);
    if (!file.endsWith('.json')) return;
    try {
      await processManifest(bucketId, file);
    } catch (err) {
      console.error(`❌ sharing.watcher: processManifest threw for ${file}: ${err?.message || err}`);
    }
  });
  w.on('change', async (path) => {
    // A manifest *changing* after first write is unusual (atomicWrite
    // produces a stable file), but it can happen if a peer's sync app
    // does a delete-then-write. Re-process — cursor will dedup.
    const file = basename(path);
    if (!file.endsWith('.json')) return;
    try {
      await processManifest(bucketId, file);
    } catch (err) {
      console.error(`❌ sharing.watcher: processManifest threw on change ${file}: ${err?.message || err}`);
    }
  });
  w.on('error', (err) => {
    console.error(`❌ sharing.watcher: bucket=${bucket.name} ${err?.message || err}`);
  });
  watchers.set(bucketId, w);
  sharingEvents.emit('watcher-attached', { bucketId, manifestsDir });
  console.log(`👁️  sharing.watcher: attached bucket=${bucket.name} path=${manifestsDir}`);
  return w;
}

export async function detachWatcher(bucketId) {
  const w = watchers.get(bucketId);
  if (!w) return;
  await w.close().catch(() => {});
  watchers.delete(bucketId);
  sharingEvents.emit('watcher-detached', { bucketId });
}

export async function attachAllWatchers() {
  const buckets = await listBuckets();
  for (const b of buckets) {
    await attachWatcher(b.id).catch((err) => {
      console.error(`❌ sharing.watcher: failed to attach bucket=${b.name}: ${err.message}`);
    });
    // Catch up on any manifests that arrived while we were offline.
    await processBacklog(b.id).catch((err) => {
      console.error(`❌ sharing.watcher: backlog process failed bucket=${b.name}: ${err.message}`);
    });
  }
  return { attached: watchers.size };
}

export async function shutdownAllWatchers() {
  const ids = [...watchers.keys()];
  for (const id of ids) {
    await detachWatcher(id).catch(() => {});
  }
}

export function listAttachedWatchers() {
  return [...watchers.keys()];
}
