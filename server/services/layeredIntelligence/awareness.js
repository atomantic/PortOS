/**
 * Layered Intelligence — scope / execution awareness reports
 * (#2842 split of layeredIntelligence.js).
 *
 * The avoid/prefer signals derived from task-learning metrics and proposal
 * execution outcomes, the propose-well-but-execute-poorly cross-reference, and the
 * deterministic hand-off routing decision (auto-hand-off vs file-for-human).
 */

import { EFFECTIVE_RATE_MIN_WINDOW_SAMPLES } from '../taskLearning/store.js';
import { summarizeExecutionFailures, formatExecutionFailure } from '../layeredIntelligenceExecutionFailures.js';
import {
  SCOPE_AWARENESS_MAX_TYPE_LEN, SCOPE_AWARENESS_MAX_PER_LIST, SCOPE_AWARENESS_MIN_SAMPLE,
  SCOPE_AVOID_SUCCESS_THRESHOLD, SCOPE_PREFER_SUCCESS_THRESHOLD,
  PROPOSAL_OUTCOMES, PROPOSAL_EXECUTION_OUTCOMES, PROPOSAL_EXECUTION_MIN_SAMPLE,
} from './constants.js';

/**
 * Clamp a task-type / proposal-domain label so one pathological key (e.g. a mission
 * task type embedding an unbounded mission name) can't blow the scope-awareness block
 * budget. Shared by both avoid/prefer signals below.
 */
export function clampScopeLabel(label) {
  return label.length > SCOPE_AWARENESS_MAX_TYPE_LEN
    ? `${label.slice(0, SCOPE_AWARENESS_MAX_TYPE_LEN - 1)}…`
    : label;
}

/**
 * Render an avoid/prefer prompt block from pre-classified item lists — the presentation
 * both scope-awareness signals share (#2760 install-wide task-type rates, #2765
 * per-proposal-domain execution rates). Owns the sort (worst-first avoid, best-first
 * prefer), the per-list cap + "…and N more" overflow, and the empty-guard, so a tweak
 * to any of those lands in one place. Callers supply their own classified `avoid`/
 * `prefer` lists, the per-item `fmt`, and the two headers — the only parts that
 * legitimately differ between the two signals. Returns '' when both lists are empty.
 */
function renderAvoidPreferSections({ avoid = [], prefer = [], fmt, avoidHeader, preferHeader }) {
  if (!avoid.length && !prefer.length) return '';
  avoid.sort((a, b) => a.rate - b.rate);  // worst-first — sharpest signal at the top
  prefer.sort((a, b) => b.rate - a.rate); // best-first
  const section = (header, items) => {
    const shown = items.slice(0, SCOPE_AWARENESS_MAX_PER_LIST);
    const more = items.length - shown.length;
    const lines = shown.map(fmt);
    if (more > 0) lines.push(`- …and ${more} more`);
    return `${header}\n${lines.join('\n')}`;
  };
  const sections = [];
  if (avoid.length) sections.push(section(avoidHeader, avoid));
  if (prefer.length) sections.push(section(preferHeader, prefer));
  return sections.join('\n\n');
}

