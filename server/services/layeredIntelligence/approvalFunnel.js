/**
 * Layered Intelligence: proposal APPROVAL FUNNEL metrics (#3120).
 *
 * Answers "where in the human-approval funnel are my proposals stuck, and is triage
 * behavior changing?" (a backlog of undecided proposals is a reason to STOP filing).
 * Derived from the proposal lifecycle (`filedAt` to `outcome` + `outcomeAt`) in
 * `data/cos/li-outcomes/`, not tracker labels, with no second aggregate:
 *   1. Approval rate over a sliding window of decisions made INSIDE the window.
 *   2. Pending-review count.
 *   3. Median time from filing to a decision (and to an APPROVAL).
 *   4. Approver-delay buckets: undecided proposals past 1 / 3 / 7 days.
 *   5. Proposal-phase delivery: share of filed proposals with any verdict (distinct from
 *      `cosMetrics`, which measures the agent-task lifecycle).
 *
 * Pure, no LLM call; `now` is an injected clock so one selfEval run uses a single "now".
 *
 * Decision timestamps must be authoritative: only a tracker-reported close time dates the
 * decision. `reconcileOutcomes` synthesizes one (`outcomeAtSource: 'observed'`) for the
 * `plan` tracker, and such records count as UNDATED so a long-checked PLAN.md item first
 * reconciled today cannot inflate the window (see `hasAuthoritativeDecisionDate`).
 *
 * Sentinels: a rate with a zero denominator is `null`, never 0 (a 0% rate instructs the
 * reasoner to hold back); unparseable timestamps go to an explicit `undated` slot.
 */

import { DAY, formatDuration } from '../../lib/fileUtils.js';
import { LI_APPROVAL_FUNNEL_WINDOW_MS, LI_APPROVAL_DELAY_BUCKET_DAYS } from './constants.js';
import { summarizeDurations } from './awareness.js';

// Bucket key for an age threshold (`1` -> `'1d'`); one place so computed keys and rendered line agree.
export const delayBucketKey = (days) => `${days}d`;

