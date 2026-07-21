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
 * it. Pure, no I/O, no LLM call — every classifier here derives its token from data
 * handed to it, so classification never adds a provider round-trip (the
 * "no cold-bootstrap LLM calls" policy). One signal, the implementing-PR failure
 * (#2748, deliverable 2), needs a `gh pr view` read the pure classifiers can't do —
 * the RECONCILER owns that I/O (bounded to non-merged proposals that carry a PR ref
 * and whose free signals left them undiagnosed) and passes the resolved token in, so
 * this module stays pure.
 *
 * A LEAF module by design: it imports nothing from the LI graph, so both
 * `layeredIntelligence.js` (which formats the reports) and
 * `layeredIntelligenceOutcomes.js` (which persists the classification) can use it
 * without an import cycle.
 *
 * KNOWN LIMITATION — label-only closures on trackers with no close reason.
 * Classification runs only on an outcome `deriveOutcome` already called non-merged,
 * and that fallback maps a closed issue with NO `stateReason` to `merged` (glab and
 * jira never report one, and their ordinary close IS a merge). So a GitLab issue
 * closed with a bare `wontfix` label reads as merged and is never classified — its
 * label signal is wasted, and it inflates the merge rate.
 *
 * Fixing it is NOT as simple as letting labels override the merged fallback: the
 * map below mixes labels that state a FINAL DISPOSITION (`wontfix`, `duplicate`,
 * `declined`, `out-of-scope` — the issue is over, and this is why) with labels that
 * describe a STATE THE ISSUE PASSED THROUGH (`blocked`, `needs-input`, `invalid`,
 * `conflict`). Only the first group can justify overriding `merged`; a stale
 * `blocked` label left on a genuinely completed GitLab issue would otherwise flip it
 * to rejected and corrupt the merge rate in the opposite direction — worse than the
 * gap it closes. The fix therefore needs a disposition/state split here plus a
 * change to `deriveOutcome`'s merge-rate semantics (#2620's territory), so it is
 * deliberately left to a follow-up rather than bolted on. Tracked on #2689.
 *
 * The tally + top-N-line render engine (the commonest-first sort with a
 * taxonomy-order tie-break, the three-bucket `{entries, unknown, unclassified,
 * diagnosed, total}` discipline, and `normalizeToken`) lives in the shared leaf
 * `lib/taxonomyTally.js` (#2800); this module supplies only the vocabulary, gloss
 * maps, and classifiers.
 */

import {
  normalizeToken,
  formatTaxonomyToken,
  createTaxonomyTally
} from '../lib/taxonomyTally.js';

// The rejection-reason vocabulary. Stored on the outcome record and rendered into
// the reasoner's prompt, so these tokens are a persisted contract: rename one and
// old records fail the sanitizer's membership check and re-classify (which is the
// designed self-heal, but it discards history — prefer adding over renaming).
//
// Only the tokens marked (live) are reachable from the signals the reconciler has
// today. The rest are declared now because they are the vocabulary this taxonomy
// is meant to express, and because the sanitizer must already accept them: a later
// PR that classifies from the implementing PR's checks can then persist them
// WITHOUT a record-shape migration.
export const REJECTION_REASONS = [
  // (live) stateReason `duplicate`, or a duplicate/dupe label.
  'duplicate',
  // (live) GitHub's "closed as not planned", or a wontfix/declined label — a human
  // looked at it and said no.
  'user-rejected',
  // (live) An explicit tracker label, OR the deterministic closing-comment keyword
  // pass (#2748) — a human who declined in prose without applying a matching label.
  'scope-mismatch',
  'missing-context',
  'quality-issue',
  // Label-only today.
  'environment-blocker',
  // (live) From a human-applied label, OR the implementing-PR state read (#2748,
  // deliverable 2): these are properties of the PR that IMPLEMENTS a proposal, and
  // LI tracks proposals as issues. The reconciler now threads the implementing-PR ref
  // (`closedByPullRequestsReferences`, additive/null-default) and reads its merge
  // state / checks via `classifyPrFailure`, so a conflicted or CI-failed implementing
  // PR is reachable without a record-shape migration.
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

/**
 * Render one token as prose for the reasoner. An unglossed token passes through;
 * a nullish (unclassified) input renders as '' — mapping it onto the sentinel
 * would invert this module's central rule by dressing "not classified" up as
 * "classified, and we found nothing".
 */
export function formatRejectionReason(reason) {
  return formatTaxonomyToken(reason, REJECTION_REASON_LABELS);
}

// Label → reason. Every key here must be a label that states a JUDGEMENT ABOUT THE
// PROPOSAL'S MERIT — by a human, or by another agent that actually assessed it.
// That is what earns labels their precedence over the generic stateReason
// (`not_planned` + a `duplicate` label is a duplicate, not a bare user rejection),
// and `needs-input` qualifies even though an agent applies it: it is a finding that
// the proposal under-specified itself, which is exactly `missing-context`.
//
// LI's OWN BOOKKEEPING must never appear here, however suggestive it looks. LI
// stamps `layered-intelligence:blocking` on its proposals to record that the loop
// is paused there (applyBlockingLabel ← the reasoner's `pause.blockOnIssue`), and
// `layered-intelligence` to mark authorship — neither says anything about why a
// proposal failed. Mapping the blocking label to `environment-blocker` would
// outrank a real `not_planned` close and feed the loop "blocked on the environment"
// when the user simply declined: LI corrupting the very signal this taxonomy exists
// to produce, through its own marker. The `blocked` / `environment-blocker` entries
// below carry that meaning legitimately because someone diagnosed the proposal to
// apply them.
//
// Keys are normalizeToken'd; add conventions here rather than teaching callers to
// pre-map.
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

// stateReason → reason. Only GitHub reports one; `completed`/absent never reach
// here because the caller classifies non-merged outcomes only.
const STATE_REASON_REASONS = new Map(Object.entries({
  'not-planned': 'user-rejected',
  'duplicate': 'duplicate'
}));

// Diagnoses that name only THAT a proposal was declined, not WHY — GitHub's
// generic `not_planned` close. A specific closing-comment rationale is allowed to
// refine one of these into a precise taxonomy token (not_planned + "out of scope"
// → scope-mismatch); a SPECIFIC close reason (duplicate) is never refined. The
// refinement changes only the reason token, never the OUTCOME (deriveOutcome has
// already fixed that), so the merge rate the reasoner calibrates on is untouched.
const GENERIC_REJECTION_REASONS = new Set(['user-rejected']);

/**
 * The reasons a PR-state read (#2748, deliverable 2) is ALLOWED to refine: the honest
 * `unknown-reason` and the generic user-rejection. A SPECIFIC diagnosis — a
 * scope/quality/duplicate label, a `duplicate` close reason, or a closing-comment
 * rationale — already states WHY, so the reconciler skips the `gh pr view` round-trip
 * for those (the read is bounded to the records prFailure could actually change).
 *
 * The gate is intentionally coarse: `user-rejected` also comes from a `wontfix`/
 * `declined` LABEL, not only the generic `not_planned` state, and this predicate can't
 * tell those apart from the reason token alone. So a labeled-wontfix record that also
 * carries a PR ref pays one superfluous fetch — but NOT a wrong diagnosis: on the
 * refine pass, `classifyRejection`'s step-1 label precedence returns `user-rejected`
 * before it ever reaches the step-4 `prFailure`, so the human's label still wins and
 * the stored token is unchanged. Distinguishing label- from state-derived
 * `user-rejected` here would need threading the signal source through, which isn't
 * worth it to save a bounded, harmless round-trip.
 */
export function isPrRefinableReason(reason) {
  return reason === UNKNOWN_REJECTION_REASON || GENERIC_REJECTION_REASONS.has(reason);
}

// PR-check verdicts that mean the implementing change FAILED validation. gh's
// statusCheckRollup mixes CheckRun (`conclusion`) and StatusContext (`state`) rows;
// both are normalized to upper-case and tested against this set. Deliberately
// conservative — CANCELLED/SKIPPED/NEUTRAL are ambiguous (superseded runs, opt-out
// checks) and excluded, so a miss falls through to the honest `unknown-reason`
// rather than a fabricated validation-failed.
const FAILED_CHECK_VERDICTS = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'STARTUP_FAILURE', 'ACTION_REQUIRED']);

