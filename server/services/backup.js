/**
 * Backup Service
 *
 * Rsync-based incremental backup from ./data/ to an external drive.
 * Generates SHA-256 manifests for integrity verification.
 * Integrates with eventScheduler for daily cron scheduling.
 *
 * This module owns the backup run, the database dump, manifest generation and
 * the persisted backup state, and re-exports the rest of the public API from
 * `./backup/`: exclude policy (`excludes.js`), rsync supervision
 * (`rsync.js`), snapshot markers/leases/inventory (`snapshots.js`), file
 * restore (`restore.js`) and database restore (`dbRestore.js`). Callers keep
 * importing this module; submodules never import it.
 */

import { dashboardEvents } from './dashboardEvents.js';
import { spawn } from '../lib/childProcess.js';
import { access, lstat, mkdir, readdir, stat, unlink, writeFile } from 'fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'path';
import { PATHS, ensureDir, readJSONFile, atomicWrite, sha256File } from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { acquireBackupSnapshotCut } from '../lib/backupSnapshotBoundary.js';
import { backupAssetConsistency } from '../lib/backupAssetOwners.js';
import { assertDatabaseAdmission } from '../lib/databaseMaintenanceJournal.js';
import { getEvent } from './eventScheduler.js';
import { POOL_CONFIG, checkHealth, getServerMajorVersion } from '../lib/db.js';
import { withPgToolEnv, resolvePgDumpBinary } from '../lib/pgTools.js';
import { inspectDatabaseDump, SNAPSHOT_PG_DUMP_FLAGS } from './backupDatabaseDump.js';
import { emitErrorEvent, ServerError } from '../lib/errorHandler.js';
import { noteSystemActivity } from './systemActivityNotify.js';
import { maintenance } from '../lib/maintenanceAdmission.js';
import { settleAdmissionEventually } from '../lib/maintenanceSettlementRetry.js';
import { computeEffectiveExcludes, isOsMetadataFile } from './backup/excludes.js';
import {
  BACKUP_PROCESS_START_ID, MACHINE_HOST, failedMarkerPath, legacyDbMetadataDomains, legacyDbMetadataMessage,
  markInterruptedSnapshotsFailed, markerPath, missingDumpParts, parentMarkerPath, pruneOldSnapshots,
  setActiveSnapshotId, usesFileEscapeHatch,
} from './backup/snapshots.js';
import { runRsync, watchBackupProcess } from './backup/rsync.js';

export { DEFAULT_EXCLUDES, computeEffectiveExcludes } from './backup/excludes.js';
export { resolveRsyncBinary } from './backup/rsync.js';
export { listSnapshots, deleteSnapshot, openSnapshotStream } from './backup/snapshots.js';
export { restoreSnapshot } from './backup/restore.js';
export { restorePostgres } from './backup/dbRestore.js';

// Module-level state
let isRunning = false;
let failedStateProjection = null;

// The in-process lock is the activity signal the updater reads. Note the edge
// in the same assignment so a client cannot keep a stale "backup running"
// verdict after the lock drops, or miss one that just started. There is no
// cancel path: a failed run releases the lock as `failure`.
function setBackupRunning(running, phase) {
  isRunning = running;
  noteSystemActivity('backup', phase);
}

const STATE_PATH = join(PATHS.data, 'backup', 'state.json');

// Serialize state read-merge-write so two saveState() calls (e.g. a run
// completing while the scheduler stamps a status) can't each read the same
// pre-image and clobber the other's fields. Single tail per shared state file.
const queueStateWrite = createFileWriteQueue();

const DEFAULT_STATE = {
  lastRun: null,
  lastSuccessfulRun: null,
  status: 'never',
  lastSnapshotId: null,
  filesChanged: 0,
  pgBackup: null,
  restoreWarning: null,
  error: null
};

/**
 * Map a dumpPostgres result to the overall backup status. Only a *failed*
 * dump (PG configured but the dump errored) degrades the backup; a *skipped*
 * dump (no PG — file mode) is benign and stays 'ok'.
 * @param {{status: string}} pgResult
 * @returns {'ok'|'degraded'}
 */