/** A parsed epoch-ms timestamp, or null when the value is absent/unparseable. */
const parsedMs = (value) => {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

/**
 * Clamp a timestamp at `now`: clock skew or a repaired record can leave `filedAt`/`outcomeAt`
 * in the future, which would yield a negative pending age ("-1m") and inflate latency.
 * Applied to ELAPSED-TIME math only, never to window membership.
 */
const elapsedSince = (ms, now) => Math.max(0, now - ms);

// Trackers that report NO close timestamp, so `outcomeAt` is synthesized: only `plan`
// (PLAN.md checkboxes; see `extractPlanSlugs`).
const TIMESTAMPLESS_TRACKERS = ['plan'];

/**
 * Can this record's `outcomeAt` be read as WHEN THE HUMAN DECIDED? Only a tracker-reported
 * close time can. It fails for `outcomeAtSource === 'observed'` (synthesized) and for a
 * `plan`-tracker record with no provenance stamp (forge/jira always report `closedAt`, so
 * their legacy values are real). Those never self-heal, since `reconcileOutcomes` no-ops on
 * settled records, hence derived at READ time rather than backfilled.
 */
const hasAuthoritativeDecisionDate = (record) => {
  if (record?.outcomeAtSource === 'observed') return false;
  if (record?.outcomeAtSource === 'tracker') return true;
  return !TIMESTAMPLESS_TRACKERS.includes(record?.tracker);
};

/**
 * Compute the approval-funnel metrics for one app's outcome records.
 *
 * @param {Array} [outcomes] - li-outcomes records. A NON-array is treated as empty; callers
 *   that must distinguish a FAILED store read check that BEFORE calling.
 * @param {object} [opts]
 * @param {number} [opts.now] - clock seam for ages and the window edge.
 * @param {number} [opts.windowMs] - sliding-window span (default the shared constant).
 * @returns {{ windowMs: number, windowDays: number,
 *   window: { decided: number, approved: number, rejected: number, abandoned: number,
 *             undated: number, approvalRate: number|null, timeToDecision: object,
 *             timeToApproval: object },
 *   pending: { count: number, oldestAgeMs: number|null, undated: number,
 *              byAge: Object<string, number> },
 *   proposalPhase: { totalFiled: number, totalDecided: number, totalPending: number,
 *                    decisionRate: number|null } }}
 */
export function computeApprovalFunnel(outcomes = [], { now = Date.now(), windowMs = LI_APPROVAL_FUNNEL_WINDOW_MS } = {}) {
  const records = (Array.isArray(outcomes) ? outcomes : []).filter(r => r && typeof r === 'object');
  const windowStart = now - windowMs;

  // Decision cohort: verdicts issued inside the window, keyed on `outcomeAt` (when the
  // user decided), not `filedAt`, since the metric tracks current triage behavior.
  const decided = records.filter(r => r.outcome);
  const decidedInWindow = [];
  let undatedDecisions = 0;
  for (const r of decided) {
    // A synthesized decision timestamp (the reconcile clock; `plan` reports no close time)
    // is treated like an unparseable one: `undated`, not a decision made now.
    const decidedMs = hasAuthoritativeDecisionDate(r) ? parsedMs(r.outcomeAt) : null;
    // An undatable decision cannot be placed in or out of the window; it gets its own slot.
    if (decidedMs === null) { undatedDecisions += 1; continue; }
    // Lower bound only: a FUTURE-dated decision (clock skew, repaired record) is still a
    // real, most-recent decision. Excluding it would drop a verdict from both sides of the
    // rate while `totalDecided` counted it, and a dropped rejection inflates the approval
    // rate. Elapsed-time math clamps at `now` separately (see `latency`).
    if (decidedMs >= windowStart) decidedInWindow.push({ record: r, decidedMs });
  }
  const countOutcome = (name) => decidedInWindow.filter(({ record }) => record.outcome === name).length;
  const approvedInWindow = decidedInWindow.filter(({ record }) => record.outcome === 'merged');
  // Filing-to-decision latency: needs both timestamps to parse and decision >= filing
  // (summarizeDurations drops NaN/negative). Both ends clamp at `now` so a future-dated
  // record cannot drag the median.
  const latency = (entries) => summarizeDurations(
    entries.map(({ record, decidedMs }) => {
      const filedMs = parsedMs(record.filedAt);
      return filedMs === null ? NaN : Math.min(decidedMs, now) - Math.min(filedMs, now);
    })
  );

  // Right-now snapshot, deliberately NOT windowed: a proposal undecided for 40 days is the key signal.
  const pending = records.filter(r => !r.outcome);
  const byAge = Object.create(null);
  for (const days of LI_APPROVAL_DELAY_BUCKET_DAYS) byAge[delayBucketKey(days)] = 0;
  let oldestAgeMs = null;
  let undatedPending = 0;
  for (const r of pending) {
    const filedMs = parsedMs(r.filedAt);
    if (filedMs === null) { undatedPending += 1; continue; }
    // Clamped at zero: a future-dated filing has waited no time, and must not render "-1m" or sort to the top.
    const ageMs = elapsedSince(filedMs, now);
    if (oldestAgeMs === null || ageMs > oldestAgeMs) oldestAgeMs = ageMs;
    // CUMULATIVE buckets (a 9-day-old counts in 1d, 3d AND 7d); `>=` so exactly 24h is past the mark.
    for (const days of LI_APPROVAL_DELAY_BUCKET_DAYS) {
      if (ageMs >= days * DAY) byAge[delayBucketKey(days)] += 1;
    }
  }

  return {
    windowMs,
    windowDays: Math.round(windowMs / DAY),
    window: {
      decided: decidedInWindow.length,
      approved: approvedInWindow.length,
      rejected: countOutcome('rejected'),
      abandoned: countOutcome('abandoned'),
      // Undatable decisions, so an empty-looking window is distinguishable from undatable verdicts.
      undated: undatedDecisions,
      // Null, never 0, when the user decided nothing in the window.
      approvalRate: decidedInWindow.length > 0
        ? (approvedInWindow.length / decidedInWindow.length) * 100
        : null,
      timeToDecision: latency(decidedInWindow),
      timeToApproval: latency(approvedInWindow)
    },
    pending: {
      count: pending.length,
      oldestAgeMs,
      undated: undatedPending,
      byAge
    },
    proposalPhase: {
      totalFiled: records.length,
      totalDecided: decided.length,
      totalPending: pending.length,
      // Share of everything filed that got a human verdict; null (not 0) when nothing was filed.
      decisionRate: records.length > 0 ? (decided.length / records.length) * 100 : null
    }
  };
}

/**
 * Render the funnel as lines folded into the `liSelfEval` block (#3120). Takes the same
 * three-valued `outcomes` as `computeSelfEvalSummary`: a non-array (source off or store
 * unreadable) is reported UNAVAILABLE, never as a clean zero-proposal funnel; `[]` is
 * genuinely nothing filed. Returns an array of lines for the caller to splice.
 */
export function formatApprovalFunnelLines({ outcomes = null, now = Date.now(), windowMs = LI_APPROVAL_FUNNEL_WINDOW_MS } = {}) {
  if (!Array.isArray(outcomes)) {
    return ['- LI approval funnel: UNAVAILABLE — no outcome history was gathered this run, so how your proposals move through human review is unknown.'];
  }
  const funnel = computeApprovalFunnel(outcomes, { now, windowMs });
  if (funnel.proposalPhase.totalFiled === 0) {
    return [`- LI approval funnel: no proposals filed yet for this app — nothing has entered human review, so there is no approval bottleneck to read (this is an empty history, NOT a failed read).`];
  }

  const { window, pending, proposalPhase, windowDays } = funnel;
  const lines = [];

  lines.push(
    `- LI approval rate (last ${windowDays}d): `
    + (window.approvalRate === null
      // No literal percentage: an idle approver means the rate is UNKNOWN, and a quoted
      // rate is a number the reasoner can latch onto.
      ? `no decisions in the window — ${proposalPhase.totalPending} proposal(s) awaiting review; rate unknown. An idle approver is not a poor approval rate.`
      : `${Math.round(window.approvalRate)}% — ${window.approved} of ${window.decided} decisions were approvals`
        + `${window.rejected ? `, ${window.rejected} rejected` : ''}${window.abandoned ? `, ${window.abandoned} abandoned` : ''}.`)
    + (window.undated ? ` (${window.undated} recorded decision(s) carry no usable timestamp and are excluded from the window.)` : '')
  );

  lines.push(
    '- LI time-to-decision: '
    + (window.timeToDecision.medianMs === null
      ? 'no dated decision in the window — median unknown.'
      : `median ${formatDuration(window.timeToDecision.medianMs)} from filing to a human decision (p90 ${formatDuration(window.timeToDecision.p90Ms)}, ${window.timeToDecision.count} decided).`)
    + (window.timeToApproval.medianMs === null
      ? ' No approval in the window, so time-to-APPROVAL is unknown.'
      : ` Median time-to-APPROVAL ${formatDuration(window.timeToApproval.medianMs)} (${window.timeToApproval.count} approved).`)
  );

  // Emitted ONLY when something is pending: a "0 awaiting review" line every run is noise.
  if (pending.count > 0) {
    const stalled = LI_APPROVAL_DELAY_BUCKET_DAYS
      .map(days => ({ days, count: pending.byAge[delayBucketKey(days)] }))
      .filter(({ count }) => count > 0)
      .map(({ days, count }) => `${count} past ${days}d`)
      .join(', ');
    lines.push(
      `- PENDING HUMAN REVIEW: ${pending.count} filed proposal(s) are awaiting your approver's decision`
      + `${stalled ? ` (${stalled})` : ''}`
      + `${pending.oldestAgeMs === null ? '' : `; oldest has waited ${formatDuration(pending.oldestAgeMs)}`}.`
      + `${pending.undated ? ` ${pending.undated} of them carry no usable filing date and are excluded from the age buckets.` : ''}`
      // An approval backlog means human review capacity is the constraint: raise the bar, not the volume.
      + `${pending.byAge[delayBucketKey(LI_APPROVAL_DELAY_BUCKET_DAYS.at(-1))] > 0
        ? ` Proposals are sitting past ${LI_APPROVAL_DELAY_BUCKET_DAYS.at(-1)} days without a verdict — your bottleneck is human review, not idea supply. Adding to this queue makes it LESS likely any of it is read: file only something clearly more valuable than what is already waiting, or return proposal: null.`
        : ''}`
    );
  }

  lines.push(
    `- LI proposal-phase throughput (distinct from the cosMetrics agent-task lifecycle): `
    + `${proposalPhase.totalDecided} of ${proposalPhase.totalFiled} filed proposals have received any verdict`
    // The percentage renders only once a verdict exists: at zero decisions "0 of 2" says it
    // all and a bare "0%" reads as a failure verdict on a young pipeline. `decisionRate`
    // stays numeric in the route payload.
    + `${proposalPhase.totalDecided > 0 ? ` (${Math.round(proposalPhase.decisionRate)}%)` : ''}`
    + `${proposalPhase.totalPending ? `; ${proposalPhase.totalPending} still unjudged` : ''}.`
  );

  return lines;
}
