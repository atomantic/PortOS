/**
 * Pure verdicts for the post-merge gate audit (#12549).
 *
 * The merge-admission lease and the "required CI is green" rule are prompt
 * instructions; an agent with full forge access can still merge around them.
 * Given what the forge reports about a merged head and what PortOS recorded
 * about the run's admission leases, these functions decide whether the merge
 * respected both gates. No I/O: `services/mergeGateAudit.js` gathers the inputs.
 */

export const MERGE_GATE_VIOLATIONS = Object.freeze({
  NO_ADMISSION_LEASE: 'no-admission-lease',
  CHECKS_NOT_GREEN_AT_MERGE: 'checks-not-green-at-merge',
});

// Lease timestamps are local, `mergedAt` is the forge's clock; tolerate drift
// without letting a merge made well outside the hold pass as covered.
export const LEASE_CLOCK_SKEW_MS = 30 * 1000;
// Agent leases hold at most 5 minutes (`AGENT_LEASE_MAX_HOLD_MS`): past that a
// holder must re-acquire, so a merge later than this is not covered. It also
// bounds when a legacy `lastMergeAdmission` (release time only) began.
const LEASE_MAX_HOLD_MS = 5 * 60 * 1000;

const GREEN_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);
const RED_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure']);

const time = (value) => {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

/**
 * Classify a merged head's check runs against the moment it merged.
 *
 * Absent and empty are different: `checks === null` means the forge could not be
 * read, and no verdict is possible. An empty list is a repository with no CI on
 * that head, which has nothing to wait for.
 *
 * @param {Array<{name?: string, status?: string, conclusion?: string|null, started_at?: string|null, completed_at?: string|null}>|null} checks
 * @param {string} mergedAt
 * @returns {{ readable: boolean, notGreenAtMerge: string[], failing: string[], settled: boolean }}
 */
export function classifyHeadChecks(checks, mergedAt) {
  if (!Array.isArray(checks)) return { readable: false, notGreenAtMerge: [], failing: [], settled: false };
  const mergedMs = time(mergedAt);
  const notGreenAtMerge = [];
  const failing = [];
  let settled = true;
  for (const check of checks) {
    const name = String(check?.name || 'unnamed check');
    const completed = check?.status === 'completed';
    const conclusion = String(check?.conclusion || '').toLowerCase();
    if (!completed) settled = false;
    if (completed && RED_CONCLUSIONS.has(conclusion)) failing.push(name);
    // A run created after the merge (a push workflow on the merge commit, a manual
    // rerun) was never something the merge could have waited for.
    const startedMs = time(check?.started_at);
    if (startedMs !== null && mergedMs !== null && startedMs > mergedMs + LEASE_CLOCK_SKEW_MS) continue;
    const completedMs = time(check?.completed_at);
    const greenBeforeMerge = completed && GREEN_CONCLUSIONS.has(conclusion)
      && mergedMs !== null && completedMs !== null && completedMs <= mergedMs;
    if (!greenBeforeMerge) notGreenAtMerge.push(name);
  }
  return { readable: true, notGreenAtMerge, failing, settled };
}

/** One agent-lease interval, whatever shape recorded it. */
function leaseInterval(entry) {
  const releasedMs = time(entry?.releasedAt);
  if (releasedMs === null) return null;
  const acquiredMs = time(entry?.acquiredAt) ?? releasedMs - LEASE_MAX_HOLD_MS;
  return { repository: entry?.repository, outcome: entry?.outcome, acquiredMs, releasedMs };
}

/**
 * Did the run hold the repository's merge-admission lease at `mergedAt`?
 *
 * @param {object} evidence
 * @param {string} evidence.repository
 * @param {string} evidence.mergedAt
 * @param {Array<object>} [evidence.history] released leases (`mergeAdmissionHistory` and the legacy `lastMergeAdmission`)
 * @param {{repository?: string, acquiredAt?: string}|null} [evidence.heldLease] a lease the run still holds
 */
function leaseCoversMerge({ repository, mergedAt, history = [], heldLease = null }) {
  const mergedMs = time(mergedAt);
  if (mergedMs === null) return false;
  if (heldLease?.repository === repository) {
    const acquiredMs = time(heldLease.acquiredAt);
    if (acquiredMs !== null && acquiredMs <= mergedMs + LEASE_CLOCK_SKEW_MS && mergedMs <= acquiredMs + LEASE_MAX_HOLD_MS + LEASE_CLOCK_SKEW_MS) return true;
  }
  return history.some((entry) => {
    const lease = leaseInterval(entry);
    return lease && lease.repository === repository && lease.outcome === 'merged'
      && lease.acquiredMs <= mergedMs + LEASE_CLOCK_SKEW_MS && lease.releasedMs >= mergedMs - LEASE_CLOCK_SKEW_MS
      && mergedMs <= lease.acquiredMs + LEASE_MAX_HOLD_MS + LEASE_CLOCK_SKEW_MS;
  });
}

/**
 * Judge one merged claim PR.
 *
 * A head the pending-merge coordinator merged under its own admission is never
 * flagged. Only a receipt the coordinator marked `coordinatorMergedAt` when its
 * own merge call succeeded counts: a bare handoff proves nothing about who
 * merged, and a run that merged around the queue leaves its receipt unmarked.
 *
 * @param {object} input
 * @param {string} input.repository
 * @param {string} input.headSha
 * @param {string} input.mergedAt
 * @param {Array<{headSha?: string, coordinatorMergedAt?: string}>} [input.receipts] handoff receipts recorded on the run
 * @param {Array<object>} [input.history]
 * @param {object|null} [input.heldLease]
 * @param {Array<object>|null} input.checks check runs of the merged head; null when unreadable
 * @returns {{ exempt: boolean, violations: Array<{code: string, message: string}>, checks: ReturnType<typeof classifyHeadChecks> }}
 */
export function assessMergeGate({ repository, headSha, mergedAt, receipts = [], history = [], heldLease = null, checks }) {
  const classification = classifyHeadChecks(checks, mergedAt);
  const head = String(headSha || '').toLowerCase();
  if (receipts.some((receipt) => receipt?.coordinatorMergedAt && String(receipt.headSha || '').toLowerCase() === head)) {
    return { exempt: true, violations: [], checks: classification };
  }
  const violations = [];
  if (!leaseCoversMerge({ repository, mergedAt, history, heldLease })) {
    violations.push({
      code: MERGE_GATE_VIOLATIONS.NO_ADMISSION_LEASE,
      message: 'merged without holding the repository merge-admission lease',
    });
  }
  if (classification.notGreenAtMerge.length > 0) {
    violations.push({
      code: MERGE_GATE_VIOLATIONS.CHECKS_NOT_GREEN_AT_MERGE,
      message: `merged before ${classification.notGreenAtMerge.length} check(s) on the head finished green`,
    });
  }
  return { exempt: false, violations, checks: classification };
}
