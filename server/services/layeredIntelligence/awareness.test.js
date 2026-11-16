import { describe, it, expect } from 'vitest';
import {
  computeScopeAwareness,
  computeExecutionByDomain,
  computePostApprovalCompletion,
  computeProposalExecutionAwareness,
  computeCrossReferenceAnalysis,
  computeHandoffRouting,
} from './awareness.js';
import {
  PROPOSAL_EXECUTION_MIN_SAMPLE,
  SCOPE_AVOID_SUCCESS_THRESHOLD,
  SCOPE_PREFER_SUCCESS_THRESHOLD,
  SCOPE_AWARENESS_MIN_SAMPLE,
} from './constants.js';

describe('computeExecutionByDomain (#2765)', () => {
  it('groups executed proposals by their scope and computes per-domain success rate', () => {
    const byDomain = computeExecutionByDomain([
      { scope: 'loop-meta', executionOutcome: 'success' },
      { scope: 'loop-meta', executionOutcome: 'failure' },
      { scope: 'app-improvement', executionOutcome: 'success' }
    ]);
    // The loop-meta failure carries no failureCategory, so it lands in `unclassified`
    // rather than as a diagnosis; app-improvement had no failure at all.
    expect(byDomain['loop-meta']).toEqual({
      completed: 2, succeeded: 1, successRate: 50,
      failureSummary: { entries: [], unknown: 0, unclassified: 1, diagnosed: 0, total: 1 }
    });
    expect(byDomain['app-improvement']).toEqual({
      completed: 1, succeeded: 1, successRate: 100,
      failureSummary: { entries: [], unknown: 0, unclassified: 0, diagnosed: 0, total: 0 }
    });
  });

  it('buckets a "__proto__" scope as data instead of rewriting the prototype', () => {
    const byDomain = computeExecutionByDomain([
      { scope: '__proto__', executionOutcome: 'success' }
    ]);
    // A plain {} would swallow this key into the prototype: absent from
    // Object.entries yet truthy on lookup — inconsistent gate-vs-prompt views.
    expect(Object.keys(byDomain)).toEqual(['__proto__']);
    expect(byDomain['__proto__'].completed).toBe(1);
  });

  it('carries the dominant per-domain failure causes in failureSummary (#2764 §3)', () => {
    const byDomain = computeExecutionByDomain([
      { scope: 'loop-meta', executionOutcome: 'failure', failureCategory: 'planning' },
      { scope: 'loop-meta', executionOutcome: 'failure', failureCategory: 'planning' },
      { scope: 'loop-meta', executionOutcome: 'failure', failureCategory: 'execution' },
      { scope: 'loop-meta', executionOutcome: 'success' }
    ]);
    expect(byDomain['loop-meta'].failureSummary).toEqual({
      entries: [{ category: 'planning', count: 2 }, { category: 'execution', count: 1 }],
      unknown: 0, unclassified: 0, diagnosed: 3, total: 3
    });
  });

  it('ignores records with no executionOutcome or no scope', () => {
    const byDomain = computeExecutionByDomain([
      { scope: 'loop-meta', executionOutcome: null },      // filed but never executed
      { scope: null, executionOutcome: 'success' },        // executed but domain unknown
      { executionOutcome: 'success' },                     // no scope key
      'nonsense',
      { scope: 'app-data-gap', executionOutcome: 'success' }
    ]);
    expect(Object.keys(byDomain)).toEqual(['app-data-gap']);
  });

  it('returns an empty map for a non-array / empty input', () => {
    expect(computeExecutionByDomain()).toEqual({});
    expect(computeExecutionByDomain(null)).toEqual({});
    expect(computeExecutionByDomain([])).toEqual({});
  });
});

