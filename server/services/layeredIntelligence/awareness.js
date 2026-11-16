/**
 * Layered Intelligence — scope / execution awareness reports: avoid/prefer signals from
 * task-learning metrics and proposal execution outcomes, the propose-well-but-execute-poorly
 * cross-reference, and the deterministic hand-off routing decision.
 */

import { EFFECTIVE_RATE_MIN_WINDOW_SAMPLES } from '../taskLearning/store.js';
import { summarizeExecutionFailures, formatExecutionFailure } from '../layeredIntelligenceExecutionFailures.js';
import {
  SCOPE_AWARENESS_MAX_TYPE_LEN, SCOPE_AWARENESS_MAX_PER_LIST, SCOPE_AWARENESS_MIN_SAMPLE,
  SCOPE_AVOID_SUCCESS_THRESHOLD, SCOPE_PREFER_SUCCESS_THRESHOLD,
  PROPOSAL_OUTCOMES, PROPOSAL_EXECUTION_OUTCOMES, PROPOSAL_EXECUTION_MIN_SAMPLE,
} from './constants.js';

/** Clamp a task-type / proposal-domain label so one pathological key can't blow the scope-awareness block budget. */
export function clampScopeLabel(label) {
  return label.length > SCOPE_AWARENESS_MAX_TYPE_LEN
    ? `${label.slice(0, SCOPE_AWARENESS_MAX_TYPE_LEN - 1)}…`
    : label;
}

/**
 * Resolve an outcome record's grouping key: trimmed `scope`, or `fallback` when absent.
 * One predicate so the groupings can't split one scope across two buckets. A report that
 * must not invent a bucket passes `null` and skips the record; a breakdown accounting for
 * every record uses the default `'unknown'`.
 */
export function scopeKeyOf(record, fallback = 'unknown') {
  const scope = record?.scope;
  return typeof scope === 'string' && scope.trim() ? scope.trim() : fallback;
}

/**
 * Render an avoid/prefer prompt block from pre-classified lists, shared by both
 * scope-awareness signals. Owns the sort (worst-first avoid, best-first prefer), the
 * per-list cap + "…and N more" overflow, and the empty-guard. Returns '' when both are empty.
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
 * Scope-awareness report: classifies each CoS task TYPE by completion rate into
 * low/high-completion lists as directional context. Pure; takes the per-type metrics map
 * `{ lifetimeSuccessRate, lifetimeCompleted, recentSuccessRate, recentCompleted, ... }` and
 * returns a report string, or '' when no type qualifies.
 *
 * This is install-wide per-task-TYPE telemetry, NOT a per-proposal execution record: a
 * proposal is implemented through a claim/plan/handoff task whose type does not carry the
 * proposal's domain. Framed as "work of this KIND tends to (not) get finished here", not a
 * 1:1 mapping (per-proposal correlation is computeProposalExecutionAwareness).
 *
 * Judges on the EFFECTIVE rate: the recency window when it has >=
 * EFFECTIVE_RATE_MIN_WINDOW_SAMPLES runs (the scheduler's own floor, so a recovered scope
 * leaves "avoid" promptly and one noisy run can't flip a reliable scope), else lifetime.
 * The base sample floor gates on LIFETIME completed. Each rate is paired with the run
 * count of the same basis.
 *
 * Thresholds (50/75) are deliberately wider than the scheduler's 30% hard-skip: this is
 * advisory (it nudges what LI proposes, never suppresses execution).
 */
