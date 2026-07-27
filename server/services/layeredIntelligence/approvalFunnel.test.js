import { describe, it, expect } from 'vitest';
import { computeApprovalFunnel, formatApprovalFunnelLines, delayBucketKey } from './approvalFunnel.js';
import { summarizeDurations } from './awareness.js';
import { LI_APPROVAL_DELAY_BUCKET_DAYS, LI_APPROVAL_FUNNEL_WINDOW_MS } from './constants.js';
import { DAY } from '../../lib/fileUtils.js';

// A fixed clock so every age/window assertion is deterministic.
const NOW = Date.parse('2026-07-20T12:00:00.000Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

// Records use invented placeholder slugs/scopes — never live instance data.
const pendingRecord = (slug, filedMsAgo) => ({
  appId: 'app-example', slug, scope: 'app-improvement', filedAt: iso(filedMsAgo), outcome: null, outcomeAt: null
});
const decidedRecord = (slug, outcome, filedMsAgo, decidedMsAgo) => ({
  appId: 'app-example', slug, scope: 'app-improvement', filedAt: iso(filedMsAgo), outcome, outcomeAt: iso(decidedMsAgo)
});

describe('computeApprovalFunnel (#3120)', () => {
  it('reports null rates — never zeros — for an EMPTY proposal set', () => {
    const funnel = computeApprovalFunnel([], { now: NOW });
    // A zero-proposal window must not read as a failure: every rate is the null
    // sentinel, and the counts are honestly zero.
    expect(funnel.window.approvalRate).toBeNull();
    expect(funnel.window.timeToDecision).toMatchObject({ count: 0, medianMs: null, p90Ms: null });
    expect(funnel.window.timeToApproval.medianMs).toBeNull();
    expect(funnel.pending).toMatchObject({ count: 0, oldestAgeMs: null, undated: 0 });
    expect(funnel.proposalPhase).toMatchObject({ totalFiled: 0, totalDecided: 0, totalPending: 0, decisionRate: null });
  });

  it('treats a non-array (failed read) the same as empty at the math layer', () => {
    // The read/empty distinction is the FORMATTER's job (asserted below); the pure
    // math must not throw on a null and must not invent records.
    expect(computeApprovalFunnel(null, { now: NOW }).proposalPhase.totalFiled).toBe(0);
    expect(computeApprovalFunnel(undefined, { now: NOW }).pending.count).toBe(0);
  });

  it('computes a 100% approval rate when every windowed decision was an approval', () => {
    const outcomes = [
      decidedRecord('alpha', 'merged', 3 * DAY, 2 * DAY),
      decidedRecord('beta', 'merged', 5 * DAY, DAY)
    ];
    const funnel = computeApprovalFunnel(outcomes, { now: NOW });
    expect(funnel.window).toMatchObject({ decided: 2, approved: 2, rejected: 0, abandoned: 0, approvalRate: 100 });
    expect(funnel.pending.count).toBe(0);
    expect(funnel.proposalPhase).toMatchObject({ totalFiled: 2, totalDecided: 2, totalPending: 0, decisionRate: 100 });
    // Median over an ODD sample is the middle value: durations are 1d and 4d.
    expect(funnel.window.timeToDecision.count).toBe(2);
    expect(funnel.window.timeToApproval.medianMs).toBe(Math.round((DAY + 4 * DAY) / 2));
  });

  it('keeps the approval rate NULL when everything is pending (not 0%)', () => {
    const outcomes = [pendingRecord('alpha', 2 * DAY), pendingRecord('beta', 4 * DAY)];
    const funnel = computeApprovalFunnel(outcomes, { now: NOW });
    // The decisive assertion: an idle approver is unknown, not a 0% approval rate.
    expect(funnel.window.approvalRate).toBeNull();
    expect(funnel.window.decided).toBe(0);
    expect(funnel.pending).toMatchObject({ count: 2, oldestAgeMs: 4 * DAY });
    expect(funnel.proposalPhase).toMatchObject({ totalFiled: 2, totalDecided: 0, decisionRate: 0 });
  });

  it('averages the two middle values for an EVEN-count median', () => {
    // Four decisions with filing-to-decision latencies of 1d, 2d, 4d, 8d → median 3d.
    const outcomes = [
      decidedRecord('a', 'merged', 10 * DAY, 9 * DAY),      // 1d
      decidedRecord('b', 'rejected', 9 * DAY, 7 * DAY),     // 2d
      decidedRecord('c', 'merged', 8 * DAY, 4 * DAY),       // 4d
      decidedRecord('d', 'abandoned', 10 * DAY, 2 * DAY)    // 8d
    ];
    const funnel = computeApprovalFunnel(outcomes, { now: NOW });
    expect(funnel.window).toMatchObject({ decided: 4, approved: 2, rejected: 1, abandoned: 1, approvalRate: 50 });
    expect(funnel.window.timeToDecision.count).toBe(4);
    expect(funnel.window.timeToDecision.medianMs).toBe(3 * DAY);
    // Approvals alone (1d, 4d) — also even, so also a mean of the middle pair.
    expect(funnel.window.timeToApproval.medianMs).toBe(Math.round((DAY + 4 * DAY) / 2));
  });

  it('counts a pending proposal at EXACTLY 1/3/7 days in the boundary buckets', () => {
    const outcomes = [
      pendingRecord('exactly-1d', 1 * DAY),
      pendingRecord('exactly-3d', 3 * DAY),
      pendingRecord('exactly-7d', 7 * DAY),
      pendingRecord('fresh', 6 * 60 * 60 * 1000)
    ];
    const { pending } = computeApprovalFunnel(outcomes, { now: NOW });
    // CUMULATIVE and inclusive at the boundary: the 7d record counts in all three,
    // the 3d record in 1d+3d, the 1d record only in 1d, and the 6h record in none.
    expect(pending.byAge[delayBucketKey(1)]).toBe(3);
    expect(pending.byAge[delayBucketKey(3)]).toBe(2);
    expect(pending.byAge[delayBucketKey(7)]).toBe(1);
    expect(pending.count).toBe(4);
    expect(pending.oldestAgeMs).toBe(7 * DAY);
  });

  it('windows on the DECISION date, so an old decision outside the window is excluded', () => {
    const outsideMsAgo = LI_APPROVAL_FUNNEL_WINDOW_MS + DAY;
    const outcomes = [
      decidedRecord('old-reject', 'rejected', outsideMsAgo + DAY, outsideMsAgo),
      decidedRecord('recent-merge', 'merged', 60 * DAY, DAY)
    ];
    const funnel = computeApprovalFunnel(outcomes, { now: NOW });
    // Only the in-window decision counts → 100%, even though lifetime is 50%. A
    // long-open-then-approved proposal still belongs to the window it was DECIDED in.
    expect(funnel.window).toMatchObject({ decided: 1, approved: 1, approvalRate: 100 });
    // Proposal-phase throughput is lifetime, so it still sees both.
    expect(funnel.proposalPhase).toMatchObject({ totalFiled: 2, totalDecided: 2, decisionRate: 100 });
  });

  it('does NOT hide a long-stalled pending proposal behind the window', () => {
    const outcomes = [pendingRecord('ancient', 40 * DAY)];
    const { pending } = computeApprovalFunnel(outcomes, { now: NOW });
    expect(pending.count).toBe(1);
    expect(pending.byAge[delayBucketKey(7)]).toBe(1);
    expect(pending.oldestAgeMs).toBe(40 * DAY);
  });

  it('segregates undatable records instead of laundering them into a bucket', () => {
    const outcomes = [
      { appId: 'app-example', slug: 'no-filed-date', filedAt: null, outcome: null, outcomeAt: null },
      { appId: 'app-example', slug: 'no-decision-date', filedAt: iso(5 * DAY), outcome: 'merged', outcomeAt: 'not-a-date' },
      pendingRecord('dated', 2 * DAY)
    ];
    const funnel = computeApprovalFunnel(outcomes, { now: NOW });
    expect(funnel.pending).toMatchObject({ count: 2, undated: 1, oldestAgeMs: 2 * DAY });
    // The undated decision is excluded from the window (rate stays null) but is
    // reported so an "empty window" is distinguishable from undatable history.
    expect(funnel.window).toMatchObject({ decided: 0, undated: 1, approvalRate: null });
    expect(funnel.proposalPhase).toMatchObject({ totalFiled: 3, totalDecided: 1 });
  });

  it('drops a decision that predates its filing rather than reporting a negative latency', () => {
    const outcomes = [decidedRecord('skewed', 'merged', 2 * DAY, 5 * DAY)];
    const funnel = computeApprovalFunnel(outcomes, { now: NOW });
    expect(funnel.window).toMatchObject({ decided: 1, approved: 1, approvalRate: 100 });
    // The verdict still counts toward the rate; only its unusable latency is dropped.
    expect(funnel.window.timeToDecision).toMatchObject({ count: 0, medianMs: null });
  });

  it('clamps a FUTURE-dated pending filing to a zero age, never a negative one', () => {
    // Cross-peer clock skew / a repaired record can leave filedAt ahead of the local
    // clock. An unclamped age renders as a nonsensical "-1m" wait and would sort itself
    // to the top of the backlog.
    const outcomes = [pendingRecord('from-the-future', -2 * DAY), pendingRecord('real', 3 * DAY)];
    const { pending } = computeApprovalFunnel(outcomes, { now: NOW });
    expect(pending.count).toBe(2);
    // The real 3d record still owns the oldest-wait slot; the skewed one reads as 0.
    expect(pending.oldestAgeMs).toBe(3 * DAY);
    expect(pending.byAge[delayBucketKey(1)]).toBe(1);
    expect(pending.byAge[delayBucketKey(3)]).toBe(1);
  });

  it('clamps a FUTURE-dated decision so it cannot inflate the latency median', () => {
    // A decision dated 2 days ahead of a filing 1 day ago must not report a 3-day
    // latency for a proposal that has only existed for one day.
    const outcomes = [decidedRecord('skewed-forward', 'merged', DAY, -2 * DAY)];
    const funnel = computeApprovalFunnel(outcomes, { now: NOW });
    expect(funnel.window).toMatchObject({ decided: 1, approved: 1, approvalRate: 100 });
    expect(funnel.window.timeToDecision.medianMs).toBe(DAY);
    expect(funnel.window.timeToDecision.medianMs).toBeLessThanOrEqual(DAY);
  });

  it('keeps a FUTURE-dated decision inside the window rather than dropping the verdict', () => {
    // Excluding a skewed verdict is the more dangerous choice: it drops a real decision
    // from BOTH sides of the rate while proposalPhase still counts it, and dropping a
    // REJECTION inflates the approval rate — the one direction that must never flatter.
    const outcomes = [
      decidedRecord('skewed-rejection', 'rejected', DAY, -30 * DAY),
      decidedRecord('real-approval', 'merged', 4 * DAY, 2 * DAY)
    ];
    const funnel = computeApprovalFunnel(outcomes, { now: NOW });
    expect(funnel.window).toMatchObject({ decided: 2, approved: 1, rejected: 1, approvalRate: 50 });
    // The window cohort and the lifetime decided count agree — no verdict silently lost.
    expect(funnel.proposalPhase.totalDecided).toBe(2);
    // And the skew still cannot distort a duration: the clamp holds it at the age of
    // the proposal (1d), not the 31d the raw timestamps imply.
    expect(funnel.window.timeToDecision.maxMs).toBeLessThanOrEqual(4 * DAY);
  });

  it('honors an injected window span', () => {
    const outcomes = [decidedRecord('mid', 'merged', 6 * DAY, 5 * DAY)];
    expect(computeApprovalFunnel(outcomes, { now: NOW, windowMs: 3 * DAY }).window.approvalRate).toBeNull();
    expect(computeApprovalFunnel(outcomes, { now: NOW, windowMs: 10 * DAY }).window.approvalRate).toBe(100);
  });

  it('seeds every configured delay bucket even when nothing is pending', () => {
    const { pending } = computeApprovalFunnel([decidedRecord('a', 'merged', 2 * DAY, DAY)], { now: NOW });
    for (const days of LI_APPROVAL_DELAY_BUCKET_DAYS) {
      expect(pending.byAge[delayBucketKey(days)]).toBe(0);
    }
  });
});

describe('formatApprovalFunnelLines (#3120)', () => {
  it('reports UNAVAILABLE for a failed/absent read, never a clean empty funnel', () => {
    const lines = formatApprovalFunnelLines({ outcomes: null, now: NOW });
    expect(lines.join('\n')).toContain('LI approval funnel: UNAVAILABLE');
    // A failed read must NOT render a pending indicator or a rate.
    expect(lines.join('\n')).not.toContain('PENDING HUMAN REVIEW');
  });

  it('distinguishes a genuinely empty history from a failed read', () => {
    const text = formatApprovalFunnelLines({ outcomes: [], now: NOW }).join('\n');
    expect(text).toContain('no proposals filed yet');
    expect(text).toContain('NOT a failed read');
  });

  it('omits the pending indicator entirely when nothing is awaiting review', () => {
    const text = formatApprovalFunnelLines({
      outcomes: [decidedRecord('a', 'merged', 3 * DAY, 2 * DAY)],
      now: NOW
    }).join('\n');
    expect(text).not.toContain('PENDING HUMAN REVIEW');
    expect(text).toContain('LI approval rate');
  });

  it('shows the pending count with its age buckets when the count is > 0', () => {
    const text = formatApprovalFunnelLines({
      outcomes: [pendingRecord('stalled', 9 * DAY), pendingRecord('fresh', 2 * 60 * 60 * 1000)],
      now: NOW
    }).join('\n');
    expect(text).toContain('PENDING HUMAN REVIEW: 2 filed proposal(s)');
    expect(text).toContain('1 past 1d');
    expect(text).toContain('1 past 7d');
    // Past the last bucket → the "your bottleneck is human review" guidance arms.
    expect(text).toContain('bottleneck is human review');
  });

  it('does not arm the bottleneck guidance for a young pending queue', () => {
    const text = formatApprovalFunnelLines({
      outcomes: [pendingRecord('fresh', 2 * 60 * 60 * 1000)],
      now: NOW
    }).join('\n');
    expect(text).toContain('PENDING HUMAN REVIEW: 1 filed proposal(s)');
    expect(text).not.toContain('bottleneck is human review');
  });

  it('says the rate is unknown — not 0% — when the window holds no decision', () => {
    const text = formatApprovalFunnelLines({
      outcomes: [pendingRecord('alpha', 2 * DAY)],
      now: NOW
    }).join('\n');
    expect(text).toContain('rate unknown');
    expect(text).not.toContain('0% —');
  });

  it('never renders a bare 0% when nothing has been decided yet', () => {
    // A young pipeline must not be told it is at 0% — the fraction ("0 of 2") carries
    // the fact without the failure verdict a percentage implies.
    const text = formatApprovalFunnelLines({
      outcomes: [pendingRecord('a', DAY), pendingRecord('b', 2 * DAY)],
      now: NOW
    }).join('\n');
    expect(text).not.toContain('0%');
    expect(text).toContain('0 of 2 filed proposals have received any verdict');
  });

  it('DOES render 0% when the approver really rejected everything in the window', () => {
    // The inverse of the case above: a measured 0% approval rate over real decisions is
    // evidence, and must be stated plainly rather than softened into "unknown".
    const text = formatApprovalFunnelLines({
      outcomes: [decidedRecord('a', 'rejected', 4 * DAY, 3 * DAY), decidedRecord('b', 'rejected', 3 * DAY, DAY)],
      now: NOW
    }).join('\n');
    expect(text).toContain('LI approval rate (last 14d): 0% — 0 of 2 decisions were approvals');
  });

  it('names the proposal-phase line as distinct from cosMetrics', () => {
    const text = formatApprovalFunnelLines({
      outcomes: [decidedRecord('a', 'merged', 3 * DAY, 2 * DAY), pendingRecord('b', DAY)],
      now: NOW
    }).join('\n');
    expect(text).toContain('LI proposal-phase throughput (distinct from the cosMetrics agent-task lifecycle)');
    expect(text).toContain('1 of 2 filed proposals have received any verdict');
  });
});

describe('summarizeDurations (shared duration stats)', () => {
  it('returns nulls with count 0 for an empty sample', () => {
    expect(summarizeDurations([])).toEqual({ count: 0, averageMs: null, medianMs: null, p90Ms: null, minMs: null, maxMs: null });
  });

  it('drops NaN and negative values rather than treating them as 0ms', () => {
    expect(summarizeDurations([NaN, -5, 10])).toMatchObject({ count: 1, medianMs: 10, minMs: 10, maxMs: 10 });
  });

  it('averages the middle pair for an even sample and takes the middle for an odd one', () => {
    expect(summarizeDurations([4, 1, 3, 2]).medianMs).toBe(3); // mean of 2 and 3 → 2.5 → 3
    expect(summarizeDurations([5, 1, 3]).medianMs).toBe(3);
  });

  it('takes p90 at the nearest rank', () => {
    expect(summarizeDurations([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]).p90Ms).toBe(9);
  });
});