/**
 * Scope-awareness report (#2760). Classifies each CoS task TYPE by its completion rate
 * into low-completion and high-completion lists, as directional context for the
 * reasoner. Pure — takes the already-parsed per-type metrics map (the `summary`
 * gatherSources builds from learning.byTaskType) and returns a report string, or ''
 * when no type has enough runs to qualify either way.
 *
 * IMPORTANT (codex P1): this is per-task-TYPE, install-wide completion telemetry — NOT
 * a per-proposal execution record. An LI proposal is later implemented through a
 * claim/plan/handoff task whose task type does NOT carry the proposal's domain (a
 * handoff becomes `internal-task`; a claimed issue runs under the claim task type), so
 * these buckets are populated by independently-scheduled jobs, not by LI's own
 * proposals bucketed by subject. The block is therefore framed as "work of this KIND
 * tends to (not) get finished here" — useful directional context (especially LI's own
 * reasoning-run type, self-improve:layered-intelligence, which IS LI's execution) — and
 * deliberately NOT a claim that a given proposal maps 1:1 onto a listed type. Proper
 * per-proposal-domain outcome correlation is tracked as a follow-up (#2765).
 *
 * `metricsByType[type] = { lifetimeSuccessRate, lifetimeCompleted, recentSuccessRate, recentCompleted, ... }`.
 *
 * Classification judges on the EFFECTIVE rate — the recency-windowed rate when the
 * window has enough samples, else lifetime — NOT the raw lifetime rate. This matters
 * for the issue's "dynamic adjustment" requirement: the lifetime rate barely decays
 * (an old failure burst depresses it near-permanently), so a scope that has actually
 * recovered would stay stuck on the avoid list for dozens of runs. Using the windowed
 * rate lets a recovered scope leave "avoid" promptly — and, critically, this uses the
 * SAME window floor as the scheduler's own skip logic
 * (EFFECTIVE_RATE_MIN_WINDOW_SAMPLES, the threshold in computeEffectiveSuccessRate /
 * isSkipCandidate): the window is trusted only at >= that many in-window runs, so a
 * single noisy recent result can't flip a lifetime-reliable scope to avoid (or vice
 * versa). Below that floor the lifetime rate governs, exactly as the scheduler does,
 * so this advisory list moves in the same direction the scheduler acts on. The base
 * sample floor still gates on LIFETIME completed: a scope needs enough TOTAL evidence
 * to be judged at all. Each rendered rate is paired with the run count of the SAME
 * basis (windowed count when the window governs, lifetime count otherwise) so the
 * "N% over M runs" line never mixes a windowed rate with a lifetime count.
 *
 * The thresholds (50/75) are deliberately NOT the scheduler's 30% hard-skip line: this
 * steering is advisory (it nudges what LI PROPOSES, it never suppresses execution), so
 * a wider, more cautious net is correct here. LI still MAY propose in an avoid scope
 * when it is genuinely the highest-value work — it just has to justify doing so.
 */
export function computeScopeAwareness({ metricsByType = {} } = {}) {
  const avoid = [];
  const prefer = [];
  for (const [type, m] of Object.entries(metricsByType || {})) {
    const lifetimeN = m?.lifetimeCompleted || 0;
    if (lifetimeN < SCOPE_AWARENESS_MIN_SAMPLE) continue; // not enough total evidence to judge
    // Effective rate: trust the recency window ONLY when it carries enough samples —
    // the same EFFECTIVE_RATE_MIN_WINDOW_SAMPLES floor the scheduler's
    // computeEffectiveSuccessRate uses — so one noisy recent run can't flip a
    // lifetime-reliable scope. Below the floor (including an empty window, where
    // recentSuccessRate is null, not 0 — #2460), lifetime governs. Pair the rate with
    // the count of its own basis so the rendered "N% over M runs" is truthful.
    const useWindow = m?.recentCompleted >= EFFECTIVE_RATE_MIN_WINDOW_SAMPLES
      && typeof m?.recentSuccessRate === 'number';
    const rate = useWindow ? m.recentSuccessRate : m?.lifetimeSuccessRate;
    if (typeof rate !== 'number') continue; // a never-run scope stays neutral
    const n = useWindow ? m.recentCompleted : lifetimeN;
    if (rate < SCOPE_AVOID_SUCCESS_THRESHOLD) avoid.push({ type, rate, n });
    else if (rate >= SCOPE_PREFER_SUCCESS_THRESHOLD) prefer.push({ type, rate, n });
  }
  // Honest framing (#2760, codex P1): these are per-task-TYPE completion rates for the
  // whole install — NOT a per-proposal execution record. An LI proposal is implemented
  // through a claim/plan/handoff task whose type does not carry the proposal's domain,
  // so this is directional context ("work of this kind tends to (not) get finished
  // here"), not a claim that a given proposal maps 1:1 onto a listed type.
  return renderAvoidPreferSections({
    avoid,
    prefer,
    fmt: ({ type, rate, n }) => `- ${clampScopeLabel(type)}: ${Math.round(rate)}% completed over ${n} runs`,
    avoidHeader: `LOW-COMPLETION task types — work of this kind is finished below ${SCOPE_AVOID_SUCCESS_THRESHOLD}% of the time on this install:`,
    preferHeader: `HIGH-COMPLETION task types — finished at or above ${SCOPE_PREFER_SUCCESS_THRESHOLD}%:`
  });
}

