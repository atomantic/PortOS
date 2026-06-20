import { describe, it, expect } from 'vitest';
import {
  scoreBand,
  deltaDisplay,
  sparklineGeometry,
  orderedCategories,
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
