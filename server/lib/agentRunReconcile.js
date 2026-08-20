/**
 * CoS run reconciliation — the ledger read BACK against the run record.
 *
 * Slices 1 and 2 of #4540 made the lifecycle observable: every boundary appends
 * to `data/cos/run-events.jsonl`, and `projectRunStates` folds that stream into
 * "what this run is now". But the fold has been write-only so far — the ledger
 * is appended *alongside* `data/runs/{id}/metadata.json` and nothing ever
 * compared the two. When they disagree, the mutable record wins by default and
 * the disagreement is invisible, which is precisely the class of failure the
 * ledger exists to explain.
 *
 * This module is the comparison. It is pure — no disk, no clock — so every
 * finding case is a table test rather than a fixture tree. The service half
 * (`services/agentRunReconciler.js`) supplies the projections, the records, and
 * the write.
 *
 * **Repairs run one direction only: ledger → record.** A run record left open
 * because the process died between the ledger append and the metadata write can
 * be closed from the stream, because the stream holds the verdict. The reverse
 * — a record that is closed while the ledger never saw the close — is reported
 * and never "fixed": inventing the missing lifecycle event would put a fact in
 * the append-only stream that nothing ever observed, and a ledger that
 * back-fills itself from the record it is supposed to audit can no longer audit
 * it.
 */

/**
 * The closed finding vocabulary. Closed for the same reason the event kinds are:
 * the summary below is exhaustive over it, and a typo becomes a test failure
 * rather than a finding nothing counts.
 */
export const RUN_RECONCILE_FINDINGS = Object.freeze([
  // Ledger reached a verdict; the run record still has no `endTime`. The one
  // repairable case — the stream holds everything the close needs.
  'record-open',
  // The ledger names a run that has no `metadata.json` on disk. Not repairable:
  // a run record is written by the run, and synthesizing one from redacted
  // telemetry would fabricate a run history rather than recover one.
  'record-missing',
  // Both sides are closed and disagree on the verdict. Reported, never
  // repaired: the record's verdict is the one every other reader already used
  // (usage billing, task status), so silently flipping it would rewrite history
  // downstream of this module.
  'verdict-mismatch',
  // The record is closed but the ledger still reads live. The close event never
  // landed — a ledger gap, not a record defect.
  'ledger-open'
]);

/** Projection statuses that mean "this run is over, and the ledger knows how". */
const TERMINAL_STATUSES = new Set(['completed', 'failed']);

/**
 * Projection statuses that mean the run is over *as far as the process goes*,
 * even without a verdict event. `orphaned` belongs here and not in
 * TERMINAL_STATUSES: the sweep observed the process gone, so the run is
 * certainly not still working, but no `run.finalized` recorded a verdict — the
 * repair has to supply "failed" itself rather than copy one.
 */
const PROCESS_ENDED_STATUSES = new Set([...TERMINAL_STATUSES, 'orphaned']);

/** Projection statuses that contradict a CLOSED record. */
const LIVE_STATUSES = new Set(['running', 'orphaned', 'paused', 'interrupted']);

/**
 * `unknown` is deliberately in none of the three sets above. A projection with
 * only, say, a `run.pr-verified` event says nothing about whether the run is
 * open, so pairing it with any record shape is not a finding — reporting it
 * would fill the panel with rows that have no defect behind them.
 */

/** Is this projection key a real run id, or the `agent:<id>` fallback? */
export const isAgentFallbackKey = (id) => typeof id === 'string' && id.startsWith('agent:');

/**
 * Compare one projection against one run record.
 *
 * @param {object} projection - a `projectRunStates` entry
 * @param {object|null} record - the run's `metadata.json`, or null when absent
 * @returns {{finding: string, repairable: boolean, detail: object}|null}
 */
export function diffRunRecord(projection, record) {
  if (!projection || isAgentFallbackKey(projection.id)) return null;

  if (!record) {
    // Only worth reporting once the ledger believes the run actually started.
    // A projection built solely from an annotation event (a PR verdict that
    // outlived its run) has no missing record to speak of.
    if (!projection.startedAt) return null;
    return finding('record-missing', false, { ledgerStatus: projection.status });
  }

  const recordClosed = Boolean(record.endTime);

  if (!recordClosed) {
    if (!PROCESS_ENDED_STATUSES.has(projection.status)) return null;
    return finding('record-open', true, {
      ledgerStatus: projection.status,
      ledgerEndedAt: projection.endedAt ?? projection.lastEventAt ?? null,
      ledgerSuccess: projection.status === 'orphaned' ? false : projection.success === true
    });
  }

  if (TERMINAL_STATUSES.has(projection.status)) {
    const ledgerSuccess = projection.success === true;
    const recordSuccess = record.success === true;
    if (ledgerSuccess === recordSuccess) return null;
    return finding('verdict-mismatch', false, {
      ledgerStatus: projection.status,
      ledgerSuccess,
      recordSuccess
    });
  }

  if (LIVE_STATUSES.has(projection.status)) {
    return finding('ledger-open', false, {
      ledgerStatus: projection.status,
      recordEndedAt: record.endTime
    });
  }

  return null;
}

