import { describe, it, expect } from 'vitest';
import {
  deriveOutcome,
  computeOutcomesReport,
  summarizeOutcomeStats,
  describeSuppressedIssue,
  suppressedIssueSlug,
  rejectionReasonBySlug,
  computeProposalOutcomeMetrics,
  computeDeliveryMetrics,
  computeDeliveryThrottle,
  formatDeliveryThrottleGuidance,
  computeLiExecutionHealth,
} from './outcomes.js';
import {
  LI_DELIVERY_MIN_SAMPLE,
  LOW_MERGE_RATE_THRESHOLD,
  LOW_MERGE_RATE_MIN_SAMPLE,
} from './constants.js';
import {
  computePostApprovalCompletion,
} from './awareness.js';

describe('computeProposalOutcomeMetrics (#3014)', () => {
  const RECORDS = [
    // Approved and delivered.
    { scope: 'app-improvement', outcome: 'merged', executionOutcome: 'success', filedAt: '2026-07-01T00:00:00.000Z', executionAt: '2026-07-01T01:00:00.000Z' },
    // Approved, handed off, hand-off failed.
    { scope: 'app-improvement', outcome: 'merged', executionOutcome: 'failure', filedAt: '2026-07-01T00:00:00.000Z', executionAt: '2026-07-01T02:00:00.000Z' },
    // Approved but LOST — never executed. The bucket a rejection tally can't see.
    { scope: 'app-data-gap', outcome: 'merged', executionOutcome: null, filedAt: '2026-07-01T00:00:00.000Z' },
    // Rejected outright, in a scope that never had an approval at all.
    { scope: 'loop-meta', outcome: 'rejected', filedAt: '2026-07-01T00:00:00.000Z' },
    // Closed for some other reason (filing-side abandonment).
    { scope: 'loop-meta', outcome: 'abandoned', filedAt: '2026-07-01T00:00:00.000Z' },
    // Still open — awaiting triage, not a failure.
    { scope: 'app-data-gap', outcome: null, filedAt: '2026-07-01T00:00:00.000Z' }
  ];

  it('rolls filing and execution outcomes into one metrics object', () => {
    const out = computeProposalOutcomeMetrics(RECORDS);
    expect(out).toMatchObject({
      totalFiled: 6,
      totalApproved: 3,
      totalCompleted: 1,
      totalRejected: 1,
      totalAbandonedAtFiling: 1,
      totalPending: 1,
      totalAwaitingExecution: 1,
      totalFailedExecution: 1
    });
    // 1 of 3 approved actually delivered — while the attempted-only rate reads 50%.
    expect(out.approvalToCompletionRate).toBeCloseTo(100 / 3, 10);
    expect(out.completionRate).toBe(50);
  });

  it('breaks down by scope, keeping scopes that were only ever rejected', () => {
    const { byScope } = computeProposalOutcomeMetrics(RECORDS);
    expect(byScope['app-improvement']).toMatchObject({
      approved: 2, completed: 1, rejected: 0, abandonedAtFiling: 0, failedExecution: 1,
      awaitingExecution: 0, attempted: 2, completionRate: 50, approvalToCompletionRate: 50
    });
    expect(byScope['app-data-gap']).toMatchObject({
      approved: 1, completed: 0, awaitingExecution: 1, pending: 1,
      completionRate: null, approvalToCompletionRate: 0
    });
    // A never-approved scope still appears, with null rates rather than a fake 0%.
    expect(byScope['loop-meta']).toMatchObject({
      approved: 0, completed: 0, rejected: 1, abandonedAtFiling: 1,
      completionRate: null, approvalToCompletionRate: null
    });
  });

  it('never counts a non-approved proposal towards completion (rate stays <= 100%)', () => {
    // A hand-off that succeeded for a REJECTED proposal is not evidence that approval
    // leads to delivery — letting it into the numerator would exceed 100%.
    const out = computeProposalOutcomeMetrics([
      { scope: 'app-improvement', outcome: 'merged', executionOutcome: 'success', filedAt: '2026-07-01T00:00:00.000Z', executionAt: '2026-07-01T01:00:00.000Z' },
      { scope: 'app-improvement', outcome: 'rejected', executionOutcome: 'success', filedAt: '2026-07-01T00:00:00.000Z', executionAt: '2026-07-01T01:00:00.000Z' }
    ]);
    expect(out.totalApproved).toBe(1);
    expect(out.totalCompleted).toBe(1);
    expect(out.approvalToCompletionRate).toBe(100);
  });

  it('returns zeroed totals with null rates for an empty or invalid history', () => {
    for (const input of [[], null, undefined]) {
      const out = computeProposalOutcomeMetrics(input);
      expect(out).toMatchObject({
        totalFiled: 0, totalApproved: 0, totalCompleted: 0, totalRejected: 0,
        totalAbandonedAtFiling: 0, totalPending: 0, approvalToCompletionRate: null, completionRate: null
      });
      expect(Object.keys(out.byScope)).toEqual([]);
    }
  });

  it('produces the same result whether or not the caller pre-computes the aggregates', () => {
    // The route hands in the `stats`/`execution` it already computed to avoid a second
    // pass. That shortcut must stay a pure optimization — if it ever diverges from
    // recomputing, the API's three blocks silently disagree about the same records.
    const stats = summarizeOutcomeStats(RECORDS);
    const execution = computePostApprovalCompletion(stats.filed);
    expect(computeProposalOutcomeMetrics(RECORDS, { stats, execution }))
      .toEqual(computeProposalOutcomeMetrics(RECORDS));
  });

  it('buckets a "__proto__" scope as data rather than rewriting the prototype', () => {
    const { byScope } = computeProposalOutcomeMetrics([
      { scope: '__proto__', outcome: 'merged', executionOutcome: 'success', filedAt: '2026-07-01T00:00:00.000Z', executionAt: '2026-07-01T01:00:00.000Z' }
    ]);
    expect(Object.keys(byScope)).toContain('__proto__');
    expect(byScope['__proto__'].approvalToCompletionRate).toBe(100);
    expect({}.approvalToCompletionRate).toBeUndefined();
  });
});

