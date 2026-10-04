/**
 * Process-local admission for durable file-plus-row publications during backup.
 * Callers hold one mutation lease across BOTH stores, not around individual
 * filesystem or SQL operations. The backup closes admission before rsync and
 * keeps it closed through the database dump and manifest write.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const publicationScope = new AsyncLocalStorage();
const DEFAULT_DRAIN_TIMEOUT_MS = 120_000;
let admitted = 0;
let cutRequested = false;
let cutActive = false;
let drainWaiters = [];
let publicationWaiters = [];

function releasePublications() {
  const waiters = publicationWaiters;
  publicationWaiters = [];
  for (const resolve of waiters) resolve();
}

/** Hold one admission across an entire file-plus-row workflow. Nested calls reuse it. */
export async function withBackupAssetPublication(work) {
  const scope = publicationScope.getStore();
  if (scope?.active) return work();
  // Work spawned by a still-admitted lease joins it: the cut already waits for that lease.
  const joinsAdmitted = scope?.spawnedBy?.active === true;
  while (!joinsAdmitted && (cutRequested || cutActive)) {
    await new Promise(resolve => publicationWaiters.push(resolve));
  }
  admitted += 1;
  const lease = { active: true };
  try {
    return await publicationScope.run(lease, work);
  } finally {
    lease.active = false;
    admitted -= 1;
    if (admitted === 0) {
      const waiters = drainWaiters;
      drainWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }
}

/**
 * Run a synchronous fan-out (an event emit) so each listener acquires its OWN
 * lease while the caller's lease is still held, even if a cut is already
 * waiting to drain. A listener reusing the caller's lease would continue
 * unadmitted once the caller finished and could land mid-cut; one queued behind
 * the cut would leave the caller's publication half drained. Listeners must
 * call withBackupAssetPublication before their first await, and the caller must
 * not await them.
 */
export function runOutsideBackupAssetPublication(work) {
  return publicationScope.run({ active: false, spawnedBy: publicationScope.getStore() }, work);
}

/**
 * Close admission and drain already admitted workflows before copying files.
 * The returned release function owns only this cut. A timed-out drain reopens
 * admission and rejects, so runBackup marks its incomplete snapshot failed.
 */
export async function acquireBackupSnapshotCut({ timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS } = {}) {
  // A cut requested from inside an admitted workflow would wait on itself for the whole timeout.
  if (publicationScope.getStore()?.active) throw new Error('Backup snapshot cut cannot be acquired inside an asset publication');
  if (cutRequested || cutActive) throw new Error('Backup snapshot cut already owned');
  cutRequested = true;
  if (admitted > 0) {
    let timer;
    let onDrained;
    try {
      await Promise.race([
        new Promise(resolve => {
          onDrained = resolve;
          drainWaiters.push(resolve);
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Timed out draining asset publications for backup')), timeoutMs);
          timer.unref?.();
        }),
      ]);
    } catch (error) {
      cutRequested = false;
      releasePublications();
      throw error;
    } finally {
      clearTimeout(timer);
      drainWaiters = drainWaiters.filter(resolve => resolve !== onDrained);
    }
  }
  cutActive = true;
  cutRequested = false;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    cutActive = false;
    releasePublications();
  };
}
