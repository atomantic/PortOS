/**
 * Snapshot database restore: dump admission and staging, the reset plan and the
 * psql replay under database maintenance admission.
 */

import { spawn } from '../../lib/childProcess.js';
import { mkdtemp, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { readJSONFileStrict } from '../../lib/fileUtils.js';
import { acquireBackupSnapshotCut } from '../../lib/backupSnapshotBoundary.js';
import {
  POOL_CONFIG, checkHealth, databaseRestoreRecovery, getServerMajorVersion, query, withDatabaseMaintenance,
} from '../../lib/db.js';
import { withPgToolEnv } from '../../lib/pgTools.js';
import { inspectDatabaseDump, prepareDatabaseReplay } from '../backupDatabaseDump.js';
import {
  captureSyncFeedPositions, pendingRecoveryResult, repairCommittedRestore, restoreApplicationName, restoreReceiptSql,
  restoreRecoveryRefusal, settleReplayOutcome, withDatabaseRestoreAdmission,
} from '../backupRestoreRecovery.js';
import {
  assertExplicitSnapshotSourceSafe, assertSnapshotRestorable, inventoryReadError, missingDumpParts,
  resolveSnapshotPath, withSnapshotRead,
} from './snapshots.js';
import { watchBackupProcess } from './rsync.js';

const DUMP_UNREADABLE = Object.freeze({ status: 'failed', reason: 'dump_unreadable', error: 'The snapshot database dump could not be read or staged for restore. Restore was refused without changing data.' });

/**
 * Restore the PostgreSQL dump from a snapshot. Dry-run by default — mirrors
 * restoreSnapshot's safety default. Both modes first admit the snapshot's
 * portos-db.sql (complete pg_dump envelope, manifest hash when recorded); a
 * real restore then replays the admitted private copy into psql. The dump was
 * written with --no-owner --no-acl so it replays cleanly.
 *   { status: 'ok', dryRun, sizeBytes, tableCount }   (dry-run or applied)
 *   { status: 'skipped', reason: 'no_dump' }           (no sql file in snapshot)
 *   { status: 'skipped', reason: 'not_configured' }    (real restore, PG unreachable)
 *   { status: 'failed', reason: 'manifest_unreadable'|'manifest_mismatch'|'dump_unreadable'|'dump_incomplete'|'restore_compatibility'|'restore_preflight'|'restore_preflight_unavailable'|'restore_journal'|'backup_snapshot_busy'|'database_restore_busy'|'restore_error'|'timeout', error? }
 *     (nothing changed; a failed replay is reported only once proven rolled back)
 *   { status: 'failed', reason: 'restore_recovery_pending'|'restore_commit_unknown'|'restore_schema_reconciliation'|'restore_catalog_reconciliation'|'restore_sync_resync'|'restore_recovery_release', error, recovery }
 *     (a restore awaits recovery: ordinary database work stays fenced until
 *     resumeDatabaseRestore finishes it — see backupRestoreRecovery.js, #9725)
 * A successful real restore also carries `syncCursorsRewound` (peer count).
 * @param {string} destPath - Backup destination root
 * @param {string} snapshotId
 * @param {{dryRun?: boolean}} [options]
 */
export async function restorePostgres(destPath, snapshotId, { dryRun = true, source } = {}) {
  return withDatabaseRestoreAdmission(`restore-db:${String(snapshotId).slice(0, 240)}`,
    () => restorePostgresAdmitted(destPath, snapshotId, { dryRun, source }));
}

async function restorePostgresAdmitted(destPath, snapshotId, { dryRun, source }) {
  const resolved = resolveSnapshotPath(destPath, snapshotId, source);
  await assertExplicitSnapshotSourceSafe(resolved, snapshotId);
  // Held for the whole call, which spans every read of snapshot bytes: the
  // restorability check, the manifest and the dump admission/spool read. (The
  // replay itself reads only the private spool copy.) Neither deletion nor
  // retention can remove the dump while it is being admitted (#10898).
  return withSnapshotRead(resolved.snapshotDir, snapshotId,
    () => restoreHeldDatabase(resolved, snapshotId, { dryRun }));
}

async function restoreHeldDatabase({ snapshotDir, currentSource }, snapshotId, { dryRun }) {
  await assertSnapshotRestorable(snapshotDir, snapshotId, currentSource);
  // A committed restore awaiting repair fences the database; neither a preview
  // nor another replay may start until it is resolved (#9725).
  const pendingRecovery = restoreRecoveryRefusal();
  if (pendingRecovery) return pendingRecovery;
  const sqlPath = join(snapshotDir, 'portos-db.sql');

  const info = await stat(sqlPath).catch(cause => {
    if (cause?.code === 'ENOENT') return null;
    const { filesystemCode } = inventoryReadError(cause, 'stat-database-dump').context;
    console.error(`❌ restore: dump metadata unreadable for snapshot ${snapshotId} (${filesystemCode})`);
    return false;
  });
  if (info === false) return DUMP_UNREADABLE;
  // An empty/0-byte dump is as good as absent — restoring it is a silent no-op.
  // Mirror dumpPostgres's empty-dump guard so a truncated snapshot can't read
  // as a successful "0 tables" restore.
  if (!info || !info.isFile?.() || info.size === 0) {
    return { status: 'skipped', reason: 'no_dump' };
  }
  // Verify the dump against the manifest's stored SHA-256 before trusting it.
  // The dump is hashed in generateManifest under the parent-relative key
  // '../portos-db.sql' (it lives ALONGSIDE the snapshot data/ dir, not inside
  // it). Backward-compat: snapshots taken before manifests existed — or missing
  // the dump key — have nothing to verify against, so we SKIP verification and
  // proceed rather than hard-failing. An existing manifest refuses the restore
  // when it cannot be read or when its recorded dump hash does not match.
  const manifestPath = join(snapshotDir, 'manifest.json');
  // Read-only verification metadata. A confirmed ENOENT remains the legacy
  // no-manifest case, while corrupt bytes and every other read failure mean the
  // dump cannot be trusted. This path never writes the manifest back.
  const manifestRead = await readJSONFileStrict(manifestPath, null);
  if (!manifestRead.ok) {
    console.error(`❌ restore: integrity manifest unreadable for snapshot ${snapshotId}`);
    return { status: 'failed', reason: 'manifest_unreadable' };
  }
  const expectedHash = manifestRead.value?.files?.['../portos-db.sql'];
  // Execution replays a private copy written by the same read that admits the
  // dump, so replay derives only from the checked bytes even if the
  // snapshot changes afterwards (#8782). Preview only inspects.
  const spoolDir = dryRun ? null : await mkdtemp(join(tmpdir(), 'portos-restore-')).catch((err) => {
    console.error(`❌ restore: cannot stage dump for snapshot ${snapshotId}: ${err.message}`);
    return false;
  });
  if (spoolDir === false) return DUMP_UNREADABLE;
  try {
    return await restoreAdmittedDump({ sqlPath, spoolPath: spoolDir && join(spoolDir, 'dump.sql'), expectedHash, snapshotId, dryRun, sizeBytes: info.size });
  } finally {
    if (spoolDir) {
      await rm(spoolDir, { recursive: true, force: true })
        .catch(err => console.error(`❌ restore: failed to remove dump spool ${spoolDir}: ${err.message}`));
    }
  }
}

async function restoreAdmittedDump({ sqlPath, spoolPath, expectedHash, snapshotId, dryRun, sizeBytes }) {
  // One streamed read supplies the checksum and the completeness proof. A read
  // failure is refused here — never mistaken for an empty dump.
  const targetServerMajor = await getServerMajorVersion().catch(() => null);
  const dump = await inspectDatabaseDump(sqlPath, { spoolTo: spoolPath, targetServerMajor }).catch((err) => {
    console.error(`❌ restore: dump unreadable for snapshot ${snapshotId}: ${err.message}`);
    return null;
  });
  if (!dump) {
    return DUMP_UNREADABLE;
  }
  if (expectedHash && dump.sha256 !== expectedHash) {
    console.error(`❌ restore: manifest hash mismatch for snapshot ${snapshotId} (expected ${expectedHash}, got ${dump.sha256})`);
    return { status: 'failed', reason: 'manifest_mismatch' };
  }
  // The restore resets every application table first, so a dump that parses
  // but stops early (header-only, or truncated between statements) would
  // commit an empty database. ON_ERROR_STOP cannot see that; the envelope can.
  const missing = missingDumpParts(dump);
  if (missing) {
    console.error(`❌ restore: incomplete dump for snapshot ${snapshotId} (missing ${missing})`);
    return { status: 'failed', reason: 'dump_incomplete', error: `The snapshot database dump is incomplete (missing ${missing}). Restore was refused without changing data.` };
  }
  const { tableCount } = dump;
  const health = await checkHealth();
  if (!health.connected) return { status: 'skipped', reason: 'not_configured' };
  if (!Number.isInteger(targetServerMajor) || targetServerMajor <= 0) {
    return {
      status: 'failed',
      reason: 'restore_compatibility',
      error: 'Cannot establish the target PostgreSQL major version. Check database connectivity and permission to SHOW server_version_num, then retry preview before restoring. No data was changed.',
    };
  }
  // Admission checks above always cover the original bytes. Only the private
  // replay copy omits extension comments and clean-dump extension drops,
  // whose ownership may belong to a provisioning role, plus the exact PG17
  // transaction_timeout header when replaying to an older target.
  const replayPath = dryRun ? null : await prepareDatabaseReplay(spoolPath, dump.extensionMetadata).catch(err => {
    console.error(`❌ restore: cannot normalize admitted dump for snapshot ${snapshotId}: ${err.message}`);
    return null;
  });
  if (!dryRun && !replayPath) return DUMP_UNREADABLE;

  // Preview remains read-only. Recheck inside the replay transaction as well,
  // so a changed catalog cannot turn a previously safe preview into a cascade.
  const { getDatabaseResetPlan } = await import('../backupDatabaseReset.js');
  const { preflight, reset } = await getDatabaseResetPlan();
  const preflightError = await query(preflight).then(() => null, error => error);
  if (preflightError) {
    const message = String(preflightError.message || '');
    // Only explicit PL/pgSQL refusals from backupDatabaseReset.js indicate
    // unexpected schema objects or ownership; connection/query errors (e.g.
    // 57P01) must report preflight unavailability instead of a schema conflict.
    const isExplicitPreflightRefusal = /^Restore preflight:\s*/.test(message)
      && (!preflightError.code || preflightError.code === 'P0001');
    if (isExplicitPreflightRefusal) {
      console.error(`❌ restore: preflight refused snapshot ${snapshotId}: ${preflightError.message}`);
      const detail = message.replace(/^Restore preflight:\s*/, '');
      return { status: 'failed', reason: 'restore_preflight', error: `Database contains unexpected objects, ownership, or dependencies${detail ? ` (${detail})` : ''}. Restore was refused without changing data.` };
    }
    console.error(`❌ restore: preflight unavailable for snapshot ${snapshotId}: ${preflightError.message}`);
    const detail = message.trim();
    return {
      status: 'failed',
      reason: 'restore_preflight_unavailable',
      error: `Could not complete the restore preflight check${detail ? ` (${detail})` : ''}. Restore database connectivity and retry preview before restoring. No data was changed.`,
    };
  }
  if (dryRun) return { status: 'ok', dryRun: true, sizeBytes, tableCount };

  // The replay replaces every row. Take the backup boundary first so no admitted
  // file-plus-row publication is half done underneath it and no backup cut is
  // capturing the database mid-replay. Only this restore's own cut is released.
  let releaseSnapshotCut;
  try {
    releaseSnapshotCut = await acquireBackupSnapshotCut();
  } catch (err) {
    if (err.code !== 'BACKUP_SNAPSHOT_BUSY') throw err;
    console.log(`🚫 restore: refused for snapshot ${snapshotId}: ${err.message}`);
    return {
      status: 'failed',
      reason: 'backup_snapshot_busy',
      error: `A backup is capturing the database or an asset publication did not finish draining. Restore was refused without changing data; retry when it finishes. ${err.message}`,
    };
  }
  try {
    return await replayAdmittedDump({ tableCount, sizeBytes, snapshotId, dump, reset, replayPath });
  } catch (err) {
    if (err.code !== 'DATABASE_RESTORE_BUSY') throw err;
    console.log(`🚫 restore: refused for snapshot ${snapshotId}: ${err.message}`);
    return { status: 'failed', reason: 'database_restore_busy', error: err.message };
  } finally {
    releaseSnapshotCut();
  }
}

async function replayAdmittedDump({ tableCount, sizeBytes, snapshotId, dump, reset, replayPath }) {
  return withDatabaseMaintenance(async ({ adoptRestoreRecovery }) => {
    // Read before the replay rewinds them, then make them durable together
    // with this operation's identity BEFORE anything destructive runs: a
    // committed replay whose repair fails (or a restart) must floor sequences
    // at THESE positions, never at values re-read after the dump reset them.
    const feedPositions = await captureSyncFeedPositions();
    let record;
    try {
      record = databaseRestoreRecovery.begin({ snapshotId, dumpSha256: dump.sha256, feedPositions });
      adoptRestoreRecovery(record.id);
    } catch (err) {
      if (record) throw err;
      console.error(`❌ restore: recovery journal could not be written for snapshot ${snapshotId}: ${err.message}`);
      return {
        status: 'failed',
        reason: 'restore_journal',
        error: 'The restore recovery journal could not be written. Restore was refused without changing data.',
      };
    }
    try {
      const { preparePeerExecutionRestore } = await import('../peerExecutionRestore.js');
      await preparePeerExecutionRestore(record.id);
    } catch (err) {
      console.error(`❌ restore: execution consumption capture failed: ${err.message}`);
      return pendingRecoveryResult('restore_execution_reconciliation', record);
    }
    const { host: pgHost, port, database: pgDb, user: pgUser } = POOL_CONFIG;
    const pgPort = String(port);

    const replay = await withPgToolEnv(POOL_CONFIG, pgEnv => new Promise((resolveP) => {
      // ON_ERROR_STOP=1 aborts on the first failed statement; --single-transaction
      // wraps the whole replay in one transaction so that abort ROLLs BACK every
      // prior statement. Together they make the restore atomic: it either fully
      // applies or leaves the live DB untouched — never a mixed snapshot/current
      // state. (The dump is written with --clean --if-exists, so the DROPs and
      // recreates all commit or roll back as one unit.) psql reads the admitted
      // spool copy, never the snapshot path. The trailing receipt commits with
      // the dump or not at all, and the application name identifies this
      // replay's session to recovery (#9725).
      const proc = spawn('psql', [
        '-X', '-v', 'ON_ERROR_STOP=1',
        '--single-transaction',
        '--echo-all',
        '-h', pgHost, '-p', pgPort, '-U', pgUser, '-d', pgDb, '-c', reset, '-f', replayPath,
        '-c', restoreReceiptSql(record),
      ], { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { ...pgEnv, PGAPPNAME: restoreApplicationName(record.id) } });

      let stderr = '';
      const watchdog = watchBackupProcess(proc, { label: 'PostgreSQL restore' });
      // `--echo-all` echoes input as psql consumes it, including rows within a
      // long COPY. The output is never retained, but it must be drained: unread
      // piped output can backpressure and deadlock a verbose restore. Each chunk
      // is also the progress signal that keeps an active long restore alive.
      proc.stdout.on('data', watchdog.markActivity);
      proc.stderr.on('data', (chunk) => {
        watchdog.markActivity();
        stderr += chunk.toString();
      });

      proc.on('close', (code) => {
        if (!watchdog.finish()) return;
        const timeoutError = watchdog.getTimeoutError();
        if (timeoutError) {
          resolveP({ status: 'failed', reason: 'timeout', error: timeoutError.message });
          return;
        }
        if (code === 0) {
          console.log(`💾 psql restore complete from snapshot ${snapshotId}: ${tableCount} tables`);
          resolveP({ status: 'ok', dryRun: false, sizeBytes, tableCount });
        } else {
          console.warn(`⚠️ psql restore failed (code ${code}): ${stderr.trim()}`);
          resolveP({ status: 'failed', reason: 'restore_error', error: stderr.trim() });
        }
      });
      proc.on('error', (err) => {
        if (watchdog.getTimeoutError() || !watchdog.finish()) return;
        console.warn(`⚠️ psql not available: ${err.message}`);
        resolveP({ status: 'failed', reason: 'restore_error', error: err.message });
      });
    })).catch((err) => ({ status: 'failed', reason: 'restore_error', error: err.message }));

    if (replay.status === 'ok') {
      // psql exit 0 under --single-transaction means COMMIT succeeded.
      record = databaseRestoreRecovery.markCommitted(record.id);
    } else {
      // A failed/killed/lost psql may still have committed (a crash or lost
      // response at COMMIT). Only the receipt can say; an unknown outcome stays
      // fenced instead of reopening writes or replaying again.
      const settled = await settleReplayOutcome(record);
      if (settled.outcome === 'rolled_back') return replay;
      if (settled.outcome === 'uncertain') return pendingRecoveryResult(settled.reason ?? 'restore_commit_unknown', record);
      record = settled.record;
    }

    // Replay has committed. Still inside maintenance and still fenced, so no
    // sync apply or feed write can interleave with the repair, and a failed
    // step leaves ordinary work closed with the original positions recorded.
    const repaired = await repairCommittedRestore(record);
    if (repaired.status !== 'ok') return repaired;
    return { status: 'ok', dryRun: false, sizeBytes, tableCount, syncCursorsRewound: repaired.syncCursorsRewound };
  });
}
