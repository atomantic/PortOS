/**
 * CoS run reconciliation service — the I/O half of `lib/agentRunReconcile.js`.
 * Reads the run-event ledger back against the durable run records in
 * `data/runs/{id}/metadata.json`.
 *
 * - `getRunReconciliation()` is a pure read (diagnostic view and GET route).
 * - `repairRunRecords()` closes the records the ledger proves are finished. It
 *   only runs from an explicit POST — never from boot or a timer, because a
 *   background sweep is most likely to race whatever recovery is already in flight.
 *
 * Only run ids the projections name are read, so this never scans a `data/runs`
 * directory of thousands of historical runs.
 */

import { join } from 'path';
import { PATHS, readJSONFile, atomicWrite, sha256Text } from '../lib/fileUtils.js';
import { RUN_EVENT_READ_LIMITS } from '../lib/agentRunEvents.js';
import { reconcileRunRecords, planRunRecordRepair, isAgentFallbackKey } from '../lib/agentRunReconcile.js';
import { getRunProjections, appendRunEvent } from './agentRunEventLog.js';

/**
 * A run id becomes a filesystem path but arrives from a file on disk. The
 * ledger's schema bounds ids by LENGTH only, so a hand-edited line could carry
 * `../` and aim the read or repair write outside `data/runs`. Server-minted ids
 * are uuids, so requiring a single plain path segment costs nothing.
 */
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const metadataPath = (runId) =>
  (SAFE_RUN_ID.test(runId) && runId !== '.' && runId !== '..' ? join(PATHS.runs, runId, 'metadata.json') : null);

/**
 * A parsed `metadata.json`, or null if it is not a run record. A corrupt file can
 * parse to `[]` or `"…"` — truthy with no `endTime` — which would read as an open
 * run and spread an array into the repaired record.
 */
const asRecord = (value) =>
  (value && typeof value === 'object' && !Array.isArray(value) ? value : null);

const readRecord = async (runId) => {
  const path = metadataPath(runId);
  // Non-strict exception: unreadable metadata becomes null; repair planning
  // skips it (including the final re-read), so no default is written back.
  return path ? asRecord(await readJSONFile(path, null)) : null;
};

/**
 * Load the run records the given projections name. Absent records are an explicit
 * `null` (not omitted) so the diff can tell "no record on disk" from "not looked
 * at"; an unusable id or corrupt file lands on the same `null`.
 */
async function loadRecordsFor(projections) {
  const runIds = projections.map((p) => p.id).filter((id) => id && !isAgentFallbackKey(id));
  const records = await Promise.all(runIds.map(readRecord));
  return new Map(runIds.map((id, index) => [id, records[index]]));
}

/**
 * The idempotency key for one repair: this run, closed at this instant. Hashed
 * because `buildRunEvent` truncates `eventId` at 128 characters and a readable
 * key puts the run id first, so ids sharing a long prefix would collide and the
 * second repair would be suppressed as a duplicate. The `reconcile:` prefix keeps
 * it recognizable in the ledger.
 */
const repairEventId = (runId, endTime) => `reconcile:${sha256Text(`${runId}\u0000${endTime}`).slice(0, 32)}`;

const cap = (limit) => Math.min(
  Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : RUN_EVENT_READ_LIMITS.default,
  RUN_EVENT_READ_LIMITS.max
);

/**
 * Compare the ledger's projections against the run records. Read-only.
 *
 * @param {object} [options]
 * @param {string} [options.runId] - restrict to one run
 * @param {number} [options.limit] - max projections examined
 * @returns {Promise<{checkedAt: string, findings: object[], summary: object}>}
 */
export async function getRunReconciliation({ runId, limit } = {}) {
  const projections = await getRunProjections({ runId, limit: cap(limit) });
  const records = await loadRecordsFor(projections);
  return { checkedAt: new Date().toISOString(), ...reconcileRunRecords({ projections, records }) };
}

// Re-entrancy guard: a second pass launched mid-write would read records the first
// has not closed yet and plan the same repairs twice.
let inFlight = null;

/**
 * Close every run record the ledger proves is finished.
 *
 * Each repair is re-read immediately before the write and re-planned against that
 * fresh copy, so a run that finalized normally in the meantime is left as its own
 * completion path wrote it.
 *
 * The returned `findings`/`summary` describe the state the pass STARTED from; call
 * `getRunReconciliation()` again for the post-repair picture.
 *
 * @param {object} [options]
 * @param {string} [options.runId] - restrict to one run
 * @param {number} [options.limit] - max projections examined
 * @returns {Promise<{checkedAt: string, repaired: object[], skipped: number, findings: object[], summary: object}>}
 */
export function repairRunRecords(options = {}) {
  if (inFlight) return inFlight;
  inFlight = repairNow(options).finally(() => { inFlight = null; });
  return inFlight;
}

async function repairNow({ runId, limit } = {}) {
  const projections = await getRunProjections({ runId, limit: cap(limit) });
  const records = await loadRecordsFor(projections);
  const report = reconcileRunRecords({ projections, records });
  const byId = new Map(projections.map((p) => [p.id, p]));

  const repaired = [];
  let skipped = 0;

  for (const item of report.findings) {
    if (!item.repairable) continue;
    const projection = byId.get(item.runId);
    const path = metadataPath(item.runId);
    // The run's own completion path is the one writer allowed to win the race.
    const record = await readRecord(item.runId);
    const patch = planRunRecordRepair(projection, record, new Date().toISOString());
    if (!patch) {
      skipped += 1;
      continue;
    }

    // The ledger entry goes FIRST, and a failed append aborts the repair. Only
    // event-then-record is recoverable after a crash: the next pass plans the same
    // repair and the event's natural key dedupes the append. The reverse leaves a
    // record closed by an unrecorded event — a permanent `ledger-open` finding no
    // pass can resolve. `appendRunEvent` REPORTS failure rather than rejecting,
    // so the result must be read.
    const appended = await appendRunEvent({
      kind: 'run.reconciled',
      eventId: repairEventId(item.runId, patch.endTime),
      runId: item.runId,
      agentId: item.agentId,
      taskId: item.taskId,
      at: patch.reconciledAt,
      data: {
        fromStatus: patch.reconciledFromStatus,
        success: patch.success,
        exitCode: patch.exitCode,
        durationMs: patch.duration
      }
    });
    if (appended?.error) {
      console.error(`❌ Skipped reconciling run ${item.runId}: could not record the repair (${appended.error})`);
      skipped += 1;
      continue;
    }

    // The append did disk I/O, so re-read: the LAST read before the write must be
    // current or a run whose completion landed during the append gets overwritten.
    // A null re-plan means the record closed itself; the appended event is harmless
    // (a real `run.finalized` outranks it, and its key dedupes a retry).
    const fresh = await readRecord(item.runId);
    // Same instant, so `endTime` and the ledger event key are unchanged.
    const finalPatch = planRunRecordRepair(projection, fresh, patch.reconciledAt);
    if (!finalPatch) {
      skipped += 1;
      continue;
    }

    await atomicWrite(path, { ...fresh, ...finalPatch });
    console.log(`🩹 Closed run ${item.runId} from the event ledger: ledger read ${item.detail.ledgerStatus}, record now ${finalPatch.success ? 'success' : 'failure'}`);

    repaired.push({ runId: item.runId, from: item.detail.ledgerStatus, success: finalPatch.success, endTime: finalPatch.endTime });
  }

  return { checkedAt: new Date().toISOString(), repaired, skipped, ...report };
}