describe('computeDeliveryMetrics (#3085)', () => {
  const RECORDS = [
    { scope: 'app-improvement', outcome: 'merged', executionOutcome: 'success', filedAt: '2026-07-01T00:00:00.000Z', executionAt: '2026-07-01T01:00:00.000Z' },
    { scope: 'app-improvement', outcome: 'merged', executionOutcome: 'failure', filedAt: '2026-07-01T00:00:00.000Z', executionAt: '2026-07-01T02:00:00.000Z' },
    { scope: 'app-data-gap', outcome: 'merged', executionOutcome: null, filedAt: '2026-07-01T00:00:00.000Z' },
    // Rejected-only scope: it has a filing record but nothing was ever approved there.
    { scope: 'loop-meta', outcome: 'rejected', filedAt: '2026-07-01T00:00:00.000Z' }
  ];

  it('projects the approval → delivery totals and rate', () => {
    const { delivery } = computeDeliveryMetrics(RECORDS);
    // 3 approved, 1 delivered → 33%. The run-success rates sitting beside this in the
    // same document say nothing about that gap, which is the whole point of the block.
    expect(delivery).toEqual({ totalApproved: 3, totalDelivered: 1, currentDeliveryRate: 33 });
  });

  it('breaks delivery down per scope, omitting scopes with no approvals', () => {
    const { deliveryByScope } = computeDeliveryMetrics(RECORDS);
    expect(deliveryByScope).toEqual({
      'app-improvement': { approved: 2, delivered: 1 },
      'app-data-gap': { approved: 1, delivered: 0 }
    });
    // A scope whose every proposal was rejected carries no delivery signal — its
    // 0-of-0 row would only restate the merge-rate block.
    expect(deliveryByScope['loop-meta']).toBeUndefined();
  });

  it('reports a NULL rate (never 0%) when nothing has been approved yet', () => {
    // The sentinel rule: "no approvals to deliver on" is not "every approval was lost".
    // This rate arms the hard exclusion gate, so a 0 here would lock out a cold loop.
    for (const input of [[], null, [{ scope: 'loop-meta', outcome: 'rejected' }]]) {
      const { delivery, deliveryByScope } = computeDeliveryMetrics(input);
      expect(delivery).toEqual({ totalApproved: 0, totalDelivered: 0, currentDeliveryRate: null });
      expect(Object.keys(deliveryByScope)).toEqual([]);
    }
  });

  it('agrees with the roll-up it projects', () => {
    // `scope` is LLM-authored, so the two must never disagree about which scope a
    // record belongs to — the prompt and the exclusion gate both trace back here.
    const rolled = computeProposalOutcomeMetrics(RECORDS);
    const { delivery, deliveryByScope } = computeDeliveryMetrics(RECORDS);
    expect(delivery.totalApproved).toBe(rolled.totalApproved);
    expect(delivery.totalDelivered).toBe(rolled.totalCompleted);
    expect(deliveryByScope['app-improvement'].delivered).toBe(rolled.byScope['app-improvement'].completed);
  });

  it('buckets a "__proto__" scope as data rather than rewriting the prototype', () => {
    const { deliveryByScope } = computeDeliveryMetrics([
      { scope: '__proto__', outcome: 'merged', executionOutcome: 'success', filedAt: '2026-07-01T00:00:00.000Z', executionAt: '2026-07-01T01:00:00.000Z' }
    ]);
    // On a plain object `bucket['__proto__'] = …` swaps the prototype instead of adding
    // a key, so the bucket would vanish from Object.keys. The null prototype is what
    // makes it data — assert the prototype directly, since a passing Object.keys check
    // on Object.prototype pollution would be silent.
    expect(Object.getPrototypeOf(deliveryByScope)).toBeNull();
    expect(Object.keys(deliveryByScope)).toContain('__proto__');
  });
});