/**
 * Aggregate LI proposal EXECUTION outcomes by proposal DOMAIN (scope) (#2765).
 * Pure. Unlike computeScopeAwareness — which borrows install-wide CoS
 * per-task-TYPE completion rates that a proposal only loosely maps onto — this is a
 * TRUE per-proposal record: each data point is one of LI's OWN filed proposals that
 * was handed off and executed, keyed by the domain (scope) it was proposed under.
 *
 * `outcomes` is the app's outcome records (from listOutcomes); only records carrying
 * a resolved `executionOutcome` AND a `scope` contribute. Returns
 * `{ [scope]: { completed, succeeded, successRate, failureSummary } }` (empty when
 * nothing has been executed yet). The acceptance signal for #2765: after one proposal
 * in domain X is executed, only X's bucket moves.
 *
 * `failureSummary` (#2764 §3) carries the per-domain execution-FAILURE taxonomy tally
 * so a low execution rate no longer arrives without its cause: it is the shared
 * `summarizeExecutionFailures` engine run over ONLY this domain's records (the engine
 * itself keeps just the failures), the "filter per-domain, then reuse the existing
 * summariser" join #2764 §3 asks for. Every bucket carries one — a domain with zero
 * failed hand-offs simply reports `total: 0`, the honest "nothing to explain" reading.
 */
export function computeExecutionByDomain(outcomes = []) {
  // Group each executed record by its domain first, so the failure taxonomy can be
  // tallied over that domain's OWN records rather than the install-wide set.
  const recordsByScope = new Map();
  for (const r of Array.isArray(outcomes) ? outcomes : []) {
    if (!r || typeof r !== 'object') continue;
    if (!PROPOSAL_EXECUTION_OUTCOMES.includes(r.executionOutcome)) continue;
    const scope = typeof r.scope === 'string' && r.scope.trim() ? r.scope.trim() : null;
    if (!scope) continue;
    if (!recordsByScope.has(scope)) recordsByScope.set(scope, []);
    recordsByScope.get(scope).push(r);
  }
  // Null prototype: `scope` is an LLM-authored free string, and a "__proto__"
  // key on a plain object would silently rewrite the prototype instead of
  // adding a bucket — vanishing from Object.entries while lookups read the
  // prototype object.
  const byDomain = Object.create(null);
  for (const [scope, records] of recordsByScope) {
    const completed = records.length;
    const succeeded = records.filter(r => r.executionOutcome === 'success').length;
    byDomain[scope] = {
      completed,
      succeeded,
      successRate: Math.round((succeeded / completed) * 100),
      // Reuse the shared taxonomy engine on this domain's slice — it discards the
      // successes internally, so passing the whole slice yields this domain's own
      // failure shape without a second pre-filter here.
      failureSummary: summarizeExecutionFailures(records)
    };
  }
  return byDomain;
}

/**
 * Render the dominant execution-failure causes from a domain's `failureSummary`
 * (#2764 §3) as a compact clause for the per-domain avoid line. Reuses the shared
 * `formatExecutionFailure` gloss so the wording matches the install-wide failure line
 * in computeOutcomesReport. Returns '' when the domain holds NO diagnosed failure — a
 * pure-`unknown`/`unclassified` (or failure-free) domain adds no cause clause rather
 * than a hollow "failed for unknown reasons" tail on every low-execution line.
 */
export function formatDominantFailureCause(failureSummary, limit = 2) {
  const entries = Array.isArray(failureSummary?.entries) ? failureSummary.entries : [];
  if (entries.length === 0) return '';
  const listed = entries
    .slice(0, limit)
    .map(({ category, count }) => `${formatExecutionFailure(category)} (${count})`)
    .join('; ');
  return `failing mostly on ${listed}`;
}