export function computeScopeAwareness({ metricsByType = {} } = {}) {
  const avoid = [];
  const prefer = [];
  for (const [type, m] of Object.entries(metricsByType || {})) {
    const lifetimeN = m?.lifetimeCompleted || 0;
    if (lifetimeN < SCOPE_AWARENESS_MIN_SAMPLE) continue; // not enough total evidence to judge
    // Trust the window only with enough samples; below the floor (including an empty
    // window, where recentSuccessRate is null, not 0) lifetime governs. Pair rate and
    // count from the same basis.
    const useWindow = m?.recentCompleted >= EFFECTIVE_RATE_MIN_WINDOW_SAMPLES
      && typeof m?.recentSuccessRate === 'number';
    const rate = useWindow ? m.recentSuccessRate : m?.lifetimeSuccessRate;
    if (typeof rate !== 'number') continue; // a never-run scope stays neutral
    const n = useWindow ? m.recentCompleted : lifetimeN;
    if (rate < SCOPE_AVOID_SUCCESS_THRESHOLD) avoid.push({ type, rate, n });
    else if (rate >= SCOPE_PREFER_SUCCESS_THRESHOLD) prefer.push({ type, rate, n });
  }
  return renderAvoidPreferSections({
    avoid,
    prefer,
    fmt: ({ type, rate, n }) => `- ${clampScopeLabel(type)}: ${Math.round(rate)}% completed over ${n} runs`,
    avoidHeader: `LOW-COMPLETION task types — work of this kind is finished below ${SCOPE_AVOID_SUCCESS_THRESHOLD}% of the time on this install:`,
    preferHeader: `HIGH-COMPLETION task types — finished at or above ${SCOPE_PREFER_SUCCESS_THRESHOLD}%:`
  });
}

/**
 * Aggregate LI proposal EXECUTION outcomes by proposal DOMAIN (scope). Pure. Unlike
 * computeScopeAwareness this is a true per-proposal record: one point per LI-filed proposal
 * that was handed off and executed. Only records with a resolved `executionOutcome` AND a
 * `scope` contribute. Returns `{ [scope]: { completed, succeeded, successRate, failureSummary } }`.
 *
 * `failureSummary` is `summarizeExecutionFailures` run over only this domain's records, so
 * a low rate arrives with its cause; a domain with zero failures reports `total: 0`.
 */
export function computeExecutionByDomain(outcomes = []) {
  // Group by domain first so the failure taxonomy tallies that domain's own records.
  const recordsByScope = new Map();
  for (const r of Array.isArray(outcomes) ? outcomes : []) {
    if (!r || typeof r !== 'object') continue;
    if (!PROPOSAL_EXECUTION_OUTCOMES.includes(r.executionOutcome)) continue;
    const scope = scopeKeyOf(r, null);
    if (!scope) continue;
    if (!recordsByScope.has(scope)) recordsByScope.set(scope, []);
    recordsByScope.get(scope).push(r);
  }
  // Null prototype: `scope` is LLM-authored, and a "__proto__" key would rewrite the
  // prototype instead of adding a bucket.
  const byDomain = Object.create(null);
  for (const [scope, records] of recordsByScope) {
    const completed = records.length;
    const succeeded = records.filter(r => r.executionOutcome === 'success').length;
    byDomain[scope] = {
      completed,
      succeeded,
      successRate: Math.round((succeeded / completed) * 100),
      // The engine discards successes internally, so pass the whole slice.
      failureSummary: summarizeExecutionFailures(records)
    };
  }
  return byDomain;
}

/**
 * Summarize millisecond durations into `{ count, averageMs, medianMs, p90Ms, minMs, maxMs }`,
 * shared by every LI duration report so they agree on median/p90. Input is filtered to
 * finite non-negative values (an unparseable timestamp yields NaN and must not become 0ms)
 * and sorted. An EMPTY sample reports `count: 0` with NULL stats, not "completed instantly".
 * Even-length median is the rounded mean of the middle two; p90 is nearest-rank ceil(n*0.9).
 */
export function summarizeDurations(values = []) {
  const durations = (Array.isArray(values) ? values : [])
    .filter(value => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  if (durations.length === 0) {
    return { count: 0, averageMs: null, medianMs: null, p90Ms: null, minMs: null, maxMs: null };
  }
  const median = durations.length % 2 === 1
    ? durations[Math.floor(durations.length / 2)]
    : Math.round((durations[(durations.length / 2) - 1] + durations[durations.length / 2]) / 2);
  return {
    count: durations.length,
    averageMs: Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length),
    medianMs: median,
    p90Ms: durations[Math.max(0, Math.ceil(durations.length * 0.9) - 1)],
    minMs: durations[0],
    maxMs: durations.at(-1)
  };
}

