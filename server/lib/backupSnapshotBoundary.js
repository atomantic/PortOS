import { maintenance } from './maintenanceAdmission.js';
import { backupSharedAdmission } from './backupSharedAdmission.js';
/**
 * Cross-process admission for durable file-plus-row publications during backup.
 * Callers hold one mutation lease across BOTH stores, not around individual
 * filesystem or SQL operations. The backup closes admission before rsync and
 * keeps it closed through the database dump and manifest write.
 *
 * Database maintenance shares the boundary. A cut is refused while a maintenance
 * fence is up, and maintenance that must not observe or replace a half-published
 * pair takes the same cut around its own destructive step. Publication itself
 * waits for a snapshot; unreadable ownership fails closed. Under a database
 * fence the database already rejects the row write.
 * Every retryable refusal carries BACKUP_SNAPSHOT_BUSY.
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
export async function withBackupAssetPublication(work, { timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS } = {}) {
  let started = false;
  return maintenance.continueSettlement(() => withAdmittedBackupAssetPublication(() => {
    started = true;
    return work();
  }, timeoutMs), { hasStarted: () => started });
}

function publicationTimeoutError() {
  let owner;
  try { owner = backupSharedAdmission.status().cut; }
  catch (error) { owner = { unreadable: true, error: error.message }; }
  return Object.assign(busyError(`Timed out waiting for backup publication admission${owner?.path ? ` at ${owner.path}` : ''}. No publication writes started. Reconcile the interrupted backup or restore before retiring its exact ownership record; do not remove it by age or PID.`), {
    owner, ...(owner?.path ? { recoveryPath: owner.path } : {}),
  });
}

async function waitForLocalCut(deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw publicationTimeoutError();
  await new Promise((resolve, reject) => {
    const clear = () => {
      clearTimeout(timer);
      publicationWaiters = publicationWaiters.filter(waiter => waiter !== resumed);
    };
    const resumed = () => { clear(); resolve(); };
    const timer = setTimeout(() => { clear(); reject(publicationTimeoutError()); }, remaining);
    publicationWaiters.push(resumed);
  });
}

function retainUncertainPublication(scope, error) {
  if (error?.backupPublicationUncertain !== true) return;
  scope.uncertain = true;
  // Diagnostic decoration is best effort; a frozen error cannot release authority.
  try {
    error.backupPublicationOwner = { ...scope.sharedLease.owner, path: scope.sharedLease.path };
    error.recoveryPath ??= scope.sharedLease.path;
  } catch { /* The durable owner remains the recovery authority. */ }
}

async function withAdmittedBackupAssetPublication(work, timeoutMs) {
  const scope = publicationScope.getStore();
  if (scope?.active) {
    try { return await work(); }
    catch (error) {
      retainUncertainPublication(scope, error);
      throw error;
    }
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new TypeError('Publication timeoutMs must be a non-negative finite number');
  const deadline = Date.now() + timeoutMs;
  // Work spawned by a still-admitted lease joins it: the cut already waits for that lease.
  const joinsAdmitted = scope?.spawnedBy?.active === true;
  while (!joinsAdmitted && (cutRequested || cutActive)) {
    await waitForLocalCut(deadline);
  }
  let sharedLease;
  while (!(sharedLease = backupSharedAdmission.tryPublication({ parent: joinsAdmitted ? scope.spawnedBy.sharedLease : null }))) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw publicationTimeoutError();
    await new Promise(resolve => setTimeout(resolve, Math.min(25, remaining)));
  }
  admitted += 1;
  const lease = { active: true, sharedLease };
  try {
    return await publicationScope.run(lease, work);
  } catch (error) {
    retainUncertainPublication(lease, error);
    throw error;
  } finally {
    lease.active = false;
    try {
      if (lease.uncertain) {
        // The owner was already durable before work started. A diagnostic
        // marker failure must never release that existing recovery blocker.
        try { sharedLease.markUncertain(); }
        catch (error) { console.error(`❌ Backup publication recovery marker failed at ${sharedLease.path}: ${error.message}`); }
      } else sharedLease.release();
    } finally {
      // Settled local callbacks no longer count as running. The retained
      // shared owner supplies concrete diagnostics to the next refused cut.
      admitted -= 1;
      if (admitted === 0) {
        const waiters = drainWaiters;
        drainWaiters = [];
        for (const resolve of waiters) resolve();
      }
    }
  }
}

/**
 * Whether the caller runs inside an active admission lease, so no cut can be
 * active until its work settles. A listener scope created by
 * runOutsideBackupAssetPublication is not a lease of its own.
 */
export function holdsBackupAssetPublication() {
  return publicationScope.getStore()?.active === true;
}

/** Read-only ownership evidence for interrupted-publication recovery. */
export function backupPublicationAdmissionStatus() {
  return backupSharedAdmission.status();
}

/**
 * Whether a backup cut is requested or active. Optional housekeeping that would
 * otherwise wait out the whole snapshot can defer to its next pass instead.
 */
export function backupSnapshotCutPending() {
  return cutRequested || cutActive || backupSharedAdmission.cutPending();
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
  const sharedCut = backupSharedAdmission.reserveCut();
  cutRequested = true;
  const deadline = Date.now() + timeoutMs;
  try {
    if (admitted > 0) await awaitDrain(timeoutMs);
    let blockers;
    while ((blockers = backupSharedAdmission.publications()).length > 0) {
      if (Date.now() >= deadline) throw Object.assign(busyError('Timed out draining asset publications for backup. Reconcile interrupted publications before retrying; ownership records must not be removed by age or PID.'), { blockers });
      await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
    }
    assertDatabaseAdmission();
  } catch (error) {
    sharedCut.release();
    cutRequested = false;
    releasePublications();
    throw error;
  }
  cutActive = true;
  cutRequested = false;
  let released = false;
  return () => {
    if (released) return;
    sharedCut.release();
    released = true;
    cutActive = false;
    releasePublications();
  };
}
