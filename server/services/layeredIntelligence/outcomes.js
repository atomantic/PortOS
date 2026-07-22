/**
 * Layered Intelligence — proposal outcomes & self-evaluation reports
 * (#2842 split of layeredIntelligence.js).
 *
 * Derives merged/rejected/abandoned outcomes from closed tracker issues, rolls them
 * into the merge-rate report fed back into the next prompt, and builds the
 * self-eval summary (suppressed issues, rejection reasons, LI execution health).
 */

import { DAY } from '../../lib/fileUtils.js';
import { computeEffectiveSuccessRate } from '../taskLearning/store.js';
import { formatRejectionReasons, formatRejectionReason, REJECTION_REASONS } from '../layeredIntelligenceRejections.js';
import { formatExecutionFailures } from '../layeredIntelligenceExecutionFailures.js';
import {
  LOW_MERGE_RATE_MIN_SAMPLE, LOW_MERGE_RATE_THRESHOLD, LI_DEGRADED_MIN_SAMPLE,
  LI_DEGRADED_SUCCESS_THRESHOLD, LI_HARD_GATE_EXECUTION_THRESHOLD, CLOSED_SUPPRESSION_MS,
} from './constants.js';
import { normalizeSlug, extractSlugFromBody, isIssueWithinDedupWindow } from './dedup.js';

/**
 * Derive a resolved outcome for a filed proposal from its live tracker issue.
 * Pure — the reconciler feeds it a `{ state, stateReason, closedAt }` issue:
 *   - still open (or unknown state)     → null   (unresolved)
 *   - closed as "completed"             → 'merged'
 *   - closed as "not planned"           → 'rejected'
 *   - closed with any OTHER reason       → 'abandoned' (duplicate/stale/etc. —
 *                                          counting these as merged inflated the
 *                                          merge-rate calibration signal, #2620)
 *   - closed with NO reason              → 'merged' (graceful fallback: glab/jira
 *                                          and the plan filer report no stateReason,
 *                                          and their common close path IS a merge —
 *                                          absent ≠ other, per the sentinel rule)
 * GitHub reports `stateReason` ('completed' | 'not_planned' | 'reopened' | …);
 * other trackers omit it, so a bare closed issue reads as merged.
 */
export function deriveOutcome(issue) {
  if ((issue?.state || '').toLowerCase() !== 'closed') return null;
  const reason = (issue?.stateReason || '').toLowerCase().replace(/[\s-]+/g, '_');
  if (reason === 'not_planned') return 'rejected';
  if (reason === '' || reason === 'completed') return 'merged';
  return 'abandoned';
}

/**
 * Tally a recorded-outcome list into the counts BOTH the outcomes report (#2428)
 * and the self-eval summary (#2700) reason over. Pure; the single place the
 * merge-rate math lives so the two blocks can never disagree about LI's record.
 *
 * `rawMergeRate` is measured over RESOLVED proposals only and is `null` when
 * nothing has resolved yet — the sentinel rule: "no proposal has been judged" must
 * not collapse into the same 0 as "every judged proposal was rejected". Callers
 * round only for display (rounding before a threshold compare would let 19.6%
 * read as 20% and suppress a warning that should fire).
 */
export function summarizeOutcomeStats(outcomes = []) {
  const filed = (Array.isArray(outcomes) ? outcomes : []).filter(o => o && typeof o === 'object');
  const total = filed.length;
  const count = (name) => filed.filter(o => o.outcome === name).length;
  const merged = count('merged');
  const rejected = count('rejected');
  const abandoned = count('abandoned');
  const resolved = merged + rejected + abandoned;
  return {
    filed,
    total,
    merged,
    rejected,
    abandoned,
    // Anything filed but not yet resolved — still awaiting triage, NOT a failure.
    pending: total - resolved,
    resolved,
    rawMergeRate: resolved > 0 ? (merged / resolved) * 100 : null
  };
}

