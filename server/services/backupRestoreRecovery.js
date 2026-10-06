/**
 * Committed-restore recovery for snapshot database restores (#9725).
 *
 * restorePostgres publishes a durable journal (server/lib/databaseRestoreRecovery.js)
 * with the ORIGINAL feed positions before its destructive replay, and the replay
 * writes a receipt row for that operation inside its own transaction. From then
 * on ordinary database work stays fenced until this module finishes repair:
 * forced schema upgrades, ordered migrations, feed-sequence flooring at the
 * recorded positions and the inbound cursor rewind. A committed replay is never
 * replayed again; an unknown outcome is resolved only from the receipt.
 */
import { databaseRestoreRecovery, ensureSchema, query, withDatabaseMaintenance } from '../lib/db.js';
import { syncFeedTables, syncFeedSequenceName } from '../lib/db/schema/syncFeed.js';
import { restoreReceiptsDdl } from '../lib/db/schema/core.js';

// Ties the replay's psql session to its operation, so recovery can prove no
// session of that replay is still able to commit before reading "no receipt"
// as a rollback.
export const restoreApplicationName = (id) => `portos-restore-${id}`;

// Appended after the dump inside the same --single-transaction replay. The
// id/digest come from the validated journal (uuid / lowercase hex), never from
// the snapshot. pg_dump empties search_path, so restore the application schema
// first (ensureSchema creates the table there too).
export const restoreReceiptSql = ({ id, dumpSha256 }) =>
  `SET search_path = public;\n${restoreReceiptsDdl.join(';\n')};\nINSERT INTO restore_receipts (operation_id, dump_sha256) VALUES ('${id}', '${dumpSha256}');`;

const SESSION_SETTLE_ATTEMPTS = 10;
const SESSION_SETTLE_MS = 200;

const MESSAGES = {
  restore_commit_unknown: 'The restore could not confirm whether the database dump was committed. Ordinary database work stays paused and the dump will NOT be replayed; retry recovery from Settings > Backup once PostgreSQL is reachable.',
  restore_schema_reconciliation: 'The database dump was applied, but schema recovery is incomplete. It was not rolled back and will not be replayed. Ordinary database work stays paused: retry recovery from Settings > Backup, or restart PortOS to retry automatically. If it keeps failing, check the server logs.',
  restore_execution_reconciliation: 'Execution request consumption and unresolved ownership are awaiting reconciliation. Database work stays paused; the dump will not be replayed. Recovery retries automatically at startup and can also be retried from Settings > Backup.',
  restore_sync_resync: 'The database dump was applied, but peer sync could not be reset yet. It will not be replayed. Ordinary database work stays paused: retry recovery from Settings > Backup, or restart PortOS to retry automatically.',
  restore_recovery_release: 'The database dump was applied and repaired, but the recovery journal could not be cleared. Ordinary database work stays paused: retry recovery from Settings > Backup.',
  restore_recovery_pending: 'A previous database restore is awaiting recovery. Finish it from Settings > Backup before starting another restore.',
  restore_recovery_damaged: 'The database restore recovery journal is unreadable, so the database stays fenced. Inspect data/database-restore-recovery.json and the server logs; never delete it unless you have confirmed how the restore ended.',
};

/** Bounded status projection — never feed positions, paths or digests. */
function recoveryProjection(record) {
  return { id: record.id, stage: record.stage, snapshotId: record.snapshotId, createdAt: record.createdAt };
}

export function pendingRecoveryResult(reason, record) {
  return { status: 'failed', reason, error: MESSAGES[reason], recovery: recoveryProjection(record) };
}

/**
 * Pending restore recovery, for the API/UI. A damaged journal still fences the
 * database and is reported as such rather than as "nothing pending".
 */
export function getDatabaseRestoreRecoveryStatus() {
  if (!databaseRestoreRecovery.isFenced()) return { pending: false };
  let record;
  try {
    record = databaseRestoreRecovery.read();
  } catch {
    return { pending: true, damaged: true };
  }
  return record ? { pending: true, ...recoveryProjection(record) } : { pending: false };
}

/** A restore refusal while recovery is pending, or null when none is. */
export function restoreRecoveryRefusal() {
  const status = getDatabaseRestoreRecoveryStatus();
  if (!status.pending) return null;
  return {
    status: 'failed',
    reason: 'restore_recovery_pending',
    error: status.damaged ? MESSAGES.restore_recovery_damaged : MESSAGES.restore_recovery_pending,
    recovery: status.damaged ? { damaged: true } : recoveryProjection(status),
  };
}

