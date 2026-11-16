/**
 * Layered Intelligence rejection taxonomy + classifier.
 *
 * `deriveOutcome` says whether a proposal was merged, rejected or abandoned; this
 * module owns the structured vocabulary for why, and the deterministic mapping onto
 * it. Pure, no I/O, no LLM call (the "no cold-bootstrap LLM calls" policy). The
 * implementing-PR failure signal needs a `gh pr view` read; the reconciler owns that
 * I/O and passes the resolved token in.
 *
 * A LEAF module: imports nothing from the LI graph so `layeredIntelligence.js` and
 * `layeredIntelligenceOutcomes.js` can both use it without a cycle.
 *
 * KNOWN LIMITATION: classification runs only on outcomes `deriveOutcome` already called
 * non-merged, and that maps a closed issue with NO `stateReason` to `merged` (glab and
 * jira never report one). So a GitLab issue closed with a bare `wontfix` label reads as
 * merged and is never classified. Letting labels override the merged fallback is not
 * safe: the label map mixes FINAL DISPOSITION labels (`wontfix`, `duplicate`,
 * `declined`, `out-of-scope`) with labels for a STATE THE ISSUE PASSED THROUGH
 * (`blocked`, `needs-input`, `invalid`, `conflict`), and a stale `blocked` on a
 * completed issue would corrupt the merge rate the other way. The fix needs a
 * disposition/state split plus a `deriveOutcome` change. Tracked on #2689.
 *
 * The tally + render engine lives in the shared leaf `lib/taxonomyTally.js`; this
 * module supplies the vocabulary, gloss maps, and classifiers.
 */

import { REJECTION_REASON_LABELS } from '../lib/layeredIntelligenceRejectionLabels.js';
import {
  normalizeToken,
  formatTaxonomyToken,
  createTaxonomyTally
} from '../lib/taxonomyTally.js';

// The rejection-reason vocabulary. Persisted on outcome records and rendered into the
// reasoner's prompt: renaming a token makes old records fail the sanitizer's membership
// check and re-classify (discarding history), so prefer adding. Declared tokens the
// reconciler can't yet produce must still be accepted by the sanitizer.
export const REJECTION_REASONS = [
  // stateReason `duplicate`, or a duplicate/dupe label.
  'duplicate',
  // GitHub's "closed as not planned", or a wontfix/declined label.
  'user-rejected',
  // An explicit tracker label, or the closing-comment keyword pass.
  'scope-mismatch',
  'missing-context',
  'quality-issue',
  // Label-only.
  'environment-blocker',
  // A human-applied label, or the implementing-PR state read (`classifyPrFailure`):
  // properties of the PR that implements a proposal.
  'merge-conflict',
  'validation-failed'
];

/**
 * Sentinel: "classified, found no signal". NOT a member of REJECTION_REASONS and distinct
 * from a `null` rejectionReason ("not classified yet"); conflating them would hide the
 * data gap or re-classify the same record forever. See sanitizeOutcomeRecord.
 */
export const UNKNOWN_REJECTION_REASON = 'unknown-reason';

// Every value the store may hold in `rejectionReason` for a non-merged proposal.
// non-merged proposal.
export const REJECTION_REASON_VALUES = [...REJECTION_REASONS, UNKNOWN_REJECTION_REASON];

// Glosses (REJECTION_REASON_LABELS, shared with the client) render the prompt blocks;
// an unglossed token degrades to the raw token.

/** Render one token as prose. Nullish (unclassified) renders '' — never the sentinel, which would dress "not classified" up as "found nothing". */
export function formatRejectionReason(reason) {
  return formatTaxonomyToken(reason, REJECTION_REASON_LABELS);
}

// Label -> reason. Keys must be labels stating a JUDGEMENT ABOUT THE PROPOSAL'S MERIT
// (by a human or an agent that assessed it); that earns them precedence over the generic
// stateReason. `needs-input` qualifies: the proposal under-specified itself.
//
// LI's OWN BOOKKEEPING must never appear here: `layered-intelligence:blocking` records
// that the loop is paused and `layered-intelligence` marks authorship; mapping them
// would outrank a real `not_planned` close and corrupt the signal. Keys are
// normalizeToken'd; add conventions here rather than pre-mapping in callers.
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
  'environment-blocker': 'environment-blocker',
  'merge-conflict': 'merge-conflict',
  'conflict': 'merge-conflict',
  'validation-failed': 'validation-failed',
  'ci-failure': 'validation-failed'
}));

// stateReason -> reason. Only GitHub reports one; `completed`/absent never reach here.
const STATE_REASON_REASONS = new Map(Object.entries({
  'not-planned': 'user-rejected',
  'duplicate': 'duplicate'
}));

