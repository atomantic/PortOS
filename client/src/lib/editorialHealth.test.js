import { describe, it, expect } from 'vitest';
import {
  scoreBand,
  deltaDisplay,
  sparklineGeometry,
  orderedCategories,
  orderedChecks,
  checkCountSeries,
  countSparklineGeometry,
  diffCountMaps,
  snapshotDiff,
} from './editorialHealth.js';

describe('scoreBand', () => {
  it('bands scores into label + tone', () => {
    expect(scoreBand(100).label).toBe('Clean');
    expect(scoreBand(75).label).toBe('Minor');
    expect(scoreBand(50).label).toBe('Needs work');
    expect(scoreBand(10).label).toBe('Rough');
  });

  it('tolerates a non-finite score (treats as 0 → Rough)', () => {
    expect(scoreBand(undefined).label).toBe('Rough');
  });
});

describe('deltaDisplay', () => {
  it('marks an improving delta positive', () => {
    const d = deltaDisplay(10);
    expect(d.text).toBe('+10');
    expect(d.arrow).toBe('▲');
  });

  it('marks a regressing delta negative', () => {
    const d = deltaDisplay(-8);
    expect(d.text).toBe('-8');
    expect(d.arrow).toBe('▼');
  });

  it('is neutral at zero', () => {
    expect(deltaDisplay(0).arrow).toBe('→');
  });
});

describe('sparklineGeometry', () => {
  it('maps a higher score to a higher point (smaller y)', () => {
    const { coords } = sparklineGeometry([{ score: 20 }, { score: 90 }], { width: 100, height: 30, pad: 0 });
    expect(coords).toHaveLength(2);
    expect(coords[1].y).toBeLessThan(coords[0].y); // 90 plotted above 20
    expect(coords[0].x).toBe(0);
    expect(coords[1].x).toBe(100);
  });

  it('returns empty geometry for no points', () => {
    expect(sparklineGeometry([]).points).toBe('');
    expect(sparklineGeometry(undefined).coords).toEqual([]);
  });

  it('drops non-finite scores', () => {
    const { coords } = sparklineGeometry([{ score: 50 }, { score: null }]);
    expect(coords).toHaveLength(1);
  });
});

describe('orderedCategories', () => {
  it('sorts by count desc then name, dropping zero buckets', () => {
    expect(orderedCategories({ pacing: 1, continuity: 3, naming: 0, style: 1 })).toEqual([
      { category: 'continuity', count: 3 },
      { category: 'pacing', count: 1 },
      { category: 'style', count: 1 },
    ]);
  });

  it('returns empty for an empty/absent map', () => {
    expect(orderedCategories()).toEqual([]);
    expect(orderedCategories({})).toEqual([]);
  });
});

describe('orderedChecks', () => {
  it('sorts by count desc then label, resolving ids to labels and dropping zero buckets', () => {
    const labels = { 'naming.dissimilar-names': 'Name dissimilarity', 'roster.economy': 'Cast economy' };
    expect(orderedChecks(
      { 'naming.dissimilar-names': 1, 'roster.economy': 3, 'comic.prose-sync': 0 },
      (id) => labels[id],
    )).toEqual([
      { checkId: 'roster.economy', count: 3, label: 'Cast economy' },
      { checkId: 'naming.dissimilar-names', count: 1, label: 'Name dissimilarity' },
    ]);
  });

  it('falls back to the raw checkId when no label resolves (deleted custom check)', () => {
    expect(orderedChecks({ 'custom.gone': 2 })).toEqual([
      { checkId: 'custom.gone', count: 2, label: 'custom.gone' },
    ]);
    // A non-function labelFor is tolerated (falls back to the id).
    expect(orderedChecks({ 'custom.gone': 2 }, null)[0].label).toBe('custom.gone');
  });

  it('returns empty for an empty/absent map', () => {
    expect(orderedChecks()).toEqual([]);
    expect(orderedChecks({})).toEqual([]);
  });
});

describe('checkCountSeries', () => {
  it('extracts one check count across points, defaulting absent points to 0', () => {
    const points = [
      { openByCheck: { 'a': 3 } },
      { openByCheck: { 'a': 1, 'b': 2 } },
      { openByCheck: { 'b': 2 } },
    ];
    expect(checkCountSeries(points, 'a')).toEqual([3, 1, 0]);
    expect(checkCountSeries(points, 'b')).toEqual([0, 2, 2]);
  });

  it('omits points with no per-check telemetry (null openByCheck) — no false zero-spike for pre-#1597 snapshots', () => {
    const points = [
      { openByCheck: null },        // pre-upgrade: unknown, omitted (not 0)
      { openByCheck: { 'a': 2 } },  // telemetry-bearing
      { openByCheck: { 'b': 1 } },  // 'a' absent here → legit 0
    ];
    expect(checkCountSeries(points, 'a')).toEqual([2, 0]);
  });

  it('returns empty for empty/absent points', () => {
    expect(checkCountSeries([], 'a')).toEqual([]);
    expect(checkCountSeries(undefined, 'a')).toEqual([]);
  });
});

