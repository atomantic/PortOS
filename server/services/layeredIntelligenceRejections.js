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
 */

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

/**
 * Render one token as prose for the reasoner. An unglossed token passes through;
 * a nullish (unclassified) input renders as '' — mapping it onto the sentinel
 * would invert this module's central rule by dressing "not classified" up as
 * "classified, and we found nothing".
 */
export function formatRejectionReason(reason) {
  if (!reason) return '';
  return REJECTION_REASON_LABELS[reason] || reason;
}

// Normalize a tracker token (label name or stateReason) for matching: lowercased,
// with separators collapsed so `not_planned`, `not-planned` and `Not Planned` all
// land on the same key.
function normalizeToken(value) {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/[\s_-]+/g, '-') : '';
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
// confident wrong diagnosis feeding the reasoner a fabricated pattern.
const CLOSING_COMMENT_PATTERNS = [
  {
    reason: 'scope-mismatch',
    patterns: [
      /\bout[\s-]?of[\s-]?scope\b/,
      /\b(?:outside|beyond|not in|not within) (?:the |our |its )?scope\b/,
      /\bnot (?:in|within) scope\b/,
      /\bdoes ?n[o']?t (?:fit|belong)\b/,
      /\bwo ?n[o']?t fit\b/,
      /\bnot (?:aligned|a (?:good )?fit)\b/,
      /\bnot something (?:we|this app|the app)\b/
    ]
  },
  {
    reason: 'missing-context',
    patterns: [
      /\b(?:need|needs|needing|require[sd]?) (?:more|additional|further) (?:info|information|context|detail|details|clarification)\b/,
      /\b(?:not enough|insufficient|lack(?:s|ing)? (?:of )?) (?:info|information|context|detail|details)\b/,
      /\b(?:cannot|can'?t|could ?n'?t|couldn'?t|unable to) reproduce\b/,
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
 * Signal precedence (most authoritative first): a human-applied label, then the
 * tracker's close reason, then the deterministic closing-comment keyword pass
 * (#2748). Explicit signals a human/agent deliberately set outrank a prose
 * heuristic, so the comment scan only decides an otherwise-undiagnosed close.
 *
 * Deterministic and total: same inputs always yield the same token.
 */
export function classifyRejection({ outcome = null, stateReason = null, labels = [], closingComment = null } = {}) {
  // Only a resolved, non-merged proposal has a rejection to explain.
  if (outcome !== 'rejected' && outcome !== 'abandoned') return null;

  // A human-applied label is the most specific signal available; first match wins
  // in the tracker's own label order.
  for (const label of Array.isArray(labels) ? labels : []) {
    const hit = LABEL_REASONS.get(normalizeToken(label));
    if (hit) return hit;
  }

  // The tracker's own close reason (GitHub only) outranks free-text prose.
  const stateHit = STATE_REASON_REASONS.get(normalizeToken(stateReason));
  if (stateHit) return stateHit;

  // Last resort before the honest unknown: scan the closing-comment prose for a
  // rationale a human stated without a matching label/close reason.
  const commentHit = classifyClosingComment(closingComment);
  if (commentHit) return commentHit;

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
export function summarizeRejectionReasons(outcomes = []) {
  const counts = new Map();
  let unknown = 0;
  let unclassified = 0;
  for (const o of Array.isArray(outcomes) ? outcomes : []) {
    if (!o || (o.outcome !== 'rejected' && o.outcome !== 'abandoned')) continue;
    const reason = o.rejectionReason;
    if (reason === UNKNOWN_REJECTION_REASON) { unknown += 1; continue; }
    // Absent OR unrecognized (hand-edited, or a token from a newer version): both
    // mean we hold no valid diagnosis for a proposal that demonstrably didn't merge.
    if (!REJECTION_REASONS.includes(reason)) { unclassified += 1; continue; }
    counts.set(reason, (counts.get(reason) || 0) + 1);
  }
  const entries = [...counts.entries()]
    // Commonest first; ties broken by taxonomy order so the output is stable
    // rather than dependent on Map insertion (i.e. on record ordering).
    .sort((a, b) => b[1] - a[1] || REJECTION_REASONS.indexOf(a[0]) - REJECTION_REASONS.indexOf(b[0]))
    .map(([reason, count]) => ({ reason, count }));
  const diagnosed = entries.reduce((n, e) => n + e.count, 0);
  return { entries, unknown, unclassified, diagnosed, total: diagnosed + unknown + unclassified };
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
  const { entries, unknown, unclassified, total } = summarizeRejectionReasons(outcomes);
  if (total === 0) return '';
  const listed = entries
    .slice(0, limit)
    .map(({ reason, count }) => `${formatRejectionReason(reason)} (${count})`)
    .join('; ');
  // Name every gap: "3 of 3 closed with no recorded reason" is a real, actionable
  // fact about the loop's own blind spot, and the honest line when it's all we have.
  const gaps = [
    unknown ? `${unknown} of ${total} closed with no recorded reason` : '',
    unclassified ? `${unclassified} of ${total} not yet classified` : ''
  ];
  return [listed, ...gaps].filter(Boolean).join(' — ');
}