/**
 * Format the LI outcome-feedback report (#2428) from this app's recorded
 * proposals + their reconciled outcomes. Pure + side-effect-free: the LI hook
 * loads the outcomes and passes them here, then feeds the string into buildPrompt.
 * Returns '' when there's nothing to report (no filed history) so the caller omits
 * the block entirely rather than injecting an empty section.
 */
export function computeOutcomesReport({ outcomes = [], hasPlannedWork = false } = {}) {
  const { filed, total, merged, rejected, abandoned, pending, resolved, rawMergeRate } =
    summarizeOutcomeStats(outcomes);
  if (total === 0) return '';
  const pct = (n) => Math.round((n / total) * 100);

  // Per-scope merge rate — the calibration signal the reasoner acts on.
  const scopes = new Map();
  for (const o of filed) {
    const s = o.scope || 'unknown';
    const agg = scopes.get(s) || { filed: 0, merged: 0 };
    agg.filed += 1;
    if (o.outcome === 'merged') agg.merged += 1;
    scopes.set(s, agg);
  }
  const scopeLines = [...scopes.entries()]
    .sort((a, b) => b[1].filed - a[1].filed)
    .map(([s, v]) => `- ${s}: ${v.filed} filed, ${v.merged} merged (${v.filed ? Math.round((v.merged / v.filed) * 100) : 0}%)`)
    .join('\n');

  // Structured diagnosis of every non-merged proposal (#2689), replacing the raw
  // tracker string this used to echo ('not_planned' merely restated the outcome).
  // '' when nothing has been closed unmerged — distinct from "closed, reason
  // unknown", which the line reports explicitly.
  const rejectionReasons = formatRejectionReasons(filed, 5);

  // Structured diagnosis of every FAILED hand-off (#2764 §1) — the "why" behind the
  // per-domain execution rate the liProposalExecution block reports (#2765). '' when
  // no hand-off has failed, so the line below is omitted rather than contradicting a
  // clean execution record.
  const executionFailures = formatExecutionFailures(filed, 5);

  // Low-merge-rate alarm (#2698). `rawMergeRate` is measured over RESOLVED
  // proposals only and is null when none have resolved — see summarizeOutcomeStats
  // for the sentinel rationale (pending ≠ rejected). A null rate stays silent
  // rather than alarming an app whose first proposal is simply still in flight.
  // The sample floor is the same idea one step further out: 0-of-1 is not evidence.
  const lowMergeWarning = (
    rawMergeRate !== null
    && resolved >= LOW_MERGE_RATE_MIN_SAMPLE
    && rawMergeRate < LOW_MERGE_RATE_THRESHOLD
  )
    ? [
      '',
      `WARNING: your merge rate is critically low — only ${merged} of ${resolved} resolved proposals (${Math.round(rawMergeRate)}%) were merged.`,
      // Only point at the plannedWork block when one was actually gathered — the
      // source is per-app-toggleable and yields nothing on an unresolvable
      // tracker, and citing a section that isn't in the prompt is just noise.
      hasPlannedWork
        ? 'Review the "plannedWork" source above: your proposals may be overlapping with work the user has already committed to. Propose only work that is clearly outside that committed backlog — and if you cannot find any, return proposal: null rather than filing something marginal.'
        : 'Your proposals may be overlapping with work the user has already committed to, or missing what they actually value. Hold a higher bar: return proposal: null rather than filing something marginal.'
    ]
    : [];

  return [
    'Recent LI proposals (all still-open, plus outcomes resolved within ~30 days):',
    `- Total filed: ${total}`,
    `- Merged/implemented: ${merged} (${pct(merged)}%)`,
    `- Rejected: ${rejected} (${pct(rejected)}%)`,
    `- Abandoned: ${abandoned} (${pct(abandoned)}%)`,
    `- Still open: ${pending} (${pct(pending)}%)`,
    '',
    'By scope:',
    scopeLines || '- (none)',
    '',
    `Why non-merged proposals were closed: ${rejectionReasons || 'nothing has been closed unmerged yet'}`,
    // Only emit the execution-failure line when a hand-off has actually failed —
    // an app whose proposals were never handed off (or all succeeded) shows nothing
    // here rather than a misleading "no failures" line.
    ...(executionFailures ? [`Why LI's own hand-offs failed when implemented: ${executionFailures}`] : []),
    ...lowMergeWarning
  ].join('\n');
}

