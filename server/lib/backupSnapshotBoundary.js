/**
 * Process-local admission for durable file-plus-row publications during backup.
 * Callers hold one mutation lease across BOTH stores, not around individual
 * filesystem or SQL operations. The backup closes admission before rsync and
 * keeps it closed through the database dump and manifest write.
 *
 * Database maintenance shares the boundary. A maintenance fence refuses a NEW
 * publication or cut before either store changes, and maintenance that must not
 * observe or replace a half-published pair takes the same cut around its own
 * destructive step. Every refusal that is retryable carries BACKUP_SNAPSHOT_BUSY.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { assertDatabaseAdmission } from './databaseMaintenanceJournal.js';

const publicationScope = new AsyncLocalStorage();
const DEFAULT_DRAIN_TIMEOUT_MS = 120_000;
let admitted = 0;
let cutRequested = false;
let cutActive = false;
let drainWaiters = [];
let publicationWaiters = [];

const busyError = message => Object.assign(new Error(message), { status: 503, code: 'BACKUP_SNAPSHOT_BUSY' });

function releasePublications() {
  const waiters = publicationWaiters;
  publicationWaiters = [];
  for (const resolve of waiters) resolve();
}

/** Hold one admission across an entire file-plus-row workflow. Nested calls reuse it. */
export async function withBackupAssetPublication(work) {
  const scope = publicationScope.getStore();
  if (scope?.active) return work();
  // A maintenance fence would fail the row write after the file was published.
  // Refuse before either store changes, and again once a cut has been waited out.
  assertDatabaseAdmission();
  // Work spawned by a still-admitted lease joins it: the cut already waits for that lease.
  const joinsAdmitted = scope?.spawnedBy?.active === true;
  while (!joinsAdmitted && (cutRequested || cutActive)) {
    await new Promise(resolve => publicationWaiters.push(resolve));
    assertDatabaseAdmission();
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

/** Wait for already admitted workflows to settle, or reject when they do not. */
async function awaitDrain(timeoutMs) {
  let timer;
  let onDrained;
  try {
    await Promise.race([
      new Promise(resolve => {
        onDrained = resolve;
        drainWaiters.push(resolve);
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(busyError('Timed out draining asset publications for backup')), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
    drainWaiters = drainWaiters.filter(resolve => resolve !== onDrained);
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
 * Close admission and drain already admitted workflows before the caller reads
 * or replaces both stores. The returned release function owns only this cut. A
 * failed drain (timeout, or a maintenance fence that closed meanwhile) reopens
 * admission and rejects: runBackup then marks its incomplete snapshot failed,
 * and maintenance acceptance refuses before publishing its fence.
 */
export async function acquireBackupSnapshotCut({ timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS } = {}) {
  // A cut requested from inside an admitted workflow would wait on itself for the whole timeout.
  if (publicationScope.getStore()?.active) throw new Error('Backup snapshot cut cannot be acquired inside an asset publication');
  if (cutRequested || cutActive) throw busyError('Backup snapshot cut already owned');
  assertDatabaseAdmission();
  cutRequested = true;
  try {
    if (admitted > 0) await awaitDrain(timeoutMs);
    assertDatabaseAdmission();
  } catch (error) {
    cutRequested = false;
    releasePublications();
    throw error;
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