/**
 * Is this a proposal DOMAIN whose OWN hand-offs chronically fail — enough executed
 * hand-offs to be evidence (PROPOSAL_EXECUTION_MIN_SAMPLE) AND a success rate below
 * the coin-flip avoid line (SCOPE_AVOID_SUCCESS_THRESHOLD)? The single load-bearing
 * definition of "on the avoid list", shared so the reasoner-facing prompt
 * (computeProposalExecutionAwareness) and the deterministic hand-off gate
 * (computeHandoffRouting) can NEVER disagree about which domains qualify — the
 * design requires the prompt's avoid list and the gate to name the same set. Takes
 * a per-domain bucket from computeExecutionByDomain (or undefined when the domain
 * has no execution history → false).
 */
export function isAvoidDomain(bucket) {
  return !!bucket
    && bucket.completed >= PROPOSAL_EXECUTION_MIN_SAMPLE
    && bucket.successRate < SCOPE_AVOID_SUCCESS_THRESHOLD;
}

/**
 * Render the per-proposal-DOMAIN execution avoid/prefer split for the reasoning
 * prompt (#2765) — the real per-proposal signal the #2760 install-wide scope block
 * could only approximate. Returns '' when no domain clears the sample floor, so
 * buildPrompt omits the block. Mirrors computeScopeAwareness's 50/75 thresholds and
 * bounded rendering, but keys on the proposal's own scope and carries NO
 * "directional context only" caveat: this IS how LI's own proposals in each domain
 * fared, so the reasoner can steer toward domains it actually executes and away from
 * domains where its own hand-offs fail even after the proposal was accepted.
 */
export function computeProposalExecutionAwareness({ outcomes = [] } = {}) {
  const byDomain = computeExecutionByDomain(outcomes);
  const avoid = [];
  const prefer = [];
  for (const [scope, bucket] of Object.entries(byDomain)) {
    // The per-domain failure CAUSE (#2764 §3) is surfaced only for domains that clear
    // this floor — i.e. only where the domain is already listed as low-execution. A
    // single failed hand-off below the floor is the install-wide early-signal case the
    // "Why LI's own hand-offs failed" line in computeOutcomesReport already reports, so
    // we do not also emit a one-sample per-domain cause here (it would read as a trend
    // off n=1).
    if (bucket.completed < PROPOSAL_EXECUTION_MIN_SAMPLE) continue; // not enough executions to judge this domain
    if (isAvoidDomain(bucket)) avoid.push({ scope, rate: bucket.successRate, n: bucket.completed, cause: formatDominantFailureCause(bucket.failureSummary) });
    else if (bucket.successRate >= SCOPE_PREFER_SUCCESS_THRESHOLD) prefer.push({ scope, rate: bucket.successRate, n: bucket.completed });
  }
  return renderAvoidPreferSections({
    avoid,
    prefer,
    // Only the avoid list carries a `cause`; a preferred (reliably-executed) domain has
    // no failure shape worth naming, so its clause is simply absent.
    fmt: ({ scope, rate, n, cause }) => `- ${clampScopeLabel(scope)}: LI implemented ${rate}% of its own ${scope} proposals successfully over ${n} executed${cause ? ` — ${cause}` : ''}`,
    avoidHeader: `LOW-EXECUTION proposal domains — LI's OWN hand-offs in these domains succeed below ${SCOPE_AVOID_SUCCESS_THRESHOLD}% of the time; a proposal here needs a strong justification or a narrower slice:`,
    preferHeader: `HIGH-EXECUTION proposal domains — LI reliably implements its own proposals here (at or above ${SCOPE_PREFER_SUCCESS_THRESHOLD}%):`
  });
}