export function backupStatusForPg(pgResult) {
  return pgResult?.status === 'failed' ? 'degraded' : 'ok';
}

/**
 * Run a full backup snapshot from PATHS.data to destPath.
 * @param {string} destPath - Path to external drive backup root
 * @param {object|null} io - Socket.IO instance for real-time events (optional)
 */
export async function runBackup(destPath, io = null, { excludePaths = [], disabledDefaultExcludes = [], retentionCount = null } = {}) {
  if (isRunning) {
    console.log('💾 Backup already running — skipping');
    return { skipped: true };
  }

  if (!destPath) {
    throw new Error('Backup destination not configured');
  }

  const permit = maintenance.admit('backup', 'snapshot');
  try {
    return await permit.run(() => runAdmittedBackup(destPath, io, { excludePaths, disabledDefaultExcludes, retentionCount }, permit));
  } finally { await settleAdmissionEventually(permit, 'Backup'); }
}

async function runAdmittedBackup(destPath, io, { excludePaths, disabledDefaultExcludes, retentionCount }, permit) {

  setBackupRunning(true, 'start');
  let snapshotId = null;
  let snapshotDir;
  let parentMarker;

  const effectiveExcludes = computeEffectiveExcludes({ excludePaths, disabledDefaultExcludes });

  let changedFiles = [];
  let manifest;
  let previousState;

  const removeMarker = (path, marker) => unlink(path).catch(cause => {
    if (cause.code === 'ENOENT') return;
    // Raw filesystem errors can contain the private backup destination.
    const code = ['EACCES', 'EPERM', 'EIO', 'ENOSPC', 'EROFS', 'ENOTDIR', 'EMFILE', 'ENFILE', 'EBUSY'].includes(cause.code) ? cause.code : 'UNKNOWN';
    console.error(`❌ Backup snapshot finalization failed: snapshot=${snapshotId} marker=${marker} code=${code}`);
    throw new ServerError(`Backup snapshot finalization failed (${marker} marker, ${code})`, {
      code: 'BACKUP_SNAPSHOT_FINALIZATION_FAILED',
    });
  });

  const clearInProgressMarkers = async () => {
    if (snapshotDir) await removeMarker(markerPath(snapshotDir), 'snapshot');
    if (parentMarker) await removeMarker(parentMarker, 'reservation');
  };

  const releaseActiveSnapshot = () => {
    setActiveSnapshotId(null);
  };

  const complete = (result) => {
    releaseActiveSnapshot();
    setBackupRunning(false, 'completion');
    return result;
  };

  const fail = async (err) => {
    // Persist failure BEFORE removing the incomplete guards. If the marker
    // cannot be written, retain those guards so a partial tree never becomes a
    // restore source. The process lock is independent and is always released.
    const failureRecorded = snapshotDir
      ? await writeFile(failedMarkerPath(snapshotDir), '').then(() => true, () => false)
      : false;
    // Cleanup errors are already logged by removeMarker. The durable failure
    // marker blocks restore even if cleanup fails; always release the run lock.
    if (failureRecorded) await clearInProgressMarkers().catch(() => {});
    releaseActiveSnapshot();
    setBackupRunning(false, 'failure');
    const failureState = {
      lastRun: new Date().toISOString(), status: 'error', error: err.message, pgBackup: null, restoreWarning: null,
      ...(previousState ?? {}),
    };
    await saveState(failureState, (cause) => {
      const code = ['EACCES', 'EPERM', 'EIO', 'ENOSPC', 'EROFS', 'ENOENT', 'EMFILE', 'ENFILE'].includes(cause.code) ? cause.code : 'UNKNOWN';
      failedStateProjection = { ...failureState, error: `Backup failed; status persistence failed (${code}). See server logs.` };
      console.error(`❌ Backup status persistence failed: transition=error snapshot=${snapshotId ?? 'none'} code=${code}`);
    });
    dashboardEvents.emit('backup:changed');
    if (io) io.emit('backup:failed', { snapshotId, error: err.message });
    throw err;
  };

  try {
    // Refuse before reserving a snapshot while database maintenance is fenced;
    // the cut below repeats this check after it drains.
    assertDatabaseAdmission();
    await access(destPath).catch((cause) => {
      // Never expose the filesystem message: it can include private paths.
      const code = ['ENOENT', 'EACCES', 'EPERM', 'EIO'].includes(cause.code) ? cause.code : 'UNKNOWN';
      const message = code === 'ENOENT' ? 'Backup destination not found' : 'Backup destination inaccessible';
      const error = new ServerError(`${message} (${code})`, { code: `BACKUP_DESTINATION_${code}` });
      error.cause = cause;
      throw error;
    });
    const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
    const snapshotsRoot = join(destPath, 'snapshots', MACHINE_HOST);
    await ensureDir(snapshotsRoot);
    // Inside the single-run guard, so no run of this process can own a marker
    // the sweep is converging.
    await markInterruptedSnapshotsFailed(snapshotsRoot).catch(err => {
      console.error(`❌ Backup interrupted-snapshot sweep failed: code=${err?.code ?? 'UNKNOWN'}`);
    });
    // Own the durable guard before exposing a directory. Never adopt an
    // existing tree, even when its timestamp matches this run's clock.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const candidateId = attempt === 0 ? timestamp : `${timestamp}-${randomUUID()}`;
      const candidateDir = join(snapshotsRoot, candidateId);
      const candidateMarker = parentMarkerPath(candidateDir, candidateId);
      const exists = await lstat(candidateDir).then(() => true, err => {
        if (err.code === 'ENOENT') return false;
        throw err;
      });
      if (exists) continue;
      const reserved = await writeFile(candidateMarker, BACKUP_PROCESS_START_ID, { flag: 'wx' }).then(() => true, err => {
        if (err.code === 'EEXIST') return false;
        throw err;
      });
      if (!reserved) continue;
      const created = await mkdir(candidateDir).then(() => true, async err => {
        // Only our exclusive reservation can be released here. The directory
        // may belong to a competing writer and must remain untouched.
        await unlink(candidateMarker);
        if (err.code === 'EEXIST') return false;
        throw err;
      });
      if (!created) continue;
      snapshotId = candidateId;
      snapshotDir = candidateDir;
      parentMarker = candidateMarker;
      break;
    }
    if (!snapshotDir) throw new Error('Unable to reserve a fresh backup snapshot');
    // Both rsync and pg_dump carry this snapshot ID in their argv. Record it
    // before either process can start, including for external destinations.
    permit.identify(snapshotId);
    const dataDestDir = join(snapshotDir, 'data');

    console.log(`💾 Backup starting: snapshot ${snapshotId} (excluding ${effectiveExcludes.length} paths)`);
    if (io) io.emit('backup:started', { snapshotId });
    await ensureDir(dataDestDir);
    setActiveSnapshotId(snapshotId);
    await writeFile(markerPath(snapshotDir), BACKUP_PROCESS_START_ID);
    dashboardEvents.emit('backup:changed');

    // Freeze admitted file-plus-row publications across both stores. A writer
    // that started first drains completely; new writers wait until the dump
    // and manifest are published. Rendering/provider work is outside admission.
    const releaseSnapshotCut = await acquireBackupSnapshotCut();
    // The snapshot records how far that guarantee reaches: `global` only once
    // no durable asset owner remains outside admission.
    const assetConsistency = { ...backupAssetConsistency(), reclaimedLeases: releaseSnapshotCut.reclaimedLeases ?? 0 };
    let pgResult;
    let restoreWarning = null;
    try {
      const { flushPendingUsageWrites } = await import('./usage.js');
      await flushPendingUsageWrites().catch(() => {
        throw new ServerError('Usage ledger could not be saved for this backup', { code: 'BACKUP_USAGE_FLUSH_FAILED' });
      });
      const excludeFlags = effectiveExcludes.flatMap(p => ['--exclude', p]);
      changedFiles = await runRsync(PATHS.data, dataDestDir, excludeFlags, { allowVanishedSources: true });
      console.log(`💾 Backup rsync complete: ${changedFiles.length} files changed (exit 0)`);

      // A configured-but-failed dump degrades the backup and alerts the user.
      const pgDumpPath = join(snapshotDir, 'portos-db.sql');
      pgResult = await dumpPostgres(pgDumpPath);
      manifest = await generateManifest(dataDestDir, join(snapshotDir, 'manifest.json'), pgDumpPath, {
        allowMissingDump: pgResult.status === 'skipped' || pgResult.status === 'failed',
        assetConsistency,
      });
      if (!usesFileEscapeHatch()) {
        const domains = await legacyDbMetadataDomains(dataDestDir, Object.keys(manifest.files));
        if (domains.length) {
          restoreWarning = { code: 'BACKUP_LEGACY_DB_METADATA', domains, message: legacyDbMetadataMessage(domains) };
        }
      }
    } finally {
      releaseSnapshotCut();
    }

    // A backup is not complete while its durable guards still block restore.
    // Keep the reservation guard until success is persisted: if both the
    // status write and failure-marker write fail, it must survive a restart.
    await removeMarker(failedMarkerPath(snapshotDir), 'failed');
    await removeMarker(markerPath(snapshotDir), 'snapshot');

    const status = restoreWarning ? 'degraded' : backupStatusForPg(pgResult);
    const error = [pgResult.status === 'failed' ? `DB dump ${pgResult.reason}` : null, restoreWarning?.message]
      .filter(Boolean).join(' ') || null;
    const lastRun = new Date().toISOString();
    // Read durable status: getState() projects this attempt as running.
    const state = await readJSONFile(STATE_PATH, DEFAULT_STATE, { strict: true });
    previousState = {
      lastSnapshotId: state.lastSnapshotId,
      lastSuccessfulRun: Object.hasOwn(state, 'lastSuccessfulRun')
        ? state.lastSuccessfulRun : (state.status === 'ok' ? state.lastRun : null),
    };
    await saveState({
      lastRun,
      lastSnapshotId: snapshotId,
      status,
      filesChanged: changedFiles.length,
      pgBackup: pgResult,
      assetConsistency,
      restoreWarning,
      error
    });

    await removeMarker(parentMarker, 'reservation');
    // A crash before the reservation clears must still leave the slot due.
    if (status === 'ok') await saveState({ lastSuccessfulRun: lastRun });

    if (io) io.emit('backup:completed', { snapshotId, filesChanged: changedFiles.length, status, pgBackup: pgResult, restoreWarning, error });

    // Loud-on-failure: surface a degraded DB dump as a warning toast, even on
    // unattended scheduled runs (which pass io=null) via the module-level io.
    if (pgResult.status === 'failed') {
      // Keep socket/auth initialization out of backup metadata reads and tests.
      const errIo = io || (await import('./socketIo.js')).getIo();
      if (errIo) {
        emitErrorEvent(errIo, new ServerError(
          `Backup DB dump failed: ${pgResult.reason}`,
          { status: 500, code: 'BACKUP_DB_DUMP_FAILED', severity: 'warning' }
        ));
      }
    }

    const result = complete({ snapshotId, filesChanged: changedFiles.length, status, lastRun, manifest, pgBackup: pgResult, assetConsistency, restoreWarning, error });

    // Prune only after the snapshot markers are cleared and `complete()` has
    // released `activeSnapshotId` — pruning any
    // earlier would make the run's OWN fresh snapshot read as incomplete
    // (via `snapshotState`) and drop out of the retention count entirely,
    // silently keeping one snapshot MORE than configured. A run that throws
    // before this point takes the `fail()` path below and never reaches
    // here, so this run's own snapshot is never pruned as failed or in-progress.
    // Retention failures must not fail an otherwise-successful backup.
    let pruned = { pruned: 0 };
    if (status === 'degraded') {
      console.log('💾 Backup retention skipped: degraded snapshot — keeping older snapshots');
    } else {
      pruned = await pruneOldSnapshots(destPath, retentionCount).catch(err => {
        console.error(`❌ Backup retention prune failed: ${err.message}`);
        return { pruned: 0 };
      });
    }

    dashboardEvents.emit('backup:changed');
    return { ...result, prunedSnapshots: pruned.pruned };
  } catch (err) {
    return fail(err);
  }
}