describe('computePostApprovalCompletion (#2944)', () => {
  it('separates approved hand-off completion states and summarizes duration by scope', () => {
    const out = computePostApprovalCompletion([
      {
        scope: 'app-improvement', outcome: 'merged', executionOutcome: 'success',
        filedAt: '2026-07-01T00:00:00.000Z', executionAt: '2026-07-01T01:00:00.000Z'
      },
      {
        scope: 'app-improvement', outcome: 'merged', executionOutcome: 'failure',
        filedAt: '2026-07-01T00:00:00.000Z', executionAt: '2026-07-01T02:00:00.000Z'
      },
      {
        scope: 'app-data-gap', outcome: 'merged', executionOutcome: null,
        filedAt: '2026-07-01T00:00:00.000Z'
      },
      // Rejected proposals never enter the post-approval denominator.
      {
        scope: 'app-improvement', outcome: 'rejected', executionOutcome: 'success',
        filedAt: '2026-07-01T00:00:00.000Z', executionAt: '2026-07-01T03:00:00.000Z'
      },
      // Invalid chronology must not poison duration telemetry.
      {
        scope: 'loop-meta', outcome: 'merged', executionOutcome: 'success',
        filedAt: '2026-07-02T00:00:00.000Z', executionAt: '2026-07-01T00:00:00.000Z'
      }
    ]);

    expect(out).toMatchObject({
      approved: 4,
      completed: 2,
      abandoned: 1,
      awaitingExecution: 1,
      attempted: 3
    });
    expect(out.completionRate).toBeCloseTo(200 / 3, 10);
    expect(out.duration).toEqual({
      count: 1,
      averageMs: 3_600_000,
      medianMs: 3_600_000,
      p90Ms: 3_600_000,
      minMs: 3_600_000,
      maxMs: 3_600_000
    });
    expect(out.byScope['app-improvement']).toMatchObject({
      approved: 2, completed: 1, abandoned: 1, awaitingExecution: 0, attempted: 2, completionRate: 50
    });
    expect(out.byScope['app-data-gap']).toMatchObject({
      approved: 1, completed: 0, abandoned: 0, awaitingExecution: 1, attempted: 0, completionRate: null
    });
  });

  it('calculates median and p90 from the completed duration distribution', () => {
    const filedAt = '2026-07-01T00:00:00.000Z';
    const out = computePostApprovalCompletion([1, 2, 3, 4].map(hours => ({
      scope: 'app-data-gap', outcome: 'merged', executionOutcome: 'success', filedAt,
      executionAt: `2026-07-01T${String(hours).padStart(2, '0')}:00:00.000Z`
    })));

    expect(out.duration).toEqual({
      count: 4,
      averageMs: 9_000_000,
      medianMs: 9_000_000,
      p90Ms: 14_400_000,
      minMs: 3_600_000,
      maxMs: 14_400_000
    });
  });

  it('divides approvalToCompletionRate by APPROVED, not attempted, and nulls it at zero approvals', () => {
    // 2 approved, 1 completed, 1 still awaiting execution: the attempted-only rate
    // reads a perfect 100% while only half the approved work has actually landed.
    const out = computePostApprovalCompletion([
      { scope: 'app-improvement', outcome: 'merged', executionOutcome: 'success', filedAt: '2026-07-01T00:00:00.000Z', executionAt: '2026-07-01T01:00:00.000Z' },
      { scope: 'app-improvement', outcome: 'merged', executionOutcome: null, filedAt: '2026-07-01T00:00:00.000Z' }
    ]);
    expect(out.completionRate).toBe(100);
    expect(out.approvalToCompletionRate).toBe(50);
    expect(out.byScope['app-improvement'].approvalToCompletionRate).toBe(50);

    // Nothing approved → null, never 0 (the division-by-zero sentinel).
    const none = computePostApprovalCompletion([{ scope: 'loop-meta', outcome: 'rejected' }]);
    expect(none.approved).toBe(0);
    expect(none.approvalToCompletionRate).toBeNull();
  });
});