// Header for the cross-reference block (#2764 §3). Names the pattern the block exists
// to surface: a domain LI PROPOSES well (its proposals earn merges) yet EXECUTES
// poorly (its own hand-offs there fail), which neither liOutcomes (merge rate alone)
// nor liProposalExecution (execution rate alone) puts side by side.
const CROSS_REFERENCE_HEADER = "Domains where LI PROPOSES well but EXECUTES poorly — the proposal earns a merge, yet LI's OWN hand-off to implement it tends to fail with the named cause. These are blind spots: you pick the right work here but can't finish it as handed off. Narrow such a proposal to a slice an agent can complete, split it, or route it to a human — don't re-file the same shape expecting a different execution result:";

/**
 * Cross-reference MERGED-proposal success against EXECUTION-failure modes within the
 * SAME domain (#2764 §3). Pure + side-effect-free like the sibling report functions;
 * derives only from the outcome records already loaded (no new store read, no AI/tracker
 * call). The unique signal it adds over liOutcomes (per-scope merge rate) and
 * liProposalExecution (per-domain execution rate) is the CONTRAST between them: a domain
 * whose proposals the user merges but whose hand-offs then fail is "proposes well,
 * executes poorly" — the reasoner should keep proposing there but narrow the scope, not
 * abandon the domain (which a low execution rate read alone might imply).
 *
 * A domain qualifies only when BOTH signals are present: at least one MERGED proposal
 * (the "proposes well" side — otherwise the domain is just failing outright, which
 * liProposalExecution already covers) AND at least one DIAGNOSED failed hand-off (the
 * "executes poorly" side, with a concrete cause to name — a purely `unknown`/
 * `unclassified` failure history has no actionable mode to cross-reference). Merge rate
 * is measured over RESOLVED proposals only — the same denominator summarizeOutcomeStats
 * uses for its rawMergeRate (pending ≠ a merge verdict), not computeOutcomesReport's
 * per-scope rate, which divides by all filed. Sorted sharpest-execution-problem first;
 * bounded like the avoid/prefer lists. Returns '' when no domain qualifies, so
 * buildPrompt omits the block.
 */
export function computeCrossReferenceAnalysis({ outcomes = [] } = {}) {
  const records = Array.isArray(outcomes) ? outcomes : [];
  const byDomain = computeExecutionByDomain(records); // per-domain failure taxonomy (self-guards bad records)

  // Per-domain merge stats over RESOLVED proposals (pending ≠ a merge verdict).
  const mergeByScope = new Map();
  for (const o of records) {
    if (!o || typeof o !== 'object') continue;
    const scope = typeof o.scope === 'string' && o.scope.trim() ? o.scope.trim() : null;
    if (!scope) continue;
    if (!PROPOSAL_OUTCOMES.includes(o.outcome)) continue; // unresolved: no verdict yet
    const agg = mergeByScope.get(scope) || { merged: 0, resolved: 0 };
    agg.resolved += 1;
    if (o.outcome === 'merged') agg.merged += 1;
    mergeByScope.set(scope, agg);
  }

  const qualifying = [];
  for (const [scope, exec] of Object.entries(byDomain)) {
    const merge = mergeByScope.get(scope);
    if (!merge || merge.merged < 1) continue; // "proposes well" side needs a merge
    const { entries, diagnosed, total: failTotal } = exec.failureSummary;
    if (diagnosed < 1) continue; // "executes poorly" side needs a diagnosed failed hand-off
    const top = entries[0];
    qualifying.push({
      scope,
      mergeRate: Math.round((merge.merged / merge.resolved) * 100),
      merged: merge.merged,
      resolved: merge.resolved,
      cause: top.category,
      causeCount: top.count,
      failTotal,
      diagnosed
    });
  }
  if (!qualifying.length) return '';
  // Sharpest execution problem first (most diagnosed failures), ties broken by the
  // strongest "proposes well" contrast (highest merge rate) so the output is stable.
  qualifying.sort((a, b) => b.diagnosed - a.diagnosed || b.mergeRate - a.mergeRate);
  const shown = qualifying.slice(0, SCOPE_AWARENESS_MAX_PER_LIST);
  const more = qualifying.length - shown.length;
  const lines = shown.map(q =>
    `- ${clampScopeLabel(q.scope)}: proposals merge at ${q.mergeRate}% (${q.merged}/${q.resolved}) but hand-offs here fail on ${q.cause} (${q.causeCount} of ${q.failTotal})`
  );
  if (more > 0) lines.push(`- …and ${more} more`);
  return `${CROSS_REFERENCE_HEADER}\n${lines.join('\n')}`;
}

