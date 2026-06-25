import { describe, it, expect } from 'vitest';
import {
  SEVERITY_WEIGHTS,
  DEFAULT_READINESS_GATE,
  scoreFromOpen,
  isReadyUnderGate,
  resolveReadinessGate,
  isOpenFinding,
  openBlockers,
  computeHealth,
  computeTrend,
  __testing,
} from './editorialScore.js';

const open = (severity, extra = {}) => ({ status: 'open', severity, ...extra });

describe('scoreFromOpen', () => {
  it('a clean draft scores 100', () => {
    expect(scoreFromOpen({ high: 0, medium: 0, low: 0 })).toBe(100);
  });

  it('subtracts the published severity weights', () => {
    expect(scoreFromOpen({ high: 1, medium: 0, low: 0 })).toBe(100 - SEVERITY_WEIGHTS.high);
    expect(scoreFromOpen({ high: 0, medium: 1, low: 0 })).toBe(100 - SEVERITY_WEIGHTS.medium);
    expect(scoreFromOpen({ high: 0, medium: 0, low: 1 })).toBe(100 - SEVERITY_WEIGHTS.low);
  });

  it('clamps to 0 (never negative) when findings pile up', () => {
    expect(scoreFromOpen({ high: 100, medium: 0, low: 0 })).toBe(0);
  });

  it('tolerates an absent/partial counts object', () => {
    expect(scoreFromOpen(undefined)).toBe(100);
    expect(scoreFromOpen({ high: 2 })).toBe(100 - 2 * SEVERITY_WEIGHTS.high);
  });
});

describe('readiness gate', () => {
  it('resolves unknown/absent gate to the default', () => {
    expect(resolveReadinessGate('bogus')).toBe(DEFAULT_READINESS_GATE);
    expect(resolveReadinessGate(undefined)).toBe(DEFAULT_READINESS_GATE);
    expect(resolveReadinessGate('none')).toBe('none');
  });

  it('noOpenHigh: ready iff no open high findings', () => {
    expect(isReadyUnderGate({ high: 0, medium: 5, low: 9 }, 'noOpenHigh')).toBe(true);
    expect(isReadyUnderGate({ high: 1, medium: 0, low: 0 }, 'noOpenHigh')).toBe(false);
  });

  it('noOpenHighOrMedium: blocks on mediums too', () => {
    expect(isReadyUnderGate({ high: 0, medium: 1, low: 0 }, 'noOpenHighOrMedium')).toBe(false);
    expect(isReadyUnderGate({ high: 0, medium: 0, low: 9 }, 'noOpenHighOrMedium')).toBe(true);
  });

  it('none: always ready', () => {
    expect(isReadyUnderGate({ high: 9, medium: 9, low: 9 }, 'none')).toBe(true);
  });
});

describe('isOpenFinding / openBlockers', () => {
  it('treats anything but accepted/dismissed as open', () => {
    expect(isOpenFinding({ status: 'open' })).toBe(true);
    expect(isOpenFinding({})).toBe(true); // absent status
    expect(isOpenFinding({ status: 'accepted' })).toBe(false);
    expect(isOpenFinding({ status: 'dismissed' })).toBe(false);
  });

  it('openBlockers matches computeHealth open-detection + severity normalization', () => {
    const comments = [
      { severity: 'high', issueNumber: 1 }, // no status → open
      open('medium', { issueNumber: 1 }),
      open('low', { issueNumber: 2 }),
      { status: 'accepted', severity: 'high' },
      { status: 'open', severity: 'weird' }, // unknown → normalizes to medium
    ];
    // noOpenHigh: only the high (and nothing else) blocks.
    expect(openBlockers(comments, 'noOpenHigh').map((c) => c.severity)).toEqual(['high']);
    // noOpenHighOrMedium: high + both mediums (incl. the normalized 'weird').
    expect(openBlockers(comments, 'noOpenHighOrMedium')).toHaveLength(3);
    // none: nothing blocks.
    expect(openBlockers(comments, 'none')).toEqual([]);
  });

  it('the blocker list can never disagree with computeHealth.ready', () => {
    const comments = [open('high', { issueNumber: 1 })];
    const health = computeHealth(comments, 'noOpenHigh');
    const blockers = openBlockers(comments, 'noOpenHigh');
    expect(health.ready).toBe(blockers.length === 0);
  });
});