const finding = (kind, repairable, detail) => ({ finding: kind, repairable, detail });

/**
 * Reconcile a batch of projections against the records supplied for them.
 *
 * @param {object} input
 * @param {object[]} input.projections - `projectRunStates` output
 * @param {Map<string, object|null>} input.records - runId → metadata (null = absent)
 * @returns {{findings: object[], summary: object}}
 */
export function reconcileRunRecords({ projections = [], records = new Map() } = {}) {
  const findings = [];
  let agentOnly = 0;
  let checked = 0;

  for (const projection of projections) {
    if (isAgentFallbackKey(projection?.id)) {
      agentOnly += 1;
      continue;
    }
    checked += 1;
    const record = records.get(projection.id) ?? null;
    const diff = diffRunRecord(projection, record);
    if (!diff) continue;
    findings.push({
      runId: projection.id,
      agentId: projection.agentId ?? null,
      taskId: projection.taskId ?? null,
      lastEventAt: projection.lastEventAt ?? null,
      ...diff
    });
  }

  return { findings, summary: summarize(findings, { checked, agentOnly }) };
}

/**
 * Counts, one per finding kind, always present even at zero.
 *
 * Zero-filled on purpose: a UI reading `summary['record-open']` must get `0`
 * for a healthy install rather than `undefined`, or "no drift" and "this build
 * doesn't know that finding" render identically.
 */
function summarize(findings, { checked, agentOnly }) {
  const byFinding = Object.fromEntries(RUN_RECONCILE_FINDINGS.map((kind) => [kind, 0]));
  for (const item of findings) byFinding[item.finding] += 1;
  return {
    checked,
    agentOnly,
    findings: findings.length,
    repairable: findings.filter((item) => item.repairable).length,
    byFinding
  };
}

/**
 * The metadata patch that closes an open record from its ledger projection.
 *
 * Returns null unless the pair is genuinely a `record-open` finding, so the
 * service can call this per candidate without re-deriving the diff and can
 * never write from a finding that was only informational.
 *
 * The patch carries `reconciledFromLedger` so a later reader — a human, or the
 * usage reconciler — can tell a verdict the run reported from one the ledger
 * supplied after the fact. `duration` is derived rather than copied because a
 * run whose `run.finalized` never landed has no recorded duration either.
 *
 * @param {object} projection
 * @param {object|null} record
 * @param {string} at - ISO timestamp for the repair itself
 * @returns {object|null} shallow patch to merge into metadata.json
 */
export function planRunRecordRepair(projection, record, at) {
  const diff = diffRunRecord(projection, record);
  if (!diff || diff.finding !== 'record-open') return null;

  // Prefer the ledger's own end stamp; fall back to the repair time so the
  // record is never closed with a null `endTime` (the field every other reader
  // uses as "is this run over").
  const endTime = diff.detail.ledgerEndedAt || at;
  const success = diff.detail.ledgerSuccess;
  const startedMs = Date.parse(record?.startTime ?? '');
  const endedMs = Date.parse(endTime);
  const duration = Number.isFinite(record?.duration) ? record.duration
    : (Number.isFinite(startedMs) && Number.isFinite(endedMs) && endedMs >= startedMs ? endedMs - startedMs : null);

  const patch = {
    endTime,
    duration,
    success,
    exitCode: Number.isFinite(projection.exitCode) ? projection.exitCode : (record?.exitCode ?? null),
    reconciledFromLedger: true,
    reconciledAt: at,
    reconciledFromStatus: projection.status
  };

  if (!success) {
    patch.error = record?.error || (projection.status === 'orphaned'
      ? 'Agent process terminated unexpectedly (closed by run-event reconciliation)'
      : 'Run failed (closed by run-event reconciliation)');
    patch.errorCategory = record?.errorCategory || projection.errorCategory || 'reconciled';
  }

  return patch;
}
