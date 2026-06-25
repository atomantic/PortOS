import { describe, it, expect } from 'vitest';
import {
  scoreBand,
  deltaDisplay,
  sparklineGeometry,
  orderedCategories,
  orderedChecks,
  checkCountSeries,
  countSparklineGeometry,
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