describe('countSparklineGeometry', () => {
  it('normalizes to its own max — peak at top, zero at bottom', () => {
    const { coords, max, last } = countSparklineGeometry([0, 4, 2], { width: 100, height: 20, pad: 0 });
    expect(max).toBe(4);
    expect(coords[0].y).toBe(20); // 0 → bottom
    expect(coords[1].y).toBe(0);  // 4 (max) → top
    expect(last.count).toBe(2);
  });

  it('renders an all-zero series as a flat baseline (no divide-by-zero)', () => {
    const { coords, max } = countSparklineGeometry([0, 0], { width: 100, height: 20, pad: 0 });
    expect(max).toBe(0);
    expect(coords.every((c) => c.y === 20)).toBe(true);
  });

  it('yields empty geometry for an empty series', () => {
    expect(countSparklineGeometry([]).points).toBe('');
    expect(countSparklineGeometry(undefined).coords).toEqual([]);
    expect(countSparklineGeometry([]).last).toBeNull();
  });
});

describe('diffCountMaps', () => {
  it('reports only the buckets whose count changed', () => {
    const rows = diffCountMaps({ a: 2, b: 1, c: 3 }, { a: 5, b: 1, c: 0 });
    // b unchanged (1→1) is dropped; a dropped 5→2, c rose 0→3
    expect(rows.map((r) => r.key).sort()).toEqual(['a', 'c']);
    const a = rows.find((r) => r.key === 'a');
    expect(a).toMatchObject({ from: 5, to: 2, delta: -3 });
    const c = rows.find((r) => r.key === 'c');
    expect(c).toMatchObject({ from: 0, to: 3, delta: 3 });
  });

  it('treats a bucket absent on one side as 0', () => {
    const rows = diffCountMaps({ added: 4 }, { removed: 2 });
    expect(rows.find((r) => r.key === 'added')).toMatchObject({ from: 0, to: 4, delta: 4 });
    expect(rows.find((r) => r.key === 'removed')).toMatchObject({ from: 2, to: 0, delta: -2 });
  });

  it('sorts by magnitude of change descending, then key', () => {
    const rows = diffCountMaps({ big: 10, small: 2, tie: 1 }, { big: 0, small: 0, tie: 0, ties: 1 });
    expect(rows.map((r) => r.key)).toEqual(['big', 'small', 'tie', 'ties']);
  });

  it('tolerates null/non-object maps', () => {
    expect(diffCountMaps(null, undefined)).toEqual([]);
    expect(diffCountMaps({ a: 1 }, null)).toEqual([{ key: 'a', from: 0, to: 1, delta: 1 }]);
  });
});

describe('snapshotDiff', () => {
  const point = {
    score: 80, open: 3,
    openBySeverity: { high: 0, medium: 1, low: 2 },
    openByCategory: { continuity: 1, pacing: 2 },
    openByCheck: { 'continuity.x': 1, 'pacing.y': 2 },
  };
  const prev = {
    score: 70, open: 5,
    openBySeverity: { high: 1, medium: 1, low: 3 },
    openByCategory: { continuity: 3, pacing: 2 },
    openByCheck: { 'continuity.x': 3, 'pacing.y': 2 },
  };

  it('returns null for a missing point', () => {
    expect(snapshotDiff(null)).toBeNull();
  });

  it('diffs every dimension against the previous snapshot', () => {
    const d = snapshotDiff(point, prev);
    expect(d.hasPrevious).toBe(true);
    expect(d.scoreDelta).toBe(10);
    expect(d.openDelta).toBe(-2);
    // severity: high 1→0, low 3→2 changed; medium unchanged
    expect(d.bySeverity.map((r) => r.key).sort()).toEqual(['high', 'low']);
    // category: continuity 3→1 changed; pacing unchanged
    expect(d.byCategory).toEqual([{ key: 'continuity', from: 3, to: 1, delta: -2 }]);
    // check: continuity.x 3→1 changed; pacing.y unchanged
    expect(d.byCheck).toEqual([{ key: 'continuity.x', from: 3, to: 1, delta: -2 }]);
  });

  it('marks the first revision as having no previous (null deltas)', () => {
    const d = snapshotDiff(point, null);
    expect(d.hasPrevious).toBe(false);
    expect(d.scoreDelta).toBeNull();
    expect(d.openDelta).toBeNull();
    // breakdown still computed as a pure first-revision delta (everything new)
    expect(d.byCategory.find((r) => r.key === 'continuity')).toMatchObject({ from: 0, to: 1 });
  });

  it('returns byCheck:null when either snapshot lacks per-check telemetry', () => {
    const noChecks = { ...point, openByCheck: null };
    expect(snapshotDiff(point, noChecks).byCheck).toBeNull();
    expect(snapshotDiff(noChecks, prev).byCheck).toBeNull();
    // severity/category still diff even without per-check telemetry
    expect(snapshotDiff(noChecks, prev).bySeverity.length).toBeGreaterThan(0);
  });
});