/**
 * Run pg_dump to create a PostgreSQL backup alongside the rsync snapshot.
 * Returns an explicit status so the caller can distinguish the benign file
 * escape hatch from "PG required but dump failed" (data at risk):
 *   { status: 'ok', sizeBytes, tableCount }
 *   { status: 'skipped', reason: 'not_configured' }   (explicit file escape hatch only)
 *   { status: 'failed', reason: 'pg_unreachable'|'pg_dump_missing'|'version_mismatch'|'dump_error'|'empty_dump'|'inspect_error'|'dump_incomplete'|'timeout', error }
 *     (pg_unreachable fires whenever Postgres is required — i.e. not the file
 *      escape hatch — but the DB is down at backup time; version_mismatch means
 *      no installed pg_dump is new enough for the running server)
 * @param {string} outputPath - Path to write the SQL dump file
 */
export async function dumpPostgres(outputPath) {
  const health = await checkHealth();
  if (!health.connected || !health.hasSchema) {
    // PG unreachable or uninitialized. Since PostgreSQL is now a mandatory
    // dependency, the ONLY benign "no PG to back up" case is the explicit file
    // escape hatch (MEMORY_BACKEND=file, or the backend resolved to 'file' in
    // test/dev mode). Every other state — including a default install whose
    // memory backend simply hasn't initialized yet (getBackendName() === null)
    // — means Postgres is required, so an unreachable DB is a real backup
    // failure (data that lives only in PG won't be captured). Degrade and alert
    // rather than silently skip; gating on getBackendName() === 'postgres'
    // alone would let an outage-before-first-memory-access read as a green
    // "not configured" run.
    if (!usesFileEscapeHatch()) {
      return { status: 'failed', reason: 'pg_unreachable', error: health.error || 'PostgreSQL is required but is unreachable or uninitialized' };
    }
    return { status: 'skipped', reason: 'not_configured' };
  }

  const { host: pgHost, port, database: pgDb, user: pgUser } = POOL_CONFIG;
  const pgPort = String(port);

  // pg_dump must be >= the server's major version or it aborts on a "server
  // version mismatch". On machines with multiple Postgres installs (the common
  // Homebrew case: an old postgresql@NN keg shadowing a newer running server in
  // PATH) the bare `pg_dump` is often the wrong one, so select a matching binary
  // instead of trusting PATH order.
  const serverMajor = await getServerMajorVersion();
  // Shared resolver (server/lib/pgTools.js): PORTOS_PGDUMP override wins, else
  // auto-select a binary whose major is >= the server when we know the version,
  // else fall back to bare `pg_dump` off PATH.
  const { binary: pgDumpBin, satisfies } = await resolvePgDumpBinary(serverMajor);
  if (!satisfies) {
    console.warn(`⚠️ No installed pg_dump satisfies server major ${serverMajor} (using ${pgDumpBin})`);
  }

  return withPgToolEnv(POOL_CONFIG, pgEnv => new Promise((resolvePromise, rejectPromise) => {
    // A failed dump must be absent before a degraded snapshot can be
    // published. If we cannot remove it, leave the snapshot failed instead.
    const discardDump = (reason, error) => unlink(outputPath)
      .catch(err => {
        if (err.code !== 'ENOENT') throw backupFilesystemFailure('dump cleanup', err);
      })
      .then(() => resolvePromise({ status: 'failed', reason, error }), rejectPromise);

    const proc = spawn(pgDumpBin, [
      '-h', pgHost,
      '-p', pgPort,
      '-U', pgUser,
      '-d', pgDb,
      ...SNAPSHOT_PG_DUMP_FLAGS,
      '-f', outputPath
    ], {
      shell: false,
      env: pgEnv
    });

    let stderr = '';
    const watchdog = watchBackupProcess(proc, { label: 'PostgreSQL dump', progressPath: outputPath });
    proc.stderr.on('data', (chunk) => {
      watchdog.markActivity();
      stderr += chunk.toString();
    });

    proc.on('close', async (code) => {
      if (!watchdog.finish()) return;
      const timeoutError = watchdog.getTimeoutError();
      if (timeoutError) {
        return discardDump('timeout', timeoutError.message);
      }
      if (code !== 0) {
        console.warn(`⚠️ pg_dump failed (code ${code}): ${stderr.trim()}`);
        // A version mismatch is a distinct, actionable failure (install a newer
        // pg_dump) — classify it so the UI can point at the fix instead of the
        // generic "is pg_dump installed / is PG reachable" hint.
        const isMismatch = !satisfies || /server version mismatch|aborting because of server version/i.test(stderr);
        return discardDump(isMismatch ? 'version_mismatch' : 'dump_error', stderr.trim());
      }
      // Verify: a dump that exits 0 but is empty/truncated is still a failure.
      const info = await stat(outputPath).catch(() => null);
      if (!info || info.size === 0) {
        console.warn('⚠️ pg_dump produced an empty dump file');
        return discardDump('empty_dump', 'dump file missing or 0 bytes');
      }
      // Stream the dump to check its restore envelope and count tables
      // without holding it in memory. This callback owns stream failures.
      const inspected = await inspectDatabaseDump(outputPath).catch((err) => {
        console.warn(`⚠️ pg_dump inspection failed: ${err.code || err.message}`);
        return null;
      });
      if (!inspected) {
        return discardDump('inspect_error', 'dump could not be read for verification');
      }
      const missing = missingDumpParts(inspected);
      if (missing) {
        const error = `The database dump is incomplete (missing ${missing})`;
        console.warn(`⚠️ pg_dump rejected: ${error}`);
        return discardDump('dump_incomplete', error);
      }
      const tableCount = inspected.tableCount;
      console.log(`💾 pg_dump complete: ${Math.round(info.size / 1024)}KB, ${tableCount} tables`);
      // Don't return the absolute dump path: this result is persisted into
      // state.pgBackup and surfaced to the client via GET /api/backup/status,
      // the backup:completed socket event, and the /run response. No client
      // reads it (restorePostgres recomputes its own sqlPath), so leaking an
      // internal FS path serves no purpose.
      resolvePromise({ status: 'ok', sizeBytes: info.size, tableCount });
    });

    proc.on('error', (err) => {
      if (watchdog.getTimeoutError() || !watchdog.finish()) return;
      // pg_dump not installed — a configured-but-unbacked-up DB is at risk,
      // so this is a failure, not a silent skip.
      console.warn(`⚠️ pg_dump not available: ${err.message}`);
      resolvePromise({ status: 'failed', reason: 'pg_dump_missing', error: err.message });
    });
  }));
}