/**
 * Classify why the PR that was meant to IMPLEMENT a proposal failed, from a
 * `gh pr view --json state,mergeStateStatus,statusCheckRollup` read (#2748,
 * deliverable 2). Pure, total, deterministic — the reconciler owns the I/O and hands
 * the parsed object here. Returns a REJECTION_REASONS token, or null when the PR
 * merged or nothing indicates a failure (→ the caller keeps the honest fallback).
 *
 *   - `merge-conflict`    — the branch could not be merged (`mergeStateStatus` DIRTY).
 *                           GitHub only computes mergeability while the PR is open, so
 *                           this fires on an open/last-known-dirty PR; it is checked
 *                           first because a conflicted branch is the more fundamental
 *                           blocker than a failed check on top of it.
 *   - `validation-failed` — a required check reported a failing verdict. Readable even
 *                           on a CLOSED (abandoned) PR from its last recorded rollup,
 *                           which is the common terminal state for a proposal whose
 *                           implementing PR was given up on.
 *
 * A MERGED PR is never a failure (returns null): if it merged, the proposal's outcome
 * is `merged` and there is no rejection to diagnose.
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

// The REJECTION_REASONS subset that classifyPrFailure produces (#2748, deliverable 2).
// Once a record carries one of these it was already diagnosed from its implementing
// PR's state, so re-reading that PR on a later reconcile can only reproduce the same
// token — the reconciler consults this to STOP re-spawning `gh pr view` for an
// already-settled PR diagnosis on every scheduler tick across the 30-day retention.
export const PR_FAILURE_REASONS = ['merge-conflict', 'validation-failed'];

/** Whether `reason` is a PR-state-derived diagnosis (merge-conflict / validation-failed). */
export function isPrFailureReason(reason) {
  return PR_FAILURE_REASONS.includes(reason);
}

