/**
 * Layered Intelligence — proposal APPROVAL FUNNEL metrics (#3120).
 *
 * The outcome store already answers "how did my resolved proposals fare?"
 * (`summarizeOutcomeStats`) and "did my approved proposals get delivered?"
 * (`computeProposalOutcomeMetrics`). Neither can answer the question this module exists
 * for: **where in the human-approval funnel are my proposals stuck, and is the user's
 * triage behavior changing?** Those are the loop's own bottleneck signals —
 * a backlog of undecided proposals is a reason to STOP filing, and neither a lifetime
 * merge rate nor a delivery rate makes it visible.
 *
 * Five metrics, all derived from the proposal LIFECYCLE (`filedAt` → `outcome` +
 * `outcomeAt`) that `data/cos/li-outcomes/` already persists — explicitly NOT from
 * tracker labels, and with no second on-disk aggregate to drift from its source:
 *   1. Approval rate over a sliding window — measured over the decisions the user made
 *      INSIDE the window, so it tracks current triage behavior rather than restating the
 *      lifetime rate.
 *   2. Pending-review count — proposals awaiting a human decision right now.
 *   3. Median time from filing to a human decision (and, separately, to an APPROVAL).
 *   4. Approver-delay buckets — how many undecided proposals are past 1 / 3 / 7 days.
 *   5. Proposal-PHASE delivery: what share of everything LI filed has received any
 *      verdict at all. Deliberately distinct from `cosMetrics`, which measures the
 *      AGENT-TASK lifecycle ("did the run finish?") and says nothing about whether a
 *      filed proposal was ever looked at.
 *
 * Pure + side-effect-free, and NO LLM call: every number is a read of records the loop
 * already keeps (the "no cold-bootstrap LLM calls" policy). `now` is an injected clock
 * seam so the ages are testable and so one selfEval run reasons against a single "now".
 *
 * SENTINEL DISCIPLINE throughout — a rate whose denominator is zero is `null`, never 0:
 * "no decision has been made in this window" and "every decision was a rejection" are
 * opposite facts, and a 0% approval rate in the prompt is a direct instruction to the
 * reasoner to hold back. A record whose timestamp cannot be parsed is counted in an
 * explicit `undated` slot rather than being placed in a window or an age bucket it
 * cannot be shown to belong to.
 */

import { DAY, formatDuration } from '../../lib/fileUtils.js';
import { LI_APPROVAL_FUNNEL_WINDOW_MS, LI_APPROVAL_DELAY_BUCKET_DAYS } from './constants.js';
import { summarizeDurations } from './awareness.js';

// The bucket key for an age threshold — `1` → `'1d'`. One place so the computed object's
// keys and the rendered line can't disagree.
export const delayBucketKey = (days) => `${days}d`;

