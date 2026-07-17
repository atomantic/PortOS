/**
 * Layered Intelligence rejection taxonomy + classifier (#2689).
 *
 * `deriveOutcome` (layeredIntelligence.js) answers *whether* a filed proposal was
 * merged, rejected, or abandoned. It does not answer *why* — the store's
 * `outcomeReason` slot held whatever raw string the tracker happened to report
 * (GitHub's `not_planned`, or the literal filler `auto-derived from tracker state`
 * on trackers that report nothing). That is unusable as a feedback signal: the
 * reasoner was told "common rejection reasons: not_planned", which restates the
 * outcome rather than diagnosing it.
 *
 * This module owns the structured vocabulary and the deterministic mapping onto
 * it. Pure, no I/O, no LLM call — every token is derived from data the reconciler
 * already holds, so classification never adds a provider round-trip (the
 * "no cold-bootstrap LLM calls" policy) and never adds a tracker fetch.
 *
 * A LEAF module by design: it imports nothing from the LI graph, so both
 * `layeredIntelligence.js` (which formats the reports) and
 * `layeredIntelligenceOutcomes.js` (which persists the classification) can use it
 * without an import cycle.
 */

// The rejection-reason vocabulary. Stored on the outcome record and rendered into
// the reasoner's prompt, so these tokens are a persisted contract: rename one and
// old records fail the sanitizer's membership check and re-classify (which is the
// designed self-heal, but it discards history — prefer adding over renaming).
//
// Only the tokens marked (live) are reachable from the tracker-state signals the
// reconciler has today. The rest are declared now because they are the vocabulary
// this taxonomy is meant to express, and because the sanitizer must already accept
// them: a later PR that classifies from closing comments or from the implementing
// PR's checks can then persist them WITHOUT a record-shape migration. Every
// unreachable token is populated today only by an explicit tracker label.
export const REJECTION_REASONS = [
  // (live) stateReason `duplicate`, or a duplicate/dupe label.
  'duplicate',
  // (live) GitHub's "closed as not planned", or a wontfix/declined label — a human
  // looked at it and said no.
  'user-rejected',
  // Label-only today. Needs closing-comment analysis to fire on its own.
  'scope-mismatch',
  'missing-context',
  'quality-issue',
  'environment-blocker',
  // Label-only today. These are properties of the PR that IMPLEMENTS a proposal,
  // and LI tracks proposals as issues — it has no PR handle to read checks from.
  'merge-conflict',
  'validation-failed'
];

/**
 * The explicit "we classified this and found no signal" sentinel. NOT a member of
 * REJECTION_REASONS: it is the absence of a diagnosis, not a diagnosis. Kept
 * distinct from a `null` rejectionReason, which means "not classified yet" —
 * conflating the two would either hide the data gap this issue exists to measure
 * or re-classify the same record forever. See sanitizeOutcomeRecord.
 */
export const UNKNOWN_REJECTION_REASON = 'unknown-reason';

// Every value the store may legitimately hold in `rejectionReason` for a
// non-merged proposal.
export const REJECTION_REASON_VALUES = [...REJECTION_REASONS, UNKNOWN_REJECTION_REASON];

// Human-readable gloss, used to render the prompt blocks. A token with no gloss
// degrades to the raw token rather than being dropped.
const REJECTION_REASON_LABELS = {
  'duplicate': 'already tracked elsewhere (duplicate)',
  'user-rejected': 'the user declined it (closed as not planned)',
  'scope-mismatch': "outside the app's scope",
  'missing-context': 'missing context the proposal should have supplied',
  'quality-issue': 'the proposal itself was low quality or malformed',
  'environment-blocker': 'blocked on the environment or a dependency',
  'merge-conflict': 'the implementing change could not be merged',
  'validation-failed': 'the implementing change failed lint/validation',
  [UNKNOWN_REJECTION_REASON]: 'closed with no recorded reason'
};

/** Render one token as prose for the reasoner. Unknown tokens pass through. */
export function formatRejectionReason(reason) {
  return REJECTION_REASON_LABELS[reason] || reason || UNKNOWN_REJECTION_REASON;
}

// Normalize a tracker token (label name or stateReason) for matching: lowercased,
// with separators collapsed so `not_planned`, `not-planned` and `Not Planned` all
// land on the same key.
function normalizeToken(value) {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/[\s_-]+/g, '-') : '';
}

// Label → reason. Labels are a deliberate human act, so they outrank the generic
// stateReason: `not_planned` + a `duplicate` label is a duplicate, not a bare
// user rejection. Keys are normalizeToken'd; add conventions here rather than
// teaching callers to pre-map.
const LABEL_REASONS = new Map(Object.entries({
  'duplicate': 'duplicate',
  'dupe': 'duplicate',
  'wontfix': 'user-rejected',
  'declined': 'user-rejected',
  'not-planned': 'user-rejected',
  'out-of-scope': 'scope-mismatch',
  'scope-mismatch': 'scope-mismatch',
  'needs-input': 'missing-context',
  'needs-info': 'missing-context',
  'incomplete': 'missing-context',
  'invalid': 'quality-issue',
  'quality-issue': 'quality-issue',
  'blocked': 'environment-blocker',
  'layered-intelligence:blocking': 'environment-blocker',
  'environment-blocker': 'environment-blocker',
  'merge-conflict': 'merge-conflict',
  'conflict': 'merge-conflict',
  'validation-failed': 'validation-failed',
  'ci-failure': 'validation-failed'
}));