describe('computeHealth', () => {
  it('rolls up open findings, ignoring accepted/dismissed in the score', () => {
    const comments = [
      open('high', { issueNumber: 1, category: 'continuity' }),
      open('medium', { issueNumber: 1, category: 'pacing' }),
      { status: 'accepted', severity: 'high', issueNumber: 1, category: 'continuity' },
      { status: 'dismissed', severity: 'high', issueNumber: 2, category: 'naming' },
      open('low', { issueNumber: 2, category: 'style' }),
    ];
    const health = computeHealth(comments, 'noOpenHigh');
    expect(health.total).toBe(5);
    expect(health.open).toBe(3);
    expect(health.accepted).toBe(1);
    expect(health.dismissed).toBe(1);
    expect(health.openBySeverity).toEqual({ high: 1, medium: 1, low: 1 });
    expect(health.score).toBe(100 - SEVERITY_WEIGHTS.high - SEVERITY_WEIGHTS.medium - SEVERITY_WEIGHTS.low);
    expect(health.ready).toBe(false); // one open high
  });

  it('breaks findings down per issue, with series-scoped (null issueNumber) last', () => {
    const comments = [
      open('high', { issueNumber: 2, category: 'continuity' }),
      open('low', { issueNumber: 1, category: 'style' }),
      open('medium', { category: 'naming' }), // series-scoped, no issueNumber
    ];
    const health = computeHealth(comments);
    expect(health.perIssue.map((p) => p.issueNumber)).toEqual([1, 2, null]);
    const issue2 = health.perIssue.find((p) => p.issueNumber === 2);
    expect(issue2.openBySeverity.high).toBe(1);
    expect(issue2.ready).toBe(false);
    const seriesScoped = health.perIssue.find((p) => p.issueNumber === null);
    expect(seriesScoped.openByCategory.naming).toBe(1);
  });

  it('treats a finding with no/unknown status as open (does not under-count blockers)', () => {
    const comments = [{ severity: 'high', issueNumber: 1 }]; // no status field
    const health = computeHealth(comments);
    expect(health.open).toBe(1);
    expect(health.ready).toBe(false);
  });

  it('buckets a missing checkId under "completeness" and missing category under "other"', () => {
    const comments = [open('low', { issueNumber: 1 })];
    const health = computeHealth(comments);
    expect(health.openByCheck.completeness).toBe(1);
    expect(health.openByCategory.other).toBe(1);
  });

  it('a clean (all-resolved) review is ready and scores 100', () => {
    const comments = [
      { status: 'accepted', severity: 'high', issueNumber: 1 },
      { status: 'dismissed', severity: 'medium', issueNumber: 1 },
    ];
    const health = computeHealth(comments);
    expect(health.score).toBe(100);
    expect(health.open).toBe(0);
    expect(health.ready).toBe(true);
  });
});