/** A parsed epoch-ms timestamp, or null when the value is absent/unparseable. */
const parsedMs = (value) => {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

/**
 * Clamp a timestamp at `now`. Nothing can have elapsed INTO the future, but a record's
 * timestamps are not guaranteed to be in the past: cross-peer clock skew, a repaired
 * record, or a tracker reporting in a different timezone offset can all leave a
 * `filedAt`/`outcomeAt` ahead of the local clock. Unclamped that yields a NEGATIVE
 * pending age (which `formatDuration` renders as a nonsensical "-1m") and an inflated
 * filing-to-decision latency that drags the median. Clamping reads a future-dated record
 * as "this just happened", which is the closest true statement available — and it is
 * applied only to ELAPSED-TIME math, never to the window membership test: a decision is
 * still a decision whenever it is dated.
 */
const elapsedSince = (ms, now) => Math.max(0, now - ms);

/**
 * Compute the approval-funnel metrics for one app's outcome records.
 *
 * @param {Array} [outcomes] - the app's li-outcomes records (from listOutcomes). A
 *   NON-array is treated as an empty set here; callers that must distinguish a FAILED
 *   store read from a genuinely empty history check that BEFORE calling (the report
 *   formatter below does).
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

  // --- Decision cohort: verdicts the user issued inside the window --------------
  // Keyed on `outcomeAt` (WHEN the user decided), not `filedAt`: the metric is about the
  // user's current triage behavior, so a 5-month-old proposal decided yesterday belongs
  // in this window and a proposal filed yesterday and still open does not.
  const decided = records.filter(r => r.outcome);
  const decidedInWindow = [];
  let undatedDecisions = 0;
  for (const r of decided) {
    const decidedMs = parsedMs(r.outcomeAt);
    // An undatable decision cannot be placed in or out of the window. Counting it in
    // would inflate a "recent" rate with an unknown-age verdict; counting it out
    // silently would undercount the user's activity. It gets its own slot.
    if (decidedMs === null) { undatedDecisions += 1; continue; }
    if (decidedMs >= windowStart) decidedInWindow.push({ record: r, decidedMs });
  }
  const countOutcome = (name) => decidedInWindow.filter(({ record }) => record.outcome === name).length;
  const approvedInWindow = decidedInWindow.filter(({ record }) => record.outcome === 'merged');
  // Filing-to-decision latency. Only measurable when BOTH timestamps parse and the
  // decision does not precede the filing (a clock-skewed or hand-edited record);
  // summarizeDurations drops the NaN/negative values for us. Both ends are clamped at
  // `now` so a future-dated record cannot contribute a latency longer than the proposal
  // has existed and drag the median.
  const latency = (entries) => summarizeDurations(
    entries.map(({ record, decidedMs }) => {
      const filedMs = parsedMs(record.filedAt);
      return filedMs === null ? NaN : Math.min(decidedMs, now) - Math.min(filedMs, now);
    })
  );

  // --- Right-now snapshot: what is awaiting a human decision -------------------
  // Deliberately NOT windowed: a proposal that has sat undecided for 40 days is the
  // single most important thing in this block, and a window would hide it.
  const pending = records.filter(r => !r.outcome);
  const byAge = Object.create(null);
  for (const days of LI_APPROVAL_DELAY_BUCKET_DAYS) byAge[delayBucketKey(days)] = 0;
  let oldestAgeMs = null;
  let undatedPending = 0;
  for (const r of pending) {
    const filedMs = parsedMs(r.filedAt);
    if (filedMs === null) { undatedPending += 1; continue; }
    // Clamped at zero: a future-dated filing has waited no time at all, not a negative
    // amount. Without this the oldest-wait line renders as "-1m" and a skewed record
    // could sort itself to the top of the backlog.
    const ageMs = elapsedSince(filedMs, now);
    if (oldestAgeMs === null || ageMs > oldestAgeMs) oldestAgeMs = ageMs;
    // CUMULATIVE buckets: a 9-day-old proposal counts in 1d, 3d AND 7d, so the three
    // numbers read as a decay curve. `>=` so an age exactly at the threshold counts —
    // "older than 1 day" at precisely 24h is past the mark, not short of it.
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
      // Decisions the store holds but cannot date — reported so a window that looks
      // empty is distinguishable from a store full of undatable verdicts.
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
      // The proposal-phase analogue of a delivery rate: of everything LI filed, what
      // share ever got a human verdict? Null (not 0) when nothing has been filed.
      decisionRate: records.length > 0 ? (decided.length / records.length) * 100 : null
    }
  };
}

/**
 * Render the funnel as the lines folded into the `liSelfEval` block (#3120), so the
 * reasoner sees its own approval bottleneck on EVERY run rather than only in a dashboard.
 *
 * Takes the SAME three-valued `outcomes` argument `computeSelfEvalSummary` receives:
 *   - not an array → the outcomes source is off / the store was unreadable. Reported as
 *     UNAVAILABLE. A failed read must never render as a clean zero-proposal funnel.
 *   - `[]`         → read fine, genuinely nothing filed. Reported as such.
 * Returns an array of lines (never a bare string) so the caller splices them into its
 * own list without re-splitting.
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
      // Deliberately free of any literal percentage: an idle approver means the rate is
      // UNKNOWN, and even a rate quoted inside a disclaimer is a number the reasoner can
      // latch onto as its own record.
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

  // "Pending human review" indicator — emitted ONLY when something is actually pending
  // (the issue's explicit requirement). A "0 awaiting review" line every run would be
  // noise, and worse, would read as reassurance in exactly the case where the real
  // signal is elsewhere.
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
      // The actionable read: an approval backlog means the constraint is human review
      // capacity, not idea supply. Filing more into a full queue lowers the odds any of
      // it is read — so the correct response is a higher bar, not more volume.
      + `${pending.byAge[delayBucketKey(LI_APPROVAL_DELAY_BUCKET_DAYS.at(-1))] > 0
        ? ` Proposals are sitting past ${LI_APPROVAL_DELAY_BUCKET_DAYS.at(-1)} days without a verdict — your bottleneck is human review, not idea supply. Adding to this queue makes it LESS likely any of it is read: file only something clearly more valuable than what is already waiting, or return proposal: null.`
        : ''}`
    );
  }

  lines.push(
    `- LI proposal-phase throughput (distinct from the cosMetrics agent-task lifecycle): `
    + `${proposalPhase.totalDecided} of ${proposalPhase.totalFiled} filed proposals have received any verdict`
    // The percentage is only rendered once a verdict exists. At zero decisions the
    // fraction already says everything ("0 of 2"), and a bare "0%" in the self-eval
    // block reads to the reasoner as a failure verdict on a pipeline that may simply be
    // young — the same reason `computeSelfEvalSummary` keeps an unresolved merge rate
    // out of percentage form. The computed `decisionRate` is unchanged for the
    // queryable route payload, where a numeric 0 over a real denominator is correct.
    + `${proposalPhase.totalDecided > 0 ? ` (${Math.round(proposalPhase.decisionRate)}%)` : ''}`
    + `${proposalPhase.totalPending ? `; ${proposalPhase.totalPending} still unjudged` : ''}.`
  );

  return lines;
}
