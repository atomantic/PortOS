import { describe, it, expect } from 'vitest';
import {
  computeSelfEvalSummary,
  SELF_EVAL_MAX_SUPPRESSED_LISTED,
} from './outcomes.js';

describe('computeSelfEvalSummary (#2700)', () => {
  const liMetrics = (over = {}) => ({
    read: true,
    metrics: { completed: 10, succeeded: 8, failed: 2, successRate: 80, recentOutcomes: [], ...over }
  });

  it('reports every signal as explicitly unavailable — and low confidence — with no data', () => {
    const report = computeSelfEvalSummary();
    expect(report).toContain('Reasoning confidence: low (0 of 3 self-signals available)');
    expect(report).toContain('Proposal merge rate: UNAVAILABLE');
    expect(report).toContain('Your already-filed proposals: UNKNOWN');
    expect(report).toContain('LI execution health: UNAVAILABLE');
    expect(report).toContain('GUIDANCE — low self-confidence');
    // A blind run must never be told it has a 0% rate.
    expect(report).not.toContain('(0%)');
  });

  it('distinguishes "outcomes not gathered" from "gathered, none filed"', () => {
    expect(computeSelfEvalSummary({ outcomes: null })).toContain('Proposal merge rate: UNAVAILABLE');
    expect(computeSelfEvalSummary({ outcomes: [] })).toContain('no proposals filed yet for this app');
  });

  it('does not read filed-but-unresolved proposals as a 0% merge rate', () => {
    const report = computeSelfEvalSummary({ outcomes: [{ outcome: null }, { outcome: null }] });
    expect(report).toContain('2 filed, none resolved yet — rate unknown');
    expect(report).toContain('Awaiting triage is NOT rejection');
    expect(report).not.toContain('0%');
  });

  it('reports a real merge rate with its classified rejection reasons', () => {
    const outcomes = [
      { outcome: 'merged' },
      { outcome: 'rejected', rejectionReason: 'user-rejected' },
      { outcome: 'rejected', rejectionReason: 'user-rejected' },
      { outcome: 'abandoned', rejectionReason: 'duplicate' }
    ];
    const report = computeSelfEvalSummary({ outcomes });
    expect(report).toContain('1 of 4 resolved proposals merged (25%)');
    // Tallied by taxonomy token and glossed, commonest first — and an `abandoned`
    // proposal is explained too, not just a `rejected` one (#2689).
    expect(report).toContain(
      'Why the rest were closed: the user declined it (closed as not planned) (2); already tracked elsewhere (duplicate) (1)'
    );
  });

  it('omits the rejection clause when every resolved proposal merged (#2689)', () => {
    const report = computeSelfEvalSummary({ outcomes: [{ outcome: 'merged' }, { outcome: 'merged' }] });
    expect(report).toContain('2 of 2 resolved proposals merged (100%)');
    expect(report).not.toContain('Why the rest were closed');
  });

  it('flags a below-floor sample as unreadable rather than as evidence', () => {
    const report = computeSelfEvalSummary({ outcomes: [{ outcome: 'rejected' }] });
    expect(report).toContain('too small a sample to read a rate from yet');
    // One rejection is not a merge-rate signal → confidence must not count it.
    expect(report).toContain('Reasoning confidence: low');
  });

  it('counts open and still-suppressed closed proposals so the loop does not re-file', () => {
    const now = Date.now();
    const report = computeSelfEvalSummary({
      existingIssues: [
        { slug: 'a', state: 'open' },
        { slug: 'b', state: 'open' },
        { slug: 'c', state: 'closed', closedAt: new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString() },
        // Closed long ago → out of the window → re-proposable, so NOT counted.
        { slug: 'd', state: 'closed', closedAt: new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString() }
      ],
      now
    });
    expect(report).toContain('2 open, plus 1 closed but still within the 30-day suppression window');
    expect(report).toContain('deterministically suppressed');
  });

  it('NAMES the closed-but-suppressed proposals, not just their count', () => {
    const now = Date.now();
    const recent = new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString();
    const report = computeSelfEvalSummary({
      existingIssues: [
        { number: 12, title: 'Add telemetry', body: '<!-- lil-slug: add-telemetry -->', state: 'closed', closedAt: recent },
        // The plan filer's bare shape carries a slug and nothing else.
        { slug: 'fix-thing', state: 'closed' }
      ],
      now
    });
    // A closed issue appears nowhere else in the prompt — the reasoner can only
    // avoid re-proposing it if selfEval names its dedup key.
    expect(report).toContain('Recently closed (do NOT re-propose):');
    expect(report).toContain('#12 [add-telemetry] Add telemetry');
    expect(report).toContain('[fix-thing]');
  });

  it('annotates each named suppressed proposal with WHY it was closed (#2689 feedback loop)', () => {
    const now = Date.now();
    const recent = new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString();
    const report = computeSelfEvalSummary({
      // The reconciled outcome store carries the rejection diagnosis per slug.
      outcomes: [
        { appId: 'a', slug: 'add-telemetry', outcome: 'rejected', rejectionReason: 'scope-mismatch' },
        { appId: 'a', slug: 'fix-thing', outcome: 'abandoned', rejectionReason: 'duplicate' }
      ],
      existingIssues: [
        { number: 12, title: 'Add telemetry', body: '<!-- lil-slug: add-telemetry -->', state: 'closed', closedAt: recent },
        { slug: 'fix-thing', state: 'closed' }
      ],
      now
    });
    // The reasoner sees the specific failure pattern, not merely a slug to route around.
    expect(report).toContain("#12 [add-telemetry] Add telemetry — previously closed: outside the app's scope");
    expect(report).toContain('[fix-thing] — previously closed: already tracked elsewhere (duplicate)');
  });

  it('leaves an undiagnosed suppressed proposal unannotated', () => {
    const now = Date.now();
    const recent = new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString();
    const report = computeSelfEvalSummary({
      // No outcomes gathered this run — the line renders exactly as before.
      outcomes: null,
      existingIssues: [
        { number: 12, title: 'Add telemetry', body: '<!-- lil-slug: add-telemetry -->', state: 'closed', closedAt: recent }
      ],
      now
    });
    expect(report).toContain('#12 [add-telemetry] Add telemetry');
    expect(report).not.toContain('previously closed:');
  });

  it('does not annotate a proposal closed with the unknown-reason sentinel', () => {
    const now = Date.now();
    const recent = new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString();
    const report = computeSelfEvalSummary({
      // Reconciled but undiagnosable: the sentinel is not an actionable failure pattern,
      // so the "do NOT re-propose" line names it without a spurious reason gloss.
      outcomes: [{ appId: 'a', slug: 'add-telemetry', outcome: 'rejected', rejectionReason: 'unknown-reason' }],
      existingIssues: [
        { number: 12, title: 'Add telemetry', body: '<!-- lil-slug: add-telemetry -->', state: 'closed', closedAt: recent }
      ],
      now
    });
    expect(report).toContain('#12 [add-telemetry] Add telemetry');
    expect(report).not.toContain('previously closed:');
  });

  it('caps the named list and counts the remainder', () => {
    const now = Date.now();
    const closedAt = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const existingIssues = Array.from({ length: SELF_EVAL_MAX_SUPPRESSED_LISTED + 3 }, (_, i) => ({
      slug: `item-${i}`, state: 'closed', closedAt
    }));
    const report = computeSelfEvalSummary({ existingIssues, now });
    expect(report).toContain('[item-0]');
    expect(report).toContain('(+3 more)');
    expect(report).not.toContain(`[item-${SELF_EVAL_MAX_SUPPRESSED_LISTED}]`);
  });

  it('leaves an unidentifiable suppressed entry to the count rather than a mystery bullet', () => {
    const now = Date.now();
    const report = computeSelfEvalSummary({
      existingIssues: [{ state: 'closed', closedAt: new Date(now - 1000).toISOString() }],
      now
    });
    expect(report).toContain('plus 1 closed but still within the 30-day suppression window');
    expect(report).not.toContain('Recently closed (do NOT re-propose):');
  });

  it('says so plainly when nothing is suppressed', () => {
    const report = computeSelfEvalSummary({ existingIssues: [] });
    expect(report).toContain('0 open');
    expect(report).toContain('Nothing is currently suppressed');
  });

  it('treats a failed tracker read (null) as unknown, never as "nothing filed"', () => {
    const report = computeSelfEvalSummary({ existingIssues: null });
    expect(report).toContain('Your already-filed proposals: UNKNOWN');
    expect(report).toContain('may be about to re-file something that already exists');
    expect(report).not.toContain('0 open');
  });

  it('distinguishes an unreadable learning store from a loop that has never run', () => {
    expect(computeSelfEvalSummary({ liTaskStats: { read: false, metrics: null } }))
      .toContain('LI execution health: UNAVAILABLE');
    expect(computeSelfEvalSummary({ liTaskStats: { read: true, metrics: null } }))
      .toContain('no LI runs recorded yet');
  });

  it('adds degraded-execution guidance when LI run success is under the threshold', () => {
    const report = computeSelfEvalSummary({
      liTaskStats: liMetrics({ completed: 9, succeeded: 3, failed: 6, successRate: 33 })
    });
    expect(report).toContain('33% of 9 lifetime LI runs succeeded — DEGRADED');
    expect(report).toContain('GUIDANCE — your own execution is degraded');
    expect(report).toContain('the problem may be THIS LOOP, not the app');
    expect(report).toContain('do not mark anything trivial+safe for hand-off');
  });

  it('does not fire the degraded warning on a healthy loop', () => {
    const report = computeSelfEvalSummary({ liTaskStats: liMetrics() });
    expect(report).toContain('80% of 10 lifetime LI runs succeeded');
    expect(report).not.toContain('DEGRADED');
    expect(report).not.toContain('execution is degraded');
  });

  it('reports approval-to-completion delivery alongside LI run health', () => {
    const report = computeSelfEvalSummary({
      liTaskStats: liMetrics(),
      outcomes: [
        { outcome: 'merged', executionOutcome: 'success' },
        ...Array.from({ length: 4 }, () => ({ outcome: 'merged', executionOutcome: null }))
      ]
    });
    expect(report).toContain('80% of 10 lifetime LI runs succeeded');
    expect(report).toContain('20% of 5 approved LI proposals completed');
  });

  it('does not fire the degraded warning below the sample floor', () => {
    const report = computeSelfEvalSummary({
      liTaskStats: liMetrics({ completed: 1, succeeded: 0, failed: 1, successRate: 0 })
    });
    expect(report).toContain('too small a sample to judge');
    expect(report).not.toContain('DEGRADED');
  });

  const DAY_AGO_MS = 24 * 60 * 60 * 1000;

  it('folds the approval funnel into the block on every run (#3120)', () => {
    const now = Date.parse('2026-07-20T12:00:00.000Z');
    const ago = (ms) => new Date(now - ms).toISOString();
    const report = computeSelfEvalSummary({
      liTaskStats: liMetrics(),
      existingIssues: [],
      outcomes: [
        { slug: 'approved-one', outcome: 'merged', filedAt: ago(5 * DAY_AGO_MS), outcomeAt: ago(3 * DAY_AGO_MS) },
        { slug: 'rejected-one', outcome: 'rejected', filedAt: ago(6 * DAY_AGO_MS), outcomeAt: ago(2 * DAY_AGO_MS) },
        { slug: 'stalled-one', outcome: null, filedAt: ago(9 * DAY_AGO_MS), outcomeAt: null }
      ],
      now
    });
    expect(report).toContain('LI approval rate (last 14d): 50%');
    expect(report).toContain('LI time-to-decision: median');
    expect(report).toContain('PENDING HUMAN REVIEW: 1 filed proposal(s)');
    expect(report).toContain('LI proposal-phase throughput');
  });

  it('omits the pending-review indicator when the count is zero (#3120)', () => {
    const report = computeSelfEvalSummary({
      liTaskStats: liMetrics(),
      outcomes: [{ slug: 'done', outcome: 'merged', filedAt: '2026-07-18T00:00:00.000Z', outcomeAt: '2026-07-19T00:00:00.000Z' }],
      now: Date.parse('2026-07-20T12:00:00.000Z')
    });
    expect(report).not.toContain('PENDING HUMAN REVIEW');
  });

  it('reports the funnel as UNAVAILABLE when outcomes were not gathered (#3120)', () => {
    const report = computeSelfEvalSummary({ outcomes: null, liTaskStats: liMetrics() });
    expect(report).toContain('LI approval funnel: UNAVAILABLE');
    expect(report).not.toContain('PENDING HUMAN REVIEW');
  });

  it('does not let the approval funnel inflate the confidence count (#3120)', () => {
    // The funnel measures the APPROVER's throughput, not LI's self-knowledge — a rich
    // funnel must not make a signal-less loop look well-informed.
    const now = Date.parse('2026-07-20T12:00:00.000Z');
    const report = computeSelfEvalSummary({
      outcomes: [
        { slug: 'a', outcome: 'merged', filedAt: new Date(now - 4 * DAY_AGO_MS).toISOString(), outcomeAt: new Date(now - 2 * DAY_AGO_MS).toISOString() }
      ],
      now
    });
    expect(report).toContain('Reasoning confidence: low');
  });

  it('rates confidence high with all three signals, and drops guidance', () => {
    const outcomes = Array.from({ length: 6 }, () => ({ outcome: 'merged' }));
    const report = computeSelfEvalSummary({
      outcomes,
      existingIssues: [{ slug: 'a', state: 'open' }],
      liTaskStats: liMetrics()
    });
    expect(report).toContain('Reasoning confidence: high (3 of 3 self-signals available)');
    expect(report).not.toContain('GUIDANCE — low self-confidence');
  });

  it('rates a well-measured 0% merge rate as HIGH confidence in a bad result, not low', () => {
    // Confidence rates the EVIDENCE, not the news. A loop with solid evidence that
    // it is failing should act decisively, not hedge as if it were flying blind.
    const outcomes = Array.from({ length: 8 }, () => ({ outcome: 'rejected', rejectionReason: 'user-rejected' }));
    const report = computeSelfEvalSummary({
      outcomes,
      existingIssues: [{ slug: 'a', state: 'open' }],
      liTaskStats: liMetrics()
    });
    expect(report).toContain('0 of 8 resolved proposals merged (0%)');
    expect(report).toContain('Reasoning confidence: high');
    expect(report).not.toContain('GUIDANCE — low self-confidence');
  });

  it('rates confidence medium with two of three signals', () => {
    const report = computeSelfEvalSummary({
      outcomes: Array.from({ length: 5 }, () => ({ outcome: 'merged' })),
      existingIssues: [],
      liTaskStats: { read: false, metrics: null }
    });
    expect(report).toContain('Reasoning confidence: medium (2 of 3 self-signals available)');
    expect(report).not.toContain('GUIDANCE — low self-confidence');
  });

  it('honors the injected clock when ageing the LI run window', () => {
    const now = Date.now();
    const DAY_MS = 24 * 60 * 60 * 1000;
    // 6 in-window failures (enough for the 'windowed' branch, which needs >= 5)
    // alongside a lifetime rate that says the loop is healthy: the windowed read
    // must win, which it can only do if `now` reaches computeWindowedStats.
    const recentOutcomes = Array.from({ length: 6 }, (_, i) => ({
      t: new Date(now - (i + 1) * DAY_MS).toISOString(), s: false
    }));
    const liTaskStats = { read: true, metrics: { completed: 50, succeeded: 50, failed: 0, successRate: 100, recentOutcomes } };
    expect(computeSelfEvalSummary({ liTaskStats, now })).toContain('0% of 6 windowed LI runs succeeded — DEGRADED');
    // Wind the clock past the window: the same ring ages out and the lifetime rate
    // takes over. A hard-wired Date.now() would report DEGRADED here too.
    const later = now + 365 * DAY_MS;
    expect(computeSelfEvalSummary({ liTaskStats, now: later })).toContain('100% of 50 lifetime LI runs succeeded');
  });
});