/**
 * Summarize what happens after a proposal is approved/merged: `outcome: 'merged'` marks
 * approval, `executionOutcome` the terminal hand-off result. Pure. Duration runs from filing
 * to a successful hand-off (the only timestamp pair available for every tracker).
 *
 * TWO completion rates, because they answer different questions:
 *   - `completionRate` = completed / ATTEMPTED (completed + abandoned): execution quality,
 *     excluding work still in flight.
 *   - `approvalToCompletionRate` = completed / APPROVED: counts an approved proposal never
 *     handed off, or stuck awaiting execution, as not completed ("approved but LOST").
 * Both are `null` (not 0) when their denominator is zero.
 */
export function computePostApprovalCompletion(outcomes = []) {
  const approved = (Array.isArray(outcomes) ? outcomes : []).filter(record =>
    record && typeof record === 'object' && record.outcome === 'merged'
  );

  const summarize = (records) => {
    const completedRecords = records.filter(record => record.executionOutcome === 'success');
    const abandoned = records.filter(record => record.executionOutcome === 'failure').length;
    const completed = completedRecords.length;
    const attempted = completed + abandoned;
    const duration = summarizeDurations(
      completedRecords.map(record => Date.parse(record.executionAt) - Date.parse(record.filedAt))
    );
    return {
      approved: records.length,
      completed,
      abandoned,
      awaitingExecution: records.length - attempted,
      attempted,
      completionRate: attempted > 0 ? (completed / attempted) * 100 : null,
      // Denominator is every APPROVED proposal; null (never 0) on a zero denominator.
      approvalToCompletionRate: records.length > 0 ? (completed / records.length) * 100 : null,
      duration
    };
  };

  const recordsByScope = new Map();
  for (const record of approved) {
    const scope = scopeKeyOf(record);
    const records = recordsByScope.get(scope) || [];
    records.push(record);
    recordsByScope.set(scope, records);
  }
  const byScope = Object.create(null);
  for (const [scope, records] of recordsByScope) byScope[scope] = summarize(records);

  return { ...summarize(approved), byScope };
}

/**
 * Render the dominant execution-failure causes from a domain's `failureSummary` as a
 * compact clause (shared `formatExecutionFailure` gloss). Returns '' when no diagnosed
 * failure exists, avoiding a hollow "failed for unknown reasons" tail.
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
 * Is this a proposal DOMAIN whose OWN hand-offs chronically fail: >=
 * PROPOSAL_EXECUTION_MIN_SAMPLE executed hand-offs AND success below
 * SCOPE_AVOID_SUCCESS_THRESHOLD? Shared so the reasoner prompt
 * (computeProposalExecutionAwareness) and the hand-off gate (computeHandoffRouting) can
 * never disagree. Takes a computeExecutionByDomain bucket (undefined -> false).
 */
export function isAvoidDomain(bucket) {
  return !!bucket
    && bucket.completed >= PROPOSAL_EXECUTION_MIN_SAMPLE
    && bucket.successRate < SCOPE_AVOID_SUCCESS_THRESHOLD;
}

/**
 * Render the per-proposal-DOMAIN execution avoid/prefer split for the reasoning prompt.
 * Returns '' when no domain clears the sample floor. Mirrors computeScopeAwareness's
 * thresholds but keys on the proposal's own scope and carries no "directional only" caveat.
 */
export function computeProposalExecutionAwareness({ outcomes = [] } = {}) {
  const byDomain = computeExecutionByDomain(outcomes);
  const avoid = [];
  const prefer = [];
  for (const [scope, bucket] of Object.entries(byDomain)) {
    // Failure CAUSE is surfaced only for domains clearing this floor; a one-sample cause
    // would read as a trend off n=1 (computeOutcomesReport covers the install-wide early signal).
    if (bucket.completed < PROPOSAL_EXECUTION_MIN_SAMPLE) continue; // not enough executions to judge this domain
    if (isAvoidDomain(bucket)) avoid.push({ scope, rate: bucket.successRate, n: bucket.completed, cause: formatDominantFailureCause(bucket.failureSummary) });
    else if (bucket.successRate >= SCOPE_PREFER_SUCCESS_THRESHOLD) prefer.push({ scope, rate: bucket.successRate, n: bucket.completed });
  }
  return renderAvoidPreferSections({
    avoid,
    prefer,
    // Only the avoid list carries a `cause`.
    fmt: ({ scope, rate, n, cause }) => `- ${clampScopeLabel(scope)}: LI implemented ${rate}% of its own ${scope} proposals successfully over ${n} executed${cause ? ` — ${cause}` : ''}`,
    avoidHeader: `LOW-EXECUTION proposal domains — LI's OWN hand-offs in these domains succeed below ${SCOPE_AVOID_SUCCESS_THRESHOLD}% of the time; a proposal here needs a strong justification or a narrower slice:`,
    preferHeader: `HIGH-EXECUTION proposal domains — LI reliably implements its own proposals here (at or above ${SCOPE_PREFER_SUCCESS_THRESHOLD}%):`
  });
}