// Filesystem messages contain private paths; only expose the operation and errno.
function backupFilesystemFailure(operation, err) {
  const code = /^E[A-Z0-9]+$/.test(err?.code) ? err.code : 'UNKNOWN';
  return new Error(`Backup ${operation} failed (${code})`);
}

/**
 * Generate a SHA-256 manifest for all files in snapshotDataDir, plus the
 * sibling pg dump (which lives outside the data/ tree). Hashing the dump means
 * a truncated/corrupt portos-db.sql is detectable, not silently trusted.
 * @param {string} snapshotDataDir - Directory to hash
 * @param {string} manifestPath - Path to write manifest.json
 * @param {string|null} [pgDumpPath=null] - Sibling SQL dump to also hash
 * @param {object} [options] - Dump inventory expectations
 * @param {boolean} [options.allowMissingDump=false] - Only for skipped/failed dumps
 * @param {object} [options.assetConsistency] - The file-and-row consistency this snapshot claims
 */
export async function generateManifest(snapshotDataDir, manifestPath, pgDumpPath = null, { allowMissingDump = false, assetConsistency } = {}) {
  const entries = await readdir(snapshotDataDir, { recursive: true })
    .catch(err => { throw backupFilesystemFailure('manifest data readdir', err); });
  const files = {};

  for (const entry of entries) {
    const filePath = join(snapshotDataDir, entry);
    const info = await stat(filePath).catch(async err => {
      // rsync --archive preserves links even when their targets are absent or
      // excluded. Preserve that compatibility, but never skip a missing entry.
      if (err.code === 'ENOENT') {
        const entryInfo = await lstat(filePath)
          .catch(entryErr => { throw backupFilesystemFailure('manifest data lstat', entryErr); });
        if (entryInfo.isSymbolicLink()) return null;
      }
      throw backupFilesystemFailure('manifest data stat', err);
    });
    if (!info || !info.isFile() || isOsMetadataFile(basename(entry))) continue;
    files[entry] = await sha256File(filePath)
      .catch(err => { throw backupFilesystemFailure('manifest data hash', err); });
  }

  if (pgDumpPath) {
    const dumpInfo = await stat(pgDumpPath).catch(err => {
      if (allowMissingDump && err.code === 'ENOENT') return null;
      throw backupFilesystemFailure('manifest dump stat', err);
    });
    if (dumpInfo && !dumpInfo.isFile()) {
      throw new Error('Backup manifest dump stat failed (not a regular file)');
    }
    if (dumpInfo?.isFile()) {
      // Parent-relative key: the dump lives one level ABOVE snapshotDataDir
      // (alongside it, not inside it). A future manifest-verify must not assume
      // every key resolves under snapshotDataDir.
      files['../portos-db.sql'] = await sha256File(pgDumpPath)
        .catch(err => { throw backupFilesystemFailure('manifest dump hash', err); });
    }
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    fileCount: Object.keys(files).length,
    files,
    ...(assetConsistency ? { assetConsistency } : {}),
  };

  await atomicWrite(manifestPath, manifest);
  console.log(`💾 Backup manifest: ${manifest.fileCount} files`);
  return manifest;
}

