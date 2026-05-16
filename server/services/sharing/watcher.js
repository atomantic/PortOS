/**
 * Share Bucket — chokidar watcher on each bucket's `manifests/` and `assets/`
 * directories.
 *
 * When a peer's cloud-sync app drops a new manifest into the shared folder,
 * chokidar fires `add` and we ingest it via importer.processManifest. When
 * asset files arrive after the manifest, we rescan the backlog so pending
 * manifests can finish. Mirrors the pattern in server/services/taskWatcher.js
 * — persistent + ignoreInitial + awaitWriteFinish so we don't pick up the file
 * mid-write.
 *
 * Per-bucket watchers are kept in a map keyed by bucket id so a bucket
 * registration / removal can attach / detach individually without restarting
 * everything.
 */

import { watch } from 'chokidar';
import { join, basename } from 'path';
import { processManifest, processBacklog, handleUnshare, sharingEvents } from './importer.js';
import { getBucket, listBuckets, ensureBucketLayout } from './buckets.js';
import { isManifestPruning, pruneBucketManifests } from './manifest.js';
import { getInstanceId } from '../instances.js';

const watchers = new Map(); // bucketId → chokidar instance
const backlogQueues = new Map(); // bucketId → { running: Promise, queued: Promise|null }

/**
 * Coalesce backlog-scan requests per bucket. A flood of records/ or assets/
 * events from cloud sync (e.g. 32 issue JSONs landing in quick succession)
 * should collapse to at most one in-flight scan + one queued follow-up, not
 * N sequential rescans. While a scan is running, any subsequent request
 * shares the same queued follow-up so all events get exactly one observation.
 */
function queueBacklog(bucketId) {
  const slot = backlogQueues.get(bucketId);
  if (slot?.queued) return slot.queued;
  const runScan = () => processBacklog(bucketId).catch((err) => {
    console.error(`❌ sharing.watcher: backlog process failed bucket=${bucketId}: ${err?.message || err}`);
  });
  if (!slot) {
    const running = runScan().finally(() => {
      const live = backlogQueues.get(bucketId);
      if (live && live.running === running) backlogQueues.delete(bucketId);
    });
    backlogQueues.set(bucketId, { running, queued: null });
    return running;
  }
  const queued = slot.running.then(runScan).finally(() => {
    const live = backlogQueues.get(bucketId);
    if (live && live.queued === queued) backlogQueues.delete(bucketId);
  });
  slot.queued = queued;
  return queued;
}

export async function attachWatcher(bucketId) {
  const existing = watchers.get(bucketId);
  if (existing) {
    await existing.close().catch(() => {});
  }
  const bucket = await getBucket(bucketId);
  await ensureBucketLayout(bucket);
  const manifestsDir = join(bucket.path, 'manifests');
  const assetsDir = join(bucket.path, 'assets');
  // Records sync at the same lag as assets — Drive may deliver the small
  // manifest before the larger record JSONs. Watch the dir so a late-arriving
  // record file re-triggers backlog and the importer can retry the manifest.
  const recordsDir = join(bucket.path, 'records');
  const w = watch([manifestsDir, assetsDir, recordsDir], {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  });

  // A path under assets/ or records/ is bundle-side sync we should retry on,
  // not a manifest to process. Manifests live in manifests/ (always *.json).
  const isBundleSync = (p) => p.includes(`${assetsDir}/`) || p.includes(`${recordsDir}/`);

  // try/catch around async event handlers — see CLAUDE.md "PTY/child-process
  // /setTimeout/setInterval callbacks" rule (chokidar events fire outside the
  // request lifecycle, no Express middleware to bubble the throw to).
  w.on('add', async (path) => {
    if (isBundleSync(path)) { await queueBacklog(bucketId); return; }
    const file = basename(path);
    if (!file.endsWith('.json')) return;
    try {
      await processManifest(bucketId, file);
    } catch (err) {
      console.error(`❌ sharing.watcher: processManifest threw for ${file}: ${err?.message || err}`);
    }
  });
  w.on('change', async (path) => {
    if (isBundleSync(path)) { await queueBacklog(bucketId); return; }
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
  w.on('unlink', async (path) => {
    // Only manifest deletions are unshare signals. Record/asset unlinks are
    // expected during cloud-sync churn and not actionable here.
    if (!path.includes(`${manifestsDir}/`)) return;
    const file = basename(path);
    if (!file.endsWith('.json')) return;
    // Our own pruner moves stale manifests into `<bucket>/.archive/manifests/`;
    // skip the resulting unlink so we don't reset our cursor or emit a
    // misleading "peer unshared" socket event for an archive we initiated.
    if (isManifestPruning(bucketId, file)) return;
    try {
      await handleUnshare(bucketId, file);
    } catch (err) {
      console.error(`❌ sharing.watcher: handleUnshare threw for ${file}: ${err?.message || err}`);
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
  const localInstanceId = await getInstanceId().catch(() => null);
  for (const b of buckets) {
    await attachWatcher(b.id).catch((err) => {
      console.error(`❌ sharing.watcher: failed to attach bucket=${b.name}: ${err.message}`);
    });
    // Catch up on any manifests that arrived while we were offline.
    await processBacklog(b.id).catch((err) => {
      console.error(`❌ sharing.watcher: backlog process failed bucket=${b.name}: ${err.message}`);
    });
    // One-shot prune on boot: handles long-lived buckets where this instance
    // rarely exports (post-export prune wouldn't fire often enough).
    if (localInstanceId) {
      await pruneBucketManifests(b, { localInstanceId }).catch((err) => {
        console.error(`❌ sharing.watcher: prune failed bucket=${b.name}: ${err.message}`);
      });
    }
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