describe('computeProposalExecutionAwareness (#2765)', () => {
  const execRecords = (scope, successes, failures) => [
    ...Array.from({ length: successes }, () => ({ scope, executionOutcome: 'success' })),
    ...Array.from({ length: failures }, () => ({ scope, executionOutcome: 'failure' }))
  ];

  it('returns "" until a domain clears the sample floor', () => {
    // One execution is below PROPOSAL_EXECUTION_MIN_SAMPLE (2) — no list yet.
    expect(computeProposalExecutionAwareness({ outcomes: execRecords('loop-meta', 0, 1) })).toBe('');
    expect(computeProposalExecutionAwareness({ outcomes: [] })).toBe('');
    expect(computeProposalExecutionAwareness()).toBe('');
  });

  it('lists a low-execution domain under AVOID and a high one under PREFER', () => {
    const out = computeProposalExecutionAwareness({
      outcomes: [
        ...execRecords('app-improvement', 0, 3), // 0% → avoid
        ...execRecords('loop-meta', 3, 0)         // 100% → prefer
      ]
    });
    expect(out).toContain('LOW-EXECUTION proposal domains');
    expect(out).toContain('app-improvement');
    expect(out).toContain('HIGH-EXECUTION proposal domains');
    expect(out).toContain('loop-meta');
    // No "directional context only" hedge — this is a true per-proposal record.
    expect(out).not.toContain('directional');
    expect(out).not.toMatch(/don't map 1:1|do not map 1:1/);
  });

  it('leaves a mid-rate domain (>=avoid, <prefer) off both lists', () => {
    // 2/3 ≈ 67%: above the 50% avoid line, below the 75% prefer line.
    expect(computeProposalExecutionAwareness({ outcomes: execRecords('loop-meta', 2, 1) })).toBe('');
    expect(PROPOSAL_EXECUTION_MIN_SAMPLE).toBe(2);
  });

  it('names the dominant failure cause on a low-execution AVOID line (#2764 §3)', () => {
    const out = computeProposalExecutionAwareness({
      outcomes: [
        { scope: 'loop-meta', executionOutcome: 'failure', failureCategory: 'planning' },
        { scope: 'loop-meta', executionOutcome: 'failure', failureCategory: 'planning' },
        { scope: 'loop-meta', executionOutcome: 'failure', failureCategory: 'execution' }
      ]
    });
    expect(out).toContain('LOW-EXECUTION proposal domains');
    expect(out).toContain('loop-meta');
    // The glossed dominant cause is appended to the avoid line, commonest first.
    expect(out).toContain('failing mostly on');
    expect(out).toContain('the task was under-defined or already done (no correct change to make) (2)');
  });

  it('omits the cause clause when no failure carries a diagnosis', () => {
    // All failures are unclassified (no failureCategory), so there is no cause to name.
    const out = computeProposalExecutionAwareness({ outcomes: execRecords('app-improvement', 0, 3) });
    expect(out).toContain('app-improvement');
    expect(out).not.toContain('failing mostly on');
  });
});

describe('computeCrossReferenceAnalysis (#2764 §3)', () => {
  it('surfaces a domain that merges well but executes poorly', () => {
    const out = computeCrossReferenceAnalysis({
      outcomes: [
        // loop-meta: 2 of 4 resolved proposals merged (50%)...
        { scope: 'loop-meta', outcome: 'merged' },
        { scope: 'loop-meta', outcome: 'merged' },
        { scope: 'loop-meta', outcome: 'rejected' },
        { scope: 'loop-meta', outcome: 'abandoned' },
        // ...but its hand-offs fail: planning 3, execution 1 (planning dominant)
        { scope: 'loop-meta', executionOutcome: 'failure', failureCategory: 'planning' },
        { scope: 'loop-meta', executionOutcome: 'failure', failureCategory: 'planning' },
        { scope: 'loop-meta', executionOutcome: 'failure', failureCategory: 'planning' },
        { scope: 'loop-meta', executionOutcome: 'failure', failureCategory: 'execution' }
      ]
    });
    expect(out).toContain('PROPOSES well but EXECUTES poorly');
    expect(out).toContain('loop-meta: proposals merge at 50% (2/4) but hand-offs here fail on planning (3 of 4)');
  });

  it('excludes a domain with no merged proposal (proposes poorly too)', () => {
    // Domain fails execution but never merged — liProposalExecution already covers it,
    // so the cross-reference (which is about the CONTRAST) stays silent.
    expect(computeCrossReferenceAnalysis({
      outcomes: [
        { scope: 'loop-meta', outcome: 'rejected' },
        { scope: 'loop-meta', executionOutcome: 'failure', failureCategory: 'planning' }
      ]
    })).toBe('');
  });

  it('excludes a domain whose failures are all undiagnosed', () => {
    // Merges well, but the failed hand-offs carry no recognized cause — nothing to
    // cross-reference, so no line (unknown/unclassified are not findings).
    expect(computeCrossReferenceAnalysis({
      outcomes: [
        { scope: 'loop-meta', outcome: 'merged' },
        { scope: 'loop-meta', executionOutcome: 'failure' } // unclassified
      ]
    })).toBe('');
  });

  it('returns "" for empty / non-array input', () => {
    expect(computeCrossReferenceAnalysis({ outcomes: [] })).toBe('');
    expect(computeCrossReferenceAnalysis({ outcomes: null })).toBe('');
    expect(computeCrossReferenceAnalysis()).toBe('');
  });
});

describe('computeHandoffRouting (#2764 §4)', () => {
  const execRecords = (scope, successes, failures, extraFail = {}) => [
    ...Array.from({ length: successes }, () => ({ scope, executionOutcome: 'success' })),
    ...Array.from({ length: failures }, () => ({ scope, executionOutcome: 'failure', ...extraFail }))
  ];

  it('allows the hand-off when the proposal has no scope (cannot judge)', () => {
    expect(computeHandoffRouting({ proposal: {}, outcomes: [] })).toEqual({ handoff: true, reason: null });
    expect(computeHandoffRouting({ proposal: { scope: '  ' }, outcomes: [] })).toEqual({ handoff: true, reason: null });
    expect(computeHandoffRouting()).toEqual({ handoff: true, reason: null });
  });

  it('allows the hand-off for an unknown domain (no execution history)', () => {
    expect(computeHandoffRouting({ proposal: { scope: 'loop-meta' }, outcomes: [] }))
      .toEqual({ handoff: true, reason: null });
  });

  it('allows the hand-off below the sample floor even at 0%', () => {
    // One failed execution is below PROPOSAL_EXECUTION_MIN_SAMPLE (2) — not evidence.
    expect(computeHandoffRouting({ proposal: { scope: 'loop-meta' }, outcomes: execRecords('loop-meta', 0, 1) }))
      .toEqual({ handoff: true, reason: null });
  });

  it('allows the hand-off when the rate is at/above the avoid threshold', () => {
    // 2/3 ≈ 67% is at/above the 50% avoid line → not chronically failing.
    expect(computeHandoffRouting({ proposal: { scope: 'loop-meta' }, outcomes: execRecords('loop-meta', 2, 1) }))
      .toEqual({ handoff: true, reason: null });
  });

  it('suppresses the hand-off for a chronically-failing domain and names domain+rate+cause', () => {
    const routing = computeHandoffRouting({
      proposal: { scope: 'loop-meta' },
      outcomes: [
        { scope: 'loop-meta', executionOutcome: 'success' },              // 1 success
        { scope: 'loop-meta', executionOutcome: 'failure', failureCategory: 'planning' },
        { scope: 'loop-meta', executionOutcome: 'failure', failureCategory: 'planning' }  // 2 failures → 33%
      ]
    });
    expect(routing.handoff).toBe(false);
    expect(routing.domain).toBe('loop-meta');
    expect(routing.rate).toBe(33);
    expect(routing.n).toBe(3);
    expect(routing.reason).toContain('loop-meta');
    expect(routing.reason).toContain('33%');
    expect(routing.reason).toContain('over 3 executed');
    expect(routing.reason).toContain('filing for human review instead of auto-hand-off');
    // Dominant cause is glossed and appended in parentheses.
    expect(routing.reason).toContain('failing mostly on');
    expect(routing.reason).toContain('the task was under-defined or already done (no correct change to make) (2)');
    // Agrees with the reasoner-facing avoid list on WHICH domains are chronically failing.
    expect(computeProposalExecutionAwareness({ outcomes: [
      { scope: 'loop-meta', executionOutcome: 'success' },
      { scope: 'loop-meta', executionOutcome: 'failure', failureCategory: 'planning' },
      { scope: 'loop-meta', executionOutcome: 'failure', failureCategory: 'planning' }
    ] })).toContain('loop-meta');
  });

  it('suppresses with NO trailing cause clause when failures are purely undiagnosed', () => {
    const routing = computeHandoffRouting({
      proposal: { scope: 'app-improvement' },
      outcomes: execRecords('app-improvement', 0, 3) // 0%, all unclassified
    });
    expect(routing.handoff).toBe(false);
    expect(routing.domain).toBe('app-improvement');
    expect(routing.rate).toBe(0);
    expect(routing.n).toBe(3);
    expect(routing.cause).toBe('');
    expect(routing.reason).toContain('app-improvement');
    expect(routing.reason).not.toContain('failing mostly on');
    expect(routing.reason).not.toContain('(');
  });
});

describe('computeScopeAwareness (#2760)', () => {
  it('returns empty string when no scope clears the sample floor', () => {
    // Both under SCOPE_AWARENESS_MIN_SAMPLE (3) → neither classified.
    expect(computeScopeAwareness({ metricsByType: {
      'plan-task': { lifetimeSuccessRate: 100, lifetimeCompleted: 2 },
      'accessibility': { lifetimeSuccessRate: 0, lifetimeCompleted: 1 }
    } })).toBe('');
  });

  it('returns empty string for an empty / missing map', () => {
    expect(computeScopeAwareness({})).toBe('');
    expect(computeScopeAwareness()).toBe('');
    expect(computeScopeAwareness({ metricsByType: {} })).toBe('');
  });

  it('classifies a below-threshold scope with enough runs as AVOID', () => {
    const out = computeScopeAwareness({ metricsByType: {
      'self-improve:layered-intelligence': { lifetimeSuccessRate: 0, lifetimeCompleted: 9 }
    } });
    expect(out).toContain('LOW-COMPLETION');
    expect(out).toContain('self-improve:layered-intelligence: 0% completed over 9 runs');
    expect(out).not.toContain('HIGH-COMPLETION');
  });

  it('classifies an at/above-threshold scope with enough runs as PREFER', () => {
    const out = computeScopeAwareness({ metricsByType: {
      'plan-task': { lifetimeSuccessRate: 100, lifetimeCompleted: 10 }
    } });
    expect(out).toContain('HIGH-COMPLETION');
    expect(out).toContain('plan-task: 100% completed over 10 runs');
    expect(out).not.toContain('LOW-COMPLETION');
  });

  it('leaves a mid-band scope (between avoid and prefer) unclassified', () => {
    // 60% is >= AVOID (50) and < PREFER (75) → neither list.
    expect(computeScopeAwareness({ metricsByType: {
      'feature-ideas': { lifetimeSuccessRate: 60, lifetimeCompleted: 8 }
    } })).toBe('');
  });

  it('ignores a never-run scope (null rate) even with a high completed count artifact', () => {
    expect(computeScopeAwareness({ metricsByType: {
      'idle-review': { lifetimeSuccessRate: null, lifetimeCompleted: 12 }
    } })).toBe('');
  });

  it('judges on the recency-windowed rate so a RECOVERED scope leaves avoid (#2760 dynamic adjustment)', () => {
    // Lifetime is dragged to 10% by an old failure burst, but the recent window (>= the
    // 5-sample floor) is all successes → the effective rate is high, so the scope must
    // NOT be on the avoid list (and here clears PREFER). Proves self-clearing works off
    // the windowed rate, which the near-permanent lifetime rate could never deliver.
    // The rendered count matches the rate's basis: windowed rate → windowed count.
    const out = computeScopeAwareness({ metricsByType: {
      'branch-reconcile': { lifetimeSuccessRate: 10, lifetimeCompleted: 20, recentSuccessRate: 100, recentCompleted: 6 }
    } });
    expect(out).not.toContain('LOW-COMPLETION');
    expect(out).toContain('HIGH-COMPLETION');
    expect(out).toContain('branch-reconcile: 100% completed over 6 runs'); // windowed rate AND windowed count
  });

  it('judges on the windowed rate so a REGRESSED scope enters avoid despite a high lifetime rate', () => {
    // Lifetime looks great (95%) but the recent window (>= floor) has collapsed → avoid.
    const out = computeScopeAwareness({ metricsByType: {
      'performance': { lifetimeSuccessRate: 95, lifetimeCompleted: 40, recentSuccessRate: 20, recentCompleted: 8 }
    } });
    expect(out).toContain('LOW-COMPLETION');
    expect(out).toContain('performance: 20% completed over 8 runs'); // windowed rate AND windowed count
    expect(out).not.toContain('HIGH-COMPLETION');
  });

  it('ignores a THIN recent window (below the sample floor) and lets lifetime govern (#2760)', () => {
    // Only 1 recent run — below EFFECTIVE_RATE_MIN_WINDOW_SAMPLES (5) — so one noisy
    // recent failure must NOT flip a lifetime-reliable scope to avoid; lifetime (95%)
    // governs → PREFER, matching the scheduler's own effective-rate floor.
    const out = computeScopeAwareness({ metricsByType: {
      'plan-task': { lifetimeSuccessRate: 95, lifetimeCompleted: 40, recentSuccessRate: 0, recentCompleted: 1 }
    } });
    expect(out).toContain('HIGH-COMPLETION');
    expect(out).toContain('plan-task: 95% completed over 40 runs'); // lifetime rate AND lifetime count
    expect(out).not.toContain('LOW-COMPLETION');
  });

  it('falls back to the lifetime rate when the recency window is empty', () => {
    // recentCompleted 0 / recentSuccessRate null → lifetime rate governs.
    const out = computeScopeAwareness({ metricsByType: {
      'plan-task': { lifetimeSuccessRate: 100, lifetimeCompleted: 10, recentSuccessRate: null, recentCompleted: 0 }
    } });
    expect(out).toContain('HIGH-COMPLETION');
    expect(out).toContain('plan-task: 100% completed over 10 runs');
  });

  it('sorts AVOID worst-first and PREFER best-first', () => {
    const out = computeScopeAwareness({ metricsByType: {
      'branch-reconcile': { lifetimeSuccessRate: 20, lifetimeCompleted: 5 },
      'accessibility': { lifetimeSuccessRate: 0, lifetimeCompleted: 4 },
      'test-coverage': { lifetimeSuccessRate: 80, lifetimeCompleted: 5 },
      'performance': { lifetimeSuccessRate: 100, lifetimeCompleted: 3 }
    } });
    // worst avoid (accessibility 0%) precedes the milder one (branch-reconcile 20%)
    expect(out.indexOf('accessibility')).toBeLessThan(out.indexOf('branch-reconcile'));
    // best prefer (performance 100%) precedes the milder one (test-coverage 80%)
    expect(out.indexOf('performance')).toBeLessThan(out.indexOf('test-coverage'));
    // AVOID section precedes PREFER section
    expect(out.indexOf('LOW-COMPLETION')).toBeLessThan(out.indexOf('HIGH-COMPLETION'));
  });

  it('truncates a pathologically long task-type name (#2760 codex P2)', () => {
    const longType = 'self-improve:mission-' + 'x'.repeat(200);
    const out = computeScopeAwareness({ metricsByType: {
      [longType]: { lifetimeSuccessRate: 0, lifetimeCompleted: 5 }
    } });
    expect(out).toContain('LOW-COMPLETION');
    expect(out).not.toContain(longType); // full 200-char name never rendered verbatim
    expect(out).toContain('…');           // truncation marker present
  });

  it('honors the exported thresholds at their exact boundaries', () => {
    // exactly PREFER threshold → prefer; exactly AVOID threshold → neither (< is strict)
    const atPrefer = computeScopeAwareness({ metricsByType: {
      x: { lifetimeSuccessRate: SCOPE_PREFER_SUCCESS_THRESHOLD, lifetimeCompleted: SCOPE_AWARENESS_MIN_SAMPLE }
    } });
    expect(atPrefer).toContain('HIGH-COMPLETION');
    const atAvoidBoundary = computeScopeAwareness({ metricsByType: {
      x: { lifetimeSuccessRate: SCOPE_AVOID_SUCCESS_THRESHOLD, lifetimeCompleted: SCOPE_AWARENESS_MIN_SAMPLE }
    } });
    expect(atAvoidBoundary).toBe(''); // 50% is not < 50 and not >= 75
  });
});