// Feed sequences present before the replay (a pre-#8315 install has none).
// pg_sequences reports a NULL last_value for a never-drawn sequence, which
// holds no position worth preserving.
export async function captureSyncFeedPositions() {
  const { rows } = await query(
    `SELECT sequencename, last_value::text AS last_value FROM pg_sequences
      WHERE schemaname = current_schema() AND sequencename = ANY($1::text[]) AND last_value IS NOT NULL`,
    [syncFeedTables.map(syncFeedSequenceName)],
  );
  return rows.map(({ sequencename, last_value }) => ({ sequencename, last_value }));
}

/**
 * Resolve a replay whose outcome the restoring process did not observe
 * (non-zero/killed psql, lost response, crash) from its transactional receipt.
 *   'committed'   — this operation's receipt row exists
 *   'rolled_back' — no session of the replay remains and no receipt exists
 *   'uncertain'   — a replay session is still live, or the database could not
 *                   be inspected; nothing may reopen or replay
 */
async function inspectReplayOutcome(record) {
  const inspect = async () => {
    // A replay backend that is still running could yet commit: the receipt's
    // absence proves a rollback only once no session of that replay remains.
    let sessions = 1;
    for (let attempt = 0; attempt < SESSION_SETTLE_ATTEMPTS && sessions > 0; attempt++) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, SESSION_SETTLE_MS));
      const { rows } = await query(
        `SELECT (SELECT count(*) FROM pg_stat_activity WHERE application_name = $1)::int AS sessions,
           to_regclass('public.restore_receipts') IS NOT NULL AS has_receipts`,
        [restoreApplicationName(record.id)],
      );
      sessions = rows[0]?.sessions ?? 1;
      if (!sessions && !rows[0]?.has_receipts) return 'rolled_back';
    }
    if (sessions > 0) return 'uncertain';
    const { rows } = await query('SELECT dump_sha256 FROM restore_receipts WHERE operation_id = $1', [record.id]);
    if (!rows.length) return 'rolled_back';
    // A receipt for this unique id with another digest is not ours to trust.
    return rows[0].dump_sha256 === record.dumpSha256 ? 'committed' : 'uncertain';
  };
  return inspect().catch((err) => {
    console.error(`❌ DB restore ${record.id}: replay outcome could not be inspected: ${err.message}`);
    return 'uncertain';
  });
}

/**
 * Repair both directions of peer sync after a committed replay (#8710).
 *
 * Outbound: the dump `setval`s each feed sequence back to the dump's maximum,
 * so new rows would reuse positions peers already passed and never be pulled.
 * Floor every sequence at its ORIGINAL pre-restore value (from the journal,
 * never re-captured) so post-restore positions land above any peer cursor.
 *
 * Inbound: our per-peer memory/Catalog cursors still point past rows the
 * restore discarded. Rewind them so the next sync replays each peer's streams
 * through the idempotent LWW / ON CONFLICT apply paths. Both steps are
 * idempotent, so a retried recovery repeats them safely.
 * @returns {Promise<number>} peers whose cursors were rewound
 */
async function resyncFederationAfterRestore(feedPositions) {
  if (feedPositions.length) {
    // GREATEST ignores the NULL of a sequence the dump left undrawn.
    await query(
      `SELECT setval(format('%I', s.sequencename)::regclass, GREATEST(c.captured::bigint, s.last_value))
        FROM pg_sequences s
        JOIN unnest($1::text[], $2::text[]) AS c(name, captured) ON c.name = s.sequencename
        WHERE s.schemaname = current_schema()`,
      [feedPositions.map((p) => p.sequencename), feedPositions.map((p) => p.last_value)],
    );
  }
  const { rewindPostgresSyncCursors } = await import('./syncOrchestrator.js');
  const peers = await rewindPostgresSyncCursors();
  console.log(`🔄 DB restore: floored ${feedPositions.length} sync feed sequences, rewound memory/Catalog cursors for ${peers} peers`);
  return peers;
}

/**
 * Finish a COMMITTED replay. Must run inside the maintenance context that owns
 * this operation. Releases admission only after every step succeeded.
 * @returns {Promise<{status:'ok', syncCursorsRewound:number}|object>} ok, or a pending-recovery failure
 */