// How many closed-but-still-suppressed proposals selfEval names before it
// summarizes the rest as a count. The block is a calibration aid, not a backlog
// dump — an unbounded list would crowd out the sources it exists to be weighed
// against, and past this many the reasoner has the pattern anyway.
export const SELF_EVAL_MAX_SUPPRESSED_LISTED = 8;

/**
 * Recover a suppressed issue's normalized dedup slug — the key the reasoner must
 * avoid re-using and the join key onto the outcome store's rejectionReason. Shapes
 * vary by tracker: forge/jira rows carry `{ number, title, body }` (the slug lives
 * in the body marker), while the `plan` filer yields bare `{ slug, state }`.
 * Normalized both ways so the value matches the outcome record's stored slug
 * (`normalizeSlug(slug)` at file time) exactly. Returns null when unrecoverable.
 */
export function suppressedIssueSlug(issue) {
  if (issue?.slug) return normalizeSlug(issue.slug);
  return normalizeSlug(extractSlugFromBody(issue?.body) || extractSlugFromBody(issue?.title));
}

/**
 * Build a `slug → rejectionReason` lookup from reconciled outcome records, so the
 * self-eval "recently closed" line can tell the reasoner not just WHICH proposals
 * to avoid but WHY each was closed — the feedback loop of #2689 (ask #4), closing
 * the loop with the taxonomy #2735 already persists rather than any new signal.
 *
 * Only a RESOLVED non-merged record carries a diagnosis, and only a REAL taxonomy
 * token (a member of REJECTION_REASONS) counts: a merged, unresolved, or
 * still-unclassified (`rejectionReason == null`) record contributes nothing, and so
 * does the `unknown-reason` SENTINEL — it means "we looked and found no signal",
 * which is not an actionable failure pattern to route around, so annotating a
 * suppressed proposal with "closed with no recorded reason" would add noise the
 * reasoner can't act on (and would contradict the promise that undiagnosed closures
 * stay unannotated). The annotation therefore appears only where a concrete reason
 * explains the closure. First diagnosed record per slug wins (records arrive
 * newest-filed-first). Pure.
 */
export function rejectionReasonBySlug(outcomes = []) {
  const map = new Map();
  for (const o of Array.isArray(outcomes) ? outcomes : []) {
    if (!o || (o.outcome !== 'rejected' && o.outcome !== 'abandoned')) continue;
    if (!REJECTION_REASONS.includes(o.rejectionReason)) continue;
    const slug = normalizeSlug(o.slug);
    if (slug && !map.has(slug)) map.set(slug, o.rejectionReason);
  }
  return map;
}

/**
 * Identify a suppressed proposal for the prompt: its slug (the actual dedup key the
 * reasoner must avoid re-using) plus its title for human-readable context. Returns
 * null when neither is recoverable — an unidentifiable entry is left to the count
 * rather than rendered as a mystery bullet the reasoner can't act on.
 *
 * When `reasonBySlug` (from rejectionReasonBySlug) holds this slug's diagnosis, it
 * is appended as glossed prose so the reasoner sees the specific failure pattern
 * that sank the earlier proposal (#2689), not merely a slug to route around. An
 * undiagnosed (null) or unmatched slug renders exactly as before.
 */
export function describeSuppressedIssue(issue, reasonBySlug = null) {
  const slug = suppressedIssueSlug(issue);
  const title = typeof issue?.title === 'string' ? issue.title.trim() : '';
  if (!slug && !title) return null;
  const ref = issue?.number ? `#${issue.number} ` : '';
  const reason = slug && reasonBySlug instanceof Map ? reasonBySlug.get(slug) : null;
  const why = reason ? ` — previously closed: ${formatRejectionReason(reason)}` : '';
  if (!slug) return `${ref}${title}${why}`.trim();
  return `${ref}[${slug}]${title ? ` ${title}` : ''}${why}`.trim();
}