/**
 * Deterministic hand-off routing gate (#2764 §4). Given a proposal and the app's
 * historical outcome records, decides whether a trivial+safe proposal may be
 * auto-handed-off to a coding agent NOW, or must instead be filed for a human —
 * because LI's OWN prior hand-offs in that domain chronically fail. This is the
 * SYSTEM-side enforcement of the same signal the reasoner is merely WARNED about
 * in the liProposalExecution / liCrossReference prompt blocks: even when the
 * reasoner marks a proposal trivial+safe, the gate suppresses the auto-hand-off
 * for a domain whose track record says the hand-off will just fail again.
 *
 * Pure + side-effect-free, like the sibling compute* report functions — derives
 * only from the `li-outcomes` records already loaded (no new AI/tracker/store
 * call). The just-filed proposal cannot skew this: computeExecutionByDomain only
 * counts records carrying a resolved `executionOutcome`, which a freshly-filed
 * proposal has not got yet.
 *
 * Shares the isAvoidDomain classifier with computeProposalExecutionAwareness so the
 * gate and the reasoner-facing prompt can NEVER disagree about which domains are
 * "chronically failing": a domain qualifies only when it has at least
 * PROPOSAL_EXECUTION_MIN_SAMPLE executed hand-offs AND its success rate is below
 * SCOPE_AVOID_SUCCESS_THRESHOLD — the SAME floor + threshold that puts a domain on
 * the reasoner's avoid list.
 *
 * Returns:
 *   - `{ handoff: true, reason: null }` — allow the auto-hand-off, when the
 *     proposal has no scope (can't judge), the domain is below the sample floor,
 *     the domain has no execution history, or its rate is at/above the threshold.
 *   - `{ handoff: false, domain, rate, n, cause, reason }` — SUPPRESS: file for a
 *     human instead. `reason` names the domain, rate, sample size, and (when a
 *     dominant failure cause is diagnosed) the cause — reusing formatDominantFailureCause,
 *     which returns '' for a purely unknown/unclassified domain so the cause clause
 *     is simply omitted there.
 *
 * @param {object} args
 * @param {object} args.proposal - the reasoner's proposal ({ scope, ... }).
 * @param {Array}  [args.outcomes] - the app's li-outcomes records.
 * @returns {{ handoff: boolean, reason: string|null, domain?: string, rate?: number, n?: number, cause?: string }}
 */
export function computeHandoffRouting({ proposal, outcomes = [] } = {}) {
  // No scope → we can't map the proposal to a domain's track record, so we can't
  // justify suppressing the hand-off. Allow, as before §4 existed.
  const domain = typeof proposal?.scope === 'string' && proposal.scope.trim() ? proposal.scope.trim() : null;
  if (!domain) return { handoff: true, reason: null };

  const byDomain = computeExecutionByDomain(outcomes);
  const bucket = byDomain[domain];
  // Below the floor, no bucket, or at/above the threshold → no signal to suppress on,
  // so allow the hand-off exactly as today. isAvoidDomain is the SAME predicate
  // computeProposalExecutionAwareness uses for its avoid list, so the gate and the
  // reasoner-facing prompt agree on which domains are "chronically failing".
  if (!isAvoidDomain(bucket)) return { handoff: true, reason: null };

  const cause = formatDominantFailureCause(bucket.failureSummary);
  const reason = `${domain} hand-offs succeed ${bucket.successRate}% over ${bucket.completed} executed — filing for human review instead of auto-hand-off${cause ? ` (${cause})` : ''}`;
  return { handoff: false, domain, rate: bucket.successRate, n: bucket.completed, cause, reason };
}