describe('computeDeliveryThrottle (#3160)', () => {
  const health = (deliveryRate, deliverySample) => ({ deliveryRate, deliverySample });

  it('returns null when delivery data is unavailable', () => {
    expect(computeDeliveryThrottle(null)).toBeNull();
    expect(computeDeliveryThrottle(health(null, 0))).toBeNull();
    expect(computeDeliveryThrottle(health(Number.NaN, 5))).toBeNull();
  });

  it('stops below the evidence floor regardless of the observed rate', () => {
    expect(computeDeliveryThrottle(health(100, LI_DELIVERY_MIN_SAMPLE - 1))).toBe(0);
    expect(computeDeliveryThrottle(health(0, 1))).toBe(0);
  });

  it('stops a sufficiently-sampled delivery rate below 20%', () => {
    expect(computeDeliveryThrottle(health(0, LI_DELIVERY_MIN_SAMPLE))).toBe(0);
    expect(computeDeliveryThrottle(health(19.99, LI_DELIVERY_MIN_SAMPLE))).toBe(0);
  });

  it('scales proportionally from 0% to full throttle at 75%', () => {
    expect(computeDeliveryThrottle(health(20, LI_DELIVERY_MIN_SAMPLE))).toBeCloseTo(20 / 75);
    expect(computeDeliveryThrottle(health(50, 12))).toBeCloseTo(2 / 3);
    expect(computeDeliveryThrottle(health(75, 12))).toBe(1);
    expect(computeDeliveryThrottle(health(100, 12))).toBe(1);
  });

  it('formats full, degraded, stopped, cold-start, and unavailable prompt guidance', () => {
    expect(formatDeliveryThrottleGuidance(health(75, 12)))
      .toContain('LI proposal throttle: full — based on 75% delivery rate from 12 approved proposals');
    expect(formatDeliveryThrottleGuidance(health(50, 12)))
      .toContain('LI proposal throttle: 67% — based on 50% delivery rate from 12 approved proposals');
    expect(formatDeliveryThrottleGuidance(health(0, 12)))
      .toContain('LI proposal throttle: stopped — based on 0% delivery rate from 12 approved proposals');
    expect(formatDeliveryThrottleGuidance(health(0, 12))).toContain('return proposal: null');
    expect(formatDeliveryThrottleGuidance(health(19.99, 12))).toContain('return proposal: null');
    expect(formatDeliveryThrottleGuidance(health(100, LI_DELIVERY_MIN_SAMPLE - 1)))
      .toContain(`at least ${LI_DELIVERY_MIN_SAMPLE} approvals are required before filing resumes`);
    expect(formatDeliveryThrottleGuidance(health(null, 0)))
      .toContain('LI proposal throttle: unavailable');
  });
});