// Closing-comment keyword pass (#2748). Some closures state their rationale only in
// prose — a human declines in a comment without applying a matching label or (on
// glab/jira) any close reason at all. This is a DETERMINISTIC keyword/heuristic
// scan of that prose, NOT an LLM call: it adds no provider round-trip (the
// "no cold-bootstrap LLM" policy) and no tracker fetch beyond the comment text the
// reconciler already read.
//
// It is deliberately a LAST-RESORT signal, weaker than a label or a close reason:
// classifyRejection consults it only when both of those miss. Free text is noisier
// than a label a human deliberately applied, so it must never override one. Groups
// are ordered and the FIRST group with any match wins, so the order below is the
// tiebreak when one comment trips more than one bucket — most-specific intent
// (scope) before the vaguer quality catch-all. Patterns are conservative: a miss
// (→ null → the honest `unknown-reason`) is the correct failure, better than a
// confident wrong diagnosis feeding the reasoner a fabricated pattern. There is no
// negation handling — a keyword pass can't reliably parse "not out of scope" — so
// patterns favor phrasings that read unambiguously when they appear; the safety net
// is that this only ever refines an already-decided rejection, never the outcome.
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

/**
 * Classify a rejection rationale from the closing comment's TEXT. Pure, total,
 * deterministic: same string always yields the same token. Returns a
 * REJECTION_REASONS token, or null when no keyword matched (a nullish/blank comment
 * included) so the caller can fall through to the honest `unknown-reason`.
 */