// Header for the cross-reference block: a domain LI PROPOSES well (earns merges) yet
// EXECUTES poorly (hand-offs fail), which neither merge rate nor execution rate shows alone.
const CROSS_REFERENCE_HEADER = "Domains where LI PROPOSES well but EXECUTES poorly — the proposal earns a merge, yet LI's OWN hand-off to implement it tends to fail with the named cause. These are blind spots: you pick the right work here but can't finish it as handed off. Narrow such a proposal to a slice an agent can complete, split it, or route it to a human — don't re-file the same shape expecting a different execution result:";

/**
 * Cross-reference MERGED-proposal success against EXECUTION-failure modes within the same
 * domain. Pure; derives only from loaded outcome records. A domain qualifies only with at
 * least one MERGED proposal (else it is failing outright, covered by the execution block)
 * AND at least one DIAGNOSED failed hand-off (a concrete cause to name). Merge rate is over
 * RESOLVED proposals only (same denominator as summarizeOutcomeStats' rawMergeRate). Sorted
 * sharpest problem first, bounded like the avoid/prefer lists. Returns '' when none qualify.
 */
export function computeCrossReferenceAnalysis({ outcomes = [] } = {}) {
  const records = Array.isArray(outcomes) ? outcomes : [];
  const byDomain = computeExecutionByDomain(records);

  // Per-domain merge stats over RESOLVED proposals.
  const mergeByScope = new Map();
  for (const o of records) {
    if (!o || typeof o !== 'object') continue;
    const scope = scopeKeyOf(o, null);
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
  // Sharpest problem first, ties by highest merge rate for stable output.
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
 * Deterministic hand-off routing gate. Decides whether a trivial+safe proposal may be
 * auto-handed-off now or must be filed for a human because LI's OWN prior hand-offs in that
 * domain chronically fail. System-side enforcement of what the reasoner is only WARNED about.
 * Pure; derives from loaded `li-outcomes` records. A just-filed proposal cannot skew it
 * (computeExecutionByDomain counts only resolved `executionOutcome`s). Uses isAvoidDomain so
 * the gate and the prompt agree.
 *
 * Returns `{ handoff: true, reason: null }` when the proposal has no scope, the domain is
 * below the sample floor or has no history, or its rate is at/above the threshold; else
 * `{ handoff: false, domain, rate, n, cause, reason }` (`cause` omitted when undiagnosed).
 *
 * @param {object} args
 * @param {object} args.proposal - the reasoner's proposal ({ scope, ... }).
 * @param {Array}  [args.outcomes] - the app's li-outcomes records.
 * @returns {{ handoff: boolean, reason: string|null, domain?: string, rate?: number, n?: number, cause?: string }}
 */
export function computeHandoffRouting({ proposal, outcomes = [] } = {}) {
  // No scope: can't map to a domain's track record, so allow.
  const domain = typeof proposal?.scope === 'string' && proposal.scope.trim() ? proposal.scope.trim() : null;
  if (!domain) return { handoff: true, reason: null };

  const byDomain = computeExecutionByDomain(outcomes);
  const bucket = byDomain[domain];
  // No signal to suppress on: allow.
  if (!isAvoidDomain(bucket)) return { handoff: true, reason: null };

  const cause = formatDominantFailureCause(bucket.failureSummary);
  const reason = `${domain} hand-offs succeed ${bucket.successRate}% over ${bucket.completed} executed — filing for human review instead of auto-hand-off${cause ? ` (${cause})` : ''}`;
  return { handoff: false, domain, rate: bucket.successRate, n: bucket.completed, cause, reason };
}