describe('computeTrend', () => {
  const snap = (at, score, open, openByCategory = {}) => ({
    runId: `run-${at}`, at, score, ready: open === 0, open,
    openBySeverity: { high: 0, medium: 0, low: open }, openByCategory,
  });

  it('projects a score/open time-series in order', () => {
    const trend = computeTrend([
      snap('2026-06-01T00:00:00Z', 80, 5),
      snap('2026-06-02T00:00:00Z', 90, 2),
    ]);
    expect(trend.points.map((p) => p.score)).toEqual([80, 90]);
    expect(trend.delta).toBe(10); // improving
    expect(trend.latest.open).toBe(2);
    expect(trend.previous.open).toBe(5);
  });

  it('flags a category that regressed (got worse) between the two latest snapshots', () => {
    const trend = computeTrend([
      snap('2026-06-01T00:00:00Z', 90, 3, { continuity: 1, pacing: 2 }),
      snap('2026-06-02T00:00:00Z', 70, 5, { continuity: 4, pacing: 1 }),
    ]);
    expect(trend.regressions).toEqual([{ category: 'continuity', from: 1, to: 4 }]);
    expect(trend.delta).toBe(-20); // regressing
  });

  it('treats a category absent in the prior snapshot as 0 prior (new regressions count)', () => {
    const trend = computeTrend([
      snap('2026-06-01T00:00:00Z', 95, 1, { style: 1 }),
      snap('2026-06-02T00:00:00Z', 88, 2, { style: 1, naming: 1 }),
    ]);
    expect(trend.regressions).toEqual([{ category: 'naming', from: 0, to: 1 }]);
  });

  it('returns empty trend for an empty/absent ledger', () => {
    const trend = computeTrend([]);
    expect(trend.points).toEqual([]);
    expect(trend.regressions).toEqual([]);
    expect(trend.checkRegressions).toEqual([]);
    expect(trend.delta).toBe(0);
    expect(trend.latest).toBeNull();
  });

  // Per-check trend tracking (#1597).
  const snapWithChecks = (at, openByCheck) => ({
    runId: `run-${at}`, at, score: 100 - Object.values(openByCheck).reduce((a, b) => a + b, 0),
    ready: false, open: Object.values(openByCheck).reduce((a, b) => a + b, 0),
    openBySeverity: { high: 0, medium: 0, low: 0 }, openByCategory: {}, openByCheck,
  });

  it('carries the per-check open counts on each point so the UI can build per-check sparklines', () => {
    const trend = computeTrend([
      snapWithChecks('2026-06-01T00:00:00Z', { 'naming.dissimilar-names': 3 }),
      snapWithChecks('2026-06-02T00:00:00Z', { 'naming.dissimilar-names': 1, 'roster.economy': 2 }),
    ]);
    expect(trend.points.map((p) => p.openByCheck)).toEqual([
      { 'naming.dissimilar-names': 3 },
      { 'naming.dissimilar-names': 1, 'roster.economy': 2 },
    ]);
  });

  it('flags a check that regressed (more findings) between the two latest snapshots', () => {
    const trend = computeTrend([
      snapWithChecks('2026-06-01T00:00:00Z', { 'naming.dissimilar-names': 1, 'roster.economy': 2 }),
      snapWithChecks('2026-06-02T00:00:00Z', { 'naming.dissimilar-names': 4, 'roster.economy': 1 }),
    ]);
    // naming worsened 1→4 (regressed); roster improved 2→1 (not a regression).
    expect(trend.checkRegressions).toEqual([{ checkId: 'naming.dissimilar-names', from: 1, to: 4 }]);
  });

  it('treats a check absent in the prior snapshot as 0 prior (newly-failing check counts as a regression)', () => {
    const trend = computeTrend([
      snapWithChecks('2026-06-01T00:00:00Z', { 'naming.dissimilar-names': 1 }),
      snapWithChecks('2026-06-02T00:00:00Z', { 'naming.dissimilar-names': 1, 'comic.prose-sync': 2 }),
    ]);
    expect(trend.checkRegressions).toEqual([{ checkId: 'comic.prose-sync', from: 0, to: 2 }]);
  });

  it('does NOT flag per-check regressions when the prior snapshot predates per-check telemetry (no false 0→N spike)', () => {
    // A pre-#1597 snapshot has no openByCheck map (sanitizes to null); comparing
    // against it must not read as all-zeros and flag every open check.
    const preUpgrade = {
      runId: 'run-old', at: '2026-06-01T00:00:00Z', score: 88, ready: false, open: 2,
      openBySeverity: { high: 0, medium: 2, low: 0 }, openByCategory: { naming: 2 },
      // openByCheck intentionally absent
    };
    const trend = computeTrend([
      preUpgrade,
      snapWithChecks('2026-06-02T00:00:00Z', { 'naming.dissimilar-names': 2 }),
    ]);
    expect(trend.checkRegressions).toEqual([]);
    // The new point still carries its per-check map for the sparkline.
    expect(trend.points[1].openByCheck).toEqual({ 'naming.dissimilar-names': 2 });
    // The old point's per-check telemetry is the explicit "unknown" sentinel.
    expect(trend.points[0].openByCheck).toBeNull();
  });
});

describe('ledger sanitization', () => {
  it('drops malformed snapshots and coerces severity counts', () => {
    const ledger = __testing.sanitizeLedger({
      snapshots: [
        null,
        { at: '2026-06-01T00:00:00Z', score: 90, openBySeverity: { high: 'x', medium: 2 }, openByCategory: { a: 1, b: 'nope' }, openByCheck: { 'check.a': 2, 'check.b': 'nope' } },
        { score: 50 }, // no `at` → dropped
      ],
    }, 'ser-abc');
    expect(ledger.snapshots).toHaveLength(1);
    expect(ledger.snapshots[0].openBySeverity).toEqual({ high: 0, medium: 2, low: 0 });
    expect(ledger.snapshots[0].openByCategory).toEqual({ a: 1 });
    expect(ledger.snapshots[0].openByCheck).toEqual({ 'check.a': 2 });
    expect(ledger.seriesId).toBe('ser-abc');
  });

  it('preserves an absent openByCheck as null (not {}) so pre-#1597 snapshots read as "no telemetry", not "zero findings"', () => {
    const ledger = __testing.sanitizeLedger({
      snapshots: [{ at: '2026-05-01T00:00:00Z', score: 88, openBySeverity: { high: 0, medium: 1, low: 0 }, openByCategory: { naming: 1 } }],
    }, 'ser-old');
    expect(ledger.snapshots[0].openByCheck).toBeNull();
  });

  it('keeps a present-but-empty openByCheck as {} (a run that found zero per-check findings is real telemetry)', () => {
    const ledger = __testing.sanitizeLedger({
      snapshots: [{ at: '2026-06-01T00:00:00Z', score: 100, openBySeverity: { high: 0, medium: 0, low: 0 }, openByCategory: {}, openByCheck: {} }],
    }, 'ser-clean');
    expect(ledger.snapshots[0].openByCheck).toEqual({});
  });
});