export function classifyClosingComment(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  // Lowercase + collapse whitespace so a rationale split across newlines still
  // matches multi-word patterns.
  const normalized = text.toLowerCase().replace(/\s+/g, ' ');
  for (const { reason, patterns } of CLOSING_COMMENT_PATTERNS) {
    for (const re of patterns) {
      if (re.test(normalized)) return reason;
    }
  }
  return null;
}

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
 * Signal precedence (most authoritative first):
 *   1. a human-applied label (the most deliberate signal);
 *   2. a SPECIFIC tracker close reason (duplicate);
 *   3. the deterministic closing-comment keyword pass (#2748);
 *   4. an implementing-PR failure token (#2748, deliverable 2) — a mechanical fact
 *      about the PR that was meant to implement the proposal (`merge-conflict` /
 *      `validation-failed`), pre-resolved by the reconciler from a `gh pr view` read;
 *   5. a GENERIC tracker close reason (GitHub `not_planned` → user-rejected: it
 *      says the proposal was declined, but not why).
 * The comment and the PR-failure both sit BELOW a label/specific reason but ABOVE the
 * generic decline, so each REFINES a bare not_planned into a precise token instead of
 * being shadowed by it. The PR-failure sits below the closing comment on purpose: a
 * human who stated a rationale in prose ("out of scope") outranks the mechanical fact
 * that the implementing PR happened to have a conflict — the PR-failure only speaks
 * for the records a human left otherwise undiagnosed. Every refinement changes only
 * the reason token, never the outcome deriveOutcome already fixed, so none can move
 * the merge rate. The pass NEVER overrides the merged fallback (deriveOutcome runs
 * first and never reaches here for a merge), so the reasonless-close-reads-as-merged
 * gap the module header documents is untouched.
 *
 * Deterministic and total: same inputs always yield the same token.
 */
export function classifyRejection({ outcome = null, stateReason = null, labels = [], closingComment = null, prFailure = null } = {}) {
  // Only a resolved, non-merged proposal has a rejection to explain.
  if (outcome !== 'rejected' && outcome !== 'abandoned') return null;

  // 1. A human-applied label is the most specific signal available; first match
  //    wins in the tracker's own label order.
  for (const label of Array.isArray(labels) ? labels : []) {
    const hit = LABEL_REASONS.get(normalizeToken(label));
    if (hit) return hit;
  }

  // 2. A SPECIFIC tracker close reason (duplicate) outranks free-text prose.
  const stateHit = STATE_REASON_REASONS.get(normalizeToken(stateReason));
  if (stateHit && !GENERIC_REJECTION_REASONS.has(stateHit)) return stateHit;

  // 3. The closing-comment keyword pass — refines a generic decline, or diagnoses a
  //    close whose (abandoned) reason isn't otherwise recognized.
  const commentHit = classifyClosingComment(closingComment);
  if (commentHit) return commentHit;

  // 4. The implementing-PR failure (#2748, deliverable 2) — only a member of
  //    REJECTION_REASONS is honoured, so a caller can't inject a foreign token.
  if (prFailure && REJECTION_REASONS.includes(prFailure)) return prFailure;

  // 5. The generic close reason, when nothing more specific named the rationale.
  if (stateHit) return stateHit;

  return UNKNOWN_REJECTION_REASON;
}

/**
 * Tally rejection reasons across every non-merged RESOLVED proposal. A pending
 * proposal is awaiting triage, not rejected, and a merged one has nothing to
 * explain — neither is counted.
 *
 * Returns `{ entries, unknown, unclassified, diagnosed, total }`:
 *   - `entries`      — `[{ reason, count }]` of REAL diagnoses only, commonest first.
 *   - `unknown`      — classified as `unknown-reason`: we looked and no signal
 *                      explained it. A MEASURED gap.
 *   - `unclassified` — no valid diagnosis stored at all: written before the taxonomy
 *                      existed, or reconcile hasn't reached it yet. An UNMEASURED
 *                      gap — a different fact from `unknown`, with a different
 *                      remedy (reconcile it vs. enrich the signals).
 *   - `diagnosed`    — records carrying a real diagnosis (sum of `entries`).
 *   - `total`        — every non-merged resolved proposal: the full population being
 *                      diagnosed. `total === 0` means, and only means, "nothing has
 *                      been closed unmerged".
 *
 * The three buckets stay apart for the same reason the record field is three-valued:
 * collapsing them would either fabricate a diagnosis or hide the data gap this
 * metric exists to track. `unknown`/`unclassified` stay OUT of `entries` so they
 * can't crowd real diagnoses out of a caller's top-N list — they measure missing
 * data, they are not findings.
 */
// The shared tally + render engine, bound to the rejection taxonomy. The counting
// rules, commonest-first sort, taxonomy-order tie-break, three-bucket discipline,
// and top-N-line render live in `lib/taxonomyTally.js` (#2800); this module supplies
// only the population predicate, the stored-token accessor, the vocabulary/sentinel,
// the gloss, and the gap wording.
const rejectionTally = createTaxonomyTally({
  predicate: (o) => o.outcome === 'rejected' || o.outcome === 'abandoned',
  select: (o) => o.rejectionReason,
  field: 'reason',
  vocabulary: REJECTION_REASONS,
  sentinel: UNKNOWN_REJECTION_REASON,
  glossFn: formatRejectionReason,
  gapWording: {
    // "3 of 3 closed with no recorded reason" is a real, actionable fact about the
    // loop's own blind spot, and the honest line when it's all we have.
    unknown: (n, total) => `${n} of ${total} closed with no recorded reason`,
    unclassified: (n, total) => `${n} of ${total} not yet classified`
  }
});

/**
 * Tally rejection reasons across every non-merged RESOLVED proposal. A pending
 * proposal is awaiting triage, not rejected, and a merged one has nothing to
 * explain — neither is counted.
 *
 * Returns `{ entries, unknown, unclassified, diagnosed, total }`:
 *   - `entries`      — `[{ reason, count }]` of REAL diagnoses only, commonest first.
 *   - `unknown`      — classified as `unknown-reason`: we looked and no signal
 *                      explained it. A MEASURED gap.
 *   - `unclassified` — no valid diagnosis stored at all: written before the taxonomy
 *                      existed, or reconcile hasn't reached it yet. An UNMEASURED
 *                      gap — a different fact from `unknown`, with a different
 *                      remedy (reconcile it vs. enrich the signals).
 *   - `diagnosed`    — records carrying a real diagnosis (sum of `entries`).
 *   - `total`        — every non-merged resolved proposal: the full population being
 *                      diagnosed. `total === 0` means, and only means, "nothing has
 *                      been closed unmerged".
 *
 * The three buckets stay apart for the same reason the record field is three-valued:
 * collapsing them would either fabricate a diagnosis or hide the data gap this
 * metric exists to track. `unknown`/`unclassified` stay OUT of `entries` so they
 * can't crowd real diagnoses out of a caller's top-N list — they measure missing
 * data, they are not findings.
 */
export function summarizeRejectionReasons(outcomes = []) {
  return rejectionTally.summarize(outcomes);
}

/**
 * Render a tally as one prompt line: the commonest `limit` diagnoses, glossed,
 * followed by whichever gaps are non-zero.
 *
 * Returns '' ONLY when nothing has been closed unmerged, so a caller may safely read
 * '' as "there is nothing to explain". It must never fall silent merely because the
 * closures are undiagnosed: a report that says "Rejected: 2" and then "nothing has
 * been closed unmerged yet" is a self-contradiction, and staying quiet about a gap
 * is exactly the blindness this taxonomy exists to remove.
 */
export function formatRejectionReasons(outcomes = [], limit = 3) {
  return rejectionTally.format(outcomes, limit);
}
