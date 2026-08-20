/**
 * CoS run reconciliation service — the I/O half of `lib/agentRunReconcile.js`.
 *
 * Completes the loop #4540 opened: slices 1 and 2 made every lifecycle boundary
 * append to the ledger, and this reads that stream back against the durable run
 * records in `data/runs/{id}/metadata.json`.
 *
 * Two operations, deliberately separated:
 *
 * - `getRunReconciliation()` is a pure read. It is what the diagnostic view and
 *   the GET route call, and it can never change anything.
 * - `repairRunRecords()` closes the records the ledger proves are finished. It
 *   only ever runs from an explicit POST — never from boot, never from a timer.
 *   A repair rewrites a user-visible run record, and the situation that calls
 *   for one (a record left open by a crash) is also the situation where a
 *   background sweep is most likely to race whatever recovery is already in
 *   flight.
 *
 * The record load is bounded by the ledger, not by the filesystem: only run ids
 * the projections actually name are read, so this never becomes a scan of a
 * `data/runs` directory holding thousands of historical runs.
 */

import { join } from 'path';
import { PATHS, readJSONFile, atomicWrite } from '../lib/fileUtils.js';
import { RUN_EVENT_READ_LIMITS } from '../lib/agentRunEvents.js';
import { reconcileRunRecords, planRunRecordRepair, isAgentFallbackKey } from '../lib/agentRunReconcile.js';
import { getRunProjections, appendRunEvent } from './agentRunEventLog.js';

/**
 * A run id is about to become a filesystem path, and it arrives from a file on
 * disk rather than from this process. The ledger's envelope schema bounds ids
 * by LENGTH only, so a hand-edited or truncated-and-recovered line could carry
 * `../` and point the read — or the repair write — at a `metadata.json`
 * outside `data/runs`. Every id the server itself mints is a uuid, so
 * demanding a single plain path segment costs nothing and closes that.
 */
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const metadataPath = (runId) =>
  (SAFE_RUN_ID.test(runId) && runId !== '.' && runId !== '..' ? join(PATHS.runs, runId, 'metadata.json') : null);

/**
 * A parsed `metadata.json`, or null if the file held something that is not a
 * run record. `readJSONFile` returns whatever the file parsed to, and a
 * truncated or hand-edited file can parse to `[]` or `"…"` — both truthy, both
 * with no `endTime`, so an unguarded read would call a corrupt file an open run
 * and then spread an array into the repaired record.
 */
const asRecord = (value) =>
  (value && typeof value === 'object' && !Array.isArray(value) ? value : null);

const readRecord = async (runId) => {
  const path = metadataPath(runId);
  return path ? asRecord(await readJSONFile(path, null)) : null;
};

/**
 * Load the run records the given projections name.
 *
 * Absent records are stored as an explicit `null` rather than left out of the
 * map, so the diff can tell "no record on disk" from "not looked at" — the
 * sentinel-over-truthiness rule that runs through this whole feature. An
 * unusable id or a corrupt file lands on that same `null`, and so is reported
 * as `record-missing` — which is what it is from here: no readable run record.
 */
async function loadRecordsFor(projections) {
  const runIds = projections.map((p) => p.id).filter((id) => id && !isAgentFallbackKey(id));
  const records = await Promise.all(runIds.map(readRecord));
  return new Map(runIds.map((id, index) => [id, records[index]]));
}

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

// Re-entrancy guard: one repair pass at a time. Not a concurrency defense (see
// the trust model) — a second pass launched while the first is mid-write would
// read records the first has not closed yet and plan the same repairs twice,
// producing a duplicate-looking result for work already done.
let inFlight = null;

/**
 * Close every run record the ledger proves is finished.
 *
 * Each repair is a read-modify-write against the record itself, and the record
 * is **re-read immediately before the write**: a run that finalized normally in
 * the window between the report and the repair must be left exactly as its own
 * completion path wrote it. `planRunRecordRepair` is re-run against that fresh
 * copy, so a record that closed itself in the meantime plans to nothing.
 *
 * The returned `findings`/`summary` describe the state the pass STARTED from,
 * not what is left afterwards — they are the evidence for `repaired`, and a
 * caller wanting the post-repair picture calls `getRunReconciliation()` again.
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
    // Fresh read — the report above may be a few disk reads old, and the run's
    // own completion path is the one writer allowed to win that race.
    const record = await readRecord(item.runId);
    const patch = planRunRecordRepair(projection, record, new Date().toISOString());
    if (!patch) {
      skipped += 1;
      continue;
    }

    // The ledger entry goes FIRST, and a failed append aborts the repair.
    //
    // Order decides which half of a half-finished repair survives a crash, and
    // only one order is recoverable. Event-then-record: the next pass reads the
    // run as terminal, the record as still open, plans the same repair, and the
    // event's natural key dedupes the second append — self-healing. The reverse
    // leaves a record closed by an event nothing recorded, which for an orphan
    // repair reads as a permanent `ledger-open` finding no later pass can
    // resolve, because the record it would have to fix is already closed.
    //
    // `appendRunEvent` never rejects; it REPORTS failure, so the result has to
    // be read rather than awaited and ignored.
    const appended = await appendRunEvent({
      kind: 'run.reconciled',
      eventId: `reconcile:${item.runId}:${patch.endTime}`,
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

    await atomicWrite(path, { ...record, ...patch });
    console.log(`🩹 Closed run ${item.runId} from the event ledger: ledger read ${item.detail.ledgerStatus}, record now ${patch.success ? 'success' : 'failure'}`);

    repaired.push({ runId: item.runId, from: item.detail.ledgerStatus, success: patch.success, endTime: patch.endTime });
  }

  return { checkedAt: new Date().toISOString(), repaired, skipped, ...report };
}