// stateReason → reason. Only GitHub reports one; `completed`/absent never reach
// here because the caller classifies non-merged outcomes only.
const STATE_REASON_REASONS = new Map(Object.entries({
  'not-planned': 'user-rejected',
  'duplicate': 'duplicate'
}));

/**
 * Classify WHY a filed proposal ended up not merged.
 *
 * Returns:
 *   - `null` for a merged or still-unresolved proposal — there is no rejection to
 *     diagnose. Never invent one: a merged jira/plan proposal (whose tracker
 *     reports no stateReason at all) must not acquire a rejection reason just
 *     because the signals are empty.
 *   - a REJECTION_REASONS token when a tracker signal supports it.
 *   - UNKNOWN_REJECTION_REASON when the proposal was demonstrably not merged but
 *     no signal explains it. This is the honest answer and the metric the issue
 *     asks for — "how much of our rejection history is undiagnosed" — so it must
 *     never be silently dressed up as a real reason.
 *
 * Deterministic and total: same inputs always yield the same token.
 */
export function classifyRejection({ outcome = null, stateReason = null, labels = [] } = {}) {
  // Only a resolved, non-merged proposal has a rejection to explain.
  if (outcome !== 'rejected' && outcome !== 'abandoned') return null;

  // A human-applied label is the most specific signal available; first match wins
  // in the tracker's own label order.
  for (const label of Array.isArray(labels) ? labels : []) {
    const hit = LABEL_REASONS.get(normalizeToken(label));
    if (hit) return hit;
  }

  return STATE_REASON_REASONS.get(normalizeToken(stateReason)) || UNKNOWN_REJECTION_REASON;
}

/**
 * Tally rejection reasons across an outcome list.
 *
 * Counts only non-merged RESOLVED records: a pending proposal is awaiting triage,
 * not rejected. Records with no stored classification (`null` — merged, or written
 * before the taxonomy existed) are counted in neither bucket; they are unclassified
 * data, not a measured gap, and folding them into `unknown` would overstate the gap
 * this metric exists to track.
 *
 * Returns `{ entries, unknown, diagnosed, total }`:
 *   - `entries`  — `[{ reason, count }]` of REAL diagnoses only, commonest first.
 *   - `unknown`  — records classified as `unknown-reason` (the data gap).
 *   - `diagnosed`— records carrying a real diagnosis (sum of `entries`).
 *   - `total`    — `diagnosed + unknown`, i.e. every classified record.
 * `unknown` is kept OUT of `entries` so it can't crowd real diagnoses out of a
 * caller's top-N list — it is the measure of missing data, not a finding.
 */
export function summarizeRejectionReasons(outcomes = []) {
  const counts = new Map();
  let unknown = 0;
  for (const o of Array.isArray(outcomes) ? outcomes : []) {
    if (!o || (o.outcome !== 'rejected' && o.outcome !== 'abandoned')) continue;
    const reason = o.rejectionReason;
    if (reason === UNKNOWN_REJECTION_REASON) { unknown += 1; continue; }
    if (!REJECTION_REASONS.includes(reason)) continue;
    counts.set(reason, (counts.get(reason) || 0) + 1);
  }
  const entries = [...counts.entries()]
    // Commonest first; ties broken by taxonomy order so the output is stable
    // rather than dependent on Map insertion (i.e. on record ordering).
    .sort((a, b) => b[1] - a[1] || REJECTION_REASONS.indexOf(a[0]) - REJECTION_REASONS.indexOf(b[0]))
    .map(([reason, count]) => ({ reason, count }));
  const diagnosed = entries.reduce((n, e) => n + e.count, 0);
  return { entries, unknown, diagnosed, total: diagnosed + unknown };
}

/**
 * Render a tally as one prompt line: the commonest `limit` diagnoses, glossed,
 * plus the undiagnosed share when there is one.
 *
 * Returns '' when NOTHING is classified, so the caller omits the line rather than
 * emitting "rejection reasons: none" — which reads as "nothing was ever rejected"
 * when the truth may be "we don't know why anything was".
 */
export function formatRejectionReasons(outcomes = [], limit = 3) {
  const { entries, unknown, total } = summarizeRejectionReasons(outcomes);
  if (total === 0) return '';
  const listed = entries
    .slice(0, limit)
    .map(({ reason, count }) => `${formatRejectionReason(reason)} (${count})`)
    .join('; ');
  // Always name the gap: a run that can only say "3 of 3 closed with no recorded
  // reason" is reporting a real, actionable fact about its own blind spot.
  const gap = unknown ? `${unknown} of ${total} closed with no recorded reason` : '';
  return [listed, gap].filter(Boolean).join(' — ');
}