describe('computeLiExecutionHealth (#2824)', () => {
  const stats = (over = {}) => ({ read: true, metrics: { completed: 10, succeeded: 3, failed: 7, successRate: 30, recentOutcomes: [], ...over } });

  it('reports UNKNOWN (rate null) when the store is unreadable or has no runs', () => {
    expect(computeLiExecutionHealth(null)).toEqual({
      rate: null, sample: 0, source: null, confident: false,
      deliveryRate: null, deliverySample: 0, deliveryConfident: false
    });
    expect(computeLiExecutionHealth({ read: false })).toMatchObject({ rate: null, confident: false });
    expect(computeLiExecutionHealth({ read: true, metrics: null })).toMatchObject({ rate: null, confident: false });
  });

  it('reads the effective lifetime rate + sample and marks it confident above the floor', () => {
    const health = computeLiExecutionHealth(stats());
    expect(health.rate).toBe(30);
    expect(health.sample).toBe(10);
    expect(health.confident).toBe(true);
  });

  it('keeps run health independent from approval-to-completion delivery health', () => {
    const outcomes = [
      { outcome: 'merged', executionOutcome: 'success' },
      ...Array.from({ length: 4 }, () => ({ outcome: 'merged', executionOutcome: null }))
    ];
    const health = computeLiExecutionHealth(stats({ succeeded: 9, failed: 1, successRate: 90 }), outcomes);
    expect(health).toMatchObject({
      rate: 90,
      sample: 10,
      confident: true,
      deliveryRate: 20,
      deliverySample: 5,
      deliveryConfident: true
    });
  });

  it('is NOT confident below LI_DEGRADED_MIN_SAMPLE runs', () => {
    const health = computeLiExecutionHealth(stats({ completed: 2, succeeded: 0, failed: 2, successRate: 0 }));
    expect(health.rate).toBe(0);
    expect(health.sample).toBe(2);
    expect(health.confident).toBe(false);
  });
});

describe('deriveOutcome', () => {
  it('leaves an open issue unresolved', () => {
    expect(deriveOutcome({ state: 'open' })).toBeNull();
    expect(deriveOutcome({ state: 'OPEN', stateReason: 'reopened' })).toBeNull();
    expect(deriveOutcome({})).toBeNull();
  });

  it('maps closed-not-planned to rejected', () => {
    expect(deriveOutcome({ state: 'closed', stateReason: 'not_planned' })).toBe('rejected');
    expect(deriveOutcome({ state: 'closed', stateReason: 'not planned' })).toBe('rejected');
  });

  it('maps closed-completed (and reason-less closes from glab/jira/plan) to merged', () => {
    expect(deriveOutcome({ state: 'closed', stateReason: 'completed' })).toBe('merged');
    // Graceful fallback: trackers that report no stateReason keep the current
    // merged behavior — their common close path IS a merge (#2620).
    expect(deriveOutcome({ state: 'closed' })).toBe('merged');
    expect(deriveOutcome({ state: 'closed', stateReason: null })).toBe('merged');
    expect(deriveOutcome({ state: 'closed', stateReason: '' })).toBe('merged');
  });

  it('maps a close with any OTHER present reason to abandoned (#2620)', () => {
    expect(deriveOutcome({ state: 'closed', stateReason: 'duplicate' })).toBe('abandoned');
    expect(deriveOutcome({ state: 'closed', stateReason: 'stale' })).toBe('abandoned');
    expect(deriveOutcome({ state: 'closed', stateReason: 'reopened' })).toBe('abandoned');
  });
});