// Diagnoses naming only THAT a proposal was declined (GitHub's generic `not_planned`).
// A closing-comment rationale may refine these; a specific close reason (duplicate)
// is never refined. Refinement changes only the token, never the outcome.
const GENERIC_REJECTION_REASONS = new Set(['user-rejected']);

/**
 * Reasons a PR-state read is ALLOWED to refine: `unknown-reason` and the generic
 * user-rejection. A specific diagnosis already states why, so the reconciler skips the
 * `gh pr view` round-trip. Intentionally coarse: `user-rejected` also comes from a
 * `wontfix` LABEL, costing one superfluous fetch, but never a wrong diagnosis since
 * `classifyRejection`'s label precedence wins before `prFailure`.
 */
export function isPrRefinableReason(reason) {
  return reason === UNKNOWN_REJECTION_REASON || GENERIC_REJECTION_REASONS.has(reason);
}

// PR-check verdicts meaning the implementing change FAILED validation. gh's
// statusCheckRollup mixes CheckRun (`conclusion`) and StatusContext (`state`); both are
// upper-cased. Conservative: CANCELLED/SKIPPED/NEUTRAL are ambiguous and excluded so a
// miss yields `unknown-reason`, not a fabricated validation-failed.
const FAILED_CHECK_VERDICTS = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'STARTUP_FAILURE', 'ACTION_REQUIRED']);

/**
 * Classify why the PR meant to IMPLEMENT a proposal failed, from a
 * `gh pr view --json state,mergeStateStatus,statusCheckRollup` read. Pure and total.
 * Returns a REJECTION_REASONS token, or null when merged or no failure is indicated.
 *
 *   - `merge-conflict`    — `mergeStateStatus` DIRTY. Checked first: a conflicted
 *                           branch is the more fundamental blocker.
 *   - `validation-failed` — a check reported a failing verdict; readable on a CLOSED PR
 *                           from its last recorded rollup.
 *
 * A MERGED PR is never a failure.
 */
export function classifyPrFailure(prView) {
  if (!prView || typeof prView !== 'object') return null;
  if (String(prView.state || '').toUpperCase() === 'MERGED') return null;
  if (String(prView.mergeStateStatus || '').toUpperCase() === 'DIRTY') return 'merge-conflict';
  const rollup = Array.isArray(prView.statusCheckRollup) ? prView.statusCheckRollup : [];
  for (const check of rollup) {
    const verdict = String(check?.conclusion || check?.state || '').toUpperCase();
    if (FAILED_CHECK_VERDICTS.has(verdict)) return 'validation-failed';
  }
  return null;
}

// The REJECTION_REASONS subset classifyPrFailure produces. A record carrying one was
// already diagnosed, so the reconciler stops re-spawning `gh pr view` for it.
export const PR_FAILURE_REASONS = ['merge-conflict', 'validation-failed'];

/** Whether `reason` is a PR-state-derived diagnosis (merge-conflict / validation-failed). */
export function isPrFailureReason(reason) {
  return PR_FAILURE_REASONS.includes(reason);
}