export async function repairCommittedRestore(record) {
  // Reapply this version's upgrades even when readiness was cached before the
  // restore, then honor the restored migration ledger.
  const reconciliationError = await (async () => {
    await ensureSchema({ force: true });
    const { runDbMigrations } = await import('../scripts/run-db-migrations.js');
    await runDbMigrations();
  })().then(() => null, (err) => err);
  if (reconciliationError) {
    console.error(`❌ DB restore ${record.id}: schema reconciliation failed: ${reconciliationError.message}`);
    return pendingRecoveryResult('restore_schema_reconciliation', record);
  }
  const executionError = await (async () => {
    const { finishPeerExecutionRestore } = await import('./peerExecutionRestore.js');
    await finishPeerExecutionRestore(record.id);
  })().then(() => null, error => error);
  if (executionError) {
    console.error(`❌ DB restore ${record.id}: execution reconciliation failed: ${executionError.message}`);
    return pendingRecoveryResult('restore_execution_reconciliation', record);
  }
  const resync = await resyncFederationAfterRestore(record.feedPositions).then(
    (syncCursorsRewound) => ({ syncCursorsRewound }),
    (err) => ({ err }),
  );
  if (resync.err) {
    console.error(`❌ DB restore ${record.id}: federation resync failed: ${resync.err.message}`);
    return pendingRecoveryResult('restore_sync_resync', record);
  }
  const releaseError = await Promise.resolve().then(() => databaseRestoreRecovery.release(record.id)).then(() => null, (err) => err);
  if (releaseError) {
    console.error(`❌ DB restore ${record.id}: recovery journal could not be cleared: ${releaseError.message}`);
    return pendingRecoveryResult('restore_recovery_release', record);
  }
  console.log(`💾 DB restore ${record.id}: recovery complete, database admission reopened`);
  return { status: 'ok', syncCursorsRewound: resync.syncCursorsRewound };
}

/**
 * Settle an operation whose replay outcome was not observed as a commit.
 * Inside the owning maintenance context. Returns 'rolled_back' after releasing
 * admission, 'committed' (with the record now at `repairing`) after recording
 * the commit, or 'uncertain'.
 * @returns {Promise<{outcome: string, record: object}>}
 */
export async function settleReplayOutcome(record) {
  const outcome = await inspectReplayOutcome(record);
  if (outcome === 'rolled_back') {
    try {
      const { finishPeerExecutionRestore } = await import('./peerExecutionRestore.js');
      await finishPeerExecutionRestore(record.id, { rolledBack: true });
    } catch (err) {
      console.error(`❌ DB restore ${record.id}: rollback execution reconciliation failed: ${err.message}`);
      return { outcome: 'uncertain', record, reason: 'restore_execution_reconciliation' };
    }
    databaseRestoreRecovery.release(record.id);
    console.log(`💾 DB restore ${record.id}: replay rolled back; database admission reopened without changes`);
    return { outcome, record };
  }
  if (outcome === 'committed') return { outcome, record: databaseRestoreRecovery.markCommitted(record.id) };
  console.error(`❌ DB restore ${record.id}: replay outcome unknown; database stays fenced`);
  return { outcome, record };
}

/**
 * Resume the pending restore recovery: resolve an unknown replay outcome from
 * its receipt, then repair a committed replay. Never resets or replays.
 *   { status: 'ok', outcome: 'repaired', syncCursorsRewound }
 *   { status: 'ok', outcome: 'rolled_back' }   (proven rollback, nothing changed)
 *   { status: 'ok', outcome: 'none' }          (nothing pending)
 *   { status: 'failed', reason, error, recovery }  (still pending)
 * @param {string} [id] - operation to resume; omitted = whichever is pending
 */
export async function resumeDatabaseRestore(id) {
  const record = databaseRestoreRecovery.read();
  if (!record) return { status: 'ok', outcome: 'none' };
  if (id && record.id !== id) {
    throw Object.assign(new Error('A different database restore operation is pending.'), { status: 409, code: 'RESTORE_RECOVERY_MISMATCH' });
  }
  return withDatabaseMaintenance(async () => {
    // Re-read inside maintenance: another resume may have finished meanwhile.
    let current = databaseRestoreRecovery.read();
    if (current?.id !== record.id) return { status: 'ok', outcome: 'none' };
    if (current.stage === 'replaying') {
      const settled = await settleReplayOutcome(current);
      if (settled.outcome === 'rolled_back') return { status: 'ok', outcome: 'rolled_back' };
      if (settled.outcome === 'uncertain') return pendingRecoveryResult(settled.reason ?? 'restore_commit_unknown', current);
      current = settled.record;
    }
    const repaired = await repairCommittedRestore(current);
    return repaired.status === 'ok' ? { ...repaired, outcome: 'repaired' } : repaired;
  }, { restoreRecoveryId: record.id });
}