describe('computeOutcomesReport', () => {
  it('returns empty string when there is no filed history', () => {
    expect(computeOutcomesReport({ outcomes: [] })).toBe('');
    expect(computeOutcomesReport({})).toBe('');
  });

  it('summarizes totals, per-scope merge rates, and classified rejection reasons', () => {
    const outcomes = [
      { scope: 'app-data-gap', outcome: 'merged' },
      { scope: 'app-data-gap', outcome: 'merged' },
      { scope: 'app-improvement', outcome: 'rejected', rejectionReason: 'duplicate' },
      { scope: 'app-improvement', outcome: null }
    ];
    const report = computeOutcomesReport({ outcomes });
    expect(report).toContain('Total filed: 4');
    expect(report).toContain('Merged/implemented: 2 (50%)');
    expect(report).toContain('Rejected: 1 (25%)');
    expect(report).toContain('Still open: 1 (25%)');
    expect(report).toContain('app-data-gap: 2 filed, 2 merged (100%)');
    expect(report).toContain('app-improvement: 2 filed, 0 merged (0%)');
    // The taxonomy gloss (#2689), not the raw tracker string this used to echo.
    expect(report).toContain('Why non-merged proposals were closed: already tracked elsewhere (duplicate) (1)');
  });

  it('adds post-approval completion rates and filed-to-completed duration distribution (#2944)', () => {
    const report = computeOutcomesReport({
      outcomes: [
        {
          scope: 'app-improvement', outcome: 'merged', executionOutcome: 'success',
          filedAt: '2026-07-01T00:00:00.000Z', executionAt: '2026-07-01T01:00:00.000Z'
        },
        {
          scope: 'app-improvement', outcome: 'merged', executionOutcome: 'failure',
          filedAt: '2026-07-01T00:00:00.000Z', executionAt: '2026-07-01T02:00:00.000Z'
        },
        { scope: 'app-data-gap', outcome: 'merged', executionOutcome: null }
      ]
    });

    expect(report).toContain('Post-approval LI hand-off follow-through:');
    expect(report).toContain('Approved proposals: 3; 1 completed, 1 abandoned, 1 awaiting execution.');
    expect(report).toContain('Completion rate: 50% (1/2 attempted).');
    expect(report).toContain('average 1h 0m, median 1h 0m, p90 1h 0m (1 completed)');
    expect(report).toContain('app-improvement: 1 completed, 1 abandoned, 0 awaiting execution; 50% completed');
  });

  it('surfaces the execution-failure taxonomy line only when a hand-off has failed (#2764 §1)', () => {
    // A clean execution record shows no failure line…
    const clean = computeOutcomesReport({
      outcomes: [{ scope: 'loop-meta', outcome: 'merged', executionOutcome: 'success' }]
    });
    expect(clean).not.toContain("Why LI's own hand-offs failed");

    // …but a failed hand-off surfaces the classified "why".
    const withFailure = computeOutcomesReport({
      outcomes: [
        { scope: 'loop-meta', outcome: 'merged', executionOutcome: 'success' },
        { scope: 'loop-meta', outcome: null, executionOutcome: 'failure', failureCategory: 'testing' },
        { scope: 'loop-meta', outcome: null, executionOutcome: 'failure', failureCategory: 'testing' },
        { scope: 'loop-meta', outcome: null, executionOutcome: 'failure', failureCategory: 'execution' }
      ]
    });
    expect(withFailure).toContain("Why LI's own hand-offs failed when implemented:");
    expect(withFailure).toContain('regression'); // the `testing` gloss
    expect(withFailure).toContain('(2)');         // commonest diagnosis count
  });

  it('reports an undiagnosed rejection history as the data gap it is (#2689)', () => {
    const report = computeOutcomesReport({
      outcomes: [
        { scope: 'app-improvement', outcome: 'merged' },
        { scope: 'app-improvement', outcome: 'rejected', rejectionReason: 'unknown-reason' }
      ]
    });
    expect(report).toContain('Why non-merged proposals were closed: 1 of 1 closed with no recorded reason');
  });

  it('says nothing has been closed unmerged rather than implying no reasons exist (#2689)', () => {
    const report = computeOutcomesReport({ outcomes: [{ scope: 'app-improvement', outcome: 'merged' }] });
    expect(report).toContain('Why non-merged proposals were closed: nothing has been closed unmerged yet');
  });

  it('never claims nothing was closed unmerged while reporting rejections (#2689)', () => {
    // A resolved record that reconcile has not classified yet (a pre-taxonomy
    // install, or an issue that fell out of the tracker read) must not make the
    // report contradict its own "Rejected: 2" line two rows above.
    const report = computeOutcomesReport({
      outcomes: [
        { scope: 'app-improvement', outcome: 'rejected' },
        { scope: 'app-improvement', outcome: 'abandoned' }
      ]
    });
    expect(report).toContain('Rejected: 1 (50%)');
    expect(report).not.toContain('nothing has been closed unmerged yet');
    expect(report).toContain('Why non-merged proposals were closed: 2 of 2 not yet classified');
  });

  it('reports abandoned distinctly and excludes it from the merged numerator (#2620)', () => {
    const outcomes = [
      { scope: 'app-improvement', outcome: 'merged' },
      { scope: 'app-improvement', outcome: 'abandoned' },
      { scope: 'app-improvement', outcome: 'abandoned' },
      { scope: 'app-improvement', outcome: 'rejected', rejectionReason: 'duplicate' }
    ];
    const report = computeOutcomesReport({ outcomes });
    expect(report).toContain('Abandoned: 2 (50%)');
    expect(report).toContain('Merged/implemented: 1 (25%)');
    // Per-scope merge rate: abandoned counts in filed, never in merged.
    expect(report).toContain('app-improvement: 4 filed, 1 merged (25%)');
  });

});