/**
 * Format LI's self-evaluation block (#2700) — the loop's pre-filing quality check
 * on its OWN reasoning. Pure + side-effect-free and NO LLM call: every line is
 * derived from data the loop already has, so this never adds a provider round-trip
 * (the "no cold-bootstrap LLM calls" policy). The hook loads the inputs and feeds
 * the string to buildPrompt, exactly like computeOutcomesReport.
 *
 * Three independent self-signals, each of which is either PRESENT or explicitly
 * reported ABSENT — never silently defaulted, because "I have no data about myself"
 * and "the data says I am doing badly" demand opposite responses from the reasoner:
 *   1. Proposal merge rate      — do the user's triage decisions validate my picks?
 *   2. Already-filed proposals  — what have I said already that I must not repeat?
 *   3. LI execution health      — are my own agent runs even succeeding?
 *
 * Unlike computeOutcomesReport this ALWAYS returns a block when called: "you are
 * reasoning with no signal about yourself, hold a higher bar" is the single most
 * useful thing to tell a cold loop, so an empty-handed run is exactly when the
 * block matters most.
 *
 * @param {Object} args
 * @param {Array|null} args.outcomes - recorded proposals; `null` = NOT gathered
 *   (source off / outcomes-incapable tracker), `[]` = gathered and genuinely none.
 * @param {Array|null} args.existingIssues - LI-labeled tracker issues; `null` = the
 *   tracker read FAILED or never ran, `[]` = read fine and LI has filed nothing.
 *   The caller MUST pass null on a failed read: readIssues returns `[]` for a blown
 *   read, which would otherwise read as "nothing filed" and license a re-file.
 * @param {{ read: boolean, metrics: Object|null }|null} args.liTaskStats - from
 *   readLiTaskMetrics. `null`/`read:false` = the learning store was unreadable;
 *   `read:true, metrics:null` = read fine and LI has simply never run a task.
 * @param {number} [args.now] - clock seam for the suppression window.
 * @returns {string} the liSelfEval block body.
 */
/**
 * Resolve LI's own EXECUTION HEALTH — the loop's reasoning-run success rate — into a
 * single structured read, so every consumer (the selfEval Signal 3 line AND the hard
 * exclusion gate, #2824) judges LI's health off the SAME number instead of each
 * re-deriving it and risking drift. Reads the LI-task metrics bucket
 * (readLiTaskMetrics) through the effective (recency-windowed-or-lifetime) success
 * rate, exactly as Signal 3 did inline.
 *
 * @param {{ read: boolean, metrics: Object|null }|null} liTaskStats - from
 *   readLiTaskMetrics. `null`/`read:false` = the learning store was unreadable;
 *   `read:true, metrics:null` = read fine and LI has simply never run a task.
 * @param {{ now?: number }} [opts] - clock seam forwarded to computeEffectiveSuccessRate.
 * @returns {{ rate: number|null, sample: number, source: string|null, confident: boolean }}
 *   `rate` is null when health is UNKNOWN (store unreadable, no runs, or no completed
 *   runs). `confident` is true only at >= LI_DEGRADED_MIN_SAMPLE runs — the floor
 *   below which a rate (0-of-1 vs 0-of-N) is not yet evidence.
 */
export function computeLiExecutionHealth(liTaskStats = null, { now = Date.now() } = {}) {
  if (!liTaskStats?.read || !liTaskStats.metrics) {
    return { rate: null, sample: 0, source: null, confident: false };
  }
  const { successRate, source, windowedCompleted } = computeEffectiveSuccessRate(liTaskStats.metrics, { now });
  if (successRate === null) return { rate: null, sample: 0, source: null, confident: false };
  const sample = source === 'windowed' ? windowedCompleted : (liTaskStats.metrics.completed || 0);
  return { rate: successRate, sample, source, confident: sample >= LI_DEGRADED_MIN_SAMPLE };
}