/**
 * Get backup state with process-local failure and running projections.
 */
export async function getState() {
  const state = await readJSONFile(STATE_PATH, DEFAULT_STATE, { strict: true });
  const projected = failedStateProjection ? { ...state, ...failedStateProjection } : state;
  return isRunning ? { ...projected, status: 'running' } : projected;
}

/**
 * Merge patch into current backup state and persist.
 * @param {object} patch - Fields to merge into state
 * @param {Function} [onFailure] - Handle a rejected write inside the serialized queue
 */
export async function saveState(patch, onFailure) {
  return queueStateWrite(() => (async () => {
    await ensureDir(join(PATHS.data, 'backup'));
    // Status projections are read-only and must never become durable state.
    const current = await readJSONFile(STATE_PATH, DEFAULT_STATE, { strict: true });
    // Preserve legacy success before a failed/degraded attempt replaces its status.
    const legacySuccess = Object.hasOwn(current, 'lastSuccessfulRun') ? {} : {
      lastSuccessfulRun: current.status === 'ok' ? current.lastRun ?? null : null,
    };
    const updated = { ...current, ...legacySuccess, ...patch };
    await atomicWrite(STATE_PATH, updated);
    failedStateProjection = null;
    return updated;
  })().catch((error) => {
    // Handle the failed transition inside the queue: a later successful write
    // must clear it, never race with an out-of-queue failure handler.
    if (onFailure) return onFailure(error);
    throw error;
  }));
}

/**
 * Get the next scheduled backup run time from eventScheduler.
 * @returns {string|null} ISO timestamp of next run, or null
 */
export function getNextRunTime() {
  const event = getEvent('backup-daily');
  return event?.nextRunAt ? new Date(event.nextRunAt).toISOString() : null;
}

/**
 * Whether THIS process has a backup snapshot in flight right now, for the
 * system-idle gate. Deliberately reads the in-process `isRunning` flag rather
 * than scanning for an on-disk `.in-progress` marker: that marker is designed
 * to OUTLIVE a crash/PM2 restart so a restore never mistakes a partial
 * snapshot for a complete one, and only the next run converges an orphaned
 * one — gating the updater on its mere existence would block it until then
 * after a single interrupted backup on a drive that might not even be
 * mounted. The gate only needs to know whether restarting would kill a live
 * rsync/pg_dump in this server instance, and `isRunning` answers exactly
 * that, with no I/O and nothing that can fail to read.
 */
export function isBackupInProgress() {
  return isRunning;
}