describe('summarizeOutcomeStats', () => {
  it('reports a null merge rate (not 0) when nothing has resolved yet', () => {
    const stats = summarizeOutcomeStats([{ outcome: null }, { outcome: null }]);
    expect(stats.total).toBe(2);
    expect(stats.pending).toBe(2);
    expect(stats.resolved).toBe(0);
    // The sentinel that keeps "awaiting triage" from reading as "all rejected".
    expect(stats.rawMergeRate).toBeNull();
  });

  it('measures the merge rate over resolved proposals only, unrounded', () => {
    const stats = summarizeOutcomeStats([
      { outcome: 'merged' },
      { outcome: 'rejected' },
      { outcome: 'abandoned' },
      { outcome: null }
    ]);
    expect(stats.resolved).toBe(3);
    expect(stats.pending).toBe(1);
    expect(stats.rawMergeRate).toBeCloseTo(33.33, 1);
  });

  it('tolerates a non-array / junk input', () => {
    expect(summarizeOutcomeStats(null).total).toBe(0);
    expect(summarizeOutcomeStats([null, 'x', { outcome: 'merged' }]).total).toBe(1);
  });
});

describe('suppressedIssueSlug + rejectionReasonBySlug (#2689 feedback loop)', () => {
  it('recovers a normalized slug from a forge body marker, a bare plan row, or nothing', () => {
    expect(suppressedIssueSlug({ body: '<!-- lil-slug: Add-Telemetry -->' })).toBe('add-telemetry');
    expect(suppressedIssueSlug({ slug: 'Fix Thing' })).toBe('fix-thing');
    expect(suppressedIssueSlug({ title: 'no marker here' })).toBe(null);
    expect(suppressedIssueSlug({})).toBe(null);
  });

  it('indexes only resolved records diagnosed with a REAL taxonomy reason', () => {
    const map = rejectionReasonBySlug([
      { slug: 'a', outcome: 'rejected', rejectionReason: 'scope-mismatch' },
      { slug: 'b', outcome: 'abandoned', rejectionReason: 'unknown-reason' }, // sentinel: not an actionable pattern
      { slug: 'c', outcome: 'merged', rejectionReason: 'scope-mismatch' },    // merged: not a rejection
      { slug: 'd', outcome: 'rejected', rejectionReason: null },              // unclassified: nothing to say
      { slug: 'e', outcome: null, rejectionReason: 'duplicate' }              // unresolved
    ]);
    expect(map.get('a')).toBe('scope-mismatch');
    // The `unknown-reason` sentinel is deliberately excluded — it is the absence of a
    // diagnosis, not a failure pattern the reasoner can route around.
    expect(map.has('b')).toBe(false);
    expect(map.has('c')).toBe(false);
    expect(map.has('d')).toBe(false);
    expect(map.has('e')).toBe(false);
  });

  it('keeps the first diagnosed record per slug and tolerates non-array input', () => {
    const map = rejectionReasonBySlug([
      { slug: 'dup', outcome: 'rejected', rejectionReason: 'duplicate' },
      { slug: 'dup', outcome: 'rejected', rejectionReason: 'quality-issue' }
    ]);
    expect(map.get('dup')).toBe('duplicate');
    expect(rejectionReasonBySlug(null).size).toBe(0);
    expect(rejectionReasonBySlug(undefined).size).toBe(0);
  });

  it('describeSuppressedIssue appends the glossed reason only when the slug is diagnosed', () => {
    const reasons = new Map([['add-telemetry', 'scope-mismatch']]);
    expect(describeSuppressedIssue({ number: 12, title: 'Add telemetry', body: '<!-- lil-slug: add-telemetry -->' }, reasons))
      .toBe("#12 [add-telemetry] Add telemetry — previously closed: outside the app's scope");
    // Unmatched slug or no lookup → unchanged output (back-compat).
    expect(describeSuppressedIssue({ slug: 'other' }, reasons)).toBe('[other]');
    expect(describeSuppressedIssue({ slug: 'add-telemetry' })).toBe('[add-telemetry]');
  });
});