// Closing-comment keyword pass: a deterministic scan (NOT an LLM call) of prose for
// closures that state their rationale only in a comment. A LAST-RESORT signal, weaker
// than a label or close reason; classifyRejection consults it only when both miss.
// The FIRST group with a match wins, so order is the tiebreak (specific scope before the
// vague quality catch-all). Patterns are conservative: a miss (-> `unknown-reason`) beats
// a confident wrong diagnosis. No negation handling, so patterns favor unambiguous phrasings.
const CLOSING_COMMENT_PATTERNS = [
  {
    reason: 'scope-mismatch',
    patterns: [
      /\bout[\s-]?of[\s-]?scope\b/,
      /\b(?:outside|beyond|not in|not within) (?:the |our |its )?scope\b/,
      /\bnot (?:in|within) scope\b/,
      /\bdoes ?n[o']?t (?:fit|belong)\b/,
      /\bwo ?n[o']?t fit\b/,
      /\bnot (?:aligned|a (?:good )?fit)\b/
    ]
  },
  {
    reason: 'missing-context',
    patterns: [
      /\b(?:need|needs|needing|require[sd]?) (?:more|additional|further) (?:info|information|context|detail|details|clarification)\b/,
      /\b(?:not enough|insufficient|lack(?:s|ing)?(?: of)?) (?:info|information|context|detail|details)\b/,
      /\b(?:can ?not|cannot|can'?t|could ?not|could ?n'?t|couldn'?t|unable to) reproduce\b/,
      /\bunder[\s-]?specified\b/,
      /\bplease clarify\b/,
      /\bmore (?:details|information|context) (?:needed|required)\b/,
      /\btoo vague\b/,
      /\bunclear\b/
    ]
  },
  {
    reason: 'quality-issue',
    patterns: [
      /\blow[\s-]?quality\b/,
      /\bpoorly (?:written|specified|thought|scoped)\b/,
      /\bmalformed\b/,
      /\bdoes ?n[o']?t make sense\b/,
      /\bnot actionable\b/,
      /\bhallucinat/,
      /\b(?:nonsense|incoherent|gibberish)\b/,
      /\bspam\b/
    ]
  }
];

/** Classify a rationale from closing-comment TEXT. Pure; returns a REJECTION_REASONS token or null when nothing matched. */
export function classifyClosingComment(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  // Collapse whitespace so rationale split across newlines matches multi-word patterns.
  const normalized = text.toLowerCase().replace(/\s+/g, ' ');
  for (const { reason, patterns } of CLOSING_COMMENT_PATTERNS) {
    for (const re of patterns) {
      if (re.test(normalized)) return reason;
    }
  }
  return null;
}

/**
 * Classify WHY a filed proposal ended up not merged. Returns `null` for a merged or
 * unresolved proposal (never invent a rejection), a REJECTION_REASONS token when a signal
 * supports it, else UNKNOWN_REJECTION_REASON (the honest answer; never dress it up).
 *
 * Precedence, most authoritative first: (1) human-applied label; (2) SPECIFIC tracker
 * close reason (duplicate); (3) closing-comment keyword pass; (4) implementing-PR failure
 * token, below the comment so a human's stated rationale outranks a mechanical conflict;
 * (5) GENERIC close reason (`not_planned` -> user-rejected). Refinements change only the
 * token, never the outcome, so none moves the merge rate.
 */
export function classifyRejection({ outcome = null, stateReason = null, labels = [], closingComment = null, prFailure = null } = {}) {
  if (outcome !== 'rejected' && outcome !== 'abandoned') return null;

  // 1. First label match wins in the tracker's own order.
  for (const label of Array.isArray(labels) ? labels : []) {
    const hit = LABEL_REASONS.get(normalizeToken(label));
    if (hit) return hit;
  }

  // 2. A specific close reason outranks free-text prose.
  const stateHit = STATE_REASON_REASONS.get(normalizeToken(stateReason));
  if (stateHit && !GENERIC_REJECTION_REASONS.has(stateHit)) return stateHit;

  // 3. Closing-comment keyword pass.
  const commentHit = classifyClosingComment(closingComment);
  if (commentHit) return commentHit;

  // 4. Implementing-PR failure; only a REJECTION_REASONS member is honoured.
  if (prFailure && REJECTION_REASONS.includes(prFailure)) return prFailure;

  // 5. Generic close reason.
  if (stateHit) return stateHit;

  return UNKNOWN_REJECTION_REASON;
}

// Shared tally + render engine (lib/taxonomyTally.js) bound to the rejection taxonomy.
const rejectionTally = createTaxonomyTally({
  predicate: (o) => o.outcome === 'rejected' || o.outcome === 'abandoned',
  select: (o) => o.rejectionReason,
  field: 'reason',
  vocabulary: REJECTION_REASONS,
  sentinel: UNKNOWN_REJECTION_REASON,
  glossFn: formatRejectionReason,
  gapWording: {
    // Honest line when no reasons are recorded.
    unknown: (n, total) => `${n} of ${total} closed with no recorded reason`,
    unclassified: (n, total) => `${n} of ${total} not yet classified`
  }
});

/** Tally rejection reasons across non-merged RESOLVED proposals into `{ entries, unknown, unclassified, diagnosed, total }`.
 *
 *   - `entries`      — `[{ reason, count }]` of real diagnoses, commonest first.
 *   - `unknown`      — classified `unknown-reason`: a MEASURED gap.
 *   - `unclassified` — no valid diagnosis stored: an UNMEASURED gap (reconcile it).
 *   - `diagnosed`    — sum of `entries`.
 *   - `total`        — every non-merged resolved proposal; 0 means nothing closed unmerged.
 *
 * `unknown`/`unclassified` stay OUT of `entries` so they cannot crowd real diagnoses out of
 * a top-N list.
 */
export function summarizeRejectionReasons(outcomes = []) {
  return rejectionTally.summarize(outcomes);
}

/**
 * Render a tally as one prompt line: top `limit` diagnoses, glossed, then non-zero gaps.
 * Returns '' ONLY when nothing was closed unmerged; never silent about undiagnosed gaps.
 */
export function formatRejectionReasons(outcomes = [], limit = 3) {
  return rejectionTally.format(outcomes, limit);
}
