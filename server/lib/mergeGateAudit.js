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

const isGreen = (check, mergedMs) => check.status === 'completed' && GREEN_CONCLUSIONS.has(String(check.conclusion || '').toLowerCase())
  && mergedMs !== null && time(check.completed_at) !== null && time(check.completed_at) <= mergedMs;

/**
 * Reduce the forge's check-run and commit-status history for a head to one
 * record per check, as the merge saw it.
 *
 * A rerun adds an attempt rather than replacing one, and a status context is
 * re-posted in place, so the newest record can postdate the merge. Each check's
 * attempts are dated by when they existed: a run's first attempt by its suite's
 * creation (a run queued before the merge may not start until well after it), a
 * rerun by its start, a status by its post time. A check none of whose attempts
 * existed at `mergedAt` was never something the merge could wait for. Of the rest,
 * an attempt that was green before the merge stands for the check; otherwise the
 * newest attempt does, so a head still red (or fixed only after the merge) is
 * reported as it now stands.
 *
 * Forge timestamps on both sides, so no clock-skew allowance applies.
 *
 * @param {object} evidence
 * @param {Array<{id?: number, name?: string, status?: string, conclusion?: string|null, suite?: number, started_at?: string|null, completed_at?: string|null}>} evidence.runs every attempt (`filter=all`)
 * @param {Array<{id?: number, created_at?: string|null}>} evidence.suites
 * @param {Array<{context?: string, state?: string, created_at?: string|null}>} evidence.statuses every status posted, in any order
 * @param {string} mergedAt
 * @returns {Array<{name: string, status: string, conclusion: string|null, completed_at: string|null}>}
 */
export function foldHeadChecks({ runs, suites, statuses }, mergedAt) {
  const mergedMs = time(mergedAt);
  const suiteCreated = new Map(suites.map((suite) => [suite.id, time(suite.created_at)]));
  const groups = new Map();
  const add = (key, attempt) => groups.set(key, [...(groups.get(key) || []), attempt]);

  for (const run of [...runs].sort((a, b) => (a.id ?? 0) - (b.id ?? 0))) {
    const key = `run:${run.suite}:${run.name}`;
    const first = !groups.has(key);
    const created = suiteCreated.get(run.suite) ?? null;
    const at = first ? created : (time(run.started_at) ?? created);
    add(key, { at, check: { name: run.name, status: run.status, conclusion: run.conclusion ?? null, completed_at: run.completed_at ?? null } });
  }
  const orderedStatuses = statuses.map((status, index) => ({ status, index, at: time(status.created_at) }))
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || b.index - a.index);
  for (const { status, at } of orderedStatuses) {
    add(`status:${status.context}`, { at, check: {
      name: status.context,
      status: status.state === 'pending' ? 'in_progress' : 'completed',
      conclusion: status.state === 'error' ? 'failure' : status.state,
      completed_at: status.created_at ?? null,
    } });
  }

  const folded = [];
  for (const attempts of groups.values()) {
    const existing = attempts.filter((attempt) => attempt.at === null || mergedMs === null || attempt.at <= mergedMs);
    if (existing.length === 0) continue;
    const atMerge = existing[existing.length - 1].check;
    folded.push(isGreen(atMerge, mergedMs) ? atMerge : attempts[attempts.length - 1].check);
  }
  return folded;
}

/**
 * Classify a merged head's folded checks (`foldHeadChecks`) against the moment it merged.
 *
 * Absent and empty are different: `checks === null` means the forge could not be
 * read, and no verdict is possible. An empty list is a repository with no CI on
 * that head, which has nothing to wait for.
 *
 * @param {Array<{name?: string, status?: string, conclusion?: string|null, completed_at?: string|null}>|null} checks
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
    if (!completed) settled = false;
    if (completed && RED_CONCLUSIONS.has(String(check?.conclusion || '').toLowerCase())) failing.push(name);
    if (!isGreen(check || {}, mergedMs)) notGreenAtMerge.push(name);
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

const sameHandoff = (receipt, prUrl, headSha) => String(receipt?.prUrl || '').toLowerCase() === String(prUrl || '').toLowerCase()
  && String(receipt?.headSha || '').toLowerCase() === String(headSha || '').toLowerCase();

/**
 * Was this PR handed to the pending-merge coordinator without the coordinator
 * having recorded a merge of it? The coordinator marks its receipt just after
 * its merge call succeeds, so within that window an unmarked receipt cannot yet
 * tell the coordinator's merge from the run's own.
 */
export function awaitsCoordinatorMark({ receipts = [], prUrl, headSha }) {
  const matching = receipts.filter((receipt) => sameHandoff(receipt, prUrl, headSha));
  return matching.length > 0 && !matching.some((receipt) => receipt.coordinatorMergedAt);
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
 * @param {string} input.prUrl the audited PR; a head can back several PRs (main and a release branch)
 * @param {Array<{prUrl?: string, headSha?: string, coordinatorMergedAt?: string}>} [input.receipts] handoff receipts recorded on the run
 * @param {Array<object>} [input.history]
 * @param {object|null} [input.heldLease]
 * @param {Array<object>|null} input.checks check runs of the merged head; null when unreadable
 * @returns {{ exempt: boolean, violations: Array<{code: string, message: string}>, checks: ReturnType<typeof classifyHeadChecks> }}
 */
export function assessMergeGate({ repository, prUrl, headSha, mergedAt, receipts = [], history = [], heldLease = null, checks }) {
  const classification = classifyHeadChecks(checks, mergedAt);
  if (receipts.some((receipt) => receipt?.coordinatorMergedAt && sameHandoff(receipt, prUrl, headSha))) {
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