describe('computeOutcomesReport low-merge-rate warning (#2698)', () => {
  const filed = (outcome) => ({ scope: 'app-improvement', outcome });
  const rejected = (n) => Array.from({ length: n }, () => filed('rejected'));

  it('warns and points at plannedWork when the resolved merge rate is below the threshold', () => {
    // 0 of 4 resolved merged → 0% < 20%, and 4 clears the sample floor.
    const report = computeOutcomesReport({ outcomes: [...rejected(3), filed('abandoned')], hasPlannedWork: true });
    expect(report).toContain('WARNING');
    expect(report).toContain('merge rate is critically low');
    expect(report).toContain('plannedWork');
    expect(report).toContain('0 of 4 resolved proposals (0%)');
  });

  it('stays silent when the merge rate is healthy', () => {
    const report = computeOutcomesReport({ outcomes: [filed('merged'), filed('merged'), filed('rejected'), filed('merged')] });
    expect(report).not.toContain('WARNING');
  });

  it('stays silent when NOTHING is resolved yet (pending ≠ rejected)', () => {
    // Filed, all still open: 0 merged of 0 resolved. Dividing by `total` would
    // render 0% and alarm — but nothing has actually failed.
    const report = computeOutcomesReport({ outcomes: [filed(null), filed(null), filed(null), filed(null), filed(null)] });
    expect(report).toContain('Total filed: 5');
    expect(report).not.toContain('WARNING');
  });

  it('measures over resolved proposals, not total (a pending backlog cannot trip it)', () => {
    // 1 merged of 1 resolved = 100% → healthy, despite 1/5 = 20% of total.
    const report = computeOutcomesReport({ outcomes: [filed('merged'), filed(null), filed(null), filed(null), filed(null)] });
    expect(report).not.toContain('WARNING');
  });

  it('stays silent below the sample floor — 0-of-1 is not evidence of a rate', () => {
    // A single early rejection must not tell the loop to stop proposing: it can
    // never earn a merge if it stops filing.
    for (let n = 1; n < LOW_MERGE_RATE_MIN_SAMPLE; n += 1) {
      expect(computeOutcomesReport({ outcomes: rejected(n), hasPlannedWork: true })).not.toContain('WARNING');
    }
    expect(computeOutcomesReport({ outcomes: rejected(LOW_MERGE_RATE_MIN_SAMPLE), hasPlannedWork: true })).toContain('WARNING');
    expect(LOW_MERGE_RATE_MIN_SAMPLE).toBe(4);
  });

  it('fires exactly below the documented threshold', () => {
    // 1 merged of 5 resolved = 20% → NOT below 20 → silent.
    const at = computeOutcomesReport({ outcomes: [filed('merged'), ...rejected(4)] });
    expect(at).not.toContain('WARNING');
    // 1 merged of 6 resolved = 17% → below → warns.
    const below = computeOutcomesReport({ outcomes: [filed('merged'), ...rejected(5)] });
    expect(below).toContain('WARNING');
    expect(LOW_MERGE_RATE_THRESHOLD).toBe(20);
  });

  it('compares the RAW rate — a sub-threshold rate that rounds up still warns', () => {
    // 10 merged of 51 resolved = 19.6% — genuinely below 20, but rounds to 20.
    // Rounding before the comparison would suppress the warning entirely.
    const report = computeOutcomesReport({
      outcomes: [...Array.from({ length: 10 }, () => filed('merged')), ...rejected(41)]
    });
    expect(report).toContain('WARNING');
    // ...while the DISPLAYED figure is still the friendly rounded one.
    expect(report).toContain('10 of 51 resolved proposals (20%)');
  });

  it('does NOT cite a plannedWork block that is not in the prompt', () => {
    // The source is per-app-toggleable and yields nothing on an unresolvable
    // tracker — citing a section that isn't there is just noise.
    const report = computeOutcomesReport({ outcomes: rejected(5), hasPlannedWork: false });
    expect(report).toContain('WARNING');
    expect(report).not.toContain('plannedWork');
    expect(report).toContain('return proposal: null');
  });

  it('still returns "" with no filed history (nothing to calibrate on)', () => {
    expect(computeOutcomesReport({ outcomes: [] })).toBe('');
  });
});