export function computeSelfEvalSummary({
  outcomes = null,
  existingIssues = null,
  liTaskStats = null,
  now = Date.now()
} = {}) {
  const lines = [];

  // --- Signal 1: does the user actually merge what I propose? -----------------
  let mergeSignal = false;
  if (!Array.isArray(outcomes)) {
    lines.push('- Proposal merge rate: UNAVAILABLE — no outcome history was gathered this run (the outcomes source is off, or this tracker cannot report outcomes). You cannot see how your past proposals fared; do not assume they went well.');
  } else {
    const { total, merged, resolved, rawMergeRate, filed } = summarizeOutcomeStats(outcomes);
    if (total === 0) {
      lines.push('- Proposal merge rate: no proposals filed yet for this app — you have no track record here to calibrate against.');
    } else if (rawMergeRate === null) {
      lines.push(`- Proposal merge rate: ${total} filed, none resolved yet — rate unknown. Awaiting triage is NOT rejection; do not read this as failure.`);
    } else {
      mergeSignal = resolved >= LOW_MERGE_RATE_MIN_SAMPLE;
      // Same structured diagnosis as computeOutcomesReport (#2689) — one helper, so
      // the two blocks can never disagree about why proposals were closed. Gated on
      // the formatted string, not on `rejected`, because an `abandoned` proposal is
      // also a non-merge worth explaining.
      const reasons = formatRejectionReasons(filed, 3);
      lines.push(
        `- Proposal merge rate: ${merged} of ${resolved} resolved proposals merged (${Math.round(rawMergeRate)}%)`
        + `${resolved < LOW_MERGE_RATE_MIN_SAMPLE ? ' — too small a sample to read a rate from yet' : ''}.`
        + (reasons ? ` Why the rest were closed: ${reasons}.` : '')
      );
    }
  }

  // --- Signal 2: what have I already said? (dedup awareness) ------------------
  let trackerSignal = false;
  if (!Array.isArray(existingIssues)) {
    lines.push('- Your already-filed proposals: UNKNOWN — the tracker could not be read this run. You may be about to re-file something that already exists; hold a higher bar than usual.');
  } else {
    trackerSignal = true;
    const open = existingIssues.filter(i => (i?.state || '').toLowerCase() === 'open');
    // Closed but still inside the 30-day suppression window: re-proposing one of
    // these gets deterministically dropped downstream, so spending the run on it is
    // a wasted run. Surfaced so the reasoner can route around it BEFORE proposing.
    const closedSuppressed = existingIssues.filter(i =>
      (i?.state || '').toLowerCase() !== 'open' && isIssueWithinDedupWindow(i, now));
    lines.push(
      `- Your already-filed proposals: ${open.length} open`
      + `${closedSuppressed.length ? `, plus ${closedSuppressed.length} closed but still within the ${Math.round(CLOSED_SUPPRESSION_MS / DAY)}-day suppression window` : ''}.`
      + ` ${open.length + closedSuppressed.length
        ? 'Re-proposing any of these is deterministically suppressed — the run is wasted. Propose something genuinely new.'
        : 'Nothing is currently suppressed.'}`
    );
    // NAME the closed-but-suppressed ones. The open proposals are already listed in
    // full elsewhere in the prompt, but a closed issue appears NOWHERE else — so
    // without this the reasoner is told a number it cannot act on and can burn the
    // whole run re-proposing something the dedup guard silently drops. Capped so a
    // long tail can't crowd out the sources it is meant to be reasoning about.
    if (closedSuppressed.length) {
      // Join each suppressed proposal to its reconciled rejection reason (#2689),
      // so the "do NOT re-propose" line also carries WHY each was closed — a
      // no-extra-cost read of the outcome records selfEval already received. Empty
      // when outcomes weren't gathered this run (`outcomes` not an array), leaving
      // the line exactly as before.
      const reasonBySlug = rejectionReasonBySlug(Array.isArray(outcomes) ? outcomes : []);
      const named = closedSuppressed
        .map(i => describeSuppressedIssue(i, reasonBySlug))
        .filter(Boolean)
        .slice(0, SELF_EVAL_MAX_SUPPRESSED_LISTED);
      if (named.length) {
        lines.push(
          `  Recently closed (do NOT re-propose): ${named.join('; ')}`
          + `${closedSuppressed.length > named.length ? ` (+${closedSuppressed.length - named.length} more)` : ''}`
        );
      }
    }
  }

  // --- Signal 3: is the LI machinery itself healthy? --------------------------
  // Deliberately GLOBAL, not per-app: the learning store keys LI runs by task type
  // alone, so this bucket aggregates the loop's runs across every app. That is the
  // right scope for the question being asked — "is the LI machinery working?" is a
  // property of the shared loop, not of the app it happens to be pointed at — and
  // it mirrors the cosMetrics source, which is likewise install-wide.
  let taskSignal = false;
  let liDegraded = false;
  if (!liTaskStats?.read) {
    lines.push('- LI execution health: UNAVAILABLE — the CoS learning store could not be read.');
  } else if (!liTaskStats.metrics) {
    lines.push('- LI execution health: no LI runs recorded yet — this loop has no execution history.');
  } else {
    // Forward the clock seam via the shared helper (computeLiExecutionHealth), which
    // the hard exclusion gate (#2824) reads too — so the DEGRADED line and the gate can
    // never disagree about LI's own success rate. Without `now` computeEffectiveSuccessRate
    // would read the real wall clock while the suppression-window branch above uses the
    // injected one — the same summary reasoning against two different "nows".
    const health = computeLiExecutionHealth(liTaskStats, { now });
    if (health.rate === null) {
      lines.push('- LI execution health: no completed LI runs recorded yet — success rate unknown.');
    } else {
      taskSignal = health.confident;
      liDegraded = taskSignal && health.rate < LI_DEGRADED_SUCCESS_THRESHOLD;
      lines.push(
        `- LI execution health: ${health.rate}% of ${health.sample} ${health.source} LI runs succeeded`
        + `${taskSignal ? '' : ' — too small a sample to judge'}${liDegraded ? ' — DEGRADED' : ''}.`
      );
    }
  }

  // --- Confidence: how much do I actually know about myself? ------------------
  // Purely a count of PRESENT signals — it rates the evidence available to the
  // reasoner, NOT whether that evidence is flattering. A loop with a well-measured
  // 0% merge rate has HIGH confidence in a bad result, which is precisely the state
  // where it should act decisively rather than hedge.
  const signalCount = [mergeSignal, trackerSignal, taskSignal].filter(Boolean).length;
  const confidence = signalCount >= 3 ? 'high' : signalCount === 2 ? 'medium' : 'low';

  const guidance = [];
  if (confidence === 'low') {
    guidance.push(
      '',
      `GUIDANCE — low self-confidence (${signalCount} of 3 self-signals available): you are reasoning about this app with little evidence about your own track record. Do NOT compensate by proposing something speculative or sweeping. Prefer a small, concretely-grounded proposal you can justify from the gathered sources alone, and return proposal: null rather than filing a guess.`
    );
  }
  if (liDegraded) {
    guidance.push(
      '',
      `GUIDANCE — your own execution is degraded (LI run success is under ${LI_DEGRADED_SUCCESS_THRESHOLD}%): the problem may be THIS LOOP, not the app. Favor a narrowly-scoped, low-risk app-improvement / app-data-gap proposal that a coding agent can finish, and do not mark anything trivial+safe for hand-off while your runs are failing this often. Self-improve-scoped work (loop-meta / portos-self) is HARD-EXCLUDED while your execution health is below ${LI_HARD_GATE_EXECUTION_THRESHOLD}% (#2824): a degraded loop cannot repair itself, so that work is deferred to a human — return proposal: null rather than filing it.`
    );
  }

  return [
    'LI self-evaluation (deterministic — computed from this loop\'s own record, not a model\'s opinion):',
    `- Reasoning confidence: ${confidence} (${signalCount} of 3 self-signals available)`,
    ...lines,
    ...guidance
  ].join('\n');
}
